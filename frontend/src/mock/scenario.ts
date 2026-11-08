// The presenter's scenarios. "Big job failure" (DESIGN.md §10.2) is scripted for both
// scheduler modes: each step mutates a copy of the world through the mock engine and emits the
// decision events the real backend would publish. The operations scenarios ("Software updates",
// "Maintenance window") exercise work scopes the mock engine doesn't model, so they run on the
// backend only (spacetimedb/src/core/scenario.ts); here they are just their step list, which
// spacetimedb/test/runner.test.ts keeps in step with the backend's.

import type { DecisionEvent, FocusTarget, Site, World } from '../model/types';
import {
  checkMaintenance,
  computeMargins,
  diagnose,
  jobNodes,
  protectionLease,
  safePlacement,
} from './engine';
import { JOB_ID, JOB_SIZE, initialOwners, label } from './site';

/** A scenario key: the two scheduler modes of "Big job failure", then the operations scenarios. */
export type Mode = 'naive' | 'squawk' | 'updates' | 'maintenance';

/** The scenarios the presenter picks from. `modes` are the keys it runs as (the scheduler toggle when there are two). */
export const SCENARIO_LIST: { id: string; name: string; modes: Mode[]; liveOnly: boolean }[] = [
  { id: 'big-job', name: 'Big job failure', modes: ['naive', 'squawk'], liveOnly: false },
  { id: 'updates', name: 'Software updates', modes: ['updates'], liveOnly: true },
  { id: 'maintenance', name: 'Maintenance window', modes: ['maintenance'], liveOnly: true },
];

export const scenarioOf = (mode: Mode) => SCENARIO_LIST.find((s) => s.modes.includes(mode))!;
export const isLiveOnly = (mode: Mode) => scenarioOf(mode).liveOnly;

export interface StepResult {
  caption: string;
  camera?: FocusTarget;
}

export interface Step {
  at: number; // simulated minutes
  title: string;
  run: (ctx: Ctx) => StepResult;
}

export interface Ctx {
  site: Site;
  world: World;
  emit: (e: Omit<DecisionEvent, 'seq' | 'time'>) => void;
}

const CAUSE = 'cdu-3';
const BACKUP = 'cdu-4';
const FIRST_FAIL = 'node-417';
const SECOND_FAIL = 'node-422';
const PROTECT_MINUTES = 72 * 60;

export function initialWorld(site: Site): World {
  const partState: World['partState'] = {};
  for (const p of site.partOrder) partState[p] = 'ok';
  const nodeState: World['nodeState'] = {};
  for (const n of site.nodeOrder) nodeState[n] = 'ok';
  const world: World = {
    now: 0,
    partState,
    nodeState,
    owner: initialOwners(site),
    leases: [],
    margins: {},
    placed: [],
    job: { id: JOB_ID, status: 'running', nodes: JOB_SIZE, restarts: 0, crashes: 0 },
    deniedRequests: 0,
  };
  world.margins = computeMargins(site, world);
  return world;
}

export const INTRO_CAPTION = `Hall A at steady state. ${JOB_ID} is training on ${JOB_SIZE.toLocaleString()} nodes in Rows 1–8, and every rack has full backup.`;

function refresh(ctx: Ctx) {
  ctx.world.margins = computeMargins(ctx.site, ctx.world);
  ctx.world.job.nodes = jobNodes(ctx.site, ctx.world).length;
}

const causeRacks = (site: Site) => site.downstream[CAUSE].filter((r) => site.racks[r].coolingFeeds[0][0] === CAUSE);

const shared: Step[] = [
  {
    at: 0,
    title: 'CDU-3 degrades',
    run: (ctx) => {
      ctx.world.partState[CAUSE] = 'degraded';
      refresh(ctx);
      const yellow = ctx.site.downstream[CAUSE].filter((r) => ctx.world.margins[r].level === 'yellow');
      ctx.emit({
        actor: 'Facility',
        actorKind: 'facility',
        title: `${label(CAUSE)} degraded`,
        verdict: 'warn',
        reason: `${yellow.length} racks are now one failure from an outage. ${label(BACKUP)} is their only working cooling feed.`,
        focus: { kind: 'part', id: CAUSE },
      });
      return {
        caption: `${label(CAUSE)} degrades. Its ${yellow.length} racks drop to one failure from an outage; ${label(BACKUP)} is now their only cooling.`,
        camera: { kind: 'racks', ids: [...yellow], parts: [CAUSE, BACKUP] },
      };
    },
  },
  {
    at: 10,
    title: `${FIRST_FAIL} fails`,
    run: (ctx) => {
      ctx.world.nodeState[FIRST_FAIL] = 'failed';
      ctx.world.job.status = 'stopped';
      ctx.world.job.crashes++;
      refresh(ctx);
      ctx.emit({
        actor: 'Scheduler',
        actorKind: 'scheduler',
        title: `${FIRST_FAIL} failed, ${JOB_ID} stopped`,
        verdict: 'failure',
        reason: `One node down stops all ${JOB_SIZE.toLocaleString()} nodes of a synchronous training job.`,
        focus: { kind: 'node', id: FIRST_FAIL },
      });
      return {
        caption: `${FIRST_FAIL} fails. ${JOB_ID} is synchronous, so the whole ${JOB_SIZE.toLocaleString()}-node job stops.`,
        camera: { kind: 'node', id: FIRST_FAIL },
      };
    },
  },
];

