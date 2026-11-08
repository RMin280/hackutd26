// The building round the hall: walls, the entrance's two interlocked doors, the corridor they
// open onto (it runs on past the hall to the rest of the site, fading away at both ends), and
// the tech's office off that corridor, behind an ordinary door. The walls are a low solid base with clear glass above, so every camera angle still
// sees the racks. Each door has a lamp over it on both faces: red while it is locked (the
// other door is not shut), azure while it is open, dim while it is shut and free. The door
// logic is airlock.ts; the tech drives it (rounds.ts), this only draws it.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { C } from '../theme';
import { ENTRY, HALL, WALL } from './layout';
import type { Airlock } from './airlock';
import type { Rect } from './nav';
import { box, merge, place } from './geo';
import { walkerLists } from './walkers';

const noRaycast = () => null;
const LAMP_IDLE = new THREE.Color('#3a3a40');
const LAMP_OPEN = new THREE.Color(C.azure);
const LAMP_LOCKED = new THREE.Color(C.red);

/** A piece of wall: its footprint, and how far it has faded into the distance (1 = not at all). */
export interface WallPiece extends Rect {
  k: number;
}

/** 0 at the corridor's ends .. 1 once it is `fade` metres in. */
export function corridorFade(z: number): number {
  const c = ENTRY.corridor;
  return THREE.MathUtils.smoothstep(Math.min(z - c.z0, c.z1 - z), 0, ENTRY.fade);
}

/** Wall footprints, with gaps left where the doors are; the corridor's long walls come in short pieces that fade away. */
export function wallRects(): WallPiece[] {
  const t = WALL.t;
  const { x0, x1, z0, z1 } = HALL;
  const hw = WALL.door / 2;
  const hall = ENTRY.hallway;
  const c = ENTRY.corridor;
  const o = ENTRY.office;
  const d = ENTRY.officeDoor;
  const z = ENTRY.z;
  const solid = (r: Rect): WallPiece => ({ ...r, k: 1 });
  /** A wall along z from za to zb at x0..x1, in pieces short enough to fade. */
  const long = (wx0: number, wx1: number, za: number, zb: number): WallPiece[] => {
    const n = Math.max(1, Math.ceil((zb - za) / 0.6));
    return Array.from({ length: n }, (_, i) => {
      const a = za + ((zb - za) * i) / n;
      const b = za + ((zb - za) * (i + 1)) / n;
      return { x0: wx0, x1: wx1, z0: a, z1: b, k: corridorFade((a + b) / 2) };
    });
  };
  return [
    // the hall
    ...[
      { x0: x0 - t, x1: x1 + t, z0: z0 - t, z1: z0 },
      { x0: x0 - t, x1: x1 + t, z0: z1, z1: z1 + t },
      { x0: x0 - t, x1: x0, z0, z1 },
      { x0: x1, x1: x1 + t, z0, z1: z - hw },
      { x0: x1, x1: x1 + t, z0: z + hw, z1 },
      // the short hallway between the two interlocked doors
      { x0: hall.x0, x1: hall.x1, z0: hall.z0 - t, z1: hall.z0 },
      { x0: hall.x0, x1: hall.x1, z0: hall.z1, z1: hall.z1 + t },
      // the office, off the corridor's east side
      { x0: c.x1 + t, x1: o.x1 + t, z0: o.z0 - t, z1: o.z0 },
      { x0: c.x1 + t, x1: o.x1 + t, z0: o.z1, z1: o.z1 + t },
      { x0: o.x1, x1: o.x1 + t, z0: o.z0 - t, z1: o.z1 + t },
    ].map(solid),
    // the corridor, running on past the hall both ways
    ...long(c.x0 - t, c.x0, c.z0, z - hw),
    ...long(c.x0 - t, c.x0, z + hw, c.z1),
    ...long(c.x1, c.x1 + t, c.z0, d.z - hw),
    ...long(c.x1, c.x1 + t, d.z + hw, c.z1),
  ];
}

const centre = (r: Rect, y: number): [number, number, number] => [(r.x0 + r.x1) / 2, y, (r.z0 + r.z1) / 2];
/** Fade levels: each draws with its own materials (level LEVELS is solid). */
const LEVELS = 8;
const levelOf = (k: number) => Math.round(k * LEVELS);

/** Every doorway with a frame: the two interlocked doors and the office door, all in walls that run along z. */
const DOORWAYS = [
  { x: ENTRY.doors[0], z: ENTRY.z },
  { x: ENTRY.doors[1], z: ENTRY.z },
  { x: ENTRY.officeDoor.x, z: ENTRY.officeDoor.z },
];

