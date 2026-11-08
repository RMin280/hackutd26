// Shared-cause diagnosis (DESIGN.md §5). Deterministic, uses only what has already
// failed or degraded; it never forecasts. Touches ~14 ancestors per failed node plus
// one downstream lookup for the cause.

import { NETWORK_PARTS, SEND_BY_PART } from './catalog';
import type { Store } from './store';
import { duration, fmtInt, joinAnd, label, plural } from './text';
import type { PartType } from './types';

export interface DiagnosisResult {
  job: string;
  classification: 'shared_cause' | 'isolated';
  cause: string;
  atRisk: string[];
  send: string;
  reason: string;
}

function ancestorsOf(s: Store, nodeId: string): string[] {
  const rack = s.rack(s.node(nodeId)!.rack)!;
  return [...new Set([...rack.powerFeeds.flat(), ...rack.coolingFeeds.flat(), ...rack.network])];
}

export function diagnose(s: Store, failed: string[], now: number, windowMin: number): DiagnosisResult {
  const primary = failed[0];
  const node = s.node(primary)!;
  const job = node.ownerKind === 'job' ? node.ownerId : '';
  const ancestors = ancestorsOf(s, primary);

  // Other failures in the window (plus any passed in together) that share a part with it.
  const others = [...new Set([...failed.slice(1), ...s.failuresSince(now - windowMin).map((f) => f.node)])].filter(
    (n) => n !== primary && s.node(n),
  );
  const otherAnc = others.map((n) => ({ node: n, above: new Set(ancestorsOf(s, n)) }));

  const candidates = ancestors
    .map((p, order) => {
      const part = s.part(p)!;
      const sharedWith = otherAnc.filter((o) => o.above.has(p)).map((o) => o.node);
      const bad = part.state === 'failed' ? 2 : part.state === 'degraded' ? 1 : 0;
      return { p, part, order, bad, sharedWith };
    })
    // A broken part always counts. A healthy part counts only if another recent failure
    // shares it and it is row-level: central plant (UPS, utility, chillers, spines) sits
    // above most of the hall, so sharing it says nothing.
    .filter((c) => c.bad > 0 || (c.sharedWith.length > 0 && c.part.rowNum !== 0))
    .map((c) => ({ ...c, size: s.downstreamRacks(c.p).length, noBackup: NETWORK_PARTS.includes(c.part.type as PartType) ? 1 : 0 }))
    // Broken parts first, then the most shared, then the most specific (fewest racks below).
    .sort(
      (a, b) =>
        b.bad - a.bad ||
        b.sharedWith.length - a.sharedWith.length ||
        a.size - b.size ||
        b.noBackup - a.noBackup ||
        a.order - b.order,
    );

  if (candidates.length === 0) {
    return {
      job,
      classification: 'isolated',
      cause: '',
      atRisk: [],
      send: `hardware tech to ${primary}`,
      reason: `Isolated: every part above ${primary} is ok and no other recent failure shares a part with it. Treat as a single-node fault.`,
    };
  }

  const c = candidates[0];
  const failedSet = new Set(failed);
  const atRisk: string[] = [];
  for (const r of s.downstreamRacks(c.p)) {
    for (const n of s.rack(r)!.nodes) {
      if (n === primary || failedSet.has(n)) continue;
      const nr = s.node(n);
      if (nr && job && nr.ownerKind === 'job' && nr.ownerId === job && nr.state !== 'failed') atRisk.push(n);
    }
  }
  const type = c.part.type as PartType;
  const verb = type === 'cdu' || type === 'chiller' ? 'cooled' : type === 'leaf' || type === 'spine' ? 'connected' : 'powered';
  const C = label(c.p);
  const onIt = job ? `${fmtInt(atRisk.length)} other nodes of ${job} are on ${C}.` : `${C} feeds ${plural(s.downstreamRacks(c.p).length, 'rack')}.`;
  const reason =
    c.bad > 0
      ? `Shared cause: ${primary} is ${verb} by ${C} (${c.part.state}). ${onIt} Not a single-GPU fault.`
      : `Shared cause: ${primary} and ${joinAnd(c.sharedWith)} failed within ${duration(windowMin)} and share ${C}. ${onIt} Check it before restarting nearby.`;
  return { job, classification: 'shared_cause', cause: c.p, atRisk, send: `${SEND_BY_PART[type]} to ${C}`, reason };
}
