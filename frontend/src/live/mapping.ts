// Turns SpacetimeDB rows into the shapes the view already renders (model/types.ts).
// Pure functions: no connection, no store. The view keeps holding no safety logic;
// margins, verdicts and diagnoses all arrive computed by the backend.

import type {
  ActorKind,
  DecisionEvent,
  Diagnosis,
  FocusTarget,
  JobStatus,
  Lease,
  Margin,
  MarginLevel,
  NodeInfo,
  Owner,
  Part,
  PartState,
  PartType,
  Placement,
  Rack,
  Site,
  Verdict,
  WorkItem,
  WorkStatus,
  World,
} from '../model/types';
import type { Mode } from '../mock/scenario';

/** The backend's scenario keys (spacetimedb/src/core/scenario.ts MODES). */
const MODES: readonly Mode[] = ['naive', 'squawk', 'updates', 'maintenance'];

// Row shapes as the generated bindings expose them (column names in camelCase).
// u64 columns arrive as bigint.
export interface PartRow {
  id: string;
  type: string;
  rowNum: number;
  ord: number;
  state: string;
  heldBy: bigint;
}
export interface RackRow {
  id: string;
  rowNum: number;
  pos: number;
  aisle: string;
  ord: number;
  powerFeeds: string[][];
  coolingFeeds: string[][];
  network: string[];
  nodes: string[];
}
export interface NodeRow {
  id: string;
  rack: string;
  rowNum: number;
  slot: number;
  ord: number;
  state: string;
  ownerKind: string;
  ownerId: string;
  heldBy: bigint;
}
export interface DownstreamRow {
  id: bigint;
  part: string;
  rack: string;
}
export interface MarginRow {
  rack: string;
  power: number;
  cooling: number;
  margin: number;
  level: string;
  unprotected: string[];
}
export interface JobRow {
  id: string;
  status: string;
  nodes: number;
  restarts: number;
  crashes: number;
}
export interface WorkRow {
  id: bigint;
  ticket: string;
  kind: string;
  category: string;
  targetKind: string;
  target: string;
  targetLabel: string;
  actor: string;
  actorRole: string;
  requestedAt: number;
  startMin: number;
  endMin: number;
  status: string;
  verdict: string;
  reason: string;
  earliestSafe: string;
  blockers: string[];
  racks: string[];
  job: string;
  nodeCount: number;
  approvedBy: string;
  routine: boolean;
  note: string;
  bookedBy: string;
}
/** The work board's bookkeeping: who took a lease on and who finished it (accept_work / complete_work). */
export interface AssignmentRow {
  work: bigint;
  assignee: string;
  assigneeRole: string;
  acceptedAt: number;
  completedBy: string;
  completedAt: number;
  repaired: string[];
  note: string;
}
export interface DiagnosisRow {
  id: bigint;
  nodes: string[];
  classification: string;
  cause: string;
  atRisk: string[];
  send: string;
  reason: string;
}
export interface PlacementRow {
  id: bigint;
  job: string;
  nodes: string[];
  excludedReasons: string[];
  excludedCounts: number[];
  reason: string;
  used: boolean;
}
export interface DecisionRow {
  seq: bigint;
  atMin: number;
  actor: string;
  actorKind: string;
  title: string;
  verdict: string;
  reason: string;
  focusKind: string;
  focusIds: string[];
  focusParts: string[];
  type?: string; // what happened (state_change, lease_denied, agent_plan, ...)
  subject?: string; // the node, part, job or work it is about
  data?: string; // JSON with the typed fields agents read; the work board reads an agent's status from it
}
export interface ClockRow {
  id: number;
  nowMin: number;
}
export interface ScenarioRow {
  mode: string;
  bed: string;
  step: number;
  total: number;
  caption: string;
  cameraKind: string;
  cameraIds: string[];
  cameraParts: string[];
  version: number;
}

export interface Tables {
  part: PartRow[];
  rack: RackRow[];
  node: NodeRow[];
  downstream: DownstreamRow[];
  margin: MarginRow[];
  job: JobRow[];
  work: WorkRow[];
  assignment?: AssignmentRow[]; // missing until the bindings include the table (npm run bindings)
  diagnosis: DiagnosisRow[];
  placement: PlacementRow[];
  decision: DecisionRow[];
  clock: ClockRow[];
  scenario: ScenarioRow[];
}

const isHeld = (heldBy: bigint | number) => String(heldBy) !== '0';
const byOrd = <T extends { ord: number }>(a: T, b: T) => a.ord - b.ord;
const byId = <T extends { id: bigint }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const newest = <T extends { id: bigint }>(rows: T[]): T | undefined => rows.reduce<T | undefined>((m, r) => (!m || r.id > m.id ? r : m), undefined);

