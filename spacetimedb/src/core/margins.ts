// Remaining backup per rack (DESIGN.md §3.2), from explicit feed chains.
//   power   = working power feeds - 1
//   cooling = working cooling feeds - 1 - (1 if its hot aisle is open for work)
//   margin  = min(power, cooling): >= 1 green, 0 yellow ("one failure from an outage"), < 0 red
// A feed works when every part on its chain is ok and not held offline by work.

import type { Store } from './store';
import type { MarginLevel, MarginRow, RackRow } from './types';

export interface MarginCalc {
  power: number;
  cooling: number;
  margin: number;
  level: MarginLevel;
  unprotected: string[];
}

export const levelOf = (margin: number): MarginLevel => (margin >= 1 ? 'green' : margin === 0 ? 'yellow' : 'red');

export function computeMargin(rack: RackRow, working: (part: string) => boolean, coolingHits: number): MarginCalc {
  const pw = rack.powerFeeds.filter((c) => c.every(working));
  const cw = rack.coolingFeeds.filter((c) => c.every(working));
  const power = pw.length - 1;
  const cooling = cw.length - 1 - coolingHits;
  const margin = Math.min(power, cooling);
  const unprotected: string[] = [];
  if (power === 0) unprotected.push(...pw[0]);
  if (cooling === 0 && cw.length === 1) unprotected.push(...cw[0]);
  return { power, cooling, margin, level: levelOf(margin), unprotected };
}

/** Margin right now: physical state plus work that is active at this minute. */
export function currentMargin(s: Store, rack: RackRow): MarginCalc {
  const working = (p: string) => {
    const part = s.part(p);
    return !!part && part.state === 'ok' && part.heldBy === 0n;
  };
  const aisle = s.aisle(rack.aisle);
  return computeMargin(rack, working, aisle && aisle.heldBy !== 0n ? 1 : 0);
}

export function marginRow(rack: RackRow, m: MarginCalc, prev?: MarginRow): MarginRow {
  return {
    rack: rack.id,
    power: m.power,
    cooling: m.cooling,
    margin: m.margin,
    level: m.level,
    unprotected: m.unprotected,
    protectedBy: prev?.protectedBy ?? 0n,
    protectedJob: prev?.protectedJob ?? '',
    protectedUntil: prev?.protectedUntil ?? -1,
  };
}

/** Incremental recompute: only the racks below what changed (CLAUDE.md scalability rules). */
export function recomputeRacks(s: Store, rackIds: Iterable<string>): void {
  for (const id of new Set(rackIds)) {
    const rack = s.rack(id);
    if (!rack) continue;
    s.putMargin(marginRow(rack, currentMargin(s, rack), s.margin(id)));
  }
}
