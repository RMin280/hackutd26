// What each kind of work touches (DESIGN.md §4.4). Every request names one of
// these kinds; its scope decides which locks it claims and what it takes offline.
//
//   Hardware: a node, a rack, a whole hot aisle, or a facility part (and everything below it).
//   Software: "online" runs alongside HPC jobs; "drain-required" needs the nodes to itself.

import type { PartType, Role } from './types';

export type WorkKind =
  | 'node_repair'
  | 'rack_work'
  | 'hot_aisle_work'
  | 'facility_work'
  | 'switch_firmware'
  | 'sw_online'
  | 'sw_exclusive';

export type TargetKind = 'node' | 'rack' | 'row' | 'aisle' | 'part' | 'job';

export interface WorkSpec {
  kind: WorkKind;
  category: 'hardware' | 'software';
  title: string; // "Maintenance on CDU-4", "Online update on rack-r3-07"
  examples: string;
  scope: 'node' | 'rack' | 'hot_aisle' | 'part' | 'nodes';
  targets: TargetKind[];
  partTypes?: PartType[];
  /** Hands-on space it locks exclusively; a bigger space covers everything inside it. */
  space: 'node' | 'rack' | 'aisle' | null;
  /** Locks the nodes' service (what runs on them). All maintenance on a node is one at a time. */
  locksNodes: boolean;
  /** true: may run while jobs run on its nodes. false: the nodes must be drained first. */
  withJobs: boolean;
  /** Takes the target's nodes offline (they show as maintenance while it runs). */
  nodesOffline: boolean;
  /** Takes the target part offline: racks below it lose that feed. */
  partOffline: boolean;
  /** Opens a hot aisle's containment: every rack in it loses one cooling feed's worth of headroom. */
  coolingHit: boolean;
  defaultMin: number;
  send: string;
}

const ALL_PARTS: PartType[] = ['utility', 'switchgear', 'ups', 'pdu', 'chiller', 'cdu', 'spine', 'leaf'];
export const NETWORK_PARTS: PartType[] = ['leaf', 'spine'];
export const COOLING_PARTS: PartType[] = ['chiller', 'cdu'];

export const CATALOG: Record<WorkKind, WorkSpec> = {
  node_repair: {
    kind: 'node_repair',
    category: 'hardware',
    title: 'Hardware repair',
    examples: 'GPU, DIMM, NVMe, NIC or PSU swap in one node',
    scope: 'node',
    targets: ['node'],
    space: 'node',
    locksNodes: true,
    withJobs: false,
    nodesOffline: true,
    partOffline: false,
    coolingHit: false,
    defaultMin: 120,
    send: 'hardware tech',
  },
  rack_work: {
    kind: 'rack_work',
    category: 'hardware',
    title: 'Rack work',
    examples: 'rack power strip, top-of-rack cabling, rear-door heat exchanger, full rack power-down',
    scope: 'rack',
    targets: ['rack'],
    space: 'rack',
    locksNodes: true,
    withJobs: false,
    nodesOffline: true,
    partOffline: false,
    coolingHit: false,
    defaultMin: 240,
    send: 'hardware tech',
  },
  hot_aisle_work: {
    kind: 'hot_aisle_work',
    category: 'hardware',
    title: 'Hot-aisle work',
    examples: 'containment door or roof panel, overhead busway, in-aisle sensors (both rows keep running)',
    scope: 'hot_aisle',
    targets: ['aisle'],
    space: 'aisle',
    locksNodes: false,
    withJobs: true,
    nodesOffline: false,
    partOffline: false,
    coolingHit: true,
    defaultMin: 180,
    send: 'mechanical tech',
  },
  facility_work: {
    kind: 'facility_work',
    category: 'hardware',
    title: 'Maintenance',
    examples: 'CDU, chiller, PDU, UPS, switchgear or utility service; leaf or spine switch swap',
    scope: 'part',
    targets: ['part'],
    partTypes: ALL_PARTS,
    space: null,
    locksNodes: false, // network parts lock the nodes below them (see footprint.ts)
    withJobs: true, // power/cooling work keeps nodes up; the backup check decides
    nodesOffline: false,
    partOffline: true,
    coolingHit: false,
    defaultMin: 240,
    send: 'facility tech',
  },
  switch_firmware: {
    kind: 'switch_firmware',
    category: 'software',
    title: 'Switch firmware',
    examples: 'leaf or spine OS upgrade; the switch reboots and every node below it is unreachable',
    scope: 'part',
    targets: ['part'],
    partTypes: NETWORK_PARTS,
    space: null,
    locksNodes: true,
    withJobs: false,
    nodesOffline: false,
    partOffline: true,
    coolingHit: false,
    defaultMin: 60,
    send: 'network engineer',
  },
  sw_online: {
    kind: 'sw_online',
    category: 'software',
    title: 'Online update',
    examples: 'monitoring agent, live kernel patch, firmware staged for the next reboot',
    scope: 'nodes',
    targets: ['node', 'rack', 'row', 'job'],
    space: null,
    locksNodes: true,
    withJobs: true,
    nodesOffline: false,
    partOffline: false,
    coolingHit: false,
    defaultMin: 30,
    send: 'automation',
  },
  sw_exclusive: {
    kind: 'sw_exclusive',
    category: 'software',
    title: 'Drain-required update',
    examples: 'OS or kernel upgrade with reboot, GPU driver / CUDA, BIOS, BMC or NIC firmware',
    scope: 'nodes',
    targets: ['node', 'rack', 'row'],
    space: null,
    locksNodes: true,
    withJobs: false,
    nodesOffline: true,
    partOffline: false,
    coolingHit: false,
    defaultMin: 90,
    send: 'automation',
  },
};

