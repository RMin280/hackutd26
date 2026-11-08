// Repairs, backend against the view's mock. The tech gull marks things repaired through the
// store: on the mock that is frontend/src/mock/repair.ts, live it is the backend's
// set_part_state / set_node_state with "ok". Both must leave the view with the same hall and
// the same feed row, or the gull would behave differently on stage than in rehearsal.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toEvents, toSite, toWorld } from '../../frontend/src/live/mapping';
import { repairWorld, type RepairTarget } from '../../frontend/src/mock/repair';
import { initialWorld, SCENARIOS } from '../../frontend/src/mock/scenario';
import { buildSite as buildMockSite } from '../../frontend/src/mock/site';
import type { World } from '../../frontend/src/model/types';
import { setNodeState, setPartState } from '../src/core/commands';
import { ensureScriptedActors, scenarioNext, scenarioStart } from '../src/core/scenario';
import { demo, ID } from './helpers';
import { tablesOf } from './tables';

const LEAD = 'Shift lead'; // the name helpers.ts gives ID.lead; live, the control room calls itself "Control room"

const view = (w: World) => ({
  partState: w.partState,
  nodeState: w.nodeState,
  margins: Object.fromEntries(Object.entries(w.margins).map(([r, m]) => [r, `${m.level} p${m.power} c${m.cooling} ${m.unprotected.join('>')}`])),
});

/** Both sides after the first two steps of the Squawk scenario: CDU-3 degraded, node-417 failed. */
function broken() {
  const s = demo();
  ensureScriptedActors(s);
  scenarioStart(s, ID.lead, 'squawk');
  const mockSite = buildMockSite();
  let mock = initialWorld(mockSite);
  for (const step of SCENARIOS.squawk.slice(0, 2)) {
    scenarioNext(s, ID.lead, 'squawk');
    mock.now = step.at;
    step.run({ site: mockSite, world: mock, emit: () => {} });
  }
  const site = toSite(tablesOf(s));
  assert.equal(toWorld(tablesOf(s), site).partState['cdu-3'], 'degraded');
  assert.equal(toWorld(tablesOf(s), site).nodeState['node-417'], 'failed');
  return {
    s,
    site,
    mockSite,
    get mock() {
      return mock;
    },
    repair(target: RepairTarget) {
      if (target.kind === 'part') setPartState(s, ID.lead, target.id, 'ok');
      else setNodeState(s, ID.lead, target.id, 'ok');
      const done = repairWorld(mockSite, mock, target, LEAD);
      assert.ok(done, `${target.id} was broken on the mock too`);
      mock = done.world;
      return done.event;
    },
  };
}

for (const target of [
  { kind: 'part', id: 'cdu-3' },
  { kind: 'node', id: 'node-417' },
] as const) {
  test(`repairing ${target.id}: same hall and same feed row on the backend and the mock`, () => {
    const b = broken();
    const mockEvent = b.repair(target);
    const t = tablesOf(b.s);
    assert.deepEqual(view(toWorld(t, b.site)), view(b.mock));
    const [latest] = toEvents(t.decision);
    assert.deepEqual(
      { actor: latest.actor, actorKind: latest.actorKind, title: latest.title, verdict: latest.verdict, reason: latest.reason, focus: latest.focus },
      mockEvent,
    );
  });
}

test('repairing CDU-3 gives its racks their backup back', () => {
  const b = broken();
  b.repair({ kind: 'part', id: 'cdu-3' });
  const world = toWorld(tablesOf(b.s), b.site);
  for (const r of b.site.downstream['cdu-3']) assert.equal(world.margins[r].level, 'green', r);
});

test('something that is not broken is left alone, with no feed row', () => {
  const site = buildMockSite();
  const world = initialWorld(site);
  assert.equal(repairWorld(site, world, { kind: 'part', id: 'cdu-3' }), null);
  assert.equal(repairWorld(site, world, { kind: 'node', id: 'node-417' }), null);
  world.partState['cdu-4'] = 'maintenance';
  assert.equal(repairWorld(site, world, { kind: 'part', id: 'cdu-4' }), null, 'maintenance is on purpose, not a fault');
});
