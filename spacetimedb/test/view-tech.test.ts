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
import { buildPartLayout, coldAisleZs, HALL } from '../../frontend/src/scene/layout';
import {
  BODY,
  CELL,
  buildGrid,
  buildHallGrid,
  dijkstra,
  forEachStep,
  hallObstacles,
  nearestFree,
  planRoute,
  routeLength,
  spotsFor,
  standable,
  type Point,
  type Rect,
  type Repair,
} from '../../frontend/src/scene/nav';
import { POST, RETRY_AFTER, brokenIn, createTech, type Tech } from '../../frontend/src/scene/rounds';

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

test('a node is worked on from the aisle in front of its rack, facing it', () => {
  const [spot] = spotsFor(site, layout, { kind: 'node', id: 'node-417' }); // rack-r1-12, Row 1 faces north
  const north = coldAisleZs()[0];
  assert.ok(Math.abs(spot.z - north) < 0.5, 'in the cold aisle north of Row 1');
  assert.equal(spot.face, 0, 'facing south, at the rack');
});

test('nearest means nearest on foot, not as the crow flies', () => {
  // In the cold aisle between Rows 2 and 3: a Row 1 rack is just across Row 2 as the crow
  // flies, but on foot it is round the end of the row. A Row 3 rack at the far end of this same
  // aisle is farther in a straight line and much nearer to walk to.
  const from = { x: 2, z: coldAisleZs()[1] };
  const across: Repair = { kind: 'node', id: firstNode('rack-r1-12') };
  const along: Repair = { kind: 'node', id: firstNode('rack-r3-01') };
  const crow = (r: Repair) => {
    const [s] = spotsFor(site, layout, r);
    return Math.hypot(s.x - from.x, s.z - from.z);
  };
  assert.ok(crow(across) < crow(along), 'Row 1 is nearer as the crow flies');

  const pick = planRoute(hall, from, [
    { tag: across, spots: spotsFor(site, layout, across) },
    { tag: along, spots: spotsFor(site, layout, along) },
  ]);
  assert.equal(pick?.tag, along);
  const walkAcross = planRoute(hall, from, [{ tag: across, spots: spotsFor(site, layout, across) }])!;
  assert.ok(routeLength([from, ...walkAcross.points]) > 1.5 * routeLength([from, ...pick!.points]), 'going round Row 2 is a long way');
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