export const WORK_KINDS = Object.keys(CATALOG) as WorkKind[];
export const isWorkKind = (k: string): k is WorkKind => k in CATALOG;

/** Who goes for facility work, by part type (DESIGN.md §5: hardcoded in Iteration 1). */
export const SEND_BY_PART: Record<PartType, string> = {
  cdu: 'mechanical tech',
  chiller: 'mechanical tech',
  pdu: 'electrical tech',
  ups: 'electrical tech',
  switchgear: 'electrical tech',
  utility: 'electrical tech',
  leaf: 'network engineer',
  spine: 'network engineer',
};

// ---- roles (DESIGN.md §9)

export const CAN_REQUEST: Record<Role, WorkKind[]> = {
  admin: WORK_KINDS,
  shift_lead: WORK_KINDS,
  technician: WORK_KINDS,
  scheduler_agent: ['sw_online', 'sw_exclusive'],
  cooling_agent: ['facility_work'],
  facility: [],
  viewer: [],
};

/** Extra limit on part types for roles that may only touch one system. */
export const PART_TYPES_FOR_ROLE: Partial<Record<Role, PartType[]>> = {
  cooling_agent: COOLING_PARTS,
};

export type Action =
  | 'approve'
  | 'set_state'
  | 'report_failure'
  | 'diagnose'
  | 'placement'
  | 'restart'
  | 'protect'
  | 'clock'
  | 'present'
  | 'admin';

export const CAN_DO: Record<Action, Role[]> = {
  approve: ['shift_lead', 'admin'],
  set_state: ['facility', 'shift_lead', 'admin'],
  report_failure: ['scheduler_agent', 'facility', 'shift_lead', 'admin'],
  diagnose: ['scheduler_agent', 'technician', 'shift_lead', 'admin'],
  placement: ['scheduler_agent', 'shift_lead', 'admin'],
  restart: ['scheduler_agent', 'shift_lead', 'admin'],
  protect: ['scheduler_agent', 'shift_lead', 'admin'],
  clock: ['shift_lead', 'admin'],
  present: ['shift_lead', 'admin'],
  admin: ['admin'],
};

/** Decision-feed icon for each role (frontend ActorKind has four kinds). */
export const ACTOR_KIND: Record<Role, 'facility' | 'scheduler' | 'cooling' | 'blast_radius'> = {
  admin: 'facility',
  shift_lead: 'facility',
  technician: 'facility',
  scheduler_agent: 'scheduler',
  cooling_agent: 'cooling',
  facility: 'facility',
  viewer: 'facility',
};
