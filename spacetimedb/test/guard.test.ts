import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceClock,
  approveWork,
  releaseWork,
  requestProtection,
  requestWork,
  setPartState,
} from '../src/core/commands';
import { compatible, footprint } from '../src/core/footprint';
import { RequestError } from '../src/core/types';
import { demo, ID, work } from './helpers';

// rack-r9-01 holds node-1025..1032: slots 0-2 tenant-gamma, slots 3-7 free spares.
const FREE_A = 'node-1028';
const FREE_B = 'node-1029';
const GAMMA = 'node-1025';

test('lock modes: only intent+intent and shared+shared are compatible', () => {
  assert.equal(compatible('I', 'I'), true);
  assert.equal(compatible('S', 'S'), true);
  for (const [a, b] of [['I', 'S'], ['I', 'X'], ['S', 'X'], ['X', 'X'], ['S', 'I'], ['X', 'I']]) {
    assert.equal(compatible(a, b), false, `${a}+${b}`);
  }
});

test('scopes: what each kind of work claims', () => {
  const s = demo();
  const node = footprint(s, 'node_repair', 'node-417');
  assert.deepEqual(
    node.claims.map((c) => `${c.mode} ${c.resource}`),
    ['X node:node-417', 'I rack:rack-r1-12', 'I aisle:ha-1', 'X svc:node-417'],
  );
  const rack = footprint(s, 'rack_work', 'rack-r1-12');
  assert.equal(rack.claims.filter((c) => c.resource.startsWith('svc:')).length, 8);
  assert.equal(rack.offlineNodes.length, 8);
  const aisle = footprint(s, 'hot_aisle_work', 'ha-1');
  assert.deepEqual(aisle.claims, [{ resource: 'aisle:ha-1', mode: 'X' }]);
  assert.equal(aisle.racks.length, 32, 'a hot aisle spans both of its rows');
  const leaf = footprint(s, 'switch_firmware', 'sw-leaf-r3');
  assert.equal(leaf.nodes.length, 128, 'a leaf switch takes every node in its row off the network');
  assert.equal(leaf.withJobs, false);
  const online = footprint(s, 'sw_online', 'job-train-1');
  assert.equal(online.nodes.length, 1000);
  assert.equal(online.withJobs, true);
  assert.throws(() => footprint(s, 'sw_exclusive', 'cdu-4'), RequestError);
  assert.throws(() => footprint(s, 'switch_firmware', 'cdu-4'), RequestError);
});

test('facility work that leaves racks on their last feed needs approval', () => {
  const s = demo();
  const w = requestWork(s, ID.cool, work('facility_work', 'cdu-4'));
  assert.equal(w.verdict, 'warn');
  assert.equal(w.status, 'needs_approval');
  assert.match(w.reason, /leaves 10 racks one failure from an outage \(exposes job-train-1\)/);
  assert.equal(s.claimsOn('part:cdu-4').length, 0, 'waiting requests claim nothing');
  const ok = approveWork(s, ID.lead, w.id);
  assert.equal(ok.status, 'active');
  assert.equal(s.part('cdu-4')!.heldBy, ok.id);
  assert.equal(s.margin('rack-r1-11')!.level, 'yellow');
});

