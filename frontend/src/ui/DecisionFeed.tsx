import type { ReactNode } from 'react';
import type { ActorKind } from '../model/types';
import { useStore } from '../store';
import { VERDICT, clock } from './format';
import { IconBolt, IconCpu, IconShield, IconSnow } from './Icons';

const ACTOR_ICON: Record<ActorKind, { icon: ReactNode; tone: string }> = {
  facility: { icon: <IconBolt />, tone: 'it-amber' },
  scheduler: { icon: <IconCpu />, tone: 'it-purple' },
  cooling: { icon: <IconSnow />, tone: 'it-orange' },
  blast_radius: { icon: <IconShield />, tone: 'it-blue' },
};

export function DecisionFeed() {
  const events = useStore((s) => s.events);
  const focus = useStore((s) => s.focus);

  return (
    <section className="panel feed">
      <header className="card-head">
        <h2>Decision feed</h2>
        <span className="card-meta">{events.length} decisions</span>
      </header>
      {events.length === 0 ? (
        <div className="feed-empty">
          Every request, diagnosis and placement appears here with its verdict and reason.
          <span>
            Press <kbd>Space</kbd> to start the scenario.
          </span>
        </div>
      ) : (
        <ol className="feed-list">
          {events.map((e) => {
            const v = VERDICT[e.verdict];
            const a = ACTOR_ICON[e.actorKind];
            return (
              <li key={e.seq}>
                <button className="feed-row" onClick={() => focus(e.focus)}>
                  <span className={`icon-tile ${a.tone}`}>{a.icon}</span>
                  <span className="feed-body">
                    <span className="feed-top">
                      <span className="feed-title">{e.title}</span>
                      <span className="feed-time">{clock(e.time)}</span>
                    </span>
                    <span className="feed-actor">
                      {e.actor}
                      <span className={`status tone-text-${v.tone}`}>
                        <span className={`dot tone-${v.tone}`} />
                        {v.text}
                      </span>
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
