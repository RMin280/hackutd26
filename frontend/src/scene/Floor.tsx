import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { C } from '../theme';
import {
  AISLE,
  ENTRY,
  HALL,
  PAIR_COUNT,
  POWER_ROOM_Z,
  RACK,
  ROW_CX,
  ROW_LEN,
  ROW_X0,
  ROW_X1,
  coldAisleZs,
  hotAisleZ,
  rowFacing,
  rowZ,
  type PartBox,
  type Vec3,
} from './layout';
import { makeTextTexture, useFontsReady } from './labels';
import { readFrame } from './camera';

const noRaycast = () => null;
const TILE = 0.6; // raised-floor tiles
const FADE = 9; // world units over which the floor dissolves into the dark around the hall
const SLAB_W = HALL.w + 2 * FADE;
const SLAB_D = HALL.d + 2 * FADE;

/** Alpha map: opaque over the hall, easing to transparent across the FADE margin. */
function fadeTexture(): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = ((i + 0.5) / size - 0.5) * SLAB_W;
      const z = ((j + 0.5) / size - 0.5) * SLAB_D;
      const dx = Math.max(0, Math.abs(x) - HALL.w / 2);
      const dz = Math.max(0, Math.abs(z) - HALL.d / 2);
      const t = Math.min(1, Math.hypot(dx, dz) / FADE);
      const v = Math.round((1 - t * t * (3 - 2 * t)) * 255);
      const k = (j * size + i) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = v;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

function tileTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = C.hallFloor;
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = C.tileLine;
  g.lineWidth = 4;
  g.strokeRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function perforatedTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = C.coldAisle;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = C.coldDot;
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      g.beginPath();
      g.arc(20 + i * 22, 20 + j * 22, 4.5, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.strokeStyle = C.tileLine;
  g.lineWidth = 4;
  g.strokeRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function Floor() {
  const tiles = useMemo(() => {
    const t = tileTexture();
    t.repeat.set(SLAB_W / TILE, SLAB_D / TILE);
    return t;
  }, []);
  const fade = useMemo(fadeTexture, []);
  const perf = useMemo(() => {
    const t = perforatedTexture();
    t.repeat.set((ROW_LEN + 0.3) / TILE, (AISLE.cold - 0.12) / TILE);
    return t;
  }, []);
  useEffect(
    () => () => {
      tiles.dispose();
      perf.dispose();
      fade.dispose();
    },
    [tiles, perf, fade],
  );

  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[HALL.cx, 0, HALL.cz]} renderOrder={-1} raycast={noRaycast}>
        <planeGeometry args={[SLAB_W, SLAB_D]} />
        <meshStandardMaterial map={tiles} alphaMap={fade} transparent roughness={0.95} />
      </mesh>
      {coldAisleZs().map((z) => (
        <mesh key={`cold-${z}`} rotation-x={-Math.PI / 2} position={[ROW_CX, 0.003, z]} raycast={noRaycast}>
          <planeGeometry args={[ROW_LEN + 0.3, AISLE.cold - 0.12]} />
          <meshStandardMaterial map={perf} roughness={0.9} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
        </mesh>
      ))}
      {Array.from({ length: PAIR_COUNT }, (_, p) => (
        <mesh key={`hot-${p}`} rotation-x={-Math.PI / 2} position={[ROW_CX, 0.003, hotAisleZ(p)]} raycast={noRaycast}>
          <planeGeometry args={[ROW_LEN, AISLE.hot]} />
          <meshStandardMaterial color={C.hotAisle} roughness={1} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
        </mesh>
      ))}
    </group>
  );
}

