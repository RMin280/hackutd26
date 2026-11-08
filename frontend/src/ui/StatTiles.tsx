import type { ReactNode } from 'react';
import { useStore } from '../store';
import { label } from '../mock/site';
import { IconBriefcase, IconLock, IconServer, IconShield } from './Icons';
import type { Tone } from './format';

function Tile(props: { icon: ReactNode; iconTone: string; title: string; value: ReactNode; detail: ReactNode; detailTone: Tone }) {
  return (
    <div className="panel tile">
      <div className="tile-head">
        <span className={`icon-tile ${props.iconTone}`}>{props.icon}</span>
        <span className="tile-title">{props.title}</span>
      </div>
      <div className="tile-value">{props.value}</div>
      <div className="tile-detail">
        <span className={`dot tone-${props.detailTone}`} />
        <span className={`tone-text-${props.detailTone}`}>{props.detail}</span>
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

  return (
    <div className="tiles">
      <Tile
        icon={<IconServer />}
        iconTone="it-green"
        title="Racks at full backup"
        value={
          <>
            {levels.green}
            <span className="tile-of"> / {total}</span>
          </>
        }
        detail={
          levels.red
            ? `${levels.red} with no working feed`
            : levels.yellow
              ? `${levels.yellow} one failure from an outage`
              : 'Every rack has a backup'
        }
        detailTone={levels.red ? 'red' : levels.yellow ? 'amber' : 'green'}
      />
      <Tile
        icon={<IconBriefcase />}
        iconTone="it-blue"
        title={job.id}
        value={job.status === 'running' ? 'Running' : 'Stopped'}
        detail={`${job.nodes.toLocaleString()} nodes · ${job.crashes} ${job.crashes === 1 ? 'crash' : 'crashes'} · ${job.restarts} ${job.restarts === 1 ? 'restart' : 'restarts'}`}
        detailTone={job.status === 'running' ? (job.crashes > 1 ? 'amber' : 'green') : 'red'}
      />
      <Tile
        icon={<IconShield />}
        iconTone="it-amber"
        title="Diagnosis"
        value={d ? (d.classification === 'shared_cause' ? 'Shared cause' : 'Isolated') : mode === 'naive' && job.crashes ? 'Not checked' : 'None'}
        detail={
          d
            ? `${label(d.cause ?? d.node)} · ${d.atRisk.length} nodes at risk`
            : mode === 'naive' && job.crashes
              ? 'Naive scheduler never asks why'
              : 'No failures to diagnose'
        }
        detailTone={d ? 'amber' : mode === 'naive' && job.crashes ? 'red' : 'muted'}
      />
      <Tile
        icon={<IconLock />}
        iconTone="it-purple"
        title="Leases"
        value={
          <>
            {activeLeases.length}
            <span className="tile-of"> active</span>
          </>
        }
        detail={
          world.deniedRequests
            ? `${world.deniedRequests} unsafe request denied`
            : protection
              ? `Protecting ${protection.racks?.length ?? 0} racks for 72 h`
              : 'No leases held'
        }
        detailTone={world.deniedRequests ? 'red' : protection ? 'blue' : 'muted'}
      />
    </div>
  );
}
