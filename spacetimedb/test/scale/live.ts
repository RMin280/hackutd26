// The scale demo's second layer: the same operations through a real SpacetimeDB server,
// as an agent sees them (HTTP round trip, one transaction per call, rows committed).
// `bash dev.sh scale --live` publishes the module as its own database (squawk-scale, so
// the 100k seed never touches the demo hall), then:
//   node --import tsx test/scale/live.ts identity <host>   new identity; token kept in results/
//   (dev.sh registers that identity as admin with the CLI)
//   npm run demo:scale -- --live                            measures and adds it to the report

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(HERE, 'results', '.live-identity.json'); // results/ is gitignored

export interface LiveOp {
  key: string;
  label: string;
  median: number;
  p95: number;
  runs: number;
}
export interface LiveResult {
  host: string;
  db: string;
  gpus: number;
  site: { nodes: number; racks: number; parts: number };
  seedMs: number;
  ops: LiveOp[];
  checks: { diagnosesWritten: number; expected: number; cause: string; classification: string; placementShortfall: number; placementNodes: number };
}

async function post(url: string, body: string, token?: string, json = true) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': json ? 'application/json' : 'text/plain', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body,
  });
  return { status: r.status, text: await r.text() };
}

export async function runLive(host: string, db: string, gpus: number): Promise<LiveResult> {
  if (!existsSync(TOKEN_FILE)) throw new Error('No live identity yet: run `bash dev.sh scale --live`.');
  const { token } = JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as { token: string };
  const base = `${host.replace(/\/$/, '')}/v1/database/${db}`;

  const call = async (reducer: string, args: unknown[], mayRefuse = false) => {
    const t = performance.now();
    const r = await post(`${base}/call/${reducer}`, JSON.stringify(args), token);
    const ms = performance.now() - t;
    if (r.status !== 200 && !mayRefuse) throw new Error(`${reducer} -> ${r.status}: ${r.text.slice(0, 300)}`);
    return ms;
  };
  const sql = async (q: string): Promise<unknown[][]> => {
    const r = await post(`${base}/sql`, q, token, false);
    if (r.status !== 200) throw new Error(`sql ${q} -> ${r.status}: ${r.text.slice(0, 300)}`);
    return (JSON.parse(r.text) as { rows: unknown[][] }[])[0].rows;
  };
  const count = async (table: string) => Number((await sql(`SELECT COUNT(*) AS n FROM ${table}`))[0][0]);
  const bench = async (key: string, label: string, runs: number, fn: (i: number) => Promise<number>): Promise<LiveOp> => {
    for (let i = 0; i < 3; i++) await fn(i);
    const ts: number[] = [];
    for (let i = 0; i < runs; i++) ts.push(await fn(i + 3));
    ts.sort((a, b) => a - b);
    const op = { key, label, median: ts[Math.floor(runs / 2)], p95: ts[Math.min(runs - 1, Math.floor(runs * 0.95))], runs };
    console.log(`  ${label.padEnd(44)} ${op.median.toFixed(2).padStart(7)} ms   p95 ${op.p95.toFixed(2).padStart(7)} ms`);
    return op;
  };

  const seedMs = await call('seed_scale_site', [gpus]);
  const site = { nodes: await count('node'), racks: await count('rack'), parts: await count('part') };
  const cdus = (await sql(`SELECT id FROM part WHERE type = 'cdu'`)).map((r) => String(r[0]));
  const cause = cdus[Math.floor(cdus.length * 0.3)];
  const rack = String((await sql(`SELECT rack FROM downstream WHERE part = '${cause}'`))[0][0]);
  const victim = String((await sql(`SELECT id FROM node WHERE rack = '${rack}'`))[0][0]);
  await call('set_part_state', [cause, 'degraded']);
  await call('report_node_failure', [victim]);

  console.log(`\n  Through SpacetimeDB (${host}, database ${db}), ${gpus.toLocaleString('en-US')} GPUs, HTTP round trip per call:`);
  const d0 = await count('diagnosis');
  const ops: LiveOp[] = [];
  ops.push(await bench('floor', 'Empty round trip (reducer refuses at once)', 50, () => call('claim_admin', ['x'], true)));
  ops.push(await bench('diagnose', 'Diagnose a failed node', 50, () => call('diagnose_failure', [[victim]])));
  ops.push(await bench('placement', 'Safe restart placement (1,000 nodes)', 30, () => call('safe_placement', ['job-train-1', 1000, 0, [], 0])));
  ops.push(await bench('simulate', 'Check an action (simulate CDU work)', 50, (i) => call('request_work', ['facility_work', cdus[(i * 7) % cdus.length], 0, 0, true, '', false, '', ''])));
  ops.push(await bench('lease', 'Grant a lease (node repair)', 50, (i) => call('request_work', ['node_repair', `node-${12_000 + (i % 500)}`, 0, 0, false, '', false, '', ''])));
  const toggle = cdus[Math.floor(cdus.length * 0.6)];
  ops.push(await bench('recompute', 'State change, incremental recompute', 50, (i) => call('set_part_state', [toggle, i % 2 ? 'ok' : 'degraded'])));

  const d1 = await count('diagnosis');
  const diags = await sql('SELECT classification, cause FROM diagnosis');
  const last = diags[diags.length - 1];
  const pls = await sql('SELECT shortfall, nodes FROM placement');
  const pl = pls[pls.length - 1];
  const checks = {
    diagnosesWritten: d1 - d0,
    expected: 53,
    classification: String(last[0]),
    cause: String(last[1]),
    placementShortfall: Number(pl[0]),
    placementNodes: (pl[1] as unknown[]).length,
  };
  console.log(`  checks: ${checks.diagnosesWritten}/${checks.expected} diagnoses committed, last says ${checks.classification} ${checks.cause} (injected ${cause}); placement ${checks.placementNodes} nodes, shortfall ${checks.placementShortfall}`);
  if (checks.diagnosesWritten !== checks.expected || checks.cause !== cause || checks.placementShortfall !== 0) throw new Error('live checks failed');
  return { host, db, gpus, site, seedMs, ops, checks };
}

// CLI: `identity <host>` makes a fresh identity for the live run and prints its hex.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === 'identity') {
  const host = process.argv[3] ?? 'http://127.0.0.1:3000';
  const r = await post(`${host.replace(/\/$/, '')}/v1/identity`, '{}');
  if (r.status !== 200) throw new Error(`identity -> ${r.status}: ${r.text}`);
  const d = JSON.parse(r.text) as { identity: string; token: string };
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify(d), { mode: 0o600 });
  console.log(d.identity);
}
