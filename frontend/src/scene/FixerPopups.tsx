// Popups over the hall while the Nemotron fixer agent does a software fix: its plan, each step
// as it happens, and how it ended (fixed, handed off, stopped). Hardware repairs are the tech
// gull's (Tech.tsx); these are the fixes no one walks to. What's shown is the agent's own rows
// in the decision feed (fixes.ts), so the view still decides nothing.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Html } from '@react-three/drei';
import { useStore } from '../store';
import { label } from '../mock/site';
import type { FocusTarget, Site } from '../model/types';
import { HALL, RACK, rackBase, type PartBox, type Vec3 } from './layout';
import { softwareFixes, type Fix, type FixStatus } from './fixes';

/** A finished fix stays up this long, a fix that has gone quiet this long. */
const LINGER_MS = 7000;
const QUIET_MS = 90_000;

function anchor(site: Site, layout: Record<string, PartBox>, f: FocusTarget): Vec3 {
  const overRack = (id: string): Vec3 | null => {
    if (!site.racks[id]) return null;
    const [x, , z] = rackBase(site, id);
    return [x, RACK.h + 0.7, z];
  };
  switch (f.kind) {
    case 'node': {
      const n = site.nodes[f.id];
      return (n && overRack(n.rack)) ?? [HALL.cx, 3, HALL.cz];
    }
    case 'rack':
      return overRack(f.id) ?? [HALL.cx, 3, HALL.cz];
    case 'part': {
      const box = layout[f.id];
      if (!box) return [HALL.cx, 3, HALL.cz];
      return [box.pos[0], box.size[1] + 1.4, box.pos[2]];
    }
    case 'racks': {
      const ps = f.ids.map(overRack).filter((p): p is Vec3 => p !== null);
      if (!ps.length) return [HALL.cx, 3, HALL.cz];
      return [ps.reduce((a, p) => a + p[0], 0) / ps.length, RACK.h + 0.7, ps.reduce((a, p) => a + p[2], 0) / ps.length];
    }
    default:
      return [HALL.cx, 3, HALL.cz];
  }
}

const subjectName = (site: Site, s: string) => (site.parts[s] ? label(s) : s);

const FOOT: Record<FixStatus, { text: string; tone: string }> = {
  working: { text: 'Fixing', tone: 'azure' },
  fixed: { text: 'Fixed', tone: 'azure' },
  handoff: { text: 'Handed off', tone: 'gold' },
  stopped: { text: 'Stopped: failed closed', tone: 'gold' },
};

export function FixerPopups({ layout }: { layout: Record<string, PartBox> }) {
  const site = useStore((s) => s.site);
  const events = useStore((s) => s.events);

  // Live mode's first sync brings the whole feed: what the fixer did before the view opened is
  // history, not a popup (the connection sets feedStart in the same update).
  const feedStart = useStore((s) => s.feedStart);
  const fixes = useMemo(() => softwareFixes(events, feedStart), [events, feedStart]);

  // When each fix last changed, on the wall clock (the simulated clock jumps in steps).
  const changed = useRef(new Map<string, { last: number; at: number }>());
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const t = performance.now();
    const seen = new Map<string, { last: number; at: number }>();
    for (const f of fixes) {
      const was = changed.current.get(f.key);
      seen.set(f.key, was && was.last === f.last ? was : { last: f.last, at: t });
    }
    changed.current = seen;
    setNow(t);
  }, [fixes]);

  const shown = fixes.filter((f) => {
    const at = changed.current.get(f.key)?.at ?? now;
    return now - at < (f.status === 'working' ? QUIET_MS : LINGER_MS);
  });

  // Tick only while something is up, so finished popups go away on their own.
  const any = shown.length > 0;
  useEffect(() => {
    if (!any) return;
    const id = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(id);
  }, [any]);

  return (
    <>
      {shown.map((f) => (
        <FixPopup key={f.key} fix={f} name={subjectName(site, f.subject)} at={anchor(site, layout, f.focus)} />
      ))}
    </>
  );
}

function FixPopup({ fix, name, at }: { fix: Fix; name: string; at: Vec3 }) {
  const foot = FOOT[fix.status];
  const working = fix.status === 'working';
  return (
    <Html position={at} center zIndexRange={[2, 0]} pointerEvents="none">
      <div className={`fix-pop fix-pop-${fix.status}`}>
        <div className="fix-pop-head">
          <span className="fix-pop-agent">Nemotron fixer</span>
          <span className="fix-pop-subject">{name}</span>
        </div>
        {fix.model && <div className="fix-pop-model">{fix.model}</div>}
        <ol className="fix-pop-lines">
          {fix.lines.map((l, i) => (
            <li key={l.seq} className={working && i === fix.lines.length - 1 ? 'is-current' : undefined}>
              {l.text}
            </li>
          ))}
        </ol>
        <div className={`fix-pop-foot tone-${foot.tone}`}>
          {working ? <span className="fix-pop-spin" aria-hidden /> : <span className="mark" aria-hidden />}
          {foot.text}
        </div>
      </div>
    </Html>
  );
}
