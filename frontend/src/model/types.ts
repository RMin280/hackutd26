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
  | 'info';

export type FocusTarget =
  | { kind: 'rack'; id: string }
  | { kind: 'node'; id: string }
  | { kind: 'part'; id: string }
  | { kind: 'racks'; ids: string[]; parts?: string[] }
  | { kind: 'overview' };

export type ActorKind = 'facility' | 'scheduler' | 'cooling' | 'blast_radius';

export interface DecisionEvent {
  seq: number;
  time: number; // simulated minutes since T+0
  actor: string;
  actorKind: ActorKind;
  title: string;
  verdict: Verdict;
  reason: string;
  focus: FocusTarget;
}

export interface JobStatus {
  id: string;
  status: 'running' | 'stopped';
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
}

export type Selection =
  | { kind: 'rack'; id: string }
  | { kind: 'node'; id: string }
  | { kind: 'part'; id: string };
