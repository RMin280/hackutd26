import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../store';
import { C } from '../theme';
import { NODE, RACK, nodeCenter, rackBase, rowFacing } from './layout';
import { marginText, ownerText } from '../ui/format';

const tmpObj = new THREE.Object3D();
const tmpColor = new THREE.Color();
const isClick = (e: ThreeEvent<MouseEvent>) => e.delta <= 4;
const noRaycast = () => null;

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
      lidRef.current.setColorAt(i, tmpColor.set(C.amber)); // allocates instanceColor up front
    });
    site.nodeOrder.forEach((nid, i) => {
      for (const side of [1, -1] as const) {
        const [x, y, z] = nodeCenter(site, nid, side);
        tmpObj.position.set(x, y, z);
        tmpObj.updateMatrix();
        nodeRef.current.setMatrixAt(side === 1 ? i : i + N, tmpObj.matrix);
      }
    });
    for (const m of [bodyRef.current, stripRef.current, nodeRef.current]) {
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }, [site, R, N]);

  // A selected part lights the racks below it; a selected rack or node lights its rack.
  const litRacks = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === 'part') return new Set(site.downstream[selection.id]);
    if (selection.kind === 'rack') return new Set([selection.id]);
    return new Set([site.nodes[selection.id].rack]);
  }, [selection, site]);

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
      const strip = level === 'green' ? C.stripOk : level === 'yellow' ? C.amber : C.red;
      tmpColor.set(strip);
      stripRef.current.setColorAt(i, tmpColor);
      stripRef.current.setColorAt(i + R, tmpColor);
    });
    bodyRef.current.instanceColor!.needsUpdate = true;
    stripRef.current.instanceColor!.needsUpdate = true;

    const problems = site.rackOrder.filter((rid) => world.margins[rid].level !== 'green');
    problems.forEach((rid, j) => {
      const [x, , z] = rackBase(site, rid);
      tmpObj.position.set(x, RACK.h + 0.012, z);
      tmpObj.updateMatrix();
      lidRef.current.setMatrixAt(j, tmpObj.matrix);
      lidRef.current.setColorAt(j, tmpColor.set(world.margins[rid].level === 'yellow' ? C.amber : C.red));
    });
    lidRef.current.count = problems.length;
    lidRef.current.instanceMatrix.needsUpdate = true;
    lidRef.current.instanceColor!.needsUpdate = true;
    lidRef.current.computeBoundingSphere();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, litRacks, site, R]);

  // Server panels: muted unless something is wrong
  const atRisk = useMemo(() => new Set(world.diagnosis?.atRisk ?? []), [world.diagnosis]);
  // Teal = a Blast Radius safe placement, shown as soon as it is proposed (naive swaps stay plain).
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
    if (atRisk.has(n)) return C.amber;
    const o = world.owner[n];
    if (placed.has(n)) return C.teal;
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
  }, [world, atRisk, placed, site, N]);

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
          setHover({
            label: nid,
            sub: st === 'ok' ? ownerText(world.owner[nid]) : `${st} · ${ownerText(world.owner[nid])}`,
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
    </group>
  );
}
