// The view's fixer popups (frontend/src/scene/fixes.ts): which software fixes the Nemotron fixer
// is doing, grouped from its own rows in the decision feed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DecisionEvent } from '../../frontend/src/model/types';
import { MAX_LINES, softwareFixes } from '../../frontend/src/scene/fixes';

let seq = 0;
const row = (p: Partial<DecisionEvent>): DecisionEvent => ({
  seq: ++seq,
  time: 0,
  actor: 'fixer-agent',
  actorKind: 'fixer',
  title: `row ${seq}`,
  verdict: 'info',
  reason: '',
  focus: { kind: 'node', id: 'node-12' },
  type: 'agent_step',
  subject: 'node-12',
  ...p,
});
const newestFirst = (rows: DecisionEvent[]) => [...rows].reverse();

test('one popup per subject, steps in order, ending with the status', () => {
  const rows = [
    row({ type: 'agent', title: 'Working on node-12' }),
    row({ type: 'agent_plan', verdict: 'plan', title: 'Plan for node-12: drain → reimage' }),
    row({ title: 'Drained node-12' }),
    row({ type: 'agent', verdict: 'fixed', title: 'Fixed node-12' }),
  ];
  const [fix, ...rest] = softwareFixes(newestFirst(rows));
  assert.equal(rest.length, 0);
  assert.equal(fix.status, 'fixed');
  assert.deepEqual(
    fix.lines.map((l) => l.text),
    ['Working on node-12', 'Plan for node-12: drain → reimage', 'Drained node-12', 'Fixed node-12'],
  );
});

test('hardware dispatches, other actors and old rows are not software fixes', () => {
  const old = row({});
  const rows = [old, row({ type: 'tech_dispatched', subject: 'cdu-3' }), row({ actorKind: 'scheduler', actor: 'Scheduler', subject: 'x' }), row({ subject: 'node-9' })];
  const fixes = softwareFixes(newestFirst(rows), old.seq);
  assert.deepEqual(fixes.map((f) => f.subject), ['node-9']);
  assert.equal(fixes[0].status, 'working');
});

test('only the last few lines are kept; a hand-off or failing closed ends it; a new row starts a new fix', () => {
  const rows = Array.from({ length: MAX_LINES + 2 }, () => row({ subject: 'rack-r3-07' }));
  rows.push(row({ subject: 'rack-r3-07', type: 'escalated', verdict: 'handoff' }));
  rows.push(row({ subject: 'rack-r3-07' }));
  rows.push(row({ subject: 'node-5', type: 'agent', verdict: 'warn' }));
  const fixes = softwareFixes(newestFirst(rows));
  assert.equal(fixes.length, 3);
  assert.equal(fixes[0].lines.length, MAX_LINES);
  assert.equal(fixes[0].status, 'handoff');
  assert.equal(fixes[1].status, 'working');
  assert.equal(fixes[2].status, 'stopped');
  assert.notEqual(fixes[0].key, fixes[1].key);
});
