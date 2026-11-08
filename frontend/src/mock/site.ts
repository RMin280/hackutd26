// Generates the demo hall described in DESIGN.md §3.4:
// 10 rows x 16 racks x 8 nodes = 1,280 nodes, power A/B per row, one leaf per row,
// each CDU primary for 5 racks with a neighbouring CDU as backup.
//
// This is a stand-in until data/site.json (and later SpacetimeDB) exists. The
// backend should adopt the same IDs so the scenario lines up:
//   cdu-3 cools rack-r1-11 .. rack-r1-15 (backup cdu-4)
//   node-417 .. node-424 live in rack-r1-12 (so node-417 and node-422 share CDU-3)

import type { Owner, Part, PartType, Rack, NodeInfo, Site } from '../model/types';

export const ROWS = 10;
export const RACKS_PER_ROW = 16;
export const NODES_PER_RACK = 8;
export const RACKS_PER_CDU = 5;
export const CDU_COUNT = (ROWS * RACKS_PER_ROW) / RACKS_PER_CDU; // 32

export const JOB_ID = 'job-train-1';
export const JOB_SIZE = 1000;

const pad2 = (n: number) => String(n).padStart(2, '0');
export const rackId = (row: number, pos: number) => `rack-r${row}-${pad2(pos)}`;

// Rack (global index) that holds node-417..424, and the rack whose numbers it swaps with.
const SCENARIO_RACK_INDEX = 11; // rack-r1-12, second rack on CDU-3
const SWAP_RACK_INDEX = (417 - 1) / NODES_PER_RACK; // 52, would hold 417..424 by default

function nodeNumberBase(globalRack: number): number {
  let g = globalRack;
  if (g === SCENARIO_RACK_INDEX) g = SWAP_RACK_INDEX;
  else if (g === SWAP_RACK_INDEX) g = SCENARIO_RACK_INDEX;
  return g * NODES_PER_RACK + 1;
}

// Backup CDU for each primary is a neighbour, chosen so that CDU-4 backs CDU-3
// and CDU-3 backs nobody. That keeps the scenario exact: CDU-3 degrading turns
// only its own 5 racks yellow (DESIGN.md §10.2).
export function backupCdu(primary: number): number {
  const m = primary % 4;
  if (m === 2) return primary - 1;
  if (primary === CDU_COUNT) return primary - 1;
  return primary + 1; // m = 1, 3, 0
}

export function cduForRack(globalRack: number): { primary: number; backup: number } {
  const primary = Math.floor(globalRack / RACKS_PER_CDU) + 1;
  return { primary, backup: backupCdu(primary) };
}

const chillerFor = (cdu: number) => (cdu % 2 === 1 ? 'chiller-1' : 'chiller-2');

