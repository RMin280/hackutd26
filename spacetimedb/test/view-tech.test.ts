// The tech gull's path planning and behaviour: frontend/src/scene/nav.ts (Dijkstra on the floor
// grid) and frontend/src/scene/rounds.ts (walk to the nearest repair, fix it, on to the next).
// View code, tested here because this is the suite the team runs and it already compiles the
// view's plain modules (see frontend-contract.test.ts). Nothing here needs three.js or a browser.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialWorld } from '../../frontend/src/mock/scenario';
import { buildSite } from '../../frontend/src/mock/site';
import type { PartState, World } from '../../frontend/src/model/types';
import type { GullState } from '../../frontend/src/scene/gait';
import { buildPartLayout, coldAisleZs, ENTRY, HALL, WALL, hotAisleZ } from '../../frontend/src/scene/layout';
import { createAirlock, DOOR_CLOSE_TIME, DOOR_OPEN_TIME } from '../../frontend/src/scene/airlock';
import {
  BODY,
  CELL,
  buildGrid,
  buildHallGrid,
  cellAt,
  dijkstra,
  forEachStep,
  hallObstacles,
  nearestFree,
  planRoute,
  routeLength,
  spotsFor,
  standable,
  walkable,
  type Point,
  type Rect,
  type Repair,
} from '../../frontend/src/scene/nav';
import { POST, RETRY_AFTER, brokenIn, buildOffice, createTech, type Tech } from '../../frontend/src/scene/rounds';

const site = buildSite();
const layout = buildPartLayout(site);
const hall = buildHallGrid(site, layout);
const walls = hallObstacles(site, layout);

/** True distance from a point to the nearest piece of equipment or the edge of the floor. */
function clearance(p: Point, rects: Rect[] = walls, floor: Rect = HALL): number {
  let d = Math.min(p.x - floor.x0, floor.x1 - p.x, p.z - floor.z0, floor.z1 - p.z);
  for (const r of rects) d = Math.min(d, Math.hypot(Math.max(r.x0 - p.x, 0, p.x - r.x1), Math.max(r.z0 - p.z, 0, p.z - r.z1)));
  return d;
}

/** The least clearance anywhere along a walk, sampled every 2 cm. */
function leastClearance(pts: Point[], rects: Rect[] = walls, floor: Rect = HALL): number {
  let least = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.02));
    for (let k = 0; k <= n; k++) least = Math.min(least, clearance({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n }, rects, floor));
  }
  return least;
}

const gullAt = (p: Point, yaw = 0): GullState => ({ seg: 0, x: p.x, z: p.z, yaw, phase: 0, walk: 0, pause: 0, hot: 0, work: 0, spawn: 0, seed: 0.5 });
const firstNode = (rack: string) => site.racks[rack].nodes[0];

// ---------- the planner ----------

test('Dijkstra finds the same cheapest costs as a brute-force search', () => {
  const g = buildGrid({ x0: 0, z0: 0, x1: 4, z1: 3 }, [
    { x0: 1, z0: 0, x1: 1.3, z1: 2 },
    { x0: 2.2, z0: 1, x1: 2.6, z1: 3 },
    { x0: 3.2, z0: 0.4, x1: 3.5, z1: 0.9 },
  ]);
  const source = nearestFree(g, 0.5, 0.5);
  const fast = dijkstra(g, source).dist;

  // Bellman-Ford: relax every edge until nothing improves
  const slow = new Float64Array(g.cols * g.rows).fill(Infinity);
  slow[source] = 0;
  for (let changed = true; changed; ) {
    changed = false;
    for (let u = 0; u < slow.length; u++) {
      if (!(slow[u] < Infinity)) continue;
      forEachStep(g, u, (v, w) => {
        if (slow[u] + w < slow[v] - 1e-12) {
          slow[v] = slow[u] + w;
          changed = true;
        }
      });
    }
  }
  let reached = 0;
  for (let i = 0; i < slow.length; i++) {
    if (slow[i] === Infinity) assert.equal(fast[i], Infinity, `cell ${i} should be unreachable`);
    else {
      reached++;
      assert.ok(Math.abs(fast[i] - slow[i]) < 1e-9, `cell ${i}: ${fast[i]} vs ${slow[i]}`);
    }
  }
  assert.ok(reached > 100, 'most of the floor is reachable');
});

