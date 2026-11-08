// The view's fixer popups (frontend/src/scene/fixes.ts): which software fixes the Nemotron fixer
// is doing, grouped from its own rows in the decision feed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DecisionEvent } from '../../frontend/src/model/types';
import { MAX_LINES, detailOf, softwareFixes } from '../../frontend/src/scene/fixes';

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

test("the update agent's advisory gets its own popup, follows its wave onto the hall and waits between waves", () => {
  const upd = (p: Partial<DecisionEvent>) => row({ actor: 'update-agent', actorKind: 'updater', subject: 'SQK-SIM-2026-0419', focus: { kind: 'overview' }, ...p });
  const rows = [
    upd({ type: 'agent', title: 'Working on SQK-SIM-2026-0419' }),
    upd({ type: 'agent_plan', verdict: 'plan', title: 'Plan for SQK-SIM-2026-0419: check_wave → book_wave' }),
    upd({ type: 'lease_granted', verdict: 'allow', subject: 'row-1', focus: { kind: 'racks', ids: ['rack-r1-01', 'rack-r1-02'] }, title: 'Online update on Row 1 allowed' }),
    row({ subject: 'node-12' }), // the fixer, at the same time: its own popup
    upd({ type: 'agent', title: 'Waiting on SQK-SIM-2026-0419' }),
    row({ actor: 'Scheduler', actorKind: 'scheduler', type: 'lease_granted', subject: 'job-train-1' }), // not the update agent's
  ];
  const fixes = softwareFixes(newestFirst(rows));
  assert.deepEqual(fixes.map((f) => [f.agent, f.subject, f.status]), [
    ['updater', 'SQK-SIM-2026-0419', 'waiting'],
    ['fixer', 'node-12', 'working'],
  ]);
  assert.deepEqual(fixes[0].focus, { kind: 'racks', ids: ['rack-r1-01', 'rack-r1-02'] });
  assert.ok(fixes[0].lines.some((l) => l.text === 'Online update on Row 1 allowed'));

  // The next wave continues the same popup; a lease row with no advisory open is not a fix.
  const more = [...rows, upd({ type: 'agent_step', title: 'check_wave: Next wave: 4 of 9' }), upd({ type: 'agent', verdict: 'fixed', title: 'Fixed SQK-SIM-2026-0419' })];
  more.push(upd({ type: 'lease_granted', verdict: 'allow', subject: 'row-2' }));
  const after = softwareFixes(newestFirst(more));
  assert.equal(after.filter((f) => f.agent === 'updater').length, 1);
  assert.equal(after[0].status, 'fixed');
});

test("the model's thinking and words ride along, newest reply first; a row's reason shows only when it adds to the title", () => {
  const plan = JSON.stringify({ steps: [], model: 'Nemotron on Brev', thinking: 'A free spare failed; no job is on it.', said: 'Taking it out of service.' });
  const step = JSON.stringify({ thinking: 'Isolated, as expected.' });
  const rows = [
    row({ type: 'agent', title: 'Working on node-12', reason: 'Taking broken_node. node-12 is a free spare that failed.' }),
    row({ type: 'agent_plan', verdict: 'plan', title: 'Plan for node-12: diagnose → finish', reason: 'Plan: confirm it is isolated · done', data: plan }),
    row({ title: 'diagnose: isolated. node-12 alone', reason: 'diagnose: isolated. node-12 alone', data: step }),
    row({ title: 'diagnose: isolated. node-12 alone…', reason: 'diagnose: isolated. node-12 alone, nothing shared upstream' }),
    row({ type: 'agent', verdict: 'fixed', title: 'Fixed node-12', reason: 'FIXED: node-12 is out of service and a tech is on the way.' }),
  ];
  const [fix] = softwareFixes(newestFirst(rows));
  assert.equal(fix.model, 'Nemotron on Brev');
  assert.equal(fix.thinking, 'Isolated, as expected.', 'the step row replaces the plan row');
  assert.equal(fix.said, undefined, 'the newer reply said nothing, so nothing stale is kept');
  assert.deepEqual(
    fix.lines.map((l) => l.detail),
    ['confirm it is isolated · done', undefined, undefined, 'node-12 is out of service and a tech is on the way.'],
  );
  assert.equal(detailOf({ title: 'Working on node-12', reason: 'Taking broken_node. node-12 is a free spare that failed.' }), 'Taking broken_node. node-12 is a free spare that failed.');
  assert.equal(detailOf({ title: 'Row 3 patched', reason: '' }), undefined);
});
