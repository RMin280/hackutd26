// How a gull gets about: the kinematics the patrolling crew and the tech share. Turn toward
// where you're going, then waddle there; slow right down while still turning. Pure maths (no
// three.js), so the tech's route-following can be tested in Node.

export const TURN_RATE = 3.4; // rad/s
export const STRIDE = 0.42; // metres per cycle: two quick little steps

export interface GullState {
  seg: number; // index of the waypoint being walked to (patrol routes)
  x: number;
  z: number;
  yaw: number; // 0 = facing south (+z), PI = north
  phase: number;
  walk: number; // 0 standing .. 1 walking
  pause: number;
  hot: number; // 0 .. 1, eases in and out at the hot-aisle doors
  work: number; // 0 .. 1, pecking away at a repair (the tech)
  spawn: number;
  seed: number;
}

export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
export const approach = (v: number, to: number, step: number) => (Math.abs(to - v) <= step ? to : v + Math.sign(to - v) * step);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const turnToward = (yaw: number, to: number, step: number) => yaw + clamp(wrap(to - yaw), -step, step);

/** One frame of walking toward (x, z). True once it's there; it doesn't move on that frame. */
export function stepToward(g: GullState, x: number, z: number, speed: number, dt: number): boolean {
  const dx = x - g.x;
  const dz = z - g.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.02) return true;
  const want = Math.atan2(dx, dz);
  const off = Math.abs(wrap(want - g.yaw));
  g.yaw = turnToward(g.yaw, want, TURN_RATE * dt);
  const aligned = off < 0.5;
  const step = Math.min(d, speed * (aligned ? 1 : 0.12) * dt);
  g.x += (dx / d) * step;
  g.z += (dz / d) * step;
  g.walk = approach(g.walk, aligned ? 1 : 0.45, dt * 4);
  g.phase += (step / STRIDE) * Math.PI * 2 + (aligned ? 0 : dt * 6);
  return false;
}

/** One frame of standing still, turning unhurriedly to `face` if given. True once facing it. */
export function standFacing(g: GullState, face: number | undefined, dt: number): boolean {
  if (face !== undefined) g.yaw = turnToward(g.yaw, face, TURN_RATE * 0.6 * dt);
  g.walk = approach(g.walk, 0, dt * 4);
  return face === undefined || Math.abs(wrap(face - g.yaw)) < 0.05;
}