/** Glass roof and frame over each hot aisle: hot-aisle containment. The end doors are in Doors.tsx. */
export function Containment() {
  const glass = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: C.hotGlass,
        transparent: true,
        opacity: 0.1,
        depthWrite: false,
        side: THREE.DoubleSide,
        roughness: 0.3,
      }),
    [],
  );
  const frame = useMemo(() => {
    const pts: number[] = [];
    const seg = (a: Vec3, b: Vec3) => pts.push(...a, ...b);
    const y = RACK.h + 0.012;
    for (let p = 0; p < PAIR_COUNT; p++) {
      const z0 = hotAisleZ(p) - AISLE.hot / 2;
      const z1 = hotAisleZ(p) + AISLE.hot / 2;
      seg([ROW_X0, y, z0], [ROW_X1, y, z0]);
      seg([ROW_X0, y, z1], [ROW_X1, y, z1]);
      for (const x of [ROW_X0, ROW_X1]) {
        seg([x, y, z0], [x, y, z1]);
        seg([x, 0, z0], [x, y, z0]);
        seg([x, 0, z1], [x, y, z1]);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return geo;
  }, []);
  useEffect(
    () => () => {
      glass.dispose();
      frame.dispose();
    },
    [glass, frame],
  );

  return (
    <group>
      {Array.from({ length: PAIR_COUNT }, (_, p) => (
        <group key={p}>
          <mesh material={glass} rotation-x={-Math.PI / 2} position={[ROW_CX, RACK.h + 0.012, hotAisleZ(p)]} raycast={noRaycast} renderOrder={1}>
            <planeGeometry args={[ROW_LEN, AISLE.hot]} />
          </mesh>
        </group>
      ))}
      <lineSegments geometry={frame} raycast={noRaycast}>
        <lineBasicMaterial color={C.hotFrame} transparent opacity={0.9} />
      </lineSegments>
    </group>
  );
}

type Register = (mesh: THREE.Mesh | null) => void;

function FloorText({
  text,
  position,
  height,
  color,
  opacity = 1,
  weight = 500,
  register,
}: {
  text: string;
  position: Vec3;
  height: number;
  color: string;
  opacity?: number;
  weight?: number;
  register: Register;
}) {
  const ready = useFontsReady();
  const tex = useMemo(() => (ready ? makeTextTexture(text, weight) : null), [ready, text, weight]);
  useEffect(() => () => tex?.texture.dispose(), [tex]);
  if (!tex) return null;
  return (
    <mesh
      ref={(m) => {
        if (m) m.userData.baseOpacity = opacity;
        register(m);
      }}
      position={position}
      rotation-x={-Math.PI / 2}
      renderOrder={2}
      raycast={noRaycast}
    >
      <planeGeometry args={[height * tex.aspect, height]} />
      <meshBasicMaterial
        map={tex.texture}
        color={color}
        transparent
        opacity={opacity}
        depthWrite={false}
        toneMapped={false}
        polygonOffset
        polygonOffsetFactor={-2}
        polygonOffsetUnits={-2}
      />
    </mesh>
  );
}

// Floor text grows with camera distance so it stays readable from the overview without
// turning into billboards in close-ups (scale = distance / LABEL_REF, clamped).
const LABEL_REF = 16;
const LABEL_MIN = 0.8;
const LABEL_MAX = 1.9;
// Labels fade out when they would sit under a HUD panel (text under text reads as a glitch).
const LABEL_EDGE = 16; // px inside the free area

/** Row names painted on the cold-aisle floor in front of each row, plus zone names. */
export function FloorLabels({ parts }: { parts: Record<string, PartBox> }) {
  // Floor text turns 180° when the camera looks south, so it never reads upside down.
  const meshes = useRef(new Set<THREE.Mesh>());
  const flipped = useRef(false);
  const forward = useMemo(() => new THREE.Vector3(), []);
  const end = useMemo(() => new THREE.Vector3(), []);
  const register: Register = (mesh) => {
    if (mesh) {
      mesh.rotation.z = flipped.current ? Math.PI : 0;
      meshes.current.add(mesh);
    }
  };
  useFrame(({ camera, gl }, dt) => {
    camera.getWorldDirection(forward);
    const flip = forward.z > 0.05 ? true : forward.z < -0.05 ? false : flipped.current;
    const f = readFrame(gl.domElement);
    const ease = 1 - Math.exp(-dt * 10);
    const inside = (p: THREE.Vector3) => {
      end.copy(p).project(camera);
      const sx = ((end.x + 1) / 2) * f.width;
      const sy = ((1 - end.y) / 2) * f.height;
      return end.z < 1 && sx > f.left + LABEL_EDGE && sx < f.right - LABEL_EDGE && sy > f.top + LABEL_EDGE && sy < f.bottom - LABEL_EDGE;
    };
    for (const m of meshes.current) {
      if (!m.parent) {
        meshes.current.delete(m);
        continue;
      }
      if (flip !== flipped.current) m.rotation.z = flip ? Math.PI : 0;
      const s = THREE.MathUtils.clamp(camera.position.distanceTo(m.position) / LABEL_REF, LABEL_MIN, LABEL_MAX);
      m.scale.setScalar(s);
      // both ends of the label must be inside the free area
      const half = (((m.geometry as THREE.PlaneGeometry).parameters?.width ?? 0) / 2) * s;
      end.set(m.position.x - half, m.position.y, m.position.z);
      const a = inside(end);
      end.set(m.position.x + half, m.position.y, m.position.z);
      const visible = a && inside(end);
      const mat = m.material as THREE.MeshBasicMaterial;
      const base = (m.userData.baseOpacity as number | undefined) ?? 1;
      mat.opacity += ((visible ? base : 0) - mat.opacity) * ease;
      m.visible = mat.opacity > 0.01;
    }
    flipped.current = flip;
  });

  const y = 0.004;
  const rows = Array.from({ length: 10 }, (_, i) => i + 1);
  const chiller1 = parts['chiller-1'].pos;
  const spine1 = parts['sw-spine-1'].pos;
  const t = { register };
  return (
    <group>
      {rows.map((row) => (
        <FloorText
          key={row}
          {...t}
          text={`ROW ${row}`}
          position={[ROW_X0 + 0.95, y, rowZ(row) + rowFacing(row) * (RACK.d / 2 + 0.45)]}
          height={0.36}
          color={C.label}
        />
      ))}
      {Array.from({ length: PAIR_COUNT }, (_, p) => (
        <FloorText key={`hot-${p}`} {...t} text="HOT AISLE" position={[ROW_X0 + 1.25, y, hotAisleZ(p)]} height={0.3} color={C.hotLabel} opacity={0.85} />
      ))}
      <FloorText {...t} text="POWER ROOM" position={[0, y, POWER_ROOM_Z - 1.25]} height={0.42} color={C.label} />
      <FloorText {...t} text="COOLING" position={[ROW_X0 - 2.0, y, rowZ(1) - RACK.d / 2 - 0.9]} height={0.34} color={C.label} />
      <FloorText {...t} text="CHILLERS" position={[chiller1[0], y, chiller1[2] - 2.2]} height={0.34} color={C.label} />
      <FloorText {...t} text="PDU · LEAF" position={[ROW_X1 + 1.25, y, rowZ(1) - RACK.d / 2 - 0.9]} height={0.3} color={C.label} />
      <FloorText {...t} text="TECH OFFICE" position={[(ENTRY.office.x0 + ENTRY.office.x1) / 2 - 0.3, y, ENTRY.office.z1 - 0.55]} height={0.26} color={C.label} />
      <FloorText {...t} text="SPINE" position={[spine1[0], y, spine1[2] - 1.2]} height={0.3} color={C.label} />
    </group>
  );
}
