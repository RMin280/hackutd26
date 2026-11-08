// What the floor sees: the work board's pure logic. No React, no three.js, and nothing decides
// here. Verdicts, statuses and assignments arrive computed by the backend; this file only sorts
// them into the lanes a worker reads and names the trade each piece of work calls for.
// Tested in ../../../../spacetimedb/test/view-board.test.ts.

import type { DecisionEvent, PartType, Site, WorkItem, World } from '../../model/types';

// ---------------------------------------------------------------- trade and level

export type Level = 'L1' | 'L2' | 'L3';

export interface Trade {
  trade: string;
  level: Level;
}

/**
 * Trade and level per kind of work: a presentation table, DESIGN.md §10.1. It mirrors the
 * backend's `send` per kind (catalog.ts, SEND_BY_PART for facility work). L1: any tech on shift.
 * L2: the trade's own tech. L3: senior or licensed (switchgear, utility, UPS, spines). The
 * risk-aware allocator (Iteration 3, roadmap) would score people instead; until then the board
 * says what the work needs and people take it on themselves.
 */
export const TRADES: readonly string[] = ['hardware tech', 'mechanical tech', 'electrical tech', 'network engineer', 'automation'];

const BY_KIND: Record<string, Trade> = {
  node_repair: { trade: 'hardware tech', level: 'L1' },
  rack_work: { trade: 'hardware tech', level: 'L2' },
  hot_aisle_work: { trade: 'mechanical tech', level: 'L2' },
  sw_online: { trade: 'automation', level: 'L1' },
  sw_exclusive: { trade: 'automation', level: 'L1' },
};

const BY_PART: Record<PartType, Trade> = {
  cdu: { trade: 'mechanical tech', level: 'L2' },
  chiller: { trade: 'mechanical tech', level: 'L2' },
  pdu: { trade: 'electrical tech', level: 'L2' },
  ups: { trade: 'electrical tech', level: 'L3' },
  switchgear: { trade: 'electrical tech', level: 'L3' },
  utility: { trade: 'electrical tech', level: 'L3' },
  leaf: { trade: 'network engineer', level: 'L2' },
  spine: { trade: 'network engineer', level: 'L3' },
};

/** The trade a piece of work calls for; none for a protection lease (the scheduler's, not a person's). */
export function tradeFor(item: Pick<WorkItem, 'kind' | 'targetKind' | 'target'>, site: Site): Trade | undefined {
  if (item.kind === 'protection') return undefined;
  if (item.kind === 'facility_work' || item.kind === 'switch_firmware') {
    const type = site.parts[item.target]?.type;
    if (type) return BY_PART[type];
    return { trade: item.kind === 'switch_firmware' ? 'network engineer' : 'facility tech', level: 'L2' };
  }
  return BY_KIND[item.kind] ?? { trade: 'tech', level: 'L1' };
}

// ---------------------------------------------------------------- lanes

export type Lane = 'active' | 'booked' | 'approval' | 'refused' | 'done';
export const LANES: readonly Lane[] = ['active', 'booked', 'approval', 'refused', 'done'];

export const LANE_TITLE: Record<Lane, string> = {
  active: 'Active now',
  booked: 'Booked',
  approval: 'Needs approval',
  refused: 'Refused',
  done: 'Done',
};

/** Which lane a request sits in; none for dry runs and protection leases (those are locks, below). */
export function laneOf(item: Pick<WorkItem, 'kind' | 'status'>): Lane | null {
  if (item.kind === 'protection') return null;
  switch (item.status) {
    case 'active':
      return 'active';
    case 'granted':
      return 'booked';
    case 'needs_approval':
      return 'approval';
    case 'denied':
    case 'rejected':
      return 'refused';
    case 'done':
    case 'cancelled':
    case 'expired':
      return 'done';
    default:
      return null; // simulated
  }
}

export const DONE_SHOWN = 12;

/** The work sorted into lanes, newest first where the past is shown and soonest first where the future is. */
export function groupWork(items: readonly WorkItem[], site: Site, filter = 'all'): Record<Lane, WorkItem[]> {
  const out: Record<Lane, WorkItem[]> = { active: [], booked: [], approval: [], refused: [], done: [] };
  for (const item of items) {
    const lane = laneOf(item);
    if (!lane) continue;
    if (filter !== 'all' && tradeFor(item, site)?.trade !== filter) continue;
    out[lane].push(item);
  }
  const id = (x: WorkItem) => Number(x.id);
  out.active.sort((a, b) => a.end - b.end || id(a) - id(b));
  out.booked.sort((a, b) => a.start - b.start || id(a) - id(b));
  out.approval.sort((a, b) => a.requestedAt - b.requestedAt || id(a) - id(b));
  out.refused.sort((a, b) => id(b) - id(a));
  out.done.sort((a, b) => (b.completedAt ?? b.end) - (a.completedAt ?? a.end) || id(b) - id(a));
  out.done = out.done.slice(0, DONE_SHOWN);
  return out;
}

// ---------------------------------------------------------------- locks

export interface LockView {
  id: string;
  job: string;
  holder: string;
  racks: string[];
  rows: number[];
  until: number;
}

/** Protection leases still running: the racks nobody may cut the backup of, and until when. */
export function locks(world: Pick<World, 'leases' | 'now'>, site: Site): LockView[] {
  return world.leases
    .filter((l) => l.type === 'protection' && world.now < l.end)
    .map((l) => {
      const racks = [...(l.racks ?? [])];
      const rows = [...new Set(racks.map((r) => site.racks[r]?.row).filter((r): r is number => typeof r === 'number'))].sort((a, b) => a - b);
      return { id: l.id, job: l.job ?? '', holder: l.actor, racks, rows, until: l.end };
    })
    .sort((a, b) => a.until - b.until);
}