function buildWalls() {
  const pieces = wallRects();
  const glassT = 0.02;
  const levels = Array.from({ length: LEVELS + 1 }, (_, lv) => {
    const mine = pieces.filter((p) => levelOf(p.k) === lv);
    if (!mine.length || lv === 0) return null;
    const h = WALL.h - WALL.base - 0.05;
    return {
      k: lv / LEVELS,
      base: merge(mine.map((r) => place(box(r.x1 - r.x0, WALL.base, r.z1 - r.z0), centre(r, WALL.base / 2)))),
      rail: merge(mine.map((r) => place(box(r.x1 - r.x0, 0.05, r.z1 - r.z0), centre(r, WALL.h - 0.025)))),
      glass: merge(
        mine.map((r) => {
          const alongX = r.x1 - r.x0 > r.z1 - r.z0;
          return place(box(alongX ? r.x1 - r.x0 : glassT, h, alongX ? glassT : r.z1 - r.z0), centre(r, WALL.base + h / 2));
        }),
      ),
    };
  }).filter((l): l is NonNullable<typeof l> => l !== null);
  // a solid lintel and posts round each doorway
  const frames = merge(
    DOORWAYS.flatMap(({ x, z }) => [
      place(box(WALL.t + 0.02, WALL.h - WALL.doorH, WALL.door), [x, (WALL.h + WALL.doorH) / 2, z]),
      place(box(WALL.t + 0.04, WALL.doorH, 0.05), [x, WALL.doorH / 2, z - WALL.door / 2 - 0.025]),
      place(box(WALL.t + 0.04, WALL.doorH, 0.05), [x, WALL.doorH / 2, z + WALL.door / 2 + 0.025]),
    ]),
  );
  // light bars across the corridor every few metres, fading with it
  const c = ENTRY.corridor;
  const bars: { z: number; k: number }[] = [];
  for (let z = c.z0 + 1.5; z < c.z1; z += 3) bars.push({ z, k: corridorFade(z) });
  const barLevels = Array.from({ length: LEVELS }, (_, i) => i + 1)
    .map((lv) => {
      const mine = bars.filter((b) => levelOf(b.k) === lv);
      if (!mine.length) return null;
      return { k: lv / LEVELS, geo: merge(mine.map((b) => place(box(c.x1 - c.x0, 0.03, 0.16), [(c.x0 + c.x1) / 2, WALL.h + 0.02, b.z]))) };
    })
    .filter((l): l is NonNullable<typeof l> => l !== null);
  return { levels, frames, barLevels };
}

/** Alpha along the corridor: opaque in the middle, dark at both ends. */
function corridorAlpha(): THREE.CanvasTexture {
  const n = 256;
  const cv = document.createElement('canvas');
  cv.width = 1;
  cv.height = n;
  const g = cv.getContext('2d')!;
  const c = ENTRY.corridor;
  for (let j = 0; j < n; j++) {
    const v = Math.round(corridorFade(c.z0 + ((j + 0.5) / n) * (c.z1 - c.z0)) * 255);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(0, j, 1, 1);
  }
  return new THREE.CanvasTexture(cv);
}

const OFFICE_DOOR_NEAR = 1.4; // metres: a gull this close opens the office door

