// The tech: Squawk's floor tech, a gull in an azure hard hat. Off duty it stands at its post
// on the east side of the hall, between the spines. On duty (T) it walks the cheapest route
// (nav.ts: Dijkstra on the floor grid) to the nearest failed or degraded node or part, works on
// it for a few seconds, marks it repaired, and walks on to the nearest one left. With nothing
// left to fix it goes back to its post.
//
// What counts as broken is whatever the world in the store says (the backend's tables, in live
// mode), and marking something repaired is an ordinary state change: in live mode the backend
// checks and records it like any other (set_part_state / set_node_state). Once it has picked a
// repair it sees it through, unless it's called off duty or the thing gets fixed meanwhile.
//
// Pure logic: no three.js, no React. Tech.tsx draws it; spacetimedb/test/view-tech.test.ts
// runs it without a screen.

import type { PartState } from '../model/types';
import { approach, standFacing, stepToward, type GullState } from './gait';
import { ROW_X1, hotAisleZ } from './layout';
import { planRoute, type NavGrid, type Option, type Point, type Repair, type Route, type Spot } from './nav';

/** Its post: on the east side, between the two spines, facing the hall. */
export const POST: Spot = { x: ROW_X1 + 3.7, z: hotAisleZ(2), face: -Math.PI / 2, work: [ROW_X1 + 2.7, 1, hotAisleZ(2)] };

export const TECH_SPEED = 1.25; // m/s: a brisk waddle, quicker than the patrols
export const WORK_TIME = 4; // seconds per repair
/** Once it has asked for a repair, it leaves that one alone this long while the world catches up. */
export const RETRY_AFTER = 10;
/** Asked twice and still broken (the backend refused?): it leaves it until it next goes on duty. */
const TRIES = 2;

export type TechPhase = 'idle' | 'walking' | 'turning' | 'working';

/** The slice of the world the tech looks at. */
export interface TechWorld {
  partState: Record<string, PartState>;
  nodeState: Record<string, PartState>;
}

export interface TechOptions {
  grid: NavGrid;
  gull: GullState;
  /** Where it can stand to work on a repair (nav.ts spotsFor, cached). */
  spots: (r: Repair) => Spot[];
  /** Marks a repair done (the store's repair action). */
  repair: (r: Repair) => void;
  post?: Spot;
  speed?: number;
  workTime?: number;
}

export interface Tech {
  readonly gull: GullState;
  readonly phase: TechPhase;
  /** What it is walking to or working on; null when idle or on its way back to the post. */
  readonly job: Repair | null;
  readonly spot: Spot | null;
  /** The legs still to walk; the first is the one it's on. */
  readonly route: readonly Point[];
  /** 0 .. 1 through the current repair. */
  readonly progress: number;
  /** One frame: dt seconds at time t, on duty or not, seeing this world. */
  update(dt: number, t: number, onDuty: boolean, world: TechWorld): void;
}

const isBroken = (s: PartState | undefined) => s === 'failed' || s === 'degraded';
const keyOf = (r: Repair) => `${r.kind}:${r.id}`;

/** Everything failed or degraded, parts first, each in id order (so ties go the same way every time). */
export function brokenIn(world: TechWorld): Repair[] {
  const out: Repair[] = [];
  for (const id of Object.keys(world.partState).sort()) if (isBroken(world.partState[id])) out.push({ kind: 'part', id });
  for (const id of Object.keys(world.nodeState).sort()) if (isBroken(world.nodeState[id])) out.push({ kind: 'node', id });
  return out;
}

export function createTech(o: TechOptions): Tech {
  const { grid, gull, spots, repair } = o;
  const post = o.post ?? POST;
  const speed = o.speed ?? TECH_SPEED;
  const workTime = o.workTime ?? WORK_TIME;

  let phase: TechPhase = 'idle';
  let job: Repair | null = null;
  let spot: Spot | null = null;
  let route: Point[] = [];
  let left = 0;

  let seen: TechWorld | null = null;
  let broken: Repair[] = [];
  let onDutyBefore = false;
  let dirty = true; // something changed that may change what to do next
  let recheckAt = Infinity; // when a repair it asked for becomes fair game again
  const asked = new Map<string, number>(); // repair -> when it last asked for it
  const tries = new Map<string, number>(); // repair -> how often it asked this shift

  const atPost = () => Math.hypot(gull.x - post.x, gull.z - post.z) < 0.05;
  const stillBroken = (r: Repair) => broken.some((b) => b.kind === r.kind && b.id === r.id);

  const go = (r: Route<Repair | null>) => {
    job = r.tag;
    spot = r.spot;
    route = r.points.slice();
    phase = 'walking';
  };
  const stop = () => {
    job = null;
    spot = null;
    route = [];
    phase = 'idle';
  };

  /** The nearest repair it may take on now, by walking cost, with the route there. */
  function nearestRepair(t: number): Route<Repair | null> | null {
    const options: Option<Repair | null>[] = [];
    for (const r of broken) {
      const k = keyOf(r);
      if ((tries.get(k) ?? 0) >= TRIES) continue;
      const since = t - (asked.get(k) ?? -Infinity);
      if (since < RETRY_AFTER) {
        recheckAt = Math.min(recheckAt, t + RETRY_AFTER - since);
        continue;
      }
      options.push({ tag: r, spots: spots(r) });
    }
    return options.length > 0 ? planRoute(grid, gull, options) : null;
  }

  function replan(t: number, onDuty: boolean) {
    // Busy with a repair that is still wanted: see it through.
    if (job && onDuty && stillBroken(job)) return;
    const next = onDuty ? nearestRepair(t) : null;
    if (next) return go(next);
    if (atPost()) return stop();
    if (job || phase !== 'walking') {
      const home = planRoute(grid, gull, [{ tag: null, spots: [post] }]);
      if (home) go(home);
      else stop();
    }
    // else it is already walking back to the post: carry on
  }

  function finish(t: number) {
    const done = job!;
    const k = keyOf(done);
    asked.set(k, t);
    tries.set(k, (tries.get(k) ?? 0) + 1);
    stop();
    dirty = true;
    repair(done);
  }

  return {
    gull,
    get phase() {
      return phase;
    },
    get job() {
      return job;
    },
    get spot() {
      return spot;
    },
    get route() {
      return route;
    },
    get progress() {
      return phase === 'working' ? Math.min(1, 1 - left / workTime) : 0;
    },

    update(dt, t, onDuty, world) {
      if (world !== seen) {
        seen = world;
        broken = brokenIn(world);
        dirty = true;
      }
      if (onDuty !== onDutyBefore) {
        onDutyBefore = onDuty;
        tries.clear();
        dirty = true;
      }
      if (t >= recheckAt) {
        recheckAt = Infinity;
        dirty = true;
      }
      if (dirty) {
        dirty = false;
        replan(t, onDuty);
      }

      switch (phase) {
        case 'idle':
          gull.work = approach(gull.work, 0, dt * 3);
          standFacing(gull, atPost() ? post.face : undefined, dt);
          break;
        case 'walking': {
          gull.work = approach(gull.work, 0, dt * 3);
          const leg = route[0];
          if (leg && stepToward(gull, leg.x, leg.z, speed, dt)) route.shift();
          if (route.length === 0) phase = job ? 'turning' : 'idle';
          break;
        }
        case 'turning':
          if (standFacing(gull, spot!.face, dt)) {
            phase = 'working';
            left = workTime;
          }
          break;
        case 'working':
          standFacing(gull, spot!.face, dt);
          gull.work = approach(gull.work, 1, dt * 4);
          left -= dt;
          if (left <= 0) finish(t);
          break;
      }
    },
  };
}