test('a route goes around a wall through its gap; a closed wall means no route', () => {
  const floor = { x0: 0, z0: 0, x1: 6, z1: 4 };
  const from = { x: 1, z: 1 };
  const there = [{ tag: 'B', spots: [{ x: 5, z: 1, face: 0, work: [5, 1, 1.5] as [number, number, number] }] }];

  const wall = { x0: 2.9, z0: 0, x1: 3.1, z1: 3 };
  const open = buildGrid(floor, [wall]);
  const r = planRoute(open, from, there);
  assert.ok(r, 'reachable through the gap');
  assert.ok(Math.max(...r.points.map((p) => p.z)) > 3.2, 'it goes through the gap at the far end');
  assert.ok(routeLength([from, ...r.points]) > 4 + 2, 'longer than the straight line, which the wall blocks');
  assert.ok(leastClearance([from, ...r.points], [wall], floor) >= BODY - CELL / 2, 'clear of the wall and the edges');
  assert.deepEqual(r.points.at(-1), { x: 5, z: 1 }, 'ends on the spot');

  const closed = buildGrid(floor, [{ x0: 2.9, z0: 0, x1: 3.1, z1: 4 }]);
  assert.equal(planRoute(closed, from, there), null);
});

test('every node and every facility part in the hall can be reached from the tech post', () => {
  const field = dijkstra(hall, nearestFree(hall, POST.x, POST.z));
  const all: Repair[] = [
    ...site.partOrder.map((id) => ({ kind: 'part' as const, id })),
    ...site.nodeOrder.map((id) => ({ kind: 'node' as const, id })),
  ];
  const stuck = all.filter((r) => !standable(hall, spotsFor(site, layout, r)).some((s) => field.dist[s.cell] < Infinity));
  assert.deepEqual(stuck, []);
});

test('routes keep the gull clear of racks and equipment', () => {
  const targets: Repair[] = [
    { kind: 'node', id: 'node-417' },
    { kind: 'part', id: 'cdu-3' },
    { kind: 'part', id: 'cdu-4' },
    { kind: 'part', id: 'ups-a' },
    { kind: 'part', id: 'chiller-1' },
    { kind: 'part', id: 'pdu-r10-b' },
    { kind: 'part', id: 'sw-leaf-r5' },
    { kind: 'node', id: firstNode('rack-r10-16') },
    { kind: 'node', id: firstNode('rack-r6-01') },
  ];
  for (const r of targets) {
    const route = planRoute(hall, POST, [{ tag: r, spots: spotsFor(site, layout, r) }]);
    assert.ok(route, `${r.id} reachable`);
    // a straight leg keeps 0.42 m from equipment at cell centres; a cell-by-cell step at least BODY
    const least = leastClearance([POST, ...route.points]);
    assert.ok(least >= BODY - CELL / 2, `${r.id}: came within ${least.toFixed(2)} m of equipment`);
    assert.ok(route.points.length <= 8, `${r.id}: ${route.points.length} legs, should be a few straight ones`);
  }
});

test('a node is a hardware repair: worked on from the hot aisle behind its rack, facing it', () => {
  const [spot] = spotsFor(site, layout, { kind: 'node', id: 'node-417' }); // rack-r1-12, Row 1 faces north
  assert.ok(Math.abs(spot.z - hotAisleZ(0)) < 0.05, 'in the hot aisle between Rows 1 and 2');
  assert.equal(spot.face, Math.PI, 'facing north, at the back of the rack');
  assert.ok(standable(hall, [spot]).length === 1, 'a gull fits there');
});

