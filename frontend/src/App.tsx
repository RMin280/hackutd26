import { useEffect } from 'react';
import { useStore, stepCount } from './store';
import { Hall } from './scene/Hall';
import { Sidebar } from './ui/Sidebar';
import { StatTiles } from './ui/StatTiles';
import { DecisionFeed } from './ui/DecisionFeed';
import { DetailCard } from './ui/DetailCard';
import { clock } from './ui/format';
import { IconCalendar, IconShield, IconTarget } from './ui/Icons';

const AUTOPLAY_MS = 4200;

function Tooltip() {
  const hover = useStore((s) => s.hover);
  if (!hover) return null;
  return (
    <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
      <div className="tooltip-title">{hover.label}</div>
      {hover.sub && <div className="tooltip-sub">{hover.sub}</div>}
    </div>
  );
}

function Caption() {
  const caption = useStore((s) => s.caption);
  const stepIndex = useStore((s) => s.stepIndex);
  const mode = useStore((s) => s.mode);
  const total = stepCount(mode);
  return (
    <div className="panel caption" key={`${mode}-${stepIndex}`}>
      <div className="caption-head">
        <span className={`caption-mode ${mode}`}>
          {mode === 'blast_radius' ? (
            <>
              <IconShield /> Blast Radius
            </>
          ) : (
            'Naive scheduler'
          )}
        </span>
        <span className="caption-step">{stepIndex < 0 ? 'Ready' : `Step ${stepIndex + 1} of ${total}`}</span>
      </div>
      <p>{caption}</p>
    </div>
  );
}

function ViewControls() {
  const overview = useStore((s) => s.overview);
  return (
    <>
      <button className="panel view-btn" onClick={overview} title="Back to overview (Esc)">
        <IconTarget /> Overview
      </button>
      <div className="nav-hint">
        <span><kbd>Drag</kbd> pan</span>
        <span><kbd>Right-drag</kbd> rotate</span>
        <span><kbd>Scroll</kbd> zoom</span>
        <span><kbd>WASD</kbd> move</span>
      </div>
    </>
  );
}

function useKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Space/Enter belong to the presenter shortcuts, not to whichever button was clicked last.
      if (t?.tagName === 'BUTTON' && (e.code === 'Space' || e.key === 'Enter')) t.blur();
      const s = useStore.getState();
      if (e.code === 'Space' || e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        s.setPlaying(false);
        s.next();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        s.setPlaying(false);
        s.prev();
      } else if (e.key === 'Escape') {
        if (s.selection) s.select(null);
        else s.overview();
      } else if (e.key === 'r' || e.key === 'R') {
        s.reset();
      } else if (e.key === 'p' || e.key === 'P') {
        s.setPlaying(!s.playing);
      } else if (e.key === '1') {
        s.setMode('naive');
      } else if (e.key === '2') {
        s.setMode('blast_radius');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function useAutoplay() {
  const playing = useStore((s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    useStore.getState().next();
    const id = window.setInterval(() => useStore.getState().next(), AUTOPLAY_MS);
    return () => window.clearInterval(id);
  }, [playing]);
}

export default function App() {
  useKeys();
  useAutoplay();
  const now = useStore((s) => s.world.now);
  const stepIndex = useStore((s) => s.stepIndex);

  return (
    <div className="app">
      <Hall />
      <div className="hud">
        <Sidebar />
        <header className="topbar">
          <div className="title">
            <h1>Overview</h1>
            <p>Hall A · 160 racks · 1,280 nodes · every action checked before it happens</p>
          </div>
          <div className="panel clock-pill">
            <IconCalendar />
            <span>{stepIndex < 0 ? 'T+0m' : clock(now)}</span>
            <span className="clock-sep" />
            <span className="muted">Simulated time</span>
          </div>
        </header>
        <StatTiles />
        <div className="scene-frame">
          <ViewControls />
        </div>
        <div className="bottombar">
          <Caption />
        </div>
        <div className="rightcol">
          <DecisionFeed />
          <DetailCard />
        </div>
      </div>
      <Tooltip />
    </div>
  );
}
