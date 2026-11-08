// Shapes the control-room view consumes. The mock backend (src/mock) produces
// them today; the SpacetimeDB backend should produce the same shapes later.

export type PartType =
  | 'utility'
  | 'switchgear'
  | 'ups'
  | 'pdu'
  | 'chiller'
  | 'cdu'
  | 'spine'
  | 'leaf';

export type PartState = 'ok' | 'degraded' | 'failed' | 'maintenance';

export interface Part {
  id: string;
  type: PartType;
  row?: number;
}

export interface Rack {
  id: string;
  row: number;
  pos: number; // 1..16 within the row
  powerFeeds: string[][]; // upstream chains, nearest part first
  coolingFeeds: string[][];
  network: string[]; // [leaf, spine]
  nodes: string[];
}

export interface NodeInfo {
  id: string;
  rack: string;
  row: number;
  slot: number; // 0..7, bottom to top
}

export interface Site {
  parts: Record<string, Part>;
  partOrder: string[];
  racks: Record<string, Rack>;
  rackOrder: string[];
  nodes: Record<string, NodeInfo>;
  nodeOrder: string[];
  downstream: Record<string, string[]>; // part id -> rack ids below it
}

export type Owner =
  | { kind: 'job'; id: string }
  | { kind: 'tenant'; id: string }
  | { kind: 'free' };

export type MarginLevel = 'green' | 'yellow' | 'red';

export interface Margin {
  power: number;
  cooling: number;
  margin: number;
  level: MarginLevel;
  unprotected: string[]; // parts on the single working feed (yellow racks)
}

export interface Lease {
  id: string;
  type: 'maintenance' | 'protection';
  actor: string;
  target?: string; // part taken offline (maintenance)
  racks?: string[]; // racks protected (protection)
  job?: string;
  start: number; // simulated minutes
  end: number;
}

/** A request's life on the backend (spacetimedb/src/core/types.ts WorkStatus). */
export type WorkStatus = 'simulated' | 'denied' | 'needs_approval' | 'granted' | 'active' | 'done' | 'cancelled' | 'rejected' | 'expired';

/**
 * One request as the backend keeps it, every status included (the work board reads these;
 * `World.leases` is the live subset the hall draws). Live mode only: the mock has no work table.
 */
export interface WorkItem {
  id: string;
  ticket: string;
  kind: string; // node_repair | rack_work | hot_aisle_work | facility_work | switch_firmware | sw_online | sw_exclusive | protection
  category: 'hardware' | 'software' | 'protection';
  targetKind: string; // node | rack | row | aisle | part | job
  target: string;
  targetLabel: string;
  actor: string; // the requester (holder)
  actorRole: string;
  bookedBy?: string; // who booked it on the requester's behalf
  requestedAt: number;
  start: number;
  end: number;
  status: WorkStatus;
  verdict: 'allow' | 'warn' | 'deny';
  reason: string;
  earliestSafe?: string;
  blockers: string[];
  racks: string[];
  job?: string;
  nodeCount: number;
  approvedBy?: string;
  routine: boolean;
  note?: string;
  // The work board's bookkeeping (assignment table): who took it on, who finished it.
  assignee?: string;
  assigneeRole?: string;
  acceptedAt?: number;
  completedBy?: string;
  completedAt?: number;
  repaired?: string[];
  completionNote?: string;
}

export interface Diagnosis {
  node: string;
  classification: 'shared_cause' | 'isolated';
  cause?: string;
  atRisk: string[];
  send: string;
  reason: string;
}

export interface Placement {
  job: string;
  nodes: string[];
  excluded: Record<string, number>;
  reason: string;
}

export type Verdict =
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

export type FocusTarget =
  | { kind: 'rack'; id: string }
  | { kind: 'node'; id: string }
  | { kind: 'part'; id: string }
  | { kind: 'racks'; ids: string[]; parts?: string[] }
  | { kind: 'overview' };

export type ActorKind = 'facility' | 'scheduler' | 'cooling' | 'fixer' | 'updater' | 'squawk';

export interface DecisionEvent {
  seq: number;
  time: number; // simulated minutes since T+0
  actor: string;
  actorKind: ActorKind;
  title: string;
  verdict: Verdict;
  reason: string;
  focus: FocusTarget;
  type?: string; // what happened (backend EventType); the mock leaves it unset
  subject?: string; // the node, part, job or work it is about
  data?: string; // the backend's JSON fields for the row (agents read them; the work board reads an agent's status)
}

export interface JobStatus {
  id: string;
  status: 'running' | 'stopped' | 'finished';
  nodes: number;
  restarts: number;
  crashes: number;
}

export interface World {
  now: number;
  partState: Record<string, PartState>;
  nodeState: Record<string, PartState>;
  owner: Record<string, Owner>;
  leases: Lease[];
  margins: Record<string, Margin>;
  diagnosis?: Diagnosis;
  placement?: Placement;
  placed: string[]; // nodes added to the job by the last restart
  job: JobStatus;
  deniedRequests: number;
  /** Every request the backend holds, for the work board. Unset on the mock. */
  work?: WorkItem[];
}

export type Selection =
  | { kind: 'rack'; id: string }
  | { kind: 'node'; id: string }
  | { kind: 'part'; id: string };
