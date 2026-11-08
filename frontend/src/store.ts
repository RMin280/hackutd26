// App state. Today the scenario player below is the data source (mock backend).
// When the SpacetimeDB backend exists, replace `applyStep` with a subscription
// that writes the backend's world + events into the same fields; the scene and
// panels read only from here and hold no safety logic.

import { create } from 'zustand';
import type { DecisionEvent, FocusTarget, Selection, Site, World } from './model/types';
import { buildSite } from './mock/site';
import { INTRO_CAPTION, SCENARIOS, initialWorld, isLiveOnly, type Mode } from './mock/scenario';

/** Offline, a backend-only scenario has nothing to play. */
const LIVE_ONLY_CAPTION = 'This scenario runs on the backend: start the view in live mode (VITE_SPACETIMEDB_URI) to play it.';
import { repairWorld, type RepairTarget } from './mock/repair';

export interface Hover {
  label: string;
  sub?: string;
  x: number;
  y: number;
}

export type PanelName = 'sidebar' | 'feed' | 'metrics' | 'caption' | 'legend';

/** What fills the window: the 3D hall with its HUD, or the work board (what the floor sees). */
export type ViewName = 'hall' | 'board';

/** `?view=work` opens the board on its own, for a second screen: no hall is drawn. */
export const boardOnly = (() => {
  try {
    return new URLSearchParams(window.location.search).get('view') === 'work';
  } catch {
    return false;
  }
})();

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
  view: ViewName; // the hall, or the work board (B)
  boardFilter: string; // the board's trade filter: 'all' or a trade name
  boardSelection: string | null; // the work item open in the board's detail pane
  notice: string; // the work board's status line: a refusal from the backend, or why a button did nothing
  /** How the backend knows this screen: the control room is a shift lead, a stand-alone board a technician. */
  me: string;

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
  setView: (v: ViewName) => void;
  toggleView: () => void;
  setBoardFilter: (trade: string) => void;
  selectWork: (id: string | null) => void;
  setNotice: (text: string) => void;
  /** The work board's buttons. Bookkeeping on the backend (accept_work / complete_work); the mock has no work table. */
  acceptWork: (id: string) => void;
  completeWork: (id: string, note: string) => void;
  /** A busy shift's worth of work laid over the hall through the interlock (seed_shift), for the board. */
  seedShift: () => void;
}

const MOCK_BOARD_CAPTION = 'The work board acts on the backend: start the view in live mode (VITE_SPACETIMEDB_URI) to take work on or complete it.';

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
  view: boardOnly ? 'board' : 'hall',
  boardFilter: 'all',
  boardSelection: null,
  notice: '',
  me: boardOnly ? 'Floor tech' : 'Control room',

  setMode: (mode) => {
    set({ mode });
    get().reset();
  },

  reset: () =>
    set((s) => ({
      stepIndex: -1,
      world: initialWorld(s.site),
      events: [],
      caption: isLiveOnly(s.mode) ? LIVE_ONLY_CAPTION : INTRO_CAPTION,
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

  setView: (view) => set({ view }),
  toggleView: () => set((s) => ({ view: boardOnly ? 'board' : s.view === 'hall' ? 'board' : 'hall' })),
  setBoardFilter: (boardFilter) => set({ boardFilter }),
  selectWork: (boardSelection) => set({ boardSelection }),
  setNotice: (notice) => set({ notice }),
  acceptWork: () => set({ notice: MOCK_BOARD_CAPTION }),
  completeWork: () => set({ notice: MOCK_BOARD_CAPTION }),
  seedShift: () => set({ notice: MOCK_BOARD_CAPTION }),
}));

export const stepCount = (mode: Mode) => SCENARIOS[mode].length;
export const stepTitles = (mode: Mode) => SCENARIOS[mode].map((s) => s.title);
