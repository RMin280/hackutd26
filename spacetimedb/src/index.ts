// Squawk backend: a SpacetimeDB module (TypeScript, SpacetimeDB 2.x).
//
// Tables hold the facility map (parts, hot aisles, racks, nodes), the live state the
// control-room view renders (margin, job, work, claim, decision) and the private
// audit log. Reducers are the only way to change anything, and each reducer is one
// transaction: two actors asking for the same backup at the same moment are
// serialized, so the second one sees the first one's lease and is refused.
//
// The logic lives in ./core (plain functions, unit-tested without SpacetimeDB).
// This file declares the tables, adapts them to the core's Store interface and
// exports the reducers. Export names become reducer names (requestWork -> request_work).

import { schema, SenderError, t, table, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import * as cmd from './core/commands';
import * as lab from './core/lab';
import * as scenario from './core/scenario';
import type { Store } from './core/store';
import { RequestError } from './core/types';

// ---------------------------------------------------------------- facility map

const part = table(
  { public: true },
  {
    id: t.string().primaryKey(), // util-a, ups-a, pdu-r3-a, cdu-3, chiller-1, sw-leaf-r3, sw-spine-1
    type: t.string(), // utility | switchgear | ups | pdu | chiller | cdu | spine | leaf
    rowNum: t.u32(), // 0 = central plant
    ord: t.u32(),
    state: t.string(), // ok | degraded | failed
    heldBy: t.u64(), // active work holding it offline (shown as maintenance), 0 = none
  },
);

const aisle = table(
  { public: true },
  {
    id: t.string().primaryKey(), // ha-1 .. ha-5
    kind: t.string(), // hot
    rows: t.array(t.u32()), // ha-1 = [1, 2]
    ord: t.u32(),
    heldBy: t.u64(), // active hot-aisle work, 0 = none
  },
);

const rack = table(
  { public: true },
  {
    id: t.string().primaryKey(), // rack-r3-07
    rowNum: t.u32().index('btree'),
    pos: t.u32(),
    aisle: t.string(),
    ord: t.u32(),
    powerFeeds: t.array(t.array(t.string())), // upstream chains, nearest part first
    coolingFeeds: t.array(t.array(t.string())),
    network: t.array(t.string()), // [leaf, spine]
    nodes: t.array(t.string()),
  },
);

const node = table(
  { public: true },
  {
    id: t.string().primaryKey(), // node-417
    rack: t.string().index('btree'),
    rowNum: t.u32(),
    slot: t.u32(),
    ord: t.u32(),
    state: t.string(), // ok | degraded | failed
    ownerKind: t.string().index('btree'), // job | tenant | free
    ownerId: t.string().index('btree'), // job-train-1, tenant-beta, '' when free
    heldBy: t.u64(), // active work holding it offline, 0 = none
  },
);

const downstream = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    part: t.string().index('btree'),
    rack: t.string(),
  },
);

// ---------------------------------------------------------------- live state

const margin = table(
  { public: true },
  {
    rack: t.string().primaryKey(),
    power: t.i32(),
    cooling: t.i32(),
    margin: t.i32(),
    level: t.string(), // green | yellow | red
    unprotected: t.array(t.string()),
    protectedBy: t.u64(),
    protectedJob: t.string(),
    protectedUntil: t.i32(), // -1 = not protected
  },
);

const job = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    status: t.string(), // running | stopped
    size: t.u32(),
    nodes: t.u32(),
    restarts: t.u32(),
    crashes: t.u32(),
  },
);

const work = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    ticket: t.string().index('btree'),
    kind: t.string(),
    category: t.string(),
    scope: t.string(),
    mode: t.string(),
    targetKind: t.string(),
    target: t.string(),
    targetLabel: t.string(),
    actor: t.string(),
    actorRole: t.string(),
    actorIdentity: t.string(),
    requestedAt: t.u32(),
    startMin: t.u32(),
    endMin: t.u32(),
    status: t.string().index('btree'),
    verdict: t.string(),
    reason: t.string(),
    earliestSafe: t.string(),
    earliestSafeMin: t.i32(),
    blockers: t.array(t.string()),
    racks: t.array(t.string()),
    job: t.string(),
    offlineParts: t.array(t.string()),
    offlineNodes: t.array(t.string()),
    nodeCount: t.u32(),
    approvedBy: t.string(),
    routine: t.bool(), // routine work: the fixer may queue a refusal and rebook it when the blockers clear
    note: t.string(), // free text from the requester (data only)
    bookedBy: t.string(), // actor who booked it on the requester's behalf, '' = the requester
  },
);

