// The work board (frontend/src/ui/board/board.ts): the lanes a worker reads, the trade and
// level each piece of work calls for, the lock over its racks and the agents' state. Pure
// functions over the view's shapes; the backend rows come through the live mapping.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toEvents, toSite, toWorkItems, toWorld } from '../../frontend/src/live/mapping';
import { nodesUnder, softwareWork } from '../../frontend/src/scene/software';
import type { DecisionEvent, WorkItem } from '../../frontend/src/model/types';
import {
  DONE_SHOWN,
  LANES,
  TRADES,
  agentCards,
  groupWork,
  laneOf,
  lockOn,
  locks,
  mockWorkItems,
  racksOf,
  tradeFor,
} from '../../frontend/src/ui/board/board';
import { acceptWork, completeWork, requestProtection, requestWork, reportNodeFailure, setPartState } from '../src/core/commands';
import { WORK_KINDS } from '../src/core/catalog';
import { scenarioStart, scenarioNext } from '../src/core/scenario';
import { demo, ID, work } from './helpers';
import { tablesOf } from './tables';

const site = toSite(tablesOf(demo()));

const item = (p: Partial<WorkItem>): WorkItem => ({
  id: '1',
  ticket: '',
  kind: 'node_repair',
  category: 'hardware',
  targetKind: 'node',
  target: 'node-1028',
  targetLabel: 'node-1028',
  actor: 'Tech Ana',
  actorRole: 'technician',
  requestedAt: 0,
  start: 0,
  end: 120,
  status: 'active',
  verdict: 'allow',
  reason: '',
  blockers: [],
  racks: [],
  nodeCount: 1,
  routine: false,
  ...p,
});

test('every kind of work has a trade and a level; facility work goes by the part', () => {
  for (const kind of WORK_KINDS) {
    const target = kind === 'facility_work' ? 'cdu-3' : kind === 'switch_firmware' ? 'sw-leaf-r3' : kind === 'hot_aisle_work' ? 'ha-1' : 'node-1028';
    const t = tradeFor({ kind, targetKind: kind === 'facility_work' || kind === 'switch_firmware' ? 'part' : 'node', target }, site);
    assert.ok(t, `${kind} has no trade`);
    assert.ok(TRADES.includes(t.trade), `${kind}: ${t.trade} is not a trade the filter knows`);
    assert.match(t.level, /^L[123]$/);
  }
  const part = (id: string) => tradeFor({ kind: 'facility_work', targetKind: 'part', target: id }, site)!;
  assert.deepEqual(part('cdu-3'), { trade: 'mechanical tech', level: 'L2' });
  assert.deepEqual(part('pdu-r3-a'), { trade: 'electrical tech', level: 'L2' });
  assert.deepEqual(part('ups-b'), { trade: 'electrical tech', level: 'L3' });
  assert.deepEqual(part('sw-spine-1'), { trade: 'network engineer', level: 'L3' });
  assert.deepEqual(tradeFor({ kind: 'switch_firmware', targetKind: 'part', target: 'sw-leaf-r3' }, site), { trade: 'network engineer', level: 'L2' });
  assert.deepEqual(tradeFor({ kind: 'node_repair', targetKind: 'node', target: 'node-1028' }, site), { trade: 'hardware tech', level: 'L1' });
  assert.equal(tradeFor({ kind: 'protection', targetKind: 'job', target: 'job-train-1' }, site), undefined, 'a lock is nobody’s job');
});