test('nearest means nearest on foot, not as the crow flies', () => {
  // In the hot aisle between Rows 1 and 2, mid-row: a Row 3 rack is just across Row 2 and the
  // next cold aisle as the crow flies, but on foot it is out of this aisle and round the end of
  // the rows. A Row 1 rack at the far end of this same aisle is farther in a straight line and
  // much nearer to walk to.
  const from = { x: 0.93, z: hotAisleZ(0) };
  const across: Repair = { kind: 'node', id: firstNode('rack-r3-10') };
  const along: Repair = { kind: 'node', id: firstNode('rack-r1-01') };
  const crow = (r: Repair) => {
    const [s] = spotsFor(site, layout, r);
    return Math.hypot(s.x - from.x, s.z - from.z);
  };
  assert.ok(crow(across) < crow(along), 'Row 3 is nearer as the crow flies');

  const pick = planRoute(hall, from, [
    { tag: across, spots: spotsFor(site, layout, across) },
    { tag: along, spots: spotsFor(site, layout, along) },
  ]);
  assert.equal(pick?.tag, along);
  const walkAcross = planRoute(hall, from, [{ tag: across, spots: spotsFor(site, layout, across) }])!;
  assert.ok(routeLength([from, ...walkAcross.points]) > 1.5 * routeLength([from, ...pick!.points]), 'going round the rows is a long way');
});

test('planning a route is quick enough to do whenever the hall changes', () => {
  let t = performance.now();
  const g = buildHallGrid(site, layout);
  const build = performance.now() - t;
  t = performance.now();
  const r = planRoute(g, POST, [{ tag: 'cdu-3', spots: spotsFor(site, layout, { kind: 'part', id: 'cdu-3' }) }]);
  const plan = performance.now() - t;
  assert.ok(r);
  assert.ok(build < 250, `grid built in ${build.toFixed(0)} ms`);
  assert.ok(plan < 150, `route planned in ${plan.toFixed(0)} ms`);
});

// ---------- the tech ----------

/** A world with these things broken, and a tech on it that repairs by patching the world the way the store does. */
function setup(broken: Record<string, PartState>, opts: { applyRepairs?: boolean } = {}) {
  let world: World = initialWorld(site);
  for (const [id, state] of Object.entries(broken)) {
    if (site.parts[id]) world.partState[id] = state;
    else world.nodeState[id] = state;
  }
  const repaired: string[] = [];
  const tech = createTech({
    grid: hall,
    gull: gullAt(POST, POST.face),
    spots: (r) => spotsFor(site, layout, r),
    repair: (r) => {
      repaired.push(r.id);
      if (opts.applyRepairs === false) return;
      const next = structuredClone(world);
      if (r.kind === 'part') next.partState[r.id] = 'ok';
      else next.nodeState[r.id] = 'ok';
      world = next;
    },
  });
  return {
    tech,
    repaired,
    get world() {
      return world;
    },
    set world(w: World) {
      world = w;
    },
  };
}

/** Runs the tech at 20 fps until `until` says stop (or the time runs out). Returns the seconds it took. */
function run(s: ReturnType<typeof setup>, onDuty: (t: number) => boolean, until: (tech: Tech, t: number) => boolean, limit = 300, t0 = 0) {
  const dt = 0.05;
  let t = t0;
  let least = Infinity;
  for (; t < t0 + limit; t += dt) {
    s.tech.update(dt, t, onDuty(t), s.world);
    least = Math.min(least, clearance(s.tech.gull));
    if (until(s.tech, t)) break;
  }
  return { t, least };
}

const atPost = (tech: Tech) => tech.phase === 'idle' && Math.hypot(tech.gull.x - POST.x, tech.gull.z - POST.z) < 0.05;

