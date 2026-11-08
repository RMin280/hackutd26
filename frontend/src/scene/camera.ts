// Camera shots: where to look for each focus target, and how far back to stand
// so the subject lands inside the free part of the screen (between the panels).

import * as THREE from 'three';
import type { FocusTarget, Site } from '../model/types';
import { ENTRY, HALL, RACK, WALL, rackBase, rowFacing, type PartBox } from './layout';

export type Shot =
  | { kind: 'look'; target: THREE.Vector3; dir: THREE.Vector3; distance: number }
  | { kind: 'fit'; points: THREE.Vector3[]; dir: THREE.Vector3 };

/** Screen rectangle (canvas pixels) that is not covered by the HUD panels. */
export interface Frame {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number; // whole canvas
  height: number;
}

/** Unit vector from the target towards the camera. Azimuth 0 = from the south (+z), polar 0 = straight down. */
export function dirFrom(azimuth: number, polar: number): THREE.Vector3 {
  return new THREE.Vector3(Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), Math.sin(polar) * Math.cos(azimuth));
}

// Overview from the south-east, turned so the hall's long axis runs across the wide screen.
export const OVERVIEW_AZIMUTH = 0.95;
export const OVERVIEW_POLAR = 0.88;

// Close-ups look down at ~48°: steep enough to see a whole rack front over the
// 2 m racks on the other side of the 1.8 m cold aisle.
const CLOSE_POLAR = 0.72;
// Runs of racks are framed from higher up, so the row in front (or the power room in
// front of Row 1) stays out of the bottom of the frame.
const RACKS_POLAR = 0.62;
// How much of the row to keep around a single rack or node, in metres either side:
// enough neighbours to see where it sits, not so many that a node shrinks to a dot.
const RACK_CONTEXT = 1.6;
const NODE_CONTEXT = 2.1;

// ---------- foreground test for close shots ----------

/** Camera-to-target distance below which a shot counts as close. */
export const CLOSE_SHOT = 24;
const fgTarget = new THREE.Vector3();

/**
 * True when something at `center` (footprint radius `radius`) stands between the camera and
 * what it is looking at, in a close shot: the power room in front of Row 1, a gull walking past
 * the lens. Overview and wide shots never count.
 */
export function inForeground(
  camera: THREE.Camera,
  controls: { getTarget?: (out: THREE.Vector3) => THREE.Vector3; distance?: number } | null | undefined,
  center: THREE.Vector3,
  radius: number,
): boolean {
  if (!controls?.getTarget || (controls.distance ?? Infinity) > CLOSE_SHOT) return false;
  controls.getTarget(fgTarget);
  const dx = fgTarget.x - camera.position.x;
  const dz = fgTarget.z - camera.position.z;
  const dT = Math.hypot(dx, dz);
  if (dT < 0.5) return false;
  // how far along the (horizontal) view the thing's far edge reaches, compared with the subject
  const along = ((center.x - camera.position.x) * dx + (center.z - camera.position.z) * dz) / dT + radius;
  return along > 0 && along < dT - 2.5;
}

/** The part of the canvas not covered by HUD panels (the `.scene-frame` grid cell). */
export function readFrame(canvas: HTMLCanvasElement): Frame {
  const c = canvas.getBoundingClientRect();
  const r = document.querySelector('.scene-frame')?.getBoundingClientRect();
  if (!r || r.width < 200 || r.height < 140) {
    return { left: 0, top: 0, right: c.width, bottom: c.height, width: c.width, height: c.height };
  }
  return {
    left: r.left - c.left,
    top: r.top - c.top,
    right: r.right - c.left,
    bottom: r.bottom - c.top,
    width: c.width,
    height: c.height,
  };
}

// Look at a row's front: from the south for south-facing rows, from the north otherwise (slightly from the east).
const azimuthForFacing = (facing: number) => (facing > 0 ? 0.35 : Math.PI - 0.35);

function boxCorners(min: THREE.Vector3, max: THREE.Vector3): THREE.Vector3[] {
  return [0, 1, 2, 3, 4, 5, 6, 7].map(
    (i) => new THREE.Vector3(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z),
  );
}

