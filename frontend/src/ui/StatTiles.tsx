import type { ReactNode } from 'react';
import { useStore } from '../store';
import { label } from '../mock/site';
import type { Tone } from './format';

// Four facts in one typographic row, divided by hairlines. No cards, no icons.
function Metric({ name, value, detail, tone }: { name: string; value: ReactNode; detail: ReactNode; tone: Tone }) {
  return (
    <div className="metric">
      <div className="eyebrow">{name}</div>
      <div className="metric-value">{value}</div>
      <div className={`metric-detail tone-${tone}`}>
        {tone !== 'ok' && tone !== 'muted' && <span className="mark" aria-hidden />}
        {detail}
      </div>
    </div>
  );
}

export function StatTiles() {
  const site = useStore((s) => s.site);
  const world = useStore((s) => s.world);
  const mode = useStore((s) => s.mode);

  const levels = { green: 0, yellow: 0, red: 0 };
  for (const rid of site.rackOrder) levels[world.margins[rid].level]++;
  const total = site.rackOrder.length;

  const job = world.job;
  const d = world.diagnosis;
  const activeLeases = world.leases.filter((l) => world.now < l.end);
  const protection = activeLeases.find((l) => l.type === 'protection');
  const naiveCrash = mode === 'naive' && job.crashes > 0;

  return (
    <div className="metrics">
      <Metric
        name="Racks at full backup"
        value={
          <>
            {levels.green}
            <span className="metric-of">/{total}</span>
          </>
        }
        detail={
          levels.red
            ? `${levels.red} with no working feed`
            : levels.yellow
              ? `${levels.yellow} one failure from an outage`
              : 'Every rack has a backup'
        }
        tone={levels.red ? 'red' : levels.yellow ? 'gold' : 'ok'}
      />
      <Metric
        name={job.id}
        value={job.status === 'running' ? 'Running' : job.status === 'finished' ? 'Finished' : 'Stopped'}
        detail={`${job.nodes.toLocaleString()} nodes · ${job.crashes} ${job.crashes === 1 ? 'crash' : 'crashes'} · ${job.restarts} ${job.restarts === 1 ? 'restart' : 'restarts'}`}
        tone={job.status === 'stopped' ? 'red' : job.crashes > 1 ? 'gold' : 'ok'}
      />
      <Metric
        name="Diagnosis"
        value={d ? (d.classification === 'shared_cause' ? 'Shared cause' : 'Isolated') : naiveCrash ? 'Not checked' : 'None'}
        detail={
          d ? `${label(d.cause ?? d.node)} · ${d.atRisk.length} nodes at risk` : naiveCrash ? 'Naive scheduler never asks why' : 'No failures to diagnose'
        }
        tone={d ? 'gold' : naiveCrash ? 'red' : 'muted'}
      />
      <Metric
        name="Leases"
        value={
          <>
            {activeLeases.length}
            <span className="metric-of"> active</span>
          </>
        }
        detail={
          world.deniedRequests
            ? `${world.deniedRequests} unsafe request denied`
            : protection
              ? `Protecting ${protection.racks?.length ?? 0} racks for 72 h`
              : 'No leases held'
        }
        tone={world.deniedRequests || protection ? 'azure' : 'muted'}
      />
    </div>
  );
}
