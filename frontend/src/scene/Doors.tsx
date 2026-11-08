// Sliding doors on the ends of each hot-aisle containment. Two leaves per end, sliding apart
// along the rack ends (pocket-door style) when a member of the crew comes near, and closing
// again once they have passed. Frames and glass match the containment they sit in.

import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { C } from '../theme';
import { AISLE, PAIR_COUNT, RACK, ROW_X0, ROW_X1, hotAisleZ } from './layout';
import { walkers } from './walkers';
import { box, merge, place } from './geo';

const noRaycast = () => null;

const LEAF_W = AISLE.hot / 2 + 0.02; // the two leaves overlap a little when shut
const LEAF_H = RACK.h - 0.06;
const LEAF_T = 0.03;
const BAR = 0.04;
const SLIDE = LEAF_W - 0.06; // how far each leaf retracts
const OFF = 0.035; // the door plane sits just outside the rack ends
const TRIGGER = 1.9; // metres: a gull this close opens the door
const OPEN_RATE = 5.5;
const CLOSE_RATE = 2.2;

const ends = [ROW_X0 - OFF, ROW_X1 + OFF];
const tmp = new THREE.Object3D();

/** One leaf, centred on its own origin, standing in the YZ plane: a frame of four bars and a mid rail. */
function leafFrame() {
  return merge([
    place(box(LEAF_T, BAR, LEAF_W), [0, LEAF_H / 2 - BAR / 2, 0]),
    place(box(LEAF_T, BAR, LEAF_W), [0, -LEAF_H / 2 + BAR / 2, 0]),
    place(box(LEAF_T, LEAF_H, BAR), [0, 0, LEAF_W / 2 - BAR / 2]),
    place(box(LEAF_T, LEAF_H, BAR), [0, 0, -LEAF_W / 2 + BAR / 2]),
    place(box(LEAF_T, 0.03, LEAF_W), [0, -0.12, 0]),
  ]);
}

export interface Doors {
  group: THREE.Group;
  update: (dt: number) => void;
  dispose: () => void;
}

export function buildDoors(): Doors {
  const group = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: C.hotFrame, roughness: 0.5, metalness: 0.4 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: C.hotGlass,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    side: THREE.DoubleSide,
    roughness: 0.25,
  });
  const frameGeo = leafFrame();
  const glassGeo = new THREE.PlaneGeometry(LEAF_W - 2 * BAR, LEAF_H - 2 * BAR).rotateY(Math.PI / 2);

  const leaves = PAIR_COUNT * 2 * 2;
  const frames = new THREE.InstancedMesh(frameGeo, frameMat, leaves);
  frames.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const glass = new THREE.InstancedMesh(glassGeo, glassMat, leaves);
  glass.instanceMatrix = frames.instanceMatrix;
  glass.renderOrder = 1;

  // a track over each opening, reaching over the rack ends the leaves slide across
  const trackGeo = merge(
    Array.from({ length: PAIR_COUNT * 2 }, (_, d) =>
      place(box(0.05, 0.04, 2 * (LEAF_W + SLIDE) + 0.06), [ends[d % 2], RACK.h - 0.035, hotAisleZ(Math.floor(d / 2))]),
    ),
  );
  const tracks = new THREE.Mesh(trackGeo, frameMat);

  for (const m of [frames, glass, tracks]) {
    m.raycast = noRaycast;
    m.frustumCulled = false;
    group.add(m);
  }

  const open = new Float32Array(PAIR_COUNT * 2); // 0 shut .. 1 open, per door (pair p, end e) at p*2+e
  const layout = () => {
    for (let d = 0; d < open.length; d++) {
      const x = ends[d % 2];
      const z = hotAisleZ(Math.floor(d / 2));
      const slide = SLIDE * THREE.MathUtils.smoothstep(open[d], 0, 1);
      for (const l of [0, 1]) {
        const dir = l === 0 ? -1 : 1;
        tmp.position.set(x, LEAF_H / 2 + 0.03, z + dir * (LEAF_W / 2 - 0.01 + slide));
        tmp.updateMatrix();
        frames.setMatrixAt(d * 2 + l, tmp.matrix);
      }
    }
    frames.instanceMatrix.needsUpdate = true;
  };
  layout();

  const update = (dt: number) => {
    let changed = false;
    for (let d = 0; d < open.length; d++) {
      const x = ends[d % 2];
      const z = hotAisleZ(Math.floor(d / 2));
      let near = false;
      for (const w of walkers) {
        if (Math.hypot(w.x - x, w.z - z) < TRIGGER) {
          near = true;
          break;
        }
      }
      const target = near ? 1 : 0;
      if (open[d] === target) continue;
      const next = open[d] + (target - open[d]) * (1 - Math.exp(-dt * (near ? OPEN_RATE : CLOSE_RATE)));
      open[d] = Math.abs(target - next) < 0.004 ? target : next;
      changed = true;
    }
    if (changed) layout();
  };

  return {
    group,
    update,
    dispose: () => {
      for (const x of [frameMat, glassMat, frameGeo, glassGeo, trackGeo]) x.dispose();
    },
  };
}

export function HotAisleDoors() {
  const doors = useMemo(buildDoors, []);
  useEffect(() => () => doors.dispose(), [doors]);
  useFrame((_, dt) => doors.update(Math.min(dt, 0.05)));
  return <primitive object={doors.group} />;
}
