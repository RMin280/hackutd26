// The diagnostics test bed (core/lab.ts): every incident's answer key must be what the
// engine actually says, so agents are graded against the real thing.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnoseFailure } from '../src/core/commands';
import { INCIDENTS, LAB_NOW, seedDiagnostics } from '../src/core/lab';
import { freshDatabase as lab, ID } from './helpers';

test('the test bed: five incidents at T+3h', () => {
  const s = lab();
  assert.equal(s.now(), LAB_NOW);
  assert.equal(s.incidents.size, 5);
  const failed = [...s.nodes.values()].filter((n) => n.state === 'failed').map((n) => n.id).sort();
  assert.deepEqual(failed, ['node-1007', 'node-1153', 'node-417', 'node-427', 'node-660', 'node-731', 'node-923']);
  const job = s.job('job-train-1')!;
  assert.deepEqual([job.status, job.crashes], ['stopped', 1], 'stopped since node-660 at T+1h05m');
  const levels = { green: 0, yellow: 0, red: 0 } as Record<string, number>;
  for (const m of s.margins.values()) levels[m.level]++;
  assert.deepEqual(levels, { green: 124, yellow: 36, red: 0 });
  assert.equal(s.decisions.length, 10, 'one feed entry per event');
  assert.equal(s.failures.length, 7);
});

test('every incident diagnoses to its answer key', () => {
  const s = lab();
  const atRisk: Record<number, number> = { 1: 39, 2: 127, 3: 126, 4: 0, 5: 0 };
  for (const inc of INCIDENTS) {
    const d = s.diagnosis(diagnoseFailure(s, ID.sched, inc.nodes))!;
    assert.equal(d.classification, inc.expectClassification, `#${inc.id} ${inc.title}: ${d.reason}`);
    assert.equal(d.cause, inc.expectCause, `#${inc.id}: ${d.reason}`);
    assert.equal(d.send, inc.expectSend, `#${inc.id}`);
    assert.equal(d.atRisk.length, atRisk[inc.id], `#${inc.id} at-risk count`);
  }
});

test('each failed node of a shared-cause incident gives the same answer on its own', () => {
  const s = lab();
  for (const n of ['node-660', 'node-731']) {
    assert.equal(s.diagnosis(diagnoseFailure(s, ID.sched, [n]))!.cause, 'sw-leaf-r6', n);
  }
});

test('seed_diagnostics puts the test bed back', () => {
  const s = lab();
  diagnoseFailure(s, ID.sched, ['node-417']);
  seedDiagnostics(s, ID.lead);
  assert.equal(s.diagnoses.size, 0);
  assert.equal(s.incidents.size, 5);
  assert.throws(() => seedDiagnostics(s, ID.tech), /can't run the scenario/);
});