function naiveSwap(ctx: Ctx, failed: string): string {
  const { site, world } = ctx;
  const leaf = site.racks[site.nodes[failed].rack].network[0];
  const free = site.nodeOrder.filter((n) => world.owner[n].kind === 'free' && world.nodeState[n] === 'ok');
  const sameLeaf = free.find((n) => site.racks[site.nodes[n].rack].network[0] === leaf);
  const pick = sameLeaf ?? free[0];
  world.owner[failed] = { kind: 'free' };
  world.owner[pick] = { kind: 'job', id: JOB_ID };
  world.placed = [...world.placed, pick];
  world.job.status = 'running';
  world.job.restarts++;
  refresh(ctx);
  return pick;
}

const naive: Step[] = [
  ...shared,
  {
    at: 12,
    title: 'Naive swap and restart',
    run: (ctx) => {
      const pick = naiveSwap(ctx, FIRST_FAIL);
      ctx.emit({
        actor: 'Scheduler (naive)',
        actorKind: 'scheduler',
        title: `Swapped ${FIRST_FAIL} for ${pick}, restarted`,
        verdict: 'info',
        reason: `Nearest free node. Cause not checked: 39 nodes still run on ${label(CAUSE)}.`,
        focus: { kind: 'node', id: pick },
      });
      return {
        caption: `The naive scheduler swaps in the nearest free node and restarts, without asking why ${FIRST_FAIL} died.`,
        camera: { kind: 'overview' },
      };
    },
  },
  {
    at: 50,
    title: `${SECOND_FAIL} fails`,
    run: (ctx) => {
      ctx.world.nodeState[SECOND_FAIL] = 'failed';
      ctx.world.job.status = 'stopped';
      ctx.world.job.crashes++;
      refresh(ctx);
      ctx.emit({
        actor: 'Scheduler',
        actorKind: 'scheduler',
        title: `${SECOND_FAIL} failed, ${JOB_ID} stopped again`,
        verdict: 'failure',
        reason: `Same cooling loop as ${FIRST_FAIL} (${label(CAUSE)}). Second crash in 40 minutes.`,
        focus: { kind: 'node', id: SECOND_FAIL },
      });
      return {
        caption: `${SECOND_FAIL}, on the same ${label(CAUSE)} loop, fails 40 minutes later. The job crashes again.`,
        camera: { kind: 'node', id: SECOND_FAIL },
      };
    },
  },
  {
    at: 52,
    title: 'Naive restart again',
    run: (ctx) => {
      const pick = naiveSwap(ctx, SECOND_FAIL);
      ctx.emit({
        actor: 'Scheduler (naive)',
        actorKind: 'scheduler',
        title: `Swapped ${SECOND_FAIL} for ${pick}, restarted`,
        verdict: 'info',
        reason: `Still no diagnosis. 38 job nodes remain on ${label(CAUSE)}; the next crash is one failure away.`,
        focus: { kind: 'racks', ids: causeRacks(ctx.site) },
      });
      return {
        caption: `It restarts again, still on ${label(CAUSE)}. Without a diagnosis, this repeats until someone digs through the tools by hand.`,
        camera: { kind: 'racks', ids: causeRacks(ctx.site) },
      };
    },
  },
];

