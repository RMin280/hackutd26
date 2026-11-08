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
  HEALTH,
  ROLES,
  RequestError,
  type ActorRow,
  type DecisionRow,
  type MarginRow,
  type PartType,
  type Role,
  type SiteData,
  type WorkRow,
} from './types';

export const DEFAULT_SETTINGS = { id: 0, openRegistration: true, failureWindowMin: 120 };
export const DEFAULT_PROTECTION_MIN = 72 * 60;
const BLAST_RADIUS = { actor: 'Blast Radius', actorKind: 'blast_radius', actorRole: 'system' };

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
  protect: 'request protection leases',
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

type Decision = Omit<DecisionRow, 'seq' | 'atMin' | 'focusIds' | 'focusParts' | 'work'> &
  Partial<Pick<DecisionRow, 'focusIds' | 'focusParts' | 'work'>>;

function decide(s: Store, d: Decision): void {
  s.insertDecision({ focusIds: [], focusParts: [], work: 0n, ...d, atMin: s.now() });
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
    ...BLAST_RADIUS,
    title: `Scale site: ${fmtInt(gpus)} GPUs`,
    verdict: 'info',
    reason: `${fmtInt(site.racks.length)} racks, ${fmtInt(site.nodes.length)} nodes, ${fmtInt(site.parts.length)} facility parts.`,
    focusKind: 'overview',
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
}

const VERDICT_WORD = { allow: 'allowed', warn: 'needs approval', deny: 'denied' } as const;

export function requestWork(s: Store, identity: string, args: WorkArgs): WorkRow {
  const a = requireActor(s, identity);
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
  });
  if (status === 'granted' || status === 'active') {
    insertClaims(s, w, fp);
    if (status === 'active') activate(s, w);
  }

  const when = start > now ? ` from ${clock(start)}` : '';
  const title = args.dryRun
    ? `Simulated: ${spec.title.toLowerCase()} on ${fp.targetLabel} would be ${VERDICT_WORD[verdict]}`
    : `${spec.title} on ${fp.targetLabel}${when} ${VERDICT_WORD[verdict]}`;
  decide(s, {
    ...who(a),
    title,
    verdict,
    reason: `${reason}${earliest.text ? ` Earliest safe time: ${earliest.text}.` : ''}`,
    ...focusFor(fp),
    work: w.id,
  });
  audit(s, a, args.dryRun ? `simulate:${kind}` : `request:${kind}`, fp.target, verdict, reason);
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
    title: `${CATALOG[kind].title} on ${outcome.targetLabel} ${denied ? 'denied at approval' : `approved by ${a.name}`}`,
    verdict: denied ? 'deny' : 'allow',
    reason: `${outcome.reason}${denied && outcome.earliestSafe ? ` Earliest safe time: ${outcome.earliestSafe}.` : ''}`,
    ...focusFor(fp),
    work: outcome.id,
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
    title: `${describeWork(w)} rejected`,
    verdict: 'deny',
    reason: w.reason,
    focusKind: 'overview',
    work: w.id,
  });
  audit(s, a, 'reject', `#${id}`, 'rejected', n);
}

