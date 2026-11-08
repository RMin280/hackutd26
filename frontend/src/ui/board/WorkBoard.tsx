// The work board: what the floor sees. Every request the interlock has decided, as a list a
// worker reads in one glance, with the piece of work in hand open beside it: the backend's
// reason, the lock over its racks, who took it on, and the two actions. It renders what the
// backend decided and holds no safety logic; the buttons are bookkeeping reducers (accept_work,
// complete_work) and the backend may still say no.
//
// Layout: a trade rail on the left (the filter, with a glyph and a count per trade), the list in
// the middle, the detail or the context (locks, floor, agents) on the right. The same page is the
// control room's board (B over the hall) and a worker's screen (?view=work: no hall, no agents,
// your work first, the trade remembered).

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { liveEnabled } from '../../live/config';
import type { FocusTarget, Site, WorkItem } from '../../model/types';
import { boardOnly, useStore } from '../../store';
import { actorName, clock } from '../format';
import { IconBolt, IconBot, IconChevron, IconChip, IconClose, IconFan, IconGear, IconLock, IconNetwork, IconPerson, IconTarget } from '../Icons';
import { ViewTabs } from '../ViewTabs';
import {
  LANES,
  LANE_TITLE,
  TRADES,
  agentCards,
  groupWork,
  lockOn,
  locks,
  mockWorkItems,
  racksOf,
  tradeFor,
  type AgentCard,
  type AgentState,
  type Lane,
  type Level,
  type LockView,
} from './board';

const KIND_TITLE: Record<string, string> = {
  node_repair: 'Hardware repair',
  rack_work: 'Rack work',
  hot_aisle_work: 'Hot-aisle work',
  facility_work: 'Maintenance',
  switch_firmware: 'Switch firmware',
  sw_online: 'Online update',
  sw_exclusive: 'Drain-required update',
  protection: 'Protection',
};
const kindTitle = (item: WorkItem) => KIND_TITLE[item.kind] ?? item.kind;
const targetOf = (item: WorkItem) => item.targetLabel || item.target;

type Tone = 'azure' | 'gold' | 'red' | 'muted' | 'ok';

/** The status chip. A refusal is the interlock doing its job, so it speaks in azure like the feed. */
function statusChip(item: WorkItem, now: number): { text: string; tone: Tone } {
  switch (item.status) {
    case 'active':
      return { text: `Until ${clock(item.end)}`, tone: 'azure' };
    case 'granted':
      return { text: item.start > now ? `From ${clock(item.start)}` : 'Booked', tone: 'ok' };
    case 'needs_approval':
      return { text: 'Needs approval', tone: 'gold' };
    case 'denied':
      return { text: 'Denied', tone: 'azure' };
    case 'rejected':
      return { text: 'Rejected', tone: 'azure' };
    case 'done':
      return { text: item.completedBy ? 'Done' : 'Window ended', tone: 'muted' };
    case 'cancelled':
      return { text: 'Cancelled', tone: 'muted' };
    case 'expired':
      return { text: 'Expired', tone: 'muted' };
    default:
      return { text: 'Simulated', tone: 'muted' };
  }
}

const AGENT_STATE: Record<AgentState, { text: string; tone: Tone }> = {
  working: { text: 'Working', tone: 'azure' },
  waiting: { text: 'Waiting', tone: 'muted' },
  fixed: { text: 'Fixed', tone: 'azure' },
  handoff: { text: 'Handed off', tone: 'gold' },
  stopped: { text: 'Stopped · failed closed', tone: 'gold' },
  idle: { text: 'Idle', tone: 'muted' },
};

const AGENT_KIND: Record<AgentCard['kind'], string> = {
  fixer: 'Nemotron fixer',
  updater: 'Nemotron updater',
  scheduler: 'Scheduler agent',
  cooling: 'Cooling agent',
  facility: 'Facility',
  squawk: 'Squawk',
};

const TRADE_KEY = 'squawk:board:trade';
const readTrade = (): string | null => {
  try {
    return localStorage.getItem(TRADE_KEY);
  } catch {
    return null;
  }
};
const saveTrade = (trade: string) => {
  try {
    localStorage.setItem(TRADE_KEY, trade);
  } catch {
    // private window: the choice just won't survive a reload
  }
};

