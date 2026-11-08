// The work board: who takes a lease on and who finishes it (accept_work / complete_work).
// Accepting is bookkeeping on a lease the interlock already decided; completing ends the lease
// now and, for hardware work, brings a failed or degraded target back as an ordinary state change.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptWork, advanceClock, completeWork, reportNodeFailure, requestProtection, requestWork, setPartState } from '../src/core/commands';
import { RequestError, type DecisionRow } from '../src/core/types';
import { demo, ID, work } from './helpers';
import type { MemStore } from './memstore';

const FREE = 'node-1028'; // free spare, rack-r9-01
const last = (s: MemStore): DecisionRow => s.decisions[s.decisions.length - 1];
const dataOf = (d: DecisionRow) => JSON.parse(d.data) as Record<string, unknown>;

function brokenSpareUnderRepair(s: MemStore) {
  reportNodeFailure(s, ID.facility, FREE);
  const w = requestWork(s, ID.fixer, work('node_repair', FREE, { ticket: 'fix-1' }));
  assert.equal(w.status, 'active', 'a free spare on a green rack: the fixer may take it out of service');
  return w;
}

test('a technician takes an active repair on; the feed says who and which trade', () => {
  const s = demo();
  const w = brokenSpareUnderRepair(s);
  const n = s.decisions.length;
  const row = acceptWork(s, ID.tech, w.id);
  assert.equal(row.assignee, 'Tech Ana');
  assert.equal(row.assigneeRole, 'technician');
  assert.equal(row.acceptedAt, s.now());
  assert.equal(row.completedAt, -1);
  assert.equal(s.decisions.length, n + 1);
  const d = last(s);
  assert.equal(d.type, 'work_accepted');
  assert.equal(d.verdict, 'info');
  assert.equal(d.subject, FREE);
  assert.equal(d.work, w.id);
  assert.match(d.title, /Hardware repair on node-1028 taken by Tech Ana/);
  assert.match(d.reason, /Tech Ana \(hardware tech\) is on it\. Runs until T\+2h\./);
  assert.equal(dataOf(d).trade, 'hardware tech');
  assert.equal(dataOf(d).lease, String(w.id));
  // The lease itself is untouched: accepting is not a verdict.
  assert.equal(s.work(w.id)!.status, 'active');
  assert.ok(s.audits.some((a) => a.action === 'accept' && a.actor === 'Tech Ana'));
});

test('taking on what is already yours changes nothing; someone else needs a shift lead', () => {
  const s = demo();
  const w = brokenSpareUnderRepair(s);
  acceptWork(s, ID.tech, w.id);
  const n = s.decisions.length;
  const again = acceptWork(s, ID.tech, w.id);
  assert.equal(again.assignee, 'Tech Ana');
  assert.equal(s.decisions.length, n, 'no second feed row');
  // Another technician (every row) can't take it from her...
  s.putActor({ identity: ID.stranger, name: 'Tech Bo', role: 'technician', rows: [] });
  assert.throws(() => acceptWork(s, ID.stranger, w.id), (e: unknown) => e instanceof RequestError && /already with Tech Ana; only a shift lead can move it/.test(e.message));
  // ...but the shift lead can move it, and the feed says from whom.
  const moved = acceptWork(s, ID.lead, w.id);
  assert.equal(moved.assignee, 'Shift lead');
  assert.match(last(s).title, /taken by Shift lead \(from Tech Ana\)/);
  assert.equal(dataOf(last(s)).from, 'Tech Ana');
});

test('scope and roles: rows must cover the work; agents and viewers never take work on', () => {
  const s = demo();
  const w = brokenSpareUnderRepair(s);
  // Tech Row 3 may only act in Row 3; node-1028 is in Row 9.
  assert.throws(() => acceptWork(s, ID.tech3, w.id), (e: unknown) => e instanceof RequestError && /Tech Row 3 is scoped to Row 3; node-1028 is in Row 9/.test(e.message));
  for (const who of [ID.cool, ID.sched, ID.fixer]) {
    assert.throws(() => acceptWork(s, who, w.id), (e: unknown) => e instanceof RequestError && /not allowed to take on or complete work/.test(e.message));
  }
  assert.throws(() => acceptWork(s, ID.stranger, w.id), RequestError, 'unknown identity');
  // Facility staff and the shift lead may.
  assert.equal(acceptWork(s, ID.facility, w.id).assignee, 'Facility');
  assert.equal(s.assignment(w.id)!.assignee, 'Facility');
});