test('lanes: every status lands in one lane, dry runs and locks in none', () => {
  assert.equal(laneOf(item({ status: 'active' })), 'active');
  assert.equal(laneOf(item({ status: 'granted' })), 'booked');
  assert.equal(laneOf(item({ status: 'needs_approval' })), 'approval');
  assert.equal(laneOf(item({ status: 'denied' })), 'refused');
  assert.equal(laneOf(item({ status: 'rejected' })), 'refused');
  for (const status of ['done', 'cancelled', 'expired'] as const) assert.equal(laneOf(item({ status })), 'done');
  assert.equal(laneOf(item({ status: 'simulated' })), null);
  assert.equal(laneOf(item({ kind: 'protection', status: 'active' })), null);
  const items = [
    item({ id: '1', status: 'active', end: 300 }),
    item({ id: '2', status: 'active', end: 200 }),
    item({ id: '3', status: 'granted', start: 500 }),
    item({ id: '4', status: 'granted', start: 400 }),
    item({ id: '5', status: 'denied', kind: 'facility_work', targetKind: 'part', target: 'cdu-4', targetLabel: 'CDU-4' }),
    item({ id: '6', status: 'denied' }),
    item({ id: '7', status: 'done', completedAt: 50 }),
    item({ id: '8', status: 'done', end: 90 }),
    item({ id: '9', status: 'simulated' }),
    item({ id: '10', kind: 'protection', category: 'protection', status: 'active' }),
  ];
  const lanes = groupWork(items, site);
  assert.deepEqual(LANES, ['active', 'booked', 'approval', 'refused', 'done']);
  assert.deepEqual(lanes.active.map((x) => x.id), ['2', '1'], 'the one ending soonest first');
  assert.deepEqual(lanes.booked.map((x) => x.id), ['4', '3'], 'the one starting soonest first');
  assert.deepEqual(lanes.refused.map((x) => x.id), ['6', '5'], 'newest refusal first');
  assert.deepEqual(lanes.done.map((x) => x.id), ['8', '7'], 'most recently finished first');
  assert.equal(lanes.approval.length, 0);
  // The trade filter keeps a lane's order and drops the rest.
  const mech = groupWork(items, site, 'mechanical tech');
  assert.deepEqual(mech.refused.map((x) => x.id), ['5']);
  assert.equal(mech.active.length, 0);
  // Done is capped so the board stays a board, not a log.
  const many = Array.from({ length: DONE_SHOWN + 5 }, (_, i) => item({ id: String(100 + i), status: 'done', end: i }));
  assert.equal(groupWork(many, site).done.length, DONE_SHOWN);
});

test('locks: a protection lease names its racks and rows; work under it carries the lock', () => {
  const s = demo();
  const p = requestProtection(s, ID.sched, 'job-train-1', 0, 'p-1');
  const w = toWorld(tablesOf(s), site);
  const [lock, ...rest] = locks(w, site);
  assert.equal(rest.length, 0);
  assert.equal(lock.id, String(p.id));
  assert.equal(lock.job, 'job-train-1');
  assert.equal(lock.holder, 'Scheduler agent');
  assert.equal(lock.racks.length, p.racks.length);
  assert.deepEqual(lock.rows, [1, 2, 3, 4, 5, 6, 7, 8], 'the job runs in Rows 1–8');
  assert.equal(lock.until, p.endMin);
  // A node repair in Row 1 sits under the lock; a spare in Row 9 does not.
  assert.equal(lockOn(item({ target: 'node-417', racks: [] }), w, site)?.job, 'job-train-1');
  assert.equal(lockOn(item({ target: 'node-1028', racks: [] }), w, site), undefined);
  // CDU-4 feeds Row 1 racks: facility work on it is under the lock through the racks below.
  assert.equal(lockOn(item({ kind: 'facility_work', targetKind: 'part', target: 'cdu-4', racks: [] }), w, site)?.job, 'job-train-1');
  assert.deepEqual(racksOf(item({ target: 'node-417', racks: [] }), site), ['rack-r1-12']);
  assert.deepEqual(racksOf(item({ racks: ['rack-r9-01'] }), site), ['rack-r9-01'], 'what the backend recorded wins');
  // Once the lease has ended, nothing is locked.
  const over = { ...w, now: p.endMin };
  assert.equal(locks(over, site).length, 0);
  assert.equal(lockOn(item({ target: 'node-417', racks: [] }), over, site), undefined);
});

