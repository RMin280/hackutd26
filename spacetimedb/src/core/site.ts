// Facility generator. The demo hall is the same layout and the same IDs as
// frontend/src/mock/site.ts (DESIGN.md §3.4), so the scenario lines up:
//   cdu-3 cools rack-r1-11 .. rack-r1-15 (backup cdu-4), and backs nobody
//   node-417 .. node-424 live in rack-r1-12
//   job-train-1 holds the first 1,000 nodes (Rows 1–8), 160 free spares in Rows 9–10
// New here: hot aisles. Rows pair up back-to-back around an enclosed hot aisle
// (frontend/src/scene/layout.ts), so ha-1 = Rows 1–2, ha-2 = Rows 3–4, ...

import type { AisleRow, JobRow, NodeRow, PartRow, PartType, RackRow, SiteData } from './types';

export interface SiteSpec {
  rows: number;
  racksPerRow: number;
  nodesPerRack: number;
  racksPerCdu: number;
  rowsPerSpine: number;
  jobId: string;
  jobSize: number;
  spareRows: number; // last rows hold tenant-gamma (slots 0-2) and free spares
}

export const DEMO_HALL: SiteSpec = {
  rows: 10,
  racksPerRow: 16,
  nodesPerRack: 8,
  racksPerCdu: 5,
  rowsPerSpine: 5,
  jobId: 'job-train-1',
  jobSize: 1000,
  spareRows: 2,
};

