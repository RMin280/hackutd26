// The safety interlock (DESIGN.md §4): is this work safe in this window?
//
//   1. Locks: does it claim something another live lease (or a running job) already
//      holds in an incompatible mode during the window?            -> deny
//   2. Backup: with every live lease that overlaps the window applied, does taking
//      its parts offline (or opening its hot aisle) make a rack red, or drop a
//      protected rack below full backup?                            -> deny
//      ... or leave a rack one failure from an outage?              -> warn (shift lead approves)
//   3. Otherwise                                                    -> allow
//
// Every verdict carries a one-line reason naming the deciding facts, and a deny
// carries the earliest safe time. Cost depends on the work's own footprint and the
// number of live leases, never on the size of the facility.

import { CATALOG, type WorkKind, type WorkSpec } from './catalog';
import { compatible, type Footprint } from './footprint';
import { computeMargin, type MarginCalc } from './margins';
import type { Store } from './store';
import { clock, fmtInt, formatList, joinAnd, label, plural } from './text';
import { LIVE_STATUSES, type Verdict, type WorkRow } from './types';

export interface Window {
  start: number;
  end: number;
}

export interface Conflict {
  work: WorkRow;
  resource: string;
}

export interface Hold {
  owner: string;
  nodes: string[];
}

export interface Drop {
  rack: string;
  before: MarginCalc;
  after: MarginCalc;
  red: boolean;
  yellow: boolean;
  protectedBy: WorkRow | null;
}

export interface Blocker {
  ref: string; // '#12' | 'cdu-3' | 'job-train-1'
  text: string; // "CDU-3 repair", "#12 ends", "job-train-1's protection ends"
  end: number | null; // null: no known end (a repair, a job to drain)
}

export interface Evaluation {
  verdict: Verdict;
  reason: string;
  conflicts: Conflict[];
  holds: Hold[];
  drops: Drop[];
  exposed: string[];
  blockers: Blocker[];
}

const overlaps = (a: Window, start: number, end: number) => start < a.end && a.start < end;

interface WindowCtx {
  offline: Map<string, WorkRow[]>; // part -> live work holding it offline in the window
  hits: Map<string, WorkRow[]>; // aisle -> live hot-aisle work in the window
  protection: Map<string, WorkRow>; // rack -> protection lease in the window
}

function windowCtx(s: Store, w: Window, selfId: bigint): WindowCtx {
  const ctx: WindowCtx = { offline: new Map(), hits: new Map(), protection: new Map() };
  const push = <K>(m: Map<K, WorkRow[]>, k: K, v: WorkRow) => {
    const xs = m.get(k);
    if (xs) xs.push(v);
    else m.set(k, [v]);
  };
  for (const status of LIVE_STATUSES) {
    for (const lw of s.workByStatus(status)) {
      if (lw.id === selfId || !overlaps(w, lw.startMin, lw.endMin)) continue;
      for (const p of lw.offlineParts) push(ctx.offline, p, lw);
      if (lw.kind === 'hot_aisle_work') push(ctx.hits, lw.target, lw);
      if (lw.kind === 'protection') {
        for (const r of lw.racks) {
          const cur = ctx.protection.get(r);
          if (!cur || lw.endMin > cur.endMin) ctx.protection.set(r, lw);
        }
      }
    }
  }
  return ctx;
}

export function describeWork(w: WorkRow): string {
  if (w.kind === 'protection') return `protection #${w.id} for ${w.job}`;
  const title = w.kind in CATALOG ? CATALOG[w.kind as WorkKind].title.toLowerCase() : w.kind;
  return `${title} #${w.id} on ${w.targetLabel} (${w.actor})`;
}