test('the backend’s rows reach the board through the live mapping, bookkeeping included', () => {
  const s = demo();
  reportNodeFailure(s, ID.facility, 'node-1028');
  const w = requestWork(s, ID.fixer, work('node_repair', 'node-1028', { ticket: 'fix-1' }));
  const denied = requestWork(s, ID.cool, { ...work('facility_work', 'cdu-9'), routine: true, note: 'Filter change' });
  acceptWork(s, ID.tech, w.id);
  const items = toWorkItems(tablesOf(s).work, tablesOf(s).assignment);
  const repair = items.find((i) => i.id === String(w.id))!;
  assert.equal(repair.kind, 'node_repair');
  assert.equal(repair.category, 'hardware');
  assert.equal(repair.status, 'active');
  assert.equal(repair.actor, 'Fixer agent');
  assert.equal(repair.assignee, 'Tech Ana');
  assert.equal(repair.assigneeRole, 'technician');
  assert.equal(repair.acceptedAt, 0);
  assert.equal(repair.completedBy, undefined);
  assert.equal(repair.completedAt, undefined);
  assert.equal(repair.bookedBy, undefined);
  const cdu = items.find((i) => i.id === String(denied.id))!;
  assert.equal(cdu.status, denied.status);
  assert.equal(cdu.routine, true);
  assert.equal(cdu.note, 'Filter change');
  assert.equal(cdu.verdict, denied.verdict);
  assert.equal(cdu.assignee, undefined, 'nobody took it on');
  completeWork(s, ID.tech, w.id, 'DIMM swapped');
  const after = toWorkItems(tablesOf(s).work, tablesOf(s).assignment).find((i) => i.id === String(w.id))!;
  assert.equal(after.status, 'done');
  assert.equal(after.completedBy, 'Tech Ana');
  assert.deepEqual(after.repaired, ['node-1028']);
  assert.equal(after.completionNote, 'DIMM swapped');
  // The world carries the same list, and the lanes read it.
  const world = toWorld(tablesOf(s), site);
  assert.equal(world.work?.length, items.length);
  const lanes = groupWork(world.work!, site);
  assert.deepEqual(lanes.done.map((x) => x.id), [String(w.id)]);
  // Without the assignment table (older bindings) the items still map, without bookkeeping.
  const bare = toWorkItems(tablesOf(s).work);
  assert.equal(bare.find((i) => i.id === String(w.id))!.assignee, undefined);
});

test('agent cards: one per agent, newest row sets the state, counts of fixes and hand-offs', () => {
  const s = demo();
  scenarioStart(s, ID.lead, 'squawk');
  for (let i = 0; i < 6; i++) scenarioNext(s, ID.lead, 'squawk');
  const events = toEvents(tablesOf(s).decision);
  const cards = agentCards(events);
  const names = cards.map((c) => c.actor);
  assert.ok(names.includes('Scheduler agent'), `scheduler on the board: ${names.join(', ')}`);
  assert.ok(names.includes('Cooling agent'), 'cooling agent on the board');
  assert.ok(!names.includes('Squawk'), 'the interlock itself is not an agent card');
  const cooling = cards.find((c) => c.actor === 'Cooling agent')!;
  assert.equal(cooling.kind, 'cooling');
  assert.equal(cooling.state, 'working', 'a lease request is work in progress');
  assert.match(cooling.lastTitle, /CDU-4/);
  // The fixer's own rows: status comes from the agent row's data.
  let seq = 1000;
  const fixerRow = (p: Partial<DecisionEvent>): DecisionEvent => ({
    seq: ++seq,
    time: 35,
    actor: 'fixer-agent',
    actorKind: 'fixer',
    title: '',
    verdict: 'info',
    reason: '',
    focus: { kind: 'node', id: 'node-1118' },
    type: 'agent_step',
    subject: 'node-1118',
    ...p,
  });
  const fixer = [
    fixerRow({ type: 'agent', title: 'Working on node-1118', data: JSON.stringify({ status: 'started' }) }),
    fixerRow({ type: 'agent_plan', verdict: 'plan', title: 'Plan for node-1118: diagnose_node → take_node_out_of_service' }),
    fixerRow({ title: 'Took node-1118 out of service' }),
    fixerRow({ type: 'agent', verdict: 'fixed', title: 'Fixed node-1118', data: JSON.stringify({ status: 'fixed' }), time: 40 }),
    fixerRow({ type: 'agent', verdict: 'handoff', title: 'Handed off cdu-3', subject: 'cdu-3', data: JSON.stringify({ status: 'handed_off' }), time: 41 }),
  ];
  const newestFirst = [...fixer].reverse();
  const [card] = agentCards(newestFirst);
  assert.equal(card.actor, 'fixer-agent');
  assert.equal(card.kind, 'fixer');
  assert.equal(card.state, 'handoff', 'the newest row decides');
  assert.equal(card.subject, 'cdu-3');
  assert.equal(card.lastSeen, 41);
  assert.equal(card.rows, 5);
  assert.equal(card.fixed, 1);
  assert.equal(card.handoffs, 1);
  const working = agentCards(newestFirst.slice(2));
  assert.equal(working[0].state, 'working');
  const waiting = agentCards([fixerRow({ type: 'agent', title: 'Waiting on cdu-4', data: JSON.stringify({ status: 'waiting' }) })]);
  assert.equal(waiting[0].state, 'waiting');
  const stopped = agentCards([fixerRow({ type: 'agent', verdict: 'warn', title: 'Stopped on node-1118: failed closed', data: 'not json' })]);
  assert.equal(stopped[0].state, 'stopped', 'bad data falls back to the verdict');
  // The plan row says which model wrote it; the card carries the newest one.
  const planned = agentCards(
    [
      fixerRow({ type: 'agent_plan', verdict: 'plan', title: 'Plan for node-1118', data: JSON.stringify({ steps: [], model: 'nvidia/nemotron-3-super-120b-a12b via OpenRouter' }) }),
      fixerRow({ type: 'agent', verdict: 'fixed', title: 'Fixed node-1118', data: JSON.stringify({ status: 'fixed' }) }),
    ].reverse(),
  );
  assert.equal(planned[0].model, 'nvidia/nemotron-3-super-120b-a12b via OpenRouter');
  assert.equal(card.model, undefined, 'no plan row with a model: none shown');
  // The update agent (its own kind since the updater popups) keeps its card.
  const updater = agentCards([fixerRow({ actor: 'update-agent', actorKind: 'updater', type: 'agent', title: 'Waiting on SQK-SIM-2026-0419', subject: 'SQK-SIM-2026-0419', data: JSON.stringify({ status: 'waiting' }) })]);
  assert.deepEqual([updater[0]?.actor, updater[0]?.kind, updater[0]?.state], ['update-agent', 'updater', 'waiting']);
});

