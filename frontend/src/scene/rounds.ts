// The tech: Squawk's floor tech, a gull in an azure hard hat. Off duty it waits at its desk in
// its office, off the corridor that runs past the hall's east side (or, without an office, at
// its post between the spines). On duty (T) it walks up the corridor and in through the
// entrance's two interlocked doors (airlock.ts: the second opens only once the first has shut),
// walks the cheapest route (nav.ts: Dijkstra on the floor grid) to the nearest failed or
// degraded node or part, works on it for a few seconds, marks it repaired, and walks on to the
// nearest one left. With nothing left to fix it goes back out through both doors and down the
// corridor to its desk. The hall and the office side (corridor and office) are separate floor
// grids; the doors are the only way between them, and once it has started through it sees it
// through.
//
// What counts as broken is whatever the world in the store says (the backend's tables, in live
// mode), and marking something repaired is an ordinary state change: in live mode the backend
// checks and records it like any other (set_part_state / set_node_state). Once it has picked a
// repair it sees it through, unless it's called off duty or the thing gets fixed meanwhile.
//
// Pure logic: no three.js, no React. Tech.tsx draws it; spacetimedb/test/view-tech.test.ts
// runs it without a screen.

import type { PartState } from '../model/types';
import type { Airlock, DoorIndex } from './airlock';
import { approach, standFacing, stepToward, type GullState } from './gait';
import { ENTRY, ROW_X1, WALL, hotAisleZ } from './layout';
import { buildGrid, planRoute, type NavGrid, type Option, type Point, type Repair, type Route, type Spot } from './nav';

/** Its post: on the east side, between the two spines, facing the hall. */
export const POST: Spot = { x: ROW_X1 + 3.7, z: hotAisleZ(2), face: -Math.PI / 2, work: [ROW_X1 + 2.7, 1, hotAisleZ(2)] };

export const TECH_SPEED = 2.5; // m/s: a hurried waddle, twice the old pace and well ahead of the patrols
export const WORK_TIME = 4; // seconds per repair
/** Once it has asked for a repair, it leaves that one alone this long while the world catches up. */
export const RETRY_AFTER = 10;
/** Asked twice and still broken (the backend refused?): it leaves it until it next goes on duty. */
const TRIES = 2;

export type TechPhase = 'idle' | 'walking' | 'turning' | 'working' | 'doors';
export type TechZone = 'hall' | 'office';

/** The slice of the world the tech looks at. */
export interface TechWorld {
  partState: Record<string, PartState>;
  nodeState: Record<string, PartState>;
}

/** The office and the way to it. */
export interface TechOffice {
  /** The floor on the far side of the entrance: the corridor and the office off it. */
  grid: NavGrid;
  /** Where it waits off duty. */
  desk: Spot;
  doors: Airlock;
  /** Where it waits for door 0 (in the hall), between the doors, and where it waits for door 1 (in the office). */
  hallSide: Point;
  middle: Point;
  officeSide: Point;
}

/**
 * The demo site's office side: the stretch of corridor from the entrance down to the office,
 * the office through its doorway, and the desk in it. The rest of the corridor runs on to other
 * halls; the tech has no business there, so it isn't on this floor.
 */
export function buildOffice(doors: Airlock): TechOffice {
  const { corridor: c, office: o, officeDoor: door, desk } = ENTRY;
  const floor = { x0: c.x0, x1: o.x1, z0: ENTRY.z - 3, z1: o.z1 + 1 };
  const [dw, , dd] = desk.size;
  const deskRect = { x0: desk.x - dw / 2, x1: desk.x + dw / 2, z0: desk.z - dd / 2, z1: desk.z + dd / 2 };
  const half = WALL.door / 2;
  const solid = [
    { x0: c.x1, x1: o.x1, z0: floor.z0, z1: o.z0 }, // east of the corridor, north of the office
    { x0: c.x1, x1: o.x1, z0: o.z1, z1: floor.z1 }, // and south of it
    { x0: c.x1, x1: c.x1 + WALL.t, z0: o.z0, z1: door.z - half }, // the office's west wall, either side of its door
    { x0: c.x1, x1: c.x1 + WALL.t, z0: door.z + half, z1: o.z1 },
    deskRect,
  ];
  return {
    grid: buildGrid(floor, solid),
    desk: { x: deskRect.x0 - 0.55, z: desk.z, face: Math.PI / 2, work: [deskRect.x0, desk.size[1], desk.z] },
    doors,
    hallSide: ENTRY.hallSide,
    middle: ENTRY.middle,
    officeSide: ENTRY.officeSide,
  };
}