export function Building({ doors }: { doors: Airlock }) {
  const geo = useMemo(buildWalls, []);
  const alpha = useMemo(corridorAlpha, []);
  const mats = useMemo(() => {
    const glass = (k: number) =>
      new THREE.MeshStandardMaterial({ color: C.ice, transparent: true, opacity: 0.06 * k, depthWrite: false, side: THREE.DoubleSide, roughness: 0.2 });
    const faded = (color: string, k: number, rough: number, metal: number) =>
      new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, transparent: k < 1, opacity: k, depthWrite: k >= 1 });
    return {
      levels: geo.levels.map((l) => ({ base: faded('#202024', l.k, 0.85, 0.1), rail: faded('#3a3a40', l.k, 0.5, 0.5), glass: glass(l.k) })),
      bars: geo.barLevels.map((l) => new THREE.MeshBasicMaterial({ color: '#c9d3e6', transparent: true, opacity: 0.55 * l.k, toneMapped: false, depthWrite: false })),
      frame: new THREE.MeshStandardMaterial({ color: '#3a3a40', roughness: 0.5, metalness: 0.5 }),
      leaf: new THREE.MeshStandardMaterial({ color: '#4a4d55', roughness: 0.45, metalness: 0.55 }),
      lamps: [0, 1].map(() => new THREE.MeshBasicMaterial({ color: LAMP_IDLE.clone(), toneMapped: false })),
      floor: new THREE.MeshStandardMaterial({ color: '#1b1b1e', roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      corridor: new THREE.MeshStandardMaterial({ color: '#1b1b1e', roughness: 0.95, alphaMap: alpha, transparent: true, depthWrite: false }),
      guide: new THREE.MeshBasicMaterial({ color: '#34343a', alphaMap: alpha, transparent: true, depthWrite: false }),
      desk: new THREE.MeshStandardMaterial({ color: '#2e2e33', roughness: 0.6, metalness: 0.2 }),
      screen: new THREE.MeshBasicMaterial({ color: '#173a5c', toneMapped: false }),
    };
  }, [geo, alpha]);
  useEffect(
    () => () => {
      for (const l of geo.levels) for (const g of [l.base, l.rail, l.glass]) g.dispose();
      for (const l of geo.barLevels) l.geo.dispose();
      geo.frames.dispose();
      alpha.dispose();
      for (const l of mats.levels) for (const m of Object.values(l)) m.dispose();
      for (const m of [...mats.bars, ...mats.lamps, mats.frame, mats.leaf, mats.floor, mats.corridor, mats.guide, mats.desk, mats.screen]) m.dispose();
    },
    [geo, mats, alpha],
  );

  // the two interlocked leaves, then the office door's
  const leaves = useMemo(() => [new THREE.Group(), new THREE.Group(), new THREE.Group()], []);
  const officeOpen = useRef(0);
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    for (const d of [0, 1] as const) {
      const k = THREE.MathUtils.smoothstep(doors.open[d], 0, 1);
      leaves[d].position.z = ENTRY.z + k * (WALL.door - 0.04); // slides into the wall to the south
      mats.lamps[d].color.copy(doors.isLocked(d) ? LAMP_LOCKED : doors.open[d] > 0 ? LAMP_OPEN : LAMP_IDLE);
    }
    // the office door is an ordinary one: it opens for whoever walks up to it
    const { x, z } = ENTRY.officeDoor;
    let near = false;
    for (const list of walkerLists) for (const w of list) if (Math.hypot(w.x - x, w.z - z) < OFFICE_DOOR_NEAR) near = true;
    const target = near ? 1 : 0;
    officeOpen.current += (target - officeOpen.current) * (1 - Math.exp(-dt * (near ? 5.5 : 2.2)));
    leaves[2].position.z = z + THREE.MathUtils.smoothstep(officeOpen.current, 0, 1) * (WALL.door - 0.04);
  });

  const o = ENTRY.office;
  const h = ENTRY.hallway;
  const c = ENTRY.corridor;
  const desk = ENTRY.desk;
  return (
    <group>
      {geo.levels.map((l, i) => (
        <group key={l.k}>
          <mesh geometry={l.base} material={mats.levels[i].base} raycast={noRaycast} />
          <mesh geometry={l.rail} material={mats.levels[i].rail} raycast={noRaycast} />
          <mesh geometry={l.glass} material={mats.levels[i].glass} raycast={noRaycast} renderOrder={1} />
        </group>
      ))}
      {geo.barLevels.map((l, i) => (
        <mesh key={l.k} geometry={l.geo} material={mats.bars[i]} raycast={noRaycast} renderOrder={1} />
      ))}
      <mesh geometry={geo.frames} material={mats.frame} raycast={noRaycast} />

      {DOORWAYS.map(({ x }, d) => (
        <primitive key={d} object={leaves[d]} position-x={x}>
          <mesh position={[0, WALL.doorH / 2, 0]} material={mats.leaf} raycast={noRaycast}>
            <boxGeometry args={[0.05, WALL.doorH - 0.02, WALL.door - 0.02]} />
          </mesh>
        </primitive>
      ))}
      {ENTRY.doors.map((x, d) =>
        [-1, 1].map((side) => (
          <mesh key={`${d}${side}`} position={[x + side * (WALL.t / 2 + 0.02), WALL.doorH + 0.12, ENTRY.z]} material={mats.lamps[d]} raycast={noRaycast}>
            <boxGeometry args={[0.03, 0.06, 0.22]} />
          </mesh>
        )),
      )}

      {/* floors: the hall's slab fades out before these */}
      <mesh rotation-x={-Math.PI / 2} position={[(h.x0 + h.x1) / 2, 0.001, ENTRY.z]} material={mats.floor} raycast={noRaycast}>
        <planeGeometry args={[h.x1 - h.x0 + 2 * WALL.t, h.z1 - h.z0]} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[(c.x0 + c.x1) / 2, 0.0012, (c.z0 + c.z1) / 2]} material={mats.corridor} raycast={noRaycast}>
        <planeGeometry args={[c.x1 - c.x0, c.z1 - c.z0]} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[(c.x0 + c.x1) / 2, 0.0016, (c.z0 + c.z1) / 2]} material={mats.guide} raycast={noRaycast}>
        <planeGeometry args={[0.05, c.z1 - c.z0]} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[(c.x1 + o.x1) / 2, 0.001, (o.z0 + o.z1) / 2]} material={mats.floor} raycast={noRaycast}>
        <planeGeometry args={[o.x1 - c.x1, o.z1 - o.z0]} />
      </mesh>

      {/* the tech's desk, with a monitor */}
      <mesh position={[desk.x, desk.size[1] / 2, desk.z]} material={mats.desk} raycast={noRaycast}>
        <boxGeometry args={desk.size} />
      </mesh>
      <mesh position={[desk.x + 0.12, desk.size[1] + 0.22, desk.z]} material={mats.desk} raycast={noRaycast}>
        <boxGeometry args={[0.04, 0.34, 0.56]} />
      </mesh>
      <mesh position={[desk.x + 0.095, desk.size[1] + 0.22, desk.z]} rotation-y={-Math.PI / 2} material={mats.screen} raycast={noRaycast}>
        <planeGeometry args={[0.5, 0.29]} />
      </mesh>
    </group>
  );
}
