// Row shapes shared by the core logic and the SpacetimeDB tables in ../index.ts.
// They mirror the table columns one to one, so the adapter passes rows straight
// through. Times are simulated minutes since T+0 (never wall-clock time).
// Ids that come from auto-increment columns are bigint; 0n means "none".

export type PartType = 'utility' | 'switchgear' | 'ups' | 'pdu' | 'chiller' | 'cdu' | 'spine' | 'leaf';
export const PART_TYPES: readonly PartType[] = ['utility', 'switchgear', 'ups', 'pdu', 'chiller', 'cdu', 'spine', 'leaf'];

/** Physical health. "maintenance" is not stored here: it is derived from `heldBy`. */
export type Health = 'ok' | 'degraded' | 'failed';
export const HEALTH: readonly Health[] = ['ok', 'degraded', 'failed'];

export type OwnerKind = 'job' | 'tenant' | 'free';
export type MarginLevel = 'green' | 'yellow' | 'red';
export type Verdict = 'allow' | 'warn' | 'deny';

export type WorkStatus =
  | 'simulated' // dry run: verdict only, nothing claimed
  | 'denied'
  | 'needs_approval' // warn: waits for a shift lead, claims nothing yet
  | 'granted' // approved, window starts later
  | 'active' // window is running; its claims and effects are live
  | 'done' // window ended or released early
  | 'cancelled'
  | 'rejected'
  | 'expired'; // approval came after the window closed

export const LIVE_STATUSES: readonly WorkStatus[] = ['granted', 'active'];

export type Role =
  | 'admin'
  | 'shift_lead'
  | 'technician'
  | 'scheduler_agent'
  | 'cooling_agent'
  | 'remediation_agent' // the Nemotron fixer (DESIGN.md §8.2)
  | 'update_agent' // the Nemotron update agent: software patches only (agents/patch)
  | 'facility'
  | 'viewer';
export const ROLES: readonly Role[] = [
  'admin',
  'shift_lead',
  'technician',
  'scheduler_agent',
  'cooling_agent',
  'remediation_agent',
  'update_agent',
  'facility',
  'viewer',
];

/** Matches `ActorKind` in frontend/src/model/types.ts so the decision feed can render it. */
export type ActorKind = 'facility' | 'scheduler' | 'cooling' | 'fixer' | 'updater' | 'squawk';

/** Matches `Verdict` in frontend/src/model/types.ts (the decision feed's badge). */
export type FeedVerdict =
  | 'allow'
  | 'warn'
  | 'deny'
  | 'failure'
  | 'shared_cause'
  | 'isolated'
  | 'placement'
  | 'info'
  | 'plan' // an agent wrote its plan
  | 'fixed' // an agent finished an issue
  | 'handoff'; // an agent handed an issue to a person or another agent

/** What a decision row is about (DESIGN.md §4.3). Agents triage on this, the view maps it to a look. */
export type EventType =
  | 'seed'
  | 'state_change'
  | 'diagnosis'
  | 'placement'
  | 'simulated'
  | 'lease_granted'
  | 'lease_denied'
  | 'approval_requested'
  | 'lease_started'
  | 'lease_released'
  | 'lease_expired'
  | 'job_status'
  | 'work_accepted' // a worker took a lease on (the work board)
  | 'work_completed' // the worker finished early: target repaired where it was unhealthy, claims released
  | AgentEventType;

/** Rows an agent may write itself through record_event. */
export type AgentEventType = 'agent_plan' | 'agent_step' | 'agent' | 'tech_dispatched' | 'notified' | 'escalated';
export const AGENT_EVENT_TYPES: readonly AgentEventType[] = ['agent_plan', 'agent_step', 'agent', 'tech_dispatched', 'notified', 'escalated'];

export interface PartRow {
  id: string;
  type: string;
  rowNum: number; // 0 = central plant (no row)
  ord: number;
  state: string; // Health
  heldBy: bigint; // active work holding it offline, 0n = none
}