const claim = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    work: t.u64().index('btree'),
    resource: t.string().index('btree'),
    mode: t.string(), // X | S | I
    startMin: t.u32(),
    endMin: t.u32(),
  },
);

// Who is doing a piece of maintenance work (the work board): accept_work / complete_work.
const assignment = table(
  { public: true },
  {
    work: t.u64().primaryKey(), // the work row
    assignee: t.string(), // actor name
    assigneeRole: t.string(),
    acceptedAt: t.i32(), // simulated minute, -1 = never accepted
    completedBy: t.string(), // '' until completed
    completedAt: t.i32(), // -1 until completed
    repaired: t.array(t.string()), // targets marked ok on completion
    note: t.string(), // completion note, data only
  },
);

const failure = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    node: t.string(),
    atMin: t.u32(),
  },
);

const diagnosis = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    atMin: t.u32(),
    job: t.string(),
    nodes: t.array(t.string()),
    classification: t.string(),
    cause: t.string(),
    atRisk: t.array(t.string()),
    send: t.string(),
    reason: t.string(),
  },
);

const placement = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    atMin: t.u32(),
    job: t.string(),
    needed: t.u32(),
    durationMin: t.u32(),
    exclude: t.array(t.string()),
    nodes: t.array(t.string()),
    excludedReasons: t.array(t.string()),
    excludedCounts: t.array(t.u32()),
    shortfall: t.u32(),
    reason: t.string(),
    used: t.bool(),
  },
);

// The one event feed (DESIGN.md §4.3): the view renders it, agents read it by seq and triage on `type`.
const decision = table(
  { public: true },
  {
    seq: t.u64().primaryKey().autoInc(),
    atMin: t.u32(),
    actor: t.string(),
    actorKind: t.string(), // facility | scheduler | cooling | fixer | squawk
    actorRole: t.string(),
    title: t.string(),
    verdict: t.string(), // allow | warn | deny | failure | shared_cause | isolated | placement | info | plan | fixed | handoff
    reason: t.string(),
    focusKind: t.string(), // rack | node | part | racks | overview
    focusIds: t.array(t.string()),
    focusParts: t.array(t.string()),
    work: t.u64(),
    type: t.string().index('btree'), // what happened: state_change | lease_denied | agent_plan | ... (core/types.ts EventType)
    subject: t.string(), // the node, part, job or work ('#12') it is about
    data: t.string(), // JSON object with the typed fields agents read
  },
);

const clock = table(
  { public: true },
  {
    id: t.u32().primaryKey(), // single row, id 0
    nowMin: t.u32(), // simulated minutes since T+0
  },
);

const scenarioTable = table(
  { public: true },
  {
    id: t.u32().primaryKey(), // single row, id 0
    mode: t.string(), // naive | squawk
    bed: t.string(), // demo | lab (diagnostics test bed) | scale
    step: t.i32(), // -1 = ready
    total: t.u32(),
    title: t.string(),
    caption: t.string(),
    cameraKind: t.string(), // overview | rack | node | part | racks
    cameraIds: t.array(t.string()),
    cameraParts: t.array(t.string()),
    diagnosisId: t.u64(),
    placementId: t.u64(),
    version: t.u32(),
  },
);

// ---------------------------------------------------------------- private

const audit = table(
  { public: false },
  {
    id: t.u64().primaryKey().autoInc(),
    at: t.timestamp(),
    sim: t.u32(),
    identity: t.string(),
    actor: t.string(),
    action: t.string(),
    target: t.string(),
    verdict: t.string(),
    reason: t.string(),
  },
);

