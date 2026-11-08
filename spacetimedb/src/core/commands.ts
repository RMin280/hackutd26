// Every reducer is one of these commands. Each runs inside a SpacetimeDB
// transaction, so two actors asking for the same backup at the same moment are
// serialized: the second one sees the first one's lease. A bad request throws
// RequestError (rolled back, shown to the caller); a safety "no" is a result,
// written to `work`, the decision feed and the audit log.

import {
  ACTOR_KIND,
  CAN_DO,
  CAN_REQUEST,
  CATALOG,
  PART_TYPES_FOR_ROLE,
  WORK_KINDS,
  isWorkKind,
  type Action,
  type WorkKind,
} from './catalog';
import { diagnose } from './diagnose';
import { compatible, footprint, protectionFootprint, type Footprint } from './footprint';
import { describeWork, earliestSafe, evaluate, type Evaluation } from './guard';
import { computeMargin, marginRow, recomputeRacks } from './margins';
import { safePlacement } from './placement';
import { buildSite, scaleSpec } from './site';
import type { Store } from './store';
import { clock, duration, fmtInt, formatList, formatRows, label, plural } from './text';
import {
  AGENT_EVENT_TYPES,
  HEALTH,
  ROLES,
  RequestError,
  type ActorRow,
  type AgentEventType,
  type DecisionRow,
  type EventType,
  type FeedVerdict,
  type MarginRow,
  type PartType,
  type Role,
  type SiteData,
  type WorkRow,
} from './types';

export const DEFAULT_SETTINGS = { id: 0, openRegistration: true, failureWindowMin: 120 };
export const DEFAULT_PROTECTION_MIN = 72 * 60;
const SQUAWK = { actor: 'Squawk', actorKind: 'squawk', actorRole: 'system' };

// ---------------------------------------------------------------- helpers

function requireActor(s: Store, identity: string): ActorRow {
  const a = s.actor(identity);
  if (!a) throw new RequestError('Unknown identity. Register first (self_register, or ask an admin to register_actor).');
  return a;
}

const ACTION_TEXT: Record<Action, string> = {
  approve: 'approve or reject work',
  set_state: 'change part or node state',
  report_failure: 'report node failures',
  diagnose: 'diagnose failures',
  placement: 'ask for a placement',
  restart: 'restart jobs',
  finish: 'finish jobs',
  protect: 'request protection leases',
  book_for_others: 'book work for other actors',
  record: 'write events to the decision feed',
  clock: 'move the simulated clock',
  present: 'run the demo scenario or reseed the hall',
  admin: 'do admin actions',
};

function requireRole(a: ActorRow, action: Action): void {
  if (!CAN_DO[action].includes(a.role as Role)) {
    throw new RequestError(`${a.name} (${a.role}) is not allowed to ${ACTION_TEXT[action]}. Allowed: ${CAN_DO[action].join(', ')}.`);
  }
}

function who(a: ActorRow) {
  return { actor: a.name, actorKind: ACTOR_KIND[a.role as Role] ?? 'facility', actorRole: a.role };
}

/** A decision-feed row before it gets its seq and time. `type` says what happened (DESIGN.md §4.3);
 *  `subject` what it is about; `data` the typed fields agents read, stored as JSON. */
type Decision = Omit<DecisionRow, 'seq' | 'atMin' | 'focusIds' | 'focusParts' | 'work' | 'type' | 'subject' | 'data'> &
  Partial<Pick<DecisionRow, 'focusIds' | 'focusParts' | 'work' | 'subject'>> & {
    type: EventType;
    data?: Record<string, unknown>; // no bigints: ids go in as strings
  };

function decide(s: Store, d: Decision): void {
  const { data, ...row } = d;
  s.insertDecision({ focusIds: [], focusParts: [], work: 0n, subject: '', ...row, data: JSON.stringify(data ?? {}), atMin: s.now() });
}

/** The lease fields agents read from a lease_* event. */
function leaseData(w: WorkRow): Record<string, unknown> {
  return {
    lease: String(w.id),
    lease_type: w.kind === 'protection' ? 'protection' : 'maintenance',
    kind: w.kind,
    target: w.target,
    target_kind: w.targetKind,
    job: w.job,
    racks: w.racks.length,
    holder: w.actor,
    booked_by: w.bookedBy,
    start: w.startMin,
    until: w.endMin,
    routine: w.routine,
    note: w.note,
  };
}

function audit(s: Store, a: { identity: string; name: string }, action: string, target: string, verdict: string, reason: string) {
  s.insertAudit({ sim: s.now(), identity: a.identity, actor: a.name, action, target, verdict, reason });
}

function focusFor(fp: Footprint): Pick<DecisionRow, 'focusKind' | 'focusIds'> {
  if (fp.targetKind === 'part' || fp.targetKind === 'node' || fp.targetKind === 'rack') {
    return { focusKind: fp.targetKind, focusIds: [fp.target] };
  }
  return { focusKind: 'racks', focusIds: fp.racks };
}

function cleanText(text: string, max = 200): string {
  // Free text is stored as data only; it never feeds a verdict.
  return text.replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
}

// ---------------------------------------------------------------- facility setup

export function siteMargins(site: SiteData): MarginRow[] {
  const ok = new Set(site.parts.filter((p) => p.state === 'ok' && p.heldBy === 0n).map((p) => p.id));
  return site.racks.map((r) => marginRow(r, computeMargin(r, (p) => ok.has(p), 0)));
}

export function seed(s: Store, site: SiteData): void {
  s.clearFacility();
  s.loadSite(site, siteMargins(site));
  s.setNow(0);
}

