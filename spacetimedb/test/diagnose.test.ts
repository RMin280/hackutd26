import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceClock, diagnoseFailure, reportNodeFailure, setPartState } from '../src/core/commands';
import { demo, ID } from './helpers';

test('a degraded ancestor is the shared cause; at-risk nodes are the job nodes under it', () => {
  const s = demo();
  setPartState(s, ID.facility, 'cdu-3', 'degraded');
  reportNodeFailure(s, ID.sched, 'node-417');
  assert.equal(s.job('job-train-1')!.status, 'stopped');
  const d = s.diagnosis(diagnoseFailure(s, ID.sched, ['node-417']))!;
  assert.equal(d.classification, 'shared_cause');
  assert.equal(d.cause, 'cdu-3');
  assert.equal(d.atRisk.length, 39);
  assert.ok(!d.atRisk.includes('node-417'));
  assert.equal(d.send, 'mechanical tech to CDU-3');
  assert.equal(
    d.reason,
    'Shared cause: node-417 is cooled by CDU-3 (degraded). 39 other nodes of job-train-1 are on CDU-3. Not a single-GPU fault.',
  );
});

test('with nothing broken, one failure is isolated', () => {
  const s = demo();
  reportNodeFailure(s, ID.sched, 'node-417');
  const d = s.diagnosis(diagnoseFailure(s, ID.sched, ['node-417']))!;
  assert.equal(d.classification, 'isolated');
  assert.equal(d.send, 'hardware tech to node-417');
});

test('two failures in the window share their most specific common ancestor', () => {
  const s = demo();
  reportNodeFailure(s, ID.sched, 'node-417'); // rack-r1-12 (CDU-3)
  advanceClock(s, ID.lead, 30);
  reportNodeFailure(s, ID.sched, 'node-97'); // rack-r1-13 (CDU-3)
  const d = s.diagnosis(diagnoseFailure(s, ID.sched, ['node-97']))!;
  assert.equal(d.classification, 'shared_cause');
  assert.equal(d.cause, 'cdu-3', 'CDU-3 feeds 5 racks; the PDUs and the leaf feed 16');
  assert.match(d.reason, /node-97 and node-417 failed within 2 h and share CDU-3/);
});

test('failures outside the window do not count', () => {
  const s = demo();
  reportNodeFailure(s, ID.sched, 'node-417');
  advanceClock(s, ID.lead, 180);
  reportNodeFailure(s, ID.sched, 'node-97');
  const d = s.diagnosis(diagnoseFailure(s, ID.sched, ['node-97']))!;
  assert.equal(d.classification, 'isolated');
});

test('sharing only central plant (UPS, chillers, spine) is no evidence', () => {
  const s = demo();
  reportNodeFailure(s, ID.sched, 'node-417'); // Row 1
  reportNodeFailure(s, ID.sched, 'node-427'); // Row 4: shares only UPS, switchgear, utility, chillers, spine
  const d = s.diagnosis(diagnoseFailure(s, ID.sched, ['node-427']))!;
  assert.equal(d.classification, 'isolated', d.reason);
});
