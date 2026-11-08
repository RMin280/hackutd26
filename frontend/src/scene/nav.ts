// Path planning for the floor crew: Dijkstra's algorithm on a walkable grid of the hall.
//
// The floor is cut into 15 cm cells. Racks, cooling units, PDUs, switches and the power-room
// gear are obstacles, and every cell knows how far its centre is from the nearest one (or from
// the edge of the floor). A gull's centre needs BODY metres of that, so the whole bird stays
// clear. Walking a cell costs more the closer it is to equipment, so the cheapest route keeps to
// the middle of an aisle instead of scraping along the racks, and only takes a narrow hot aisle
// when that saves a lot.
//
// One Dijkstra run from where the gull stands prices every cell it can reach. That answers both
// of the tech's questions at once: which repair is nearest on foot (not as the crow flies: a row
// of racks is usually in the way), and the route there. The cell-by-cell path is then pulled
// taut wherever a straight line keeps clear of equipment, so the gull walks straight legs with a
// few turns instead of a staircase.
//
// Pure geometry: no three.js, no React, no facility logic. Tested in
// spacetimedb/test/view-tech.test.ts.

import type { Site } from '../model/types';
import { AISLE, HALL, RACK, nodeCenter, posX, rowFacing, rowZ, type PartBox } from './layout';

export const CELL = 0.15; // metres
/** Half a gull's width, near enough: its centre keeps at least this far from equipment. */
export const BODY = 0.3;
/** A pulled-taut leg keeps this far from equipment (BODY plus most of a cell, for the corners). */
const TAUT = 0.42;
/** Clearance at which walking stops costing extra: the middle of a cold aisle is roomier than this. */
const ROOMY = 0.8;
/** Extra cost per metre right at BODY clearance. The middle of a hot aisle pays 0.6 of a metre extra. */
const CRAMPED = 1.5;
/** Clearances are only tracked this far out. */
const CAP = 1;
/** The tech stands this far from the face it works on: close enough that its bill just reaches it when it pecks. */
const STAND = 0.72;

export interface Point {
  x: number;
  z: number;
}

/** An axis-aligned footprint on the floor. */
export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface NavGrid {
  x0: number;
  z0: number;
  cell: number;
  cols: number;
  rows: number;
  /** Metres from each cell's centre to the nearest obstacle or the edge of the floor, capped at CAP. */
  clear: Float32Array;
  /** Cost of walking one metre through the cell; Infinity where a gull doesn't fit. */
  cost: Float32Array;
}

const distToRect = (x: number, z: number, r: Rect) =>
  Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.z0 - z, 0, z - r.z1));

/** Rasterises a floor with obstacles on it. Each obstacle only touches the cells within CAP of it. */
export function buildGrid(floor: Rect, obstacles: Rect[], cell = CELL): NavGrid {
  const cols = Math.max(1, Math.ceil((floor.x1 - floor.x0) / cell));
  const rows = Math.max(1, Math.ceil((floor.z1 - floor.z0) / cell));
  const clear = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const z = floor.z0 + (r + 0.5) * cell;
    for (let c = 0; c < cols; c++) {
      const x = floor.x0 + (c + 0.5) * cell;
      clear[r * cols + c] = Math.max(0, Math.min(CAP, x - floor.x0, floor.x1 - x, z - floor.z0, floor.z1 - z));
    }
  }
  const clampCol = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor((x - floor.x0) / cell)));
  const clampRow = (z: number) => Math.min(rows - 1, Math.max(0, Math.floor((z - floor.z0) / cell)));
  for (const o of obstacles) {
    const c0 = clampCol(o.x0 - CAP);
    const c1 = clampCol(o.x1 + CAP);
    const r0 = clampRow(o.z0 - CAP);
    const r1 = clampRow(o.z1 + CAP);
    for (let r = r0; r <= r1; r++) {
      const z = floor.z0 + (r + 0.5) * cell;
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c;
        const d = distToRect(floor.x0 + (c + 0.5) * cell, z, o);
        if (d < clear[i]) clear[i] = d;
      }
    }
  }
  const cost = new Float32Array(cols * rows);
  for (let i = 0; i < cost.length; i++) {
    cost[i] = clear[i] < BODY ? Infinity : 1 + CRAMPED * Math.max(0, (ROOMY - clear[i]) / (ROOMY - BODY));
  }
  return { x0: floor.x0, z0: floor.z0, cell, cols, rows, clear, cost };
}

