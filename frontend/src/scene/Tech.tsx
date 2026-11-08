// The tech on screen (its behaviour is in rounds.ts): a gull in an azure hard hat, the route it
// has planned as azure dots on the floor (eaten up as it walks), a ring at its feet that fills
// while it works, and sparks off whatever it is fixing. T puts it on and off duty.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../store';
import { C } from '../theme';
import type { PartBox } from './layout';
import { STAFF_LAYER, buildCrew } from './Staff';
import { inForeground } from './camera';
import { buildHallGrid, spotsFor, type Repair, type Spot } from './nav';
import { buildOffice, createTech, type Tech as TechBrain } from './rounds';
import type { Airlock } from './airlock';

const noRaycast = () => null;
const DOT_GAP = 0.36; // metres between route dots
const MAX_DOTS = 256;
const SPARKS = 40;
const RING_SEGMENTS = 64;

interface Fx {
  group: THREE.Group;
  update: (tech: TechBrain, t: number, dt: number) => void;
  dispose: () => void;
}

function buildFx(): Fx {
  const group = new THREE.Group();
  const disposables: { dispose: () => void }[] = [];
  const own = <T extends { dispose: () => void }>(x: T) => (disposables.push(x), x);
  const add = <T extends THREE.Mesh>(m: T) => {
    m.frustumCulled = false;
    m.raycast = noRaycast;
    m.layers.set(STAFF_LAYER);
    group.add(m);
    return m;
  };
  const azure = (opacity: number) =>
    own(new THREE.MeshBasicMaterial({ color: C.azure, toneMapped: false, transparent: true, opacity, depthWrite: false }));

  // The planned route: dots on the floor from the gull to where it will stand.
  const dotGeo = own(new THREE.CircleGeometry(0.06, 12).rotateX(-Math.PI / 2));
  const dots = add(new THREE.InstancedMesh(dotGeo, azure(0.85), MAX_DOTS));
  dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  dots.count = 0;
  dots.renderOrder = 2;

  // How far through the repair it is: a faint ring at its feet, and an arc over it that fills.
  const track = add(new THREE.Mesh(own(new THREE.RingGeometry(0.5, 0.58, RING_SEGMENTS, 1).rotateX(-Math.PI / 2)), azure(0.2)));
  const fill = add(new THREE.Mesh(own(new THREE.RingGeometry(0.5, 0.58, RING_SEGMENTS, 1).rotateX(-Math.PI / 2)), azure(0.95)));
  track.renderOrder = 2;
  fill.renderOrder = 3;
  track.visible = fill.visible = false;

  // Sparks off the part being worked on.
  const sparkGeo = own(new THREE.SphereGeometry(0.024, 6, 4));
  const sparkMat = own(new THREE.MeshBasicMaterial({ color: C.azure, toneMapped: false }));
  const sparks = add(new THREE.InstancedMesh(sparkGeo, sparkMat, SPARKS));
  sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const pool = Array.from({ length: SPARKS }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), age: 1, life: 1 }));
  let nextSpark = 0;
  let spawn = 0;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);

  const update = (tech: TechBrain, t: number, dt: number) => {
    const g = tech.gull;

    // route dots, only on the way to a repair (not on the way back to the desk): the whole walk
    // ahead, through the entrance's doors and on to the repair
    let n = 0;
    if ((tech.phase === 'walking' || tech.phase === 'doors') && tech.job) {
      let from = { x: g.x, z: g.z };
      let at = DOT_GAP * 0.8; // how far along the current leg the next dot goes
      for (const to of tech.plan) {
        const dx = to.x - from.x;
        const dz = to.z - from.z;
        const len = Math.hypot(dx, dz);
        for (; at <= len && n < MAX_DOTS; at += DOT_GAP) {
          const k = at / len;
          dots.setMatrixAt(n++, m.makeTranslation(from.x + dx * k, 0.014, from.z + dz * k));
        }
        at -= len;
        from = to;
      }
    }
    dots.count = n;
    dots.instanceMatrix.needsUpdate = true;

    const working = tech.phase === 'working';
    track.visible = fill.visible = working;
    if (working) {
      track.position.set(g.x, 0.016, g.z);
      fill.position.set(g.x, 0.017, g.z);
      fill.geometry.setDrawRange(0, 6 * Math.round(RING_SEGMENTS * tech.progress));
    }

    // a spark every few hundredths of a second while it works: off the face to either side of
    // the gull (not into its face), up, and a little outward
    spawn -= dt;
    if (working && tech.spot && spawn <= 0) {
      spawn = 0.035 + 0.05 * Math.abs(Math.sin(t * 13.7));
      const [wx, wy, wz] = tech.spot.work;
      const ol = Math.hypot(g.x - wx, g.z - wz) || 1;
      const ox = (g.x - wx) / ol;
      const oz = (g.z - wz) / ol;
      const side = Math.sin(t * 23.3) > 0 ? 1 : -1;
      const across = side * (0.7 + 0.5 * Math.abs(Math.sin(t * 17.9)));
      const s = pool[nextSpark];
      nextSpark = (nextSpark + 1) % SPARKS;
      s.p.set(wx + ox * 0.03, wy + 0.1 * Math.sin(t * 7.1), wz + oz * 0.03);
      s.v.set(ox * 0.3 - oz * across, 1.0 + 0.6 * Math.abs(Math.sin(t * 5.3)), oz * 0.3 + ox * across);
      s.age = 0;
      s.life = 0.35 + 0.25 * Math.abs(Math.sin(t * 9.1));
    }
    pool.forEach((s, j) => {
      if (s.age >= s.life) {
        sparks.setMatrixAt(j, zero);
        return;
      }
      s.age += dt;
      s.v.y -= 6 * dt;
      s.p.addScaledVector(s.v, dt);
      sparks.setMatrixAt(j, m.compose(s.p, q.identity(), sc.setScalar(Math.max(0, 1 - s.age / s.life))));
    });
    sparks.instanceMatrix.needsUpdate = true;
  };

  return {
    group,
    update,
    dispose: () => {
      for (const d of disposables) d.dispose();
    },
  };
}