export interface AisleRow {
  id: string; // ha-1 .. ha-5
  kind: string; // 'hot'
  rows: number[]; // the two rows that exhaust into it
  ord: number;
  heldBy: bigint; // active hot-aisle work, 0n = none
}

export interface RackRow {
  id: string;
  rowNum: number;
  pos: number; // 1..16 within the row
  aisle: string; // hot aisle it exhausts into
  ord: number;
  powerFeeds: string[][]; // upstream chains, nearest part first
  coolingFeeds: string[][];
  network: string[]; // [leaf, spine]
  nodes: string[];
}

export interface NodeRow {
  id: string;
  rack: string;
  rowNum: number;
  slot: number; // 0..7, bottom to top
  ord: number;
  state: string; // Health
  ownerKind: string; // OwnerKind
  ownerId: string; // job or tenant id, '' when free
  heldBy: bigint; // active work holding it offline, 0n = none
}

export interface DownstreamRow {
  id: bigint;
  part: string;
  rack: string;
}

/** Current backup per rack (DESIGN.md §3.2). The view renders this; it computes nothing. */
export interface MarginRow {
  rack: string;
  power: number; // working power feeds - 1
  cooling: number; // working cooling feeds - 1 - open hot aisle
  margin: number; // min(power, cooling)
  level: string; // MarginLevel
  unprotected: string[]; // parts on the single working feed
  protectedBy: bigint; // protection work id, 0n = none
  protectedJob: string;
  protectedUntil: number; // -1 = not protected
}

export interface JobRow {
  id: string;
  status: string; // 'running' | 'stopped' | 'finished'
  size: number; // nodes the job needs
  nodes: number; // nodes it holds now
  restarts: number;
  crashes: number;
}

/** One row per request, from dry run to finished lease. Live leases are rows in `granted`/`active`. */
export interface WorkRow {
  id: bigint;
  ticket: string; // caller-chosen id so an agent can find its own result
  kind: string; // WorkKind or 'protection'
  category: string; // 'hardware' | 'software' | 'protection'
  scope: string; // 'node' | 'rack' | 'hot_aisle' | 'part' | 'nodes' | 'job_racks'
  mode: string; // 'exclusive' | 'online' | 'shared'
  targetKind: string; // 'node' | 'rack' | 'row' | 'aisle' | 'part' | 'job'
  target: string;
  targetLabel: string;
  actor: string;
  actorRole: string;
  actorIdentity: string;
  requestedAt: number;
  startMin: number;
  endMin: number;
  status: string; // WorkStatus
  verdict: string; // Verdict
  reason: string;
  earliestSafe: string; // '' when not denied
  earliestSafeMin: number; // -1 = unknown or not applicable
  blockers: string[]; // '#12', 'cdu-3', 'job-train-1', ...
  racks: string[]; // protection: racks protected; maintenance: racks whose backup drops
  job: string; // protection: the job
  offlineParts: string[];
  offlineNodes: string[];
  nodeCount: number; // nodes the work touches
  approvedBy: string;
  routine: boolean; // routine work: an agent may queue a refusal and rebook it when the blockers clear
  note: string; // free text from the requester; data only, never feeds a verdict
  bookedBy: string; // actor who booked it on the requester's behalf ('' = the requester)
}

/** Who is doing a piece of work (the work board). One row per work id, written by
 *  accept_work / complete_work; the lease itself stays in `work`. Protection leases have none. */
export interface AssignmentRow {
  work: bigint;
  assignee: string; // actor name (names are how actors appear everywhere in the feed)
  assigneeRole: string;
  acceptedAt: number; // simulated minute, -1 = never accepted
  completedBy: string; // '' until completed
  completedAt: number; // -1 until completed
  repaired: string[]; // targets marked ok on completion (the failed node, the degraded CDU)
  note: string; // completion note, data only
}

