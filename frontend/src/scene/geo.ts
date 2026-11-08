// Small helpers for building props from primitives in code: place a primitive, paint it one
// flat colour, and merge many into a single geometry (one draw call, many colours).

import * as THREE from 'three';

export type V3 = [number, number, number];

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const P = new THREE.Vector3();
const SC = new THREE.Vector3();

/** A primitive, made non-indexed and placed: scale, then Euler YZX rotation (pitch innermost), then position. */
export function place(src: THREE.BufferGeometry, pos: V3 = [0, 0, 0], rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src;
  if (g !== src) src.dispose();
  g.applyMatrix4(M.compose(P.set(...pos), Q.setFromEuler(E.set(rot[0], rot[1], rot[2], 'YZX')), SC.set(...scale)));
  return g;
}

/** Paints a geometry one flat colour as vertex colours, so pieces of many colours share one material. */
export function paint(g: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export const piece = (src: THREE.BufferGeometry, color: string, pos?: V3, rot?: V3, scale?: V3) => paint(place(src, pos, rot, scale), color);

/** Concatenates geometries into one (the attributes they all share) and disposes the inputs. */
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const names = Object.keys(parts[0].attributes).filter((n) => parts.every((p) => p.getAttribute(n)));
  for (const name of names) {
    const itemSize = parts[0].getAttribute(name).itemSize;
    const total = parts.reduce((a, p) => a + p.getAttribute(name).count, 0);
    const arr = new Float32Array(total * itemSize);
    let o = 0;
    for (const p of parts) {
      const src = p.getAttribute(name).array as ArrayLike<number>;
      arr.set(src, o);
      o += src.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
  }
  for (const p of parts) p.dispose();
  out.computeBoundingSphere();
  return out;
}

export const sphere = (w = 18, h = 12) => new THREE.SphereGeometry(1, w, h);
export const cyl = (rt: number, rb: number, h: number, seg = 14, open = false, t0 = 0, tl = Math.PI * 2) =>
  new THREE.CylinderGeometry(rt, rb, h, seg, 1, open, t0, tl);
export const cone = (r: number, h: number, seg = 14) => new THREE.ConeGeometry(r, h, seg);
export const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
