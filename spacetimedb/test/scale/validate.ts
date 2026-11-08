// Validates the scale demo's numbers (test/scale/demo.ts) two independent ways:
//   1. Timing: batch timing (N calls, one clock read) must agree with the per-call
//      median, so the result isn't timer resolution or noise.
//   2. Answers: every fast answer is compared with a brute-force oracle that scans the
//      whole facility and recomputes every rack's backup from scratch. Fast and wrong
//      would fail here.
// Run: npx tsx test/scale/validate.ts   (the scale demo runs it too and shows the result)

import { diagnoseFailure, reportNodeFailure, requestPlacement, setPartState } from '../../src/core/commands';
import { computeMargin } from '../../src/core/margins';
import { buildSite, scaleSpec } from '../../src/core/site';
import { bootstrapAdmin, seed } from '../../src/core/commands';
import { ID } from '../helpers';
import { MemStore } from '../memstore';
import { fileURLToPath } from 'node:url';

const GPUS = 100_000;
function store() {
  const s = new MemStore();
  seed(s, buildSite(scaleSpec(GPUS)));
  bootstrapAdmin(s, ID.admin);
  s.putActor({ identity: ID.sched, name: 'Scheduler agent', role: 'scheduler_agent', rows: [] });
  s.putActor({ identity: ID.facility, name: 'Facility', role: 'facility', rows: [] });
  return s;
}
function rng(seed: number) {
  let x = seed;
  return () => ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), (x >>> 0) / 2 ** 32);
}

// ---------------------------------------------------------------- 1. timing cross-check
export function validateTiming() {
  const s = store();
  const cdus = [...s.parts.values()].filter((p) => p.type === 'cdu').map((p) => p.id);
  const cause = cdus[150];
  setPartState(s, ID.facility, cause, 'degraded');
  const victim = s.rack(s.downstreamRacks(cause)[0])!.nodes[0];
  reportNodeFailure(s, ID.sched, victim);
  const before = s.diagnoses.size;
  const N = 20_000;
  for (let i = 0; i < 1000; i++) diagnoseFailure(s, ID.sched, [victim]);
  const per: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const t = performance.now();
    diagnoseFailure(s, ID.sched, [victim]);
    per.push(performance.now() - t);
  }
  per.sort((a, b) => a - b);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) diagnoseFailure(s, ID.sched, [victim]);
  const batch = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  const did = s.diagnoses.size - before;
  console.log(`diagnose_failure at 100k: per-call median ${(per[1000] * 1000).toFixed(1)} µs, batch average ${(batch * 1000).toFixed(1)} µs over ${N.toLocaleString()} calls`);
  console.log(`  each call wrote a diagnosis row, a decision row and an audit row: ${did.toLocaleString()} diagnoses written (expected ${(N + 3000).toLocaleString()})`);

  const p0 = process.hrtime.bigint();
  const P = 500;
  for (let i = 0; i < P; i++) requestPlacement(s, ID.sched, { job: 'job-train-1', needed: 1000, durationMin: 0, exclude: [], diagnosisId: 0n });
  const placementBatch = Number(process.hrtime.bigint() - p0) / 1e6 / P;
  console.log(`safe_placement (1,000 nodes) at 100k: batch average ${placementBatch.toFixed(2)} ms over ${P} calls`);
  return { diagnosePerCallMs: per[1000], diagnoseBatchMs: batch, batchCalls: N, rowsWritten: did, rowsExpected: N + 3000, placementBatchMs: placementBatch, placementCalls: P };
}

// ---------------------------------------------------------------- 2. oracle
/** Brute force: scan every rack, recompute every margin from scratch, no indexes. */
function oracle(s: MemStore) {
  const working = (p: string) => {
    const part = s.parts.get(p);
    return !!part && part.state === 'ok' && part.heldBy === 0n;
  };
  const rackOk = new Map<string, boolean>();
  const racksUnder = new Map<string, string[]>();
  for (const r of s.racks.values()) {
    const above = [...r.powerFeeds.flat(), ...r.coolingFeeds.flat(), ...r.network];
    for (const p of above) (racksUnder.get(p) ?? racksUnder.set(p, []).get(p)!).push(r.id);
    const m = computeMargin(r, working, 0);
    rackOk.set(r.id, above.every(working) && m.margin >= 1);
  }
  const eligible = new Set<string>();
  for (const n of s.nodes.values()) if (n.ownerKind === 'free' && n.state === 'ok' && n.heldBy === 0n && rackOk.get(n.rack)) eligible.add(n.id);
  return { eligible, racksUnder };
}

