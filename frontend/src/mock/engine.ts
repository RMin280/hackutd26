// MOCK BACKEND LOGIC. A small stand-in for backend/guard.py, diagnose.py and
// placement.py so the view can be built and rehearsed before the real backend
// (SpacetimeDB) exists. The UI never imports this directly: only the mock data
// source does. When the backend lands, delete this file's callers in
// src/mock/scenario.ts and feed real events into the store instead.

import type {
  Diagnosis,
  Lease,
  Margin,
  MarginLevel,
  Placement,
  Site,
  World,
} from '../model/types';
import { JOB_ID, label } from './site';

export function rackAncestors(site: Site, rackId: string): string[] {
  const r = site.racks[rackId];
  const out: string[] = [];
  for (const chain of [...r.powerFeeds, ...r.coolingFeeds, r.network]) {
    for (const p of chain) if (!out.includes(p)) out.push(p);
  }
  return out;
}

function offlineByLease(world: World, partId: string, at: number): boolean {
  return world.leases.some(
    (l) => l.type === 'maintenance' && l.target === partId && l.start <= at && at < l.end,
  );
}

function feedWorking(world: World, chain: string[], extraOffline?: string): boolean {
  return chain.every(
    (p) => p !== extraOffline && world.partState[p] === 'ok' && !offlineByLease(world, p, world.now),
  );
}

export function rackMargin(site: Site, world: World, rackId: string, extraOffline?: string): Margin {
  const r = site.racks[rackId];
  const pw = r.powerFeeds.filter((c) => feedWorking(world, c, extraOffline));
  const cw = r.coolingFeeds.filter((c) => feedWorking(world, c, extraOffline));
  const power = pw.length - 1;
  const cooling = cw.length - 1;
  const margin = Math.min(power, cooling);
  const level: MarginLevel = margin >= 1 ? 'green' : margin === 0 ? 'yellow' : 'red';
  const unprotected: string[] = [];
  if (power === 0) unprotected.push(...pw[0]);
  if (cooling === 0) unprotected.push(...cw[0]);
  return { power, cooling, margin, level, unprotected };
}

// Full recompute is fine for the 160-rack demo hall in the mock. The real
// backend recomputes only downstream[changed part] (CLAUDE.md scalability rules).
export function computeMargins(site: Site, world: World): Record<string, Margin> {
  const out: Record<string, Margin> = {};
  for (const rid of site.rackOrder) out[rid] = rackMargin(site, world, rid);
  return out;
}

export function jobNodes(site: Site, world: World, job = JOB_ID): string[] {
  return site.nodeOrder.filter((n) => {
    const o = world.owner[n];
    return o.kind === 'job' && o.id === job;
  });
}

const SEND_BY_TYPE: Record<string, string> = {
  cdu: 'mechanical tech',
  chiller: 'mechanical tech',
  pdu: 'electrical tech',
  ups: 'electrical tech',
  switchgear: 'electrical tech',
  utility: 'electrical tech',
  leaf: 'network engineer',
  spine: 'network engineer',
};

export function diagnose(site: Site, world: World, node: string): Diagnosis {
  const rackId = site.nodes[node].rack;
  const ancestors = rackAncestors(site, rackId);
  const cause = ancestors.find((p) => world.partState[p] !== 'ok');
  if (!cause) {
    return {
      node,
      classification: 'isolated',
      atRisk: [],
      send: `hardware tech to ${node}`,
      reason: `Isolated: every part above ${node} is ok and no other failures share a part with it. Treat as a single-node fault.`,
    };
  }
  const causeRacks = new Set(site.downstream[cause]);
  const atRisk = jobNodes(site, world).filter(
    (n) => n !== node && causeRacks.has(site.nodes[n].rack) && world.nodeState[n] === 'ok',
  );
  const part = site.parts[cause];
  const verb = part.type === 'cdu' || part.type === 'chiller' ? 'cooled' : part.type === 'leaf' || part.type === 'spine' ? 'connected' : 'powered';
  return {
    node,
    classification: 'shared_cause',
    cause,
    atRisk,
    send: `${SEND_BY_TYPE[part.type]} to ${label(cause)}`,
    reason: `Shared cause: ${node} is ${verb} by ${label(cause)} (${world.partState[cause]}). ${atRisk.length} other nodes of ${JOB_ID} are on ${label(cause)}. Not a single-GPU fault.`,
  };
}

function formatRows(rows: number[]): string {
  const u = [...new Set(rows)].sort((a, b) => a - b);
  if (u.length === 1) return `Row ${u[0]}`;
  const contiguous = u.every((r, i) => i === 0 || r === u[i - 1] + 1);
  return contiguous ? `Rows ${u[0]}–${u[u.length - 1]}` : `Rows ${u.join(', ')}`;
}

function formatList(ids: string[]): string {
  const u = [...new Set(ids)];
  if (u.length <= 3) return u.map(label).join(', ');
  return `${label(u[0])} … ${label(u[u.length - 1])}`;
}

