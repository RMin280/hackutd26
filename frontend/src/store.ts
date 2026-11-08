// App state. Today the scenario player below is the data source (mock backend).
// When the SpacetimeDB backend exists, replace `applyStep` with a subscription
// that writes the backend's world + events into the same fields; the scene and
// panels read only from here and hold no safety logic.

import { create } from 'zustand';
import type { DecisionEvent, FocusTarget, Selection, Site, World } from './model/types';
import { buildSite } from './mock/site';
import { INTRO_CAPTION, SCENARIOS, initialWorld, type Mode } from './mock/scenario';
import { repairWorld, type RepairTarget } from './mock/repair';

export interface Hover {
  label: string;
  sub?: string;
  x: number;
  y: number;
}

export type PanelName = 'sidebar' | 'feed' | 'metrics' | 'caption' | 'legend';

interface CameraRequest {
  seq: number;
  target: FocusTarget;
}

interface AppState {
  site: Site;
  mode: Mode;
  stepIndex: number; // -1 = before the first step
  world: World;
  events: DecisionEvent[];
  /** Feed rows up to this seq were already there when the view connected (live mode's first sync); 0 on the mock. */
  feedStart: number;
  caption: string;
  selection: Selection | null;
  hover: Hover | null;
  camera: CameraRequest;
  playing: boolean;
  follow: boolean;
  tech: boolean; // the tech gull on duty: walks to whatever is broken and repairs it (T)
  panels: Record<PanelName, boolean>; // true = open

  setMode: (m: Mode) => void;
  next: () => void;
  reset: () => void;
  goTo: (stepIndex: number) => void;
  prev: () => void;
  setPlaying: (p: boolean) => void;
  setFollow: (f: boolean) => void;
  select: (s: Selection | null) => void;
  focus: (t: FocusTarget) => void;
  overview: () => void;
  setHover: (h: Hover | null) => void;
  togglePanel: (p: PanelName) => void;
  toggleTech: () => void;
  /** Marks a failed or degraded node or part repaired. The mock does it here; live mode asks the backend. */
  repair: (target: RepairTarget) => void;
}

const site = buildSite();

export const useStore = create<AppState>((set, get) => ({
  site,
  mode: 'squawk',
  stepIndex: -1,
  world: initialWorld(site),
  events: [],
  feedStart: 0,
  caption: INTRO_CAPTION,
  selection: null,
  hover: null,
  camera: { seq: 0, target: { kind: 'overview' } },
  playing: false,
  follow: true,
  tech: false,
  panels: { sidebar: true, feed: true, metrics: true, caption: true, legend: true },

  setMode: (mode) => {
    set({ mode });
    get().reset();
  },

  reset: () =>
    set((s) => ({
      stepIndex: -1,
      world: initialWorld(s.site),
      events: [],
      caption: INTRO_CAPTION,
      selection: null,
      playing: false,
      camera: { seq: s.camera.seq + 1, target: { kind: 'overview' } },
    })),

  next: () => {
    const s = get();
    const steps = SCENARIOS[s.mode];
    const i = s.stepIndex + 1;
    if (i >= steps.length) {
      set({ playing: false });
      return;
    }
    const step = steps[i];
    const world: World = structuredClone(s.world);
    world.now = step.at;
    const newEvents: DecisionEvent[] = [];
    let seq = s.events.length;
    const result = step.run({
      site: s.site,
      world,
      emit: (e) => newEvents.push({ ...e, seq: ++seq, time: step.at }),
    });
    const patch: Partial<AppState> = {
      stepIndex: i,
      world,
      events: [...newEvents.reverse(), ...s.events],
      caption: result.caption,
    };
    if (s.follow && result.camera) {
      patch.selection = null;
      patch.camera = { seq: s.camera.seq + 1, target: result.camera };
    }
    if (i === steps.length - 1) patch.playing = false;
    set(patch);
  },

  goTo: (target) => {
    const follow = get().follow;
    get().reset();
    set({ follow: false });
    for (let i = 0; i < target; i++) get().next();
    set({ follow });
    get().next();
  },

  prev: () => {
    const i = get().stepIndex;
    if (i <= 0) get().reset();
    else get().goTo(i - 1);
  },

  setPlaying: (playing) => set({ playing }),
  setFollow: (follow) => set({ follow }),

  select: (selection) =>
    set((s) => ({
      selection,
      hover: selection ? null : s.hover,
      camera: selection ? { seq: s.camera.seq + 1, target: selection } : s.camera,
    })),

  focus: (target) =>
    set((s) => ({
      selection:
        target.kind === 'rack' || target.kind === 'node' || target.kind === 'part'
          ? { kind: target.kind, id: target.id }
          : null,
      camera: { seq: s.camera.seq + 1, target },
    })),

  overview: () => set((s) => ({ selection: null, camera: { seq: s.camera.seq + 1, target: { kind: 'overview' } } })),

  setHover: (hover) => set({ hover }),
  togglePanel: (p) => set((s) => ({ panels: { ...s.panels, [p]: !s.panels[p] } })),
  toggleTech: () => set((s) => ({ tech: !s.tech })),

  repair: (target) => {
    const s = get();
    const done = repairWorld(s.site, s.world, target);
    if (!done) return;
    set({ world: done.world, events: [{ ...done.event, seq: s.events.length + 1, time: done.world.now }, ...s.events] });
  },
}));

export const stepCount = (mode: Mode) => SCENARIOS[mode].length;
export const stepTitles = (mode: Mode) => SCENARIOS[mode].map((s) => s.title);
