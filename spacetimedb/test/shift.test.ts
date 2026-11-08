// seed_shift: a busy shift's work for the work board, laid over the hall through the interlock.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toSite, toWorkItems } from '../../frontend/src/live/mapping';
import { TRADES, groupWork, laneOf, tradeFor } from '../../frontend/src/ui/board/board';
import { scenarioStart, scenarioNext } from '../src/core/scenario';
import { SHIFT, seedShift } from '../src/core/shift';
import { RequestError } from '../src/core/types';
import { demo, ID } from './helpers';
import { tablesOf } from './tables';

test('the shift fills every lane and every trade, through real verdicts', () => {
  const s = demo();
  const made = seedShift(s, ID.lead);
  assert.equal(made.length, SHIFT.length, 'every booking produced a work row');
  const site = toSite(tablesOf(s));
  const items = toWorkItems(tablesOf(s).work, tablesOf(s).assignment);
  const lanes = groupWork(items, site);
  for (const lane of ['active', 'booked', 'approval', 'refused', 'done'] as const) {
    assert.ok(lanes[lane].length > 0, `${lane} lane is empty: ${items.map((i) => `${i.ticket}:${i.status}`).join(', ')}`);
  }
  const trades = new Set(items.map((i) => tradeFor(i, site)?.trade).filter(Boolean));
  for (const t of TRADES) assert.ok(trades.has(t), `no work for ${t}`);
  // The repair in hand has a tech on it; the finished one has who did it and what came back.
  const repair = items.find((i) => i.ticket === 'shift-repair-1037')!;
  assert.equal(repair.status, 'active');
  assert.equal(repair.assignee, 'Hardware tech');
  const done = items.find((i) => i.ticket === 'shift-done-1029')!;
  assert.equal(done.status, 'done');
  assert.equal(done.completedBy, 'Hardware tech');
  assert.deepEqual(done.repaired, [done.target]);
  assert.equal(s.node(done.target)!.state, 'ok');
  // Tenant nodes are never touched: the rack work and the rack-wide driver are refused.
  assert.equal(items.find((i) => i.ticket === 'shift-rack-r10-16')!.status, 'denied');
  assert.equal(items.find((i) => i.ticket === 'shift-driver-r9-05')!.status, 'denied');
  // The approvals happened where the verdict asked for them.
  const pdu = items.find((i) => i.ticket === 'shift-pdu-r10-b')!;
  assert.ok(pdu.status === 'granted' || pdu.status === 'denied', `pdu swap is ${pdu.status}`);
  if (pdu.status === 'granted') assert.equal(pdu.approvedBy, 'Shift lead (on call)');
  for (const i of items) assert.ok(laneOf(i) !== null, `${i.ticket} has no lane`);
});

test('seeding twice adds nothing, and viewers may not seed', () => {
  const s = demo();
  const first = seedShift(s, ID.lead);
  const again = seedShift(s, ID.lead);
  assert.equal(again.length, 0);
  assert.equal(tablesOf(s).work.length, first.length);
  assert.throws(() => seedShift(s, ID.tech), RequestError, 'a technician is not a presenter');
});

test('the shift lays over the big-job scenario without disturbing it', () => {
  const s = demo();
  scenarioStart(s, ID.lead, 'squawk');
  for (let i = 0; i < 6; i++) scenarioNext(s, ID.lead, 'squawk');
  const before = s.decisions.length;
  const protection = s.workByStatus('active').find((w) => w.kind === 'protection')!;
  seedShift(s, ID.lead);
  assert.ok(s.decisions.length > before);
  assert.equal(s.work(protection.id)!.status, 'active', 'the protection lease still holds');
  assert.equal(s.job('job-train-1')!.status, 'running', 'the seed never touches a job node, even after the restart moved the job onto spares');
  for (const w of s.workByStatus('active')) if (w.kind === 'node_repair') assert.equal(s.node(w.target)!.ownerKind, 'free');
  // The UPS-A test would take backup from protected racks: refused with a reason naming the lock.
  const ups = s.workByStatus('denied').find((w) => w.ticket === 'shift-ups-a');
  assert.ok(ups, 'UPS-A test is refused while the job is protected');
});