export function releaseWork(s: Store, identity: string, id: bigint): void {
  const a = requireActor(s, identity);
  const w = s.work(id);
  if (!w) throw new RequestError(`No work #${id}.`);
  const mine = w.actorIdentity === a.identity;
  if (!mine && !CAN_DO.approve.includes(a.role as Role)) throw new RequestError(`Only ${w.actor} or a shift lead can release #${id}.`);
  let ended: 'done' | 'cancelled';
  if (w.status === 'active') ended = 'done';
  else if (w.status === 'granted' || w.status === 'needs_approval') ended = 'cancelled';
  else throw new RequestError(`#${id} is ${w.status}; nothing to release.`);
  finish(s, w, ended, ended === 'done' ? s.now() : undefined);
  decide(s, {
    ...who(a),
    title: `${describeWork(w)} ${ended === 'done' ? 'finished' : 'cancelled'}`,
    verdict: 'info',
    reason: w.kind === 'protection' ? `${w.job}'s racks are open for maintenance again.` : `Its claims are released.`,
    focusKind: 'overview',
    work: w.id,
  });
  audit(s, a, 'release', `#${id}`, ended, '');
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
      ...BLAST_RADIUS,
      title: w.kind === 'protection' ? `Protection for ${w.job} ended` : `${describeWork(w)} finished`,
      verdict: 'info',
      reason: w.kind === 'protection' ? `Its ${plural(w.racks.length, 'rack')} are open for maintenance again.` : 'Window ended; its claims are released.',
      focusKind: 'overview',
      work: w.id,
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
      ...BLAST_RADIUS,
      title: `${describeWork(w)} started`,
      verdict: 'info',
      reason: `Runs until ${clock(w.endMin)}.`,
      focusKind: w.targetKind === 'part' || w.targetKind === 'node' || w.targetKind === 'rack' ? w.targetKind : 'racks',
      focusIds: w.targetKind === 'part' || w.targetKind === 'node' || w.targetKind === 'rack' ? [w.target] : w.racks,
      work: w.id,
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
    title: `${P} ${state === 'ok' ? 'repaired' : state}`,
    verdict: state === 'ok' ? 'info' : yellow.length || red.length ? 'warn' : 'info',
    reason,
    focusKind: 'part',
    focusIds: [partId],
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
  if (job && job.status === 'running') {
    s.putJob({ ...job, status: 'stopped', crashes: job.crashes + 1 });
    title = `${nodeId} failed, ${job.id} stopped`;
    reason = `One node down stops all ${fmtInt(job.nodes)} nodes of a synchronous training job.`;
  }
  decide(s, {
    ...who(a),
    title: text.title ?? title,
    verdict: text.verdict ?? 'failure',
    reason: text.reason ?? reason,
    focusKind: 'node',
    focusIds: [nodeId],
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
    title: `${nodeId} ${state === 'ok' ? 'back in service' : state}`,
    verdict: state === 'failed' ? 'failure' : 'info',
    reason: `Marked ${state} by ${a.name}.`,
    focusKind: 'node',
    focusIds: [nodeId],
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
    ...BLAST_RADIUS,
    title: `Diagnosis: ${d.classification === 'shared_cause' ? `shared cause ${label(d.cause)}` : 'isolated'}`,
    verdict: d.classification,
    reason: `${d.reason} Send a ${d.send}.`,
    focusKind: d.cause ? 'part' : 'node',
    focusIds: [d.cause || nodes[0]],
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
    ...BLAST_RADIUS,
    title: p.shortfall ? `Safe placement: shortfall of ${p.shortfall}` : `Safe placement: ${p.nodes.length} nodes`,
    verdict: 'placement',
    reason: p.reason,
    focusKind: 'racks',
    focusIds: [...new Set(p.nodes.map((n) => s.node(n)!.rack))],
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
    title: `Restarted ${jobId} on ${p.nodes.length} new nodes`,
    verdict: 'info',
    reason: `Left ${plural(left, 'failed or at-risk node')}; ${jobId} runs on ${fmtInt(total)} nodes again.`,
    focusKind: 'racks',
    focusIds: [...new Set(p.nodes.map((n) => s.node(n)!.rack))],
  });
  audit(s, a, 'restart_job', jobId, 'ok', `placement #${placementId}`);
}

/** What a scheduler does without Blast Radius: swap the failed node for the nearest free
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
    title: text.title ?? `Swapped ${failedNode} for ${pick.id}, restarted`,
    verdict: text.verdict ?? 'info',
    reason: text.reason ?? 'Nearest free node. Cause not checked.',
    focusKind: text.focusIds ? 'racks' : 'node',
    focusIds: text.focusIds ?? [pick.id],
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
  });
  insertClaims(s, w, fp);
  activate(s, w);
  decide(s, { ...who(a), title: `Protection lease for ${jobId} granted`, verdict: 'allow', reason, focusKind: 'overview', work: w.id });
  audit(s, a, 'request_protection', jobId, 'allow', reason);
  return w;
}
