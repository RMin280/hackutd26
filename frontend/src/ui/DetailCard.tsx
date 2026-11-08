import type { ReactNode } from 'react';
import { useStore } from '../store';
import { label, partTypeName } from '../mock/site';
import type { PartState, Selection, Site } from '../model/types';
import { VERDICT, clock, marginText, marginTone, ownerText, stateText, stateTone, type Tone } from './format';
import { IconClose } from './Icons';

function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`status tone-${tone}`}>
      <span className="mark" aria-hidden />
      {children}
    </span>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="detail-section">
      <header className="detail-section-head">
        <h4 className="eyebrow">{title}</h4>
        {aside}
      </header>
      {children}
    </section>
  );
}

function Note({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <p className={`note tone-${tone}`}>{children}</p>;
}

function PartLink({ id }: { id: string }) {
  const state = useStore((s) => s.world.partState[id]) as PartState;
  const select = useStore((s) => s.select);
  const tone = stateTone(state);
  return (
    <button className={`part-link tone-${tone}`} onClick={() => select({ kind: 'part', id })} title={`${label(id)} · ${stateText(state)}`}>
      {tone !== 'ok' && <span className="mark" aria-hidden />}
      {label(id)}
    </button>
  );
}

function Chains({ rows }: { rows: { name: string; chain: string[] }[] }) {
  return (
    <dl className="chains">
      {rows.map(({ name, chain }) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>
            {chain.map((p, i) => (
              <span key={p} className="chain-step">
                {i > 0 && <span className="chain-arrow" aria-hidden>→</span>}
                <PartLink id={p} />
              </span>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function feedRows(site: Site, rackId: string) {
  const r = site.racks[rackId];
  return [
    { name: 'Power A', chain: r.powerFeeds[0] },
    { name: 'Power B', chain: r.powerFeeds[1] },
    { name: 'Cooling', chain: r.coolingFeeds[0] },
    { name: 'Backup', chain: r.coolingFeeds[1] },
    { name: 'Network', chain: r.network },
  ];
}

function LastDecision({ match }: { match: (s: Selection) => boolean }) {
  const events = useStore((s) => s.events);
  const e = events.find((ev) => ev.focus.kind !== 'overview' && ev.focus.kind !== 'racks' && match(ev.focus as Selection));
  if (!e) return null;
  const v = VERDICT[e.verdict];
  return (
    <Section title="Latest decision" aside={<span className="detail-aside">{clock(e.time)}</span>}>
      <p className="decision-title">
        {e.title} <span className={`verdict tone-${v.tone}`}>{v.text}</span>
      </p>
      <p className="decision-reason">{e.reason}</p>
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
      <div className="detail-status">
        <Status tone={marginTone(m.level)}>{marginText(m.level)}</Status>
        {lease && <Status tone="azure">Protected</Status>}
      </div>
      {single && (
        <Note tone="gold">
          {label(single)} is this rack's only working {site.parts[single].type === 'cdu' ? 'cooling' : 'power'} feed.
        </Note>
      )}
      <dl className="facts">
        <div>
          <dt>Power feeds</dt>
          <dd>{m.power + 1} of 2 working</dd>
        </div>
        <div>
          <dt>Cooling feeds</dt>
          <dd>{m.cooling + 1} of 2 working</dd>
        </div>
        <div>
          <dt>Running</dt>
          <dd>{[...owners.entries()].map(([k, v]) => `${k} ×${v}`).join(', ')}</dd>
        </div>
      </dl>
      <Section title="Nodes" aside={<span className="detail-aside">top to bottom</span>}>
        <div className="node-grid">
          {[...r.nodes].reverse().map((n) => {
            const st = world.nodeState[n];
            const o = world.owner[n];
            const cls =
              st === 'failed'
                ? 'n-failed'
                : atRisk.has(n)
                  ? 'n-risk'
                  : placed.has(n)
                    ? 'n-safe'
                    : o.kind === 'job'
                      ? 'n-job'
                      : o.kind === 'tenant'
                        ? 'n-tenant'
                        : 'n-free';
            return (
              <button key={n} className={`node-cell ${cls}`} onClick={() => select({ kind: 'node', id: n })} title={n}>
                {n.replace('node-', '')}
              </button>
            );
          })}
        </div>
      </Section>
      <Section title="Feeds">
        <Chains rows={feedRows(site, id)} />
      </Section>
      <Section title="Lease">
        {lease ? (
          <p className="detail-text">
            Protection lease for {lease.job}, held by {lease.actor} until {clock(lease.end)}. Maintenance that would remove this rack's backup is refused.
          </p>
        ) : (
          <p className="detail-text muted">No lease on this rack.</p>
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
  const st = world.nodeState[id];
  const o = world.owner[id];
  const d = world.diagnosis;
  const isAtRisk = d?.atRisk.includes(id);
  const isPlaced = !!world.placement?.nodes.includes(id);

  let role: { tone: Tone; text: string };
  if (st === 'failed') role = { tone: 'red', text: 'Failed' };
  else if (isAtRisk) role = { tone: 'gold', text: 'At risk' };
  else if (isPlaced) role = { tone: 'ice', text: 'Safe restart node' };
  else if (o.kind === 'job') role = { tone: 'ok', text: `Running ${o.id}` };
  else if (o.kind === 'tenant') role = { tone: 'muted', text: o.id };
  else role = { tone: 'muted', text: 'Free spare' };

  return (
    <>
      <div className="detail-status">
        <Status tone={role.tone}>{role.text}</Status>
      </div>
      {d && (d.node === id || isAtRisk) && (
        <Note tone="gold">{d.node === id ? d.reason : `Shares ${label(d.cause ?? '')} with ${d.node}. Moved out of the job before it fails.`}</Note>
      )}
      <dl className="facts">
        <div>
          <dt>Rack</dt>
          <dd>
            <button className="part-link" onClick={() => select({ kind: 'rack', id: info.rack })}>
              {info.rack}
            </button>
          </dd>
        </div>
        <div>
          <dt>Assigned to</dt>
          <dd>{ownerText(o)}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>{stateText(st)}</dd>
        </div>
      </dl>
      <Section title="Depends on">
        <Chains rows={feedRows(site, info.rack)} />
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
  const onlyFeedFor = down.filter((rid) => world.margins[rid].unprotected.includes(id));
  const counts = { green: 0, yellow: 0, red: 0 };
  for (const rid of down) counts[world.margins[rid].level]++;
  const d = world.diagnosis;
  const leases = world.leases.filter((l) => l.target === id && world.now < l.end);
  const shown = down.slice(0, 32);

  return (
    <>
      <div className="detail-status">
        <Status tone={stateTone(st)}>{stateText(st)}</Status>
        {onlyFeedFor.length > 0 && <Status tone="gold">Only working feed</Status>}
      </div>
      {/* The diagnosis itself shows under "Latest decision"; here only the unit's own risk. */}
      {onlyFeedFor.length > 0 && d?.cause !== id && (
        <Note tone="gold">Only working feed for {onlyFeedFor.length} racks. Taking it offline would leave them with none.</Note>
      )}
      <dl className="facts">
        <div>
          <dt>Racks below</dt>
          <dd>{down.length}</dd>
        </div>
        <div>
          <dt>At full backup</dt>
          <dd>{counts.green}</dd>
        </div>
        <div>
          <dt>Reduced backup</dt>
          <dd className={counts.yellow + counts.red ? 'tone-gold' : undefined}>{counts.yellow + counts.red}</dd>
        </div>
      </dl>
      <Section title="Feeds these racks" aside={down.length > shown.length ? <span className="detail-aside">+{down.length - shown.length} more</span> : undefined}>
        <div className="rack-list">
          {shown.map((rid) => {
            const tone = marginTone(world.margins[rid].level);
            return (
              <button key={rid} className={`part-link tone-${tone}`} onClick={() => select({ kind: 'rack', id: rid })}>
                {tone !== 'ok' && <span className="mark" aria-hidden />}
                {rid.replace('rack-', '')}
              </button>
            );
          })}
        </div>
      </Section>
      <Section title="Maintenance">
        {leases.length ? (
          leases.map((l) => (
            <p key={l.id} className="detail-text">
              Booked by {l.actor}, {clock(l.start)}–{clock(l.end)}
            </p>
          ))
        ) : (
          <p className="detail-text muted">Nothing booked.</p>
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

  let kind = '';
  let title = '';
  let sub = '';
  if (selection.kind === 'rack') {
    const r = site.racks[selection.id];
    kind = 'Rack';
    title = r.id;
    sub = `Row ${r.row}, position ${r.pos}`;
  } else if (selection.kind === 'node') {
    const n = site.nodes[selection.id];
    kind = 'Node';
    title = n.id;
    sub = `${n.rack}, slot ${n.slot + 1}`;
  } else {
    const p = site.parts[selection.id];
    kind = partTypeName(p.type);
    title = label(p.id);
    sub = p.id;
  }

  return (
    <aside className="detail" key={`${selection.kind}-${selection.id}`} aria-label={`${kind} ${title}`}>
      <header className="detail-head">
        <div>
          <div className="eyebrow">{kind}</div>
          <h3 className="detail-title">{title}</h3>
          <div className="detail-sub">{sub}</div>
        </div>
        <button className="icon-btn" onClick={() => select(null)} title="Close" aria-label="Close">
          <IconClose />
        </button>
      </header>
      <div className="detail-body">
        {selection.kind === 'rack' && <RackBody id={selection.id} />}
        {selection.kind === 'node' && <NodeBody id={selection.id} />}
        {selection.kind === 'part' && <PartBody id={selection.id} />}
      </div>
    </aside>
  );
}