const actor = table(
  { public: false },
  {
    identity: t.string().primaryKey(), // hex
    name: t.string().index('btree'), // looked up when work is booked on an actor's behalf
    role: t.string(),
    rows: t.array(t.u32()), // empty = every row
  },
);

const settings = table(
  { public: false },
  {
    id: t.u32().primaryKey(),
    openRegistration: t.bool(),
    failureWindowMin: t.u32(),
  },
);

// Test cases for diagnostic agents, with the expected answers (see core/lab.ts).
const incident = table(
  { public: false },
  {
    id: t.u32().primaryKey(),
    title: t.string(),
    kind: t.string(),
    nodes: t.array(t.string()),
    parts: t.array(t.string()),
    atMin: t.u32(),
    expectClassification: t.string(),
    expectCause: t.string(),
    expectSend: t.string(),
    note: t.string(),
  },
);

const spacetimedb = schema({
  part,
  aisle,
  rack,
  node,
  downstream,
  margin,
  job,
  work,
  claim,
  assignment,
  failure,
  diagnosis,
  placement,
  decision,
  clock,
  scenario: scenarioTable,
  audit,
  actor,
  settings,
  incident,
});
export default spacetimedb;

// ---------------------------------------------------------------- Store adapter

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

const all = <R>(rows: Iterable<R>): R[] => Array.from(rows);
const byId = <R extends { id: bigint }>(a: R, b: R) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function storeFor(ctx: Ctx): Store {
  const db = ctx.db;
  return {
    part: (id) => db.part.id.find(id) ?? undefined,
    rack: (id) => db.rack.id.find(id) ?? undefined,
    node: (id) => db.node.id.find(id) ?? undefined,
    aisle: (id) => db.aisle.id.find(id) ?? undefined,
    racksInRow: (rowNum) => all(db.rack.rowNum.filter(rowNum)).sort((a, b) => a.ord - b.ord),
    downstreamRacks: (partId) => all(db.downstream.part.filter(partId)).sort(byId).map((d) => d.rack),

    now: () => db.clock.id.find(0)?.nowMin ?? 0,
    setNow: (min) => {
      if (db.clock.id.find(0)) db.clock.id.update({ id: 0, nowMin: min });
      else db.clock.insert({ id: 0, nowMin: min });
    },
    settings: () => db.settings.id.find(0) ?? { ...cmd.DEFAULT_SETTINGS },
    putSettings: (row) => {
      if (db.settings.id.find(row.id)) db.settings.id.update(row);
      else db.settings.insert(row);
    },
    actor: (identity) => db.actor.identity.find(identity) ?? undefined,
    actorByName: (name) => all(db.actor.name.filter(name))[0] ?? undefined,
    hasAdmin: () => all(db.actor.iter()).some((a) => a.role === 'admin'),
    putActor: (row) => {
      if (db.actor.identity.find(row.identity)) db.actor.identity.update(row);
      else db.actor.insert(row);
    },
    job: (id) => db.job.id.find(id) ?? undefined,
    putJob: (row) => {
      if (db.job.id.find(row.id)) db.job.id.update(row);
      else db.job.insert(row);
    },
    nodesOwnedBy: (ownerId) => all(db.node.ownerId.filter(ownerId)),
    freeNodes: () => all(db.node.ownerKind.filter('free')),
    putPart: (row) => {
      db.part.id.update(row);
    },
    putNode: (row) => {
      db.node.id.update(row);
    },
    putAisle: (row) => {
      db.aisle.id.update(row);
    },
    margin: (rackId) => db.margin.rack.find(rackId) ?? undefined,
    putMargin: (row) => {
      if (db.margin.rack.find(row.rack)) db.margin.rack.update(row);
      else db.margin.insert(row);
    },

    work: (id) => db.work.id.find(id) ?? undefined,
    workByStatus: (status) => all(db.work.status.filter(status)).sort(byId),
    insertWork: (row) => db.work.insert({ ...row, id: 0n }),
    putWork: (row) => {
      db.work.id.update(row);
    },
    claimsOn: (resource) => all(db.claim.resource.filter(resource)),
    insertClaim: (row) => {
      db.claim.insert({ ...row, id: 0n });
    },
    deleteClaimsOf: (workId) => {
      for (const c of all(db.claim.work.filter(workId))) db.claim.id.delete(c.id);
    },
    assignment: (workId) => db.assignment.work.find(workId) ?? undefined,
    putAssignment: (row) => {
      if (db.assignment.work.find(row.work)) db.assignment.work.update(row);
      else db.assignment.insert(row);
    },
    failuresSince: (min) => all(db.failure.iter()).filter((f) => f.atMin >= min),
    insertFailure: (row) => {
      db.failure.insert({ ...row, id: 0n });
    },
    diagnosis: (id) => db.diagnosis.id.find(id) ?? undefined,
    insertDiagnosis: (row) => db.diagnosis.insert({ ...row, id: 0n }),
    placement: (id) => db.placement.id.find(id) ?? undefined,
    insertPlacement: (row) => db.placement.insert({ ...row, id: 0n }),
    putPlacement: (row) => {
      db.placement.id.update(row);
    },
    insertDecision: (row) => {
      db.decision.insert({ ...row, seq: 0n });
    },
    scenario: () => db.scenario.id.find(0) ?? undefined,
    putScenario: (row) => {
      if (db.scenario.id.find(row.id)) db.scenario.id.update(row);
      else db.scenario.insert(row);
    },
    putIncident: (row) => {
      if (db.incident.id.find(row.id)) db.incident.id.update(row);
      else db.incident.insert(row);
    },
    insertAudit: (row) => {
      db.audit.insert({ ...row, id: 0n, at: ctx.timestamp });
    },

    clearFacility: () => {
      for (const r of all(db.incident.iter())) db.incident.id.delete(r.id);
      for (const r of all(db.assignment.iter())) db.assignment.work.delete(r.work);
      for (const r of all(db.claim.iter())) db.claim.id.delete(r.id);
      for (const r of all(db.work.iter())) db.work.id.delete(r.id);
      for (const r of all(db.decision.iter())) db.decision.seq.delete(r.seq);
      for (const r of all(db.placement.iter())) db.placement.id.delete(r.id);
      for (const r of all(db.diagnosis.iter())) db.diagnosis.id.delete(r.id);
      for (const r of all(db.failure.iter())) db.failure.id.delete(r.id);
      for (const r of all(db.job.iter())) db.job.id.delete(r.id);
      for (const r of all(db.margin.iter())) db.margin.rack.delete(r.rack);
      for (const r of all(db.downstream.iter())) db.downstream.id.delete(r.id);
      for (const r of all(db.node.iter())) db.node.id.delete(r.id);
      for (const r of all(db.rack.iter())) db.rack.id.delete(r.id);
      for (const r of all(db.aisle.iter())) db.aisle.id.delete(r.id);
      for (const r of all(db.part.iter())) db.part.id.delete(r.id);
    },
    loadSite: (site, margins) => {
      for (const r of site.parts) db.part.insert(r);
      for (const r of site.aisles) db.aisle.insert(r);
      for (const r of site.racks) db.rack.insert(r);
      for (const r of site.nodes) db.node.insert(r);
      for (const r of site.downstream) db.downstream.insert({ ...r, id: 0n });
      for (const r of margins) db.margin.insert(r);
      for (const r of site.jobs) db.job.insert(r);
    },
  };
}