test('offline the mock’s leases still read as items', () => {
  const s = demo();
  setPartState(s, ID.facility, 'cdu-3', 'degraded');
  const p = requestProtection(s, ID.sched, 'job-train-1', 0, 'p-1');
  const w = toWorld(tablesOf(s), site);
  const items = mockWorkItems({ leases: w.leases, now: w.now }, site);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'protection');
  assert.equal(items[0].id, String(p.id));
  assert.equal(items[0].status, 'active');
  assert.equal(laneOf(items[0]), null, 'a lock, not a lane');
  assert.equal(locks({ leases: w.leases, now: w.now }, site).length, 1);
});

test('software work under way maps onto the nodes and switches the hall colours for it', () => {
  const s = demo();
  // An online patch on the whole job and a driver update on one spare, both active at T+0; a third booked for later.
  const online = requestWork(s, ID.sched, work('sw_online', 'job-train-1', { durationMin: 30 }));
  const driver = requestWork(s, ID.sched, work('sw_exclusive', 'node-1100', { durationMin: 90 }));
  const booked = requestWork(s, ID.sched, work('sw_online', 'rack-r10-01', { startInMin: 120, durationMin: 10 }));
  assert.deepEqual([online.verdict, driver.verdict, booked.verdict], ['allow', 'allow', 'allow']);
  const w = toWorld(tablesOf(s), site);
  const sw = softwareWork(site, w.owner, w.work);
  assert.equal(sw.online.size, 1000, 'the job target covers its 1,000 nodes');
  assert.deepEqual([...sw.drained], ['node-1100']);
  assert.equal(w.nodeState['node-1100'], 'maintenance', 'held out of service while the driver installs');
  assert.equal(w.nodeState['node-1'], 'ok', 'an online update leaves the node running');
  // Booked for later is not under way: the view colours only active work.
  assert.equal((w.work ?? []).find((x) => x.id === String(booked.id))?.status, 'granted');
  assert.deepEqual(nodesUnder(site, w.owner, { targetKind: 'rack', target: 'rack-r10-01' }), site.racks['rack-r10-01'].nodes);
  assert.equal(nodesUnder(site, w.owner, { targetKind: 'row', target: 'row-10' }).length, 128);
  // Switch firmware (every row of the demo hall runs something, so the interlock refuses it there;
  // the view's part is only to colour the switch once a lease is active).
  const firmware = { ...item({ kind: 'switch_firmware', targetKind: 'part', target: 'sw-leaf-r3' }), status: 'active' as const };
  assert.deepEqual([...softwareWork(site, w.owner, [firmware]).parts], ['sw-leaf-r3']);
  assert.equal(softwareWork(site, w.owner, [{ ...firmware, status: 'granted' }]).parts.size, 0);
});
