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
import { useSoftwareWork, useUnprotectedParts } from './hooks';
import { inForeground } from './camera';

const noRaycast = () => null;

// Neighbouring units (CDU-3 next to CDU-4, PDU A next to PDU B) get tags at two heights so they don't overlap.
const tagStagger = (id: string) => (/[02468]$|-b$/.test(id) ? 0.55 : 0);

/** Where a unit's callout hangs: above its top, staggered for neighbours. */
const tagAnchor = (id: string, box: PartBox) => new THREE.Vector3(box.pos[0], box.size[1] + 0.5 + tagStagger(id), box.pos[2]);

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
  const firmware = useSoftwareWork().parts.has(id); // a switch rebooting for a firmware upgrade
  const cause = useStore((s) => s.world.diagnosis?.cause === id);
  const canvas = useThree((s) => s.gl.domElement);
  const [hovered, setHovered] = useState(false);

  const type = site.parts[id].type;
  const [w, h, d] = box.size;
  const capColor = firmware ? C.update : state !== 'ok' ? STATE_COLOR[state] : unprotected ? C.gold : C.partCap;
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
            sub: `${partTypeName(type)} · ${firmware ? 'firmware update' : stateText(state)}${unprotected ? ' · only working feed' : ''}`,
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
      {(unprotected || state !== 'ok') && <PulseRing size={box.size} color={state === 'failed' ? C.red : firmware ? C.update : C.gold} />}
      {selected && <SelectionEdges size={box.size} />}
    </group>
  );
}

// ---------- callouts ----------
//
// A tag over each unit that needs a look: a failed or degraded unit, the diagnosed cause, the
// one feed a rack now hangs on, the selection. They are DOM (drei's Html) and keep their pixel
// size as the camera pulls back, so left alone they pile up over neighbouring units. Each frame
// the tags are placed in screen space, most important first, and one that would land on a tag
// already placed drops a level: the whole callout, the name alone, then only its mark. Far
// enough out that a unit is a few pixels wide, nothing gets more than a name, then a mark.

type TagLevel = 0 | 1 | 2; // mark only · name · name + state
const LOD = ['dot', 'name', 'full'] as const;

interface TagSpec {
  id: string;
  name: string;
  sub: string | null;
  tone: 'red' | 'gold' | 'azure' | 'update';
  anchor: THREE.Vector3;
  priority: number;
}

// The tag's box in CSS pixels, mirroring .scene-tag in styles.css.
const TAG_PAD = 8;
const TAG_MARK = 6;
const TAG_GAP = 8;
const TAG_H = 16 + 2 * 4 + 2; // line height, padding, border
const DOT = 10; // the mark alone, with its outline
const PROMOTE_MARGIN = 12; // clearance a tag needs before it grows back, so it doesn't flicker
// Pixels per metre at the unit, below which text is a callout for a speck. Two thresholds each
// way for the same reason.
const NAME_BELOW = 20;
const NAME_ABOVE = 24;
const DOT_BELOW = 11;
const DOT_ABOVE = 14;

let measurer: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, font: string, spacingEm = 0): number {
  if (measurer === undefined) measurer = document.createElement('canvas').getContext('2d');
  if (!measurer) return 7 * text.length;
  measurer.font = font;
  const px = parseFloat(font) || 12;
  return measurer.measureText(text).width + spacingEm * px * Math.max(0, [...text].length - 1);
}

const TAG_FONT = '500 12px Roboto, Inter, sans-serif';
const SUB_FONT = '500 11px Roboto, Inter, sans-serif';