/** ~8 GPUs per node, 8 nodes per rack, 16 racks per row, an even number of rows. */
export function scaleSpec(gpus: number): SiteSpec {
  const nodes = Math.ceil(gpus / 8);
  const racks = Math.ceil(nodes / 8);
  let rows = Math.ceil(racks / 16);
  if (rows % 2) rows++;
  const spareRows = Math.max(2, Math.round(rows * 0.2));
  const jobRows = rows - spareRows;
  return {
    rows,
    racksPerRow: 16,
    nodesPerRack: 8,
    racksPerCdu: 5,
    rowsPerSpine: 5,
    jobId: 'job-train-1',
    jobSize: Math.floor(jobRows * 16 * 8 * 0.9),
    spareRows,
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');
export const rackId = (row: number, pos: number) => `rack-r${row}-${pad2(pos)}`;
export const aisleOfRow = (row: number) => `ha-${Math.ceil(row / 2)}`;

/** Backup CDU for each primary: a neighbour, chosen so CDU-4 backs CDU-3 and CDU-3 backs nobody. */
export function backupCdu(primary: number, cduCount: number): number {
  const m = primary % 4;
  if (m === 2) return primary - 1;
  if (primary === cduCount) return primary - 1;
  return primary + 1; // m = 1, 3, 0
}

const chillerFor = (cdu: number) => (cdu % 2 === 1 ? 'chiller-1' : 'chiller-2');

export function buildSite(spec: SiteSpec = DEMO_HALL): SiteData {
  const { rows, racksPerRow, nodesPerRack, racksPerCdu, rowsPerSpine } = spec;
  const totalRacks = rows * racksPerRow;
  const cduCount = Math.ceil(totalRacks / racksPerCdu);
  const spineCount = Math.ceil(rows / rowsPerSpine);

  // node-417..424 go into rack-r1-12 (global rack 11) by swapping with rack 52.
  const swapA = 11;
  const swapB = (417 - 1) / 8; // 52
  const swap = nodesPerRack === 8 && totalRacks > swapB;
  const nodeBase = (g: number) => {
    let x = g;
    if (swap && x === swapA) x = swapB;
    else if (swap && x === swapB) x = swapA;
    return x * nodesPerRack + 1;
  };

  const parts: PartRow[] = [];
  const seen = new Set<string>();
  const addPart = (id: string, type: PartType, rowNum = 0) => {
    if (seen.has(id)) return;
    seen.add(id);
    parts.push({ id, type, rowNum, ord: parts.length, state: 'ok', heldBy: 0n });
  };
  for (const side of ['a', 'b']) {
    addPart(`util-${side}`, 'utility');
    addPart(`switchgear-${side}`, 'switchgear');
    addPart(`ups-${side}`, 'ups');
  }
  addPart('chiller-1', 'chiller');
  addPart('chiller-2', 'chiller');
  for (let s = 1; s <= spineCount; s++) addPart(`sw-spine-${s}`, 'spine');
  for (let c = 1; c <= cduCount; c++) {
    const firstRack = (c - 1) * racksPerCdu;
    addPart(`cdu-${c}`, 'cdu', Math.floor(firstRack / racksPerRow) + 1);
  }

  const aisles: AisleRow[] = [];
  for (let a = 1; a <= Math.ceil(rows / 2); a++) {
    const aRows = [2 * a - 1, 2 * a].filter((r) => r <= rows);
    aisles.push({ id: `ha-${a}`, kind: 'hot', rows: aRows, ord: a - 1, heldBy: 0n });
  }

  const racks: RackRow[] = [];
  const nodes: NodeRow[] = [];
  for (let row = 1; row <= rows; row++) {
    addPart(`pdu-r${row}-a`, 'pdu', row);
    addPart(`pdu-r${row}-b`, 'pdu', row);
    addPart(`sw-leaf-r${row}`, 'leaf', row);
    for (let pos = 1; pos <= racksPerRow; pos++) {
      const g = (row - 1) * racksPerRow + (pos - 1);
      const id = rackId(row, pos);
      const primary = Math.floor(g / racksPerCdu) + 1;
      const backup = backupCdu(primary, cduCount);
      const base = nodeBase(g);
      const rackNodes: string[] = [];
      for (let slot = 0; slot < nodesPerRack; slot++) {
        const nid = `node-${base + slot}`;
        rackNodes.push(nid);
        nodes.push({
          id: nid,
          rack: id,
          rowNum: row,
          slot,
          ord: nodes.length,
          state: 'ok',
          ownerKind: 'free',
          ownerId: '',
          heldBy: 0n,
        });
      }
      racks.push({
        id,
        rowNum: row,
        pos,
        aisle: aisleOfRow(row),
        ord: g,
        powerFeeds: [
          [`pdu-r${row}-a`, 'ups-a', 'switchgear-a', 'util-a'],
          [`pdu-r${row}-b`, 'ups-b', 'switchgear-b', 'util-b'],
        ],
        coolingFeeds: [
          [`cdu-${primary}`, chillerFor(primary)],
          [`cdu-${backup}`, chillerFor(backup)],
        ],
        network: [`sw-leaf-r${row}`, `sw-spine-${Math.ceil(row / rowsPerSpine)}`],
        nodes: rackNodes,
      });
    }
  }

  // downstream[part] = racks fed by it (DESIGN.md §3.3), built once.
  const downstream: { part: string; rack: string }[] = [];
  for (const r of racks) {
    const above = new Set<string>();
    for (const chain of [...r.powerFeeds, ...r.coolingFeeds, r.network]) for (const p of chain) above.add(p);
    for (const p of above) downstream.push({ part: p, rack: r.id });
  }

  // Owners: the job takes the first jobSize nodes outside the spare rows, tenant-beta
  // the rest of those rows; spare rows hold tenant-gamma in slots 0-2 and free spares.
  const lastJobRow = rows - spec.spareRows;
  let jobCount = 0;
  for (const n of nodes) {
    if (n.rowNum <= lastJobRow) {
      if (jobCount < spec.jobSize) {
        n.ownerKind = 'job';
        n.ownerId = spec.jobId;
        jobCount++;
      } else {
        n.ownerKind = 'tenant';
        n.ownerId = 'tenant-beta';
      }
    } else if (n.slot < 3) {
      n.ownerKind = 'tenant';
      n.ownerId = 'tenant-gamma';
    }
  }
  const jobs: JobRow[] = [
    { id: spec.jobId, status: 'running', size: jobCount, nodes: jobCount, restarts: 0, crashes: 0 },
  ];

  return { parts, aisles, racks, nodes, downstream, jobs };
}
