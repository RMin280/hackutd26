// The presenter's scenarios, run by the backend. Each step acts through the normal commands
// as a scripted actor (Facility, Scheduler, Cooling agent...), so the decision feed and the
// audit log read exactly as if those agents had called the reducers themselves.
//
//   naive / squawk  "Big job failure" (DESIGN.md §10.2), the same story in both scheduler modes.
//                   Same steps, times, titles and captions as frontend/src/mock/scenario.ts.
//   updates         "Software updates": online vs drain-required updates, switch firmware, two
//                   updates on one node, a spare that comes back degraded (DESIGN.md §4.4).
//   maintenance     "Maintenance window": protection, hot-aisle and facility work, an approval,
//                   a failed spare, and a protection lease left behind by a finished job.
//
// The last two set up work for the Nemotron fixer agent (DESIGN.md §8.2) and leave it to the
// agent: routine requests refused for now (maintenance_refused), a broken spare (broken_node)
// and a stale protection lease (stale_protection). The scenario never does the fixer's job.
// The view lists their steps (frontend/src/mock/scenario.ts) but runs them only in live mode.

import {
  advanceTo,
  approveWork,
  diagnoseFailure,
  finishJob,
  naiveRestart,
  reportNodeFailure,
  requestPlacement,
  requestProtection,
  requestWork,
  restartJob,
  seed,
  setNodeState,
  setPartState,
} from './commands';
import { CAN_DO } from './catalog';
import { buildSite, DEMO_HALL } from './site';
import type { Store } from './store';
import { label } from './text';
import { RequestError, type ActorRow, type Role, type ScenarioRow } from './types';

/** A scenario key: the two scheduler modes of "Big job failure", then the operations scenarios. */
export type Mode = 'naive' | 'squawk' | 'updates' | 'maintenance';
export const MODES: readonly Mode[] = ['naive', 'squawk', 'updates', 'maintenance'];
export const isMode = (m: string): m is Mode => (MODES as readonly string[]).includes(m);

/** Built-in actors for scripted steps. Fixed hex identities no real client will ever have. */
const scripted = (n: number, name: string, role: Role): ActorRow => ({
  identity: `5c${'0'.repeat(60)}${n.toString(16).padStart(2, '0')}`,
  name,
  role,
  rows: [],
});
export const SCRIPTED = {
  facility: scripted(1, 'Facility', 'facility'),
  scheduler: scripted(2, 'Scheduler', 'scheduler_agent'),
  agent: scripted(3, 'Scheduler agent', 'scheduler_agent'),
  naive: scripted(4, 'Scheduler (naive)', 'scheduler_agent'),
  cooling: scripted(5, 'Cooling agent', 'cooling_agent'),
  updates: scripted(6, 'Update agent', 'scheduler_agent'),
  network: scripted(7, 'Network tech', 'technician'),
  tech: scripted(8, 'Facility tech', 'technician'),
  lead: scripted(9, 'Shift lead (on call)', 'shift_lead'),
  hardware: scripted(10, 'Hardware tech', 'technician'),
};

export function ensureScriptedActors(s: Store): void {
  for (const a of Object.values(SCRIPTED)) if (!s.actor(a.identity)) s.putActor({ ...a });
}

const JOB = 'job-train-1';
const CAUSE = 'cdu-3';
const BACKUP = 'cdu-4';
const FIRST = 'node-417';
const SECOND = 'node-422';
const PROTECT_MIN = 72 * 60;

export const INTRO_CAPTION =
  'Hall A at steady state. job-train-1 is training on 1,000 nodes in Rows 1–8, and every rack has full backup.';

/** Each scenario's opening caption. */
export const INTROS: Record<Mode, string> = {
  naive: INTRO_CAPTION,
  squawk: INTRO_CAPTION,
  updates:
    "Software updates in Hall A. job-train-1 trains on 1,000 nodes in Rows 1–8; tonight's queue has agent patches, GPU drivers and switch firmware.",
  maintenance:
    'Maintenance window in Hall A. job-train-1 trains on 1,000 nodes in Rows 1–8 while the facility techs work through their queue.',
};

