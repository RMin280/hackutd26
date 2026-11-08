import { useEffect } from 'react';
import { useStore, stepCount } from './store';
import { Hall } from './scene/Hall';
import { scenarioOf } from './mock/scenario';
import { Sidebar } from './ui/Sidebar';
import { StatTiles } from './ui/StatTiles';
import { DecisionFeed } from './ui/DecisionFeed';
import { DetailCard } from './ui/DetailCard';
import { clock } from './ui/format';
import { liveEnabled } from './live/config';
import { IconChevron, IconTarget } from './ui/Icons';

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

function TopBar() {
  const now = useStore((s) => s.world.now);
  const stepIndex = useStore((s) => s.stepIndex);
  const metricsOpen = useStore((s) => s.panels.metrics);
  const toggle = useStore((s) => s.togglePanel);
  return (
    <header className="topbar">
      <p className="context">
        <span className="context-strong">Hall A</span>160 racks · 1,280 nodes
      </p>
      <div className="topbar-end">
        <p className="sim-clock">
          {/* Live: the backend's clock, which agents and the presenter move outside the steps too. */}
          <span className="sim-clock-value">{stepIndex < 0 && !liveEnabled ? 'T+0m' : clock(now)}</span>simulated
        </p>
        <button
          className="icon-btn"
          onClick={() => toggle('metrics')}
          title={metricsOpen ? 'Hide metrics' : 'Show metrics'}
          aria-label={metricsOpen ? 'Hide metrics' : 'Show metrics'}
          aria-expanded={metricsOpen}
        >
          <IconChevron dir={metricsOpen ? 'up' : 'down'} />
        </button>
      </div>
    </header>
  );
}

function Caption() {
  const caption = useStore((s) => s.caption);
  const stepIndex = useStore((s) => s.stepIndex);
  const mode = useStore((s) => s.mode);
  const open = useStore((s) => s.panels.caption);
  const toggle = useStore((s) => s.togglePanel);
  const total = stepCount(mode);
  return (
    <div className={`caption ${open ? '' : 'caption-closed'}`}>
      <div className="caption-head">
        <span className={`caption-mode tone-${mode === 'naive' ? 'red' : 'azure'}`}>
          {mode === 'naive' ? 'Naive scheduler' : mode === 'squawk' ? 'Squawk' : scenarioOf(mode).name}
        </span>
        <span className="caption-step">{stepIndex < 0 ? 'Ready' : `Step ${stepIndex + 1} of ${total}`}</span>
        <button
          className="icon-btn"
          onClick={() => toggle('caption')}
          title={open ? 'Hide narration' : 'Show narration'}
          aria-label={open ? 'Hide narration' : 'Show narration'}
          aria-expanded={open}
        >
          <IconChevron dir={open ? 'down' : 'up'} />
        </button>
      </div>
      {open && (
        <p className="caption-text" key={`${mode}-${stepIndex}`}>
          {caption}
        </p>
      )}
    </div>
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
        s.setMode('squawk');
      } else if (e.key === 't' || e.key === 'T') {
        s.toggleTech();
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
  const panels = useStore((s) => s.panels);
  const hasSelection = useStore((s) => s.selection !== null);
  const overview = useStore((s) => s.overview);
  // The right column stays open while a card is showing, even if the feed is collapsed.
  const rightOpen = panels.feed || hasSelection;

  return (
    <div className="app">
      <Hall />
      <div className={`hud${panels.sidebar ? '' : ' left-closed'}${rightOpen ? '' : ' right-closed'}`}>
        <Sidebar />
        <div className="top">
          <TopBar />
          {panels.metrics && <StatTiles />}
        </div>
        <div className="scene-frame">
          <button className="view-btn" onClick={overview} title="Back to overview (Esc)">
            <IconTarget />
            Overview
          </button>
          <p className="nav-hint">Drag to pan · Right-drag to rotate · Scroll to zoom · WASD to move</p>
        </div>
        <Caption />
        <div className="rightcol">
          <DecisionFeed />
          <DetailCard />
        </div>
      </div>
      <Tooltip />
    </div>
  );
}
