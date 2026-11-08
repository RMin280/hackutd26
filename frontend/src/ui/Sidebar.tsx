import { useStore, stepTitles } from '../store';
import { clock } from './format';
import { SCENARIOS } from '../mock/scenario';
import { IconLogo, IconMap, IconNext, IconPause, IconPlay, IconReset, IconShield } from './Icons';

const LEGEND: { swatch: string; text: string }[] = [
  { swatch: 'rack-ok', text: 'Full backup' },
  { swatch: 'rack-warn', text: 'One failure from outage' },
  { swatch: 'rack-bad', text: 'No working feed' },
  { swatch: 'zone-protected', text: 'Protected by lease' },
  { swatch: 'node-job', text: 'job-train-1 node' },
  { swatch: 'node-teal', text: 'Safe restart node' },
  { swatch: 'node-amber', text: 'At risk' },
  { swatch: 'node-red', text: 'Failed' },
  { swatch: 'aisle-hot', text: 'Hot aisle' },
  { swatch: 'aisle-cold', text: 'Cold aisle' },
];

export function Sidebar() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const stepIndex = useStore((s) => s.stepIndex);
  const playing = useStore((s) => s.playing);
  const setPlaying = useStore((s) => s.setPlaying);
  const next = useStore((s) => s.next);
  const reset = useStore((s) => s.reset);
  const goTo = useStore((s) => s.goTo);
  const follow = useStore((s) => s.follow);
  const setFollow = useStore((s) => s.setFollow);
  const overview = useStore((s) => s.overview);

  const titles = stepTitles(mode);
  const steps = SCENARIOS[mode];
  const done = stepIndex >= titles.length - 1;

  return (
    <aside className="panel sidebar">
      <div className="brand">
        <IconLogo />
        <span>Blast Radius</span>
      </div>

      <div className="side-section">
        <div className="side-label">Main menu</div>
        <button className="nav-item active" onClick={overview}>
          <IconMap />
          <span>Floor map</span>
          <span className="nav-meta">Hall A</span>
        </button>
      </div>

      <div className="side-section">
        <div className="side-label">Scheduler mode</div>
        <div className="segmented" role="tablist">
          <button className={mode === 'naive' ? 'on' : ''} onClick={() => setMode('naive')}>
            Naive
          </button>
          <button className={mode === 'blast_radius' ? 'on' : ''} onClick={() => setMode('blast_radius')}>
            <IconShield /> Blast Radius
          </button>
        </div>
      </div>

      <div className="side-section grow">
        <div className="side-label">Scenario · Big job failure</div>
        <div className="steps">
          {titles.map((t, i) => (
            <button
              key={`${mode}-${i}`}
              className={`step ${i === stepIndex ? 'current' : i < stepIndex ? 'past' : ''}`}
              onClick={() => goTo(i)}
            >
              <span className="step-num">{i + 1}</span>
              <span className="step-title">{t}</span>
              <span className="step-time">{clock(steps[i].at)}</span>
            </button>
          ))}
        </div>
        <div className="controls">
          <button
            className="btn primary"
            onClick={() => {
              if (done) reset();
              setPlaying(!playing);
            }}
            title="Play / pause (P)"
          >
            {playing ? <IconPause /> : <IconPlay />}
            {playing ? 'Pause' : done ? 'Replay' : 'Play'}
          </button>
          <button className="btn icon" onClick={next} disabled={done} title="Next step (Space)">
            <IconNext />
          </button>
          <button className="btn icon" onClick={reset} title="Reset (R)">
            <IconReset />
          </button>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          <span className="toggle-track" />
          <span>Camera follows events</span>
        </label>
      </div>

      <div className="side-section">
        <div className="side-label">Legend</div>
        <ul className="legend">
          {LEGEND.map((l) => (
            <li key={l.text}>
              <span className={`swatch ${l.swatch}`} />
              {l.text}
            </li>
          ))}
        </ul>
      </div>

      <div className="profile">
        <div className="avatar">SL</div>
        <div>
          <div className="profile-name">Control room</div>
          <div className="profile-sub">shift_lead · Hall A</div>
        </div>
      </div>
    </aside>
  );
}
