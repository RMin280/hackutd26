// Diagnostics test bed: the demo hall with five incidents, for testing diagnostic agents.
// A fresh database starts here (init). Each incident is a known case with the answer the
// deterministic engine gives, kept in the private `incident` table so a grader can score
// an agent that only sees what an operator sees (failed nodes, part states, the feed).
//
//   T+20m   node-1007 fails (tenant-beta, Row 8)              <- outside the 2 h window at T+3h
//   T+30m   CDU-3 degraded                                     #1 cooling
//   T+45m   CDU-29 failed                                      #5 tenant node
//   T+1h05m node-660 fails (Row 6)                             #3 network, no alarm
//   T+1h40m PDU-R4-B failed                                    #2 power
//   T+2h10m node-427 fails (Row 4)                             #2
//   T+2h30m node-1153 fails (tenant-gamma, under CDU-29)       #5
//   T+2h40m node-417 fails (under CDU-3)                       #1
//   T+2h50m node-731 fails (Row 6, same leaf as node-660)      #3
//   T+2h55m node-923 fails (Row 8, same leaf as node-1007)     #4 isolated
//   T+3h    now

import { advanceTo, bootstrapAdmin, reportNodeFailure, setPartState, seed } from './commands';
import { ensureScriptedActors, requirePresenter, SCRIPTED, setReady } from './scenario';
import { buildSite, DEMO_HALL } from './site';
import type { Store } from './store';
import type { IncidentRow } from './types';

export const LAB_NOW = 180;

export const LAB_CAPTION =
  'Diagnostics test bed: 5 incidents in Hall A (cooling, power, network, an isolated node and a tenant node). Diagnose the failed nodes, or press Space to run the demo scenario instead.';

type Event = { at: number; part: string; state: string } | { at: number; node: string };

const TIMELINE: Event[] = [
  { at: 20, node: 'node-1007' }, // rack-r8-14, tenant-beta
  { at: 30, part: 'cdu-3', state: 'degraded' },
  { at: 45, part: 'cdu-29', state: 'failed' },
  { at: 65, node: 'node-660' }, // rack-r6-03
  { at: 100, part: 'pdu-r4-b', state: 'failed' },
  { at: 130, node: 'node-427' }, // rack-r4-06
  { at: 150, node: 'node-1153' }, // rack-r10-01, tenant-gamma
  { at: 160, node: 'node-417' }, // rack-r1-12
  { at: 170, node: 'node-731' }, // rack-r6-12
  { at: 175, node: 'node-923' }, // rack-r8-04
];

export const INCIDENTS: IncidentRow[] = [
  {
    id: 1,
    title: 'Cooling loop degraded under the training job',
    kind: 'cooling',
    nodes: ['node-417'],
    parts: ['cdu-3'],
    atMin: 160,
    expectClassification: 'shared_cause',
    expectCause: 'cdu-3',
    expectSend: 'mechanical tech to CDU-3',
    note: 'CDU-3 is degraded and cools rack-r1-11 .. rack-r1-15: 39 other job-train-1 nodes are at risk. Restarting on those racks crashes again.',
  },
  {
    id: 2,
    title: 'Row 4 B-side PDU failed',
    kind: 'power',
    nodes: ['node-427'],
    parts: ['pdu-r4-b'],
    atMin: 130,
    expectClassification: 'shared_cause',
    expectCause: 'pdu-r4-b',
    expectSend: 'electrical tech to PDU-R4-B',
    note: 'Row 4 runs on its A feed only; every Row 4 rack is one failure from an outage.',
  },
  {
    id: 3,
    title: 'Two failures in Row 6, no alarm',
    kind: 'network',
    nodes: ['node-731', 'node-660'],
    parts: [],
    atMin: 170,
    expectClassification: 'shared_cause',
    expectCause: 'sw-leaf-r6',
    expectSend: 'network engineer to Leaf R6',
    note: 'Nothing is marked degraded. The two failures share Row 6\'s PDUs and its leaf switch; the leaf is the one with no backup.',
  },
  {
    id: 4,
    title: 'Single node failure in Row 8',
    kind: 'isolated',
    nodes: ['node-923'],
    parts: [],
    atMin: 175,
    expectClassification: 'isolated',
    expectCause: '',
    expectSend: 'hardware tech to node-923',
    note: 'node-1007 failed on the same leaf at T+20m, outside the 2 h window, so it does not count.',
  },
  {
    id: 5,
    title: 'Tenant node under a failed CDU',
    kind: 'cooling',
    nodes: ['node-1153'],
    parts: ['cdu-29'],
    atMin: 150,
    expectClassification: 'shared_cause',
    expectCause: 'cdu-29',
    expectSend: 'mechanical tech to CDU-29',
    note: 'Not a job-train-1 node (tenant-gamma), so there are no at-risk job nodes; CDU-29 feeds 15 racks.',
  },
];

export function buildLab(s: Store): void {
  seed(s, buildSite(DEMO_HALL));
  ensureScriptedActors(s);
  for (const e of TIMELINE) {
    advanceTo(s, e.at);
    if ('part' in e) setPartState(s, SCRIPTED.facility.identity, e.part, e.state);
    else reportNodeFailure(s, SCRIPTED.scheduler.identity, e.node);
  }
  advanceTo(s, LAB_NOW);
  for (const inc of INCIDENTS) s.putIncident({ ...inc });
  setReady(s, 'blast_radius', 'lab', LAB_CAPTION);
}

/** Reseeds the test bed (shift lead or admin). */
export function seedDiagnostics(s: Store, identity: string): void {
  const a = requirePresenter(s, identity);
  buildLab(s);
  s.insertAudit({ sim: s.now(), identity, actor: a.name, action: 'seed_diagnostics', target: 'hall', verdict: 'ok', reason: `${INCIDENTS.length} incidents` });
}

/** First publish: settings, the test bed (only if the hall is empty), scripted actors, the owner as admin. */
export function initDatabase(s: Store, owner: string): void {
  s.putSettings(s.settings());
  if (!s.part('util-a')) buildLab(s);
  ensureScriptedActors(s);
  bootstrapAdmin(s, owner, 'Owner');
}
