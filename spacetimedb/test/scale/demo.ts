// Scale demo for the judges (DESIGN.md §7). Runs the real core logic on simulated
// sites from 10,000 to 200,000 GPUs and shows three things:
//   1. Latency stays flat as the site grows (median / p95 per operation).
//   2. Each request reads about the same number of rows at every size (the branch
//      it touches, not the facility).
//   3. A naive check that recomputes the whole facility per request grows with the
//      site; Squawk's doesn't. Plus a failure storm: hundreds of incidents back to back.
//
// Run: npm run demo:scale            (from spacetimedb/; or `bash dev.sh scale`)
//      npm run demo:scale -- --quick (fewer runs, sizes up to 100k)
// Writes test/scale/results/latest.json and test/scale/results/scale-report.html.
//
// Like test/scale/scale.test.ts, this measures core logic over in-memory indexes that
// match the SpacetimeDB tables' indexes; SpacetimeDB's own overhead is not included.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bootstrapAdmin,
  diagnoseFailure,
  reportNodeFailure,
  requestPlacement,
  requestWork,
  seed,
  setPartState,
} from '../../src/core/commands';
import { recomputeRacks } from '../../src/core/margins';
import { buildSite, scaleSpec } from '../../src/core/site';
import type { Store } from '../../src/core/store';
import { ID, work } from '../helpers';
import { MemStore } from '../memstore';
import { runLive, type LiveResult } from './live';
import { validateOracle, validateTiming } from './validate';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'results');
const QUICK = process.argv.includes('--quick');
const LIVE = process.argv.includes('--live'); // also measure through SpacetimeDB (bash dev.sh scale --live)
const LIVE_HOST = process.env.SQUAWK_SCALE_HOST ?? 'http://127.0.0.1:3000';
const LIVE_DB = process.env.SQUAWK_SCALE_DB ?? 'squawk-scale';
const SIZES = QUICK ? [10_000, 25_000, 50_000, 100_000] : [10_000, 25_000, 50_000, 100_000, 200_000];
const RUNS = QUICK ? 15 : 41;
const STORM = QUICK ? 200 : 500;
const HEADLINE = 100_000;

// Same limits as the scale test suite (CLAUDE.md).
const OPS = [
  { key: 'diagnose', label: 'Diagnose a failed node', api: 'diagnose_failure', limit: 50 },
  { key: 'placement', label: 'Safe restart placement (1,000 nodes)', api: 'safe_placement', limit: 100 },
  { key: 'simulate', label: 'Check an action (simulate CDU work)', api: 'simulate', limit: 20 },
  { key: 'lease', label: 'Grant a lease (node repair)', api: 'request_lease', limit: 20 },
  { key: 'recompute', label: 'State change, incremental recompute', api: 'set_part_state', limit: 50 },
] as const;
type OpKey = (typeof OPS)[number]['key'];

// ---------------------------------------------------------------- helpers

const gc = (globalThis as { gc?: () => void }).gc;

function stats(times: number[]) {
  const t = [...times].sort((a, b) => a - b);
  const q = (p: number) => t[Math.min(t.length - 1, Math.floor(p * t.length))];
  return { median: q(0.5), p95: q(0.95), p99: q(0.99), max: t[t.length - 1], runs: t.length };
}

function time(runs: number, fn: (i: number) => void) {
  for (let i = 0; i < 10; i++) fn(i); // warm up the JIT
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn(i + 10);
    times.push(performance.now() - t);
  }
  return stats(times);
}

/** Counts every row the core logic reads through the Store interface. */
const READS = new Set([
  'part', 'rack', 'node', 'aisle', 'margin', 'job', 'actor', 'work', 'diagnosis', 'placement', 'assignment', 'scenario',
  'racksInRow', 'downstreamRacks', 'nodesOwnedBy', 'freeNodes', 'workByStatus', 'claimsOn', 'failuresSince',
]);
function counting(s: MemStore): { store: Store; reads: () => number; reset: () => void } {
  let n = 0;
  const store = new Proxy(s, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== 'function' || !READS.has(String(prop))) return typeof v === 'function' ? v.bind(target) : v;
      return (...args: unknown[]) => {
        const r = v.apply(target, args);
        n += Array.isArray(r) ? r.length : r === undefined ? 0 : 1;
        return r;
      };
    },
  }) as unknown as Store;
  return { store, reads: () => n, reset: () => (n = 0) };
}