/** Footprints of everything a gull walks around: each row of racks, and every facility part. */
export function hallObstacles(site: Site, layout: Record<string, PartBox>): Rect[] {
  const rows = new Map<number, { x0: number; x1: number }>();
  for (const id of site.rackOrder) {
    const r = site.racks[id];
    const x = posX(r.pos);
    const span = rows.get(r.row) ?? { x0: Infinity, x1: -Infinity };
    span.x0 = Math.min(span.x0, x - RACK.w / 2);
    span.x1 = Math.max(span.x1, x + RACK.w / 2);
    rows.set(r.row, span);
  }
  const out: Rect[] = [];
  for (const [row, span] of rows) out.push({ x0: span.x0, x1: span.x1, z0: rowZ(row) - RACK.d / 2, z1: rowZ(row) + RACK.d / 2 });
  for (const box of Object.values(layout)) {
    const [x, , z] = box.pos;
    const [w, , d] = box.size;
    out.push({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 });
  }
  return out;
}

/** The demo hall's floor slab as a grid. Gulls stay on the slab, so the chillers out past its west edge are worked on from the edge. */
export const buildHallGrid = (site: Site, layout: Record<string, PartBox>): NavGrid =>
  buildGrid({ x0: HALL.x0, z0: HALL.z0, x1: HALL.x1, z1: HALL.z1 }, hallObstacles(site, layout));

export function cellAt(g: NavGrid, x: number, z: number): number {
  const c = Math.floor((x - g.x0) / g.cell);
  const r = Math.floor((z - g.z0) / g.cell);
  return c < 0 || r < 0 || c >= g.cols || r >= g.rows ? -1 : r * g.cols + c;
}

export const centerOf = (g: NavGrid, i: number): Point => ({
  x: g.x0 + ((i % g.cols) + 0.5) * g.cell,
  z: g.z0 + (Math.floor(i / g.cols) + 0.5) * g.cell,
});

export const walkable = (g: NavGrid, i: number): boolean => i >= 0 && i < g.cost.length && g.cost[i] < Infinity;

const STEPS: readonly (readonly [number, number, number])[] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/**
 * Calls visit(v, cost) for every walkable cell one step from u, in all eight directions. A
 * diagonal step needs both cells beside it free, so a route never squeezes between two
 * obstacles that only touch at a corner. The cost is the step's length times the average of
 * the two cells' costs.
 */
export function forEachStep(g: NavGrid, u: number, visit: (v: number, cost: number) => void): void {
  const cu = u % g.cols;
  const ru = (u - cu) / g.cols;
  for (const [dc, dr, len] of STEPS) {
    const c = cu + dc;
    const r = ru + dr;
    if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
    const v = r * g.cols + c;
    if (!(g.cost[v] < Infinity)) continue;
    if (dc !== 0 && dr !== 0 && (!(g.cost[ru * g.cols + c] < Infinity) || !(g.cost[r * g.cols + cu] < Infinity))) continue;
    visit(v, (len * g.cell * (g.cost[u] + g.cost[v])) / 2);
  }
}

/** A binary min-heap of cell indices. Entries are never updated in place: a cheaper one is pushed and the stale one skipped when popped. */
class MinHeap {
  private items: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, key: number): void {
    const a = this.items;
    const k = this.keys;
    let i = a.length;
    a.push(item);
    k.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      a[i] = a[p];
      k[i] = k[p];
      i = p;
    }
    a[i] = item;
    k[i] = key;
  }

  pop(): number {
    const a = this.items;
    const k = this.keys;
    const top = a[0];
    const item = a.pop()!;
    const key = k.pop()!;
    const n = a.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= key) break;
        a[i] = a[c];
        k[i] = k[c];
        i = c;
      }
      a[i] = item;
      k[i] = key;
    }
    return top;
  }
}

