// The backend scenario runner (core/scenario.ts) that the control room drives.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureScriptedActors, scenarioGoto, scenarioNext, scenarioStart, STEPS } from '../src/core/scenario';
import { demo, freshDatabase, ID } from './helpers';

// Same steps as frontend/src/mock/scenario.ts (the view's step list reads those).
const EXPECTED = {
  naive: [
    [0, 'CDU-3 degrades'],
    [10, 'node-417 fails'],
    [12, 'Naive swap and restart'],
    [50, 'node-422 fails'],
    [52, 'Naive restart again'],
  ],
  blast_radius: [
    [0, 'CDU-3 degrades'],
    [10, 'node-417 fails'],
    [11, 'Diagnose the failure'],
    [12, 'Find a safe place to restart'],
    [13, 'Restart and protect'],
    [30, 'Cooling agent asks for CDU-4'],
    [50, 'node-422 fails'],
  ],
};

function presenter() {
  const s = demo();
  ensureScriptedActors(s);
  return s;
}

test('step lists match the view', () => {
  for (const mode of ['naive', 'blast_radius'] as const) {
    assert.deepEqual(
      STEPS[mode].map((st) => [st.at, st.title]),
      EXPECTED[mode],
      mode,
    );
  }
});

test('Blast Radius mode: one crash, one restart, CDU-4 refused', () => {
  const s = presenter();
  scenarioStart(s, ID.lead, 'blast_radius');
  assert.equal(s.scenario()!.step, -1);
  for (let i = 0; i < STEPS.blast_radius.length; i++) scenarioNext(s, ID.lead, 'blast_radius');
  const sc = s.scenario()!;
  assert.equal(sc.step, 6);
  assert.equal(s.now(), 50);
  const job = s.job('job-train-1')!;
  assert.deepEqual([job.status, job.crashes, job.restarts, job.nodes], ['running', 1, 1, 1000]);
  const denied = s.workByStatus('denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].target, 'cdu-4');
  assert.equal(denied[0].actor, 'Cooling agent');
  assert.equal(s.workByStatus('active').filter((w) => w.kind === 'protection').length, 1);
  assert.deepEqual(
    s.decisions.map((d) => `${d.actor}: ${d.title}`),
    [
      'Facility: CDU-3 degraded',
      'Scheduler: node-417 failed, job-train-1 stopped',
      'Blast Radius: Diagnosis: shared cause CDU-3',
      'Blast Radius: Safe placement: 40 nodes',
      'Scheduler agent: Restarted job-train-1 on 40 new nodes',
      'Scheduler agent: Protection lease for job-train-1 granted',
      'Cooling agent: Maintenance on CDU-4 denied',
      'Scheduler: node-422 failed, job-train-1 unaffected',
    ],
  );
  assert.equal(
    s.scenario()!.caption,
    'node-422 fails, exactly as in the naive run, but it was already moved out of the job. One restart, no second outage.',
  );
  assert.equal(scenarioNext(s, ID.lead, 'blast_radius'), undefined, 'past the last step nothing happens');
  assert.equal(s.scenario()!.step, 6);
});

test('naive mode: swaps blindly and crashes twice', () => {
  const s = presenter();
  for (let i = 0; i < STEPS.naive.length; i++) scenarioNext(s, ID.lead, 'naive');
  const job = s.job('job-train-1')!;
  assert.deepEqual([job.status, job.crashes, job.restarts, job.nodes], ['running', 2, 2, 1000]);
  assert.equal(s.node('node-1028')!.ownerId, 'job-train-1', 'first naive pick: the first free node');
  assert.equal(s.node('node-1029')!.ownerId, 'job-train-1');
  assert.equal(s.placements.size, 0, 'naive restarts make no safe placement');
  const titles = s.decisions.map((d) => d.title);
  assert.ok(titles.includes('Swapped node-417 for node-1028, restarted'));
  assert.ok(titles.includes('node-422 failed, job-train-1 stopped again'));
  assert.match(s.decisions.at(-1)!.reason, /^Still no diagnosis\. 38 job nodes remain on CDU-3/);
});

test('jumping to a step replays to the same state', () => {
  const a = presenter();
  for (let i = 0; i <= 4; i++) scenarioNext(a, ID.lead, 'blast_radius');
  const b = presenter();
  scenarioNext(b, ID.lead, 'naive');
  scenarioGoto(b, ID.lead, 'blast_radius', 4);
  const snap = (s: typeof a) => ({
    now: s.now(),
    step: s.scenario()!.step,
    caption: s.scenario()!.caption,
    job: s.job('job-train-1'),
    owners: [...s.nodes.values()].map((n) => `${n.id}:${n.ownerId}:${n.state}`).join(','),
    margins: [...s.margins.values()].map((m) => `${m.rack}:${m.level}:${m.protectedJob}`).join(','),
    work: [...s.works.values()].map((w) => `${w.kind}:${w.status}`).join(','),
  });
  assert.deepEqual(snap(b), snap(a));
});

test('a fresh database holds the test bed; Space starts the demo from it', () => {
  const s = freshDatabase();
  assert.equal(s.scenario()!.bed, 'lab');
  assert.equal(s.part('cdu-29')!.state, 'failed');
  scenarioNext(s, ID.lead, 'blast_radius');
  const sc = s.scenario()!;
  assert.deepEqual([sc.bed, sc.step, sc.mode], ['demo', 0, 'blast_radius']);
  assert.equal(s.part('cdu-29')!.state, 'ok', 'the demo starts from a clean hall');
  assert.equal(s.part('cdu-3')!.state, 'degraded');
  assert.equal(s.decisions.length, 1);
});

test('only a shift lead or admin can run the scenario', () => {
  const s = presenter();
  assert.throws(() => scenarioNext(s, ID.tech, 'blast_radius'), /can't run the scenario/);
  assert.throws(() => scenarioStart(s, ID.lead, 'chaos'), /mode must be naive or blast_radius/);
});
