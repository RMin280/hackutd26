// The gull model for Squawk's floor tech (Tech.tsx): a chunky toy seagull, in the spirit of the
// articulated pocket-pet prints. Only the tech is on the floor: every gull on screen is doing a
// repair. In a hot aisle it sweats and flaps.
//
// Built from primitives in code. Each body segment is one merged geometry with vertex colours,
// drawn instanced (a dozen draw calls). The waddle is procedural: short quick steps, the body
// rocking over the planted foot, a head bob and a tail wag.

import * as THREE from 'three';
import { C } from '../theme';
import { AISLE, PAIR_COUNT, ROW_X0, ROW_X1, hotAisleZ } from './layout';
import { walkerLists, type Walker } from './walkers';
import { cone, cyl, merge, piece, sphere, type V3 } from './geo';
import { standFacing, stepToward, type GullState } from './gait';

export type { GullState } from './gait';

const noRaycast = () => null;
/** Staff live on their own layer: the main camera sees it, the baked contact shadows and picking don't. */
export const STAFF_LAYER = 1;

// Print-filament colours from the reference toy: warm white, mid grey, black tips, orange bill and feet.
// The tech's hard hat is Squawk azure: the product acting.
const COL = {
  white: '#f6f5f1',
  grey: '#a2a7af',
  black: '#1c1d21',
  orange: '#f28c28',
  eye: '#111114',
  hat: C.azure,
};
const SWEAT = '#9fe3ff';

// ---------- the model (toy proportions; the root scale makes a gull about 1.25 m tall) ----------

const S = 1.2;
const LEG = 0.16; // hip to ankle
const ANKLE = 0.035; // foot thickness under the ankle
const HIP_X = 0.11;
const STEP = 0.55; // leg swing, radians, each way
const SWEAT_POOL = 96;

// Body segment: origin at the hips; an egg lying slightly long front to back.
const bodySeg = () => merge([piece(sphere(28, 20), COL.white, [0, 0.22, 0], [0, 0, 0], [0.3, 0.28, 0.37])]);

// Head segment: origin at the neck base, inside the body. A big ball with a short flat bill,
// two bead eyes and the little nub on top the print has.
function headSeg() {
  const eye = (s: 1 | -1) => piece(sphere(12, 10), COL.eye, [s * 0.113, 0.219, 0.268], [0, 0, 0], [0.03, 0.032, 0.03]);
  return merge([
    piece(sphere(28, 20), COL.white, [0, 0.16, 0.03], [0, 0, 0], [0.28, 0.28, 0.28]),
    piece(cone(0.105, 0.2, 16), COL.orange, [0, 0.12, 0.31], [Math.PI / 2 + 0.1, 0, 0], [1, 1, 0.48]),
    piece(sphere(14, 10), COL.orange, [0, 0.12, 0.3], [0, 0, 0], [0.1, 0.05, 0.07]),
    piece(cone(0.028, 0.05, 10), COL.white, [0, 0.455, 0.01]),
    eye(1),
    eye(-1),
  ]);
}

// Wing segment: origin at the shoulder; a grey teardrop lying along the flank, black at the tip,
// lifted a little at the back. Symmetric about its own x, so one geometry serves both sides.
function wingSeg() {
  const rot: V3 = [0.35, 0, 0];
  return merge([
    piece(sphere(20, 14), COL.grey, [0, -0.14, -0.16], rot, [0.065, 0.19, 0.34]),
    piece(sphere(14, 10), COL.black, [0, -0.037, -0.442], rot, [0.055, 0.1, 0.12]),
  ]);
}

// Tail segment: origin where it meets the body; a short stub, black at the end.
function tailSeg() {
  const rot: V3 = [0.35, 0, 0];
  return merge([
    piece(sphere(16, 12), COL.white, [0, 0.02, -0.08], rot, [0.11, 0.05, 0.12]),
    piece(sphere(12, 10), COL.black, [0, 0.054, -0.174], rot, [0.085, 0.035, 0.07]),
  ]);
}