export interface TechOptions {
  /** The hall's floor. */
  grid: NavGrid;
  /** With an office, the tech starts at its desk and goes home there; without one, to `post`. */
  office?: TechOffice;
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
  readonly zone: TechZone;
  /** What it is walking to or working on; null when idle or on its way back to the post. */
  readonly job: Repair | null;
  readonly spot: Spot | null;
  /** The legs still to walk on this side of the doors; the first is the one it's on. */
  readonly route: readonly Point[];
  /** Everything still ahead: this side's legs, through the doors if it is going through, and the walk beyond. */
  readonly plan: readonly Point[];
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
  const { grid, gull, spots, repair, office } = o;
  const post = o.post ?? POST;
  const home = office?.desk ?? post;
  const speed = o.speed ?? TECH_SPEED;
  const workTime = o.workTime ?? WORK_TIME;

  let phase: TechPhase = 'idle';
  let zone: TechZone = 'hall';
  let job: Repair | null = null;
  let spot: Spot | null = null;
  let route: Point[] = [];
  let left = 0;
  let thenDoors = false; // at the end of this walk, go through the doors
  let doorStep = 0; // through the doors: 0 wait for the near one, 1 into the hallway, 2 wait for the far one, 3 out
  let beyond: Point[] = []; // the walk planned for the far side of the doors

  let seen: TechWorld | null = null;
  let broken: Repair[] = [];
  let onDutyBefore = false;
  let dirty = true; // something changed that may change what to do next
  let recheckAt = Infinity; // when a repair it asked for becomes fair game again
  const asked = new Map<string, number>(); // repair -> when it last asked for it
  const tries = new Map<string, number>(); // repair -> how often it asked this shift

  const homeZone: TechZone = office ? 'office' : 'hall';
  const atHome = () => zone === homeZone && Math.hypot(gull.x - home.x, gull.z - home.z) < 0.05;
  const stillBroken = (r: Repair) => broken.some((b) => b.kind === r.kind && b.id === r.id);
  const at = (p: Point): Spot => ({ x: p.x, z: p.z, face: 0, work: [p.x, 0, p.z] });

  const go = (r: Route<Repair | null>) => {
    job = r.tag;
    spot = r.spot;
    route = r.points.slice();
    phase = 'walking';
    thenDoors = false;
    beyond = [];
  };
  /**
   * Walks to the near side of the doors (on this zone's floor) and goes through. `next` is what
   * it is going out for, and `after` the walk it has planned on the far side (for the route dots).
   */
  const toDoors = (next: Repair | null, after: Point[]) => {
    const g = zone === 'hall' ? grid : office!.grid;
    const r = planRoute(g, gull, [{ tag: null, spots: [at(zone === 'hall' ? office!.hallSide : office!.officeSide)] }]);
    if (!r) return stop();
    go(r);
    job = next;
    spot = null;
    thenDoors = true;
    beyond = after.slice();
  };
  const stop = () => {
    job = null;
    spot = null;
    route = [];
    phase = 'idle';
    thenDoors = false;
    beyond = [];
  };
  /** The way through the doors from here: into the hallway between them, and out the far side. */
  const doorLegs = (): Point[] => {
    const f = office!;
    const farSide = zone === 'hall' ? f.officeSide : f.hallSide;
    if (phase !== 'doors') return thenDoors ? [f.middle, farSide] : [];
    return doorStep <= 1 ? [f.middle, farSide] : [farSide];
  };