export function seedScaleSite(s: Store, identity: string, gpus: number): void {
  const a = requireActor(s, identity);
  requireRole(a, 'admin');
  if (gpus < 1000 || gpus > 200000) throw new RequestError('gpus must be between 1,000 and 200,000.');
  const site = buildSite(scaleSpec(gpus));
  seed(s, site);
  decide(s, {
    ...SQUAWK,
    type: 'seed',
    title: `Scale site: ${fmtInt(gpus)} GPUs`,
    verdict: 'info',
    reason: `${fmtInt(site.racks.length)} racks, ${fmtInt(site.nodes.length)} nodes, ${fmtInt(site.parts.length)} facility parts.`,
    focusKind: 'overview',
    data: { racks: site.racks.length, nodes: site.nodes.length, parts: site.parts.length },
  });
  audit(s, a, 'seed_scale_site', String(gpus), 'ok', `${site.nodes.length} nodes`);
}

// ---------------------------------------------------------------- identities (DESIGN.md §9)

function checkRole(role: string): Role {
  if (!(ROLES as readonly string[]).includes(role)) throw new RequestError(`Unknown role "${role}". Use one of: ${ROLES.join(', ')}.`);
  return role as Role;
}

export function bootstrapAdmin(s: Store, identity: string, name = 'Admin'): void {
  if (s.hasAdmin()) return;
  s.putActor({ identity, name, role: 'admin', rows: [] });
  audit(s, { identity, name }, 'bootstrap_admin', identity, 'ok', 'first admin');
}

export function claimAdmin(s: Store, identity: string, name: string): void {
  if (s.hasAdmin()) throw new RequestError('An admin already exists; ask them to register you.');
  bootstrapAdmin(s, identity, cleanText(name, 60) || 'Admin');
}

export function registerActor(s: Store, identity: string, target: string, name: string, role: string, rows: number[]): void {
  const a = requireActor(s, identity);
  requireRole(a, 'admin');
  const r = checkRole(role);
  if (!/^[0-9a-fA-F]{64}$/.test(target)) throw new RequestError('identity must be a 64-character hex string.');
  s.putActor({ identity: target.toLowerCase(), name: cleanText(name, 60), role: r, rows });
  audit(s, a, 'register_actor', target, 'ok', `${name} as ${r} (${rows.length ? formatRows(rows) : 'all rows'})`);
}

export function selfRegister(s: Store, identity: string, name: string, role: string, rows: number[]): void {
  if (!s.settings().openRegistration) throw new RequestError('Open registration is off; ask an admin to register you.');
  const r = checkRole(role);
  if (r === 'admin') throw new RequestError('admin cannot be self-assigned.');
  const existing = s.actor(identity);
  if (existing?.role === 'admin') throw new RequestError('Admins keep their role.');
  s.putActor({ identity, name: cleanText(name, 60), role: r, rows });
  audit(s, { identity, name }, 'self_register', identity, 'ok', `${r} (${rows.length ? formatRows(rows) : 'all rows'})`);
}

export function setOpenRegistration(s: Store, identity: string, open: boolean): void {
  const a = requireActor(s, identity);
  requireRole(a, 'admin');
  s.putSettings({ ...s.settings(), openRegistration: open });
  audit(s, a, 'set_open_registration', String(open), 'ok', '');
}

// ---------------------------------------------------------------- lease effects

/** Apply a lease's effects when its window starts: parts, aisle and nodes held; racks recomputed. */
function activate(s: Store, w: WorkRow): void {
  w.status = 'active';
  s.putWork(w);
  const touched: string[] = [];
  for (const p of w.offlineParts) {
    const part = s.part(p);
    if (!part) continue;
    s.putPart({ ...part, heldBy: w.id });
    touched.push(...s.downstreamRacks(p));
  }
  if (w.kind === 'hot_aisle_work') {
    const aisle = s.aisle(w.target);
    if (aisle) {
      s.putAisle({ ...aisle, heldBy: w.id });
      for (const r of aisle.rows) touched.push(...s.racksInRow(r).map((x) => x.id));
    }
  }
  for (const n of w.offlineNodes) {
    const node = s.node(n);
    if (node) s.putNode({ ...node, heldBy: w.id });
  }
  if (w.kind === 'protection') {
    for (const r of w.racks) {
      const m = s.margin(r);
      if (m && (m.protectedBy === 0n || m.protectedUntil <= w.endMin)) {
        s.putMargin({ ...m, protectedBy: w.id, protectedJob: w.job, protectedUntil: w.endMin });
      }
    }
  }
  recomputeRacks(s, touched);
}

/** End a lease: release its claims and undo its effects. */
function finish(s: Store, w: WorkRow, status: 'done' | 'cancelled', endAt?: number): void {
  const wasActive = w.status === 'active';
  w.status = status;
  if (endAt !== undefined) w.endMin = Math.max(w.startMin, Math.min(w.endMin, endAt));
  s.putWork(w);
  s.deleteClaimsOf(w.id);
  if (!wasActive) return;
  const touched: string[] = [];
  for (const p of w.offlineParts) {
    const part = s.part(p);
    if (part && part.heldBy === w.id) s.putPart({ ...part, heldBy: 0n });
    touched.push(...s.downstreamRacks(p));
  }
  if (w.kind === 'hot_aisle_work') {
    const aisle = s.aisle(w.target);
    if (aisle && aisle.heldBy === w.id) {
      s.putAisle({ ...aisle, heldBy: 0n });
      for (const r of aisle.rows) touched.push(...s.racksInRow(r).map((x) => x.id));
    }
  }
  for (const n of w.offlineNodes) {
    const node = s.node(n);
    if (node && node.heldBy === w.id) s.putNode({ ...node, heldBy: 0n });
  }
  if (w.kind === 'protection') {
    const others = s.workByStatus('active').filter((o) => o.kind === 'protection' && o.id !== w.id);
    for (const r of w.racks) {
      const m = s.margin(r);
      if (!m || m.protectedBy !== w.id) continue;
      const next = others.filter((o) => o.racks.includes(r)).sort((a, b) => b.endMin - a.endMin)[0];
      s.putMargin({
        ...m,
        protectedBy: next?.id ?? 0n,
        protectedJob: next?.job ?? '',
        protectedUntil: next?.endMin ?? -1,
      });
    }
  }
  recomputeRacks(s, touched);
}

