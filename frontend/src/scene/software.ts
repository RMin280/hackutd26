// Software work under way, from the live `work` table, as the hall colours it: what is being
// updated (an online patch, a drain-required update, switch firmware), kept apart from what is
// broken. Pure: no React, no three.js; tested from spacetimedb/test/view-board.test.ts.

import type { Owner, Site, WorkItem } from '../model/types';

export interface SoftwareWork {
  /** Nodes under an online update: still running, software changing underneath. */
  online: Set<string>;
  /** Nodes held out of service for a drain-required update (reimage, driver, firmware). */
  drained: Set<string>;
  /** Switches rebooting for a firmware upgrade. */
  parts: Set<string>;
}

/** The nodes a piece of software work covers, from its target: a node, a rack, a row or a job. */
export function nodesUnder(site: Site, owner: Record<string, Owner>, w: Pick<WorkItem, 'targetKind' | 'target'>): string[] {
  switch (w.targetKind) {
    case 'node':
      return site.nodes[w.target] ? [w.target] : [];
    case 'rack':
      return site.racks[w.target]?.nodes ?? [];
    case 'row': {
      const row = Number(w.target.replace(/^row-/, ''));
      return site.rackOrder.filter((r) => site.racks[r].row === row).flatMap((r) => site.racks[r].nodes);
    }
    case 'job':
      return site.nodeOrder.filter((n) => {
        const o = owner[n];
        return o?.kind === 'job' && o.id === w.target;
      });
    default:
      return [];
  }
}

/** The work the hall colours: active software leases, by what they do to a node or a switch. */
export function softwareWork(site: Site, owner: Record<string, Owner>, work: readonly WorkItem[] | undefined): SoftwareWork {
  const out: SoftwareWork = { online: new Set(), drained: new Set(), parts: new Set() };
  for (const w of work ?? []) {
    if (w.status !== 'active') continue;
    if (w.kind === 'switch_firmware') out.parts.add(w.target);
    else if (w.kind === 'sw_online' || w.kind === 'sw_exclusive') {
      const into = w.kind === 'sw_online' ? out.online : out.drained;
      for (const n of nodesUnder(site, owner, w)) into.add(n);
    }
  }
  return out;
}
