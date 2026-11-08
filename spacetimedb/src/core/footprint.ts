// Turns "kind + target" into what the work touches: the locks it claims and what
// it takes offline. This is where the scope rules of DESIGN.md §4.4 live.
//
// Lock resources and modes
//   aisle:<id>, rack:<id>, node:<id>   hands-on space. A claim on a space covers everything
//                                      inside it, so work below also takes an intent (I) claim
//                                      on the rack and aisle above it.
//   svc:<node>                         what runs on a node. Maintenance always claims it
//                                      exclusively; running jobs hold it too (checked from
//                                      the node's owner) unless the work runs alongside jobs.
//   part:<id>                          a facility part.
//   X exclusive · S shared (protection) · I intent. Compatible pairs: I+I and S+S only.

import { CATALOG, NETWORK_PARTS, type TargetKind, type WorkKind, type WorkSpec } from './catalog';
import type { Store } from './store';
import { formatRows, label } from './text';
import { RequestError, type PartType } from './types';

export type LockMode = 'X' | 'S' | 'I';

export interface Claim {
  resource: string;
  mode: LockMode;
}

export interface Footprint {
  targetKind: TargetKind;
  target: string;
  targetLabel: string;
  claims: Claim[];
  nodes: string[]; // nodes whose service it locks
  offlineNodes: string[]; // nodes it takes offline
  offlineParts: string[]; // parts it takes offline
  coolingHitAisle: string; // hot aisle it opens, '' if none
  racks: string[]; // racks it works in or that sit below its part
  rows: number[]; // rows it physically happens in (for the actor's scope); 0 = central plant
  withJobs: boolean; // may run while jobs run on its nodes
}

export const compatible = (a: string, b: string) => (a === 'I' && b === 'I') || (a === 'S' && b === 'S');

export const res = {
  aisle: (id: string) => `aisle:${id}`,
  rack: (id: string) => `rack:${id}`,
  node: (id: string) => `node:${id}`,
  svc: (id: string) => `svc:${id}`,
  part: (id: string) => `part:${id}`,
};

export interface Target {
  kind: TargetKind;
  id: string;
  label: string;
}

export function resolveTarget(s: Store, target: string): Target {
  if (s.node(target)) return { kind: 'node', id: target, label: target };
  if (s.rack(target)) return { kind: 'rack', id: target, label: target };
  const aisle = s.aisle(target);
  if (aisle) return { kind: 'aisle', id: target, label: `${label(target)} (${formatRows(aisle.rows)})` };
  if (s.part(target)) return { kind: 'part', id: target, label: label(target) };
  const m = target.match(/^row-(\d+)$/);
  if (m && s.racksInRow(Number(m[1])).length) return { kind: 'row', id: target, label: label(target) };
  if (s.job(target)) return { kind: 'job', id: target, label: target };
  throw new RequestError(`Unknown target "${target}". Use a node, rack, row-N, hot aisle (ha-N), part or job id.`);
}

function nodesOf(s: Store, t: Target): string[] {
  switch (t.kind) {
    case 'node':
      return [t.id];
    case 'rack':
      return [...s.rack(t.id)!.nodes];
    case 'row':
      return s.racksInRow(Number(t.id.slice(4))).flatMap((r) => r.nodes);
    case 'job':
      return s
        .nodesOwnedBy(t.id)
        .sort((a, b) => a.ord - b.ord)
        .map((n) => n.id);
    default:
      return [];
  }
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function footprint(s: Store, kind: WorkKind, targetId: string): Footprint {
  const spec: WorkSpec = CATALOG[kind];
  const t = resolveTarget(s, targetId);
  if (!spec.targets.includes(t.kind)) {
    throw new RequestError(`${spec.title} targets ${spec.targets.join(' / ')}; ${t.id} is a ${t.kind}.`);
  }
  const fp: Footprint = {
    targetKind: t.kind,
    target: t.id,
    targetLabel: t.label,
    claims: [],
    nodes: [],
    offlineNodes: [],
    offlineParts: [],
    coolingHitAisle: '',
    racks: [],
    rows: [],
    withJobs: spec.withJobs,
  };
  const lockNodes = (ids: string[]) => {
    fp.nodes = ids;
    for (const n of ids) fp.claims.push({ resource: res.svc(n), mode: 'X' });
  };

  if (t.kind === 'part') {
    const part = s.part(t.id)!;
    if (spec.partTypes && !spec.partTypes.includes(part.type as PartType)) {
      throw new RequestError(`${spec.title} applies to ${spec.partTypes.join(' / ')} parts; ${label(t.id)} is a ${part.type}.`);
    }
    fp.claims.push({ resource: res.part(t.id), mode: 'X' });
    fp.offlineParts = [t.id];
    fp.racks = s.downstreamRacks(t.id);
    fp.rows = [part.rowNum];
    if (NETWORK_PARTS.includes(part.type as PartType)) {
      // No per-node network backup in the demo: every node below the switch drops off,
      // so the work needs those nodes to itself (no jobs, no other maintenance).
      lockNodes(fp.racks.flatMap((r) => s.rack(r)!.nodes));
      fp.withJobs = false;
    }
    return fp;
  }

  if (t.kind === 'aisle') {
    const aisle = s.aisle(t.id)!;
    fp.claims.push({ resource: res.aisle(t.id), mode: 'X' });
    fp.coolingHitAisle = spec.coolingHit ? t.id : '';
    fp.racks = aisle.rows.flatMap((r) => s.racksInRow(r).map((x) => x.id));
    fp.rows = [...aisle.rows];
    return fp;
  }

  const nodes = nodesOf(s, t);
  if (nodes.length === 0) throw new RequestError(`${t.label} holds no nodes.`);
  const nodeRows = nodes.map((n) => s.node(n)!);
  fp.racks = uniq(nodeRows.map((n) => n.rack));
  fp.rows = uniq(nodeRows.map((n) => n.rowNum));

  if (spec.space === 'node') {
    const rack = s.rack(nodeRows[0].rack)!;
    fp.claims.push(
      { resource: res.node(t.id), mode: 'X' },
      { resource: res.rack(rack.id), mode: 'I' },
      { resource: res.aisle(rack.aisle), mode: 'I' },
    );
  } else if (spec.space === 'rack') {
    const rack = s.rack(t.id)!;
    fp.claims.push({ resource: res.rack(rack.id), mode: 'X' }, { resource: res.aisle(rack.aisle), mode: 'I' });
  }
  if (spec.locksNodes) lockNodes(nodes);
  if (spec.nodesOffline) fp.offlineNodes = [...nodes];
  return fp;
}

/** A protection lease: shared claims on the job's racks (and intent on their aisles). */
export function protectionFootprint(s: Store, jobId: string): Footprint {
  const nodes = s.nodesOwnedBy(jobId).sort((a, b) => a.ord - b.ord);
  if (nodes.length === 0) throw new RequestError(`${jobId} holds no nodes to protect.`);
  const racks = uniq(nodes.map((n) => n.rack));
  const aisles = uniq(racks.map((r) => s.rack(r)!.aisle));
  return {
    targetKind: 'job',
    target: jobId,
    targetLabel: jobId,
    claims: [
      ...racks.map((r) => ({ resource: res.rack(r), mode: 'S' as const })),
      ...aisles.map((a) => ({ resource: res.aisle(a), mode: 'I' as const })),
    ],
    nodes: [],
    offlineNodes: [],
    offlineParts: [],
    coolingHitAisle: '',
    racks,
    rows: uniq(nodes.map((n) => n.rowNum)),
    withJobs: true,
  };
}