export function actionPhrase(spec: WorkSpec, fp: Footprint): string {
  const many = fp.nodes.length === 1 ? fp.nodes[0] : `${plural(fp.nodes.length, 'node')} in ${fp.targetLabel}`;
  switch (spec.kind) {
    case 'facility_work':
    case 'switch_firmware':
    case 'node_repair':
      return `Taking ${fp.targetLabel} offline`;
    case 'hot_aisle_work':
      return `Opening ${label(fp.target)}`;
    case 'rack_work':
      return `Powering down ${fp.target}`;
    case 'sw_online':
      return `Updating ${many}`;
    case 'sw_exclusive':
      return `Draining ${many}`;
  }
}

export function evaluate(s: Store, kind: WorkKind, fp: Footprint, w: Window, selfId = 0n): Evaluation {
  const spec = CATALOG[kind];

  // 1. Lock conflicts with live leases in the window.
  const conflictByWork = new Map<bigint, Conflict>();
  for (const c of fp.claims) {
    for (const h of s.claimsOn(c.resource)) {
      if (h.work === selfId || conflictByWork.has(h.work)) continue;
      if (!overlaps(w, h.startMin, h.endMin) || compatible(c.mode, h.mode)) continue;
      const work = s.work(h.work);
      if (work) conflictByWork.set(h.work, { work, resource: c.resource });
    }
  }
  const conflicts = [...conflictByWork.values()].sort((a, b) => (a.work.id < b.work.id ? -1 : 1));

  // Running jobs and tenants hold their nodes; drain-required work can't share them.
  const holdsBy = new Map<string, string[]>();
  if (!fp.withJobs) {
    for (const id of fp.nodes) {
      const n = s.node(id);
      if (!n || n.state === 'failed' || n.ownerKind === 'free') continue;
      if (n.ownerKind === 'job' && s.job(n.ownerId)?.status !== 'running') continue;
      const xs = holdsBy.get(n.ownerId);
      if (xs) xs.push(id);
      else holdsBy.set(n.ownerId, [id]);
    }
  }
  const holds: Hold[] = [...holdsBy].map(([owner, nodes]) => ({ owner, nodes }));

  // 2. Backup: only racks below the parts it takes offline, or in the aisle it opens.
  const ctx = windowCtx(s, w, selfId);
  const affected = fp.offlineParts.length || fp.coolingHitAisle ? fp.racks : [];
  const drops: Drop[] = [];
  for (const id of affected) {
    const rack = s.rack(id);
    if (!rack) continue;
    const workingBefore = (p: string) => s.part(p)?.state === 'ok' && !ctx.offline.has(p);
    const workingAfter = (p: string) => workingBefore(p) && !fp.offlineParts.includes(p);
    const hits = ctx.hits.get(rack.aisle)?.length ?? 0;
    const before = computeMargin(rack, workingBefore, hits);
    const after = computeMargin(rack, workingAfter, hits + (fp.coolingHitAisle === rack.aisle ? 1 : 0));
    const dP = after.power < before.power;
    const dC = after.cooling < before.cooling;
    if (!dP && !dC) continue;
    const prot = ctx.protection.get(id) ?? null;
    drops.push({
      rack: id,
      before,
      after,
      red: (dP && after.power < 0) || (dC && after.cooling < 0),
      yellow: (dP && after.power === 0) || (dC && after.cooling === 0),
      protectedBy: prot && ((dP && after.power < 1) || (dC && after.cooling < 1)) ? prot : null,
    });
  }

  // What already used up the backup of each red rack (for the reason and the earliest safe time).
  const blockers: Blocker[] = [];
  const consumed: string[] = [];
  const addBlocker = (b: Blocker) => {
    if (!blockers.some((x) => x.ref === b.ref)) blockers.push(b);
  };
  for (const c of conflicts) addBlocker({ ref: `#${c.work.id}`, text: `#${c.work.id} ends`, end: c.work.endMin });
  for (const h of holds) {
    addBlocker({
      ref: h.owner,
      text: `${h.owner} releases ${h.nodes.length === 1 ? h.nodes[0] : `its ${fmtInt(h.nodes.length)} nodes`}`,
      end: null,
    });
  }
  const reds = drops.filter((d) => d.red);
  for (const d of reds) {
    const rack = s.rack(d.rack)!;
    const dims: string[][][] = [];
    if (d.after.power < 0) dims.push(rack.powerFeeds);
    if (d.after.cooling < 0) dims.push(rack.coolingFeeds);
    for (const chains of dims) {
      for (const chain of chains) {
        for (const p of chain) {
          if (fp.offlineParts.includes(p)) continue;
          const st = s.part(p)?.state ?? 'ok';
          if (st !== 'ok') {
            consumed.push(`${label(p)} ${st}`);
            addBlocker({ ref: p, text: `${label(p)} repair`, end: null });
          }
          for (const lw of ctx.offline.get(p) ?? []) {
            consumed.push(`${label(p)} offline by #${lw.id} until ${clock(lw.endMin)}`);
            addBlocker({ ref: `#${lw.id}`, text: `#${lw.id} ends`, end: lw.endMin });
          }
        }
      }
    }
    if (d.after.cooling < 0) {
      for (const lw of ctx.hits.get(rack.aisle) ?? []) {
        consumed.push(`${label(lw.target)} open by #${lw.id} until ${clock(lw.endMin)}`);
        addBlocker({ ref: `#${lw.id}`, text: `#${lw.id} ends`, end: lw.endMin });
      }
    }
  }
  const protDrops = drops.filter((d) => d.protectedBy && !d.red);
  for (const d of protDrops) {
    const p = d.protectedBy!;
    addBlocker({ ref: `#${p.id}`, text: `${p.job}'s protection ends`, end: p.endMin });
  }
  const yellows = drops.filter((d) => d.yellow && !d.red && !d.protectedBy);
  const exposed = new Set<string>();
  for (const d of yellows) {
    for (const n of s.rack(d.rack)!.nodes) {
      const node = s.node(n);
      if (node && node.ownerKind !== 'free' && node.state !== 'failed') exposed.add(node.ownerId);
    }
  }

  // 3. Verdict and reason.
  const deny = conflicts.length > 0 || holds.length > 0 || reds.length > 0 || protDrops.length > 0;
  const verdict: Verdict = deny ? 'deny' : yellows.length ? 'warn' : 'allow';
  const act = actionPhrase(spec, fp);
  const parts: string[] = [];

  if (conflicts.length) {
    const c = conflicts[0];
    const more = conflicts.length > 1 ? ` (and ${plural(conflicts.length - 1, 'other lease')})` : '';
    if (c.work.kind === 'protection') {
      parts.push(
        `${fp.targetLabel} touches racks locked for ${c.work.job} until ${clock(c.work.endMin)} (protection #${c.work.id})${more}; hands-on work there has to wait.`,
      );
    } else {
      parts.push(`${fp.targetLabel} overlaps ${describeWork(c.work)} until ${clock(c.work.endMin)}${more}.`);
    }
  }
  if (holds.length) {
    const n = holds.reduce((a, h) => a + h.nodes.length, 0);
    const who = joinAnd(holds.map((h) => h.owner));
    const where = fp.targetKind === 'part' ? `below ${fp.targetLabel}` : fp.targetKind === 'node' ? '' : `in ${fp.targetLabel}`;
    const subject = n === 1 && fp.targetKind === 'node' ? fp.target : `${plural(n, 'node')}${where ? ` ${where}` : ''}`;
    parts.push(`${subject} ${n === 1 ? 'runs' : 'run'} ${who}. ${spec.title} can't run alongside jobs: drain ${n === 1 ? 'it' : 'them'} first.`);
  }
  if (reds.length) {
    const what = uniqStr(consumed);
    const why = what.length ? ` (${joinAnd(what)})` : '';
    if (spec.kind === 'hot_aisle_work') {
      parts.push(`${act} takes the last cooling headroom of ${plural(reds.length, 'rack')}${why}; they would go red.`);
    } else {
      const sys = s.part(fp.target)?.type === 'cdu' || s.part(fp.target)?.type === 'chiller' ? 'cooling' : 'power';
      const aisleOpen = reds.some((d) => (ctx.hits.get(s.rack(d.rack)!.aisle)?.length ?? 0) > 0);
      const role = aisleOpen ? `the last ${sys} headroom` : `the only ${sys} feed`;
      parts.push(`${fp.targetLabel} is ${role} for ${plural(reds.length, 'rack')}${why}; taking it offline makes them red.`);
    }
  }
  if (protDrops.length) {
    const jobs = joinAnd(uniqStr(protDrops.map((d) => d.protectedBy!.job)));
    const until = Math.max(...protDrops.map((d) => d.protectedBy!.endMin));
    parts.push(
      reds.length
        ? `It would also drop ${plural(protDrops.length, 'rack')} protected for ${jobs} below full backup.`
        : `${act} drops ${plural(protDrops.length, 'rack')} protected for ${jobs} below full backup (protected until ${clock(until)}).`,
    );
  }
  if (!deny && yellows.length) {
    const ex = exposed.size ? ` (exposes ${formatList([...exposed])})` : '';
    parts.push(`${act} leaves ${plural(yellows.length, 'rack')} one failure from an outage${ex}. Needs shift lead approval.`);
  }
  if (!deny && !yellows.length) parts.push(allowReason(s, spec, fp));

  return { verdict, reason: parts.join(' '), conflicts, holds, drops, exposed: [...exposed], blockers };
}

