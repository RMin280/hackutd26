import { useStore } from '../store';
import { VERDICT, actorName, clock, modelOf } from './format';
import { IconChevron } from './Icons';

// A log, so it reads like one: time in its own column, the decision, who made it and the verdict, then the reason.
export function DecisionFeed() {
  const events = useStore((s) => s.events);
  const focus = useStore((s) => s.focus);
  const open = useStore((s) => s.panels.feed);
  const toggle = useStore((s) => s.togglePanel);

  if (!open) {
    return (
      <aside className="feed rail">
        <button className="icon-btn" onClick={() => toggle('feed')} title="Show decisions" aria-label="Show decisions">
          <IconChevron dir="left" />
        </button>
        <span className="rail-label">Decisions</span>
        <span className="rail-meta">{events.length}</span>
      </aside>
    );
  }

  return (
    <section className="feed">
      <header className="panel-head">
        <h2 className="eyebrow">
          Decisions <span className="count">{events.length}</span>
        </h2>
        <button className="icon-btn" onClick={() => toggle('feed')} title="Hide decisions" aria-label="Hide decisions">
          <IconChevron dir="right" />
        </button>
      </header>
      {events.length === 0 ? (
        <p className="empty">
          Every request, diagnosis and placement lands here with its verdict and the reason behind it. Press Space to start the scenario.
        </p>
      ) : (
        <ol className="feed-list">
          {events.map((e) => {
            const v = VERDICT[e.verdict];
            return (
              <li key={e.seq}>
                <button className="feed-row" onClick={() => focus(e.focus)}>
                  <span className="feed-time">{clock(e.time)}</span>
                  <span className="feed-main">
                    <span className="feed-title">{e.title}</span>
                    <span className="feed-meta">
                      {actorName(e.actor)}
                      {e.type === 'agent_plan' && modelOf(e) && <span className="feed-model">{modelOf(e)}</span>}
                      <span className={`verdict tone-${v.tone}`}>{v.text}</span>
                    </span>
                    <span className="feed-reason">{e.reason}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