  // Which side of the doors it is on: a new tech (live mode's first sync, a reset that reseeds
  // the hall) picks up a gull that may be out in the hall or part way through the doors.
  if (office) {
    const g = office.grid;
    const hallEnd = grid.x0 + grid.cols * grid.cell;
    if (gull.x >= g.x0) zone = 'office';
    else if (gull.x > hallEnd) {
      // between the doors: finish going through toward the office side, then think again
      zone = 'hall';
      phase = 'doors';
      doorStep = 1;
    }
  }

  /** The nearest repair it may take on now, by walking cost from `from` (on the hall floor), with the route there. */
  function nearestRepair(t: number, from: Point): Route<Repair | null> | null {
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
    return options.length > 0 ? planRoute(grid, from, options) : null;
  }

  function replan(t: number, onDuty: boolean) {
    // Part way through the doors: see that through first, then think again.
    if (phase === 'doors') return;
    // Busy with a repair that is still wanted: see it through.
    if (job && onDuty && stillBroken(job)) return;
    const next = onDuty ? nearestRepair(t, zone === 'hall' ? gull : office!.hallSide) : null;
    if (next) return zone === 'hall' ? go(next) : toDoors(next.tag, next.points);
    if (atHome()) return stop();
    if (phase === 'walking' && !job) return; // already on its way home: carry on
    if (zone !== homeZone) {
      // home is through the doors: the walk from the far side of them to the desk
      const after = planRoute(office!.grid, office!.officeSide, [{ tag: null, spots: [home] }]);
      return toDoors(null, after?.points ?? []);
    }
    const back = planRoute(zone === 'hall' ? grid : office!.grid, gull, [{ tag: null, spots: [home] }]);
    if (back) go(back);
    else stop();
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

  /** One tick through the doors, from whichever side it is on. */
  function throughDoors(dt: number) {
    const f = office!;
    const out = zone === 'hall';
    const near: DoorIndex = out ? 0 : 1;
    const far: DoorIndex = out ? 1 : 0;
    const farSide = out ? f.officeSide : f.hallSide;
    const facing = out ? Math.PI / 2 : -Math.PI / 2; // east into the office, west into the hall
    gull.work = approach(gull.work, 0, dt * 3);
    switch (doorStep) {
      case 0:
        f.doors.request(near);
        standFacing(gull, facing, dt);
        if (f.doors.isOpen(near)) doorStep = 1;
        break;
      case 1:
        f.doors.request(near); // held open until it is through
        if (stepToward(gull, f.middle.x, f.middle.z, speed, dt)) doorStep = 2;
        break;
      case 2:
        f.doors.request(far); // opens once the near door has shut behind it
        standFacing(gull, facing, dt);
        if (f.doors.isOpen(far)) doorStep = 3;
        break;
      case 3:
        f.doors.request(far);
        if (stepToward(gull, farSide.x, farSide.z, speed, dt)) {
          zone = out ? 'office' : 'hall';
          stop();
          dirty = true;
        }
        break;
    }
  }

  return {
    gull,
    get phase() {
      return phase;
    },
    get zone() {
      return zone;
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
    get plan() {
      return office ? [...route, ...doorLegs(), ...beyond] : route;
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
      if (dirty && phase !== 'doors') {
        dirty = false;
        replan(t, onDuty);
      }

      switch (phase) {
        case 'idle':
          gull.work = approach(gull.work, 0, dt * 3);
          standFacing(gull, atHome() ? home.face : undefined, dt);
          break;
        case 'walking': {
          gull.work = approach(gull.work, 0, dt * 3);
          const leg = route[0];
          if (leg && stepToward(gull, leg.x, leg.z, speed, dt)) route.shift();
          if (route.length === 0) {
            if (thenDoors) {
              thenDoors = false;
              phase = 'doors';
              doorStep = 0;
            } else phase = job ? 'turning' : 'idle';
          }
          break;
        }
        case 'doors':
          throughDoors(dt);
          break;
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
      office?.doors.update(dt, [gull]);
    },
  };
}