function insertClaims(s: Store, w: WorkRow, fp: Footprint): void {
  for (const c of fp.claims) s.insertClaim({ work: w.id, resource: c.resource, mode: c.mode, startMin: w.startMin, endMin: w.endMin });
}

// ---------------------------------------------------------------- the interlock (DESIGN.md §4)

export interface WorkArgs {
  kind: string;
  target: string;
  startInMin: number; // 0 = now
  durationMin: number; // 0 = the kind's default
  dryRun: boolean; // simulate only
  ticket: string;
  routine?: boolean; // routine work: a refusal may be queued and rebooked by the fixer once its blockers clear
  note?: string; // free text; stored as data, never part of the check
  onBehalfOf?: string; // requester's actor name: the caller needs book_for_others, and the check runs as the requester
}

const VERDICT_WORD = { allow: 'allowed', warn: 'needs approval', deny: 'denied' } as const;

export function requestWork(s: Store, identity: string, args: WorkArgs): WorkRow {
  const caller = requireActor(s, identity);
  // Booking for someone else: the requester owns the lease and the check runs as them.
  const forName = (args.onBehalfOf ?? '').trim();
  let a = caller;
  if (forName && forName !== caller.name) {
    requireRole(caller, 'book_for_others');
    const requester = s.actorByName(forName);
    if (!requester) throw new RequestError(`No actor named "${forName}" to book for.`);
    a = requester;
  }
  const booked = a.identity !== caller.identity;
  if (!isWorkKind(args.kind)) throw new RequestError(`Unknown work kind "${args.kind}". Use one of: ${WORK_KINDS.join(', ')}.`);
  const kind: WorkKind = args.kind;
  if (!CAN_REQUEST[a.role as Role]?.includes(kind)) {
    throw new RequestError(`${a.name} (${a.role}) may not request ${kind}. Allowed: ${CAN_REQUEST[a.role as Role]?.join(', ') || 'none'}.`);
  }
  const spec = CATALOG[kind];
  const fp = footprint(s, kind, args.target);
  const limit = PART_TYPES_FOR_ROLE[a.role as Role];
  if (limit && fp.targetKind === 'part' && !limit.includes(s.part(fp.target)!.type as PartType)) {
    throw new RequestError(`${a.role} may only request work on ${limit.join(' / ')} parts.`);
  }

  const now = s.now();
  const start = now + Math.max(0, args.startInMin);
  const end = start + (args.durationMin > 0 ? args.durationMin : spec.defaultMin);

  // Scope (rows) is checked before any safety work.
  const outOfScope = a.rows.length > 0 && fp.rows.some((r) => r === 0 || !a.rows.includes(r));
  let ev: Evaluation | null = null;
  let verdict: 'allow' | 'warn' | 'deny';
  let reason: string;
  let earliest = { text: '', min: -1 };
  if (outOfScope) {
    verdict = 'deny';
    const where = fp.rows.includes(0) ? 'the central plant' : formatRows(fp.rows);
    reason = `${a.name} is scoped to ${formatRows(a.rows)}; ${fp.targetLabel} is in ${where}.`;
  } else {
    ev = evaluate(s, kind, fp, { start, end });
    verdict = ev.verdict;
    reason = ev.reason;
    if (verdict === 'deny') earliest = earliestSafe(s, kind, fp, { start, end }, ev);
  }

  const status = args.dryRun
    ? 'simulated'
    : verdict === 'allow'
      ? start <= now
        ? 'active'
        : 'granted'
      : verdict === 'warn'
        ? 'needs_approval'
        : 'denied';

  const w = s.insertWork({
    ticket: cleanText(args.ticket, 80),
    kind,
    category: spec.category,
    scope: spec.scope,
    mode: spec.category === 'software' && spec.withJobs ? 'online' : 'exclusive',
    targetKind: fp.targetKind,
    target: fp.target,
    targetLabel: fp.targetLabel,
    actor: a.name,
    actorRole: a.role,
    actorIdentity: a.identity,
    requestedAt: now,
    startMin: start,
    endMin: end,
    status,
    verdict,
    reason,
    earliestSafe: earliest.text,
    earliestSafeMin: earliest.min,
    blockers: ev ? ev.blockers.map((b) => b.ref) : [],
    racks: ev && ev.drops.length ? ev.drops.map((d) => d.rack) : fp.racks,
    job: '',
    offlineParts: fp.offlineParts,
    offlineNodes: fp.offlineNodes,
    nodeCount: fp.nodes.length || fp.offlineNodes.length,
    approvedBy: '',
    routine: args.routine ?? false,
    note: cleanText(args.note ?? ''),
    bookedBy: booked ? caller.name : '',
  });
  if (status === 'granted' || status === 'active') {
    insertClaims(s, w, fp);
    if (status === 'active') activate(s, w);
  }

  const when = start > now ? ` from ${clock(start)}` : '';
  const forWhom = booked ? ` for ${a.name}` : '';
  const title = args.dryRun
    ? `Simulated: ${spec.title.toLowerCase()} on ${fp.targetLabel}${forWhom} would be ${VERDICT_WORD[verdict]}`
    : `${spec.title} on ${fp.targetLabel}${when}${forWhom} ${VERDICT_WORD[verdict]}`;
  const type: EventType = args.dryRun ? 'simulated' : verdict === 'allow' ? 'lease_granted' : verdict === 'warn' ? 'approval_requested' : 'lease_denied';
  decide(s, {
    ...who(caller),
    type,
    subject: fp.target,
    title,
    verdict,
    reason: `${reason}${earliest.text ? ` Earliest safe time: ${earliest.text}.` : ''}`,
    ...focusFor(fp),
    work: w.id,
    data: {
      ...leaseData(w),
      verdict,
      status,
      minutes: end - start,
      earliest_safe: earliest.text,
      earliest_safe_min: earliest.min,
      blockers: ev ? ev.blockers.map((b) => ({ ref: b.ref, text: b.text, end: b.end })) : [],
      requested_for: booked ? a.name : '',
    },
  });
  audit(s, caller, `${args.dryRun ? 'simulate' : 'request'}:${kind}${booked ? ` for ${a.name}` : ''}`, fp.target, verdict, reason);
  return w;
}

