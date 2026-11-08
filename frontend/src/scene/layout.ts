// Where everything sits in the 3D hall. Pure geometry, no facility logic.
//
// Rows pair up back-to-back around an enclosed hot aisle, and cold aisles run
// between the pairs. Odd rows face north (-z), even rows face south (+z), so
// every rack draws cold air from a cold aisle and exhausts into a hot aisle.

import type { PartType, Site } from '../model/types';

export const RACK = { w: 0.6, h: 2.0, d: 1.0, pitchX: 0.62 };
export const NODE = { w: 0.5, h: 0.17, d: 0.03, base: 0.22, pitch: 0.215 };
export const AISLE = { hot: 1.2, cold: 1.8 };
export const PAIR_PITCH = 2 * RACK.d + AISLE.hot + AISLE.cold;

const ROWS = 10;
const PAIRS = ROWS / 2;
const FIRST_Z = RACK.d / 2;
const LAST_Z = (PAIRS - 1) * PAIR_PITCH + RACK.d + AISLE.hot + RACK.d / 2;
const Z_CENTER = (FIRST_Z + LAST_Z) / 2;

export type Vec3 = [number, number, number];

/** -1: the row's front faces north (-z); +1: it faces south (+z). */
export const rowFacing = (row: number) => ((row - 1) % 2 === 0 ? -1 : 1);

export function rowZ(row: number): number {
  const pair = Math.floor((row - 1) / 2);
  const second = (row - 1) % 2 === 1;
  return pair * PAIR_PITCH + RACK.d / 2 + (second ? RACK.d + AISLE.hot : 0) - Z_CENTER;
}

export const posX = (pos: number) => (pos - 8.5) * RACK.pitchX;
export const ROW_X0 = posX(1) - RACK.w / 2;
export const ROW_X1 = posX(16) + RACK.w / 2;
export const ROW_LEN = ROW_X1 - ROW_X0;
export const ROW_CX = (ROW_X0 + ROW_X1) / 2;

export const PAIR_COUNT = PAIRS;
/** Centre of the hot aisle for row pair p (0-based): rows 2p+1 and 2p+2. */
export const hotAisleZ = (pair: number) => (rowZ(pair * 2 + 1) + rowZ(pair * 2 + 2)) / 2;

/** Cold aisle centres: north of row 1, between each pair, south of row 10. */
export function coldAisleZs(): number[] {
  const out = [rowZ(1) - RACK.d / 2 - AISLE.cold / 2];
  for (let p = 0; p < PAIRS - 1; p++) {
    out.push((rowZ(p * 2 + 2) + RACK.d / 2 + rowZ(p * 2 + 3) - RACK.d / 2) / 2);
  }
  out.push(rowZ(ROWS) + RACK.d / 2 + AISLE.cold / 2);
  return out;
}

export const POWER_ROOM_Z = rowZ(1) - RACK.d / 2 - AISLE.cold - 3.2;