/** Runs a command against this transaction. Bad requests become SenderError (rolled back,
 *  returned to the caller); safety verdicts are rows, so a "deny" is committed and logged. */
function run(ctx: Ctx, fn: (s: Store, caller: string) => unknown): void {
  try {
    fn(storeFor(ctx), ctx.sender.toHexString().toLowerCase());
  } catch (e) {
    if (e instanceof RequestError) throw new SenderError(e.message);
    throw e;
  }
}

const hex = (identity: string) => identity.trim().toLowerCase().replace(/^0x/, '');

// ---------------------------------------------------------------- lifecycle and identities

/** First publish (or publish --clear-database): seed the diagnostics test bed (core/lab.ts)
 *  and make the publisher admin. Idempotent, so it never wipes a running hall. */
export const init = spacetimedb.init((ctx) => {
  lab.initDatabase(storeFor(ctx), ctx.sender.toHexString().toLowerCase());
});

/** Only works while no admin exists. */
export const claimAdmin = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) =>
  run(ctx, (s, me) => cmd.claimAdmin(s, me, name)),
);

/** Demo convenience while settings.openRegistration is on: pick any role except admin. */
export const selfRegister = spacetimedb.reducer(
  { name: t.string(), role: t.string(), rows: t.array(t.u32()) },
  (ctx, { name, role, rows }) => run(ctx, (s, me) => cmd.selfRegister(s, me, name, role, rows)),
);

