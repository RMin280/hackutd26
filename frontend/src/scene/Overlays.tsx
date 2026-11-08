import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line, QuadraticBezierLine } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '../store';
import { C } from '../theme';
import { NODE, RACK, nodeCenter, posX, rackBase, rowZ, type PartBox, type Vec3 } from './layout';
import { SelectionEdges } from './Parts';
import { useProtectedRacks, useUnprotectedParts } from './hooks';
import { makeLockTexture } from './labels';

const noRaycast = () => null;

// ---------- protection leases: one frame per protected run of racks ----------

// The lock sits on the lid of the first rack in each protected run, nearly as wide as the rack.
const LOCK_SIZE = 0.52;

export function ProtectedZones() {
  const site = useStore((s) => s.site);
  const protectedRacks = useProtectedRacks();
  const lock = useMemo(makeLockTexture, []);
  useEffect(() => () => lock.dispose(), [lock]);

  const runs = useMemo(() => {
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
  }, [protectedRacks, site]);

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
            <Line points={pts} color={C.azure} lineWidth={2} transparent opacity={0.95} raycast={noRaycast} />
            <mesh position={[posX(from), y + 0.005, rowZ(row)]} rotation-x={-Math.PI / 2} renderOrder={3} raycast={noRaycast}>
              <planeGeometry args={[LOCK_SIZE, LOCK_SIZE]} />
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
  /** Status arcs fade out when the camera comes close; the lids already carry the message there. */
  fades?: boolean;
}

// Status arcs are gone within FADE_NEAR metres of the camera and fully back by FADE_FAR,
// so close-ups don't fill with dashes the size of a rack.
const FADE_NEAR = 9;
const FADE_FAR = 16;
const ARC_OPACITY = 0.9;

function ArcLine({ a }: { a: Arc }) {
  // drei's line object (a three-stdlib Line2); only its material opacity and visibility are touched
  const ref = useRef<any>(null);
  const dist = Math.hypot(a.to[0] - a.from[0], a.to[2] - a.from[2]);
  const mid: Vec3 = [(a.from[0] + a.to[0]) / 2, Math.max(a.from[1], a.to[1]) + 0.5 + dist * 0.16, (a.from[2] + a.to[2]) / 2];
  const probes = useMemo(() => [a.from, mid, a.to].map((p) => new THREE.Vector3(...p)), [a.from, a.to, mid[0], mid[1], mid[2]]);
  useFrame(({ camera }) => {
    const line = ref.current;
    if (!line || !a.fades) return;
    const d = Math.min(...probes.map((p) => camera.position.distanceTo(p)));
    const t = THREE.MathUtils.smoothstep(d, FADE_NEAR, FADE_FAR);
    line.material.opacity = ARC_OPACITY * t;
    line.visible = t > 0.01;
  });
  return (
    <QuadraticBezierLine
      ref={ref}
      start={a.from}
      end={a.to}
      mid={mid}
      color={a.color}
      lineWidth={a.width ?? 1.2}
      dashed={a.dashed}
      dashSize={0.25}
      gapSize={0.15}
      transparent
      opacity={ARC_OPACITY}
      raycast={noRaycast}
    />
  );
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
        out.push({ key: `u-${rid}-${p}`, from: partTop(layout, p), to: rackTop(rid), color: C.gold, dashed: true, fades: true });
      }
    }

    // 2. Diagnosis: the shared cause and the racks it cools or powers. Gold, like the degraded
    //    unit and the at-risk nodes: red stays reserved for what has actually failed.
    const cause = world.diagnosis?.cause;
    if (cause) {
      for (const rid of site.downstream[cause]) {
        if (site.parts[cause].type === 'cdu' && site.racks[rid].coolingFeeds[0][0] !== cause) continue;
        out.push({ key: `c-${rid}`, from: partTop(layout, cause), to: rackTop(rid), color: C.gold, width: 1.6, fades: true });
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
      {arcs.map((a) => (
        <ArcLine key={a.key} a={a} />
      ))}
    </group>
  );
}
