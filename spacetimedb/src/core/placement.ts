// Safe restart placement (DESIGN.md §6): one linear pass over free nodes. We don't
// pack jobs; the scheduler decides how to use the list.

import type { Store } from './store';
import { formatList, formatRows } from './text';
import { LIVE_STATUSES } from './types';

export const EXCLUDE_REASONS = [
  'failed, at risk or in maintenance',
  'unhealthy part above it',
  'rack below full backup',
  'maintenance booked',
] as const;

export interface PlacementResult {
  nodes: string[];
  racks: string[]; // distinct racks of the chosen nodes, in order

  excluded: Record<(typeof EXCLUDE_REASONS)[number], number>;
  shortfall: number;
  reason: string;
}

export function safePlacement(
  s: Store,
  job: string,
  needed: number,
  durationMin: number,
  exclude: string[],
  now: number,
): PlacementResult {
  const end = now + durationMin;
  const excludeSet = new Set(exclude);
  const excluded: PlacementResult['excluded'] = {
    'failed, at risk or in maintenance': 0,
    'unhealthy part above it': 0,
    'rack below full backup': 0,
    'maintenance booked': 0,
  };

  // Maintenance already booked anywhere in [now, end): live leases are few.
  const bookedParts = new Set<string>();
  const bookedAisles = new Set<string>();
  const bookedRacks = new Set<string>();
  const bookedNodes = new Set<string>();
  for (const status of LIVE_STATUSES) {
    for (const w of s.workByStatus(status)) {
      if (!(w.startMin < end && now < w.endMin) || w.kind === 'protection') continue;
      for (const p of w.offlineParts) bookedParts.add(p);
      for (const n of w.offlineNodes) bookedNodes.add(n);
      if (w.kind === 'hot_aisle_work') bookedAisles.add(w.target);
      if (w.kind === 'rack_work') bookedRacks.add(w.target);
    }
  }

  // Locality: prefer the leaf, then the spine, of the job's healthy nodes. Asked from the
  // candidates' side: does the job have a healthy node below this switch? Once per switch,
  // walking only that switch's branch and stopping at the first hit, so the cost follows
  // the spares, not the job's size (every read is a table read in SpacetimeDB).
  const jobBelow = new Map<string, boolean>();
  const jobUnder = (sw: string) => {
    let hit = jobBelow.get(sw);
    if (hit === undefined) {
      hit = s.downstreamRacks(sw).some((r) =>
        s.rack(r)!.nodes.some((id) => {
          const n = s.node(id);
          return !!n && n.ownerId === job && n.state !== 'failed' && !excludeSet.has(id);
        }),
      );
      jobBelow.set(sw, hit);
    }
    return hit;
  };

  // Each part read once per call: racks share most of the parts above them.
  const partOk = new Map<string, boolean>();
  const working = (p: string) => {
    let ok = partOk.get(p);
    if (ok === undefined) {
      const part = s.part(p);
      ok = !!part && part.state === 'ok' && part.heldBy === 0n;
      partOk.set(p, ok);
    }
    return ok;
  };

  const rackVerdict = new Map<string, { bad: (typeof EXCLUDE_REASONS)[number] | null; rank: number }>();
  const judgeRack = (rackId: string) => {
    const hit = rackVerdict.get(rackId);
    if (hit) return hit;
    const rack = s.rack(rackId)!;
    const above = [...rack.powerFeeds.flat(), ...rack.coolingFeeds.flat(), ...rack.network];
    let bad: (typeof EXCLUDE_REASONS)[number] | null = null;
    if (!above.every(working)) bad = 'unhealthy part above it';
    else if ((s.margin(rackId)?.margin ?? -1) < 1) bad = 'rack below full backup';
    else if (above.some((p) => bookedParts.has(p)) || bookedAisles.has(rack.aisle) || bookedRacks.has(rackId)) bad = 'maintenance booked';
    const rank = bad ? 2 : jobUnder(rack.network[0]) ? 0 : jobUnder(rack.network[1]) ? 1 : 2;
    const v = { bad, rank };
    rackVerdict.set(rackId, v);
    return v;
  };

  const eligible: { id: string; rack: string; row: number; rank: number; ord: number }[] = [];
  for (const n of s.freeNodes()) {
    if (excludeSet.has(n.id) || n.state !== 'ok' || n.heldBy !== 0n) {
      excluded['failed, at risk or in maintenance']++;
      continue;
    }
    const v = judgeRack(n.rack);
    if (v.bad) {
      excluded[v.bad]++;
      continue;
    }
    if (bookedNodes.has(n.id)) {
      excluded['maintenance booked']++;
      continue;
    }
    eligible.push({ id: n.id, rack: n.rack, row: n.rowNum, rank: v.rank, ord: n.ord });
  }
  eligible.sort((a, b) => a.rank - b.rank || a.ord - b.ord);
  const chosen = eligible.slice(0, needed);
  const nodes = chosen.map((e) => e.id);

  if (nodes.length < needed) {
    return {
      nodes,
      racks: [...new Set(chosen.map((e) => e.rack))],
      excluded,
      shortfall: needed - nodes.length,
      reason: `Shortfall: only ${nodes.length} of ${needed} nodes are safe right now. Options: wait for repair, or restart smaller.`,
    };
  }
  const racks = [...new Set(chosen.map((e) => e.rack))];
  const cdus = racks.map((r) => s.rack(r)!.coolingFeeds[0][0]);
  const hours = Math.round(durationMin / 60);
  return {
    nodes,
    racks,
    excluded,
    shortfall: 0,
    reason: `Restart on ${nodes.length} spare nodes in ${formatRows(chosen.map((e) => e.row))}: separate cooling (${formatList(cdus)}) and power, full backup, no maintenance booked in the next ${hours} h.`,
  };
}
