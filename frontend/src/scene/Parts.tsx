import { useMemo, useRef, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '../store';
import { C, STATE_COLOR } from '../theme';
import { label, partTypeName } from '../mock/site';
import { stateText } from '../ui/format';
import type { PartBox } from './layout';
import { useUnprotectedParts } from './hooks';

const GROUP_BODY = { power: C.power, cooling: C.cooling, network: C.network };
const noRaycast = () => null;

// Neighbouring units (CDU-3 next to CDU-4, PDU A next to PDU B) get tags at two heights so they don't overlap.
const tagStagger = (id: string) => (/[02468]$|-b$/.test(id) ? 0.55 : 0);

function PulseRing({ size, color }: { size: [number, number, number]; color: string }) {
  const ref = useRef<THREE.Mesh>(null!);
  useFrame(({ clock }) => {
    const t = (clock.elapsedTime * 0.8) % 1;
    const s = 1 + t * 0.7;
    ref.current.scale.set(s, s, 1);
    (ref.current.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - t);
  });
  const r = Math.max(size[0], size[2]) * 0.72;
  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} raycast={noRaycast}>
      <ringGeometry args={[r, r + 0.07, 48]} />
      <meshBasicMaterial color={color} transparent toneMapped={false} depthWrite={false} />
    </mesh>
  );
}

function PartMesh({ id, box }: { id: string; box: PartBox }) {
  const site = useStore((s) => s.site);
  const state = useStore((s) => s.world.partState[id]);
  const selected = useStore((s) => s.selection?.kind === 'part' && s.selection.id === id);
  const select = useStore((s) => s.select);
  const setHover = useStore((s) => s.setHover);
  const unprotected = useUnprotectedParts().has(id);
  const cause = useStore((s) => s.world.diagnosis?.cause === id);
  const canvas = useThree((s) => s.gl.domElement);
  const [hovered, setHovered] = useState(false);

  const type = site.parts[id].type;
  const [w, h, d] = box.size;
  const capColor = state !== 'ok' ? STATE_COLOR[state] : unprotected ? C.amber : C.partCap;
  // Callout tags only where they help: problems, the unit a rack now depends on, and the selection.
  const headUnit = type === 'cdu' || type === 'pdu';
  const showTag = selected || cause || state !== 'ok' || (unprotected && headUnit);
  const body = selected || hovered ? '#3a3e48' : GROUP_BODY[box.group];

  return (
    <group position={box.pos}>
      <mesh
        position={[0, h / 2, 0]}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          setHovered(true);
          canvas.style.cursor = 'pointer';
          setHover({
            label: label(id),
            sub: `${partTypeName(type)} · ${stateText(state)}${unprotected ? ' · only working feed' : ''}`,
            x: e.clientX,
            y: e.clientY,
          });
        }}
        onPointerOut={() => {
          setHovered(false);
          canvas.style.cursor = '';
          setHover(null);
        }}
        onClick={(e) => {
          if (e.delta > 4) return;
          e.stopPropagation();
          select({ kind: 'part', id });
        }}
      >
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={body} roughness={0.65} metalness={0.3} />
      </mesh>
      <mesh position={[0, h + 0.012, 0]} raycast={noRaycast}>
        <boxGeometry args={[w, 0.025, d]} />
        <meshBasicMaterial color={capColor} toneMapped={false} />
      </mesh>
      {(unprotected || state !== 'ok') && <PulseRing size={box.size} color={state === 'failed' ? C.red : C.amber} />}
      {selected && <SelectionEdges size={box.size} />}
      {showTag && (
        <Html position={[0, h + 0.5 + tagStagger(id), 0]} center zIndexRange={[1, 0]} pointerEvents="none">
          <div className="scene-tag">
            <span className={`dot tone-${state === 'ok' ? (unprotected ? 'amber' : 'blue') : state === 'degraded' ? 'amber' : 'red'}`} />
            {label(id)}
            {unprotected && state === 'ok' && <span className="scene-tag-sub">only working feed</span>}
            {state !== 'ok' && <span className="scene-tag-sub">{stateText(state)}</span>}
          </div>
        </Html>
      )}
    </group>
  );
}

export function SelectionEdges({ size, y0 = 0 }: { size: [number, number, number]; y0?: number }) {
  const [sx, sy, sz] = size;
  const geo = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(sx + 0.08, sy + 0.08, sz + 0.08)), [sx, sy, sz]);
  return (
    <lineSegments geometry={geo} position={[0, y0 + sy / 2, 0]} raycast={noRaycast}>
      <lineBasicMaterial color={C.blue} toneMapped={false} />
    </lineSegments>
  );
}

export function Parts({ layout }: { layout: Record<string, PartBox> }) {
  const site = useStore((s) => s.site);
  return (
    <group>
      {site.partOrder.map((id) => (
        <PartMesh key={id} id={id} box={layout[id]} />
      ))}
    </group>
  );
}
