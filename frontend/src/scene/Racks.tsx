import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../store';
import { C } from '../theme';
import { NODE, RACK, nodeCenter, rackBase, rowFacing } from './layout';
import { marginText, ownerText } from '../ui/format';
import { useProtectedRacks, useSoftwareWork } from './hooks';

const tmpObj = new THREE.Object3D();
const tmpColor = new THREE.Color();
const isClick = (e: ThreeEvent<MouseEvent>) => e.delta <= 4;
const noRaycast = () => null;

// Two small LEDs at the right-hand end of every server panel: a steady power light and an
// activity light that blinks in its own rhythm. Busy (job) nodes blink most, spares hardly at all,
// failed nodes go dark. Tiny on purpose: a twinkle in close-ups, nothing from the overview.
const LED = { w: 0.022, h: 0.012, d: 0.006, xAct: 0.195, xPwr: 0.228, y: 0.045 };
const LED_ON = new THREE.Color('#e2e8f3');
const LED_POWER = 0.4;
/** Deterministic pseudo-random in [0, 1) from an index and a salt. */
function hash(n: number, salt: number): number {
  let x = Math.imul(n ^ salt, 0x9e3779b1) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  return x / 4294967296;
}

/**
 * Racks, their status strips and lids, and the server panels on each face.
 * Everything is instanced: four draw calls for 160 racks and 1,280 nodes.
 */