function buildStore(gpus: number) {
  const s = new MemStore();
  seed(s, buildSite(scaleSpec(gpus)));
  bootstrapAdmin(s, ID.admin);
  s.putActor({ identity: ID.tech, name: 'Tech', role: 'technician', rows: [] });
  s.putActor({ identity: ID.sched, name: 'Scheduler agent', role: 'scheduler_agent', rows: [] });
  s.putActor({ identity: ID.facility, name: 'Facility', role: 'facility', rows: [] });
  return s;
}

const placeArgs = (diagnosisId = 0n, needed = 1000) => ({ job: 'job-train-1', needed, durationMin: 0, exclude: [], diagnosisId });

// Deterministic pseudo-random (core logic stays deterministic; so does the demo).
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), (x >>> 0) / 2 ** 32);
}

// ---------------------------------------------------------------- one site size

function measureSize(gpus: number) {
  gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const build = time(QUICK ? 3 : 7, () => buildStore(gpus));
  const s = buildStore(gpus);
  gc?.();
  const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 2 ** 20;

  const site = { gpus, nodes: s.nodes.size, racks: s.racks.size, parts: s.parts.size, freeNodes: s.freeNodes().length, jobNodes: s.job('job-train-1')!.nodes };
  const cdus = [...s.parts.values()].filter((p) => p.type === 'cdu').map((p) => p.id);
  const free = s.freeNodes().map((n) => n.id);
  // 1,000 nodes where the site has the spares; small sites ask for 75% of theirs.
  const needed = Math.min(1000, Math.floor(free.length * 0.75));

  // A degraded CDU under the job, and a failed node below it: the hero scenario.
  const cause = cdus[Math.floor(cdus.length * 0.3)];
  const toggle = cdus[Math.floor(cdus.length * 0.6)];
  setPartState(s, ID.facility, cause, 'degraded');
  const victim = s.rack(s.downstreamRacks(cause)[0])!.nodes[0];
  reportNodeFailure(s, ID.sched, victim);

  const lat: Record<OpKey, ReturnType<typeof stats>> = {
    diagnose: time(RUNS, () => diagnoseFailure(s, ID.sched, [victim])),
    placement: time(RUNS, () => requestPlacement(s, ID.sched, placeArgs(0n, needed))),
    simulate: time(RUNS, (i) => requestWork(s, ID.tech, work('facility_work', cdus[(i * 7) % cdus.length], { dryRun: true }))),
    lease: time(RUNS, (i) => requestWork(s, ID.tech, work('node_repair', free[i % free.length]))),
    // One CDU toggled every run, so every call really changes state (and recomputes its racks).
    recompute: time(RUNS, (i) => setPartState(s, ID.facility, toggle, i % 2 ? 'ok' : 'degraded')),
  };
  const lastPlacement = [...s.placements.values()].at(-1)!;
  if (lastPlacement.nodes.length !== needed) throw new Error(`placement at ${gpus}: ${lastPlacement.reason}`);
  const lastDiag = [...s.diagnoses.values()].at(-1)!;

  // Rows read per request (one counted call each, on a fresh copy of the same state).
  const c = counting(buildStore(gpus));
  const cs = c.store;
  setPartState(cs, ID.facility, cause, 'degraded');
  reportNodeFailure(cs, ID.sched, victim);
  const freeC = cs.freeNodes().map((n) => n.id);
  const reads = {} as Record<OpKey, number>;
  const count = (k: OpKey, fn: () => void) => (c.reset(), fn(), (reads[k] = c.reads()));
  count('diagnose', () => diagnoseFailure(cs, ID.sched, [victim]));
  count('placement', () => requestPlacement(cs, ID.sched, placeArgs(0n, needed)));
  count('simulate', () => requestWork(cs, ID.tech, work('facility_work', cdus[7], { dryRun: true })));
  count('lease', () => requestWork(cs, ID.tech, work('node_repair', freeC[1])));
  count('recompute', () => setPartState(cs, ID.facility, cdus[18], 'degraded'));

  // Naive baseline: the same action check, but with every rack's backup recomputed
  // first, as a system without the downstream index has to.
  const allRacks = [...s.racks.keys()];
  const naive = time(RUNS, (i) => {
    recomputeRacks(s, allRacks);
    requestWork(s, ID.tech, work('facility_work', cdus[(i * 7) % cdus.length], { dryRun: true }));
  });

  return {
    site,
    placementNeeded: needed,
    heapMb: Math.round(heapMb),
    build,
    latency: lat,
    reads,
    naiveSimulate: naive,
    sample: {
      diagnosis: { node: victim, classification: lastDiag.classification, cause: lastDiag.cause, atRisk: lastDiag.atRisk.length, reason: lastDiag.reason },
      placement: { nodes: lastPlacement.nodes.length, reason: lastPlacement.reason },
    },
  };
}