test('only failed and degraded things need a tech', () => {
  const w = initialWorld(site);
  w.partState['cdu-3'] = 'degraded';
  w.partState['cdu-4'] = 'maintenance';
  w.nodeState['node-417'] = 'failed';
  assert.deepEqual(brokenIn(w), [
    { kind: 'part', id: 'cdu-3' },
    { kind: 'node', id: 'node-417' },
  ]);
});

test('off duty, the tech stays at its post whatever is broken', () => {
  const s = setup({ 'cdu-3': 'degraded', 'node-417': 'failed' });
  run(s, () => false, () => false, 30);
  assert.deepEqual(s.repaired, []);
  assert.ok(atPost(s.tech));
});

test('on duty, it fixes every failure, nearest on foot first, then goes back to its post', () => {
  const far = firstNode('rack-r10-16');
  const s = setup({ 'cdu-3': 'degraded', 'node-417': 'failed', [far]: 'failed' });

  // the first pick is whichever is cheapest to walk to from the post
  const cost = (r: Repair) => planRoute(hall, POST, [{ tag: r, spots: spotsFor(site, layout, r) }])!.cost;
  const candidates: Repair[] = [
    { kind: 'part', id: 'cdu-3' },
    { kind: 'node', id: 'node-417' },
    { kind: 'node', id: far },
  ];
  const nearest = candidates.reduce((a, b) => (cost(b) < cost(a) ? b : a));

  const { t, least } = run(s, () => true, (tech) => s.repaired.length === 3 && atPost(tech));
  assert.equal(s.repaired.length, 3, `repaired ${s.repaired.join(', ')}`);
  assert.equal(s.repaired[0], nearest.id);
  assert.deepEqual(s.repaired, [far, 'node-417', 'cdu-3'], 'Row 10 first (nearest the post), then Row 1, then the CDU at the far west end');
  assert.deepEqual(brokenIn(s.world), []);
  assert.ok(atPost(s.tech), 'back at its post');
  assert.ok(least >= BODY - CELL / 2, `walked within ${least.toFixed(2)} m of equipment`);
  assert.ok(t < 150, `took ${t.toFixed(0)} s`);
});

test('called off duty mid-repair, it leaves the job and walks back', () => {
  const s = setup({ 'node-417': 'failed' });
  const working = run(s, () => true, (tech) => tech.phase === 'working' && tech.progress > 0.3);
  assert.equal(s.tech.phase, 'working');
  run(s, () => false, (tech) => atPost(tech), 120, working.t);
  assert.deepEqual(s.repaired, []);
  assert.equal(s.world.nodeState['node-417'], 'failed');
  assert.ok(atPost(s.tech));
});

test('if someone else fixes what it is walking to, it heads for the next one', () => {
  const s = setup({ 'node-417': 'failed', 'cdu-3': 'degraded' });
  run(s, () => true, (tech) => tech.phase === 'walking' && tech.job !== null);
  const first = s.tech.job!;
  const fixed = structuredClone(s.world);
  if (first.kind === 'part') fixed.partState[first.id] = 'ok';
  else fixed.nodeState[first.id] = 'ok';
  s.world = fixed; // the backend repaired it meanwhile
  s.tech.update(0.05, 1000, true, s.world);
  assert.ok(s.tech.job && s.tech.job.id !== first.id, 'it changed course straight away');
  run(s, () => true, (tech) => atPost(tech) && brokenIn(s.world).length === 0, 300, 1000);
  assert.equal(s.repaired.length, 1, 'it fixed only the one left');
  assert.notEqual(s.repaired[0], first.id);
});

test('a repair that does not take is tried once more, then left alone', () => {
  const s = setup({ 'node-417': 'failed' }, { applyRepairs: false }); // the backend refuses
  run(s, () => true, (_, t) => t > 3 * (RETRY_AFTER + 30));
  assert.deepEqual(s.repaired, ['node-417', 'node-417']);
  assert.ok(atPost(s.tech), 'it gives up and goes back to its post');
});

// ---------- the entrance and the office ----------

const lockAt = () => createAirlock({ doors: ENTRY.doors, z: ENTRY.z, width: WALL.door });