function tagWidth(t: TagSpec, level: TagLevel): number {
  if (level === 0) return DOT;
  let w = 2 * TAG_PAD + 2 + TAG_MARK + TAG_GAP + textWidth(t.name, TAG_FONT);
  if (level === 2 && t.sub) w += TAG_GAP + textWidth(t.sub.toUpperCase(), SUB_FONT, 0.12);
  return w;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const rectAt = (t: TagSpec, level: TagLevel, cx: number, cy: number): Rect => {
  const w = tagWidth(t, level);
  const h = level === 0 ? DOT : TAG_H;
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
};

const overlaps = (a: Rect, b: Rect, margin: number) => a.x0 < b.x1 + margin && b.x0 < a.x1 + margin && a.y0 < b.y1 + margin && b.y0 < a.y1 + margin;

const projected = new THREE.Vector3();

function PartTags({ layout }: { layout: Record<string, PartBox> }) {
  const site = useStore((s) => s.site);
  const partState = useStore((s) => s.world.partState);
  const cause = useStore((s) => s.world.diagnosis?.cause);
  const selected = useStore((s) => (s.selection?.kind === 'part' ? s.selection.id : null));
  const unprotected = useUnprotectedParts();
  const firmware = useSoftwareWork().parts;

  // Callouts only where they help: problems, the unit a rack now depends on, and the selection.
  const specs = useMemo(() => {
    const out: TagSpec[] = [];
    for (const id of site.partOrder) {
      const type = site.parts[id].type;
      const state = partState[id];
      const only = unprotected.has(id);
      const headUnit = type === 'cdu' || type === 'pdu';
      if (!(selected === id || cause === id || state !== 'ok' || (only && headUnit))) continue;
      out.push({
        id,
        name: label(id),
        sub: firmware.has(id) ? 'Firmware update' : state !== 'ok' ? stateText(state) : only ? 'Only working feed' : null,
        tone: state === 'failed' ? 'red' : firmware.has(id) ? 'update' : state !== 'ok' || only ? 'gold' : 'azure',
        anchor: tagAnchor(id, layout[id]),
        priority: selected === id ? 5 : state === 'failed' ? 4 : cause === id ? 3 : state !== 'ok' ? 2 : 1,
      });
    }
    return out.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  }, [site, partState, cause, selected, unprotected, firmware, layout]);

  const [levels, setLevels] = useState<Record<string, TagLevel>>({});
  const current = useRef(levels);

  useFrame(({ camera, size }) => {
    const cam = camera as THREE.PerspectiveCamera;
    const pxAtOneMetre = size.height / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    const was = current.current;
    const next: Record<string, TagLevel> = {};
    const placed: Rect[] = [];
    let changed = false;
    for (const t of specs) {
      const cur = was[t.id] ?? 2;
      const pxPerMetre = pxAtOneMetre / cam.position.distanceTo(t.anchor);
      let level: TagLevel = 2;
      if (pxPerMetre < (cur >= 2 ? NAME_BELOW : NAME_ABOVE)) level = 1;
      if (pxPerMetre < (cur >= 1 ? DOT_BELOW : DOT_ABOVE)) level = 0;
      projected.copy(t.anchor).project(cam);
      if (projected.z < 1 && Math.abs(projected.x) < 1.3 && Math.abs(projected.y) < 1.3) {
        const cx = ((projected.x + 1) / 2) * size.width;
        const cy = ((1 - projected.y) / 2) * size.height;
        for (; level > 0; level--) {
          const r = rectAt(t, level, cx, cy);
          if (!placed.some((p) => overlaps(p, r, level > cur ? PROMOTE_MARGIN : 0))) break;
        }
        placed.push(rectAt(t, level, cx, cy));
      }
      next[t.id] = level;
      if (was[t.id] !== level) changed = true;
    }
    if (changed || Object.keys(was).length !== specs.length) {
      current.current = next;
      setLevels(next);
    }
  });

  return (
    <group>
      {specs.map((t) => (
        <Html key={t.id} position={t.anchor} center zIndexRange={[1, 0]} pointerEvents="none">
          <div className="scene-tag" data-lod={LOD[levels[t.id] ?? 2]}>
            <span className={`mark tone-${t.tone}`} aria-hidden />
            <span className="scene-tag-name">{t.name}</span>
            {t.sub && <span className={`scene-tag-sub tone-${t.tone}`}>{t.sub}</span>}
          </div>
        </Html>
      ))}
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
      <PartTags layout={layout} />
    </group>
  );
}