// ---------------------------------------------------------------- failure storm

/** Incidents back to back at the headline size: node fails -> diagnose -> placement. */
function storm(gpus: number, incidents: number) {
  const s = buildStore(gpus);
  const rand = rng(2026);
  const cdus = [...s.parts.values()].filter((p) => p.type === 'cdu').map((p) => p.id);
  const jobNodes = s.nodesOwnedBy('job-train-1').map((n) => n.id);
  const jobCdus = cdus.filter((c) => s.downstreamRacks(c).some((r) => s.node(s.rack(r)!.nodes[0])?.ownerId === 'job-train-1'));
  const times: number[] = [];
  let shared = 0;
  let placed = 0;
  const t0 = performance.now();
  for (let i = 0; i < incidents; i++) {
    const sharedCause = rand() < 0.5;
    const cause = jobCdus[Math.floor(rand() * jobCdus.length)];
    const victim = sharedCause
      ? s.rack(s.downstreamRacks(cause)[Math.floor(rand() * 2)])!.nodes[Math.floor(rand() * 8)]
      : jobNodes[Math.floor(rand() * jobNodes.length)];
    const t = performance.now();
    if (sharedCause) setPartState(s, ID.facility, cause, 'degraded');
    reportNodeFailure(s, ID.sched, victim);
    const d = diagnoseFailure(s, ID.sched, [victim]);
    const row = s.diagnosis(d)!;
    const p = requestPlacement(s, ID.sched, placeArgs(d, 1 + row.atRisk.length));
    times.push(performance.now() - t);
    if (row.classification === 'shared_cause') shared++;
    if (s.placement(p)!.shortfall === 0) placed++;
    // Repair and move on, outside the timed part: the next incident starts clean.
    if (sharedCause) setPartState(s, ID.facility, cause, 'ok');
    s.putNode({ ...s.node(victim)!, state: 'ok' });
    s.putJob({ ...s.job('job-train-1')!, status: 'running' });
    s.setNow(s.now() + 180);
  }
  const wall = performance.now() - t0;
  const st = stats(times);
  // Meta, Llama 3: 419 unexpected interruptions in 54 days on 16,384 GPUs.
  const perDay = (419 / 54) * (gpus / 16_384);
  return {
    gpus,
    incidents,
    sharedCause: shared,
    placedInFull: placed,
    latency: st,
    perSecond: Math.round(1000 / (st.median || 1e-6)),
    wallMs: Math.round(wall),
    metaRatePerDay: Math.round(perDay * 10) / 10,
  };
}

// ---------------------------------------------------------------- report

const ms = (x: number) => (x < 0.1 ? x.toFixed(3) : x < 10 ? x.toFixed(2) : x.toFixed(1));
const int = (x: number) => Math.round(x).toLocaleString('en-US');