// Leg: origin at the hip; a stubby orange post (it runs a little way up into the body).
const legSeg = () => merge([piece(cyl(0.045, 0.05, LEG + 0.04, 12), COL.orange, [0, -LEG / 2 + 0.02, 0])]);

// Hard hat (the tech): head space, like the head segment. A shell over the crown (the nub hides
// inside it), a ridge along the top, and a brim that dips a little at the front.
function hatSeg() {
  return merge([
    piece(sphere(24, 14), COL.hat, [0, 0.37, 0.02], [0, 0, 0], [0.235, 0.19, 0.255]),
    piece(sphere(16, 10), COL.hat, [0, 0.37, 0.02], [0, 0, 0], [0.055, 0.205, 0.262]),
    piece(cyl(0.285, 0.285, 0.024, 28), COL.hat, [0, 0.362, 0.05], [0.06, 0, 0], [1, 1, 1.12]),
  ]);
}

// Foot: origin at the ankle; a flat webbed paddle pointing forward, three toe bumps on the rim.
function footSeg() {
  const toes = [-0.45, 0, 0.45].map((a) =>
    piece(sphere(10, 8), COL.orange, [Math.sin(a) * 0.165, -0.015, 0.02 + Math.cos(a) * 0.165], [0, a, 0], [0.045, 0.02, 0.05]),
  );
  return merge([
    piece(cyl(0.17, 0.17, 0.04, 16, false, -0.62, 1.24), COL.orange, [0, -0.015, 0.02]),
    piece(sphere(12, 10), COL.orange, [0, -0.005, 0], [0, 0, 0], [0.055, 0.045, 0.06]),
    ...toes,
  ]);
}

function blobTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.75)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ---------- routes ----------

interface Waypoint {
  x: number;
  z: number;
  pause?: number; // seconds spent here
  face?: number; // yaw to turn to while paused (0 = facing south, PI = north)
}

export interface GullDef {
  route: Waypoint[];
  speed: number; // m/s
  start: number; // 0..1 along the route
}

const HOT_Z = Array.from({ length: PAIR_COUNT }, (_, p) => hotAisleZ(p));

// ---------- the crew ----------

const approach = (v: number, to: number, step: number) => (Math.abs(to - v) <= step ? to : v + Math.sign(to - v) * step);
const lerp = THREE.MathUtils.lerp;

function startState(def: GullDef, i: number): GullState {
  const r = def.route;
  const lens = r.map((w, k) => Math.hypot(r[(k + 1) % r.length].x - w.x, r[(k + 1) % r.length].z - w.z));
  let d = def.start * lens.reduce((a, b) => a + b, 0);
  let k = 0;
  while (d > lens[k] && k < r.length - 1) d -= lens[k++];
  const a = r[k];
  const b = r[(k + 1) % r.length];
  const t = lens[k] > 0 ? d / lens[k] : 0;
  return {
    seg: (k + 1) % r.length,
    x: lerp(a.x, b.x, t),
    z: lerp(a.z, b.z, t),
    yaw: Math.atan2(b.x - a.x, b.z - a.z),
    phase: i * 1.7,
    walk: 1,
    pause: 0,
    hot: 0,
    work: 0,
    spawn: 0,
    seed: i * 2.39 + 0.5,
  };
}

const inHotAisle = (x: number, z: number) => x > ROW_X0 + 0.1 && x < ROW_X1 - 0.1 && HOT_Z.some((hz) => Math.abs(z - hz) < AISLE.hot / 2);

type SegName = 'body' | 'head' | 'tail' | 'wing' | 'leg' | 'foot';

export interface CrewOptions {
  /** Azure hard hats: the tech. */
  hat?: boolean;
}

