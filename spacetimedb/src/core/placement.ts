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

  // Locality: prefer the leaf, then the spine, of the job's healthy nodes.
  const leaves = new Set<string>();
  const spines = new Set<string>();
  for (const n of s.nodesOwnedBy(job)) {
    if (excludeSet.has(n.id) || n.state === 'failed') continue;
    const net = s.rack(n.rack)!.network;
    leaves.add(net[0]);
    spines.add(net[1]);
  }

  const rackVerdict = new Map<string, { bad: (typeof EXCLUDE_REASONS)[number] | null; rank: number }>();
  const judgeRack = (rackId: string) => {
    const hit = rackVerdict.get(rackId);
    if (hit) return hit;
    const rack = s.rack(rackId)!;
    const above = [...rack.powerFeeds.flat(), ...rack.coolingFeeds.flat(), ...rack.network];
    let bad: (typeof EXCLUDE_REASONS)[number] | null = null;
    if (above.some((p) => s.part(p)?.state !== 'ok' || s.part(p)?.heldBy !== 0n)) bad = 'unhealthy part above it';
    else if ((s.margin(rackId)?.margin ?? -1) < 1) bad = 'rack below full backup';
    else if (above.some((p) => bookedParts.has(p)) || bookedAisles.has(rack.aisle) || bookedRacks.has(rackId)) bad = 'maintenance booked';
    const rank = leaves.has(rack.network[0]) ? 0 : spines.has(rack.network[1]) ? 1 : 2;
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
    excluded,
    shortfall: 0,
    reason: `Restart on ${nodes.length} spare nodes in ${formatRows(chosen.map((e) => e.row))}: separate cooling (${formatList(cdus)}) and power, full backup, no maintenance booked in the next ${hours} h.`,
  };
}
