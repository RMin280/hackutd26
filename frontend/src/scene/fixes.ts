// Which software fixes the Nemotron agents are doing right now, from the decision feed: the
// fixer's (one issue per subject) and the update agent's (one advisory per subject, rolled out
// in waves). Hardware goes to the tech gull (tech_dispatched, and anything failed or degraded);
// everything else an agent writes about an issue (its plan, each step, its status, a hand-off)
// is a software fix, and the view shows it as a popup over what it's about (FixerPopups.tsx).
//
// Pure: no React, no three.js. The view only renders the agents' own rows; nothing here decides.

import type { ActorKind, DecisionEvent, FocusTarget } from '../model/types';
import { modelOf, saidOf, thinkingOf } from '../ui/format';

/** The agents' rows that belong to a software fix. */
export const SOFTWARE_FIX_TYPES: readonly string[] = ['agent_plan', 'agent_step', 'agent', 'notified', 'escalated'];

/** The update agent's own bookings: they join the advisory it is working on and move its popup there. */
const WAVE_TYPES: readonly string[] = ['lease_granted', 'lease_denied', 'approval_requested'];

export type FixAgent = Extract<ActorKind, 'fixer' | 'updater'>;
const AGENTS: readonly string[] = ['fixer', 'updater'];

/** waiting: the update agent booked a wave and checks the next one once its windows end. */
export type FixStatus = 'working' | 'waiting' | 'fixed' | 'handoff' | 'stopped';

export interface FixLine {
  seq: number;
  text: string;
  /** The row's reason, when it says more than the title: the model's words on its plan and its
   * outcome, Squawk's on a verdict. */
  detail?: string;
}

export interface Fix {
  /** Unique while the feed lasts: agent, subject and the seq of the fix's first row. */
  key: string;
  agent: FixAgent;
  subject: string;
  focus: FocusTarget;
  /** The last few rows, oldest first. */
  lines: FixLine[];
  status: FixStatus;
  /** The seq of its newest row. */
  last: number;
  /** Which model wrote the plan, from the plan row's data. */
  model?: string;
  /** The model's reasoning behind its newest plan or step, when its server returned any. */
  thinking?: string;
  /** What the model said in words with that reply, if anything. */
  said?: string;
}

export const MAX_LINES = 4;

const statusOf = (e: DecisionEvent): FixStatus | null =>
  e.verdict === 'fixed'
    ? 'fixed'
    : e.verdict === 'handoff'
      ? 'handoff'
      : e.type === 'agent' && e.verdict === 'warn'
        ? 'stopped'
        : e.type === 'agent' && e.title.startsWith('Waiting on ') // the backend's title for status "waiting"
          ? 'waiting'
          : null;

/** Still open: later rows on the same subject continue it. */
export const isOpen = (s: FixStatus) => s === 'working' || s === 'waiting';

/**
 * The agents' software fixes in a feed (newest first, as the store keeps it), one per agent and
 * subject, counting only rows after `afterSeq`. A row on a subject whose last fix already ended
 * starts a new one. The update agent's lease rows (about a row, node or switch, not the advisory)
 * join the advisory it last wrote about, and its popup follows them onto the hall.
 */
export function softwareFixes(events: readonly DecisionEvent[], afterSeq = 0): Fix[] {
  const open = new Map<string, Fix>();
  const current = new Map<string, Fix>(); // per actor: the fix its last own row belonged to
  const out: Fix[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.seq <= afterSeq || !AGENTS.includes(e.actorKind) || !e.type) continue;
    const agent = e.actorKind as FixAgent;

    if (WAVE_TYPES.includes(e.type)) {
      const fix = agent === 'updater' ? current.get(e.actor) : undefined;
      if (!fix || !isOpen(fix.status)) continue;
      push(fix, e);
      if (e.focus.kind !== 'overview') fix.focus = e.focus;
      continue;
    }
    if (!SOFTWARE_FIX_TYPES.includes(e.type)) continue;

    const subject = e.subject || 'the hall';
    const id = `${agent}:${subject}`;
    let fix = open.get(id);
    if (!fix || !isOpen(fix.status)) {
      fix = { key: `${id}#${e.seq}`, agent, subject, focus: e.focus, lines: [], status: 'working', last: e.seq };
      open.set(id, fix);
      out.push(fix);
    }
    push(fix, e);
    if (e.type === 'agent_plan') {
      const m = modelOf(e);
      if (m) fix.model = m;
    }
    if (e.type === 'agent_plan' || e.type === 'agent_step') {
      // Each reply's reasoning replaces the last: the popup shows what it is thinking now.
      const thinking = thinkingOf(e);
      const said = saidOf(e);
      if (thinking || said) {
        fix.thinking = thinking;
        fix.said = said;
      }
    }
    if (e.focus.kind !== 'overview') fix.focus = e.focus;
    fix.status = statusOf(e) ?? 'working';
    current.set(e.actor, fix);
  }
  return out;
}

function push(fix: Fix, e: DecisionEvent): void {
  fix.lines.push({ seq: e.seq, text: e.title, detail: detailOf(e) });
  if (fix.lines.length > MAX_LINES) fix.lines.shift();
  fix.last = e.seq;
}

/**
 * A row's reason when it adds to its title. The agents' outcome rows start with their status
 * word ("FIXED: ..."), which the popup's footer already says, so that goes; a reason the title
 * already states (a step's gist) is nothing new.
 */
export function detailOf(e: Pick<DecisionEvent, 'title' | 'reason'>): string | undefined {
  const reason = e.reason.replace(/^([A-Z][A-Z ]*|Plan): /, '').trim();
  const head = e.title.replace(/…$/, '').slice(0, 60); // a step's title is its reason, cut short
  if (!reason || !head || reason.startsWith(head) || e.title.includes(reason)) return undefined;
  return reason;
}
