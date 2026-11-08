// Where the gulls are right now, on the floor. Each crew (the patrolling gulls, the tech) keeps
// its own list and rewrites it every frame; the hot-aisle doors read them all to know when to
// open. A list is empty while its crew is hidden.

export interface Walker {
  x: number;
  z: number;
}

export const walkerLists = new Set<Walker[]>();
