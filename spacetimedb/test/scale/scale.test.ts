// Performance limits (CLAUDE.md, DESIGN.md §7.2) on a simulated 100,000-GPU site,
// median of 20 runs. This measures the core logic over indexed lookups (the same
// lookups the SpacetimeDB tables declare), not SpacetimeDB's own overhead.
// Run with: npm run test:scale

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bootstrapAdmin,
  diagnoseFailure,
  reportNodeFailure,
  requestPlacement,
  requestWork,
  seed,
  setPartState,
} from '../../src/core/commands';
import { buildSite, scaleSpec } from '../../src/core/site';
import { ID, work } from '../helpers';
import { MemStore } from '../memstore';

const RUNS = 20;

function median(fn: (i: number) => void): number {
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    fn(i);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(RUNS / 2)];
}

function scaleStore() {
  const s = new MemStore();
  seed(s, buildSite(scaleSpec(100_000)));
  bootstrapAdmin(s, ID.admin);
  s.putActor({ identity: ID.tech, name: 'Tech', role: 'technician', rows: [] });
  s.putActor({ identity: ID.sched, name: 'Scheduler agent', role: 'scheduler_agent', rows: [] });
  s.putActor({ identity: ID.facility, name: 'Facility', role: 'facility', rows: [] });
  return s;
}

const results: [string, number, number][] = [];

test('100k-GPU site: every limit holds', () => {
  const build = median(() => scaleStore());
  const s = scaleStore();
  const nodes = s.nodes.size;
  const racks = s.racks.size;
  assert.ok(nodes >= 12_500 && racks >= 1_560, `${nodes} nodes, ${racks} racks`);

  const cdus = [...s.parts.values()].filter((p) => p.type === 'cdu').map((p) => p.id);
  const simulate = median((i) => requestWork(s, ID.tech, work('facility_work', cdus[i * 7], { dryRun: true })));
  const simulateUps = median(() => requestWork(s, ID.tech, work('facility_work', 'ups-a', { dryRun: true })));
  const lease = median((i) => requestWork(s, ID.tech, work('node_repair', s.freeNodes()[i].id)));

  const recompute = median((i) => setPartState(s, ID.facility, cdus[100], i % 2 ? 'ok' : 'degraded'));

  setPartState(s, ID.facility, cdus[40], 'degraded');
  const victim = s.rack(s.downstreamRacks(cdus[40])[0])!.nodes[0];
  reportNodeFailure(s, ID.sched, victim);
  const diagnose = median(() => diagnoseFailure(s, ID.sched, [victim]));

  const place = median(() =>
    requestPlacement(s, ID.sched, { job: 'job-train-1', needed: 1000, durationMin: 0, exclude: [], diagnosisId: 0n }),
  );
  const last = [...s.placements.values()].at(-1)!;
  assert.equal(last.nodes.length, 1000, last.reason);

  results.push(
    ['diagnose_failure, one node', diagnose, 50],
    ['safe_placement, 1,000 nodes', place, 100],
    ['simulate (CDU)', simulate, 20],
    ['request_lease (node repair)', lease, 20],
    ['state change -> incremental recompute', recompute, 50],
    ['full rebuild', build, 1000],
  );
  console.log(`\n  ${nodes.toLocaleString()} nodes, ${racks.toLocaleString()} racks, ${s.parts.size} parts (median of ${RUNS})`);
  for (const [name, ms, limit] of results) console.log(`  ${name.padEnd(40)} ${ms.toFixed(2).padStart(8)} ms   (limit ${limit} ms)`);
  console.log(`  ${'simulate (UPS-A, every rack below it)'.padEnd(40)} ${simulateUps.toFixed(2).padStart(8)} ms   (worst case, no limit)`);
  for (const [name, ms, limit] of results) assert.ok(ms <= limit, `${name}: ${ms.toFixed(2)} ms > ${limit} ms`);
});