export function Racks() {
  const site = useStore((s) => s.site);
  const world = useStore((s) => s.world);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const setHover = useStore((s) => s.setHover);
  const canvas = useThree((s) => s.gl.domElement);

  const bodyRef = useRef<THREE.InstancedMesh>(null!);
  const lidRef = useRef<THREE.InstancedMesh>(null!);
  const stripRef = useRef<THREE.InstancedMesh>(null!);
  const nodeRef = useRef<THREE.InstancedMesh>(null!);
  const ledRef = useRef<THREE.InstancedMesh>(null!); // [front act, rear act, front power, rear power]
  const hovered = useRef(-1);

  const R = site.rackOrder.length;
  const N = site.nodeOrder.length;

  // Static transforms. Strips and node panels exist on both faces (index + R / + N = rear).
  useLayoutEffect(() => {
    tmpObj.rotation.set(0, 0, 0);
    tmpObj.scale.set(1, 1, 1);
    site.rackOrder.forEach((rid, i) => {
      const [x, , z] = rackBase(site, rid);
      const f = rowFacing(site.racks[rid].row);
      tmpObj.position.set(x, RACK.h / 2, z);
      tmpObj.updateMatrix();
      bodyRef.current.setMatrixAt(i, tmpObj.matrix);
      for (const side of [1, -1]) {
        tmpObj.position.set(x, RACK.h - 0.1, z + f * side * (RACK.d / 2 + 0.007));
        tmpObj.updateMatrix();
        stripRef.current.setMatrixAt(side === 1 ? i : i + R, tmpObj.matrix);
      }
      lidRef.current.setColorAt(i, tmpColor.set(C.gold)); // allocates instanceColor up front
    });
    site.nodeOrder.forEach((nid, i) => {
      for (const side of [1, -1] as const) {
        const [x, y, z] = nodeCenter(site, nid, side);
        tmpObj.position.set(x, y, z);
        tmpObj.updateMatrix();
        const j = side === 1 ? i : i + N;
        nodeRef.current.setMatrixAt(j, tmpObj.matrix);
        // LEDs sit proud of the panel, on the viewer's right
        const f = rowFacing(site.nodes[nid].row) * side;
        const zl = z + f * (NODE.d / 2 + LED.d / 2 + 0.001);
        tmpObj.position.set(x - f * LED.xAct, y + LED.y, zl);
        tmpObj.updateMatrix();
        ledRef.current.setMatrixAt(j, tmpObj.matrix);
        tmpObj.position.set(x - f * LED.xPwr, y + LED.y, zl);
        tmpObj.updateMatrix();
        ledRef.current.setMatrixAt(j + 2 * N, tmpObj.matrix);
      }
    });
    for (const m of [bodyRef.current, stripRef.current, nodeRef.current, ledRef.current]) {
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }, [site, R, N]);

  // Each activity LED has its own blink rate and phase, fixed for the session.
  const blink = useMemo(() => {
    const rate = new Float32Array(N);
    const phase = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      rate[i] = hash(i, 11);
      phase[i] = hash(i, 23);
    }
    return { rate, phase };
  }, [N]);
  // 0 = failed or out of service (dark), 1 = free spare, 2 = tenant, 3 = job
  const ledKind = useMemo(() => {
    const k = new Uint8Array(N);
    site.nodeOrder.forEach((n, i) => {
      const st = world.nodeState[n];
      if (st === 'failed' || st === 'maintenance') k[i] = 0;
      else {
        const o = world.owner[n].kind;
        k[i] = o === 'job' ? 3 : o === 'tenant' ? 2 : 1;
      }
    });
    return k;
  }, [site, world, N]);

  useLayoutEffect(() => {
    for (let i = 0; i < N; i++) {
      tmpColor.copy(LED_ON).multiplyScalar(ledKind[i] ? LED_POWER : 0);
      ledRef.current.setColorAt(i + 2 * N, tmpColor);
      ledRef.current.setColorAt(i + 3 * N, tmpColor);
    }
    ledRef.current.instanceColor!.needsUpdate = true;
  }, [ledKind, N]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const { rate, phase } = blink;
    for (let i = 0; i < N; i++) {
      const k = ledKind[i];
      let b = 0;
      if (k === 3) {
        const u = (t * (0.9 + 1.7 * rate[i]) + phase[i]) % 1;
        b = u < 0.1 ? 1 : 0.28;
      } else if (k === 2) {
        const u = (t * (0.4 + 0.8 * rate[i]) + phase[i]) % 1;
        b = u < 0.08 ? 0.9 : 0.2;
      } else if (k === 1) {
        const u = (t * (0.12 + 0.15 * rate[i]) + phase[i]) % 1;
        b = u < 0.05 ? 0.7 : 0.12;
      }
      tmpColor.copy(LED_ON).multiplyScalar(b);
      ledRef.current.setColorAt(i, tmpColor);
      ledRef.current.setColorAt(i + N, tmpColor);
    }
    ledRef.current.instanceColor!.needsUpdate = true;
  });

  // A selected part lights the racks below it; a selected rack or node lights its rack.
  const litRacks = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === 'part') return new Set(site.downstream[selection.id]);
    if (selection.kind === 'rack') return new Set([selection.id]);
    return new Set([site.nodes[selection.id].rack]);
  }, [selection, site]);

  const protectedRacks = useProtectedRacks();
  const software = useSoftwareWork();

  const bodyColor = (i: number) => {
    if (i === hovered.current) return C.rackBodyHover;
    if (!litRacks) return C.rackBody;
    return litRacks.has(site.rackOrder[i]) ? C.rackBodyLit : C.rackBodyDim;
  };

  // Bodies, status strips, and lids on racks that lost backup
  useLayoutEffect(() => {
    site.rackOrder.forEach((rid, i) => {
      bodyRef.current.setColorAt(i, tmpColor.set(bodyColor(i)));
      const level = world.margins[rid].level;
      const strip = level === 'green' ? C.stripOk : level === 'yellow' ? C.gold : C.red;
      tmpColor.set(strip);
      stripRef.current.setColorAt(i, tmpColor);
      stripRef.current.setColorAt(i + R, tmpColor);
    });
    bodyRef.current.instanceColor!.needsUpdate = true;
    stripRef.current.instanceColor!.needsUpdate = true;

    // Lids say what a rack's status is from above: red (no working feed) over gold (one failure
    // from an outage) over azure (protected by a lease). Healthy, unprotected racks have none.
    const lidded = site.rackOrder.filter((rid) => world.margins[rid].level !== 'green' || protectedRacks.has(rid));
    lidded.forEach((rid, j) => {
      const [x, , z] = rackBase(site, rid);
      tmpObj.position.set(x, RACK.h + 0.012, z);
      tmpObj.updateMatrix();
      lidRef.current.setMatrixAt(j, tmpObj.matrix);
      const level = world.margins[rid].level;
      lidRef.current.setColorAt(j, tmpColor.set(level === 'red' ? C.red : level === 'yellow' ? C.gold : C.lidProtected));
    });
    lidRef.current.count = lidded.length;
    lidRef.current.instanceMatrix.needsUpdate = true;
    lidRef.current.instanceColor!.needsUpdate = true;
    lidRef.current.computeBoundingSphere();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, litRacks, site, R, protectedRacks]);

  // Server panels: muted unless something is wrong
  const atRisk = useMemo(() => new Set(world.diagnosis?.atRisk ?? []), [world.diagnosis]);
  // Ice = a safe placement, shown as soon as it is proposed (naive swaps stay plain).
  const placed = useMemo(() => new Set(world.placement?.nodes ?? []), [world.placement]);
  const pulsing = useMemo(
    () =>
      site.nodeOrder
        .map((n, i) => ({ n, i }))
        .filter(({ n }) => world.nodeState[n] === 'failed' || atRisk.has(n)),
    [site, world, atRisk],
  );

  const nodeColor = (n: string): string => {
    if (world.nodeState[n] === 'failed') return C.red;
    // Held out of service by a lease: powered down, so it goes dark. Violet-dark when the lease is
    // a drain-required update, so software work reads apart from a repair.
    if (world.nodeState[n] === 'maintenance') return software.drained.has(n) ? C.nodeUpdateOut : C.nodeOut;
    if (atRisk.has(n)) return C.gold;
    const o = world.owner[n];
    if (placed.has(n)) return C.ice;
    // An online update: the node keeps running (its LEDs say so); the panel says what is changing.
    if (software.online.has(n)) return C.update;
    if (o.kind === 'job') return C.nodeJob;
    if (o.kind === 'tenant') return C.nodeTenant;
    return C.nodeFree;
  };

  useLayoutEffect(() => {
    site.nodeOrder.forEach((n, i) => {
      tmpColor.set(nodeColor(n));
      nodeRef.current.setColorAt(i, tmpColor);
      nodeRef.current.setColorAt(i + N, tmpColor);
    });
    nodeRef.current.instanceColor!.needsUpdate = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, atRisk, placed, software, site, N]);

  useFrame(({ clock }) => {
    if (!pulsing.length) return;
    const k = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(clock.elapsedTime * 3.6));
    for (const { n, i } of pulsing) {
      tmpColor.set(nodeColor(n)).multiplyScalar(k);
      nodeRef.current.setColorAt(i, tmpColor);
      nodeRef.current.setColorAt(i + N, tmpColor);
    }
    nodeRef.current.instanceColor!.needsUpdate = true;
  });

  const setHoveredRack = (i: number) => {
    if (hovered.current === i) return;
    const prev = hovered.current;
    hovered.current = i;
    if (prev >= 0) bodyRef.current.setColorAt(prev, tmpColor.set(bodyColor(prev)));
    if (i >= 0) bodyRef.current.setColorAt(i, tmpColor.set(bodyColor(i)));
    bodyRef.current.instanceColor!.needsUpdate = true;
  };

  const leave = () => {
    setHoveredRack(-1);
    setHover(null);
    canvas.style.cursor = '';
  };

  return (
    <group>
      <instancedMesh
        ref={bodyRef}
        args={[undefined as any, undefined as any, R]}
        onPointerMove={(e) => {
          if (e.instanceId === undefined) return;
          e.stopPropagation();
          const rid = site.rackOrder[e.instanceId];
          setHoveredRack(e.instanceId);
          canvas.style.cursor = 'pointer';
          setHover({ label: rid, sub: marginText(world.margins[rid].level), x: e.clientX, y: e.clientY });
        }}
        onPointerOut={leave}
        onClick={(e) => {
          if (e.instanceId === undefined || !isClick(e)) return;
          e.stopPropagation();
          select({ kind: 'rack', id: site.rackOrder[e.instanceId] });
        }}
      >
        <boxGeometry args={[RACK.w, RACK.h, RACK.d]} />
        <meshStandardMaterial roughness={0.62} metalness={0.35} />
      </instancedMesh>

      <instancedMesh ref={stripRef} args={[undefined as any, undefined as any, R * 2]} raycast={noRaycast}>
        <boxGeometry args={[RACK.w * 0.84, 0.035, 0.012]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>

      <instancedMesh ref={lidRef} args={[undefined as any, undefined as any, R]} raycast={noRaycast}>
        <boxGeometry args={[RACK.w + 0.01, 0.025, RACK.d + 0.01]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>

      <instancedMesh
        ref={nodeRef}
        args={[undefined as any, undefined as any, N * 2]}
        onPointerMove={(e) => {
          if (e.instanceId === undefined) return;
          e.stopPropagation();
          const nid = site.nodeOrder[e.instanceId % N];
          const st = world.nodeState[nid];
          setHoveredRack(site.rackOrder.indexOf(site.nodes[nid].rack));
          canvas.style.cursor = 'pointer';
          const state = software.drained.has(nid) ? 'drain-required update' : software.online.has(nid) && st === 'ok' ? 'online update' : st;
          setHover({
            label: nid,
            sub: state === 'ok' ? ownerText(world.owner[nid]) : `${state} · ${ownerText(world.owner[nid])}`,
            x: e.clientX,
            y: e.clientY,
          });
        }}
        onPointerOut={leave}
        onClick={(e) => {
          if (e.instanceId === undefined || !isClick(e)) return;
          e.stopPropagation();
          select({ kind: 'node', id: site.nodeOrder[e.instanceId % N] });
        }}
      >
        <boxGeometry args={[NODE.w, NODE.h, NODE.d]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>

      <instancedMesh ref={ledRef} args={[undefined as any, undefined as any, N * 4]} raycast={noRaycast}>
        <boxGeometry args={[LED.w, LED.h, LED.d]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  );
}
