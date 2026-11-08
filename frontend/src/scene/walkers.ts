// Where the crew is right now, on the floor. The staff writes it every frame; the hot-aisle
// doors read it to know when to open. Empty while the crew is hidden.

export interface Walker {
  x: number;
  z: number;
}

export const walkers: Walker[] = [];