export const registerActor = spacetimedb.reducer(
  { identity: t.string(), name: t.string(), role: t.string(), rows: t.array(t.u32()) },
  (ctx, a) => run(ctx, (s, me) => cmd.registerActor(s, me, hex(a.identity), a.name, a.role, a.rows)),
);

export const setOpenRegistration = spacetimedb.reducer({ open: t.bool() }, (ctx, { open }) =>
  run(ctx, (s, me) => cmd.setOpenRegistration(s, me, open)),
);

// ---------------------------------------------------------------- demo control

/** Clean demo hall at T+0 in the current mode (shift lead or admin). */
export const resetDemo = spacetimedb.reducer((ctx) => run(ctx, (s, me) => scenario.resetDemo(s, me)));

/** Diagnostics test bed: the hall with five known incidents (shift lead or admin). */
export const seedDiagnostics = spacetimedb.reducer((ctx) => run(ctx, (s, me) => lab.seedDiagnostics(s, me)));

// The presenter's scenario (DESIGN.md §10.2). mode: naive | squawk.
export const scenarioStart = spacetimedb.reducer({ mode: t.string() }, (ctx, { mode }) =>
  run(ctx, (s, me) => scenario.scenarioStart(s, me, mode)),
);

export const scenarioNext = spacetimedb.reducer({ mode: t.string() }, (ctx, { mode }) =>
  run(ctx, (s, me) => scenario.scenarioNext(s, me, mode)),
);

export const scenarioGoto = spacetimedb.reducer({ mode: t.string(), step: t.u32() }, (ctx, { mode, step }) =>
  run(ctx, (s, me) => scenario.scenarioGoto(s, me, mode, step)),
);

/** A generated site of about `gpus` GPUs for scale tests. The 3D view only draws the demo hall. */
export const seedScaleSite = spacetimedb.reducer({ gpus: t.u32() }, (ctx, { gpus }) =>
  run(ctx, (s, me) => {
    cmd.seedScaleSite(s, me, gpus);
    scenario.setReady(s, 'squawk', 'scale', `Scale site with about ${gpus} GPUs. The 3D view only draws the demo hall.`);
  }),
);

export const advanceClock = spacetimedb.reducer({ minutes: t.u32() }, (ctx, { minutes }) =>
  run(ctx, (s, me) => cmd.advanceClock(s, me, minutes)),
);

// ---------------------------------------------------------------- facility events

export const setPartState = spacetimedb.reducer({ part: t.string(), state: t.string() }, (ctx, a) =>
  run(ctx, (s, me) => cmd.setPartState(s, me, a.part, a.state)),
);

export const setNodeState = spacetimedb.reducer({ node: t.string(), state: t.string() }, (ctx, a) =>
  run(ctx, (s, me) => cmd.setNodeState(s, me, a.node, a.state)),
);

export const reportNodeFailure = spacetimedb.reducer({ node: t.string() }, (ctx, a) =>
  run(ctx, (s, me) => cmd.reportNodeFailure(s, me, a.node)),
);

// ---------------------------------------------------------------- the interlock

/**
 * Ask before acting. kind: node_repair | rack_work | hot_aisle_work | facility_work |
 * switch_firmware | sw_online | sw_exclusive. target: node, rack, row-N, ha-N, part or job id.
 * startInMin / durationMin: 0 = now / the kind's default. dryRun: verdict only (simulate).
 * ticket: your own id, so you can find the result row in `work`. routine: routine work an
 * agent may queue and rebook if refused. note: free text, kept as data. onBehalfOf: book for
 * that actor (by name): needs book_for_others, and the check runs as them ('' = yourself).
 */
