// A busy shift's worth of work, laid over whatever the hall holds right now: the work board's
// demo content (seed_shift, for the presenter). Every request goes through the interlock as a
// scripted actor, so each verdict is real for the hall as it stands; the follow-ups (an approval,
// a tech taking a repair on, a repair completed) only happen when the verdict allows them.
// Nothing here decides anything. Idempotent: a ticket that already exists is left alone.

import { acceptWork, approveWork, completeWork, reportNodeFailure, requestWork, setNodeState, type WorkArgs } from './commands';
import { ensureScriptedActors, requirePresenter, SCRIPTED } from './scenario';
import type { Store } from './store';
import type { WorkRow } from './types';

const PREFIX = 'shift-';
const STATUSES = ['active', 'granted', 'needs_approval', 'denied', 'done', 'cancelled', 'rejected', 'expired', 'simulated'];

interface Booking {
  ticket: string;
  actor: keyof typeof SCRIPTED;
  kind: WorkArgs['kind'];
  target: string;
  /** The target is a free spare: use it if it is still free and healthy, else the next free spare in Rows 9–10
   *  (after a Squawk-mode restart the job sits on 40 of them). */
  spare?: boolean;
  startInMin?: number;
  durationMin?: number;
  routine?: boolean;
  note?: string;
  /** What happens before the request (a spare fails, a node reports degraded), given the resolved target. */
  before?: (s: Store, target: string) => void;
  /** What happens after, given the verdict the interlock gave. */
  after?: (s: Store, w: WorkRow) => void;
}

const fail = (s: Store, node: string) => {
  if (s.node(node)?.state === 'ok') reportNodeFailure(s, SCRIPTED.facility.identity, node);
};
const degrade = (s: Store, node: string) => {
  if (s.node(node)?.state === 'ok') setNodeState(s, SCRIPTED.facility.identity, node, 'degraded');
};
const approve = (s: Store, w: WorkRow) => {
  if (w.status === 'needs_approval') approveWork(s, SCRIPTED.lead.identity, w.id);
};
const take = (who: keyof typeof SCRIPTED) => (s: Store, w: WorkRow) => {
  if (w.status === 'active' || w.status === 'granted') acceptWork(s, SCRIPTED[who].identity, w.id);
};
const finish = (who: keyof typeof SCRIPTED, note: string) => (s: Store, w: WorkRow) => {
  if (w.status === 'active') {
    acceptWork(s, SCRIPTED[who].identity, w.id);
    completeWork(s, SCRIPTED[who].identity, w.id, note);
  }
};

/**
 * Rows 9–10 are tenant-gamma (slots 0–2) and free spares (slots 3–7); Rows 1–8 are the job.
 * Node ids: rack-rR-PP slot s = ((R-1)·16 + (PP-1))·8 + s + 1, so node-1037 is rack-r9-02 slot 4.
 */
