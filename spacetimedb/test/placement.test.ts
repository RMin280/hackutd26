import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approveWork, requestPlacement, requestWork } from '../src/core/commands';
import { demo, ID, work } from './helpers';

const place = (s: ReturnType<typeof demo>, needed: number, exclude: string[] = []) =>
  s.placement(requestPlacement(s, ID.sched, { job: 'job-train-1', needed, durationMin: 0, exclude, diagnosisId: 0n }))!;

test('places on free nodes with full backup, nearest spine first', () => {
  const s = demo();
  const p = place(s, 40);
  assert.equal(p.nodes.length, 40);
  assert.equal(p.shortfall, 0);
  assert.ok(p.nodes.every((n) => s.node(n)!.rowNum === 9), 'Row 9 comes first in hall order');
  assert.ok(p.nodes.every((n) => s.node(n)!.ownerKind === 'free'));
  assert.equal(
    p.reason,
    'Restart on 40 spare nodes in Row 9: separate cooling (CDU-26, CDU-27, CDU-28) and power, full backup, no maintenance booked in the next 72 h.',
  );
});

test('excludes racks with booked maintenance in the window', () => {
  const s = demo();
  const w = requestWork(s, ID.tech, work('facility_work', 'pdu-r9-a', { startInMin: 600 }));
  approveWork(s, ID.lead, w.id);
  const p = place(s, 40);
  assert.ok(p.nodes.every((n) => s.node(n)!.rowNum === 10), 'Row 9 has PDU work booked inside 72 h');
  assert.equal(p.excludedCounts[p.excludedReasons.indexOf('maintenance booked')], 80);
});

test('excludes racks below full backup and reports a shortfall', () => {
  const s = demo();
  const w = requestWork(s, ID.tech, work('hot_aisle_work', 'ha-5'));
  approveWork(s, ID.lead, w.id);
  const p = place(s, 40);
  assert.equal(p.nodes.length, 0);
  assert.equal(p.shortfall, 40);
  assert.equal(p.excludedCounts[p.excludedReasons.indexOf('rack below full backup')], 160);
  assert.match(p.reason, /^Shortfall: only 0 of 40 nodes are safe right now/);
});

test('excludes nodes passed in, and nodes under work', () => {
  const s = demo();
  requestWork(s, ID.tech, work('node_repair', 'node-1028'));
  const p = place(s, 160, ['node-1029']);
  assert.equal(p.shortfall, 2);
  assert.ok(!p.nodes.includes('node-1028') && !p.nodes.includes('node-1029'));
});