/** The racks a piece of work touches: what the backend recorded, or the target's own rack. */
export function racksOf(item: Pick<WorkItem, 'racks' | 'targetKind' | 'target'>, site: Site): string[] {
  if (item.racks.length) return item.racks;
  if (item.targetKind === 'rack') return [item.target];
  if (item.targetKind === 'node') {
    const rack = site.nodes[item.target]?.rack;
    return rack ? [rack] : [];
  }
  if (item.targetKind === 'part') return site.downstream[item.target] ?? [];
  return [];
}

/** The protection lock, if any, over the racks this work touches: "locked for job-train-1 until T+72h". */
export function lockOn(item: Pick<WorkItem, 'racks' | 'targetKind' | 'target' | 'kind'>, world: Pick<World, 'leases' | 'now'>, site: Site): LockView | undefined {
  if (item.kind === 'protection') return undefined;
  const mine = new Set(racksOf(item, site));
  if (mine.size === 0) return undefined;
  return locks(world, site).find((l) => l.racks.some((r) => mine.has(r)));
}

// ---------------------------------------------------------------- agents

export type AgentState = 'working' | 'waiting' | 'fixed' | 'handoff' | 'stopped' | 'idle';

export interface AgentCard {
  actor: string;
  kind: DecisionEvent['actorKind'];
  state: AgentState;
  /** What the newest row is about (a node, a part, a job), when it names one. */
  subject?: string;
  lastTitle: string;
  lastSeen: number; // simulated minutes
  rows: number;
  fixed: number;
  handoffs: number;
}

const AGENT_KINDS: readonly DecisionEvent['actorKind'][] = ['fixer', 'updater', 'scheduler', 'cooling'];

function dataOf(e: DecisionEvent): Record<string, unknown> {
  if (!e.data) return {};
  try {
    const parsed: unknown = JSON.parse(e.data);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** An agent's state from its newest `agent` row (the fixer's status word), else from the verdict. */
function stateOf(e: DecisionEvent): AgentState | null {
  if (e.type === 'agent') {
    const status = dataOf(e).status;
    if (status === 'fixed') return 'fixed';
    if (status === 'handed_off') return 'handoff';
    if (status === 'failed_closed') return 'stopped';
    if (status === 'waiting') return 'waiting';
    if (status === 'started') return 'working';
    return e.verdict === 'fixed' ? 'fixed' : e.verdict === 'handoff' ? 'handoff' : e.verdict === 'warn' ? 'stopped' : 'working';
  }
  if (e.type === 'agent_plan' || e.type === 'agent_step') return 'working';
  if (e.type === 'escalated') return 'handoff';
  return null;
}

/**
 * One card per agent seen in the feed (newest first, as the store keeps it): what it is doing now,
 * what it last did and when. "Last seen" is a time, never a judgment about whether it is alive.
 */
export function agentCards(events: readonly DecisionEvent[]): AgentCard[] {
  const cards = new Map<string, AgentCard>();
  for (const e of events) {
    if (!AGENT_KINDS.includes(e.actorKind)) continue;
    let card = cards.get(e.actor);
    if (!card) {
      card = { actor: e.actor, kind: e.actorKind, state: 'idle', subject: e.subject || undefined, lastTitle: e.title, lastSeen: e.time, rows: 0, fixed: 0, handoffs: 0 };
      // The newest row with a readable state sets the card's state; a lease request is just "working".
      const st = stateOf(e) ?? (e.type?.startsWith('lease_') || e.type === 'approval_requested' ? 'working' : null);
      if (st) card.state = st;
      cards.set(e.actor, card);
    }
    card.rows++;
    if (e.verdict === 'fixed') card.fixed++;
    if (e.verdict === 'handoff') card.handoffs++;
  }
  return [...cards.values()].sort((a, b) => b.lastSeen - a.lastSeen || a.actor.localeCompare(b.actor));
}

// ---------------------------------------------------------------- the mock

/**
 * Offline the mock has no work table: the leases it does have become items so the board still reads.
 * No verdict text, no bookkeeping; the live view fills those in.
 */
export function mockWorkItems(world: Pick<World, 'leases' | 'now'>, site: Site): WorkItem[] {
  return world.leases.map((l) => {
    const protection = l.type === 'protection';
    const target = l.target ?? l.job ?? '';
    const targetKind = protection ? 'job' : site.parts[target] ? 'part' : site.nodes[target] ? 'node' : site.racks[target] ? 'rack' : 'part';
    return {
      id: l.id,
      ticket: '',
      kind: protection ? 'protection' : targetKind === 'node' ? 'node_repair' : targetKind === 'rack' ? 'rack_work' : 'facility_work',
      category: protection ? 'protection' : 'hardware',
      targetKind,
      target,
      targetLabel: target,
      actor: l.actor,
      actorRole: '',
      requestedAt: l.start,
      start: l.start,
      end: l.end,
      status: world.now < l.start ? 'granted' : world.now < l.end ? 'active' : 'done',
      verdict: 'allow',
      reason: '',
      blockers: [],
      racks: [...(l.racks ?? [])],
      job: l.job,
      nodeCount: 0,
      routine: false,
    };
  });
}