test('only live or waiting work can be taken on; protection leases have no worker', () => {
  const s = demo();
  const denied = requestWork(s, ID.tech, work('sw_exclusive', 'rack-r3-07'));
  assert.equal(denied.status, 'denied');
  assert.throws(() => acceptWork(s, ID.tech, denied.id), (e: unknown) => e instanceof RequestError && /is denied; nothing to take on/.test(e.message));
  const p = requestProtection(s, ID.sched, 'job-train-1', 0, 'p-1');
  assert.throws(() => acceptWork(s, ID.tech, p.id), (e: unknown) => e instanceof RequestError && /protection lease for job-train-1/.test(e.message));
  assert.throws(() => completeWork(s, ID.lead, p.id), (e: unknown) => e instanceof RequestError && /protection lease/.test(e.message));
  assert.throws(() => acceptWork(s, ID.tech, 999n), (e: unknown) => e instanceof RequestError && /No work #999/.test(e.message));
});

test('completing a hardware repair brings the failed node back and ends the lease now', () => {
  const s = demo();
  const w = brokenSpareUnderRepair(s);
  assert.equal(s.node(FREE)!.state, 'failed');
  assert.equal(s.node(FREE)!.heldBy, w.id, 'held out of service while the repair runs');
  acceptWork(s, ID.tech, w.id);
  advanceClock(s, ID.lead, 45);
  const n = s.decisions.length;
  const row = completeWork(s, ID.tech, w.id, 'Swapped the DIMM.');
  assert.equal(row.completedBy, 'Tech Ana');
  assert.equal(row.completedAt, 45);
  assert.equal(row.acceptedAt, 0, 'keeps when it was taken on');
  assert.deepEqual(row.repaired, [FREE]);
  assert.equal(row.note, 'Swapped the DIMM.');
  const after = s.work(w.id)!;
  assert.equal(after.status, 'done');
  assert.equal(after.endMin, 45, 'ended early, at the completion time');
  assert.equal(s.node(FREE)!.state, 'ok');
  assert.equal(s.node(FREE)!.heldBy, 0n);
  assert.equal(s.claimsOn(`node:${FREE}`).length, 0, 'its claims are released');
  // Two feed rows: the state change, then the completion.
  assert.equal(s.decisions.length, n + 2);
  const [change, done] = s.decisions.slice(-2);
  assert.equal(change.type, 'state_change');
  assert.equal(dataOf(change).state, 'ok');
  assert.equal(dataOf(change).kind, 'node');
  assert.equal(done.type, 'work_completed');
  assert.equal(done.verdict, 'fixed');
  assert.equal(done.work, w.id);
  assert.match(done.title, /Hardware repair on node-1028 completed by Tech Ana/);
  assert.match(done.reason, /node-1028 is back in service\. Its claims are released\. Swapped the DIMM\./);
  assert.deepEqual(dataOf(done).repaired, [FREE]);
  assert.equal(dataOf(done).completed_by, 'Tech Ana');
  assert.ok(s.audits.some((a) => a.action === 'complete' && a.target === `#${w.id}`));
});

test('who may complete: the assignee, the requester or a shift lead; not before it starts', () => {
  const s = demo();
  const w = brokenSpareUnderRepair(s); // requested by the fixer
  acceptWork(s, ID.tech, w.id);
  s.putActor({ identity: ID.stranger, name: 'Tech Bo', role: 'technician', rows: [] });
  assert.throws(() => completeWork(s, ID.stranger, w.id), (e: unknown) => e instanceof RequestError && /Only Tech Ana or a shift lead can complete/.test(e.message));
  // The requester may complete its own lease even without accepting, but the fixer's role may not work on it.
  assert.throws(() => completeWork(s, ID.fixer, w.id), (e: unknown) => e instanceof RequestError && /not allowed to take on or complete work/.test(e.message));
  // A technician's own future booking: not before it starts.
  const later = requestWork(s, ID.tech, work('node_repair', 'node-1029', { startInMin: 60 }));
  assert.equal(later.status, 'granted');
  assert.throws(() => completeWork(s, ID.tech, later.id), (e: unknown) => e instanceof RequestError && /hasn't started \(it starts T\+1h\)/.test(e.message));
  // Nobody accepted, the shift lead completes: she is both assignee and completer.
  const row = completeWork(s, ID.lead, w.id);
  assert.equal(row.assignee, 'Tech Ana', 'the person who took it on stays the assignee');
  assert.equal(row.completedBy, 'Shift lead');
  const unassigned = requestWork(s, ID.tech, work('node_repair', 'node-1030'));
  const r2 = completeWork(s, ID.lead, unassigned.id);
  assert.equal(r2.assignee, 'Shift lead', 'completed without being taken on: the completer did it');
  assert.equal(r2.acceptedAt, s.now());
  assert.throws(() => completeWork(s, ID.lead, unassigned.id), (e: unknown) => e instanceof RequestError && /is done; nothing to complete/.test(e.message));
});

test('completing facility work on a degraded CDU repairs it and the racks below get the feed back', () => {
  const s = demo();
  setPartState(s, ID.facility, 'cdu-9', 'degraded');
  const below = s.downstreamRacks('cdu-9');
  assert.ok(below.every((r) => s.margin(r)!.level === 'yellow'), 'one failure from an outage while CDU-9 is degraded');
  const w = requestWork(s, ID.tech, work('facility_work', 'cdu-9'));
  assert.equal(w.status, 'active', 'taking an already-degraded feed offline drops nothing further');
  acceptWork(s, ID.tech, w.id);
  assert.equal(dataOf(last(s)).trade, 'mechanical tech', 'CDUs are the mechanical trade');
  advanceClock(s, ID.lead, 90);
  const row = completeWork(s, ID.tech, w.id);
  assert.deepEqual(row.repaired, ['cdu-9']);
  assert.equal(s.part('cdu-9')!.state, 'ok');
  assert.equal(s.part('cdu-9')!.heldBy, 0n);
  assert.ok(below.every((r) => s.margin(r)!.level === 'green'), 'full backup again');
  const done = last(s);
  assert.equal(done.type, 'work_completed');
  assert.match(done.reason, /CDU-9 is back in service\. Its claims are released; 15 racks below it have the feed back\./);
});

test('software work just ends: nothing was broken, so nothing is repaired', () => {
  const s = demo();
  const w = requestWork(s, ID.tech, work('sw_exclusive', 'node-1028'));
  assert.equal(w.status, 'active');
  assert.equal(s.node('node-1028')!.heldBy, w.id);
  const row = completeWork(s, ID.tech, w.id, 'Driver 580 installed.');
  assert.deepEqual(row.repaired, []);
  assert.equal(s.node('node-1028')!.state, 'ok');
  assert.equal(s.node('node-1028')!.heldBy, 0n);
  const d = last(s);
  assert.equal(d.type, 'work_completed');
  assert.equal(d.reason, 'Its claims are released. Driver 580 installed.');
  assert.equal(s.decisions.filter((x) => x.type === 'state_change' && x.subject === 'node-1028').length, 0);
});
