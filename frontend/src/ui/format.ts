import type { DecisionEvent, MarginLevel, Owner, PartState, Verdict } from '../model/types';

// Colour is reserved for meaning: healthy stays neutral ('ok'), gold and red mark
// problems, azure is the product's own voice (actions, protection), ice is a safe placement.
export type Tone = 'ok' | 'gold' | 'red' | 'azure' | 'ice' | 'muted';

export const marginText = (l: MarginLevel) =>
  l === 'green' ? 'Full backup' : l === 'yellow' ? 'One failure from an outage' : 'No working feed';

export const marginTone = (l: MarginLevel): Tone => (l === 'green' ? 'ok' : l === 'yellow' ? 'gold' : 'red');

export const stateTone = (s: PartState): Tone =>
  s === 'ok' ? 'ok' : s === 'degraded' ? 'gold' : s === 'failed' ? 'red' : 'ice';

export const stateText = (s: PartState) => (s === 'ok' ? 'OK' : s[0].toUpperCase() + s.slice(1));

export const ownerText = (o: Owner) =>
  o.kind === 'job' ? o.id : o.kind === 'tenant' ? o.id : 'Free spare';

export const VERDICT: Record<Verdict, { text: string; tone: Tone }> = {
  allow: { text: 'Allowed', tone: 'azure' },
  warn: { text: 'Warning', tone: 'gold' },
  // A refusal is the product doing its job (the interlock held), so it speaks in azure; red is for failures.
  deny: { text: 'Denied', tone: 'azure' },
  failure: { text: 'Failure', tone: 'red' },
  shared_cause: { text: 'Shared cause', tone: 'gold' },
  isolated: { text: 'Isolated', tone: 'ice' },
  placement: { text: 'Placed', tone: 'ice' },
  info: { text: 'Info', tone: 'muted' },
  // The fixer agent's own rows: its plan and a finished issue are the product acting (azure);
  // a hand-off needs a person (gold).
  plan: { text: 'Plan', tone: 'azure' },
  fixed: { text: 'Fixed', tone: 'azure' },
  handoff: { text: 'Handed off', tone: 'gold' },
};

export const clock = (min: number) => {
  if (min < 60) return `T+${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `T+${h}h${m}m` : `T+${h}h`;
};

/** The agents' registered identities, as people should read them. Anyone else keeps their name. */
const ACTOR_DISPLAY: Record<string, string> = {
  'fixer-agent': 'Nemotron fixer',
  'update-agent': 'Nemotron update agent',
};
export const actorName = (actor: string) => ACTOR_DISPLAY[actor] ?? actor;

/** Which model wrote a row, from the backend's `data` (the agents put `model` on their plan rows). */
export function modelOf(e: Pick<DecisionEvent, 'data'>): string | undefined {
  if (!e.data) return undefined;
  try {
    const d: unknown = JSON.parse(e.data);
    const m = d && typeof d === 'object' && !Array.isArray(d) ? (d as { model?: unknown }).model : undefined;
    return typeof m === 'string' && m ? m : undefined;
  } catch {
    return undefined;
  }
}
