// Live data source. Connects to the Squawk SpacetimeDB module, keeps the store's
// site / world / events / caption in sync with its tables, and turns the presenter's
// controls (Space, R, 1/2, step clicks) into reducer calls. main.tsx starts it only when
// live mode is on; otherwise the mock in src/mock drives the view as before.

import { DbConnection } from '../module_bindings';
import type { Site } from '../model/types';
import { boardOnly, stepCount, useStore } from '../store';
import { LIVE_DB, LIVE_URI } from './config';
import { toEvents, toScenario, toSite, toWorld, type Tables } from './mapping';

const TABLES = [
  'part',
  'rack',
  'node',
  'downstream',
  'margin',
  'job',
  'work',
  'assignment', // the work board's bookkeeping; older bindings lack it and the board then shows no assignees
  'diagnosis',
  'placement',
  'decision',
  'clock',
  'scenario',
] as const;
type TableName = (typeof TABLES)[number];
const TOPOLOGY = new Set<TableName>(['part', 'rack', 'node', 'downstream']);

// The slice of the generated bindings (`npm run bindings`) this file uses, checked against
// the SpacetimeDB 2.x TypeScript SDK. Kept loose on purpose and reached through one cast
// (connectionBuilder), so this file compiles the same before and after the bindings exist.
type Callback = (...args: unknown[]) => void;
interface LiveTable {
  iter(): Iterable<unknown>;
  onInsert(cb: Callback): void;
  onDelete(cb: Callback): void;
  onUpdate?(cb: Callback): void; // tables with a primary key
}
interface SubscriptionBuilder {
  onApplied(cb: Callback): SubscriptionBuilder;
  onError(cb: Callback): SubscriptionBuilder;
  subscribe(queries: string[]): unknown;
}
interface LiveConnection {
  db: Partial<Record<TableName, LiveTable>>;
  // Reducers take one object of named arguments and resolve once the module ran them.
  reducers: Partial<Record<string, (args: object) => Promise<void>>>;
  subscriptionBuilder(): SubscriptionBuilder;
}
interface LiveBuilder {
  withUri(uri: string): LiveBuilder;
  withDatabaseName(name: string): LiveBuilder;
  withToken(token?: string): LiveBuilder;
  withAutomaticReconnect?(): LiveBuilder;
  onConnect(cb: (conn: LiveConnection, identity: unknown, token: string) => void): LiveBuilder;
  onAutomaticReconnect?(cb: (conn: LiveConnection, identity: unknown, token: string) => void): LiveBuilder;
  // nextAttempt is set only while automatic reconnect is retrying.
  onConnectError(cb: (ctx: unknown, err: unknown, nextAttempt?: number) => void): LiveBuilder;
  onDisconnect(cb: (ctx: unknown, err?: unknown, nextAttempt?: number) => void): LiveBuilder;
  build(): unknown;
}
const connectionBuilder = () => (DbConnection as unknown as { builder(): LiveBuilder }).builder();
type AppState = ReturnType<typeof useStore.getState>;

const TOKEN_KEY = `squawk:${LIVE_URI}:${LIVE_DB}:token`;
const readToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};
const saveToken = (token: string) => {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // private window: the identity just won't survive a reload
  }
};
const clearToken = () => {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
};
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

let conn: LiveConnection | null = null;
let site: Site | null = null;
let topologyDirty = true;
let queued = false;
let seenVersion: number | null = null;

function snapshot(c: LiveConnection): Tables {
  const t = {} as Record<TableName, unknown[]>;
  for (const name of TABLES) t[name] = Array.from(c.db[name]?.iter() ?? []);
  return t as unknown as Tables;
}

/** Rebuilds the view's data from the client cache. Batched: a reset touches thousands of rows. */
function sync(): void {
  queued = false;
  if (!conn) return;
  const t = snapshot(conn);
  if (t.part.length === 0 || t.rack.length === 0) return; // module not seeded yet
  if (topologyDirty || !site) {
    site = toSite(t);
    topologyDirty = false;
  }
  const sc = toScenario(t.scenario[0]);
  const s = useStore.getState();
  const events = toEvents(t.decision);
  const patch: Partial<AppState> = {
    site,
    world: toWorld(t, site),
    events,
    mode: sc.mode,
    stepIndex: sc.stepIndex,
    caption: sc.caption,
  };
  // A new scenario version means a step ran (or the hall was reseeded): move the camera like the mock did.
  if (seenVersion !== null && sc.version !== seenVersion) {
    if (sc.stepIndex < 0) {
      patch.selection = null;
      patch.playing = false;
      patch.camera = { seq: s.camera.seq + 1, target: { kind: 'overview' } };
    } else if (s.follow) {
      patch.selection = null;
      patch.camera = { seq: s.camera.seq + 1, target: sc.camera };
    }
    if (sc.stepIndex >= stepCount(sc.mode) - 1) patch.playing = false;
  }
  // What was in the feed before the view connected is history (no fixer popups for it).
  if (seenVersion === null) patch.feedStart = events[0]?.seq ?? 0;
  seenVersion = sc.version;
  useStore.setState(patch);
}

function schedule(topology: boolean): void {
  if (topology) topologyDirty = true;
  if (queued) return;
  queued = true;
  setTimeout(sync, 30);
}