export function approveWork(s: Store, identity: string, id: bigint): WorkRow {
  const a = requireActor(s, identity);
  requireRole(a, 'approve');
  const w = s.work(id);
  if (!w) throw new RequestError(`No work #${id}.`);
  if (w.status !== 'needs_approval') throw new RequestError(`#${id} is ${w.status}, not waiting for approval.`);
  const kind = w.kind as WorkKind;
  const now = s.now();
  if (w.endMin <= now) {
    w.status = 'expired';
    w.reason = `${w.reason} Approval came after the window closed.`;
    s.putWork(w);
    audit(s, a, 'approve', `#${id}`, 'expired', w.reason);
    return w;
  }
  // Re-check at approval time: the facility may have changed since the request.
  const fp = footprint(s, kind, w.target);
  const start = Math.max(w.startMin, now);
  const ev = evaluate(s, kind, fp, { start, end: w.endMin }, w.id);
  const denied = ev.verdict === 'deny';
  const outcome: WorkRow = denied
    ? (() => {
        const earliest = earliestSafe(s, kind, fp, { start, end: w.endMin }, ev, w.id);
        return {
          ...w,
          status: 'denied',
          verdict: 'deny',
          reason: `Re-checked at approval: ${ev.reason}`,
          earliestSafe: earliest.text,
          earliestSafeMin: earliest.min,
          blockers: ev.blockers.map((b) => b.ref),
        };
      })()
    : {
        ...w,
        status: start <= now ? 'active' : 'granted',
        startMin: start,
        approvedBy: a.name,
        reason: `${ev.reason.replace(' Needs shift lead approval.', '')} Approved by ${a.name}.`,
        racks: ev.drops.length ? ev.drops.map((d) => d.rack) : fp.racks,
      };
  s.putWork(outcome);
  if (!denied) {
    insertClaims(s, outcome, fp);
    if (outcome.status === 'active') activate(s, outcome);
  }
  decide(s, {
    ...who(a),
    type: denied ? 'lease_denied' : 'lease_granted',
    subject: outcome.target,
    title: `${CATALOG[kind].title} on ${outcome.targetLabel} ${denied ? 'denied at approval' : `approved by ${a.name}`}`,
    verdict: denied ? 'deny' : 'allow',
    reason: `${outcome.reason}${denied && outcome.earliestSafe ? ` Earliest safe time: ${outcome.earliestSafe}.` : ''}`,
    ...focusFor(fp),
    work: outcome.id,
    data: {
      ...leaseData(outcome),
      verdict: outcome.verdict,
      status: outcome.status,
      approved_by: outcome.approvedBy,
      earliest_safe: outcome.earliestSafe,
      blockers: denied ? ev.blockers.map((b) => ({ ref: b.ref, text: b.text, end: b.end })) : [],
    },
  });
  audit(s, a, 'approve', `#${id}`, outcome.status, outcome.reason);
  return outcome;
}

export function rejectWork(s: Store, identity: string, id: bigint, note: string): void {
  const a = requireActor(s, identity);
  requireRole(a, 'approve');
  const w = s.work(id);
  if (!w || w.status !== 'needs_approval') throw new RequestError(`#${id} is not waiting for approval.`);
  w.status = 'rejected';
  const n = cleanText(note);
  w.reason = `${w.reason} Rejected by ${a.name}${n ? `: ${n}` : ''}.`;
  s.putWork(w);
  decide(s, {
    ...who(a),
    type: 'lease_denied',
    subject: w.target,
    title: `${describeWork(w)} rejected`,
    verdict: 'deny',
    reason: w.reason,
    focusKind: 'overview',
    work: w.id,
    data: { ...leaseData(w), verdict: 'rejected', status: w.status, rejected_by: a.name, earliest_safe: '', blockers: [] },
  });
  audit(s, a, 'reject', `#${id}`, 'rejected', n);
}

/** Release a lease early. The requester, a shift lead, or the fixer for a protection
 *  lock whose job has finished (DESIGN.md §8.2: stale protection). */
export function releaseWork(s: Store, identity: string, id: bigint, note = ''): void {
  const a = requireActor(s, identity);
  const w = s.work(id);
  if (!w) throw new RequestError(`No work #${id}.`);
  const mine = w.actorIdentity === a.identity;
  const lead = CAN_DO.approve.includes(a.role as Role);
  const stale = a.role === 'remediation_agent' && w.kind === 'protection' && s.job(w.job)?.status === 'finished';
  if (!mine && !lead && !stale) {
    throw new RequestError(
      w.kind === 'protection'
        ? `Only ${w.actor} or a shift lead can release #${id} while ${w.job} has not finished.`
        : `Only ${w.actor} or a shift lead can release #${id}.`,
    );
  }
  let ended: 'done' | 'cancelled';
  if (w.status === 'active') ended = 'done';
  else if (w.status === 'granted' || w.status === 'needs_approval') ended = 'cancelled';
  else throw new RequestError(`#${id} is ${w.status}; nothing to release.`);
  finish(s, w, ended, ended === 'done' ? s.now() : undefined);
  const n = cleanText(note);
  const why = w.kind === 'protection' ? `${w.job}'s racks are open for maintenance again.` : `Its claims are released.`;
  decide(s, {
    ...who(a),
    type: 'lease_released',
    subject: w.kind === 'protection' ? w.job : w.target,
    title: `${describeWork(w)} ${ended === 'done' ? 'finished' : 'cancelled'}${stale ? ' (stale lock)' : ''}`,
    verdict: 'info',
    reason: `${why}${n ? ` ${n}` : ''}`,
    focusKind: 'overview',
    work: w.id,
    data: { ...leaseData(w), ended, released_by: a.name, note: n },
  });
  audit(s, a, 'release', `#${id}`, ended, n);
}