async function main() {
  console.log(`\n  Squawk scale demo: ${SIZES.map((g) => `${g / 1000}k`).join(', ')} GPUs, ${RUNS} runs per operation${gc ? '' : '  (run with --expose-gc for memory numbers)'}\n`);
  const sizes = [];
  for (const g of SIZES) {
    const r = measureSize(g);
    sizes.push(r);
    const p = r.latency;
    console.log(
      `  ${(g / 1000 + 'k GPUs').padEnd(10)} ${int(r.site.nodes).padStart(6)} nodes ${int(r.site.racks).padStart(6)} racks  ` +
        `diagnose ${ms(p.diagnose.median).padStart(6)} ms  placement ${ms(p.placement.median).padStart(6)} ms  ` +
        `simulate ${ms(p.simulate.median).padStart(6)} ms  (naive ${ms(r.naiveSimulate.median).padStart(6)} ms)  build ${ms(r.build.median)} ms`,
    );
  }

  const head = sizes.find((r) => r.site.gpus === HEADLINE)!;
  console.log(`\n  At ${int(HEADLINE)} GPUs (${int(head.site.nodes)} nodes, ${int(head.site.racks)} racks, ${int(head.site.parts)} facility parts):\n`);
  console.log(`  ${'Operation'.padEnd(40)} ${'median'.padStart(9)} ${'p95'.padStart(9)}  ${'limit'.padStart(7)}  rows read`);
  let ok = true;
  for (const o of OPS) {
    const l = head.latency[o.key];
    const pass = l.p95 <= o.limit;
    ok &&= pass;
    console.log(`  ${o.label.padEnd(40)} ${ms(l.median).padStart(6)} ms ${ms(l.p95).padStart(6)} ms  ${String(o.limit).padStart(4)} ms  ${int(head.reads[o.key]).padStart(6)}  ${pass ? 'PASS' : 'FAIL'}`);
  }
  const buildPass = head.build.median <= 1000;
  ok &&= buildPass;
  console.log(`  ${'Full rebuild of the site'.padEnd(40)} ${ms(head.build.median).padStart(6)} ms ${ms(head.build.p95).padStart(6)} ms  ${'1000'.padStart(4)} ms  ${'-'.padStart(6)}  ${buildPass ? 'PASS' : 'FAIL'}`);

  const st = storm(HEADLINE, STORM);
  console.log(
    `\n  Failure storm at ${int(HEADLINE)} GPUs: ${st.incidents} incidents (fail -> diagnose -> placement), ` +
      `median ${ms(st.latency.median)} ms, p99 ${ms(st.latency.p99)} ms, ${int(st.perSecond)} incidents/s.\n` +
      `  At Meta's Llama 3 failure rate this site sees ~${st.metaRatePerDay} interruptions a day.\n`,
  );
  console.log(`  "${head.sample.diagnosis.reason}"`);
  console.log(`  "${head.sample.placement.reason}"\n`);

  console.log('  Validation: is the timing real, and are the fast answers right?');
  const timing = validateTiming();
  const oracle = validateOracle(QUICK ? 100 : 300);
  ok &&= oracle.mismatches === 0;

  let live: LiveResult | null = null;
  if (LIVE) {
    live = await runLive(LIVE_HOST, LIVE_DB, HEADLINE);
    for (const o of OPS) {
      const l = live.ops.find((x) => x.key === o.key);
      if (l && l.p95 > o.limit) {
        ok = false;
        console.log(`  LIMIT FAILED through SpacetimeDB: ${o.label} p95 ${ms(l.p95)} ms > ${o.limit} ms`);
      }
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    machine: { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, memGb: Math.round(totalmem() / 2 ** 30), node: process.version, platform: process.platform },
    runs: RUNS,
    headline: HEADLINE,
    ops: OPS,
    sizes,
    storm: st,
    live,
    validation: { timing, oracle },
    pass: ok,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'latest.json'), JSON.stringify(result, null, 2));
  const tpl = readFileSync(join(HERE, 'report.html'), 'utf8');
  writeFileSync(join(OUT, 'scale-report.html'), tpl.replace('/*__SCALE_DATA__*/null', JSON.stringify(result)));
  console.log(`  Wrote ${join('test/scale/results', 'latest.json')} and scale-report.html. ${ok ? 'Every limit holds.' : 'A LIMIT FAILED.'}\n`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`\n  ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