interface Camera {
  kind: 'overview' | 'rack' | 'node' | 'part' | 'racks';
  ids: string[];
  parts: string[];
}
interface StepOut {
  caption: string;
  camera: Camera;
}
interface Step {
  at: number;
  title: string;
  run: (s: Store) => StepOut;
}

const overview = (): Camera => ({ kind: 'overview', ids: [], parts: [] });
const onNode = (id: string): Camera => ({ kind: 'node', ids: [id], parts: [] });
const onRack = (id: string): Camera => ({ kind: 'rack', ids: [id], parts: [] });
const onPart = (id: string): Camera => ({ kind: 'part', ids: [id], parts: [] });
const onRacks = (ids: string[], parts: string[] = []): Camera => ({ kind: 'racks', ids, parts });

/** Racks that CDU-3 cools as their primary feed (rack-r1-11 .. rack-r1-15). */
const causeRacks = (s: Store) => s.downstreamRacks(CAUSE).filter((r) => s.rack(r)!.coolingFeeds[0][0] === CAUSE);
const jobNodesOn = (s: Store, racks: string[]) =>
  racks.flatMap((r) => s.rack(r)!.nodes).filter((n) => {
    const node = s.node(n)!;
    return node.ownerKind === 'job' && node.ownerId === JOB && node.state !== 'failed';
  }).length;

function patchScenario(s: Store, patch: Partial<ScenarioRow>): void {
  const sc = s.scenario()!;
  s.putScenario({ ...sc, ...patch });
}

const shared: Step[] = [
  {
    at: 0,
    title: 'CDU-3 degrades',
    run: (s) => {
      setPartState(s, SCRIPTED.facility.identity, CAUSE, 'degraded');
      const yellow = s.downstreamRacks(CAUSE).filter((r) => s.margin(r)?.level === 'yellow');
      return {
        caption: `${label(CAUSE)} degrades. Its ${yellow.length} racks drop to one failure from an outage; ${label(BACKUP)} is now their only cooling.`,
        camera: onRacks(yellow, [CAUSE, BACKUP]),
      };
    },
  },
  {
    at: 10,
    title: `${FIRST} fails`,
    run: (s) => {
      reportNodeFailure(s, SCRIPTED.scheduler.identity, FIRST);
      return {
        caption: `${FIRST} fails. ${JOB} is synchronous, so the whole 1,000-node job stops.`,
        camera: onNode(FIRST),
      };
    },
  },
];

const naive: Step[] = [
  ...shared,
  {
    at: 12,
    title: 'Naive swap and restart',
    run: (s) => {
      naiveRestart(s, SCRIPTED.naive.identity, JOB, FIRST, {
        reason: `Nearest free node. Cause not checked: ${jobNodesOn(s, causeRacks(s))} nodes still run on ${label(CAUSE)}.`,
      });
      return {
        caption: `The naive scheduler swaps in the nearest free node and restarts, without asking why ${FIRST} died.`,
        camera: overview(),
      };
    },
  },
  {
    at: 50,
    title: `${SECOND} fails`,
    run: (s) => {
      reportNodeFailure(s, SCRIPTED.scheduler.identity, SECOND, {
        title: `${SECOND} failed, ${JOB} stopped again`,
        reason: `Same cooling loop as ${FIRST} (${label(CAUSE)}). Second crash in 40 minutes.`,
      });
      return {
        caption: `${SECOND}, on the same ${label(CAUSE)} loop, fails 40 minutes later. The job crashes again.`,
        camera: onNode(SECOND),
      };
    },
  },
  {
    at: 52,
    title: 'Naive restart again',
    run: (s) => {
      const racks = causeRacks(s);
      naiveRestart(s, SCRIPTED.naive.identity, JOB, SECOND, {
        reason: `Still no diagnosis. ${jobNodesOn(s, racks)} job nodes remain on ${label(CAUSE)}; the next crash is one failure away.`,
        focusIds: racks,
      });
      return {
        caption: `It restarts again, still on ${label(CAUSE)}. Without a diagnosis, this repeats until someone digs through the tools by hand.`,
        camera: onRacks(racks),
      };
    },
  },
];