/** The hall's real footprint: the floor slab plus anything standing outside it (chillers, the tech's office). */
function hallPoints(parts: Record<string, PartBox>): THREE.Vector3[] {
  const pts = boxCorners(new THREE.Vector3(HALL.x0, 0, HALL.z0), new THREE.Vector3(HALL.x1, RACK.h, HALL.z1));
  const o = ENTRY.office;
  pts.push(...boxCorners(new THREE.Vector3(o.x0, 0, o.z0), new THREE.Vector3(o.x1 + WALL.t, WALL.base, o.z1)));
  for (const b of Object.values(parts)) {
    const outside = b.pos[0] - b.size[0] / 2 < HALL.x0 || b.pos[0] + b.size[0] / 2 > HALL.x1;
    if (!outside) continue;
    pts.push(
      ...boxCorners(
        new THREE.Vector3(b.pos[0] - b.size[0] / 2, 0, b.pos[2] - b.size[2] / 2),
        new THREE.Vector3(b.pos[0] + b.size[0] / 2, b.size[1], b.pos[2] + b.size[2] / 2),
      ),
    );
  }
  return pts;
}

export function shotFor(site: Site, parts: Record<string, PartBox>, t: FocusTarget): Shot {
  switch (t.kind) {
    case 'overview':
      return { kind: 'fit', points: hallPoints(parts), dir: dirFrom(OVERVIEW_AZIMUTH, OVERVIEW_POLAR) };
    case 'rack': {
      // the rack with a couple of neighbours each side, seen from its front
      const [x, , z] = rackBase(site, t.id);
      const facing = rowFacing(site.racks[t.id].row);
      return {
        kind: 'fit',
        points: boxCorners(
          new THREE.Vector3(x - RACK_CONTEXT, 0, z - 0.7),
          new THREE.Vector3(x + RACK_CONTEXT, RACK.h + 0.25, z + 0.7),
        ),
        dir: dirFrom(azimuthForFacing(facing), CLOSE_POLAR),
      };
    }
    case 'node': {
      // the node's rack in its stretch of row, so you can see where it sits; the node itself pulses
      const n = site.nodes[t.id];
      const [x, , z] = rackBase(site, n.rack);
      const facing = rowFacing(n.row);
      return {
        kind: 'fit',
        points: boxCorners(
          new THREE.Vector3(x - NODE_CONTEXT, 0, z - 0.75),
          new THREE.Vector3(x + NODE_CONTEXT, RACK.h + 0.2, z + 0.75),
        ),
        dir: dirFrom(azimuthForFacing(facing), CLOSE_POLAR),
      };
    }
    case 'part': {
      const b = parts[t.id];
      const az = b.pos[2] < HALL.z0 + 4 ? 0.2 : 0.55;
      return {
        kind: 'fit',
        points: boxCorners(
          new THREE.Vector3(b.pos[0] - b.size[0] / 2 - 0.9, 0, b.pos[2] - b.size[2] / 2 - 0.9),
          new THREE.Vector3(b.pos[0] + b.size[0] / 2 + 0.9, b.size[1] + 0.6, b.pos[2] + b.size[2] / 2 + 0.9),
        ),
        dir: dirFrom(az, 0.95),
      };
    }
    case 'racks': {
      const box = new THREE.Box3();
      let facing = 0;
      for (const id of t.ids) {
        const [x, , z] = rackBase(site, id);
        box.expandByPoint(new THREE.Vector3(x - RACK.w / 2, 0, z - RACK.d / 2));
        box.expandByPoint(new THREE.Vector3(x + RACK.w / 2, RACK.h, z + RACK.d / 2));
        facing += rowFacing(site.racks[id].row);
      }
      for (const id of t.parts ?? []) {
        const b = parts[id];
        box.expandByPoint(new THREE.Vector3(b.pos[0] - b.size[0] / 2, 0, b.pos[2] - b.size[2] / 2));
        box.expandByPoint(new THREE.Vector3(b.pos[0] + b.size[0] / 2, b.size[1], b.pos[2] + b.size[2] / 2));
      }
      box.expandByVector(new THREE.Vector3(0.8, 0, 0.8));
      return { kind: 'fit', points: boxCorners(box.min, box.max), dir: dirFrom(azimuthForFacing(facing >= 0 ? 1 : -1), RACKS_POLAR) };
    }
  }
}