/** Move simulated time forward; leases start and end on the way (they auto-expire). */
export function advanceClock(s: Store, identity: string, minutes: number): void {
  const a = requireActor(s, identity);
  requireRole(a, 'clock');
  if (minutes <= 0) throw new RequestError('minutes must be positive.');
  advanceTo(s, s.now() + minutes);
  audit(s, a, 'advance_clock', String(minutes), 'ok', clock(s.now()));
}

/** Moves simulated time forward to `now` (never back): leases whose window starts begin, and
 *  leases whose window ends finish. Used by advance_clock and the scenario runner. */
export function advanceTo(s: Store, now: number): void {
  if (now <= s.now()) return;
  s.setNow(now);
  for (const w of s.workByStatus('active')) {
    if (w.endMin > now) continue;
    finish(s, w, 'done');
    decide(s, {
      ...SQUAWK,
      type: 'lease_expired',
      subject: w.kind === 'protection' ? w.job : w.target,
      title: w.kind === 'protection' ? `Protection for ${w.job} ended` : `${describeWork(w)} finished`,
      verdict: 'info',
      reason: w.kind === 'protection' ? `Its ${plural(w.racks.length, 'rack')} are open for maintenance again.` : 'Window ended; its claims are released.',
      focusKind: 'overview',
      work: w.id,
      data: leaseData(w),
    });
  }
  for (const w of s.workByStatus('granted')) {
    if (w.startMin > now) continue;
    if (w.endMin <= now) {
      finish(s, w, 'done');
      continue;
    }
    activate(s, w);
    decide(s, {
      ...SQUAWK,
      type: 'lease_started',
      subject: w.target,
      title: `${describeWork(w)} started`,
      verdict: 'info',
      reason: `Runs until ${clock(w.endMin)}.`,
      focusKind: w.targetKind === 'part' || w.targetKind === 'node' || w.targetKind === 'rack' ? w.targetKind : 'racks',
      focusIds: w.targetKind === 'part' || w.targetKind === 'node' || w.targetKind === 'rack' ? [w.target] : w.racks,
      work: w.id,
      data: leaseData(w),
    });
  }
  for (const w of s.workByStatus('needs_approval')) {
    if (w.endMin > now) continue;
    w.status = 'expired';
    s.putWork(w);
  }
}

// ---------------------------------------------------------------- facility events

export function setPartState(s: Store, identity: string, partId: string, state: string): void {
  const a = requireActor(s, identity);
  requireRole(a, 'set_state');
  const part = s.part(partId);
  if (!part) throw new RequestError(`Unknown part "${partId}".`);
  if (!(HEALTH as readonly string[]).includes(state)) throw new RequestError(`state must be one of ${HEALTH.join(', ')}.`);
  if (part.state === state) return;
  s.putPart({ ...part, state });
  const below = s.downstreamRacks(partId);
  recomputeRacks(s, below);

  const yellow = below.filter((r) => s.margin(r)?.level === 'yellow');
  const red = below.filter((r) => s.margin(r)?.level === 'red');
  const single = new Set<string>();
  for (const r of yellow) for (const p of s.margin(r)!.unprotected) if (s.part(p)?.type === 'cdu' || s.part(p)?.type === 'pdu') single.add(p);
  const P = label(partId);
  let reason: string;
  if (state === 'ok') {
    reason = `${P} is back. ${plural(below.filter((r) => s.margin(r)?.level === 'green').length, 'rack')} below it have full backup.`;
  } else if (yellow.length || red.length) {
    const sys = part.type === 'cdu' || part.type === 'chiller' ? 'cooling' : 'power';
    const only = single.size ? ` ${formatList([...single])} ${single.size === 1 ? 'is their only working' : 'are their only working'} ${sys} feed.` : '';
    reason = `${plural(yellow.length, 'rack')} ${yellow.length === 1 ? 'is' : 'are'} now one failure from an outage${red.length ? `; ${plural(red.length, 'rack')} have no working feed` : ''}.${only}`;
  } else {
    reason = `Every rack below ${P} keeps full backup.`;
  }
  decide(s, {
    ...who(a),
    type: 'state_change',
    subject: partId,
    title: `${P} ${state === 'ok' ? 'repaired' : state}`,
    verdict: state === 'ok' ? 'info' : yellow.length || red.length ? 'warn' : 'info',
    reason,
    focusKind: 'part',
    focusIds: [partId],
    data: { kind: 'part', part_type: part.type, state, previous: part.state, yellow: yellow.length, red: red.length, note: '' },
  });
  audit(s, a, 'set_part_state', partId, state, reason);
}

export interface FeedText {
  title?: string;
  reason?: string;
  verdict?: string;
}

export function reportNodeFailure(s: Store, identity: string, nodeId: string, text: FeedText = {}): void {
  const a = requireActor(s, identity);
  requireRole(a, 'report_failure');
  const node = s.node(nodeId);
  if (!node) throw new RequestError(`Unknown node "${nodeId}".`);
  s.putNode({ ...node, state: 'failed' });
  s.insertFailure({ node: nodeId, atMin: s.now() });
  const job = node.ownerKind === 'job' ? s.job(node.ownerId) : undefined;
  let title = `${nodeId} failed`;
  let reason = node.ownerKind === 'free' ? `${nodeId} was a free spare; no job is affected.` : `${nodeId} belongs to ${node.ownerId}.`;
  let stopped = false;
  if (job && job.status === 'running') {
    s.putJob({ ...job, status: 'stopped', crashes: job.crashes + 1 });
    stopped = true;
    title = `${nodeId} failed, ${job.id} stopped`;
    reason = `One node down stops all ${fmtInt(job.nodes)} nodes of a synchronous training job.`;
  }
  decide(s, {
    ...who(a),
    type: 'state_change',
    subject: nodeId,
    title: text.title ?? title,
    verdict: text.verdict ?? 'failure',
    reason: text.reason ?? reason,
    focusKind: 'node',
    focusIds: [nodeId],
    data: {
      kind: 'node',
      state: 'failed',
      previous: node.state,
      owner_kind: node.ownerKind,
      owner_id: node.ownerId,
      job_status: stopped ? 'stopped' : '',
      note: '',
    },
  });
  audit(s, a, 'report_node_failure', nodeId, 'failed', reason);
}