test('the entrance doors: one opens when asked, the other only once the first has shut', () => {
  const doors = lockAt();
  const dt = 0.05;
  const tick = (ask: (0 | 1)[], people = []) => {
    for (const d of ask) doors.request(d);
    doors.update(dt, people);
    assert.ok(doors.open[0] === 0 || doors.open[1] === 0, 'never both open at once');
  };
  for (let t = 0; t < DOOR_OPEN_TIME + 0.2; t += dt) tick([0, 1]); // both asked for: the hall side goes first
  assert.ok(doors.isOpen(0));
  assert.equal(doors.open[1], 0);
  assert.ok(doors.isLocked(1), 'the office side is locked while the hall side is open');
  for (let t = 0; t < 0.5; t += dt) tick([1]); // the far door is asked for: the near one starts closing, the far one waits
  assert.equal(doors.open[1], 0);
  assert.ok(doors.open[0] > 0 && doors.open[0] < 1);
  for (let t = 0; t < DOOR_CLOSE_TIME + DOOR_OPEN_TIME + 0.3; t += dt) tick([1]);
  assert.equal(doors.open[0], 0);
  assert.ok(doors.isOpen(1));
});

test('someone standing in a doorway holds that door open', () => {
  const doors = lockAt();
  for (let t = 0; t < 1.2; t += 0.05) {
    doors.request(0);
    doors.update(0.05, []);
  }
  const inIt = { x: ENTRY.doors[0], z: ENTRY.z };
  for (let t = 0; t < 3; t += 0.05) doors.update(0.05, [inIt]);
  assert.ok(doors.isOpen(0), 'still open with someone in it');
  for (let t = 0; t < 3; t += 0.05) doors.update(0.05, []);
  assert.equal(doors.open[0], 0, 'shut once they have gone');
});

function officeSetup(broken: Record<string, PartState>) {
  const doors = lockAt();
  const office = buildOffice(doors);
  let world: World = initialWorld(site);
  for (const [id, state] of Object.entries(broken)) {
    if (site.parts[id]) world.partState[id] = state;
    else world.nodeState[id] = state;
  }
  const repaired: string[] = [];
  const tech = createTech({
    grid: hall,
    office,
    gull: gullAt(office.desk, office.desk.face),
    spots: (r) => spotsFor(site, layout, r),
    repair: (r) => {
      repaired.push(r.id);
      const next = structuredClone(world);
      if (r.kind === 'part') next.partState[r.id] = 'ok';
      else next.nodeState[r.id] = 'ok';
      world = next;
    },
  });
  return { tech, doors, office, repaired, world: () => world };
}

test('the office is reached only through the doors: the hall floor and the office floor do not join', () => {
  const { office } = officeSetup({});
  const [nodeSpot] = spotsFor(site, layout, { kind: 'node', id: 'node-417' });
  assert.equal(cellAt(office.grid, nodeSpot.x, nodeSpot.z), -1, 'the hall is not on the office floor');
  assert.equal(cellAt(hall, office.desk.x, office.desk.z), -1, 'and the office is not on the hall floor');
  assert.ok(walkable(hall, cellAt(hall, ENTRY.hallSide.x, ENTRY.hallSide.z)), 'it can wait for the hall-side door');
  const out = planRoute(office.grid, office.desk, [{ tag: 'x', spots: [{ ...office.desk, x: ENTRY.officeSide.x, z: ENTRY.officeSide.z }] }]);
  assert.ok(out, 'and, down the corridor, for the corridor-side one');
  // from the desk it leaves by the office door, then walks up the corridor to the entrance
  const walk = [office.desk, ...out.points];
  const c = ENTRY.corridor;
  const d = ENTRY.officeDoor;
  const through = walk.some((p, i) => i > 0 && walk[i - 1].x > d.x && p.x <= d.x) || walk.some((p) => Math.abs(p.x - d.x) < 0.1);
  assert.ok(through, 'through the office door');
  const crossing = (a: Point, b: Point) => (d.x - a.x) / (b.x - a.x);
  for (let i = 1; i < walk.length; i++) {
    const [a, b] = [walk[i - 1], walk[i]];
    if ((a.x - d.x) * (b.x - d.x) < 0) {
      const z = a.z + (b.z - a.z) * crossing(a, b);
      assert.ok(Math.abs(z - d.z) < WALL.door / 2, `crosses the office wall in its doorway (z ${z.toFixed(2)})`);
    }
  }
  assert.ok(walk.every((p) => p.x < c.x1 || (p.z > ENTRY.office.z0 && p.z < ENTRY.office.z1)), 'east of the corridor only inside the office');
  assert.ok(Math.abs(office.desk.z - ENTRY.z) > 6, 'the office is well away from the entrance');
});