export function buildSite(): Site {
  const parts: Record<string, Part> = {};
  const addPart = (id: string, type: PartType, row?: number) => {
    if (!parts[id]) parts[id] = { id, type, row };
  };

  for (const side of ['a', 'b']) {
    addPart(`util-${side}`, 'utility');
    addPart(`switchgear-${side}`, 'switchgear');
    addPart(`ups-${side}`, 'ups');
  }
  addPart('chiller-1', 'chiller');
  addPart('chiller-2', 'chiller');
  addPart('sw-spine-1', 'spine');
  addPart('sw-spine-2', 'spine');
  for (let c = 1; c <= CDU_COUNT; c++) {
    const firstRack = (c - 1) * RACKS_PER_CDU;
    addPart(`cdu-${c}`, 'cdu', Math.floor(firstRack / RACKS_PER_ROW) + 1);
  }

  const racks: Record<string, Rack> = {};
  const rackOrder: string[] = [];
  const nodes: Record<string, NodeInfo> = {};
  const nodeOrder: string[] = [];

  for (let row = 1; row <= ROWS; row++) {
    addPart(`pdu-r${row}-a`, 'pdu', row);
    addPart(`pdu-r${row}-b`, 'pdu', row);
    addPart(`sw-leaf-r${row}`, 'leaf', row);
    for (let pos = 1; pos <= RACKS_PER_ROW; pos++) {
      const g = (row - 1) * RACKS_PER_ROW + (pos - 1);
      const id = rackId(row, pos);
      const { primary, backup } = cduForRack(g);
      const base = nodeNumberBase(g);
      const rackNodes: string[] = [];
      for (let slot = 0; slot < NODES_PER_RACK; slot++) {
        const nid = `node-${base + slot}`;
        rackNodes.push(nid);
        nodes[nid] = { id: nid, rack: id, row, slot };
        nodeOrder.push(nid);
      }
      racks[id] = {
        id,
        row,
        pos,
        powerFeeds: [
          [`pdu-r${row}-a`, 'ups-a', 'switchgear-a', 'util-a'],
          [`pdu-r${row}-b`, 'ups-b', 'switchgear-b', 'util-b'],
        ],
        coolingFeeds: [
          [`cdu-${primary}`, chillerFor(primary)],
          [`cdu-${backup}`, chillerFor(backup)],
        ],
        network: [`sw-leaf-r${row}`, row <= 5 ? 'sw-spine-1' : 'sw-spine-2'],
        nodes: rackNodes,
      };
      rackOrder.push(id);
    }
  }

  // downstream[part] = racks fed by it (precomputed, DESIGN.md §3.3)
  const downstream: Record<string, string[]> = {};
  for (const pid of Object.keys(parts)) downstream[pid] = [];
  for (const rid of rackOrder) {
    const r = racks[rid];
    const seen = new Set<string>();
    for (const chain of [...r.powerFeeds, ...r.coolingFeeds, r.network]) {
      for (const p of chain) seen.add(p);
    }
    for (const p of seen) downstream[p].push(rid);
  }

  const partOrder = Object.keys(parts);
  return { parts, partOrder, racks, rackOrder, nodes, nodeOrder, downstream };
}

// Initial ownership: job-train-1 on the first 1,000 nodes (Rows 1–8),
// tenant-beta on the rest of Row 8, tenant-gamma on 3 nodes per rack in Rows 9–10,
// everything else free (160 spares in Rows 9–10).
export function initialOwners(site: Site): Record<string, Owner> {
  const owner: Record<string, Owner> = {};
  let jobCount = 0;
  for (const rid of site.rackOrder) {
    const rack = site.racks[rid];
    rack.nodes.forEach((nid, slot) => {
      if (rack.row <= 8) {
        if (jobCount < JOB_SIZE) {
          owner[nid] = { kind: 'job', id: JOB_ID };
          jobCount++;
        } else {
          owner[nid] = { kind: 'tenant', id: 'tenant-beta' };
        }
      } else {
        owner[nid] = slot < 3 ? { kind: 'tenant', id: 'tenant-gamma' } : { kind: 'free' };
      }
    });
  }
  return owner;
}

const PART_NAMES: Record<PartType, string> = {
  utility: 'Utility feed',
  switchgear: 'Switchgear',
  ups: 'UPS',
  pdu: 'PDU',
  chiller: 'Chiller',
  cdu: 'Cooling distribution unit',
  spine: 'Spine switch',
  leaf: 'Leaf switch',
};

export const partTypeName = (t: PartType) => PART_NAMES[t];

// Display label used in reasons and cards: cdu-3 -> CDU-3, sw-leaf-r3 -> Leaf R3.
export function label(id: string): string {
  let m: RegExpMatchArray | null;
  if ((m = id.match(/^cdu-(\d+)$/))) return `CDU-${m[1]}`;
  if ((m = id.match(/^pdu-r(\d+)-([ab])$/))) return `PDU-R${m[1]}-${m[2].toUpperCase()}`;
  if ((m = id.match(/^ups-([ab])$/))) return `UPS-${m[1].toUpperCase()}`;
  if ((m = id.match(/^switchgear-([ab])$/))) return `Switchgear ${m[1].toUpperCase()}`;
  if ((m = id.match(/^util-([ab])$/))) return `Utility ${m[1].toUpperCase()}`;
  if ((m = id.match(/^chiller-(\d+)$/))) return `Chiller ${m[1]}`;
  if ((m = id.match(/^sw-leaf-r(\d+)$/))) return `Leaf R${m[1]}`;
  if ((m = id.match(/^sw-spine-(\d+)$/))) return `Spine ${m[1]}`;
  return id;
}