const ACTOR_KINDS: ActorKind[] = ['facility', 'scheduler', 'cooling', 'fixer', 'squawk'];
const VERDICTS: Verdict[] = ['allow', 'warn', 'deny', 'failure', 'shared_cause', 'isolated', 'placement', 'info', 'plan', 'fixed', 'handoff'];

/** The facility map. Rebuild only when parts, racks, nodes or downstream rows are added or removed. */
export function toSite(t: Pick<Tables, 'part' | 'rack' | 'node' | 'downstream'>): Site {
  const parts: Record<string, Part> = {};
  const partRows = [...t.part].sort(byOrd);
  for (const p of partRows) parts[p.id] = { id: p.id, type: p.type as PartType, row: p.rowNum || undefined };

  const racks: Record<string, Rack> = {};
  const rackRows = [...t.rack].sort(byOrd);
  for (const r of rackRows) {
    racks[r.id] = {
      id: r.id,
      row: r.rowNum,
      pos: r.pos,
      powerFeeds: r.powerFeeds.map((c) => [...c]),
      coolingFeeds: r.coolingFeeds.map((c) => [...c]),
      network: [...r.network],
      nodes: [...r.nodes],
    };
  }

  const nodes: Record<string, NodeInfo> = {};
  const nodeRows = [...t.node].sort(byOrd);
  for (const n of nodeRows) nodes[n.id] = { id: n.id, rack: n.rack, row: n.rowNum, slot: n.slot };

  const downstream: Record<string, string[]> = {};
  for (const p of partRows) downstream[p.id] = [];
  for (const d of [...t.downstream].sort(byId)) (downstream[d.part] ??= []).push(d.rack);

  return {
    parts,
    partOrder: partRows.map((p) => p.id),
    racks,
    rackOrder: rackRows.map((r) => r.id),
    nodes,
    nodeOrder: nodeRows.map((n) => n.id),
    downstream,
  };
}

function toOwner(n: NodeRow): Owner {
  if (n.ownerKind === 'job') return { kind: 'job', id: n.ownerId };
  if (n.ownerKind === 'tenant') return { kind: 'tenant', id: n.ownerId };
  return { kind: 'free' };
}

function toLease(w: WorkRow): Lease {
  const protection = w.kind === 'protection';
  return {
    id: String(w.id),
    type: protection ? 'protection' : 'maintenance',
    actor: w.actor,
    target: protection ? undefined : w.target,
    racks: protection ? [...w.racks] : undefined,
    job: w.job || undefined,
    start: w.startMin,
    end: w.endMin,
  };
}

const WORK_STATUSES: readonly WorkStatus[] = ['simulated', 'denied', 'needs_approval', 'granted', 'active', 'done', 'cancelled', 'rejected', 'expired'];
const orUndefined = (s: string) => s || undefined;

/** Every request the backend holds, oldest first, with the board's bookkeeping joined on. */
export function toWorkItems(work: WorkRow[], assignments: AssignmentRow[] = []): WorkItem[] {
  const byWork = new Map<string, AssignmentRow>();
  for (const a of assignments) byWork.set(String(a.work), a);
  return [...work].sort(byId).map((w) => {
    const a = byWork.get(String(w.id));
    const item: WorkItem = {
      id: String(w.id),
      ticket: w.ticket,
      kind: w.kind,
      category: w.category === 'software' ? 'software' : w.category === 'protection' || w.kind === 'protection' ? 'protection' : 'hardware',
      targetKind: w.targetKind,
      target: w.target,
      targetLabel: w.targetLabel,
      actor: w.actor,
      actorRole: w.actorRole,
      bookedBy: orUndefined(w.bookedBy),
      requestedAt: w.requestedAt,
      start: w.startMin,
      end: w.endMin,
      status: WORK_STATUSES.includes(w.status as WorkStatus) ? (w.status as WorkStatus) : 'simulated',
      verdict: w.verdict === 'allow' || w.verdict === 'warn' ? w.verdict : 'deny',
      reason: w.reason,
      earliestSafe: orUndefined(w.earliestSafe),
      blockers: [...w.blockers],
      racks: [...w.racks],
      job: orUndefined(w.job),
      nodeCount: w.nodeCount,
      approvedBy: orUndefined(w.approvedBy),
      routine: w.routine,
      note: orUndefined(w.note),
    };
    if (a && (a.assignee || a.completedBy)) {
      item.assignee = orUndefined(a.assignee);
      item.assigneeRole = orUndefined(a.assigneeRole);
      item.acceptedAt = a.acceptedAt >= 0 ? a.acceptedAt : undefined;
      item.completedBy = orUndefined(a.completedBy);
      item.completedAt = a.completedAt >= 0 ? a.completedAt : undefined;
      item.repaired = [...a.repaired];
      item.completionNote = orUndefined(a.note);
    }
    return item;
  });
}