/** A lock held by live work (DESIGN.md §4.4). Modes: X exclusive, S shared, I intent. */
export interface ClaimRow {
  id: bigint;
  work: bigint;
  resource: string; // 'aisle:ha-1' | 'rack:rack-r1-12' | 'node:node-417' | 'svc:node-417' | 'part:cdu-4'
  mode: string;
  startMin: number;
  endMin: number;
}

export interface FailureRow {
  id: bigint;
  node: string;
  atMin: number;
}

export interface DiagnosisRow {
  id: bigint;
  atMin: number;
  job: string;
  nodes: string[]; // failed nodes diagnosed
  classification: string; // 'shared_cause' | 'isolated'
  cause: string; // '' when isolated
  atRisk: string[];
  send: string;
  reason: string;
}

export interface PlacementRow {
  id: bigint;
  atMin: number;
  job: string;
  needed: number;
  durationMin: number;
  exclude: string[]; // nodes the job should leave (failed + at risk)
  nodes: string[];
  excludedReasons: string[];
  excludedCounts: number[];
  shortfall: number;
  reason: string;
  used: boolean;
}

/** The decision feed (frontend DecisionEvent), and the one event feed agents read by `seq`. */
export interface DecisionRow {
  seq: bigint;
  atMin: number;
  actor: string;
  actorKind: string; // ActorKind
  actorRole: string;
  title: string;
  verdict: string; // FeedVerdict
  reason: string;
  focusKind: string; // 'rack' | 'node' | 'part' | 'racks' | 'overview'
  focusIds: string[];
  focusParts: string[];
  work: bigint;
  type: string; // EventType: what happened
  subject: string; // the node, part, job or work ('#12') it is about; '' for the hall
  data: string; // JSON object with the typed fields agents read (DESIGN.md §4.3); '{}' when none
}

export interface ActorRow {
  identity: string; // hex
  name: string;
  role: string; // Role
  rows: number[]; // rows this actor may act on; empty = every row
}

export interface AuditInput {
  sim: number;
  identity: string;
  actor: string;
  action: string;
  target: string;
  verdict: string;
  reason: string;
}

export interface SettingsRow {
  id: number;
  openRegistration: boolean;
  failureWindowMin: number;
}

/** The presenter's scenario (one row, id 0). The view reads its caption and camera. */
export interface ScenarioRow {
  id: number;
  mode: string; // 'naive' | 'squawk'
  bed: string; // what the hall holds: 'demo' (scenario), 'lab' (diagnostics test bed), 'scale'
  step: number; // -1 = ready, before the first step
  total: number;
  title: string;
  caption: string;
  cameraKind: string; // 'overview' | 'rack' | 'node' | 'part' | 'racks'
  cameraIds: string[];
  cameraParts: string[];
  diagnosisId: bigint;
  placementId: bigint;
  version: number; // bumps on every change so the view knows to move the camera
}

/** A seeded test case for diagnostic agents, with the answer the deterministic engine gives.
 *  Private table: an agent connected with its own identity sees the failures, not the answers. */
export interface IncidentRow {
  id: number;
  title: string;
  kind: string; // 'cooling' | 'power' | 'network' | 'isolated' | ...
  nodes: string[]; // failed nodes to diagnose
  parts: string[]; // parts the case marked degraded or failed
  atMin: number; // when its last failure happened
  expectClassification: string;
  expectCause: string;
  expectSend: string;
  note: string;
}

/** Everything needed to build a facility: the output of the site generator. */
export interface SiteData {
  parts: PartRow[];
  aisles: AisleRow[];
  racks: RackRow[];
  nodes: NodeRow[];
  downstream: { part: string; rack: string }[];
  jobs: JobRow[];
}

/** Thrown for a bad request: unknown identity, wrong role, unknown target. The reducer
 *  layer turns it into SpacetimeDB's SenderError so the transaction rolls back. */
export class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestError';
  }
}