/** The raised-floor slab the whole hall sits on. */
export const HALL = (() => {
  const x0 = ROW_X0 - 3.9;
  const x1 = ROW_X1 + 4.7;
  const z0 = POWER_ROOM_Z - 1.9;
  const z1 = rowZ(ROWS) + RACK.d / 2 + AISLE.cold + 0.4;
  return { x0, x1, z0, z1, w: x1 - x0, d: z1 - z0, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
})();

export function rackBase(site: Site, rackId: string): Vec3 {
  const r = site.racks[rackId];
  return [posX(r.pos), 0, rowZ(r.row)];
}

/** side 1 = front panel, -1 = rear panel. */
export function nodeCenter(site: Site, nodeId: string, side: 1 | -1 = 1): Vec3 {
  const n = site.nodes[nodeId];
  const [x, , z] = rackBase(site, n.rack);
  const f = rowFacing(n.row) * side;
  return [x, NODE.base + n.slot * NODE.pitch + NODE.h / 2, z + f * (RACK.d / 2 + NODE.d / 2 + 0.004)];
}

export interface PartBox {
  pos: Vec3; // centre of the base, on the floor
  size: Vec3;
  group: 'power' | 'cooling' | 'network';
}

const GROUP: Record<PartType, PartBox['group']> = {
  utility: 'power',
  switchgear: 'power',
  ups: 'power',
  pdu: 'power',
  chiller: 'cooling',
  cdu: 'cooling',
  spine: 'network',
  leaf: 'network',
};

export function buildPartLayout(site: Site): Record<string, PartBox> {
  const out: Record<string, PartBox> = {};
  const cdusPerRow: Record<number, number> = {};
  const fixed: Record<string, { x: number; z: number; size: Vec3 }> = {
    'util-a': { x: -6.4, z: POWER_ROOM_Z, size: [1.3, 1.1, 1.3] },
    'switchgear-a': { x: -4.4, z: POWER_ROOM_Z, size: [1.5, 1.9, 0.9] },
    'ups-a': { x: -2.4, z: POWER_ROOM_Z, size: [1.5, 1.7, 0.9] },
    'ups-b': { x: 2.4, z: POWER_ROOM_Z, size: [1.5, 1.7, 0.9] },
    'switchgear-b': { x: 4.4, z: POWER_ROOM_Z, size: [1.5, 1.9, 0.9] },
    'util-b': { x: 6.4, z: POWER_ROOM_Z, size: [1.3, 1.1, 1.3] },
    'chiller-1': { x: ROW_X0 - 6.4, z: (rowZ(2) + rowZ(3)) / 2, size: [1.8, 1.9, 3.0] },
    'chiller-2': { x: ROW_X0 - 6.4, z: (rowZ(8) + rowZ(9)) / 2, size: [1.8, 1.9, 3.0] },
    'sw-spine-1': { x: ROW_X1 + 3.7, z: hotAisleZ(1), size: [0.6, 1.9, 0.9] },
    'sw-spine-2': { x: ROW_X1 + 3.7, z: hotAisleZ(3), size: [0.6, 1.9, 0.9] },
  };

  for (const id of site.partOrder) {
    const p = site.parts[id];
    const group = GROUP[p.type];
    if (fixed[id]) {
      const f = fixed[id];
      out[id] = { pos: [f.x, 0, f.z], size: f.size, group };
      continue;
    }
    const z = rowZ(p.row ?? 1);
    if (p.type === 'cdu') {
      // end-of-row cooling units, west of the row they start in
      const k = cdusPerRow[p.row!] ?? 0;
      cdusPerRow[p.row!] = k + 1;
      out[id] = { pos: [ROW_X0 - 0.85 - k * 0.72, 0, z], size: [0.6, 1.8, 0.95], group };
    } else if (p.type === 'pdu') {
      const side = id.endsWith('-a') ? 0 : 1;
      out[id] = { pos: [ROW_X1 + 0.71 + side * 0.5, 0, z], size: [0.42, 1.8, 0.85], group };
    } else if (p.type === 'leaf') {
      out[id] = { pos: [ROW_X1 + 1.85, 0, z], size: [0.55, 1.3, 0.85], group };
    }
  }
  return out;
}

// ---------- walls, the entrance and the tech's office ----------

/** Walls round the slab: a low solid base and glass above it, so nothing hides the racks. */
export const WALL = { t: 0.12, h: 2.4, base: 0.45, door: 1.0, doorH: 2.1 };

/**
 * The way in: a short hallway out of the east wall with a door at each end (a mantrap: one
 * opens only once the other is shut). It comes out in a long corridor that runs north-south past
 * the hall, on to the rest of the site (its ends fade away). The tech's office is off the
 * corridor, well south of the entrance, behind a door of its own.
 */
export const ENTRY = (() => {
  const t = WALL.t;
  const z = 0; // the entrance, between the two spines
  const len = 1.6; // the hallway between the two doors, inside
  const width = 1.4; // that hallway, inside
  const inner = HALL.x1 + t / 2; // the hall-side door, in the hall's east wall
  const hall0 = HALL.x1 + t; // the hallway's inside, west end
  const outer = hall0 + len + t / 2; // the corridor-side door, in the corridor's west wall
  const cx0 = hall0 + len + t; // the corridor, inside
  const corridor = { x0: cx0, x1: cx0 + 1.8, z0: HALL.z0 - 10, z1: HALL.z1 + 10 };
  /** How far each end of the corridor fades into the dark. */
  const fade = 9;
  const office = { x0: corridor.x1 + t, x1: corridor.x1 + t + 3.2, z0: 8, z1: 12 };
  const officeDoor = { x: corridor.x1 + t / 2, z: (office.z0 + office.z1) / 2 };
  return {
    z,
    len,
    width,
    /** x of the two interlocked doors: 0 = the hall side, 1 = the corridor side. */
    doors: [inner, outer] as const,
    hallway: { x0: hall0, x1: hall0 + len, z0: z - width / 2, z1: z + width / 2 },
    corridor,
    fade,
    office,
    officeDoor,
    /** Where the tech stands to wait for each door, and between them. */
    hallSide: { x: HALL.x1 - 0.7, z },
    middle: { x: hall0 + len / 2, z },
    officeSide: { x: corridor.x0 + 0.7, z },
    /** The desk against the office's east wall. */
    desk: { x: office.x1 - 0.4, z: officeDoor.z, size: [0.7, 0.75, 1.4] as Vec3 },
  };
})();
