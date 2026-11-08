import { useStore, stepTitles } from '../store';
import { clock } from './format';
import { SCENARIOS, SCENARIO_LIST, scenarioOf } from '../mock/scenario';
import { liveEnabled } from '../live/config';
import { IconChevron, IconNext, IconPause, IconPlay, IconReset } from './Icons';

const LEGEND: { swatch: string; text: string }[] = [
  { swatch: 'rack-ok', text: 'Full backup' },
  { swatch: 'rack-warn', text: 'One failure from outage' },
  { swatch: 'rack-bad', text: 'No working feed' },
  { swatch: 'protected', text: 'Protected by lease' },
  { swatch: 'node-job', text: 'job-train-1 node' },
  { swatch: 'node-safe', text: 'Safe restart node' },
  { swatch: 'node-risk', text: 'At risk' },
  { swatch: 'node-failed', text: 'Failed' },
  { swatch: 'node-out', text: 'Out of service' },
  { swatch: 'aisle-hot', text: 'Hot aisle' },
  { swatch: 'aisle-cold', text: 'Cold aisle' },
];

function Transport({ compact }: { compact?: boolean }) {
  const stepIndex = useStore((s) => s.stepIndex);
  const mode = useStore((s) => s.mode);
  const playing = useStore((s) => s.playing);
  const setPlaying = useStore((s) => s.setPlaying);
  const next = useStore((s) => s.next);
  const reset = useStore((s) => s.reset);
  const done = stepIndex >= stepTitles(mode).length - 1;
  const play = () => {
    if (done) reset();
    setPlaying(!playing);
  };
  const label = playing ? 'Pause' : done ? 'Replay' : 'Play';

  return (
    <div className={compact ? 'transport transport-compact' : 'transport'}>
      {compact ? (
        <button className="icon-btn icon-btn-accent" onClick={play} title={`${label} (P)`} aria-label={label}>
          {playing ? <IconPause /> : <IconPlay />}
        </button>
      ) : (
        <button className="btn-primary" onClick={play} title={`${label} (P)`}>
          {playing ? <IconPause /> : <IconPlay />}
          {label}
        </button>
      )}
      <button className="icon-btn" onClick={next} disabled={done} title="Next step (Space)" aria-label="Next step">
        <IconNext />
      </button>
      <button className="icon-btn" onClick={reset} title="Reset (R)" aria-label="Reset">
        <IconReset />
      </button>
    </div>
  );
}

export function Sidebar() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const stepIndex = useStore((s) => s.stepIndex);
  const goTo = useStore((s) => s.goTo);
  const follow = useStore((s) => s.follow);
  const setFollow = useStore((s) => s.setFollow);
  const open = useStore((s) => s.panels.sidebar);
  const legendOpen = useStore((s) => s.panels.legend);
  const toggle = useStore((s) => s.togglePanel);

  const titles = stepTitles(mode);
  const steps = SCENARIOS[mode];
  const current = scenarioOf(mode);

  if (!open) {
    return (
      <aside className="sidebar rail">
        <button className="icon-btn" onClick={() => toggle('sidebar')} title="Show scenario panel" aria-label="Show scenario panel">
          <IconChevron dir="right" />
        </button>
        <Transport compact />
        <span className="rail-meta">
          {stepIndex < 0 ? '–' : stepIndex + 1}/{titles.length}
        </span>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <header className="side-head">
        <span className="wordmark">Squawk</span>
        <button className="icon-btn" onClick={() => toggle('sidebar')} title="Hide panel" aria-label="Hide scenario panel">
          <IconChevron dir="left" />
        </button>
      </header>

      <section className="side-section">
        <h2 className="eyebrow">Scenario</h2>
        <div className="scenario-pick" role="radiogroup" aria-label="Scenario">
          {SCENARIO_LIST.map((sc) => {
            const on = sc.id === current.id;
            const off = sc.liveOnly && !liveEnabled;
            return (
              <button
                key={sc.id}
                role="radio"
                aria-checked={on}
                className={on ? 'on' : ''}
                disabled={off}
                title={off ? 'Runs on the backend: start the view in live mode to play it' : sc.name}
                // switching scenario keeps the scheduler mode the presenter last chose
                onClick={() => !on && setMode(sc.modes.includes('squawk') ? 'squawk' : sc.modes[0])}
              >
                {sc.name}
                {off && <span className="scenario-pick-note">Live only</span>}
              </button>
            );
          })}
        </div>
        {current.modes.length > 1 && (
          <>
            <h2 className="eyebrow scheduler-head">Scheduler</h2>
            <div className="segmented" role="radiogroup" aria-label="Scheduler mode">
              <button role="radio" aria-checked={mode === 'naive'} className={mode === 'naive' ? 'on' : ''} onClick={() => setMode('naive')}>
                Naive
              </button>
              <button role="radio" aria-checked={mode === 'squawk'} className={mode === 'squawk' ? 'on' : ''} onClick={() => setMode('squawk')}>
                Squawk
              </button>
            </div>
          </>
        )}
      </section>

      <section className="side-section side-steps">
        <h2 className="eyebrow">Steps · {current.name}</h2>
        <ol className="steps">
          {titles.map((t, i) => (
            <li key={`${mode}-${i}`}>
              <button
                className={`step ${i === stepIndex ? 'current' : i < stepIndex ? 'past' : ''}`}
                aria-current={i === stepIndex ? 'step' : undefined}
                title={t}
                onClick={() => goTo(i)}
              >
                <span className="step-num">{String(i + 1).padStart(2, '0')}</span>
                <span className="step-title">{t}</span>
                <span className="step-time">{clock(steps[i].at)}</span>
              </button>
            </li>
          ))}
        </ol>
        <Transport />
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          <span className="check-box" aria-hidden />
          Camera follows events
        </label>
      </section>

      <section className="side-section side-legend">
        <button className="disclosure" onClick={() => toggle('legend')} aria-expanded={legendOpen}>
          <span className="eyebrow">Legend</span>
          <IconChevron dir={legendOpen ? 'up' : 'down'} />
        </button>
        {legendOpen && (
          <ul className="legend">
            {LEGEND.map((l) => (
              <li key={l.text}>
                <span className={`swatch swatch-${l.swatch}`} aria-hidden />
                {l.text}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="side-foot">Signed in as shift_lead · Hall A</footer>
    </aside>
  );
}
