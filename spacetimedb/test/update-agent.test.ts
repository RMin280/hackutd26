// The update agent's role (agents/patch): software work only, checked like everyone else's.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordEvent, requestWork } from '../src/core/commands';
import { RequestError } from '../src/core/types';
import { demo, work } from './helpers';
import type { MemStore } from './memstore';

const UPD = '4'.repeat(64);

function hall(): MemStore {
  const s = demo();
  s.putActor({ identity: UPD, name: 'update-agent', role: 'update_agent', rows: [] });
  return s;
}

test('the update agent patches online alongside a running job, and offline only where nothing runs', () => {
  const s = hall();
  assert.equal(requestWork(s, UPD, work('sw_online', 'job-train-1')).verdict, 'allow');
  assert.equal(requestWork(s, UPD, work('sw_exclusive', 'node-1028')).verdict, 'allow'); // free spare
  assert.equal(requestWork(s, UPD, work('sw_exclusive', 'node-417')).verdict, 'deny'); // job-train-1 holds it
  assert.equal(requestWork(s, UPD, work('switch_firmware', 'sw-leaf-r1')).verdict, 'deny'); // the job's nodes sit below it
});

test('the update agent can not touch hardware or facility parts, nor book for others', () => {
  const s = hall();
  for (const [kind, target] of [
    ['node_repair', 'node-1028'],
    ['facility_work', 'cdu-9'],
    ['rack_work', 'rack-r9-01'],
    ['hot_aisle_work', 'ha-5'],
  ]) {
    assert.throws(() => requestWork(s, UPD, work(kind, target)), RequestError, `${kind} should be refused`);
  }
  assert.throws(() => requestWork(s, UPD, { ...work('sw_online', 'node-1028'), onBehalfOf: 'Cooling agent' }), RequestError);
});

test('the update agent writes its own rows to the feed, attributed to it', () => {
  const s = hall();
  recordEvent(s, UPD, 'agent_plan', 'node-1028', 'Plan', JSON.stringify({ steps: [{ tool: 'book_wave' }] }));
  const row = s.decisions[s.decisions.length - 1];
  assert.equal(row.actor, 'update-agent');
  assert.equal(row.actorKind, 'updater');
  assert.equal(row.type, 'agent_plan');
});