test('on duty it leaves its office through both doors, repairs, and comes back to its desk', () => {
  const s = officeSetup({ 'node-417': 'failed' });
  const dt = 0.05;
  let sawHallway = false;
  let sawBothOpen = false;
  let lockedWhileInside = false;
  let t = 0;
  const home = () => s.tech.zone === 'office' && s.tech.phase === 'idle' && Math.hypot(s.tech.gull.x - s.office.desk.x, s.tech.gull.z - s.office.desk.z) < 0.05;
  for (; t < 300; t += dt) {
    s.tech.update(dt, t, true, s.world());
    const g = s.tech.gull;
    const h = ENTRY.hallway;
    if (g.x > h.x0 && g.x < h.x1) {
      sawHallway = true;
      if (s.doors.isLocked(0) || s.doors.isLocked(1)) lockedWhileInside = true;
    }
    if (s.doors.open[0] > 0 && s.doors.open[1] > 0) sawBothOpen = true;
    if (s.repaired.length === 1 && home()) break;
  }
  assert.deepEqual(s.repaired, ['node-417']);
  assert.ok(home(), 'back at its desk');
  assert.ok(sawHallway, 'it went through the hallway between the doors');
  assert.ok(lockedWhileInside, 'one door was locked while it was between them');
  assert.ok(!sawBothOpen, 'the two doors were never open together');
  assert.ok(t < 200, `took ${t.toFixed(0)} s`);
});

test('off duty it stays at its desk; called off on the way out, it goes back to the desk', () => {
  const s = officeSetup({ 'node-417': 'failed' });
  for (let t = 0; t < 20; t += 0.05) s.tech.update(0.05, t, false, s.world());
  assert.equal(s.tech.zone, 'office');
  assert.equal(s.tech.phase, 'idle');
  let t = 20;
  for (; t < 60 && s.tech.zone === 'office'; t += 0.05) s.tech.update(0.05, t, true, s.world());
  assert.equal(s.tech.zone, 'hall', 'it went out');
  for (; t < 200; t += 0.05) {
    s.tech.update(0.05, t, false, s.world());
    if (s.tech.zone === 'office' && s.tech.phase === 'idle') break;
  }
  assert.equal(s.tech.zone, 'office');
  assert.deepEqual(s.repaired, []);
});

/** Somewhere a gull may stand: free floor in the hall or on the office side, or in the hallway between the doors. */
function legal(office: ReturnType<typeof buildOffice>, p: Point): boolean {
  const h = ENTRY.hallway;
  // the hallway between the doors, and straight through either doorway
  const inHallway = p.x >= h.x0 && p.x <= h.x1 && Math.abs(p.z - ENTRY.z) <= (h.z1 - h.z0) / 2 - BODY + 0.05;
  const inDoorway = p.x >= ENTRY.doors[0] - 0.5 && p.x <= ENTRY.doors[1] + 0.5 && Math.abs(p.z - ENTRY.z) <= WALL.door / 2 - 0.2;
  const onFloor = (g: typeof hall) => {
    const i = cellAt(g, p.x, p.z);
    return i >= 0 && g.clear[i] >= BODY - CELL;
  };
  return inHallway || inDoorway || onFloor(hall) || onFloor(office.grid);
}

