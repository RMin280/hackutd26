import { useEffect, useMemo } from 'react';
import { Line, QuadraticBezierLine } from '@react-three/drei';
import { useStore } from '../store';
import { C } from '../theme';
import { NODE, RACK, nodeCenter, posX, rackBase, rowZ, type PartBox, type Vec3 } from './layout';
import { SelectionEdges } from './Parts';
import { useUnprotectedParts } from './hooks';
import { makeLockTexture } from './labels';

const noRaycast = () => null;

// ---------- protection leases: one frame per protected run of racks ----------

export function ProtectedZones() {
  const site = useStore((s) => s.site);
  const leases = useStore((s) => s.world.leases);
  const now = useStore((s) => s.world.now);
  const lock = useMemo(makeLockTexture, []);
  useEffect(() => () => lock.dispose(), [lock]);

  const runs = useMemo(() => {
    const protectedRacks = new Set(
      leases.filter((l) => l.type === 'protection' && l.start <= now && now < l.end).flatMap((l) => l.racks ?? []),
    );
    const out: { row: number; from: number; to: number }[] = [];
    for (let row = 1; row <= 10; row++) {
      let start = 0;
      for (let pos = 1; pos <= 17; pos++) {
        const id = `rack-r${row}-${String(pos).padStart(2, '0')}`;
        const on = pos <= 16 && protectedRacks.has(id) && !!site.racks[id];
        if (on && !start) start = pos;
        if (!on && start) {
          out.push({ row, from: start, to: pos - 1 });
          start = 0;
        }
      }
    }
    return out;
  }, [leases, now, site]);

  if (!runs.length) return null;
  const y = RACK.h + 0.03;
  return (
    <group>
      {runs.map(({ row, from, to }) => {
        const x0 = posX(from) - RACK.w / 2 - 0.05;
        const x1 = posX(to) + RACK.w / 2 + 0.05;
        const z0 = rowZ(row) - RACK.d / 2 - 0.05;
        const z1 = rowZ(row) + RACK.d / 2 + 0.05;
        const pts: Vec3[] = [
          [x0, y, z0],
          [x1, y, z0],
          [x1, y, z1],
          [x0, y, z1],
          [x0, y, z0],
        ];
        return (
          <group key={`${row}-${from}`}>
            <Line points={pts} color={C.azure} lineWidth={1.5} transparent opacity={0.9} raycast={noRaycast} />
            <mesh position={[posX(from), y + 0.005, rowZ(row)]} rotation-x={-Math.PI / 2} renderOrder={3} raycast={noRaycast}>
              <planeGeometry args={[0.44, 0.44]} />
              <meshBasicMaterial map={lock} transparent depthWrite={false} toneMapped={false} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

// ---------- selection outline ----------

export function SelectionOutline() {
  const site = useStore((s) => s.site);
  const selection = useStore((s) => s.selection);
  if (!selection || selection.kind === 'part') return null;
  if (selection.kind === 'rack') {
    return (
      <group position={rackBase(site, selection.id)}>
        <SelectionEdges size={[RACK.w, RACK.h, RACK.d]} />
      </group>
    );
  }
  const [x, y, z] = nodeCenter(site, selection.id);
  return (
    <group>
      <group position={rackBase(site, site.nodes[selection.id].rack)}>
        <SelectionEdges size={[RACK.w, RACK.h, RACK.d]} />
      </group>
      <group position={[x, y - NODE.h / 2 - 0.02, z]}>
        <SelectionEdges size={[NODE.w + 0.02, NODE.h + 0.02, NODE.d + 0.04]} />
      </group>
    </group>
  );
}

// ---------- feed arcs ----------

interface Arc {
  key: string;
  from: Vec3;
  to: Vec3;
  color: string;
  dashed?: boolean;
  width?: number;
}

function partTop(layout: Record<string, PartBox>, id: string): Vec3 {
  const b = layout[id];
  return [b.pos[0], b.size[1] + 0.06, b.pos[2]];
}

export function FeedLines({ layout }: { layout: Record<string, PartBox> }) {
  const site = useStore((s) => s.site);
  const world = useStore((s) => s.world);
  const selection = useStore((s) => s.selection);
  const unprotected = useUnprotectedParts();

  const arcs = useMemo(() => {
    const out: Arc[] = [];
    const rackTop = (rid: string): Vec3 => {
      const [x, , z] = rackBase(site, rid);
      return [x, RACK.h + 0.08, z];
    };
    const colorFor = (p: string) =>
      world.partState[p] === 'failed' ? C.red : world.partState[p] !== 'ok' || unprotected.has(p) ? C.gold : C.azure;

    // 1. Racks on their last backup: show the one unit they now hang on.
    for (const rid of site.rackOrder) {
      const m = world.margins[rid];
      if (m.level === 'green') continue;
      for (const p of m.unprotected) {
        const t = site.parts[p].type;
        if (t !== 'cdu' && t !== 'pdu') continue;
        out.push({ key: `u-${rid}-${p}`, from: partTop(layout, p), to: rackTop(rid), color: C.gold, dashed: true });
      }
    }

    // 2. Diagnosis: the shared cause and the racks it cools or powers.
    const cause = world.diagnosis?.cause;
    if (cause) {
      for (const rid of site.downstream[cause]) {
        if (site.parts[cause].type === 'cdu' && site.racks[rid].coolingFeeds[0][0] !== cause) continue;
        out.push({ key: `c-${rid}`, from: partTop(layout, cause), to: rackTop(rid), color: C.red, width: 1.6 });
      }
    }

    // 3. Selection: a rack's feeds, or a part's racks.
    const selRack = selection?.kind === 'rack' ? selection.id : selection?.kind === 'node' ? site.nodes[selection.id].rack : null;
    if (selRack) {
      const r = site.racks[selRack];
      for (const chain of [...r.powerFeeds, ...r.coolingFeeds]) {
        out.push({ key: `s-${chain[0]}`, from: partTop(layout, chain[0]), to: rackTop(selRack), color: colorFor(chain[0]), width: 1.8 });
      }
      out.push({ key: `s-${r.network[0]}`, from: partTop(layout, r.network[0]), to: rackTop(selRack), color: C.ice, width: 1.4 });
    } else if (selection?.kind === 'part') {
      const down = site.downstream[selection.id];
      if (down.length <= 24) {
        for (const rid of down) {
          out.push({ key: `d-${rid}`, from: partTop(layout, selection.id), to: rackTop(rid), color: colorFor(selection.id), width: 1.4 });
        }
      }
    }
    return out;
  }, [site, world, selection, layout, unprotected]);

  return (
    <group>
      {arcs.map((a) => {
        const dist = Math.hypot(a.to[0] - a.from[0], a.to[2] - a.from[2]);
        const mid: Vec3 = [(a.from[0] + a.to[0]) / 2, Math.max(a.from[1], a.to[1]) + 0.5 + dist * 0.16, (a.from[2] + a.to[2]) / 2];
        return (
          <QuadraticBezierLine
            key={a.key}
            start={a.from}
            end={a.to}
            mid={mid}
            color={a.color}
            lineWidth={a.width ?? 1.2}
            dashed={a.dashed}
            dashSize={0.25}
            gapSize={0.15}
            transparent
            opacity={0.9}
            raycast={noRaycast}
          />
        );
      })}
    </group>
  );
}