test('two maintenance windows that would take both feeds are refused, back-to-back is fine', () => {
  const s = demo();
  const a = requestWork(s, ID.tech, work('facility_work', 'pdu-r3-a'));
  approveWork(s, ID.lead, a.id);
  const b = requestWork(s, ID.tech, work('facility_work', 'pdu-r3-b'));
  assert.equal(b.verdict, 'deny');
  assert.match(b.reason, /PDU-R3-B is the only power feed for 16 racks \(PDU-R3-A offline by #1 until T\+4h\)/);
  assert.equal(b.earliestSafe, 'T+4h (with shift lead approval)');
  assert.equal(b.earliestSafeMin, 240);
  const later = requestWork(s, ID.tech, work('facility_work', 'pdu-r3-b', { startInMin: 240 }));
  assert.equal(later.verdict, 'warn');
});

test('a protection lease refuses maintenance that drops protected racks below full backup', () => {
  const s = demo();
  requestProtection(s, ID.sched, 'job-train-1', 0, '');
  const w = requestWork(s, ID.cool, work('facility_work', 'cdu-4'));
  assert.equal(w.verdict, 'deny');
  assert.match(w.reason, /drops 10 racks protected for job-train-1 below full backup/);
  assert.equal(w.earliestSafe, 'T+72h (with shift lead approval)');
});

test('hands-on work: a node, its rack and its hot aisle exclude each other', () => {
  const s = demo();
  const a = requestWork(s, ID.tech, work('node_repair', FREE_A));
  assert.equal(a.verdict, 'allow', a.reason);
  assert.equal(a.status, 'active');
  assert.equal(s.node(FREE_A)!.heldBy, a.id);

  const b = requestWork(s, ID.tech, work('node_repair', FREE_B));
  assert.equal(b.verdict, 'allow', 'two node repairs in one rack share the rack');

  const rack = requestWork(s, ID.tech, work('rack_work', 'rack-r9-01'));
  assert.equal(rack.verdict, 'deny');
  assert.match(rack.reason, /overlaps hardware repair #1 on node-1028 \(Tech Ana\) until T\+2h/);
  assert.match(rack.reason, /run tenant-gamma/, 'tenant nodes must be drained too');

  const aisle = requestWork(s, ID.tech, work('hot_aisle_work', 'ha-5'));
  assert.equal(aisle.verdict, 'deny');
  assert.match(aisle.reason, /overlaps hardware repair #1/);

  const again = requestWork(s, ID.tech, work('node_repair', FREE_A));
  assert.equal(again.verdict, 'deny');
  assert.equal(again.earliestSafe, 'T+2h');
});

test('hot aisle work costs every rack in both rows one cooling feed of headroom', () => {
  const s = demo();
  const w = requestWork(s, ID.tech, work('hot_aisle_work', 'ha-5'));
  assert.equal(w.verdict, 'warn');
  assert.match(w.reason, /Opening Hot aisle 5 leaves 32 racks one failure from an outage/);
  approveWork(s, ID.lead, w.id);
  assert.equal(s.aisle('ha-5')!.heldBy, w.id);
  assert.equal(s.margin('rack-r10-16')!.level, 'yellow');
  assert.equal(s.margin('rack-r8-16')!.level, 'green', 'other aisles keep full backup');
  // While the aisle is open, a CDU feeding it can't go too.
  const cdu = requestWork(s, ID.cool, work('facility_work', 'cdu-29'));
  assert.equal(cdu.verdict, 'deny');
  assert.match(cdu.reason, /Hot aisle 5 open by #1/);
});

test('hot aisle work is refused where racks are already on their last cooling feed', () => {
  const s = demo();
  setPartState(s, ID.facility, 'cdu-3', 'degraded');
  const w = requestWork(s, ID.tech, work('hot_aisle_work', 'ha-1'));
  assert.equal(w.verdict, 'deny');
  assert.match(w.reason, /takes the last cooling headroom of 5 racks \(CDU-3 degraded\)/);
  assert.equal(w.earliestSafe, 'after CDU-3 repair');
});

test('software: online updates run alongside jobs, drain-required updates need the nodes to themselves', () => {
  const s = demo();
  const drain = requestWork(s, ID.sched, work('sw_exclusive', 'rack-r3-07'));
  assert.equal(drain.verdict, 'deny');
  assert.match(drain.reason, /^8 nodes in rack-r3-07 run job-train-1\. Drain-required update can't run alongside jobs: drain them first\.$/);
  assert.equal(drain.earliestSafe, 'after job-train-1 releases its 8 nodes');

  const online = requestWork(s, ID.sched, work('sw_online', 'job-train-1'));
  assert.equal(online.verdict, 'allow', online.reason);
  assert.equal(online.mode, 'online');
  assert.equal(online.nodeCount, 1000);
  requestProtection(s, ID.sched, 'job-train-1', 0, '');
  const online2 = requestWork(s, ID.sched, work('sw_online', 'rack-r9-02'));
  assert.equal(online2.verdict, 'allow', 'online updates are fine next to protected racks');
  const drain2 = requestWork(s, ID.sched, work('sw_exclusive', 'rack-r3-07'));
  assert.match(drain2.reason, /overlaps online update #2 on job-train-1/, 'and one update per node at a time');

  const one = requestWork(s, ID.sched, work('sw_exclusive', FREE_A));
  assert.equal(one.verdict, 'allow');
  assert.equal(s.node(FREE_A)!.heldBy, one.id);
});

test('all maintenance on one node is one at a time, online or not', () => {
  const s = demo();
  requestWork(s, ID.tech, work('node_repair', FREE_A));
  const online = requestWork(s, ID.sched, work('sw_online', FREE_A));
  assert.equal(online.verdict, 'deny');
  assert.match(online.reason, /overlaps hardware repair #1/);
});

test('a switch upgrade needs every node below it free', () => {
  const s = demo();
  const busy = requestWork(s, ID.tech, work('switch_firmware', 'sw-leaf-r10'));
  assert.equal(busy.verdict, 'deny');
  assert.match(busy.reason, /48 nodes below Leaf R10 run tenant-gamma/);
  for (const n of s.nodesOwnedBy('tenant-gamma')) if (n.rowNum === 10) s.putNode({ ...n, ownerKind: 'free', ownerId: '' });
  const free = requestWork(s, ID.tech, work('switch_firmware', 'sw-leaf-r10'));
  assert.equal(free.verdict, 'allow', free.reason);
});

test('protected racks refuse hands-on work, not facility work that keeps their backup', () => {
  const s = demo();
  requestProtection(s, ID.sched, 'job-train-1', 0, '');
  // node-1001.. sits in rack-r8-14, which holds tenant-beta only: not protected.
  const free = s.nodesOwnedBy('tenant-beta')[0];
  s.putNode({ ...free, ownerKind: 'free', ownerId: '' });
  assert.equal(requestWork(s, ID.tech, work('node_repair', free.id)).verdict, 'allow');
  // A free node in a protected rack: rack-r1-11 holds only job nodes, so free one up.
  const n = s.node('node-81')!;
  s.putNode({ ...n, ownerKind: 'free', ownerId: '' });
  const inProtected = requestWork(s, ID.tech, work('node_repair', 'node-81'));
  assert.equal(inProtected.verdict, 'deny');
  assert.match(inProtected.reason, /locked for job-train-1 until T\+72h \(protection #1\)/);
});

test('scope: row limits and role limits are checked first', () => {
  const s = demo();
  const w = requestWork(s, ID.coolRow3, work('facility_work', 'cdu-4'));
  assert.equal(w.verdict, 'deny');
  assert.match(w.reason, /scoped to Rows 3–4; CDU-4 is in Row 1/);
  const central = requestWork(s, ID.tech3, work('facility_work', 'ups-a'));
  assert.match(central.reason, /is in the central plant/);
  assert.throws(() => requestWork(s, ID.cool, work('facility_work', 'pdu-r3-a')), /cooling_agent may only request work on chiller \/ cdu parts/);
  assert.throws(() => requestWork(s, ID.sched, work('facility_work', 'cdu-4')), /may not request facility_work/);
  assert.throws(() => requestWork(s, ID.stranger, work('node_repair', FREE_A)), /Unknown identity/);
  assert.throws(() => requestWork(s, ID.tech, work('teleport', FREE_A)), /Unknown work kind/);
  assert.equal(s.audits.filter((a) => a.verdict === 'deny').length, 2, 'scope denials are audited');
});

test('dry runs give the verdict and claim nothing', () => {
  const s = demo();
  const dry = requestWork(s, ID.tech, work('node_repair', FREE_A, { dryRun: true }));
  assert.equal(dry.status, 'simulated');
  assert.equal(dry.verdict, 'allow');
  assert.equal(s.claimsOn(`svc:${FREE_A}`).length, 0);
  assert.equal(requestWork(s, ID.tech, work('node_repair', FREE_A)).verdict, 'allow');
});

test('leases start and expire with the clock; effects are undone', () => {
  const s = demo();
  const w = requestWork(s, ID.tech, work('facility_work', 'pdu-r5-a', { startInMin: 60, durationMin: 120 }));
  const granted = approveWork(s, ID.lead, w.id);
  assert.equal(granted.status, 'granted');
  assert.equal(s.part('pdu-r5-a')!.heldBy, 0n);
  advanceClock(s, ID.lead, 60);
  assert.equal(s.work(w.id)!.status, 'active');
  assert.equal(s.part('pdu-r5-a')!.heldBy, w.id);
  assert.equal(s.margin('rack-r5-01')!.level, 'yellow');
  advanceClock(s, ID.lead, 120);
  assert.equal(s.work(w.id)!.status, 'done');
  assert.equal(s.part('pdu-r5-a')!.heldBy, 0n);
  assert.equal(s.margin('rack-r5-01')!.level, 'green');
  assert.equal(s.claimsOn('part:pdu-r5-a').length, 0);
});

test('releasing early frees the claim; approval re-checks the facility', () => {
  const s = demo();
  const a = requestWork(s, ID.tech, work('node_repair', FREE_A));
  releaseWork(s, ID.tech, a.id);
  assert.equal(s.work(a.id)!.status, 'done');
  assert.equal(s.node(FREE_A)!.heldBy, 0n);
  assert.equal(requestWork(s, ID.tech, work('node_repair', FREE_A)).verdict, 'allow');

  const pending = requestWork(s, ID.tech, work('facility_work', 'pdu-r6-a'));
  assert.equal(pending.status, 'needs_approval');
  const other = requestWork(s, ID.tech, work('facility_work', 'pdu-r6-b'));
  approveWork(s, ID.lead, other.id);
  const late = approveWork(s, ID.lead, pending.id);
  assert.equal(late.status, 'denied', 'the facility changed while it waited');
  assert.match(late.reason, /^Re-checked at approval:/);
  assert.throws(() => approveWork(s, ID.tech, pending.id), /not allowed to approve/);
});

test('a tenant node can be repaired once it is drained', () => {
  const s = demo();
  assert.equal(requestWork(s, ID.tech, work('node_repair', GAMMA)).verdict, 'deny');
  const n = s.node(GAMMA)!;
  s.putNode({ ...n, ownerKind: 'free', ownerId: '' });
  assert.equal(requestWork(s, ID.tech, work('node_repair', GAMMA)).verdict, 'allow');
});