/** Cheapest cost from the source to every cell, and the cell each one is best reached from. */
export interface Field {
  source: number;
  dist: Float64Array;
  prev: Int32Array;
}

/** Dijkstra's algorithm from one walkable cell over the whole grid. */
export function dijkstra(g: NavGrid, source: number): Field {
  const n = g.cols * g.rows;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap();
  dist[source] = 0;
  heap.push(source, 0);
  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u]) continue; // stale: u was already settled through a cheaper entry
    done[u] = 1;
    const du = dist[u];
    forEachStep(g, u, (v, w) => {
      const d = du + w;
      if (d < dist[v]) {
        dist[v] = d;
        prev[v] = u;
        heap.push(v, d);
      }
    });
  }
  return { source, dist, prev };
}

/** The cells from the field's source to `target`, both included; empty when it can't be reached. */
export function trace(f: Field, target: number): number[] {
  if (!(f.dist[target] < Infinity)) return [];
  const out: number[] = [];
  for (let i = target; i !== -1; i = f.prev[i]) out.push(i);
  return out.reverse();
}

/** The walkable cell nearest to (x, z) within `reach` metres (points off the floor are pulled onto it first), or -1. */
export function nearestFree(g: NavGrid, x: number, z: number, reach = 2): number {
  const half = g.cell / 2;
  const cx = Math.min(Math.max(x, g.x0 + half), g.x0 + g.cols * g.cell - half);
  const cz = Math.min(Math.max(z, g.z0 + half), g.z0 + g.rows * g.cell - half);
  const i0 = cellAt(g, cx, cz);
  if (walkable(g, i0)) return i0;
  const c0 = i0 % g.cols;
  const r0 = (i0 - c0) / g.cols;
  let best = -1;
  let bestD = Infinity;
  const rings = Math.ceil(reach / g.cell);
  for (let k = 1; k <= rings; k++) {
    for (let r = r0 - k; r <= r0 + k; r++) {
      if (r < 0 || r >= g.rows) continue;
      const edge = r === r0 - k || r === r0 + k;
      for (let c = c0 - k; c <= c0 + k; c += edge ? 1 : 2 * k) {
        if (c < 0 || c >= g.cols) continue;
        const i = r * g.cols + c;
        if (!walkable(g, i)) continue;
        const p = centerOf(g, i);
        const d = Math.hypot(p.x - cx, p.z - cz);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    // nothing on a farther ring can be closer than this
    if (best >= 0 && bestD <= (k + 0.5) * g.cell) break;
  }
  return best;
}

/** Whether a straight leg from a to b keeps `need` metres from equipment all the way. */
export function clearLine(g: NavGrid, a: Point, b: Point, need = TAUT): boolean {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(len / (g.cell / 2)));
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const i = cellAt(g, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    if (i < 0 || g.clear[i] < need) return false;
  }
  return true;
}

/**
 * Pulls a cell-by-cell path taut: from each corner, walk on to the farthest point the gull can
 * still reach in a straight clear line, and turn there. Keeps the first and last points.
 */
export function pullTaut(g: NavGrid, pts: Point[]): Point[] {
  if (pts.length <= 2) return pts.slice();
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = i + 1;
    while (j + 1 < pts.length && clearLine(g, pts[i], pts[j + 1])) j++;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

export const routeLength = (pts: Point[]): number => {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return d;
};

// ---------- where to stand ----------

/** Something the tech can repair. */
export interface Repair {
  kind: 'node' | 'part';
  id: string;
}

/** A place to stand and work. */
export interface Spot {
  x: number;
  z: number;
  /** The way to face while working: yaw, 0 = facing south (+z), PI = north. */
  face: number;
  /** The point being worked on (where the sparks fly): x, height, z. */
  work: [number, number, number];
}

/**
 * Where a tech can stand to work on something. A node is a hardware repair at the back of the
 * rack, so the tech goes into the hot aisle behind it (down the middle, the aisle is narrow) and
 * faces the rear panel. A facility part from any of its four sides; whichever is cheapest to
 * reach wins (a side tight against something else won't be walkable, and is skipped).
 */
export function spotsFor(site: Site, layout: Record<string, PartBox>, r: Repair): Spot[] {
  if (r.kind === 'node') {
    const n = site.nodes[r.id];
    const rack = n && site.racks[n.rack];
    if (!rack) return [];
    const back = -rowFacing(n.row); // the rear of the rack opens onto the hot aisle
    return [
      {
        x: posX(rack.pos),
        z: rowZ(n.row) + back * (RACK.d / 2 + Math.min(STAND, AISLE.hot / 2)),
        face: back < 0 ? 0 : Math.PI,
        work: nodeCenter(site, r.id, -1),
      },
    ];
  }
  const box = layout[r.id];
  if (!box) return [];
  const [x, , z] = box.pos;
  const [w, h, d] = box.size;
  const y = Math.min(h * 0.6, 1.2);
  const sides: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  return sides.map(([nx, nz]) => {
    const half = nx !== 0 ? w / 2 : d / 2;
    return {
      x: x + nx * (half + STAND),
      z: z + nz * (half + STAND),
      face: Math.atan2(-nx, -nz),
      work: [x + nx * half, y, z + nz * half],
    };
  });
}

/**
 * The cells a gull can actually stand on for these spots: each spot nudged onto free floor if
 * it sits a little too close to something. If none of them is on the floor at all (a chiller
 * out past the edge of the slab), the nearest floor to the work point will do.
 */
export function standable(g: NavGrid, spots: Spot[]): { spot: Spot; cell: number }[] {
  const out: { spot: Spot; cell: number }[] = [];
  const onCell = (s: Spot, cell: number): Spot => {
    const p = centerOf(g, cell);
    return { ...s, x: p.x, z: p.z, face: Math.atan2(s.work[0] - p.x, s.work[2] - p.z) };
  };
  for (const s of spots) {
    const at = cellAt(g, s.x, s.z);
    if (walkable(g, at)) {
      out.push({ spot: s, cell: at });
      continue;
    }
    if (at < 0) continue; // off the floor
    const near = nearestFree(g, s.x, s.z, BODY);
    if (near >= 0) out.push({ spot: onCell(s, near), cell: near });
  }
  if (out.length === 0 && spots.length > 0) {
    const s = spots[0];
    const near = nearestFree(g, s.work[0], s.work[2], 5);
    if (near >= 0) out.push({ spot: onCell(s, near), cell: near });
  }
  return out;
}

// ---------- planning ----------

export interface Option<T> {
  tag: T;
  spots: Spot[];
}

export interface Route<T> {
  tag: T;
  /** Where it ends up standing. */
  spot: Spot;
  /** The legs to walk, in order; the last point is the spot. The starting point is not included. */
  points: Point[];
  /** What the route costs (metres, weighted by how cramped it is). */
  cost: number;
}

/**
 * From where the gull stands, the cheapest option to walk to and the route there. One Dijkstra
 * run prices every option; ties go to the earlier one. Null when none can be reached.
 */
export function planRoute<T>(g: NavGrid, from: Point, options: Option<T>[]): Route<T> | null {
  const source = nearestFree(g, from.x, from.z);
  if (source < 0) return null;
  const field = dijkstra(g, source);
  let best: { tag: T; spot: Spot; cell: number; cost: number } | null = null;
  for (const o of options) {
    for (const { spot, cell } of standable(g, o.spots)) {
      const cost = field.dist[cell];
      if (cost < (best?.cost ?? Infinity)) best = { tag: o.tag, spot, cell, cost };
    }
  }
  if (!best) return null;
  // If the gull stands just off the free floor, its route starts by stepping onto it.
  const cells = trace(field, best.cell).slice(cellAt(g, from.x, from.z) === source ? 1 : 0);
  const raw: Point[] = [{ x: from.x, z: from.z }, ...cells.map((c) => centerOf(g, c)), { x: best.spot.x, z: best.spot.z }];
  const points = pullTaut(g, raw)
    .slice(1)
    .filter((p, i, all) => i === all.length - 1 || Math.hypot(all[i + 1].x - p.x, all[i + 1].z - p.z) > 0.05);
  return { tag: best.tag, spot: best.spot, points, cost: best.cost };
}
