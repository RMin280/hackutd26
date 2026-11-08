// The presenter's "big job failure" scenario (DESIGN.md §10.2), run by the backend.
// Same steps, times, titles and captions as frontend/src/mock/scenario.ts, so the
// view's step list still lines up. Each step acts through the normal commands as a
// scripted actor (Facility, Scheduler, Cooling agent...), so the decision feed and
// the audit log read exactly as if those agents had called the reducers themselves.

import {
  advanceTo,
  diagnoseFailure,
  naiveRestart,
  reportNodeFailure,
  requestPlacement,
  requestProtection,
  requestWork,
  restartJob,
  seed,
  setPartState,
} from './commands';
import { CAN_DO } from './catalog';
import { buildSite, DEMO_HALL } from './site';
import type { Store } from './store';
import { label } from './text';
import { RequestError, type ActorRow, type Role, type ScenarioRow } from './types';

export type Mode = 'naive' | 'squawk';
export const MODES: readonly Mode[] = ['naive', 'squawk'];
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
    title: 'Find a safe place to restart',
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
      const racks = [...new Set(p.nodes.map((n) => s.node(n)!.rack))];
      return {
        caption: `It finds ${p.nodes.length} replacement nodes on healthy racks with full backup, away from ${label(CAUSE)}.`,
        camera: onRacks(racks),
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
    title: 'Cooling agent asks for CDU-4',
    run: (s) => {
      const w = requestWork(s, SCRIPTED.cooling.identity, {
        kind: 'facility_work',
        target: BACKUP,
        startInMin: 0,
        durationMin: 0,
        dryRun: false,
        ticket: 'scenario-cdu4',
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

export const STEPS: Record<Mode, Step[]> = { naive, squawk: squawk };

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
  if (!isMode(mode)) throw new RequestError(`mode must be ${MODES.join(' or ')}.`);
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
  setReady(s, mode, 'demo', INTRO_CAPTION);
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