const squawk: Step[] = [
  ...shared,
  {
    at: 11,
    title: 'Diagnose the failure',
    run: (s) => {
      const id = diagnoseFailure(s, SCRIPTED.agent.identity, [FIRST]);
      patchScenario(s, { diagnosisId: id });
      const d = s.diagnosis(id)!;
      return {
        caption: `Squawk diagnoses ${FIRST}: shared cause ${label(d.cause)}. ${d.atRisk.length} other job nodes are at risk. Send a ${d.send}.`,
        camera: onRacks(causeRacks(s), [CAUSE]),
      };
    },
  },
  {
    at: 12,
    title: 'Find a safe restart',
    run: (s) => {
      const diagnosisId = s.scenario()!.diagnosisId;
      const id = requestPlacement(s, SCRIPTED.agent.identity, {
        job: JOB,
        needed: 0,
        durationMin: PROTECT_MIN,
        exclude: [],
        diagnosisId,
      });
      patchScenario(s, { placementId: id });
      const p = s.placement(id)!;
      return {
        caption: `It finds ${p.nodes.length} replacement nodes on healthy racks with full backup, away from ${label(CAUSE)}.`,
        // The whole hall, so "away from CDU-3" is visible: the spares light up across the floor from the gold racks (same as the view's mock).
        camera: overview(),
      };
    },
  },
  {
    at: 13,
    title: 'Restart and protect',
    run: (s) => {
      restartJob(s, SCRIPTED.agent.identity, JOB, s.scenario()!.placementId);
      const lease = requestProtection(s, SCRIPTED.agent.identity, JOB, PROTECT_MIN, 'scenario-protect');
      return {
        caption: `The scheduler restarts once and locks the job's ${lease.racks.length} racks with a protection lease for 72 h.`,
        camera: overview(),
      };
    },
  },
  {
    at: 30,
    title: 'Agent asks for CDU-4',
    run: (s) => {
      const w = requestWork(s, SCRIPTED.cooling.identity, {
        kind: 'facility_work',
        target: BACKUP,
        startInMin: 0,
        durationMin: 0,
        dryRun: false,
        ticket: 'scenario-cdu4',
        routine: true, // routine service: a refusal is something the fixer may queue and rebook (DESIGN.md §8.2)
        note: 'Quarterly service',
      });
      // The racks CDU-4 is the last cooling feed for: they would go red.
      const red = s.downstreamRacks(BACKUP).filter((r) => (s.margin(r)?.cooling ?? 1) <= 0);
      const verdict = w.verdict === 'deny' ? 'Refused' : w.verdict === 'warn' ? 'It needs approval' : 'Allowed';
      return {
        caption: `The cooling agent asks to take ${label(BACKUP)} offline. ${verdict}: it is the last cooling feed for ${red.length} racks. Earliest safe time: ${w.earliestSafe || 'now'}.`,
        camera: onRacks(red, [BACKUP]),
      };
    },
  },
  {
    at: 50,
    title: `${SECOND} fails`,
    run: (s) => {
      reportNodeFailure(s, SCRIPTED.scheduler.identity, SECOND, {
        title: `${SECOND} failed, ${JOB} unaffected`,
        reason: `${SECOND} was moved out of ${JOB} at T+13m. The job keeps running.`,
        verdict: 'info',
      });
      return {
        caption: `${SECOND} fails, exactly as in the naive run, but it was already moved out of the job. One restart, no second outage.`,
        camera: onNode(SECOND),
      };
    },
  },
];

// ---------------------------------------------------------------- software updates

const DRIVER_RACK = 'rack-r9-04'; // free spares, but slots 0-2 run tenant-gamma
const SPARE = 'node-1190'; // a free spare in rack-r10-05
const LEAF = 'sw-leaf-r3'; // Row 3: job-train-1 below it
const DRIVER = 'GPU driver 550 → 560';

const verdictWord = (v: string) => (v === 'deny' ? 'Refused' : v === 'warn' ? 'Needs approval' : 'Allowed');

