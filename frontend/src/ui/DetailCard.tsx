import type { ReactNode } from 'react';
import { useStore } from '../store';
import { label, partTypeName } from '../mock/site';
import type { PartState, Selection } from '../model/types';
import { VERDICT, clock, marginText, marginTone, ownerText, stateText, stateTone, type Tone } from './format';
import { IconAlert, IconBolt, IconClose, IconCpu, IconNetwork, IconServer, IconSnow } from './Icons';

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`pill tone-text-${tone}`}>
      <span className={`dot tone-${tone}`} />
      {children}
    </span>
  );
}

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="dc-section">
      <div className="dc-section-head">
        <span>{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function PartChip({ id }: { id: string }) {
  const state = useStore((s) => s.world.partState[id]) as PartState;
  const select = useStore((s) => s.select);
  return (
    <button className="chip" onClick={() => select({ kind: 'part', id })} title={`${label(id)} · ${stateText(state)}`}>
      <span className={`dot tone-${stateTone(state)}`} />
      {label(id)}
    </button>
  );
}

function Chain({ name, icon, chain }: { name: string; icon: ReactNode; chain: string[] }) {
  return (
    <div className="chain">
      <span className="chain-name">
        {icon}
        {name}
      </span>
      <span className="chain-parts">
        {chain.map((p, i) => (
          <span key={p} className="chain-step">
            {i > 0 && <span className="chain-arrow">›</span>}
            <PartChip id={p} />
          </span>
        ))}
      </span>
    </div>
  );
}

function Callout({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <div className={`callout callout-${tone}`}>
      <IconAlert />
      <span>{children}</span>
    </div>
  );
}

function LastDecision({ match }: { match: (s: Selection) => boolean }) {
  const events = useStore((s) => s.events);
  const e = events.find((ev) => ev.focus.kind !== 'overview' && ev.focus.kind !== 'racks' && match(ev.focus as Selection));
  if (!e) return null;
  const v = VERDICT[e.verdict];
  return (
    <Section title="Latest decision" right={<span className="dc-time">{clock(e.time)}</span>}>
      <div className="decision">
        <div className="decision-top">
          <span className="decision-title">{e.title}</span>
          <Pill tone={v.tone}>{v.text}</Pill>
        </div>
        <p>{e.reason}</p>
      </div>
    </Section>
  );
}

function RackBody({ id }: { id: string }) {
  const site = useStore((s) => s.site);
  const world = useStore((s) => s.world);
  const select = useStore((s) => s.select);
  const r = site.racks[id];
  const m = world.margins[id];
  const lease = world.leases.find((l) => l.type === 'protection' && world.now < l.end && l.racks?.includes(id));
  const atRisk = new Set(world.diagnosis?.atRisk ?? []);
  const placed = new Set(world.placement?.nodes ?? []);
  const owners = new Map<string, number>();
  for (const n of r.nodes) {
    const t = ownerText(world.owner[n]);
    owners.set(t, (owners.get(t) ?? 0) + 1);
  }
  const single = m.unprotected.find((p) => site.parts[p].type === 'cdu' || site.parts[p].type === 'pdu');

  return (
    <>
      <div className="dc-status">
        <Pill tone={marginTone(m.level)}>{marginText(m.level)}</Pill>
        {lease && <span className="pill tone-text-blue">Protected</span>}
      </div>
      {single && (
        <Callout tone="amber">
          {label(single)} is this rack's only working {site.parts[single].type === 'cdu' ? 'cooling' : 'power'} feed.
        </Callout>
      )}
      <div className="dc-stats">
        <div>
          <span>Power feeds working</span>
          <strong>{m.power + 1} / 2</strong>
        </div>
        <div>
          <span>Cooling feeds working</span>
          <strong>{m.cooling + 1} / 2</strong>
        </div>
      </div>
      <Section title="Nodes">
        <div className="node-grid">
          {[...r.nodes].reverse().map((n) => {
            const st = world.nodeState[n];
            const o = world.owner[n];
            const cls =
              st === 'failed'
                ? 'n-red'
                : atRisk.has(n)
                  ? 'n-amber'
                  : placed.has(n)
                    ? 'n-teal'
                    : o.kind === 'job'
                      ? 'n-job'
                      : o.kind === 'tenant'
                      ? 'n-tenant'
                      : 'n-free';
            return (
              <button key={n} className={`node-cell ${cls}`} onClick={() => select({ kind: 'node', id: n })}>
                <span>{n.replace('node-', '')}</span>
              </button>
            );
          })}
        </div>
        <div className="dc-owners">
          {[...owners.entries()].map(([k, v]) => (
            <span key={k}>
              {k} <strong>{v}</strong>
            </span>
          ))}
        </div>
      </Section>
      <Section title="Feeds">
        <Chain name="Power A" icon={<IconBolt />} chain={r.powerFeeds[0]} />
        <Chain name="Power B" icon={<IconBolt />} chain={r.powerFeeds[1]} />
        <Chain name="Cooling" icon={<IconSnow />} chain={r.coolingFeeds[0]} />
        <Chain name="Backup" icon={<IconSnow />} chain={r.coolingFeeds[1]} />
        <Chain name="Network" icon={<IconNetwork />} chain={r.network} />
      </Section>
      <Section title="Leases">
        {lease ? (
          <p className="dc-text">
            Protection lease for <strong>{lease.job}</strong> by {lease.actor}, until {clock(lease.end)}. Maintenance that would
            remove this rack's backup is refused.
          </p>
        ) : (
          <p className="dc-text muted">No lease on this rack.</p>
        )}
      </Section>
      <LastDecision match={(s) => s.kind === 'rack' && s.id === id} />
    </>
  );
}

function NodeBody({ id }: { id: string }) {
  const site = useStore((s) => s.site);
  const world = useStore((s) => s.world);
  const select = useStore((s) => s.select);
  const info = site.nodes[id];
  const r = site.racks[info.rack];
  const st = world.nodeState[id];
  const o = world.owner[id];
  const d = world.diagnosis;
  const isAtRisk = d?.atRisk.includes(id);
  const isPlaced = !!world.placement?.nodes.includes(id);

  let role: { tone: Tone; text: string };
  if (st === 'failed') role = { tone: 'red', text: 'Failed' };
  else if (isAtRisk) role = { tone: 'amber', text: 'At risk' };
  else if (isPlaced) role = { tone: 'teal', text: 'Safe restart node' };
  else if (o.kind === 'job') role = { tone: 'blue', text: `Running ${o.id}` };
  else if (o.kind === 'tenant') role = { tone: 'muted', text: o.id };
  else role = { tone: 'muted', text: 'Free spare' };

  return (
    <>
      <div className="dc-status">
        <Pill tone={role.tone}>{role.text}</Pill>
        <Pill tone={stateTone(st)}>{stateText(st)}</Pill>
      </div>
      {d && (d.node === id || isAtRisk) && (
        <Callout tone="amber">
          {d.node === id ? d.reason : `Shares ${label(d.cause ?? '')} with ${d.node}. Moved out of the job before it fails.`}
        </Callout>
      )}
      <div className="dc-stats">
        <div>
          <span>Rack</span>
          <button className="link" onClick={() => select({ kind: 'rack', id: r.id })}>
            {r.id}
          </button>
        </div>
        <div>
          <span>Assigned to</span>
          <strong>{ownerText(o)}</strong>
        </div>
      </div>
      <Section title="Depends on">
        <Chain name="Power A" icon={<IconBolt />} chain={r.powerFeeds[0]} />
        <Chain name="Power B" icon={<IconBolt />} chain={r.powerFeeds[1]} />
        <Chain name="Cooling" icon={<IconSnow />} chain={r.coolingFeeds[0]} />
        <Chain name="Backup" icon={<IconSnow />} chain={r.coolingFeeds[1]} />
        <Chain name="Network" icon={<IconNetwork />} chain={r.network} />
      </Section>
      <LastDecision match={(s) => s.kind === 'node' && s.id === id} />
    </>
  );
}

function PartBody({ id }: { id: string }) {
  const site = useStore((s) => s.site);
  const world = useStore((s) => s.world);
  const select = useStore((s) => s.select);
  const st = world.partState[id];
  const down = site.downstream[id];
  const yellowBecause = down.filter((rid) => world.margins[rid].unprotected.includes(id));
  const counts = { green: 0, yellow: 0, red: 0 };
  for (const rid of down) counts[world.margins[rid].level]++;
  const d = world.diagnosis;
  const leases = world.leases.filter((l) => l.target === id && world.now < l.end);
  const shown = down.slice(0, 30);

  return (
    <>
      <div className="dc-status">
        <Pill tone={stateTone(st)}>{stateText(st)}</Pill>
        {yellowBecause.length > 0 && <Pill tone="amber">Only working feed</Pill>}
      </div>
      {d?.cause === id && <Callout tone="amber">{`${d.reason} Send a ${d.send}.`}</Callout>}
      {yellowBecause.length > 0 && d?.cause !== id && (
        <Callout tone="amber">
          Only working feed for {yellowBecause.length} racks. Taking it offline would leave them with no working feed.
        </Callout>
      )}
      <div className="dc-stats three">
        <div>
          <span>Racks below</span>
          <strong>{down.length}</strong>
        </div>
        <div>
          <span>Full backup</span>
          <strong className="tone-text-green">{counts.green}</strong>
        </div>
        <div>
          <span>One from outage</span>
          <strong className={counts.yellow ? 'tone-text-amber' : ''}>{counts.yellow + counts.red}</strong>
        </div>
      </div>
      <Section title="Feeds these racks" right={down.length > shown.length ? <span className="dc-time">+{down.length - shown.length} more</span> : null}>
        <div className="chip-wrap">
          {shown.map((rid) => (
            <button key={rid} className="chip" onClick={() => select({ kind: 'rack', id: rid })}>
              <span className={`dot tone-${marginTone(world.margins[rid].level)}`} />
              {rid.replace('rack-', '')}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Leases">
        {leases.length ? (
          leases.map((l) => (
            <p key={l.id} className="dc-text">
              Maintenance by {l.actor}, {clock(l.start)}–{clock(l.end)}
            </p>
          ))
        ) : (
          <p className="dc-text muted">No maintenance booked.</p>
        )}
      </Section>
      <LastDecision match={(s) => s.kind === 'part' && s.id === id} />
    </>
  );
}

export function DetailCard() {
  const selection = useStore((s) => s.selection);
  const site = useStore((s) => s.site);
  const select = useStore((s) => s.select);
  if (!selection) return null;

  let title = '';
  let sub = '';
  let icon: ReactNode = null;
  let tone = 'it-blue';
  if (selection.kind === 'rack') {
    const r = site.racks[selection.id];
    title = r.id;
    sub = `Rack · Row ${r.row}, position ${r.pos}`;
    icon = <IconServer />;
  } else if (selection.kind === 'node') {
    const n = site.nodes[selection.id];
    title = n.id;
    sub = `Node · ${n.rack}, slot ${n.slot + 1}`;
    icon = <IconCpu />;
    tone = 'it-purple';
  } else {
    const p = site.parts[selection.id];
    title = label(p.id);
    sub = `${partTypeName(p.type)} · ${p.id}`;
    const cooling = p.type === 'cdu' || p.type === 'chiller';
    const net = p.type === 'leaf' || p.type === 'spine';
    icon = cooling ? <IconSnow /> : net ? <IconNetwork /> : <IconBolt />;
    tone = cooling ? 'it-teal' : net ? 'it-purple' : 'it-amber';
  }

  return (
    <aside className="panel detail" key={`${selection.kind}-${selection.id}`}>
      <header className="dc-head">
        <span className={`icon-tile ${tone}`}>{icon}</span>
        <div className="dc-titles">
          <h3>{title}</h3>
          <span>{sub}</span>
        </div>
        <button className="btn icon ghost" onClick={() => select(null)} title="Close">
          <IconClose />
        </button>
      </header>
      <div className="dc-scroll">
        {selection.kind === 'rack' && <RackBody id={selection.id} />}
        {selection.kind === 'node' && <NodeBody id={selection.id} />}
        {selection.kind === 'part' && <PartBody id={selection.id} />}
      </div>
    </aside>
  );
}