export function safePlacement(
  site: Site,
  world: World,
  needed: number,
  exclude: string[],
  durationEnd: number,
): Placement {
  const excludeSet = new Set(exclude);
  const excluded: Record<string, number> = {
    'busy (another job or tenant)': 0,
    'failed or at risk': 0,
    'unhealthy part above it': 0,
    'rack below full backup': 0,
    'maintenance booked': 0,
  };
  const healthyJobLeaves = new Set(
    jobNodes(site, world)
      .filter((n) => !excludeSet.has(n))
      .map((n) => site.racks[site.nodes[n].rack].network[0]),
  );
  const healthyJobSpines = new Set(
    jobNodes(site, world)
      .filter((n) => !excludeSet.has(n))
      .map((n) => site.racks[site.nodes[n].rack].network[1]),
  );

  const eligible: { id: string; rank: number; order: number }[] = [];
  site.nodeOrder.forEach((n, order) => {
    const info = site.nodes[n];
    if (world.owner[n].kind !== 'free') return void excluded['busy (another job or tenant)']++;
    if (excludeSet.has(n) || world.nodeState[n] !== 'ok') return void excluded['failed or at risk']++;
    const anc = rackAncestors(site, info.rack);
    if (anc.some((p) => world.partState[p] !== 'ok')) return void excluded['unhealthy part above it']++;
    if (world.margins[info.rack].margin < 1) return void excluded['rack below full backup']++;
    const booked = world.leases.some(
      (l) => l.type === 'maintenance' && l.target && anc.includes(l.target) && l.start < durationEnd && l.end > world.now,
    );
    if (booked) return void excluded['maintenance booked']++;
    const [leaf, spine] = site.racks[info.rack].network;
    const rank = healthyJobLeaves.has(leaf) ? 0 : healthyJobSpines.has(spine) ? 1 : 2;
    eligible.push({ id: n, rank, order });
  });
  eligible.sort((a, b) => a.rank - b.rank || a.order - b.order);
  const nodes = eligible.slice(0, needed).map((e) => e.id);

  if (nodes.length < needed) {
    return {
      job: JOB_ID,
      nodes,
      excluded,
      reason: `Shortfall: only ${nodes.length} of ${needed} nodes are safe right now. Options: wait for repair, or restart smaller.`,
    };
  }
  const rows = nodes.map((n) => site.nodes[n].row);
  const racks = [...new Set(nodes.map((n) => site.nodes[n].rack))];
  const cdus = racks.map((r) => site.racks[r].coolingFeeds[0][0]);
  const hours = Math.round((durationEnd - world.now) / 60);
  return {
    job: JOB_ID,
    nodes,
    excluded,
    reason: `Restart on ${nodes.length} spare nodes in ${formatRows(rows)}: separate cooling (${formatList(cdus)}) and power, full backup, no maintenance booked in the next ${hours} h.`,
  };
}

export interface LeaseCheck {
  verdict: 'allow' | 'warn' | 'deny';
  reason: string;
  earliestSafe?: string;
  dropped: { rack: string; before: MarginLevel; after: MarginLevel }[];
}

export function checkMaintenance(site: Site, world: World, part: string): LeaseCheck {
  const dropped: LeaseCheck['dropped'] = [];
  const protectedRacks = new Set(
    world.leases
      .filter((l) => l.type === 'protection' && l.start <= world.now && world.now < l.end)
      .flatMap((l) => l.racks ?? []),
  );
  const protection = world.leases.find((l) => l.type === 'protection' && world.now < l.end);
  for (const rid of site.downstream[part]) {
    const before = world.margins[rid];
    const after = rackMargin(site, world, rid, part);
    if (after.margin < before.margin) dropped.push({ rack: rid, before: before.level, after: after.level });
  }
  const red = dropped.filter((d) => d.after === 'red');
  const protectedDrops = dropped.filter((d) => protectedRacks.has(d.rack) && d.after !== 'green');
  const P = label(part);

  if (red.length || protectedDrops.length) {
    const blockers = new Set<string>();
    for (const d of red) {
      for (const p of rackAncestors(site, d.rack)) if (world.partState[p] !== 'ok') blockers.add(p);
    }
    const blockerText = [...blockers].map((b) => `${label(b)} ${world.partState[b]}`).join(', ');
    let reason = '';
    if (red.length) {
      const kind = site.parts[part].type === 'cdu' || site.parts[part].type === 'chiller' ? 'cooling' : 'power';
      reason = `${P} is the only ${kind} feed for ${red.length} racks${blockerText ? ` (${blockerText})` : ''}; taking it offline makes them red.`;
    }
    if (protectedDrops.length) {
      reason += `${reason ? ' It would also drop' : `Taking ${P} offline drops`} ${protectedDrops.length} racks protected for ${protection?.job ?? JOB_ID} below full backup.`;
    }
    const earliestSafe = blockers.size
      ? `after ${[...blockers].map(label).join(', ')} repair`
      : protection
        ? `after protection ends (T+${Math.round(protection.end / 60)}h)`
        : undefined;
    return { verdict: 'deny', reason, earliestSafe, dropped };
  }
  if (dropped.some((d) => d.after === 'yellow')) {
    const n = dropped.filter((d) => d.after === 'yellow').length;
    return {
      verdict: 'warn',
      reason: `Taking ${P} offline leaves ${n} racks one failure from an outage. Needs shift lead approval.`,
      dropped,
    };
  }
  return { verdict: 'allow', reason: `${P} can go offline: every rack below it keeps full backup.`, dropped };
}

export function protectionLease(site: Site, world: World, actor: string, end: number): Lease {
  const racks = [...new Set(jobNodes(site, world).map((n) => site.nodes[n].rack))];
  return { id: `lease-prot-${world.now}`, type: 'protection', actor, racks, job: JOB_ID, start: world.now, end };
}
