import type { MarginLevel, Owner, PartState, Verdict } from '../model/types';

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
};

export const clock = (min: number) => {
  if (min < 60) return `T+${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `T+${h}h${m}m` : `T+${h}h`;
};
