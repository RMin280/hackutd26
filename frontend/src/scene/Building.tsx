// The building round the hall: walls, the entrance's two interlocked doors, and the tech's
// office. The walls are a low solid base with clear glass above, so every camera angle still
// sees the racks. Each door has a lamp over it on both faces: red while it is locked (the
// other door is not shut), azure while it is open, dim while it is shut and free. The door
// logic is airlock.ts; the tech drives it (rounds.ts), this only draws it.

import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { C } from '../theme';
import { ENTRY, HALL, WALL } from './layout';
import type { Airlock } from './airlock';
import type { Rect } from './nav';
import { box, merge, place } from './geo';

const noRaycast = () => null;
const LAMP_IDLE = new THREE.Color('#3a3a40');
const LAMP_OPEN = new THREE.Color(C.azure);
const LAMP_LOCKED = new THREE.Color(C.red);

/** Wall footprints, with gaps left where the doors are. */
export function wallRects(): Rect[] {
  const t = WALL.t;
  const { x0, x1, z0, z1 } = HALL;
  const hw = WALL.door / 2;
  const hall = ENTRY.hallway;
  const o = ENTRY.office;
  const z = ENTRY.z;
  return [
    // the hall
    { x0: x0 - t, x1: x1 + t, z0: z0 - t, z1: z0 },
    { x0: x0 - t, x1: x1 + t, z0: z1, z1: z1 + t },
    { x0: x0 - t, x1: x0, z0, z1 },
    { x0: x1, x1: x1 + t, z0, z1: z - hw },
    { x0: x1, x1: x1 + t, z0: z + hw, z1 },
    // the hallway between the doors
    { x0: hall.x0, x1: hall.x1, z0: hall.z0 - t, z1: hall.z0 },
    { x0: hall.x0, x1: hall.x1, z0: hall.z1, z1: hall.z1 + t },
    // the office
    { x0: o.x0 - t, x1: o.x0, z0: o.z0 - t, z1: z - hw },
    { x0: o.x0 - t, x1: o.x0, z0: z + hw, z1: o.z1 + t },
    { x0: o.x1, x1: o.x1 + t, z0: o.z0 - t, z1: o.z1 + t },
    { x0: o.x0, x1: o.x1, z0: o.z0 - t, z1: o.z0 },
    { x0: o.x0, x1: o.x1, z0: o.z1, z1: o.z1 + t },
  ];
}

const centre = (r: Rect, y: number): [number, number, number] => [(r.x0 + r.x1) / 2, y, (r.z0 + r.z1) / 2];

function buildWalls() {
  const rects = wallRects();
  const glassT = 0.02;
  const base = merge(rects.map((r) => place(box(r.x1 - r.x0, WALL.base, r.z1 - r.z0), centre(r, WALL.base / 2))));
  const rail = merge(rects.map((r) => place(box(r.x1 - r.x0, 0.05, r.z1 - r.z0), centre(r, WALL.h - 0.025))));
  const glass = merge(
    rects.map((r) => {
      const alongX = r.x1 - r.x0 > r.z1 - r.z0;
      const h = WALL.h - WALL.base - 0.05;
      return place(box(alongX ? r.x1 - r.x0 : glassT, h, alongX ? glassT : r.z1 - r.z0), centre(r, WALL.base + h / 2));
    }),
  );
  // a solid lintel and posts round each doorway
  const frames = merge(
    ENTRY.doors.flatMap((x) => [
      place(box(WALL.t + 0.02, WALL.h - WALL.doorH, WALL.door), [x, (WALL.h + WALL.doorH) / 2, ENTRY.z]),
      place(box(WALL.t + 0.04, WALL.doorH, 0.05), [x, WALL.doorH / 2, ENTRY.z - WALL.door / 2 - 0.025]),
      place(box(WALL.t + 0.04, WALL.doorH, 0.05), [x, WALL.doorH / 2, ENTRY.z + WALL.door / 2 + 0.025]),
    ]),
  );
  return { base, rail, glass, frames };
}