function focusOf(item: WorkItem): FocusTarget {
  const k = item.targetKind;
  if (k === 'node' || k === 'rack' || k === 'part') return { kind: k, id: item.target };
  return item.racks.length ? { kind: 'racks', ids: item.racks } : { kind: 'overview' };
}

// ---------------------------------------------------------------- glyphs: information before words

const TRADE_ICON: Record<string, () => ReactNode> = {
  'hardware tech': IconChip,
  'mechanical tech': IconFan,
  'electrical tech': IconBolt,
  'network engineer': IconNetwork,
  automation: IconGear,
};

function TradeGlyph({ trade, className = '' }: { trade: string; className?: string }) {
  const Icon = TRADE_ICON[trade] ?? IconChip;
  return (
    <span className={`glyph ${className}`} aria-hidden>
      <Icon />
    </span>
  );
}

/** Level as three bars: L1 ▮▯▯, L3 ▮▮▮. */
function LevelBars({ level }: { level: Level }) {
  const n = Number(level.slice(1));
  return (
    <span className="level-bars" role="img" aria-label={`level ${n} of 3`} title={`Level ${n} of 3`}>
      {[1, 2, 3].map((i) => (
        <i key={i} className={i <= n ? 'on' : ''} />
      ))}
    </span>
  );
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** How far through its window a lease is. */
function TimeBar({ start, end, now }: { start: number; end: number; now: number }) {
  const f = end > start ? clamp01((now - start) / (end - start)) : 1;
  return (
    <span className="time-bar" role="img" aria-label={`${Math.round(f * 100)} percent of the window elapsed`} title={`${clock(start)} → ${clock(end)}`}>
      <i style={{ width: `${f * 100}%` }} />
    </span>
  );
}

/** Where in the hall: the ten rows as bars, the rows this work touches lit; the central plant as a strip above. */
function RowMap({ item, site, tone = 'azure' }: { item: WorkItem; site: Site; tone?: 'azure' | 'gold' }) {
  const rows = new Set<number>();
  for (const r of racksOf(item, site)) {
    const row = site.racks[r]?.row;
    if (row) rows.add(row);
  }
  const part = item.targetKind === 'part' ? site.parts[item.target] : undefined;
  const plant = !!part && !part.row;
  const where = plant ? 'Central plant' : rows.size ? `Row${rows.size > 1 ? 's' : ''} ${[...rows].sort((a, b) => a - b).join(', ')}` : 'Hall';
  return (
    <svg className={`row-map tone-${tone}`} viewBox="0 0 64 40" role="img" aria-label={where}>
      <title>{where}</title>
      <rect x="2" y="2" width="60" height="4" className={plant ? 'lit' : ''} />
      {Array.from({ length: 10 }, (_, i) => {
        const row = i + 1;
        // rows pair up around a hot aisle: 1–2, 3–4, …
        const y = 9 + i * 3 + Math.floor(i / 2) * 0.5;
        return <rect key={row} x="2" y={y} width="60" height="2" className={rows.has(row) ? 'lit' : ''} />;
      })}
    </svg>
  );
}

// ---------------------------------------------------------------- the trade rail (the filter)

function TradeRail({ counts, filter, onPick }: { counts: Record<string, number>; filter: string; onPick: (trade: string) => void }) {
  return (
    <nav className="trade-rail" aria-label="Trade">
      <button className={`rail-item${filter === 'all' ? ' on' : ''}`} onClick={() => onPick('all')} aria-pressed={filter === 'all'}>
        <span className="glyph glyph-all" aria-hidden>
          <IconTarget />
        </span>
        <span className="trade-name">All work</span>
        <span className="trade-count">{counts.all ?? 0}</span>
      </button>
      {TRADES.map((t) => (
        <button key={t} className={`rail-item${filter === t ? ' on' : ''}`} onClick={() => onPick(t)} aria-pressed={filter === t}>
          <TradeGlyph trade={t} />
          <span className="trade-name">{t}</span>
          <span className="trade-count">{counts[t] ?? 0}</span>
        </button>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------- rows

function WorkRow({ item, lane, yours }: { item: WorkItem; lane: Lane; yours: boolean }) {
  const now = useStore((s) => s.world.now);
  const world = useStore((s) => s.world);
  const site = useStore((s) => s.site);
  const selected = useStore((s) => s.boardSelection === item.id);
  const selectWork = useStore((s) => s.selectWork);
  const chip = statusChip(item, now);
  const lock = lockOn(item, world, site);
  const trade = tradeFor(item, site);
  return (
    <li>
      <button className={`work-row lane-${lane}${selected ? ' selected' : ''}`} aria-selected={selected} onClick={() => selectWork(selected ? null : item.id)}>
        {trade ? <TradeGlyph trade={trade.trade} className="glyph-tile" /> : <span className="glyph glyph-tile" aria-hidden />}
        <span className="row-main">
          <span className="row-title">
            <span className="row-target">{targetOf(item)}</span>
            <span className="row-kind">{kindTitle(item)}</span>
          </span>
          <span className="row-meta">
            {trade && (
              <span className="trade-chip">
                {trade.trade}
                <LevelBars level={trade.level} />
              </span>
            )}
            {item.completedBy ? (
              <span className="tone-azure">Done by {item.completedBy}</span>
            ) : item.assignee ? (
              <span className="tone-azure">{yours ? 'Yours' : item.assignee}</span>
            ) : (
              <span className="muted">{actorName(item.actor)}</span>
            )}
            {lock && (
              <span className="row-lock" title={`Locked for ${lock.job} until ${clock(lock.until)}`}>
                <IconLock />
                {lock.job}
              </span>
            )}
            {item.routine && <span className="muted">Routine</span>}
          </span>
        </span>
        <span className="row-end">
          <span className={`verdict tone-${chip.tone}`}>{chip.text}</span>
          {item.status === 'active' && <TimeBar start={item.start} end={item.end} now={now} />}
        </span>
      </button>
    </li>
  );
}

function LaneGroup({ lane, title, items, open, onToggle, me }: { lane: Lane; title: string; items: WorkItem[]; open: boolean; onToggle: () => void; me: string }) {
  return (
    <section className="lane-group" aria-label={title}>
      <button className="lane-toggle" onClick={onToggle} aria-expanded={open}>
        <span className="eyebrow">
          <span className={`mark lane-mark-${lane}`} aria-hidden />
          {title} <span className="count">{items.length}</span>
        </span>
        <IconChevron dir={open ? 'up' : 'down'} />
      </button>
      {open &&
        (items.length === 0 ? (
          <p className="lane-empty">None.</p>
        ) : (
          <ul className="work-list">
            {items.map((item) => (
              <WorkRow key={item.id} item={item} lane={lane} yours={item.assignee === me} />
            ))}
          </ul>
        ))}
    </section>
  );
}

// ---------------------------------------------------------------- detail

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function WorkDetail({ item }: { item: WorkItem }) {
  const site = useStore((s) => s.site);
  const world = useStore((s) => s.world);
  const me = useStore((s) => s.me);
  const focus = useStore((s) => s.focus);
  const setView = useStore((s) => s.setView);
  const selectWork = useStore((s) => s.selectWork);
  const acceptWork = useStore((s) => s.acceptWork);
  const completeWork = useStore((s) => s.completeWork);
  const [note, setNote] = useState('');
  const chip = statusChip(item, world.now);
  const trade = tradeFor(item, site);
  const lock = lockOn(item, world, site);
  const canTake = item.status === 'active' || item.status === 'granted' || item.status === 'needs_approval';
  const canComplete = item.status === 'active';
  const mine = item.assignee === me;

  return (
    <section className="work-detail" aria-label={`${kindTitle(item)} on ${targetOf(item)}`}>
      <header className="detail-head">
        <div className="detail-id">
          <RowMap item={item} site={site} tone={item.status === 'needs_approval' ? 'gold' : 'azure'} />
          <div>
            <p className="eyebrow">{kindTitle(item)}</p>
            <h2 className="detail-title">{targetOf(item)}</h2>
            <p className="detail-sub">
              <span className={`verdict tone-${chip.tone}`}>{chip.text}</span>
            </p>
          </div>
        </div>
        <button className="icon-btn" onClick={() => selectWork(null)} title="Close (Esc)" aria-label="Close">
          <IconClose />
        </button>
      </header>
      <div className="detail-body">
        {item.status === 'active' && (
          <div className="detail-window">
            <span>{clock(item.start)}</span>
            <TimeBar start={item.start} end={item.end} now={world.now} />
            <span>{clock(item.end)}</span>
          </div>
        )}

        {(canTake || canComplete || !boardOnly) && (
          <div className="detail-actions">
            {canComplete && (
              <>
                <input
                  className="board-input"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Note (optional)"
                  aria-label="Completion note"
                  disabled={!liveEnabled}
                />
                <button
                  className="board-btn board-btn-primary"
                  onClick={() => {
                    completeWork(item.id, note.trim());
                    setNote('');
                  }}
                  disabled={!liveEnabled}
                  title={liveEnabled ? 'The lease ends now; a failed or degraded target comes back' : 'Live only'}
                >
                  Complete
                </button>
              </>
            )}
            {canTake && !mine && (
              <button className="board-btn" onClick={() => acceptWork(item.id)} disabled={!liveEnabled} title={liveEnabled ? (item.assignee ? `Move it from ${item.assignee} to ${me}` : `Take it on as ${me}`) : 'Live only'}>
                <IconPerson />
                {item.assignee ? 'Move to me' : 'Take it on'}
              </button>
            )}
            {!boardOnly && (
              <button
                className="board-btn board-btn-quiet"
                onClick={() => {
                  focus(focusOf(item));
                  setView('hall');
                }}
                title="Fly the hall's camera to it"
              >
                <IconTarget />
                Show in hall
              </button>
            )}
          </div>
        )}

        <dl className="facts">
          <Fact label="Needs">
            {trade ? (
              <span className="trade-chip">
                <TradeGlyph trade={trade.trade} />
                {trade.trade}
                <LevelBars level={trade.level} />
              </span>
            ) : (
              '—'
            )}
          </Fact>
          <Fact label="Window">
            {clock(item.start)} → {clock(item.end)}
          </Fact>
          <Fact label="Requested by">
            {actorName(item.actor)}
            {item.bookedBy && <span className="muted"> · booked by {item.bookedBy}</span>}
          </Fact>
          {item.approvedBy && <Fact label="Approved by">{item.approvedBy}</Fact>}
          {item.nodeCount > 0 && <Fact label="Nodes">{item.nodeCount.toLocaleString()}</Fact>}
          {item.routine && <Fact label="Routine">Yes: the fixer may rebook a refusal once the blockers clear</Fact>}
          <Fact label="Lease">#{item.id}</Fact>
        </dl>

        <section className="detail-section">
          <h3 className="eyebrow">Why</h3>
          <p className="detail-text">{item.reason || 'No reason recorded.'}</p>
          {item.earliestSafe && (
            <p className="detail-text">
              Earliest safe time: <span className="tone-gold">{item.earliestSafe}</span>
              {item.blockers.length > 0 && <span className="muted"> · waits on {item.blockers.join(', ')}</span>}
            </p>
          )}
          {item.note && <p className="detail-text muted">“{item.note}”</p>}
        </section>

        {lock && (
          <section className="detail-section">
            <h3 className="eyebrow">
              <IconLock /> Lock
            </h3>
            <p className="detail-text">
              <span className="tone-azure">Protected for {lock.job}</span> until {clock(lock.until)}: {lock.racks.length} racks held by {lock.holder}. Work that would remove their
              backup is refused until then; online updates still run.
            </p>
          </section>
        )}

        <section className="detail-section">
          <h3 className="eyebrow">Who</h3>
          {item.completedBy ? (
            <p className="detail-text">
              <span className="tone-azure">Done by {item.completedBy}</span>
              {item.completedAt !== undefined && ` at ${clock(item.completedAt)}`}
              {item.assignee && item.assignee !== item.completedBy && `, taken on by ${item.assignee}`}
              {item.repaired && item.repaired.length > 0 && `. Back in service: ${item.repaired.join(', ')}`}
              {item.completionNote && ` · “${item.completionNote}”`}
            </p>
          ) : item.assignee ? (
            <p className="detail-text">
              <span className="tone-azure">{mine ? `Yours (${item.assignee})` : item.assignee}</span>
              {item.acceptedAt !== undefined && ` since ${clock(item.acceptedAt)}`}
              {item.assigneeRole && <span className="muted"> · {item.assigneeRole.replace('_', ' ')}</span>}
            </p>
          ) : (
            <p className="detail-text muted">Not taken on yet.</p>
          )}
        </section>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- context (nothing selected)

function LockRow({ lock }: { lock: LockView }) {
  const focus = useStore((s) => s.focus);
  const setView = useStore((s) => s.setView);
  const rows = lock.rows.length ? `Rows ${lock.rows[0]}${lock.rows.length > 1 ? `–${lock.rows[lock.rows.length - 1]}` : ''}` : '';
  return (
    <li className="ctx-row">
      <span className="glyph glyph-azure" aria-hidden>
        <IconLock />
      </span>
      <span className="ctx-main">
        <span className="ctx-title">{lock.job || 'Protection'}</span>
        <span className="ctx-sub">
          <span className="tone-azure">{lock.racks.length} racks</span> · {rows} · until {clock(lock.until)}
        </span>
      </span>
      {!boardOnly && (
        <button
          className="icon-btn"
          title="Show in hall"
          aria-label="Show in hall"
          onClick={() => {
            focus({ kind: 'racks', ids: lock.racks });
            setView('hall');
          }}
        >
          <IconTarget />
        </button>
      )}
    </li>
  );
}

function AgentRow({ card }: { card: AgentCard }) {
  const st = AGENT_STATE[card.state];
  return (
    <li className="ctx-row">
      <span className={`glyph ${card.state === 'working' || card.state === 'fixed' ? 'glyph-azure' : card.state === 'handoff' || card.state === 'stopped' ? 'glyph-gold' : ''}`} aria-hidden>
        <IconBot />
      </span>
      <span className="ctx-main">
        <span className="ctx-title">
          {actorName(card.actor)}
          {/* The update agent shares the scheduler's icon kind; its own name says what it is. */}
          {actorName(card.actor) === card.actor && <span className="ctx-kind">{AGENT_KIND[card.kind]}</span>}
        </span>
        {card.model && <span className="ctx-model">{card.model}</span>}
        <span className="ctx-sub">
          {card.lastTitle}
          <span className="muted"> · {clock(card.lastSeen)}</span>
        </span>
      </span>
      {card.state !== 'idle' && <span className={`verdict tone-${st.tone}`}>{st.text}</span>}
    </li>
  );
}

function Context({ items, me }: { items: WorkItem[]; me: string }) {
  const world = useStore((s) => s.world);
  const site = useStore((s) => s.site);
  const events = useStore((s) => s.events);
  const selectWork = useStore((s) => s.selectWork);
  const lockList = useMemo(() => locks(world, site), [world, site]);
  const agents = useMemo(() => agentCards(events), [events]);
  const onFloor = items.filter((i) => i.assignee && !i.completedBy && (i.status === 'active' || i.status === 'granted' || i.status === 'needs_approval'));
  return (
    <div className="board-context">
      <section className="ctx-section" aria-label="Locks">
        <h3 className="eyebrow">
          Locks <span className="count">{lockList.length}</span>
        </h3>
        {lockList.length === 0 ? (
          <p className="lane-empty">No protection lease is running.</p>
        ) : (
          <ul className="ctx-list">
            {lockList.map((l) => (
              <LockRow key={l.id} lock={l} />
            ))}
          </ul>
        )}
      </section>
      <section className="ctx-section" aria-label="On the floor">
        <h3 className="eyebrow">
          On the floor <span className="count">{onFloor.length}</span>
        </h3>
        {onFloor.length === 0 ? (
          <p className="lane-empty">No one has taken work on.</p>
        ) : (
          <ul className="ctx-list">
            {onFloor.map((i) => (
              <li key={i.id}>
                <button className="ctx-row ctx-row-btn" onClick={() => selectWork(i.id)}>
                  <span className="glyph glyph-azure" aria-hidden>
                    <IconPerson />
                  </span>
                  <span className="ctx-main">
                    <span className="ctx-title">
                      <span className="tone-azure">{i.assignee === me ? 'You' : i.assignee}</span> · {targetOf(i)}
                    </span>
                    <span className="ctx-sub">
                      {kindTitle(i)} · {statusChip(i, world.now).text.toLowerCase()}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {!boardOnly && (
        <section className="ctx-section" aria-label="Agents">
          <h3 className="eyebrow">
            Agents <span className="count">{agents.length}</span>
          </h3>
          {agents.length === 0 ? (
            <p className="lane-empty">No agent has acted yet.</p>
          ) : (
            <ul className="ctx-list">
              {agents.map((a) => (
                <AgentRow key={a.actor} card={a} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the board

const DEFAULT_OPEN: Record<Lane, boolean> = { active: true, booked: true, approval: true, refused: true, done: false };

export function WorkBoard() {
  const site = useStore((s) => s.site);
  const world = useStore((s) => s.world);
  const filter = useStore((s) => s.boardFilter);
  const setFilter = useStore((s) => s.setBoardFilter);
  const boardSelection = useStore((s) => s.boardSelection);
  const selectWork = useStore((s) => s.selectWork);
  const notice = useStore((s) => s.notice);
  const me = useStore((s) => s.me);
  const stepIndex = useStore((s) => s.stepIndex);
  const [open, setOpen] = useState<Record<Lane, boolean>>(DEFAULT_OPEN);

  // A worker's screen remembers its trade.
  useEffect(() => {
    if (!boardOnly) return;
    const saved = readTrade();
    if (saved) setFilter(saved);
  }, [setFilter]);

  const items = useMemo(() => world.work ?? mockWorkItems(world, site), [world, site]);
  const lanes = useMemo(() => groupWork(items, site, filter), [items, site, filter]);
  const yours = useMemo(() => items.filter((i) => i.assignee === me && !i.completedBy && (i.status === 'active' || i.status === 'granted' || i.status === 'needs_approval')), [items, me]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    for (const item of items) {
      if (item.kind === 'protection' || item.status === 'simulated' || item.status === 'done' || item.status === 'cancelled' || item.status === 'expired') continue;
      const t = tradeFor(item, site)?.trade;
      c.all++;
      if (t) c[t] = (c[t] ?? 0) + 1;
    }
    return c;
  }, [items, site]);
  const selected = boardSelection ? items.find((i) => i.id === boardSelection) : undefined;

  // A selection the filter has hidden is no selection.
  useEffect(() => {
    if (boardSelection && !selected) selectWork(null);
  }, [boardSelection, selected, selectWork]);

  const pick = (trade: string) => {
    setFilter(trade);
    if (boardOnly) saveTrade(trade);
  };

  return (
    <div className={`board${boardOnly ? ' board-only' : ''}${selected ? ' has-selection' : ''}`} role="region" aria-label="Work board">
      <header className="board-head">
        {boardOnly ? <span className="wordmark">Squawk</span> : <ViewTabs />}
        <div className="board-end">
          <p className="sim-clock">
            <span className="sim-clock-value">{stepIndex < 0 && world.now === 0 ? 'T+0m' : clock(world.now)}</span>simulated
          </p>
          <span className="board-me">
            <IconPerson />
            {me}
          </span>
        </div>
      </header>
      {notice && <p className="board-notice">{notice}</p>}
      {!world.work && <p className="board-notice muted">Mock data. Start the view in live mode to act on work.</p>}

      <div className="board-body">
        <TradeRail counts={counts} filter={filter} onPick={pick} />
        <div className="board-main">
          {boardOnly && <LaneGroup lane="active" title="Yours" items={yours} open me={me} onToggle={() => undefined} />}
          {LANES.map((lane) => (
            <LaneGroup
              key={lane}
              lane={lane}
              title={LANE_TITLE[lane]}
              items={boardOnly ? lanes[lane].filter((i) => i.assignee !== me || i.completedBy) : lanes[lane]}
              open={open[lane]}
              me={me}
              onToggle={() => setOpen((o) => ({ ...o, [lane]: !o[lane] }))}
            />
          ))}
        </div>
        <aside className="board-side">{selected ? <WorkDetail key={selected.id} item={selected} /> : <Context items={items} me={me} />}</aside>
      </div>
    </div>
  );
}
