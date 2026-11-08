// DESIGN.md §10.2 "Big job failure", Squawk mode, driven through the same
// commands the reducers call. This is the minimum demo (§10.3).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceClock,
  diagnoseFailure,
  reportNodeFailure,
  requestPlacement,
  requestProtection,
  requestWork,
  restartJob,
  setPartState,
} from '../src/core/commands';
import { demo, ID, work } from './helpers';

test('big job failure: diagnose, restart once on safe racks, refuse the unsafe CDU-4 request', () => {
  const s = demo();

  // T+0: CDU-3 degrades; its 5 racks are one failure from an outage.
  setPartState(s, ID.facility, 'cdu-3', 'degraded');
  const yellow = s.downstreamRacks('cdu-3').filter((r) => s.margin(r)!.level === 'yellow');
  assert.deepEqual(yellow, ['rack-r1-11', 'rack-r1-12', 'rack-r1-13', 'rack-r1-14', 'rack-r1-15']);
  assert.deepEqual(s.margin('rack-r1-12')!.unprotected, ['cdu-4', 'chiller-2']);

  // T+10m: node-417 fails and the synchronous job stops.
  advanceClock(s, ID.lead, 10);
  reportNodeFailure(s, ID.sched, 'node-417');

  // T+11m: diagnosis -> shared cause CDU-3, 39 job nodes at risk.
  advanceClock(s, ID.lead, 1);
  const diagId = diagnoseFailure(s, ID.sched, ['node-417']);
  const d = s.diagnosis(diagId)!;
  assert.equal(d.cause, 'cdu-3');
  assert.equal(d.atRisk.length, 39);

  // T+12m: 40 replacement nodes on healthy racks.
  advanceClock(s, ID.lead, 1);
  const placeId = requestPlacement(s, ID.sched, { job: 'job-train-1', needed: 0, durationMin: 0, exclude: [], diagnosisId: diagId });
  const p = s.placement(placeId)!;
  assert.equal(p.nodes.length, 40);
  assert.ok(p.nodes.every((n) => !s.downstreamRacks('cdu-3').includes(s.node(n)!.rack)));

  // T+13m: restart once, then protect the job's racks for 72 h.
  advanceClock(s, ID.lead, 1);
  restartJob(s, ID.sched, 'job-train-1', placeId);
  const job = s.job('job-train-1')!;
  assert.deepEqual([job.status, job.nodes, job.restarts, job.crashes], ['running', 1000, 1, 1]);
  assert.equal(s.node('node-422')!.ownerKind, 'free', 'node-422 left the job with the other at-risk nodes');
  const prot = requestProtection(s, ID.sched, 'job-train-1', 0, 'restart-1');
  assert.equal(prot.racks.length, 128);
  assert.equal(s.margin('rack-r9-01')!.protectedJob, 'job-train-1');

  // T+30m: the cooling agent asks for CDU-4. Denied, with the reason and the earliest safe time.
  advanceClock(s, ID.lead, 17);
  const req = requestWork(s, ID.cool, work('facility_work', 'cdu-4', { ticket: 'cool-cdu4' }));
  assert.equal(req.status, 'denied');
  assert.equal(
    req.reason,
    'CDU-4 is the only cooling feed for 5 racks (CDU-3 degraded); taking it offline makes them red. It would also drop 5 racks protected for job-train-1 below full backup.',
  );
  assert.equal(req.earliestSafe, 'after CDU-3 repair, and not before T+72h13m');
  assert.equal(s.part('cdu-4')!.heldBy, 0n);

  // T+50m: node-422 fails, but it already left the job. One restart, no second outage.
  advanceClock(s, ID.lead, 20);
  reportNodeFailure(s, ID.sched, 'node-422');
  assert.equal(s.job('job-train-1')!.status, 'running');

  const feed = s.decisions.map((e) => `${e.atMin} ${e.verdict} ${e.title}`);
  assert.deepEqual(feed, [
    '0 warn CDU-3 degraded',
    '10 failure node-417 failed, job-train-1 stopped',
    '11 shared_cause Diagnosis: shared cause CDU-3',
    '12 placement Safe placement: 40 nodes',
    '13 info Restarted job-train-1 on 40 new nodes',
    '13 allow Protection lease for job-train-1 granted',
    '30 deny Maintenance on CDU-4 denied',
    '50 failure node-422 failed',
  ]);
  assert.ok(s.audits.length >= feed.length, 'every decision is in the audit log');
});

test('after CDU-3 is repaired and the protection ends, CDU-4 maintenance only needs approval', () => {
  const s = demo();
  setPartState(s, ID.facility, 'cdu-3', 'degraded');
  requestProtection(s, ID.sched, 'job-train-1', 120, '');
  assert.equal(requestWork(s, ID.cool, work('facility_work', 'cdu-4')).verdict, 'deny');
  setPartState(s, ID.facility, 'cdu-3', 'ok');
  const stillProtected = requestWork(s, ID.cool, work('facility_work', 'cdu-4'));
  assert.equal(stillProtected.verdict, 'deny');
  assert.equal(stillProtected.earliestSafe, 'T+2h (with shift lead approval)');
  advanceClock(s, ID.lead, 120);
  assert.equal(requestWork(s, ID.cool, work('facility_work', 'cdu-4')).verdict, 'warn');
  assert.equal(s.margin('rack-r1-11')!.protectedBy, 0n);
});