const scratch = new THREE.PerspectiveCamera();
const v = new THREE.Vector3();
const right = new THREE.Vector3();
const up = new THREE.Vector3();

/** Places the scratch camera and returns the sideways shift that centres the target in the frame. */
function place(target: THREE.Vector3, dir: THREE.Vector3, distance: number, frame: Frame): THREE.Vector3 {
  scratch.position.copy(target).addScaledVector(dir, distance);
  scratch.up.set(0, 1, 0);
  scratch.lookAt(target);
  scratch.updateMatrixWorld(true);
  const worldPerPx = (2 * distance * Math.tan(THREE.MathUtils.degToRad(scratch.fov) / 2)) / frame.height;
  const dx = (frame.left + frame.right) / 2 - frame.width / 2;
  const dy = (frame.top + frame.bottom) / 2 - frame.height / 2;
  right.setFromMatrixColumn(scratch.matrixWorld, 0);
  up.setFromMatrixColumn(scratch.matrixWorld, 1);
  const shift = new THREE.Vector3().addScaledVector(right, -dx * worldPerPx).addScaledVector(up, dy * worldPerPx);
  scratch.position.add(shift);
  scratch.updateMatrixWorld(true);
  return shift;
}

function fits(points: THREE.Vector3[], frame: Frame, pad: number): boolean {
  for (const p of points) {
    v.copy(p).project(scratch);
    if (v.z < -1 || v.z > 1) return false;
    const sx = ((v.x + 1) / 2) * frame.width;
    const sy = ((1 - v.y) / 2) * frame.height;
    if (sx < frame.left + pad || sx > frame.right - pad || sy < frame.top + pad || sy > frame.bottom - pad) return false;
  }
  return true;
}

export function resolveShot(shot: Shot, camera: THREE.PerspectiveCamera, frame: Frame): { pos: THREE.Vector3; target: THREE.Vector3 } {
  scratch.fov = camera.fov;
  scratch.aspect = frame.width / frame.height;
  scratch.near = camera.near;
  scratch.far = camera.far;
  scratch.updateProjectionMatrix();

  if (shot.kind === 'look') {
    const shift = place(shot.target, shot.dir, shot.distance, frame);
    return { pos: scratch.position.clone(), target: shot.target.clone().add(shift) };
  }

  // Fit the distance, then nudge the target so the projected content is centred in the
  // frame, and fit again; a couple of rounds gets a tight, centred framing.
  const target = new THREE.Box3().setFromPoints(shot.points).getCenter(new THREE.Vector3());
  const frameCx = (frame.left + frame.right) / 2;
  const frameCy = (frame.top + frame.bottom) / 2;
  let distance = 50;
  for (let round = 0; round < 3; round++) {
    let lo = 1.2;
    let hi = 200;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      place(target, shot.dir, mid, frame);
      if (fits(shot.points, frame, 28)) hi = mid;
      else lo = mid;
    }
    distance = hi;
    place(target, shot.dir, distance, frame);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of shot.points) {
      v.copy(p).project(scratch);
      const sx = ((v.x + 1) / 2) * frame.width;
      const sy = ((1 - v.y) / 2) * frame.height;
      minX = Math.min(minX, sx);
      maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy);
      maxY = Math.max(maxY, sy);
    }
    const worldPerPx = (2 * distance * Math.tan(THREE.MathUtils.degToRad(scratch.fov) / 2)) / frame.height;
    right.setFromMatrixColumn(scratch.matrixWorld, 0);
    up.setFromMatrixColumn(scratch.matrixWorld, 1);
    const ox = frameCx - (minX + maxX) / 2;
    const oy = frameCy - (minY + maxY) / 2;
    target.addScaledVector(right, -ox * worldPerPx).addScaledVector(up, oy * worldPerPx);
  }
  const shift = place(target, shot.dir, distance, frame);
  return { pos: scratch.position.clone(), target: target.clone().add(shift) };
}
