// The entrance's two interlocked doors (a mantrap): door 0 on the hall side, door 1 on the
// office side, a short hallway between. A door opens only when asked for and only once the
// other one is fully shut, so the two are never open at once; it closes again when it is no
// longer asked for and nobody is standing in it. The tech asks for the door it is waiting at
// (rounds.ts); Airlock.tsx draws the doors from `open`.
//
// Pure logic: no three.js, no React. Tested in spacetimedb/test/view-tech.test.ts.

import type { Point } from './nav';

export const DOOR_OPEN_TIME = 0.9; // seconds from shut to fully open
export const DOOR_CLOSE_TIME = 1.1;
/** Someone this close to a door's plane, within its width, is standing in the doorway. */
const IN_DOORWAY = 0.45;

export type DoorIndex = 0 | 1;

export interface AirlockGeom {
  /** x of each door's plane (both doors face along x). */
  doors: readonly [number, number];
  /** z of the doorways' centre, and their width. */
  z: number;
  width: number;
}

export interface Airlock {
  /** 0 shut .. 1 fully open, per door. */
  readonly open: readonly [number, number];
  /** Asks for a door this tick. */
  request(d: DoorIndex): void;
  isOpen(d: DoorIndex): boolean;
  /** Shut, and kept shut because the other door is not. */
  isLocked(d: DoorIndex): boolean;
  /** One tick: dt seconds, with these people about (anyone in a doorway holds that door open). */
  update(dt: number, people: readonly Point[]): void;
}

export function createAirlock(g: AirlockGeom): Airlock {
  const open: [number, number] = [0, 0];
  const asked: [boolean, boolean] = [false, false];
  const inDoorway = (d: DoorIndex, p: Point) => Math.abs(p.x - g.doors[d]) < IN_DOORWAY && Math.abs(p.z - g.z) < g.width / 2;

  return {
    open,
    request(d) {
      asked[d] = true;
    },
    isOpen: (d) => open[d] >= 1,
    isLocked: (d) => open[d] === 0 && open[1 - d] > 0,
    update(dt, people) {
      for (const d of [0, 1] as const) {
        const other = open[1 - d];
        const held = open[d] > 0 && people.some((p) => inDoorway(d, p));
        if (asked[d] || held) {
          // the interlock: a door only moves toward open while the other is fully shut
          if (other === 0) open[d] = Math.min(1, open[d] + dt / DOOR_OPEN_TIME);
        } else {
          open[d] = Math.max(0, open[d] - dt / DOOR_CLOSE_TIME);
        }
      }
      asked[0] = asked[1] = false;
    },
  };
}