export function validateOracle(trials = 300) {
  const s = store();
  const rand = rng(7);
  const parts = [...s.parts.values()].filter((p) => ['cdu', 'pdu', 'leaf'].includes(p.type));
  const jobNodes = s.nodesOwnedBy('job-train-1').map((n) => n.id);
  let checked = 0;
  const fails: string[] = [];
  for (let trial = 0; trial < trials; trial++) {
    // Break 1-3 random parts somewhere in the site, then fail a job node under one of them.
    const broken = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => parts[Math.floor(rand() * parts.length)].id);
    for (const p of broken) setPartState(s, ID.facility, p, 'degraded');
    const { eligible, racksUnder } = oracle(s);
    const underJob = broken.filter((p) => (racksUnder.get(p) ?? []).some((r) => s.racks.get(r)!.nodes.some((n) => s.nodes.get(n)!.ownerId === 'job-train-1')));
    const cause = underJob[0];
    const victim = cause
      ? s.racks.get(racksUnder.get(cause)!.find((r) => s.nodes.get(s.racks.get(r)!.nodes[0])!.ownerId === 'job-train-1')!)!.nodes[0]
      : jobNodes[Math.floor(rand() * jobNodes.length)];
    const victimRow = s.nodes.get(victim)!;
    if (victimRow.ownerId !== 'job-train-1') { for (const p of broken) setPartState(s, ID.facility, p, 'ok'); continue; }
    reportNodeFailure(s, ID.sched, victim);
    const d = s.diagnosis(diagnoseFailure(s, ID.sched, [victim]))!;

    // Oracle diagnosis: broken parts above the victim; the expected cause is one of them;
    // at-risk = every other running job node under that cause, found by a full scan.
    const rack = s.racks.get(victimRow.rack)!;
    const above = new Set([...rack.powerFeeds.flat(), ...rack.coolingFeeds.flat(), ...rack.network]);
    const brokenAbove = [...new Set(broken)].filter((p) => above.has(p));
    if (brokenAbove.length === 0) {
      if (d.classification !== 'isolated') fails.push(`trial ${trial}: expected isolated, got ${d.cause}`);
    } else {
      if (!brokenAbove.includes(d.cause)) fails.push(`trial ${trial}: cause ${d.cause} not among broken parts above ${victim}: ${brokenAbove}`);
      const want = new Set<string>();
      for (const n of s.nodes.values()) if (n.id !== victim && n.ownerId === 'job-train-1' && n.state !== 'failed' && above.has(d.cause) && racksUnder.get(d.cause)!.includes(n.rack)) want.add(n.id);
      const got = new Set(d.atRisk);
      if (want.size !== got.size || [...want].some((n) => !got.has(n))) fails.push(`trial ${trial}: at-risk ${got.size} vs oracle ${want.size}`);
    }

    // Oracle placement: every chosen node must be eligible by the full scan, and there's
    // a shortfall only if the oracle also finds too few.
    const pl = s.placement(requestPlacement(s, ID.sched, { job: 'job-train-1', needed: 1000, durationMin: 0, exclude: [], diagnosisId: d.id }))!;
    const excluded = new Set([...d.nodes, ...d.atRisk]);
    const okCount = [...eligible].filter((n) => !excluded.has(n)).length;
    const bad = pl.nodes.filter((n) => !eligible.has(n) || excluded.has(n));
    if (bad.length) fails.push(`trial ${trial}: placed ${bad.length} unsafe nodes, e.g. ${bad[0]}`);
    if ((pl.shortfall > 0) !== (okCount < 1000)) fails.push(`trial ${trial}: shortfall ${pl.shortfall}, oracle has ${okCount} safe`);
    if (pl.nodes.length + pl.shortfall !== 1000) fails.push(`trial ${trial}: ${pl.nodes.length} + ${pl.shortfall} != 1000`);

    checked++;
    for (const p of broken) setPartState(s, ID.facility, p, 'ok');
    s.putNode({ ...s.nodes.get(victim)!, state: 'ok' });
    s.putJob({ ...s.job('job-train-1')!, status: 'running' });
    s.setNow(s.now() + 180);
  }
  console.log(`\noracle: ${checked} random incidents at 100k GPUs, fast answers vs a full-facility brute-force scan: ${fails.length ? `${fails.length} MISMATCHES` : 'all agree'}`);
  for (const f of fails.slice(0, 10)) console.log('  ' + f);
  return { incidents: checked, mismatches: fails.length, examples: fails.slice(0, 5) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  validateTiming();
  if (validateOracle().mismatches) process.exitCode = 1;
}
