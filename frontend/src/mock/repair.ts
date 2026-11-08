// The mock's stand-in for marking a node or part repaired: the backend's set_part_state /
// set_node_state with state "ok" (spacetimedb/src/core/commands.ts). The same change to the
// world and the same feed row, so the tech gull behaves the same on the mock and live.
// spacetimedb/test/repair-contract.test.ts checks the two against each other.

import type { DecisionEvent, Site, World } from '../model/types';
import { computeMargins } from './engine';
import { label } from './site';

export interface RepairTarget {
  kind: 'node' | 'part';
  id: string;
}

export interface Repaired {
  world: World;
  event: Omit<DecisionEvent, 'seq' | 'time'>;
}

/** The world with `target` back to ok, and the feed row for it. Null if it wasn't failed or degraded. */
export function repairWorld(site: Site, world: World, target: RepairTarget, actor = 'Control room'): Repaired | null {
  const was = target.kind === 'part' ? world.partState[target.id] : world.nodeState[target.id];
  if (was !== 'failed' && was !== 'degraded') return null;
  const next: World = structuredClone(world);

  if (target.kind === 'node') {
    next.nodeState[target.id] = 'ok';
    return {
      world: next,
      event: {
        actor,
        actorKind: 'facility',
        title: `${target.id} back in service`,
        verdict: 'info',
        reason: `Marked ok by ${actor}.`,
        focus: { kind: 'node', id: target.id },
      },
    };
  }

  next.partState[target.id] = 'ok';
  next.margins = computeMargins(site, next);
  const green = (site.downstream[target.id] ?? []).filter((r) => next.margins[r]?.level === 'green').length;
  const P = label(target.id);
  return {
    world: next,
    event: {
      actor,
      actorKind: 'facility',
      title: `${P} repaired`,
      verdict: 'info',
      reason: `${P} is back. ${green.toLocaleString('en-US')} ${green === 1 ? 'rack' : 'racks'} below it have full backup.`,
      focus: { kind: 'part', id: target.id },
    },
  };
}