const updates: Step[] = [
  {
    at: 0,
    title: 'Online agent update on job-train-1',
    run: (s) => {
      const w = requestWork(s, SCRIPTED.updates.identity, {
        kind: 'sw_online',
        target: JOB,
        startInMin: 0,
        durationMin: 0,
        dryRun: false,
        ticket: 'scenario-agent-patch',
        note: 'Monitoring agent 4.2.1 (live patch)',
      });
      return {
        caption: `The update agent live-patches the monitoring agent on all ${JOB} nodes. ${verdictWord(w.verdict)}: an online update runs while the job keeps training.`,
        camera: overview(),
      };
    },
  },
  {
    at: 5,
    title: `Driver update on ${label(DRIVER_RACK)}`,
    run: (s) => {
      const w = requestWork(s, SCRIPTED.updates.identity, {
        kind: 'sw_exclusive',
        target: DRIVER_RACK,
        startInMin: 0,
        durationMin: 0,
        dryRun: false,
        ticket: 'scenario-driver-rack',
        routine: true,
        note: DRIVER,
      });
      return {
        caption: `It asks to update the GPU driver on ${label(DRIVER_RACK)}, which reboots every node. ${verdictWord(w.verdict)}: 3 of them run tenant-gamma. A routine request, so the fixer can queue it.`,
        camera: onRack(DRIVER_RACK),
      };
    },
  },
  {
    at: 6,
    title: `Driver update on ${SPARE}`,
    run: (s) => {
      const w = requestWork(s, SCRIPTED.updates.identity, {
        kind: 'sw_exclusive',
        target: SPARE,
        startInMin: 0,
        durationMin: 0,
        dryRun: false,
        ticket: 'scenario-driver-spare',
        note: DRIVER,
      });
      return {
        caption: `On a free spare the same update is ${verdictWord(w.verdict).toLowerCase()}: ${SPARE} runs nothing, so it goes out of service for its 90-minute window.`,
        camera: onNode(SPARE),
      };
    },
  },
  {
    at: 8,
    title: `Second update on ${SPARE}`,
    run: (s) => {
      const w = requestWork(s, SCRIPTED.network.identity, {
        kind: 'sw_online',
        target: SPARE,
        startInMin: 0,
        durationMin: 0,
        dryRun: false,
        ticket: 'scenario-nic-patch',
        note: 'NIC firmware staging',
      });
      return {
        caption: `A network tech tries to stage NIC firmware on ${SPARE} at the same time. ${verdictWord(w.verdict)}: one piece of work per node at a time. Earliest safe time: ${w.earliestSafe || 'now'}.`,
        camera: onNode(SPARE),
      };
    },
  },
  {
    at: 10,
    title: `${label(LEAF)} firmware upgrade`,
    run: (s) => {
      const w = requestWork(s, SCRIPTED.network.identity, {
        kind: 'switch_firmware',
        target: LEAF,
        startInMin: 0,
        durationMin: 0,
        dryRun: false,
        ticket: 'scenario-leaf-fw',
        routine: true,
        note: 'Leaf OS 10.4 → 10.6',
      });
      const below = s.downstreamRacks(LEAF);
      return {
        caption: `The network tech asks to upgrade ${label(LEAF)}. ${verdictWord(w.verdict)}: the switch reboots and every node below it, ${JOB}'s included, drops off the network. Earliest safe time: ${w.earliestSafe || 'now'}.`,
        camera: onRacks(below, [LEAF]),
      };
    },
  },
  {
    at: 100,
    title: `${SPARE} comes back degraded`,
    run: (s) => {
      setNodeState(s, SCRIPTED.facility.identity, SPARE, 'degraded');
      return {
        caption: `${SPARE}'s driver window ends, but it comes back degraded. A free spare on a healthy rack: routine work for the fixer agent, not a page.`,
        camera: onNode(SPARE),
      };
    },
  },
  {
    at: 120,
    title: `${JOB} finishes`,
    run: (s) => {
      finishJob(s, SCRIPTED.scheduler.identity, JOB);
      return {
        caption: `${JOB} finishes and frees its 1,000 nodes. The ${label(LEAF)} firmware refused at T+10m is safe now: the fixer can rebook it. ${label(DRIVER_RACK)} still waits on tenant-gamma.`,
        camera: onPart(LEAF),
      };
    },
  },
];

