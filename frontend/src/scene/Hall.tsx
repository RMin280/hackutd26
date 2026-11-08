import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { CameraControls, ContactShadows } from '@react-three/drei';
import CameraControlsImpl from 'camera-controls';
import * as THREE from 'three';
import { useStore } from '../store';
import { C } from '../theme';
import { HALL, buildPartLayout, type PartBox } from './layout';
import { resolveShot, shotFor, type Frame } from './camera';
import type { FocusTarget } from '../model/types';
import { Racks } from './Racks';
import { Parts } from './Parts';
import { Containment, Floor, FloorLabels } from './Floor';
import { FeedLines, ProtectedZones, SelectionOutline } from './Overlays';

const { ACTION } = CameraControlsImpl;

/** The part of the canvas not covered by HUD panels (the `.scene-frame` grid cell). */
function readFrame(canvas: HTMLCanvasElement): Frame {
  const c = canvas.getBoundingClientRect();
  const r = document.querySelector('.scene-frame')?.getBoundingClientRect();
  if (!r || r.width < 200 || r.height < 140) {
    return { left: 0, top: 0, right: c.width, bottom: c.height, width: c.width, height: c.height };
  }
  return {
    left: r.left - c.left,
    top: r.top - c.top,
    right: r.right - c.left,
    bottom: r.bottom - c.top,
    width: c.width,
    height: c.height,
  };
}

const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e']);

/**
 * Map-style camera: left-drag pans along the floor, right-drag rotates,
 * wheel zooms toward the cursor. WASD pans, Q/E rotate, Shift speeds up.
 * Focus requests from the store fly the camera with a smooth transition.
 */
function CameraRig({ layout }: { layout: Record<string, PartBox> }) {
  const ref = useRef<CameraControlsImpl>(null);
  const site = useStore((s) => s.site);
  const request = useStore((s) => s.camera);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const canvas = useThree((s) => s.gl.domElement);
  const keys = useRef(new Set<string>());
  const fast = useRef(false);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.mouseButtons.left = ACTION.SCREEN_PAN;
    c.mouseButtons.right = ACTION.ROTATE;
    c.mouseButtons.middle = ACTION.DOLLY;
    c.mouseButtons.wheel = ACTION.DOLLY;
    c.touches.one = ACTION.TOUCH_SCREEN_PAN;
    c.touches.two = ACTION.TOUCH_DOLLY_ROTATE;
    c.touches.three = ACTION.TOUCH_SCREEN_PAN;
    // The point the camera orbits stays over the hall.
    c.setBoundary(new THREE.Box3(new THREE.Vector3(HALL.x0 - 5, 0, HALL.z0 - 3), new THREE.Vector3(HALL.x1 + 3, 2.5, HALL.z1 + 3)));
  }, []);

  // Fly to each new focus request. Remember it, so a layout change can re-frame it.
  const userMoved = useRef(false);
  const current = useRef(request.target);
  const frameTarget = (target: FocusTarget, smooth: boolean) => {
    const c = ref.current;
    if (!c) return;
    const { pos, target: look } = resolveShot(shotFor(site, layout, target), camera, readFrame(canvas));
    void c.setLookAt(pos.x, pos.y, pos.z, look.x, look.y, look.z, smooth);
  };

  useEffect(() => {
    userMoved.current = false;
    current.current = request.target;
    frameTarget(request.target, request.seq > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, site, layout, camera, canvas]);

  // When panels open or close (or the window resizes) the free area changes: re-frame the
  // current shot, unless the user has since moved the camera themselves.
  const layoutKey = useStore((s) => `${s.panels.sidebar}${s.panels.feed || s.selection !== null}${s.panels.metrics}${s.panels.caption}`);
  useEffect(() => {
    let timer = 0;
    const refit = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!userMoved.current) frameTarget(current.current, true);
      }, 280); // after the grid transition settles
    };
    refit();
    window.addEventListener('resize', refit);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', refit);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  useEffect(() => {
    const c = ref.current;
    const moved = () => {
      userMoved.current = true;
    };
    c?.addEventListener('controlstart', moved);
    canvas.addEventListener('wheel', moved, { passive: true });
    return () => {
      c?.removeEventListener('controlstart', moved);
      canvas.removeEventListener('wheel', moved);
    };
  }, [canvas]);

  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (MOVE_KEYS.has(k)) keys.current.add(k);
      fast.current = e.shiftKey;
    };
    const up = (e: KeyboardEvent) => {
      keys.current.delete(e.key.toLowerCase());
      fast.current = e.shiftKey;
    };
    const clear = () => keys.current.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
    };
  }, []);

  useFrame((_, dt) => {
    const c = ref.current;
    const k = keys.current;
    if (!c || k.size === 0) return;
    userMoved.current = true;
    const step = Math.min(dt, 0.05);
    const speed = Math.max(c.distance, 4) * 0.9 * step * (fast.current ? 2.4 : 1);
    if (k.has('w')) void c.forward(speed, false);
    if (k.has('s')) void c.forward(-speed, false);
    if (k.has('a')) void c.truck(-speed, 0, false);
    if (k.has('d')) void c.truck(speed, 0, false);
    if (k.has('q')) void c.rotate(1.4 * step, 0, false);
    if (k.has('e')) void c.rotate(-1.4 * step, 0, false);
  });

  return (
    <CameraControls
      ref={ref}
      makeDefault
      smoothTime={0.6}
      draggingSmoothTime={0.08}
      minDistance={1.2}
      maxDistance={75}
      minPolarAngle={0.12}
      maxPolarAngle={1.32}
      dollyToCursor
      dollySpeed={0.7}
    />
  );
}

export function Hall() {
  const site = useStore((s) => s.site);
  const setHover = useStore((s) => s.setHover);
  const select = useStore((s) => s.select);
  const layout = useMemo(() => buildPartLayout(site), [site]);

  return (
    <Canvas
      className="hall-canvas"
      dpr={[1, 2]}
      camera={{ position: [16, 24, 30], fov: 38, near: 0.1, far: 240 }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onPointerLeave={() => setHover(null)}
      onPointerMissed={() => select(null)}
      onContextMenu={(e) => e.preventDefault()}
      onCreated={({ gl }) => {
        gl.toneMappingExposure = 1.2;
      }}
    >
      <color attach="background" args={[C.bg]} />
      <fog attach="fog" args={[C.bg, 55, 150]} />
      <hemisphereLight args={['#ffffff', '#0a0a0a', 1.05]} />
      <ambientLight intensity={0.28} />
      <directionalLight position={[10, 26, 18]} intensity={2.0} />
      <directionalLight position={[-16, 12, -14]} intensity={0.5} color="#c0d1f1" />

      <Floor />
      <ContactShadows
        frames={1}
        position={[HALL.cx - 1.5, 0.006, HALL.cz]}
        scale={[HALL.w + 9, HALL.d + 2]}
        resolution={1024}
        blur={2.2}
        far={2.4}
        opacity={0.42}
        color="#000000"
      />
      <Racks />
      <Parts layout={layout} />
      <Containment />
      <FloorLabels parts={layout} />
      <ProtectedZones />
      <SelectionOutline />
      <FeedLines layout={layout} />
      <CameraRig layout={layout} />
    </Canvas>
  );
}