const center = new THREE.Vector3();

export function Tech({ layout, doors }: { layout: Record<string, PartBox>; doors: Airlock }) {
  const site = useStore((s) => s.site);
  const camera = useThree((s) => s.camera);
  const office = useMemo(() => buildOffice(doors), [doors]);
  const crew = useMemo(() => {
    const c = buildCrew([{ route: [{ x: office.desk.x, z: office.desk.z }], speed: 0, start: 0 }], { hat: true });
    c.gulls[0].yaw = office.desk.face;
    c.gulls[0].walk = 0;
    return c;
  }, [office]);
  const fx = useMemo(buildFx, []);
  // A new hall (live mode's first sync) gets a new floor grid and a fresh tech, which starts at its
  // desk again (the gull itself carries on from where it is, so it walks back if it was out).
  const tech = useMemo(() => {
    const cache = new Map<string, Spot[]>();
    return createTech({
      grid: buildHallGrid(site, layout),
      office,
      gull: crew.gulls[0],
      spots: (r: Repair) => {
        const k = `${r.kind}:${r.id}`;
        let s = cache.get(k);
        if (!s) cache.set(k, (s = spotsFor(site, layout, r)));
        return s;
      },
      repair: (r) => useStore.getState().repair(r),
    });
  }, [site, layout, crew, office]);

  useEffect(() => {
    camera.layers.enable(STAFF_LAYER);
  }, [camera]);
  useEffect(
    () => () => {
      crew.dispose();
      fx.dispose();
    },
    [crew, fx],
  );

  useFrame(({ clock, camera: cam, controls }, delta) => {
    const dt = Math.min(delta, 0.05);
    const t = clock.elapsedTime;
    const s = useStore.getState();
    tech.update(dt, t, s.tech, s.world);
    // Like the crew it steps out of a close shot it would block, but not while it works on the subject.
    const ctl = controls as Parameters<typeof inForeground>[1];
    const busy = tech.phase === 'working' || tech.phase === 'turning';
    crew.pose(t, dt, busy ? undefined : (x, z) => inForeground(cam, ctl, center.set(x, 0.6, z), 0.4));
    fx.update(tech, t, dt);
  });

  return (
    <>
      <primitive object={crew.group} />
      <primitive object={fx.group} />
    </>
  );
}