// ---------------------------------------------------------------- maintenance window

const WINDOW_MIN = 4 * 60;
const UPS = 'ups-b';
const PDU = 'pdu-r10-a';
const AISLE = 'ha-1';
const BROKEN = 'node-1118'; // a free spare in rack-r9-12

const maintenance: Step[] = [
  {
    at: 0,
    title: `Protect ${JOB}`,
    run: (s) => {
      const lease = requestProtection(s, SCRIPTED.scheduler.identity, JOB, WINDOW_MIN, 'scenario-window-protect');
      return {
        caption: `The scheduler locks ${JOB}'s ${lease.racks.length} racks with a 4 h protection lease: nothing may cut their backup while it trains.`,
        camera: overview(),
      };
    },
  },
  {
    at: 5,
    title: `Containment repair in ${label(AISLE)}`,
    run: (s) => {
      const w = requestWork(s, SCRIPTED.tech.identity, {
        kind: 'hot_aisle_work',
        target: AISLE,
        startInMin: 0,
        durationMin: 0,
        dryRun: false,
        ticket: 'scenario-ha1-door',
        note: 'Containment door closer',
      });
      return {
        caption: `A facility tech asks to open ${label(AISLE)} to fix a door closer. ${verdictWord(w.verdict)}: both rows are protected for ${JOB}. Earliest safe time: ${w.earliestSafe || 'now'}.`,
        camera: onRacks(s.aisle(AISLE)!.rows.flatMap((r) => s.racksInRow(r).map((x) => x.id))),
      };
    },
  },
  {
    at: 10,
    title: `${label(UPS)} quarterly service`,
    run: (s) => {
      const w = requestWork(s, SCRIPTED.tech.identity, {
        kind: 'facility_work',
        target: UPS,
        startInMin: 0,
        durationMin: 0,
        dryRun: false,
        ticket: 'scenario-ups-b',
        routine: true,
        note: 'Quarterly battery test',
      });
      return {
        caption: `Next, ${label(UPS)}'s quarterly battery test. ${verdictWord(w.verdict)}: it feeds ${JOB}'s protected racks. Routine, so the fixer can queue it. Earliest safe time: ${w.earliestSafe || 'now'}.`,
        camera: onPart(UPS),
      };
    },
  },
  {
    at: 15,
    title: `${label(PDU)} swap`,
    run: (s) => {
      const w = requestWork(s, SCRIPTED.tech.identity, {
        kind: 'facility_work',
        target: PDU,
        startInMin: 0,
        durationMin: 0,
        dryRun: false,
        ticket: 'scenario-pdu-swap',
        note: 'Replace failing breaker',
      });
      patchScenario(s, { placementId: w.id }); // the step after approves this request
      return {
        caption: `Then a breaker swap on ${label(PDU)}. ${verdictWord(w.verdict)}: no job there, but Row 10's racks would be one failure from an outage, with tenant-gamma on them.`,
        camera: onPart(PDU),
      };
    },
  },
  {
    at: 16,
    title: 'Shift lead approves the swap',
    run: (s) => {
      approveWork(s, SCRIPTED.lead.identity, s.scenario()!.placementId);
      const yellow = s.downstreamRacks(PDU).filter((r) => s.margin(r)?.level === 'yellow');
      return {
        caption: `The on-call shift lead approves it. ${label(PDU)} goes offline and ${yellow.length} racks run on one power feed until the swap is done.`,
        camera: onRacks(yellow, [PDU]),
      };
    },
  },
  {
    at: 20,
    title: `${BROKEN} fails`,
    run: (s) => {
      reportNodeFailure(s, SCRIPTED.scheduler.identity, BROKEN);
      return {
        caption: `${BROKEN}, a free spare in Row 9, fails. Isolated, on a healthy rack, no job: routine work the fixer can take out of service and send a hardware tech to.`,
        camera: onNode(BROKEN),
      };
    },
  },
  {
    at: 60,
    title: `${JOB} finishes`,
    run: (s) => {
      finishJob(s, SCRIPTED.scheduler.identity, JOB);
      return {
        caption: `${JOB} finishes early, but its protection lease still locks the racks until T+4h, and ${label(UPS)} stays refused for nothing. A stale lock for the fixer to release, then the battery test to rebook.`,
        camera: overview(),
      };
    },
  },
];