export function setNodeState(s: Store, identity: string, nodeId: string, state: string): void {
  const a = requireActor(s, identity);
  requireRole(a, 'set_state');
  const node = s.node(nodeId);
  if (!node) throw new RequestError(`Unknown node "${nodeId}".`);
  if (!(HEALTH as readonly string[]).includes(state)) throw new RequestError(`state must be one of ${HEALTH.join(', ')}.`);
  s.putNode({ ...node, state });
  decide(s, {
    ...who(a),
    type: 'state_change',
    subject: nodeId,
    title: `${nodeId} ${state === 'ok' ? 'back in service' : state}`,
    verdict: state === 'failed' ? 'failure' : 'info',
    reason: `Marked ${state} by ${a.name}.`,
    focusKind: 'node',
    focusIds: [nodeId],
    data: { kind: 'node', state, previous: node.state, owner_kind: node.ownerKind, owner_id: node.ownerId, job_status: '', note: '' },
  });
  audit(s, a, 'set_node_state', nodeId, state, '');
}

// ---------------------------------------------------------------- diagnosis and restart (DESIGN.md §5, §6)

export function diagnoseFailure(s: Store, identity: string, nodes: string[]): bigint {
  const a = requireActor(s, identity);
  requireRole(a, 'diagnose');
  if (nodes.length === 0) throw new RequestError('Name at least one failed node.');
  for (const n of nodes) if (!s.node(n)) throw new RequestError(`Unknown node "${n}".`);
  const d = diagnose(s, nodes, s.now(), s.settings().failureWindowMin);
  const row = s.insertDiagnosis({ atMin: s.now(), nodes, ...d });
  decide(s, {
    ...SQUAWK,
    type: 'diagnosis',
    subject: nodes[0],
    title: `Diagnosis: ${d.classification === 'shared_cause' ? `shared cause ${label(d.cause)}` : 'isolated'}`,
    verdict: d.classification,
    reason: `${d.reason} Send a ${d.send}.`,
    focusKind: d.cause ? 'part' : 'node',
    focusIds: [d.cause || nodes[0]],
    data: { diagnosis: String(row.id), nodes, classification: d.classification, cause: d.cause, at_risk: d.atRisk.length, send: d.send, by: a.name },
  });
  audit(s, a, 'diagnose_failure', nodes.join(','), d.classification, d.reason);
  return row.id;
}

export interface PlacementArgs {
  job: string;
  needed: number; // 0 = one per excluded node
  durationMin: number; // 0 = 72 h
  exclude: string[];
  diagnosisId: bigint; // 0n = none; otherwise its failed + at-risk nodes are excluded too
}

export function requestPlacement(s: Store, identity: string, args: PlacementArgs): bigint {
  const a = requireActor(s, identity);
  requireRole(a, 'placement');
  if (!s.job(args.job)) throw new RequestError(`Unknown job "${args.job}".`);
  const exclude = new Set(args.exclude);
  if (args.diagnosisId !== 0n) {
    const d = s.diagnosis(args.diagnosisId);
    if (!d) throw new RequestError(`No diagnosis #${args.diagnosisId}.`);
    for (const n of [...d.nodes, ...d.atRisk]) exclude.add(n);
  }
  const needed = args.needed > 0 ? args.needed : exclude.size;
  if (needed <= 0) throw new RequestError('needed must be positive (or pass nodes to replace).');
  const durationMin = args.durationMin > 0 ? args.durationMin : DEFAULT_PROTECTION_MIN;
  const p = safePlacement(s, args.job, needed, durationMin, [...exclude], s.now());
  const reasons = Object.keys(p.excluded);
  const row = s.insertPlacement({
    atMin: s.now(),
    job: args.job,
    needed,
    durationMin,
    exclude: [...exclude],
    nodes: p.nodes,
    excludedReasons: reasons,
    excludedCounts: reasons.map((r) => p.excluded[r as keyof typeof p.excluded]),
    shortfall: p.shortfall,
    reason: p.reason,
    used: false,
  });
  decide(s, {
    ...SQUAWK,
    type: 'placement',
    subject: args.job,
    title: p.shortfall ? `Safe placement: shortfall of ${p.shortfall}` : `Safe placement: ${p.nodes.length} nodes`,
    verdict: 'placement',
    reason: p.reason,
    focusKind: 'racks',
    focusIds: [...new Set(p.nodes.map((n) => s.node(n)!.rack))],
    data: { placement: String(row.id), job: args.job, nodes: p.nodes.length, needed, shortfall: p.shortfall, by: a.name },
  });
  audit(s, a, 'safe_placement', args.job, p.shortfall ? 'shortfall' : 'ok', p.reason);
  return row.id;
}

export function restartJob(s: Store, identity: string, jobId: string, placementId: bigint): void {
  const a = requireActor(s, identity);
  requireRole(a, 'restart');
  const job = s.job(jobId);
  if (!job) throw new RequestError(`Unknown job "${jobId}".`);
  const p = s.placement(placementId);
  if (!p || p.job !== jobId) throw new RequestError(`Placement #${placementId} is not for ${jobId}.`);
  if (p.used) throw new RequestError(`Placement #${placementId} was already used.`);
  if (p.shortfall) throw new RequestError(`Placement #${placementId} has a shortfall of ${p.shortfall}; it can't restart the job.`);
  for (const n of p.nodes) {
    const node = s.node(n);
    if (!node || node.ownerKind !== 'free' || node.state !== 'ok' || node.heldBy !== 0n) {
      throw new RequestError(`${n} is no longer a safe spare. Run safe_placement again.`);
    }
  }
  let left = 0;
  for (const n of p.exclude) {
    const node = s.node(n);
    if (node && node.ownerKind === 'job' && node.ownerId === jobId) {
      s.putNode({ ...node, ownerKind: 'free', ownerId: '' });
      left++;
    }
  }
  for (const n of p.nodes) s.putNode({ ...s.node(n)!, ownerKind: 'job', ownerId: jobId });
  const total = s.nodesOwnedBy(jobId).length;
  s.putJob({ ...job, status: 'running', restarts: job.restarts + 1, nodes: total });
  s.putPlacement({ ...p, used: true });
  decide(s, {
    ...who(a),
    type: 'job_status',
    subject: jobId,
    title: `Restarted ${jobId} on ${p.nodes.length} new nodes`,
    verdict: 'info',
    reason: `Left ${plural(left, 'failed or at-risk node')}; ${jobId} runs on ${fmtInt(total)} nodes again.`,
    focusKind: 'racks',
    focusIds: [...new Set(p.nodes.map((n) => s.node(n)!.rack))],
    data: { status: 'running', previous: job.status, nodes: total, placement: String(placementId) },
  });
  audit(s, a, 'restart_job', jobId, 'ok', `placement #${placementId}`);
}