function allowReason(s: Store, spec: WorkSpec, fp: Footprint): string {
  const n = fp.nodes.length;
  switch (spec.kind) {
    case 'facility_work':
    case 'switch_firmware':
      return n
        ? `${fp.targetLabel} can go offline: the ${plural(n, 'node')} below it run nothing and no other work claims them.`
        : `${fp.targetLabel} can go offline: no rack below it loses backup.`;
    case 'hot_aisle_work':
      return `${fp.targetLabel} can open: no rack in it loses backup.`;
    case 'node_repair': {
      const node = s.node(fp.target);
      const state = node && node.state !== 'ok' ? ` (${node.state})` : '';
      return `${fp.target}${state} runs nothing and no other work claims it, its rack or its aisle.`;
    }
    case 'rack_work':
      return `${fp.target} runs nothing and no other work claims it or its aisle.`;
    case 'sw_online':
      return `${plural(n, 'node')} update while jobs keep running; no other maintenance claims them.`;
    case 'sw_exclusive':
      return `${plural(n, 'node')} run nothing and no other maintenance claims them.`;
  }
}

const uniqStr = (xs: string[]) => [...new Set(xs)];

/** Earliest start at which the same work would no longer be denied. */
export function earliestSafe(
  s: Store,
  kind: WorkKind,
  fp: Footprint,
  w: Window,
  first: Evaluation,
  selfId = 0n,
): { text: string; min: number } {
  const dur = w.end - w.start;
  let ev = first;
  const tried = new Set<number>();
  let latest = w.start;
  for (let i = 0; i < 16; i++) {
    const unknown = uniqStr(ev.blockers.filter((b) => b.end === null).map((b) => b.text));
    const ends = ev.blockers.filter((b) => b.end !== null).map((b) => b.end!);
    for (const e of ends) latest = Math.max(latest, e);
    if (unknown.length) {
      const notBefore = latest > w.start ? `, and not before ${clock(latest)}` : '';
      return { text: `after ${joinAnd(unknown)}${notBefore}`, min: -1 };
    }
    const next = ends.filter((t) => t > w.start && !tried.has(t)).sort((a, b) => a - b)[0];
    if (next === undefined) break;
    tried.add(next);
    ev = evaluate(s, kind, fp, { start: next, end: next + dur }, selfId);
    if (ev.verdict !== 'deny') {
      return { text: `${clock(next)}${ev.verdict === 'warn' ? ' (with shift lead approval)' : ''}`, min: next };
    }
  }
  return latest > w.start ? { text: `after ${clock(latest)}`, min: -1 } : { text: '', min: -1 };
}