export function toWorld(t: Tables, site: Site): World {
  const partState: Record<string, PartState> = {};
  for (const p of t.part) partState[p.id] = isHeld(p.heldBy) ? 'maintenance' : (p.state as PartState);

  const nodeState: Record<string, PartState> = {};
  const owner: Record<string, Owner> = {};
  for (const n of t.node) {
    nodeState[n.id] = isHeld(n.heldBy) ? 'maintenance' : (n.state as PartState);
    owner[n.id] = toOwner(n);
  }

  const margins: Record<string, Margin> = {};
  for (const m of t.margin) {
    margins[m.rack] = {
      power: m.power,
      cooling: m.cooling,
      margin: m.margin,
      level: m.level as MarginLevel,
      unprotected: [...m.unprotected],
    };
  }
  // Never leave a rack without an entry: the view indexes margins by every rack id.
  for (const rid of site.rackOrder) margins[rid] ??= { power: 1, cooling: 1, margin: 1, level: 'green', unprotected: [] };

  const d = newest(t.diagnosis);
  const diagnosis: Diagnosis | undefined = d && {
    node: d.nodes[0] ?? '',
    classification: d.classification === 'shared_cause' ? 'shared_cause' : 'isolated',
    cause: d.cause || undefined,
    atRisk: [...d.atRisk],
    send: d.send,
    reason: d.reason,
  };

  const p = newest(t.placement);
  const placement: Placement | undefined = p && {
    job: p.job,
    nodes: [...p.nodes],
    excluded: Object.fromEntries(p.excludedReasons.map((r, i) => [r, p.excludedCounts[i] ?? 0])),
    reason: p.reason,
  };
  const used = newest(t.placement.filter((x) => x.used));

  const jobRow = t.job.find((j) => j.id === 'job-train-1') ?? t.job[0];
  const job: JobStatus = jobRow
    ? {
        id: jobRow.id,
        status: jobRow.status === 'running' ? 'running' : jobRow.status === 'finished' ? 'finished' : 'stopped',
        nodes: jobRow.nodes,
        restarts: jobRow.restarts,
        crashes: jobRow.crashes,
      }
    : { id: 'job-train-1', status: 'stopped', nodes: 0, restarts: 0, crashes: 0 };

  return {
    now: t.clock[0]?.nowMin ?? 0,
    partState,
    nodeState,
    owner,
    leases: t.work.filter((w) => w.status === 'granted' || w.status === 'active').sort(byId).map(toLease),
    margins,
    diagnosis,
    placement,
    placed: used ? [...used.nodes] : [],
    job,
    deniedRequests: t.work.filter((w) => w.status === 'denied').length,
    work: toWorkItems(t.work, t.assignment ?? []),
  };
}

export function toFocus(kind: string, ids: string[], parts: string[] = []): FocusTarget {
  if ((kind === 'rack' || kind === 'node' || kind === 'part') && ids[0]) return { kind, id: ids[0] };
  if (kind === 'racks') return parts.length ? { kind: 'racks', ids: [...ids], parts: [...parts] } : { kind: 'racks', ids: [...ids] };
  return { kind: 'overview' };
}

/** Newest first, like the mock feed. */
export function toEvents(rows: DecisionRow[]): DecisionEvent[] {
  return [...rows]
    .sort((a, b) => (a.seq < b.seq ? 1 : a.seq > b.seq ? -1 : 0))
    .map((e) => ({
      seq: Number(e.seq),
      time: e.atMin,
      actor: e.actor,
      actorKind: ACTOR_KINDS.includes(e.actorKind as ActorKind) ? (e.actorKind as ActorKind) : 'facility',
      title: e.title,
      verdict: VERDICTS.includes(e.verdict as Verdict) ? (e.verdict as Verdict) : 'info',
      reason: e.reason,
      focus: toFocus(e.focusKind, e.focusIds, e.focusParts),
      type: e.type,
      subject: e.subject,
      data: e.data,
    }));
}

export interface ScenarioView {
  mode: Mode;
  bed: string;
  stepIndex: number;
  total: number;
  caption: string;
  camera: FocusTarget;
  version: number;
}

export function toScenario(row: ScenarioRow | undefined): ScenarioView {
  return {
    mode: row && (MODES as readonly string[]).includes(row.mode) ? (row.mode as Mode) : 'squawk',
    bed: row?.bed ?? 'demo',
    stepIndex: row?.step ?? -1,
    total: row?.total ?? 0,
    caption: row?.caption ?? '',
    camera: row ? toFocus(row.cameraKind, row.cameraIds, row.cameraParts) : { kind: 'overview' },
    version: row?.version ?? 0,
  };
}