/** The scheduler says the job is done: its nodes go back to the pool. Any protection lease it
 *  held stays until it ends or someone releases it (the fixer cleans up a stale one, DESIGN.md §8.2). */
export function finishJob(s: Store, identity: string, jobId: string): void {
  const a = requireActor(s, identity);
  requireRole(a, 'finish');
  const job = s.job(jobId);
  if (!job) throw new RequestError(`Unknown job "${jobId}".`);
  if (job.status === 'finished') throw new RequestError(`${jobId} has already finished.`);
  const held = s.nodesOwnedBy(jobId);
  for (const n of held) s.putNode({ ...n, ownerKind: 'free', ownerId: '' });
  s.putJob({ ...job, status: 'finished', nodes: 0 });
  const locks = s.workByStatus('active').filter((w) => w.kind === 'protection' && w.job === jobId);
  const lock = locks.sort((x, y) => y.endMin - x.endMin)[0];
  const reason = `${jobId} finished; its ${plural(held.length, 'node')} are free spares again.${
    lock ? ` Protection #${lock.id} still locks ${plural(lock.racks.length, 'rack')} until ${clock(lock.endMin)}.` : ''
  }`;
  decide(s, {
    ...who(a),
    type: 'job_status',
    subject: jobId,
    title: `${jobId} finished`,
    verdict: 'info',
    reason,
    focusKind: 'overview',
    data: { status: 'finished', previous: job.status, nodes_released: held.length, protection: lock ? String(lock.id) : '' },
  });
  audit(s, a, 'finish_job', jobId, 'finished', reason);
}

/** What a scheduler does without Squawk: swap the failed node for the nearest free
 *  node (same leaf if possible) and restart, with no diagnosis and no safety check. The
 *  naive half of the demo; real agents should use diagnose_failure + safe_placement. */
export function naiveRestart(
  s: Store,
  identity: string,
  jobId: string,
  failedNode: string,
  text: FeedText & { focusIds?: string[] } = {},
): string {
  const a = requireActor(s, identity);
  requireRole(a, 'restart');
  const job = s.job(jobId);
  if (!job) throw new RequestError(`Unknown job "${jobId}".`);
  const failed = s.node(failedNode);
  if (!failed) throw new RequestError(`Unknown node "${failedNode}".`);
  const leaf = s.rack(failed.rack)!.network[0];
  const free = s
    .freeNodes()
    .filter((n) => n.state === 'ok' && n.heldBy === 0n)
    .sort((x, y) => x.ord - y.ord);
  const pick = free.find((n) => s.rack(n.rack)!.network[0] === leaf) ?? free[0];
  if (!pick) throw new RequestError('No free node to swap in.');
  if (failed.ownerKind === 'job' && failed.ownerId === jobId) s.putNode({ ...failed, ownerKind: 'free', ownerId: '' });
  s.putNode({ ...pick, ownerKind: 'job', ownerId: jobId });
  const total = s.nodesOwnedBy(jobId).length;
  s.putJob({ ...job, status: 'running', restarts: job.restarts + 1, nodes: total });
  decide(s, {
    ...who(a),
    type: 'job_status',
    subject: jobId,
    title: text.title ?? `Swapped ${failedNode} for ${pick.id}, restarted`,
    verdict: text.verdict ?? 'info',
    reason: text.reason ?? 'Nearest free node. Cause not checked.',
    focusKind: text.focusIds ? 'racks' : 'node',
    focusIds: text.focusIds ?? [pick.id],
    data: { status: 'running', previous: job.status, nodes: total, swapped: failedNode, picked: pick.id },
  });
  audit(s, a, 'naive_restart', jobId, 'ok', `${failedNode} -> ${pick.id}`);
  return pick.id;
}

/** Protection lease (DESIGN.md §6.3): locks the job's racks for the run. */
export function requestProtection(s: Store, identity: string, jobId: string, durationMin: number, ticket: string): WorkRow {
  const a = requireActor(s, identity);
  requireRole(a, 'protect');
  if (!s.job(jobId)) throw new RequestError(`Unknown job "${jobId}".`);
  const fp = protectionFootprint(s, jobId);
  const now = s.now();
  const end = now + (durationMin > 0 ? durationMin : DEFAULT_PROTECTION_MIN);

  // Work booked earlier keeps its lease; we say which leases overlap the job's racks.
  const overlapping = new Map<bigint, WorkRow>();
  for (const c of fp.claims) {
    for (const h of s.claimsOn(c.resource)) {
      if (h.startMin < end && now < h.endMin && !compatible(c.mode, h.mode)) {
        const w = s.work(h.work);
        if (w && w.kind !== 'protection') overlapping.set(w.id, w);
      }
    }
  }
  const yellow = fp.racks.filter((r) => (s.margin(r)?.margin ?? 1) < 1);
  const notes: string[] = [];
  if (overlapping.size) notes.push(`Already booked and kept: ${[...overlapping.values()].slice(0, 2).map(describeWork).join('; ')}${overlapping.size > 2 ? ` and ${overlapping.size - 2} more` : ''}.`);
  if (yellow.length) notes.push(`${plural(yellow.length, 'rack')} ${yellow.length === 1 ? 'is' : 'are'} already one failure from an outage.`);
  const reason = `Protects ${plural(fp.racks.length, 'rack')} of ${jobId} until ${clock(end)} (${duration(end - now)}). Maintenance that would remove their backup, or hands-on work in them, is refused; online updates still run.${notes.length ? ` ${notes.join(' ')}` : ''}`;

  const w = s.insertWork({
    ticket: cleanText(ticket, 80),
    kind: 'protection',
    category: 'protection',
    scope: 'job_racks',
    mode: 'shared',
    targetKind: 'job',
    target: jobId,
    targetLabel: jobId,
    actor: a.name,
    actorRole: a.role,
    actorIdentity: a.identity,
    requestedAt: now,
    startMin: now,
    endMin: end,
    status: 'granted',
    verdict: 'allow',
    reason,
    earliestSafe: '',
    earliestSafeMin: -1,
    blockers: [],
    racks: fp.racks,
    job: jobId,
    offlineParts: [],
    offlineNodes: [],
    nodeCount: 0,
    approvedBy: '',
    routine: false,
    note: '',
    bookedBy: '',
  });
  insertClaims(s, w, fp);
  activate(s, w);
  decide(s, {
    ...who(a),
    type: 'lease_granted',
    subject: jobId,
    title: `Protection lease for ${jobId} granted`,
    verdict: 'allow',
    reason,
    focusKind: 'overview',
    work: w.id,
    data: { ...leaseData(w), verdict: 'allow', status: w.status },
  });
  audit(s, a, 'request_protection', jobId, 'allow', reason);
  return w;
}

// ---------------------------------------------------------------- agent events (DESIGN.md §4.3, §8.2)

const asText = (v: unknown, max = 80): string => (typeof v === 'string' ? cleanText(v, max) : '');

/** An agent writes its own row to the decision feed: its plan, a step, a dispatch, a hand-off.
 *  The row is attributed to the caller's identity and audited like everything else; `data` is
 *  untrusted JSON kept as data. The title and verdict are derived here so the view stays dumb. */
export function recordEvent(s: Store, identity: string, type: string, subject: string, reason: string, data: string): void {
  const a = requireActor(s, identity);
  requireRole(a, 'record');
  if (!(AGENT_EVENT_TYPES as readonly string[]).includes(type)) {
    throw new RequestError(`Unknown event type "${type}". Use one of: ${AGENT_EVENT_TYPES.join(', ')}.`);
  }
  const t = type as AgentEventType;
  if (data.length > 4000) throw new RequestError('data must be at most 4,000 characters of JSON.');
  let d: Record<string, unknown>;
  try {
    const parsed: unknown = data.trim() ? JSON.parse(data) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    d = parsed as Record<string, unknown>;
  } catch {
    throw new RequestError('data must be a JSON object.');
  }
  const subj = cleanText(subject, 80);
  const name = s.part(subj) ? label(subj) : subj || 'the hall';

  let title: string;
  let verdict: FeedVerdict;
  switch (t) {
    case 'agent_plan': {
      const steps = Array.isArray(d.steps) ? (d.steps as unknown[]).slice(0, 8).map((x) => asText((x as { tool?: unknown })?.tool, 40)).filter(Boolean) : [];
      title = steps.length ? `Plan for ${name}: ${steps.join(' → ')}` : `Plan for ${name}`;
      verdict = 'plan';
      break;
    }
    case 'agent_step':
      title = asText(reason, 100) || `Step on ${name}`;
      verdict = 'info';
      break;
    case 'agent': {
      const status = asText(d.status, 20);
      title =
        status === 'fixed'
          ? `Fixed ${name}`
          : status === 'handed_off'
            ? `Handed off ${name}`
            : status === 'failed_closed'
              ? `Stopped on ${name}: failed closed`
              : status === 'waiting'
                ? `Waiting on ${name}`
                : `Working on ${name}`;
      verdict = status === 'fixed' ? 'fixed' : status === 'handed_off' ? 'handoff' : status === 'failed_closed' ? 'warn' : 'info';
      break;
    }
    case 'tech_dispatched': {
      const trade = asText(d.trade, 40) || 'tech';
      title = `${trade[0].toUpperCase()}${trade.slice(1)} sent to ${name}`;
      verdict = 'info';
      break;
    }
    case 'notified':
      title = `Told ${asText(d.to, 40) || 'someone'} about ${name}`;
      verdict = 'info';
      break;
    case 'escalated':
      title = `Handed ${name} to ${asText(d.to, 40) || 'a person'}`;
      verdict = 'handoff';
      break;
  }

  // Focus: where the camera goes when the row is clicked.
  let focus: Pick<DecisionRow, 'focusKind' | 'focusIds'> = { focusKind: 'overview', focusIds: [] };
  const work = /^#?(\d+)$/.exec(subj);
  if (s.node(subj)) focus = { focusKind: 'node', focusIds: [subj] };
  else if (s.part(subj)) focus = { focusKind: 'part', focusIds: [subj] };
  else if (s.rack(subj)) focus = { focusKind: 'rack', focusIds: [subj] };
  else if (s.job(subj)) focus = { focusKind: 'racks', focusIds: [...new Set(s.nodesOwnedBy(subj).map((n) => n.rack))] };
  else if (work) {
    const w = s.work(BigInt(work[1]));
    if (w) focus = w.kind === 'protection' ? { focusKind: 'racks', focusIds: w.racks } : { focusKind: w.targetKind === 'part' || w.targetKind === 'node' || w.targetKind === 'rack' ? w.targetKind : 'racks', focusIds: w.targetKind === 'part' || w.targetKind === 'node' || w.targetKind === 'rack' ? [w.target] : w.racks };
  }

  decide(s, { ...who(a), type: t, subject: subj, title: cleanText(title, 120), verdict, reason: cleanText(reason, 300), ...focus, data: d });
  audit(s, a, `record:${t}`, subj, verdict, cleanText(reason, 300));
}