export const STEPS: Record<Mode, Step[]> = { naive, squawk: squawk, updates, maintenance };

// ---------------------------------------------------------------- reducers' logic

export function requirePresenter(s: Store, identity: string): ActorRow {
  const a = s.actor(identity);
  if (!a) throw new RequestError('Unknown identity. Register first (self_register as shift_lead to present).');
  if (!CAN_DO.present.includes(a.role as Role)) {
    throw new RequestError(`${a.name} (${a.role}) can't run the scenario. Allowed: ${CAN_DO.present.join(', ')}.`);
  }
  return a;
}

function checkMode(mode: string): Mode {
  if (!isMode(mode)) throw new RequestError(`mode must be one of ${MODES.join(', ')}.`);
  return mode;
}

/** Writes the scenario row for a freshly seeded hall. */
export function setReady(s: Store, mode: Mode, bed: string, caption: string): void {
  const prev = s.scenario();
  s.putScenario({
    id: 0,
    mode,
    bed,
    step: -1,
    total: STEPS[mode].length,
    title: '',
    caption,
    cameraKind: 'overview',
    cameraIds: [],
    cameraParts: [],
    diagnosisId: 0n,
    placementId: 0n,
    version: (prev?.version ?? 0) + 1,
  });
}

/** Clean demo hall at T+0, ready for step 1. */
export function startClean(s: Store, mode: Mode): void {
  seed(s, buildSite(DEMO_HALL));
  ensureScriptedActors(s);
  setReady(s, mode, 'demo', INTROS[mode]);
}

function runStep(s: Store, mode: Mode, i: number): void {
  const step = STEPS[mode][i];
  advanceTo(s, step.at);
  const out = step.run(s);
  patchScenario(s, {
    step: i,
    title: step.title,
    caption: out.caption,
    cameraKind: out.camera.kind,
    cameraIds: out.camera.ids,
    cameraParts: out.camera.parts,
    version: s.scenario()!.version + 1,
  });
}

export function scenarioStart(s: Store, identity: string, mode: string): void {
  const a = requirePresenter(s, identity);
  startClean(s, checkMode(mode));
  s.insertAudit({ sim: 0, identity, actor: a.name, action: 'scenario_start', target: mode, verdict: 'ok', reason: '' });
}

/** Runs the next step. If the hall isn't a demo run in this mode (a fresh database holds the
 *  diagnostics test bed), it starts one first, so Space always works. */
export function scenarioNext(s: Store, identity: string, mode: string): void {
  const a = requirePresenter(s, identity);
  const m = checkMode(mode);
  let sc = s.scenario();
  if (!sc || sc.bed !== 'demo' || sc.mode !== m) {
    startClean(s, m);
    sc = s.scenario()!;
  }
  const i = sc.step + 1;
  if (i >= STEPS[m].length) return;
  runStep(s, m, i);
  s.insertAudit({ sim: s.now(), identity, actor: a.name, action: 'scenario_next', target: `${m} #${i + 1}`, verdict: 'ok', reason: STEPS[m][i].title });
}

/** Jumps to a step: reseeds and replays every step up to it, in one transaction. */
export function scenarioGoto(s: Store, identity: string, mode: string, step: number): void {
  const a = requirePresenter(s, identity);
  const m = checkMode(mode);
  startClean(s, m);
  const last = Math.min(step, STEPS[m].length - 1);
  for (let i = 0; i <= last; i++) runStep(s, m, i);
  s.insertAudit({ sim: s.now(), identity, actor: a.name, action: 'scenario_goto', target: `${m} #${last + 1}`, verdict: 'ok', reason: '' });
}

/** Back to a clean hall in the current mode (the old reset_demo). */
export function resetDemo(s: Store, identity: string): void {
  const mode = s.scenario()?.mode;
  scenarioStart(s, identity, mode && isMode(mode) ? mode : 'squawk');
}