export const requestWork = spacetimedb.reducer(
  {
    kind: t.string(),
    target: t.string(),
    startInMin: t.u32(),
    durationMin: t.u32(),
    dryRun: t.bool(),
    ticket: t.string(),
    routine: t.bool(),
    note: t.string(),
    onBehalfOf: t.string(),
  },
  (ctx, a) => run(ctx, (s, me) => cmd.requestWork(s, me, a)),
);

export const approveWork = spacetimedb.reducer({ id: t.u64() }, (ctx, { id }) =>
  run(ctx, (s, me) => cmd.approveWork(s, me, id)),
);

export const rejectWork = spacetimedb.reducer({ id: t.u64(), note: t.string() }, (ctx, { id, note }) =>
  run(ctx, (s, me) => cmd.rejectWork(s, me, id, note)),
);

/** The requester, a shift lead, or the fixer for a protection lock whose job has finished. */
export const releaseWork = spacetimedb.reducer({ id: t.u64(), note: t.string() }, (ctx, { id, note }) =>
  run(ctx, (s, me) => cmd.releaseWork(s, me, id, note)),
);

// ---------------------------------------------------------------- the work board: who does what

/** A worker takes a maintenance lease on (technician, facility, shift lead). Bookkeeping, not a verdict. */
export const acceptWork = spacetimedb.reducer({ id: t.u64() }, (ctx, { id }) => run(ctx, (s, me) => cmd.acceptWork(s, me, id)));

/** The work is done: the active lease ends now and a failed or degraded hardware target comes back ok. */
export const completeWork = spacetimedb.reducer({ id: t.u64(), note: t.string() }, (ctx, { id, note }) =>
  run(ctx, (s, me) => cmd.completeWork(s, me, id, note)),
);

// ---------------------------------------------------------------- agent events (DESIGN.md §4.3)

/**
 * An agent's own row in the decision feed: type agent_plan | agent_step | agent | tech_dispatched |
 * notified | escalated; subject: the node, part, job or work ('#12') it is about; data: a JSON
 * object with the fields the view and other agents read (steps, status, trade, to, ...).
 */
export const recordEvent = spacetimedb.reducer(
  { type: t.string(), subject: t.string(), reason: t.string(), data: t.string() },
  (ctx, a) => run(ctx, (s, me) => cmd.recordEvent(s, me, a.type, a.subject, a.reason, a.data)),
);

// ---------------------------------------------------------------- big-job failure

export const diagnoseFailure = spacetimedb.reducer({ nodes: t.array(t.string()) }, (ctx, { nodes }) =>
  run(ctx, (s, me) => cmd.diagnoseFailure(s, me, nodes)),
);

export const safePlacement = spacetimedb.reducer(
  {
    job: t.string(),
    needed: t.u32(),
    durationMin: t.u32(),
    exclude: t.array(t.string()),
    diagnosisId: t.u64(),
  },
  (ctx, a) => run(ctx, (s, me) => cmd.requestPlacement(s, me, a)),
);

export const restartJob = spacetimedb.reducer({ job: t.string(), placementId: t.u64() }, (ctx, a) =>
  run(ctx, (s, me) => cmd.restartJob(s, me, a.job, a.placementId)),
);

/** The job is done: its nodes return to the pool; a protection lease it held stays until released. */
export const finishJob = spacetimedb.reducer({ job: t.string() }, (ctx, { job }) =>
  run(ctx, (s, me) => cmd.finishJob(s, me, job)),
);

/** The naive scheduler: swap in the nearest free node and restart, no diagnosis, no check. */
export const naiveRestart = spacetimedb.reducer({ job: t.string(), failedNode: t.string() }, (ctx, a) =>
  run(ctx, (s, me) => cmd.naiveRestart(s, me, a.job, a.failedNode)),
);

export const requestProtection = spacetimedb.reducer(
  { job: t.string(), durationMin: t.u32(), ticket: t.string() },
  (ctx, a) => run(ctx, (s, me) => cmd.requestProtection(s, me, a.job, a.durationMin, a.ticket)),
);
