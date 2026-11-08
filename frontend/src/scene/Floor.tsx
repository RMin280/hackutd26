import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { C } from '../theme';
import {
  AISLE,
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

const noRaycast = () => null;
const TILE = 0.6; // raised-floor tiles

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
    t.repeat.set(HALL.w / TILE, HALL.d / TILE);
    return t;
  }, []);
  const perf = useMemo(() => {
    const t = perforatedTexture();
    t.repeat.set((ROW_LEN + 0.3) / TILE, (AISLE.cold - 0.12) / TILE);
    return t;
  }, []);
  useEffect(
    () => () => {
      tiles.dispose();
      perf.dispose();
    },
    [tiles, perf],
  );

  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.02, 0]} raycast={noRaycast}>
        <planeGeometry args={[400, 400]} />
        <meshStandardMaterial color={C.ground} roughness={1} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[HALL.cx, 0, HALL.cz]} raycast={noRaycast}>
        <planeGeometry args={[HALL.w, HALL.d]} />
        <meshStandardMaterial map={tiles} roughness={0.95} />
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

/** Glass roof and end doors over each hot aisle: hot-aisle containment. */
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
          {[ROW_X0, ROW_X1].map((x) => (
            <mesh key={x} material={glass} rotation-y={Math.PI / 2} position={[x, RACK.h / 2, hotAisleZ(p)]} raycast={noRaycast} renderOrder={1}>
              <planeGeometry args={[AISLE.hot, RACK.h]} />
            </mesh>
          ))}
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
  weight = 600,
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
    <mesh ref={register} position={position} rotation-x={-Math.PI / 2} renderOrder={2} raycast={noRaycast}>
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

/** Row names painted on the cold-aisle floor in front of each row, plus zone names. */
export function FloorLabels({ parts }: { parts: Record<string, PartBox> }) {
  // Floor text turns 180° when the camera looks south, so it never reads upside down.
  const meshes = useRef(new Set<THREE.Mesh>());
  const flipped = useRef(false);
  const forward = useMemo(() => new THREE.Vector3(), []);
  const register: Register = (mesh) => {
    if (mesh) {
      mesh.rotation.z = flipped.current ? Math.PI : 0;
      meshes.current.add(mesh);
    }
  };
  useFrame(({ camera }) => {
    camera.getWorldDirection(forward);
    const flip = forward.z > 0.05 ? true : forward.z < -0.05 ? false : flipped.current;
    if (flip === flipped.current) return;
    flipped.current = flip;
    for (const m of meshes.current) {
      if (m.parent) m.rotation.z = flip ? Math.PI : 0;
      else meshes.current.delete(m);
    }
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
          weight={700}
        />
      ))}
      {Array.from({ length: PAIR_COUNT }, (_, p) => (
        <FloorText key={`hot-${p}`} {...t} text="HOT AISLE" position={[ROW_X0 + 1.25, y, hotAisleZ(p)]} height={0.3} color={C.hotLabel} opacity={0.85} />
      ))}
      <FloorText {...t} text="POWER ROOM" position={[0, y, POWER_ROOM_Z - 1.25]} height={0.42} color={C.label} />
      <FloorText {...t} text="COOLING" position={[ROW_X0 - 2.0, y, rowZ(1) - RACK.d / 2 - 0.9]} height={0.34} color={C.label} />
      <FloorText {...t} text="CHILLERS" position={[chiller1[0], y, chiller1[2] - 2.2]} height={0.34} color={C.label} />
      <FloorText {...t} text="PDU · LEAF" position={[ROW_X1 + 1.25, y, rowZ(1) - RACK.d / 2 - 0.9]} height={0.3} color={C.label} />
      <FloorText {...t} text="SPINE" position={[spine1[0], y, spine1[2] - 1.2]} height={0.3} color={C.label} />
    </group>
  );
}