const squawk: Step[] = [
  ...shared,
  {
    at: 11,
    title: 'Diagnose the failure',
    run: (ctx) => {
      const d = diagnose(ctx.site, ctx.world, FIRST_FAIL);
      ctx.world.diagnosis = d;
      ctx.emit({
        actor: 'Squawk',
        actorKind: 'squawk',
        title: `Diagnosis: ${d.classification === 'shared_cause' ? `shared cause ${label(d.cause!)}` : 'isolated'}`,
        verdict: d.classification,
        reason: `${d.reason} Send a ${d.send}.`,
        focus: d.cause ? { kind: 'part', id: d.cause } : { kind: 'node', id: FIRST_FAIL },
      });
      return {
        caption: `Squawk diagnoses ${FIRST_FAIL}: shared cause ${label(d.cause ?? '')}. ${d.atRisk.length} other job nodes are at risk. Send a ${d.send}.`,
        camera: { kind: 'racks', ids: causeRacks(ctx.site), parts: [CAUSE] },
      };
    },
  },
  {
    at: 12,
    title: 'Find a safe restart',
    run: (ctx) => {
      const d = ctx.world.diagnosis!;
      const exclude = [FIRST_FAIL, ...d.atRisk];
      const p = safePlacement(ctx.site, ctx.world, exclude.length, exclude, ctx.world.now + PROTECT_MINUTES);
      ctx.world.placement = p;
      const racks = [...new Set(p.nodes.map((n) => ctx.site.nodes[n].rack))];
      ctx.emit({
        actor: 'Squawk',
        actorKind: 'squawk',
        title: `Safe placement: ${p.nodes.length} nodes`,
        verdict: 'placement',
        reason: p.reason,
        focus: { kind: 'racks', ids: racks },
      });
      return {
        caption: `It finds ${p.nodes.length} replacement nodes on healthy racks with full backup, away from ${label(CAUSE)}.`,
        // The whole hall, so "away from CDU-3" is visible: the spares light up across the floor from the gold racks.
        camera: { kind: 'overview' },
      };
    },
  },
  {
    at: 13,
    title: 'Restart and protect',
    run: (ctx) => {
      const { world, site } = ctx;
      const d = world.diagnosis!;
      const p = world.placement!;
      for (const n of [FIRST_FAIL, ...d.atRisk]) world.owner[n] = { kind: 'free' };
      for (const n of p.nodes) world.owner[n] = { kind: 'job', id: JOB_ID };
      world.placed = [...p.nodes];
      world.job.status = 'running';
      world.job.restarts++;
      refresh(ctx);
      const lease = protectionLease(site, world, 'Scheduler agent', world.now + PROTECT_MINUTES);
      world.leases.push(lease);
      ctx.emit({
        actor: 'Scheduler agent',
        actorKind: 'scheduler',
        title: `Restarted ${JOB_ID}, protection lease granted`,
        verdict: 'allow',
        reason: `Protects ${lease.racks!.length} racks of ${JOB_ID} for 72 h. Maintenance that would remove their backup is refused.`,
        focus: { kind: 'overview' },
      });
      return {
        caption: `The scheduler restarts once and locks the job's ${lease.racks!.length} racks with a protection lease for 72 h.`,
        camera: { kind: 'overview' },
      };
    },
  },
  {
    at: 30,
    title: 'Agent asks for CDU-4',
    run: (ctx) => {
      const check = checkMaintenance(ctx.site, ctx.world, BACKUP);
      if (check.verdict === 'deny') ctx.world.deniedRequests++;
      const red = check.dropped.filter((d) => d.after === 'red').map((d) => d.rack);
      ctx.emit({
        actor: 'Cooling agent',
        actorKind: 'cooling',
        title: `Maintenance on ${label(BACKUP)} ${check.verdict === 'deny' ? 'denied' : check.verdict === 'warn' ? 'needs approval' : 'allowed'}`,
        verdict: check.verdict,
        reason: `${check.reason}${check.earliestSafe ? ` Earliest safe time: ${check.earliestSafe}.` : ''}`,
        focus: { kind: 'part', id: BACKUP },
      });
      return {
        caption: `The cooling agent asks to take ${label(BACKUP)} offline. Refused: it is the last cooling feed for ${red.length} racks. Earliest safe time: ${check.earliestSafe ?? 'now'}.`,
        camera: { kind: 'racks', ids: [...red], parts: [BACKUP] },
      };
    },
  },
  {
    at: 50,
    title: `${SECOND_FAIL} fails`,
    run: (ctx) => {
      ctx.world.nodeState[SECOND_FAIL] = 'failed';
      refresh(ctx);
      ctx.emit({
        actor: 'Scheduler',
        actorKind: 'scheduler',
        title: `${SECOND_FAIL} failed, ${JOB_ID} unaffected`,
        verdict: 'info',
        reason: `${SECOND_FAIL} was moved out of ${JOB_ID} at T+13m. The job keeps running.`,
        focus: { kind: 'node', id: SECOND_FAIL },
      });
      return {
        caption: `${SECOND_FAIL} fails, exactly as in the naive run, but it was already moved out of the job. One restart, no second outage.`,
        camera: { kind: 'node', id: SECOND_FAIL },
      };
    },
  },
];

/** A backend-only step: the mock can list it but not run it. */
const liveStep = (at: number, title: string): Step => ({
  at,
  title,
  run: () => ({ caption: 'This scenario runs on the backend: start the view in live mode (VITE_SPACETIMEDB_URI) to play it.' }),
});

const updates: Step[] = [
  liveStep(0, `Online agent update on ${JOB_ID}`),
  liveStep(5, 'Driver update on rack-r9-04'),
  liveStep(6, 'Driver update on node-1190'),
  liveStep(8, 'Second update on node-1190'),
  liveStep(10, 'Leaf R3 firmware upgrade'),
  liveStep(100, 'node-1190 comes back degraded'),
  liveStep(120, `${JOB_ID} finishes`),
];

const maintenance: Step[] = [
  liveStep(0, `Protect ${JOB_ID}`),
  liveStep(5, 'Containment repair in Hot aisle 1'),
  liveStep(10, 'UPS-B quarterly service'),
  liveStep(15, 'PDU-R10-A swap'),
  liveStep(16, 'Shift lead approves the swap'),
  liveStep(20, 'node-1118 fails'),
  liveStep(60, `${JOB_ID} finishes`),
];

export const SCENARIOS: Record<Mode, Step[]> = { naive, squawk: squawk, updates, maintenance };
