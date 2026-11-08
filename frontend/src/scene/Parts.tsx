import { useMemo, useRef, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type CameraControlsImpl from 'camera-controls';
import * as THREE from 'three';
import { useStore } from '../store';
import { C, STATE_COLOR } from '../theme';
import { label, partTypeName } from '../mock/site';
import { stateText } from '../ui/format';
import type { PartBox } from './layout';
import { useUnprotectedParts } from './hooks';
import { inForeground } from './camera';

const noRaycast = () => null;

// Neighbouring units (CDU-3 next to CDU-4, PDU A next to PDU B) get tags at two heights so they don't overlap.
const tagStagger = (id: string) => (/[02468]$|-b$/.test(id) ? 0.55 : 0);

// In close shots, plain units standing in front of what the camera looks at (the power
// room in front of Row 1, say) fade to a ghost so they don't fill the foreground.
const FADED = 0.12;

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
  const capColor = state !== 'ok' ? STATE_COLOR[state] : unprotected ? C.gold : C.partCap;
  // Callout tags only where they help: problems, the unit a rack now depends on, and the selection.
  const headUnit = type === 'cdu' || type === 'pdu';
  const showTag = selected || cause || state !== 'ok' || (unprotected && headUnit);
  const tagTone = state === 'failed' ? 'red' : state !== 'ok' || unprotected ? 'gold' : 'azure';
  const body = selected || hovered ? C.partBodyHover : C.partBody;

  const bodyMesh = useRef<THREE.Mesh>(null!);
  const bodyMat = useRef<THREE.MeshStandardMaterial>(null!);
  const capMat = useRef<THREE.MeshBasicMaterial>(null!);
  const center = useMemo(() => new THREE.Vector3(box.pos[0], h / 2, box.pos[2]), [box, h]);
  const keepSolid = selected || cause || state !== 'ok' || unprotected;
  useFrame(({ camera, controls }, dt) => {
    const m = bodyMat.current;
    if (!m) return;
    const want = !keepSolid && inForeground(camera, controls as CameraControlsImpl | null, center, Math.max(w, d) / 2) ? FADED : 1;
    if (Math.abs(m.opacity - want) < 0.004) return;
    m.opacity += (want - m.opacity) * (1 - Math.exp(-dt * 8));
    if (Math.abs(m.opacity - want) < 0.004) m.opacity = want;
    m.depthWrite = m.opacity > 0.98;
    capMat.current.opacity = m.opacity;
    // a ghosted unit must not catch clicks meant for the racks behind it
    bodyMesh.current.raycast = m.opacity < 0.5 ? noRaycast : THREE.Mesh.prototype.raycast;
  });

  return (
    <group position={box.pos}>
      <mesh
        ref={bodyMesh}
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
        <meshStandardMaterial ref={bodyMat} color={body} roughness={0.65} metalness={0.3} transparent />
      </mesh>
      <mesh position={[0, h + 0.012, 0]} raycast={noRaycast}>
        <boxGeometry args={[w, 0.025, d]} />
        <meshBasicMaterial ref={capMat} color={capColor} toneMapped={false} transparent />
      </mesh>
      {(unprotected || state !== 'ok') && <PulseRing size={box.size} color={state === 'failed' ? C.red : C.gold} />}
      {selected && <SelectionEdges size={box.size} />}
      {showTag && (
        <Html position={[0, h + 0.5 + tagStagger(id), 0]} center zIndexRange={[1, 0]} pointerEvents="none">
          <div className="scene-tag">
            <span className={`mark tone-${tagTone}`} aria-hidden />
            {label(id)}
            {state !== 'ok' ? (
              <span className={`scene-tag-sub tone-${tagTone}`}>{stateText(state)}</span>
            ) : unprotected ? (
              <span className="scene-tag-sub tone-gold">Only working feed</span>
            ) : null}
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
      <lineBasicMaterial color={C.white} toneMapped={false} />
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
