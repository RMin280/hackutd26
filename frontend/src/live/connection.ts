// Live data source. Connects to the Blast Radius SpacetimeDB module, keeps the store's
// site / world / events / caption in sync with its tables, and turns the presenter's
// controls (Space, R, 1/2, step clicks) into reducer calls. main.tsx starts it only when
// live mode is on; otherwise the mock in src/mock drives the view as before.

import { DbConnection } from '../module_bindings';
import type { Site } from '../model/types';
import { stepCount, useStore } from '../store';
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
  'diagnosis',
  'placement',
  'decision',
  'clock',
  'scenario',
] as const;
type TableName = (typeof TABLES)[number];
const TOPOLOGY = new Set<TableName>(['part', 'rack', 'node', 'downstream']);

// The slice of the generated DbConnection this file uses. Kept loose on purpose: the
// generated bindings are the real types; this only names what gets called.
type Callback = (...args: unknown[]) => void;
interface LiveTable {
  iter(): Iterable<unknown>;
  onInsert(cb: Callback): void;
  onDelete(cb: Callback): void;
  onUpdate?(cb: Callback): void;
}
interface SubscriptionBuilder {
  onApplied(cb: Callback): SubscriptionBuilder;
  onError(cb: Callback): SubscriptionBuilder;
  subscribe(queries: string[]): unknown;
}
interface LiveConnection {
  db: Record<TableName, LiveTable | undefined>;
  reducers: Record<string, ((args: object) => Promise<void>) | undefined>;
  subscriptionBuilder(): SubscriptionBuilder;
}
type AppState = ReturnType<typeof useStore.getState>;

const TOKEN_KEY = `blast-radius:${LIVE_URI}:${LIVE_DB}:token`;
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
  const patch: Partial<AppState> = {
    site,
    world: toWorld(t, site),
    events: toEvents(t.decision),
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
  seenVersion = sc.version;
  useStore.setState(patch);
}

function schedule(topology: boolean): void {
  if (topology) topologyDirty = true;
  if (queued) return;
  queued = true;
  setTimeout(sync, 30);
}

function call(name: string, args: object): void {
  const reducers = conn?.reducers;
  const fn = reducers?.[name];
  if (!reducers || !fn) {
    useStore.setState({ caption: `Not connected to SpacetimeDB yet (${name}).`, playing: false });
    return;
  }
  fn.call(reducers, args).catch((e: unknown) => {
    console.warn(`[blast-radius] ${name} failed`, e);
    useStore.setState({ caption: `The backend refused ${name}: ${messageOf(e)}`, playing: false });
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
  });
}

function attach(c: LiveConnection): void {
  conn = c;
  for (const name of TABLES) {
    const table = c.db[name];
    if (!table) {
      console.warn(`[blast-radius] table "${name}" is missing from the bindings: run npm run bindings`);
      continue;
    }
    const topology = TOPOLOGY.has(name);
    table.onInsert(() => schedule(topology));
    table.onDelete(() => schedule(topology));
    table.onUpdate?.(() => schedule(false));
  }
  // The control room acts as a shift lead. Fails quietly if this identity is already the
  // admin or open registration is off (then an admin must register_actor it).
  c.reducers.selfRegister?.call(c.reducers, { name: 'Control room', role: 'shift_lead', rows: [] }).catch(() => {});
  c.subscriptionBuilder()
    .onApplied(() => schedule(true))
    .onError((...args: unknown[]) => {
      console.error('[blast-radius] subscription failed', ...args);
      useStore.setState({ caption: 'Subscribing to SpacetimeDB failed; see the browser console.' });
    })
    .subscribe(TABLES.map((name) => `SELECT * FROM ${name}`));
}

export function startLive(): void {
  useStore.setState({ caption: `Connecting to SpacetimeDB: ${LIVE_DB} at ${LIVE_URI}…` });
  takeOverControls();
  let builder = DbConnection.builder().withUri(LIVE_URI).withDatabaseName(LIVE_DB).withToken(readToken());
  if (typeof builder.withAutomaticReconnect === 'function') builder = builder.withAutomaticReconnect();
  builder
    .onConnect((c: LiveConnection, _identity: unknown, token: string) => {
      saveToken(token);
      attach(c);
    })
    .onConnectError((_ctx: unknown, err: unknown) => {
      clearToken();
      useStore.setState({
        caption: `Can't reach SpacetimeDB (${LIVE_DB} at ${LIVE_URI}): ${messageOf(err)}. Is \`spacetime start\` running and the module published?`,
      });
    })
    .onDisconnect(() => {
      useStore.setState({ caption: 'Disconnected from SpacetimeDB. Reload the page to reconnect.', playing: false });
    })
    .build();
}