export const SHIFT: readonly Booking[] = [
  // Automation, running alongside the job: allowed.
  { ticket: 'shift-online-job', actor: 'updates', kind: 'sw_online', target: 'job-train-1', note: 'Monitoring agent 4.2' },
  // A failed spare under repair, with a hardware tech on it.
  { ticket: 'shift-repair-1037', actor: 'hardware', kind: 'node_repair', target: 'node-1037', spare: true, before: fail, after: take('hardware'), note: 'GPU 3 reports XID 79' },
  // A degraded spare, repair booked for later.
  { ticket: 'shift-repair-1158', actor: 'hardware', kind: 'node_repair', target: 'node-1158', spare: true, startInMin: 90, before: degrade, note: 'ECC errors climbing' },
  // A repair already finished this shift.
  { ticket: 'shift-done-1029', actor: 'hardware', kind: 'node_repair', target: 'node-1029', spare: true, before: fail, after: finish('hardware', 'DIMM swapped, memtest clean.') },
  // Facility work: CDU service later (one failure from an outage while it runs: waits for a shift lead).
  { ticket: 'shift-cdu-10', actor: 'tech', kind: 'facility_work', target: 'cdu-10', startInMin: 180, durationMin: 120, note: 'Filter and pump seal' },
  // A PDU breaker swap later, approved by the on-call shift lead.
  { ticket: 'shift-pdu-r10-b', actor: 'tech', kind: 'facility_work', target: 'pdu-r10-b', startInMin: 240, durationMin: 60, after: approve, note: 'Breaker swap' },
  // Containment work on the spares' aisle, after the repairs there are done.
  { ticket: 'shift-ha-5', actor: 'tech', kind: 'hot_aisle_work', target: 'ha-5', startInMin: 300, durationMin: 120, after: approve, note: 'Door closer and roof panel' },
  // A leaf upgrade with tenant nodes below it: refused until they drain.
  { ticket: 'shift-leaf-r10', actor: 'network', kind: 'switch_firmware', target: 'sw-leaf-r10', startInMin: 360, routine: true, note: 'NOS 9.4.1' },
  // A driver on a rack with tenant nodes: refused; on a free spare: allowed.
  { ticket: 'shift-driver-r9-05', actor: 'updates', kind: 'sw_exclusive', target: 'rack-r9-05', routine: true, note: 'GPU driver 560' },
  { ticket: 'shift-driver-1045', actor: 'updates', kind: 'sw_exclusive', target: 'node-1045', spare: true, note: 'GPU driver 560' },
  // A UPS test that would take backup from the job's racks.
  { ticket: 'shift-ups-a', actor: 'tech', kind: 'facility_work', target: 'ups-a', startInMin: 60, routine: true, note: 'Quarterly battery test' },
  // An online update across Row 10's nodes.
  { ticket: 'shift-online-row10', actor: 'updates', kind: 'sw_online', target: 'row-10', note: 'Live kernel patch' },
  // Rack work on a rack with tenant nodes: refused until drained.
  { ticket: 'shift-rack-r10-16', actor: 'hardware', kind: 'rack_work', target: 'rack-r10-16', note: 'Rear-door heat exchanger' },
];

/** The preferred spare if it is still free and healthy, else the next free, healthy spare in Rows 9–10 not used yet. */
function pickSpare(s: Store, preferred: string, used: Set<string>): string {
  const ok = (id: string) => {
    const n = s.node(id);
    return !!n && n.ownerKind === 'free' && n.state === 'ok' && n.heldBy === 0n && !used.has(id);
  };
  if (ok(preferred)) return preferred;
  const free = s
    .freeNodes()
    .filter((n) => n.rowNum >= 9 && ok(n.id))
    .sort((a, b) => b.ord - a.ord); // from the far end of Row 10: placement takes spares from the near end
  return free[0]?.id ?? preferred;
}

function existingTickets(s: Store): Set<string> {
  const out = new Set<string>();
  for (const st of STATUSES) for (const w of s.workByStatus(st)) if (w.ticket.startsWith(PREFIX)) out.add(w.ticket);
  return out;
}

/** Lays the shift's work over the current hall. Returns the work rows it created (none if already seeded). */
export function seedShift(s: Store, identity: string): WorkRow[] {
  requirePresenter(s, identity);
  ensureScriptedActors(s);
  const seen = existingTickets(s);
  const used = new Set<string>();
  const made: WorkRow[] = [];
  for (const b of SHIFT) {
    if (seen.has(b.ticket)) continue;
    const target = b.spare ? pickSpare(s, b.target, used) : b.target;
    used.add(target);
    b.before?.(s, target);
    const w = requestWork(s, SCRIPTED[b.actor].identity, {
      kind: b.kind,
      target,
      startInMin: b.startInMin ?? 0,
      durationMin: b.durationMin ?? 0,
      dryRun: false,
      ticket: b.ticket,
      routine: b.routine ?? false,
      note: b.note ?? '',
    });
    b.after?.(s, w);
    made.push(s.work(w.id) ?? w);
  }
  return made;
}