/** Calls a reducer. Refusals show in the caption unless `quiet`. */
function call(name: string, args: object, quiet = false): void {
  const fn = conn?.reducers[name];
  if (!fn) {
    if (!quiet) useStore.setState({ caption: `Not connected to SpacetimeDB yet (${name}).`, notice: `Not connected to SpacetimeDB yet (${name}).`, playing: false });
    return;
  }
  Promise.resolve()
    .then(() => fn(args))
    .catch((e: unknown) => {
      if (quiet) return;
      console.warn(`[squawk] ${name} failed`, e);
      const text = `The backend refused ${name}: ${messageOf(e)}`;
      // The caption is the hall's narration; the notice is the work board's status line.
      useStore.setState({ caption: text, notice: text, playing: false });
    });
}

/** The presenter's controls now drive the backend's scenario runner instead of the mock. */
function takeOverControls(): void {
  const get = useStore.getState;
  useStore.setState({
    next: () => {
      const s = get();
      if (s.stepIndex >= stepCount(s.mode) - 1) {
        s.setPlaying(false);
        return;
      }
      call('scenarioNext', { mode: s.mode });
    },
    prev: () => {
      const s = get();
      if (s.stepIndex <= 0) call('scenarioStart', { mode: s.mode });
      else call('scenarioGoto', { mode: s.mode, step: s.stepIndex - 1 });
    },
    goTo: (step: number) => call('scenarioGoto', { mode: get().mode, step }),
    reset: () => {
      useStore.setState({ stepIndex: -1, playing: false });
      call('scenarioStart', { mode: get().mode });
    },
    setMode: (mode) => {
      useStore.setState({ mode, stepIndex: -1, playing: false });
      call('scenarioStart', { mode });
    },
    // The tech gull's repairs: an ordinary state change, checked and recorded by the backend.
    repair: ({ kind, id }) =>
      kind === 'part' ? call('setPartState', { part: id, state: 'ok' }) : call('setNodeState', { node: id, state: 'ok' }),
    // The work board's buttons: bookkeeping on leases the interlock already decided (accept_work /
    // complete_work). The control room's identity is a shift lead, so it may take on, move and
    // complete any maintenance lease; a refusal shows in the caption like any other.
    acceptWork: (id) => {
      useStore.setState({ notice: '' });
      call('acceptWork', { id: BigInt(id) });
    },
    completeWork: (id, note) => {
      useStore.setState({ notice: '' });
      call('completeWork', { id: BigInt(id), note });
    },
    seedShift: () => {
      useStore.setState({ notice: '' });
      call('seedShift', {});
    },
  });
}

function attach(c: LiveConnection): void {
  conn = c;
  for (const name of TABLES) {
    const table = c.db[name];
    if (!table) {
      console.warn(`[squawk] table "${name}" is missing from the bindings: run npm run bindings`);
      continue;
    }
    const topology = TOPOLOGY.has(name);
    table.onInsert(() => schedule(topology));
    table.onDelete(() => schedule(topology));
    table.onUpdate?.(() => schedule(false));
  }
  // The control room acts as a shift lead; a board opened on its own (?view=work) on another device
  // is a technician's screen, so it can take work on but not run the scenario. Refused quietly if
  // this identity is already registered (a reload, or the same browser opening both: it stays what
  // it first registered as) or open registration is off (then an admin must register_actor it).
  call('selfRegister', boardOnly ? { name: 'Floor tech', role: 'technician', rows: [] } : { name: 'Control room', role: 'shift_lead', rows: [] }, true);
  c.subscriptionBuilder()
    .onApplied(() => schedule(true))
    .onError((...args: unknown[]) => {
      console.error('[squawk] subscription failed', ...args);
      useStore.setState({ caption: 'Subscribing to SpacetimeDB failed; see the browser console.' });
    })
    .subscribe(TABLES.map((name) => `SELECT * FROM ${name}`));
}

export function startLive(): void {
  const uri = LIVE_URI;
  if (!uri) return;
  const where = `${LIVE_DB} at ${uri}`;
  useStore.setState({ caption: `Connecting to SpacetimeDB: ${where}…` });
  takeOverControls();
  let builder = connectionBuilder().withUri(uri).withDatabaseName(LIVE_DB).withToken(readToken());
  // Survives a restart of `spacetime start` without a page reload (subscriptions are kept).
  if (builder.withAutomaticReconnect) builder = builder.withAutomaticReconnect();
  if (builder.onAutomaticReconnect) builder = builder.onAutomaticReconnect(() => schedule(true));
  builder
    .onConnect((c, _identity, token) => {
      saveToken(token);
      attach(c);
    })
    .onConnectError((_ctx, err, nextAttempt) => {
      if (nextAttempt === undefined) {
        // A token from an older local server is one cause; the next reload gets a fresh identity.
        clearToken();
        useStore.setState({
          caption: `Can't reach SpacetimeDB (${where}): ${messageOf(err)}. Is \`spacetime start\` running and the module published? (bash dev.sh up)`,
          playing: false,
        });
      } else {
        useStore.setState({ caption: `SpacetimeDB is unreachable (${where}); retrying (attempt ${nextAttempt})…`, playing: false });
      }
    })
    .onDisconnect((_ctx, _err, nextAttempt) => {
      useStore.setState({
        caption:
          nextAttempt === undefined
            ? 'Disconnected from SpacetimeDB. Reload the page to reconnect.'
            : 'Lost the connection to SpacetimeDB; reconnecting…',
        playing: false,
      });
    })
    .build();
}
