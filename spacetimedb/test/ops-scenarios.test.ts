// The operations scenarios (core/scenario.ts): "Software updates" and "Maintenance window".
// Each runs end to end through the scripted actors; what it leaves in the feed is the work the
// Nemotron fixer agent picks up (agents/fixer/triage.py), so these tests check that too.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureScriptedActors, scenarioGoto, scenarioNext, scenarioStart, STEPS, type Mode } from '../src/core/scenario';
import { demo, ID } from './helpers';

function runAll(mode: Mode) {
  const s = demo();
  ensureScriptedActors(s);
  scenarioStart(s, ID.lead, mode);
  for (let i = 0; i < STEPS[mode].length; i++) scenarioNext(s, ID.lead, mode);
  return s;
}

const dataOf = (d: { data?: string }) => JSON.parse(d.data || '{}') as Record<string, unknown>;

/** What the fixer's triage would open from this feed (the rules in agents/fixer/triage.py, by event type). */
function fixerWork(s: ReturnType<typeof demo>) {
  const out: string[] = [];
  for (const d of s.decisions) {
    const data = dataOf(d);
    if (d.type === 'lease_denied' && data.routine && data.verdict === 'deny' && Array.isArray(data.blockers) && data.blockers.length) {
      out.push(`maintenance_refused:${data.target}`);
    }
    if (d.type === 'state_change' && data.kind === 'node' && (data.state === 'failed' || data.state === 'degraded')) {
      const n = s.node(d.subject)!;
      if (n.ownerKind === 'free') out.push(`broken_node:${d.subject}`);
    }
    if (d.type === 'job_status' && data.status === 'finished') {
      const held = s.workByStatus('active').filter((w) => w.kind === 'protection' && w.job === d.subject);
      for (const w of held) out.push(`stale_protection:${w.id}`);
    }
  }
  return out;
}

test('every scenario starts at T+0 with its own intro and runs to its last step', () => {
  for (const mode of ['updates', 'maintenance'] as const) {
    const s = demo();
    ensureScriptedActors(s);
    scenarioStart(s, ID.lead, mode);
    assert.equal(s.scenario()!.mode, mode);
    assert.equal(s.scenario()!.total, STEPS[mode].length);
    assert.match(s.scenario()!.caption, mode === 'updates' ? /Software updates/ : /Maintenance window/);
    for (let i = 0; i < STEPS[mode].length; i++) scenarioNext(s, ID.lead, mode);
    assert.equal(s.scenario()!.step, STEPS[mode].length - 1);
    assert.equal(s.now(), STEPS[mode].at(-1)!.at);
  }
});

test('software updates: online runs alongside the job, drain-required and switch firmware wait for it', () => {
  const s = runAll('updates');
  const verdicts = s.decisions
    .filter((d) => ['lease_granted', 'lease_denied', 'approval_requested'].includes(d.type ?? ''))
    .map((d) => `${d.actor}: ${dataOf(d).kind} ${dataOf(d).target} ${d.verdict}`);
  assert.deepEqual(verdicts, [
    'Update agent: sw_online job-train-1 allow',
    'Update agent: sw_exclusive rack-r9-04 deny',
    'Update agent: sw_exclusive node-1190 allow',
    'Network tech: sw_online node-1190 deny',
    'Network tech: switch_firmware sw-leaf-r3 deny',
  ]);
  const denied = s.workByStatus('denied');
  const leaf = denied.find((w) => w.target === 'sw-leaf-r3')!;
  assert.match(leaf.reason, /128 nodes below Leaf R3 run job-train-1/);
  assert.match(denied.find((w) => w.target === 'rack-r9-04')!.reason, /tenant-gamma/);
  assert.match(denied.find((w) => w.kind === 'sw_online')!.earliestSafe, /T\+1h36m/);
  assert.equal(s.job('job-train-1')!.status, 'finished');
  assert.equal(s.node('node-1190')!.state, 'degraded');
  assert.deepEqual(fixerWork(s), ['maintenance_refused:rack-r9-04', 'maintenance_refused:sw-leaf-r3', 'broken_node:node-1190']);
});

test('maintenance window: protection refuses the risky work, an approval lets the PDU swap go, a lease is left stale', () => {
  const s = runAll('maintenance');
  const verdicts = s.decisions
    .filter((d) => ['lease_granted', 'lease_denied', 'approval_requested'].includes(d.type ?? ''))
    .map((d) => `${d.actor}: ${dataOf(d).kind} ${dataOf(d).target} ${d.verdict}`);
  assert.deepEqual(verdicts.slice(1), [
    'Facility tech: hot_aisle_work ha-1 deny',
    'Facility tech: facility_work ups-b deny',
    'Facility tech: facility_work pdu-r10-a warn',
    'Shift lead (on call): facility_work pdu-r10-a allow',
  ]);
  const pdu = s.workByStatus('active').find((w) => w.target === 'pdu-r10-a');
  assert.ok(pdu, 'the shift lead approved the PDU swap');
  assert.equal(s.margin('rack-r10-05')!.level, 'yellow');
  assert.equal(s.node('node-1118')!.state, 'failed');
  assert.equal(s.job('job-train-1')!.status, 'finished');
  const prot = s.workByStatus('active').filter((w) => w.kind === 'protection');
  assert.equal(prot.length, 1, 'the protection lease outlives the job');
  assert.deepEqual(fixerWork(s), ['maintenance_refused:ups-b', 'broken_node:node-1118', `stale_protection:${prot[0].id}`]);
});

test('jumping to a step replays the scenario up to it', () => {
  const s = demo();
  ensureScriptedActors(s);
  scenarioGoto(s, ID.lead, 'maintenance', 4);
  assert.equal(s.scenario()!.step, 4);
  assert.equal(s.now(), 16);
  assert.ok(s.workByStatus('active').some((w) => w.target === 'pdu-r10-a'));
});
