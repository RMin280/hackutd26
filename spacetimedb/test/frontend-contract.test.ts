// Contract test between the backend and the control-room view.
//
// Runs the scenario on the backend, turns its rows into the view's Site/World through
// frontend/src/live/mapping.ts (what the live view does), and checks every step against
// the frontend's own mock engine (frontend/src/mock), which the view was built on.
// If either side changes shape or behaviour, this breaks.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toScenario, toSite, toWorld } from '../../frontend/src/live/mapping';
import { initialWorld, SCENARIOS } from '../../frontend/src/mock/scenario';
import { buildSite as buildMockSite } from '../../frontend/src/mock/site';
import type { FocusTarget, World } from '../../frontend/src/model/types';
import { ensureScriptedActors, scenarioNext, scenarioStart } from '../src/core/scenario';
import { demo, ID } from './helpers';
import { tablesOf } from './tables';

const camera = (f: FocusTarget | undefined) =>
  !f || f.kind === 'overview'
    ? 'overview'
    : f.kind === 'racks'
      ? `racks ${[...f.ids].sort().join(',')} | ${[...(f.parts ?? [])].join(',')}`
      : `${f.kind} ${f.id}`;

function comparable(w: World) {
  return {
    now: w.now,
    partState: w.partState,
    nodeState: w.nodeState,
    owner: w.owner,
    margins: Object.fromEntries(
      Object.entries(w.margins).map(([r, m]) => [r, `${m.level} p${m.power} c${m.cooling} ${m.unprotected.join('>')}`]),
    ),
    job: { ...w.job },
    leases: w.leases.map((l) => ({ type: l.type, racks: [...(l.racks ?? [])].sort(), job: l.job, start: l.start, end: l.end })),
    diagnosis: w.diagnosis && { ...w.diagnosis, atRisk: [...w.diagnosis.atRisk].sort() },
    placement: w.placement && { nodes: w.placement.nodes, reason: w.placement.reason },
    deniedRequests: w.deniedRequests,
  };
}

test('the backend builds the same hall the view draws', () => {
  const s = demo();
  assert.deepEqual(toSite(tablesOf(s)), buildMockSite());
});

for (const mode of ['naive', 'squawk'] as const) {
  test(`${mode}: every step matches the view's mock engine`, () => {
    const s = demo();
    ensureScriptedActors(s);
    scenarioStart(s, ID.lead, mode);
    const site = toSite(tablesOf(s));

    const mockSite = buildMockSite();
    const mockWorld = initialWorld(mockSite);
    assert.deepEqual(comparable(toWorld(tablesOf(s), site)), comparable(mockWorld), 'ready state');

    SCENARIOS[mode].forEach((step, i) => {
      scenarioNext(s, ID.lead, mode);
      mockWorld.now = step.at;
      const mockOut = step.run({ site: mockSite, world: mockWorld, emit: () => {} });

      const t = tablesOf(s);
      const sc = toScenario(t.scenario[0]);
      const where = `${mode} step ${i + 1} (${step.title})`;
      assert.equal(sc.stepIndex, i, where);
      assert.deepEqual(comparable(toWorld(t, site)), comparable(mockWorld), where);
      assert.equal(camera(sc.camera), camera(mockOut.camera), `${where}: camera`);
      if (sc.caption !== mockOut.caption) {
        // The backend may say more (e.g. the full earliest safe time), never something else.
        assert.ok(sc.caption.startsWith(mockOut.caption.replace(/\.$/, '')), `${where}: caption\n  ${sc.caption}\n  ${mockOut.caption}`);
      }
    });
  });
}
