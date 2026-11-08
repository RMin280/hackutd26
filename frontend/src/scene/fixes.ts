// Which software fixes the Nemotron fixer agent is doing right now, from the decision feed.
// Hardware goes to the tech gull (tech_dispatched, and anything failed or degraded); everything
// else the fixer writes about an issue (its plan, each step, its status, a hand-off) is a
// software fix, and the view shows it as a popup over what it's about (FixerPopups.tsx).
//
// Pure: no React, no three.js. The view only renders the agent's own rows; nothing here decides.

import type { DecisionEvent, FocusTarget } from '../model/types';

/** The fixer's rows that belong to a software fix. */
export const SOFTWARE_FIX_TYPES: readonly string[] = ['agent_plan', 'agent_step', 'agent', 'notified', 'escalated'];

export type FixStatus = 'working' | 'fixed' | 'handoff' | 'stopped';

export interface FixLine {
  seq: number;
  text: string;
}

export interface Fix {
  /** Unique while the feed lasts: subject and the seq of the fix's first row. */
  key: string;
  subject: string;
  focus: FocusTarget;
  /** The last few rows, oldest first. */
  lines: FixLine[];
  status: FixStatus;
  /** The seq of its newest row. */
  last: number;
}

export const MAX_LINES = 4;

const statusOf = (e: DecisionEvent): FixStatus | null =>
  e.verdict === 'fixed' ? 'fixed' : e.verdict === 'handoff' ? 'handoff' : e.type === 'agent' && e.verdict === 'warn' ? 'stopped' : null;

/**
 * The fixer's software fixes in a feed (newest first, as the store keeps it), one per subject,
 * counting only rows after `afterSeq`. A row on a subject whose last fix already ended starts a new one.
 */
export function softwareFixes(events: readonly DecisionEvent[], afterSeq = 0): Fix[] {
  const open = new Map<string, Fix>();
  const out: Fix[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.seq <= afterSeq || e.actorKind !== 'fixer' || !e.type || !SOFTWARE_FIX_TYPES.includes(e.type)) continue;
    const subject = e.subject || 'the hall';
    let fix = open.get(subject);
    if (!fix || fix.status !== 'working') {
      fix = { key: `${subject}#${e.seq}`, subject, focus: e.focus, lines: [], status: 'working', last: e.seq };
      open.set(subject, fix);
      out.push(fix);
    }
    fix.lines.push({ seq: e.seq, text: e.title });
    if (fix.lines.length > MAX_LINES) fix.lines.shift();
    if (e.focus.kind !== 'overview') fix.focus = e.focus;
    fix.status = statusOf(e) ?? 'working';
    fix.last = e.seq;
  }
  return out;
}
