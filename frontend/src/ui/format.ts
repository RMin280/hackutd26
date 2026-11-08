import type { MarginLevel, Owner, PartState, Verdict } from '../model/types';

export const marginText = (l: MarginLevel) =>
  l === 'green' ? 'Full backup' : l === 'yellow' ? 'One failure from an outage' : 'No working feed';

export const marginTone = (l: MarginLevel): Tone => (l === 'green' ? 'green' : l === 'yellow' ? 'amber' : 'red');

export const stateTone = (s: PartState): Tone =>
  s === 'ok' ? 'green' : s === 'degraded' ? 'amber' : s === 'failed' ? 'red' : 'purple';

export const stateText = (s: PartState) => (s === 'ok' ? 'OK' : s[0].toUpperCase() + s.slice(1));

export const ownerText = (o: Owner) =>
  o.kind === 'job' ? o.id : o.kind === 'tenant' ? o.id : 'Free spare';

export type Tone = 'green' | 'amber' | 'red' | 'blue' | 'teal' | 'purple' | 'muted';

export const VERDICT: Record<Verdict, { text: string; tone: Tone }> = {
  allow: { text: 'Allowed', tone: 'green' },
  warn: { text: 'Warning', tone: 'amber' },
  deny: { text: 'Denied', tone: 'red' },
  failure: { text: 'Failure', tone: 'red' },
  shared_cause: { text: 'Shared cause', tone: 'amber' },
  isolated: { text: 'Isolated', tone: 'blue' },
  placement: { text: 'Placed', tone: 'teal' },
  info: { text: 'Info', tone: 'muted' },
};

export const clock = (min: number) => {
  if (min < 60) return `T+${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `T+${h}h${m}m` : `T+${h}h`;
};