export function Building({ doors }: { doors: Airlock }) {
  const geo = useMemo(buildWalls, []);
  const mats = useMemo(
    () => ({
      base: new THREE.MeshStandardMaterial({ color: '#202024', roughness: 0.85, metalness: 0.1 }),
      rail: new THREE.MeshStandardMaterial({ color: '#3a3a40', roughness: 0.5, metalness: 0.5 }),
      glass: new THREE.MeshStandardMaterial({
        color: C.ice,
        transparent: true,
        opacity: 0.06,
        depthWrite: false,
        side: THREE.DoubleSide,
        roughness: 0.2,
      }),
      leaf: new THREE.MeshStandardMaterial({ color: '#4a4d55', roughness: 0.45, metalness: 0.55 }),
      lamps: [0, 1].map(() => new THREE.MeshBasicMaterial({ color: LAMP_IDLE.clone(), toneMapped: false })),
      floor: new THREE.MeshStandardMaterial({ color: '#1b1b1e', roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      desk: new THREE.MeshStandardMaterial({ color: '#2e2e33', roughness: 0.6, metalness: 0.2 }),
      screen: new THREE.MeshBasicMaterial({ color: '#173a5c', toneMapped: false }),
    }),
    [],
  );
  useEffect(
    () => () => {
      for (const g of Object.values(geo)) g.dispose();
      for (const m of Object.values(mats)) (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
    },
    [geo, mats],
  );

  const leaves = useMemo(() => [new THREE.Group(), new THREE.Group()], []);
  useFrame(() => {
    for (const d of [0, 1] as const) {
      const k = THREE.MathUtils.smoothstep(doors.open[d], 0, 1);
      leaves[d].position.z = ENTRY.z + k * (WALL.door - 0.04); // slides into the wall to the south
      mats.lamps[d].color.copy(doors.isLocked(d) ? LAMP_LOCKED : doors.open[d] > 0 ? LAMP_OPEN : LAMP_IDLE);
    }
  });

  const o = ENTRY.office;
  const h = ENTRY.hallway;
  const desk = ENTRY.desk;
  return (
    <group>
      <mesh geometry={geo.base} material={mats.base} raycast={noRaycast} />
      <mesh geometry={geo.rail} material={mats.rail} raycast={noRaycast} />
      <mesh geometry={geo.frames} material={mats.rail} raycast={noRaycast} />
      <mesh geometry={geo.glass} material={mats.glass} raycast={noRaycast} renderOrder={1} />

      {ENTRY.doors.map((x, d) => (
        <group key={d}>
          <primitive object={leaves[d]} position-x={x}>
            <mesh position={[0, WALL.doorH / 2, 0]} material={mats.leaf} raycast={noRaycast}>
              <boxGeometry args={[0.05, WALL.doorH - 0.02, WALL.door - 0.02]} />
            </mesh>
          </primitive>
          {[-1, 1].map((side) => (
            <mesh key={side} position={[x + side * (WALL.t / 2 + 0.02), WALL.doorH + 0.12, ENTRY.z]} material={mats.lamps[d]} raycast={noRaycast}>
              <boxGeometry args={[0.03, 0.06, 0.22]} />
            </mesh>
          ))}
        </group>
      ))}

      {/* the hallway's and the office's floors (the hall's slab fades out before them) */}
      <mesh rotation-x={-Math.PI / 2} position={[(h.x0 - WALL.t + h.x1 + WALL.t) / 2, 0.001, ENTRY.z]} material={mats.floor} raycast={noRaycast}>
        <planeGeometry args={[h.x1 - h.x0 + 2 * WALL.t, h.z1 - h.z0]} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[(o.x0 + o.x1) / 2, 0.001, (o.z0 + o.z1) / 2]} material={mats.floor} raycast={noRaycast}>
        <planeGeometry args={[o.x1 - o.x0, o.z1 - o.z0]} />
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