export interface Crew {
  group: THREE.Group;
  gulls: GullState[];
  /** Where this crew is on the floor, for the hot-aisle doors (empty while hidden). */
  walkers: Walker[];
  /** Walks the defs' routes. The tech walks its own (rounds.ts) and skips this. */
  advance: (dt: number) => void;
  /** `hide(x, z)` drops a gull from this frame, e.g. one waddling right past the lens. */
  pose: (t: number, dt: number, hide?: (x: number, z: number) => boolean) => void;
  dispose: () => void;
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpM = new THREE.Matrix4();
const tmpM2 = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);

export function buildCrew(defs: GullDef[], opts: CrewOptions = {}): Crew {
  const count = defs.length;
  const group = new THREE.Group();
  const disposables: { dispose: () => void }[] = [];
  const own = <T extends { dispose: () => void }>(x: T) => (disposables.push(x), x);
  const walkers: Walker[] = [];

  // Matte like printed filament: soft shading, no outlines.
  const skin = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0 }));
  const sweatMat = own(new THREE.MeshBasicMaterial({ color: SWEAT, toneMapped: false, transparent: true, opacity: 0.92 }));

  const addMesh = <T extends THREE.Mesh>(m: T) => {
    m.frustumCulled = false;
    m.raycast = noRaycast;
    m.layers.set(STAFF_LAYER);
    group.add(m);
    return m;
  };

  const parts: Record<SegName, THREE.BufferGeometry> = {
    body: bodySeg(),
    head: headSeg(),
    tail: tailSeg(),
    wing: wingSeg(),
    leg: legSeg(),
    foot: footSeg(),
  };
  const paired: Record<SegName, boolean> = { body: false, head: false, tail: false, wing: true, leg: true, foot: true };
  const seg = {} as Record<SegName, THREE.InstancedMesh>;
  for (const name of Object.keys(parts) as SegName[]) {
    own(parts[name]);
    const m = new THREE.InstancedMesh(parts[name], skin, paired[name] ? count * 2 : count);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    seg[name] = addMesh(m);
  }
  const hat = opts.hat ? addMesh(new THREE.InstancedMesh(own(hatSeg()), skin, count)) : null;
  hat?.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  // Sweat: a comic drop on the temple while hot, and droplets flicked off the head.
  const dropGeo = own(
    merge([
      piece(sphere(12, 10), SWEAT, [0, 0, 0], [0, 0, 0], [0.045, 0.045, 0.045]),
      piece(cone(0.04, 0.08, 12), SWEAT, [0, 0.056, 0]),
    ]),
  );
  const drops = addMesh(new THREE.InstancedMesh(dropGeo, sweatMat, count));
  const dropletGeo = own(new THREE.SphereGeometry(0.024, 8, 6));
  const droplets = addMesh(new THREE.InstancedMesh(dropletGeo, sweatMat, SWEAT_POOL));
  const pool = Array.from({ length: SWEAT_POOL }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), age: 1, life: 1 }));
  let nextDroplet = 0;

  // A soft blob under each gull keeps it planted on the floor.
  const blobTex = own(blobTexture());
  const blobGeo = own(new THREE.PlaneGeometry(0.8, 0.8).rotateX(-Math.PI / 2));
  const blobMat = own(new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, color: '#000000', opacity: 0.55 }));
  const blobs = addMesh(new THREE.InstancedMesh(blobGeo, blobMat, count));
  blobs.renderOrder = 1;

  const gulls = defs.map(startState);

  const advance = (dt: number) => {
    gulls.forEach((g, i) => {
      const r = defs[i].route;
      const wp = r[g.seg];
      if (g.pause > 0) {
        g.pause -= dt;
        standFacing(g, wp.face, dt);
        if (g.pause <= 0) g.seg = (g.seg + 1) % r.length;
      } else if (stepToward(g, wp.x, wp.z, defs[i].speed, dt)) {
        if (wp.pause) g.pause = wp.pause * (0.8 + 0.4 * Math.abs(Math.sin(g.seed * 7.1 + g.phase)));
        else g.seg = (g.seg + 1) % r.length;
      }
    });
  };

  // scratch matrices for one gull's skeleton
  const root = new THREE.Matrix4();
  const mPelvis = new THREE.Matrix4();
  const mBody = new THREE.Matrix4();
  const mHead = new THREE.Matrix4();
  const mTail = new THREE.Matrix4();
  const mWing = [new THREE.Matrix4(), new THREE.Matrix4()];
  const mLeg = [new THREE.Matrix4(), new THREE.Matrix4()];
  const mFoot = [new THREE.Matrix4(), new THREE.Matrix4()];
  const link = (out: THREE.Matrix4, parent: THREE.Matrix4, x: number, y: number, z: number, pitch = 0, yaw = 0, roll = 0) =>
    out.multiplyMatrices(parent, tmpM.compose(tmpP.set(x, y, z), tmpQ.setFromEuler(tmpE.set(pitch, yaw, roll, 'YZX')), ONE));
  const local = new THREE.Vector3();
  const vel = new THREE.Vector3();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const smooth = THREE.MathUtils.smoothstep;

  const pose = (t: number, dt: number, hide?: (x: number, z: number) => boolean) => {
    walkerLists.add(walkers);
    walkers.length = count;
    gulls.forEach((g, i) => {
      const w = walkers[i] ?? (walkers[i] = { x: 0, z: 0 });
      w.x = g.x;
      w.z = g.z;
      const inHot = inHotAisle(g.x, g.z);
      g.hot = approach(g.hot, inHot ? 1 : 0, dt * (inHot ? 1.2 : 0.6));

      if (hide?.(g.x, g.z)) {
        for (const name of Object.keys(seg) as SegName[]) {
          if (paired[name]) {
            seg[name].setMatrixAt(i * 2, zero);
            seg[name].setMatrixAt(i * 2 + 1, zero);
          } else seg[name].setMatrixAt(i, zero);
        }
        hat?.setMatrixAt(i, zero);
        drops.setMatrixAt(i, zero);
        blobs.setMatrixAt(i, zero);
        return;
      }

      const a = g.walk;
      // Standing about, a gull looks around; at work it keeps its eyes on the job and pecks.
      const idle = (1 - a) * (1 - g.work);
      const peck = g.work * (0.3 + 0.24 * Math.sin(t * 15 + g.seed));
      const s = Math.sin(g.phase);
      const c = Math.cos(g.phase);
      const hot = smooth(g.hot, 0, 1);

      // Short stiff legs: the left swings forward while cos > 0, the right while cos < 0.
      const th = [-STEP * s, STEP * s];
      const hipY = LEG * Math.cos(STEP * Math.abs(s)) + ANKLE;
      // The waddle: the body rolls over whichever foot is planted and the hips shift that way.
      const roll = -0.17 * c * a;
      const sway = 0.03 * c * a;

      root.compose(tmpP.set(g.x, 0, g.z), tmpQ.setFromAxisAngle(UP, g.yaw), tmpS.setScalar(S));
      link(mPelvis, root, sway, hipY, 0);
      link(mBody, mPelvis, 0, 0, 0, 0.1 * a + 0.05 * hot + 0.12 * g.work, 0.07 * s * a, roll);
      // The head bobs twice a cycle like a pigeon's, counter-rolls to stay level, droops in the heat,
      // looks around when standing, and pecks away at a repair.
      link(
        mHead,
        mBody,
        0,
        0.42,
        0.12,
        0.1 * Math.sin(2 * g.phase) * a - 0.09 * hot + 0.04 * idle * Math.sin(t * 1.3 + g.seed) + peck,
        idle * 0.6 * Math.sin(t * 0.7 + g.seed * 3),
        -0.6 * roll + idle * 0.12 * Math.sin(t * 0.45 + g.seed * 2),
      );
      link(mTail, mBody, 0, 0.2, -0.32, 0.1 * a * Math.abs(Math.sin(2 * g.phase)), 0.35 * s * a + idle * 0.1 * Math.sin(t * 2.1 + g.seed), 0);

      for (const k of [0, 1] as const) {
        const side = k === 0 ? -1 : 1;
        // wings stay tucked; a flutter with each step, and a fluster-flap in the heat
        const lift = 0.06 * Math.abs(s) * a + hot * (0.5 + 0.4 * Math.sin(t * 10 + g.seed));
        link(mWing[k], mBody, side * 0.26, 0.4, 0.14, 0, 0, side * lift);
        const swing = k === 0 ? Math.max(0, c) : Math.max(0, -c);
        link(mLeg[k], mPelvis, side * HIP_X, 0.05 * swing * a, 0.02, th[k]);
        link(mFoot[k], mLeg[k], 0, -LEG, 0, -th[k], side * 0.2); // flat feet, toes a little splayed
        seg.wing.setMatrixAt(i * 2 + k, mWing[k]);
        seg.leg.setMatrixAt(i * 2 + k, mLeg[k]);
        seg.foot.setMatrixAt(i * 2 + k, mFoot[k]);
      }
      seg.body.setMatrixAt(i, mBody);
      seg.head.setMatrixAt(i, mHead);
      hat?.setMatrixAt(i, mHead);
      seg.tail.setMatrixAt(i, mTail);

      // sweat
      if (g.hot > 0.02) {
        const k = hot * (1 + 0.08 * Math.sin(t * 9 + g.seed));
        link(tmpM2, mHead, 0.215, 0.33, 0.1, 0, 0, -0.45);
        tmpM2.scale(tmpS.set(k, k, k));
        drops.setMatrixAt(i, tmpM2);
      } else drops.setMatrixAt(i, zero);
      g.spawn -= dt;
      if (g.hot > 0.5 && g.spawn <= 0) {
        g.spawn = 0.07 + 0.12 * Math.abs(Math.sin(t * 17.3 + g.seed));
        const side = Math.sin(t * 31.7 + g.seed) > 0 ? 1 : -1;
        const d = pool[nextDroplet];
        nextDroplet = (nextDroplet + 1) % SWEAT_POOL;
        d.p.copy(local.set(side * 0.16, 0.4, 0.06)).applyMatrix4(mHead);
        vel.set(side * (0.55 + 0.45 * Math.abs(Math.sin(t * 7 + g.seed))), 1.25 + 0.35 * Math.sin(t * 5.3), 0.25 * Math.sin(t * 3.1 + g.seed));
        d.v.copy(vel.applyAxisAngle(UP, g.yaw));
        d.age = 0;
        d.life = 0.5 + 0.2 * Math.abs(Math.sin(t * 11 + g.seed));
      }

      blobs.setMatrixAt(i, tmpM.compose(tmpP.set(g.x, 0.007, g.z), tmpQ.identity(), tmpS.set(S, 1, S)));
    });

    pool.forEach((d, j) => {
      if (d.age >= d.life) {
        droplets.setMatrixAt(j, zero);
        return;
      }
      d.age += dt;
      d.v.y -= 5 * dt;
      d.p.addScaledVector(d.v, dt);
      const k = Math.max(0, 1 - d.age / d.life);
      droplets.setMatrixAt(j, tmpM.compose(d.p, tmpQ.identity(), tmpS.set(k, 1.25 * k, k)));
    });

    for (const m of [...Object.values(seg), drops, droplets, blobs]) m.instanceMatrix.needsUpdate = true;
    if (hat) hat.instanceMatrix.needsUpdate = true;
  };

  return {
    group,
    gulls,
    walkers,
    advance,
    pose,
    dispose: () => {
      walkerLists.delete(walkers);
      for (const d of disposables) d.dispose();
    },
  };
}