/** A tech made afresh (as after a reset reseeds the hall) around a gull standing at `p`, run off duty until it is home. */
function homeFrom(p: Point) {
  const doors = lockAt();
  const office = buildOffice(doors);
  const tech = createTech({ grid: hall, office, gull: gullAt(p), spots: (r) => spotsFor(site, layout, r), repair: () => {} });
  const world = initialWorld(site);
  const off: Point[] = [];
  let t = 0;
  for (; t < 200; t += 0.05) {
    tech.update(0.05, t, false, world);
    if (!legal(office, tech.gull)) off.push({ x: tech.gull.x, z: tech.gull.z });
    if (tech.zone === 'office' && tech.phase === 'idle' && Math.hypot(tech.gull.x - office.desk.x, tech.gull.z - office.desk.z) < 0.05) break;
  }
  return { tech, office, off, t };
}

test('a fresh tech out in the hall walks home the legal way: through both doors, not through walls', () => {
  const [spot] = spotsFor(site, layout, { kind: 'node', id: 'node-417' }); // deep in a hot aisle
  const { tech, office, off } = homeFrom(spot);
  assert.equal(tech.zone, 'office');
  assert.ok(Math.hypot(tech.gull.x - office.desk.x, tech.gull.z - office.desk.z) < 0.05, 'at its desk');
  assert.deepEqual(off.slice(0, 3), [], `${off.length} steps off the floor`);
});

test('a fresh tech part way through the doors finishes going through, then walks home', () => {
  const { tech, office, off } = homeFrom(ENTRY.middle);
  assert.equal(tech.zone, 'office');
  assert.ok(Math.hypot(tech.gull.x - office.desk.x, tech.gull.z - office.desk.z) < 0.05, 'at its desk');
  assert.deepEqual(off.slice(0, 3), []);
});

test('on its way out of the office, its plan runs through both doors all the way to the repair', () => {
  const s = officeSetup({ 'node-417': 'failed' });
  s.tech.update(0.05, 0, true, s.world());
  assert.equal(s.tech.zone, 'office');
  const plan = s.tech.plan;
  const [spot] = spotsFor(site, layout, { kind: 'node', id: 'node-417' });
  const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z) < 0.2;
  assert.ok(plan.some((p) => near(p, ENTRY.officeSide)), 'to the corridor-side door');
  assert.ok(plan.some((p) => near(p, ENTRY.middle)), 'into the hallway between the doors');
  assert.ok(plan.some((p) => near(p, ENTRY.hallSide)), 'out by the hall-side door');
  assert.ok(near(plan[plan.length - 1], spot), 'and on to the node');
  // in order, and every leg on legal floor
  const idx = (q: Point) => plan.findIndex((p) => near(p, q));
  assert.ok(idx(ENTRY.officeSide) < idx(ENTRY.middle) && idx(ENTRY.middle) < idx(ENTRY.hallSide));
  const walk = [s.tech.gull, ...plan];
  for (let i = 1; i < walk.length; i++) {
    for (let k = 0; k <= 20; k++) {
      const p = { x: walk[i - 1].x + ((walk[i].x - walk[i - 1].x) * k) / 20, z: walk[i - 1].z + ((walk[i].z - walk[i - 1].z) * k) / 20 };
      assert.ok(legal(s.office, p), `leg ${i} leaves the floor at ${p.x.toFixed(2)}, ${p.z.toFixed(2)}`);
    }
  }
  // and while it waits at the doors, the plan still runs on to the node
  for (let t = 0.05; t < 60 && s.tech.phase !== 'doors'; t += 0.05) s.tech.update(0.05, t, true, s.world());
  assert.equal(s.tech.phase, 'doors');
  assert.ok(near(s.tech.plan[s.tech.plan.length - 1], spot));
});
