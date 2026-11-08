import { bootstrapAdmin, seed } from '../src/core/commands';
import { initDatabase } from '../src/core/lab';
import { buildSite, DEMO_HALL, type SiteSpec } from '../src/core/site';
import type { Role } from '../src/core/types';
import { MemStore } from './memstore';

const hex = (c: string) => c.repeat(64);

export const ID = {
  admin: hex('a'),
  lead: hex('b'),
  tech: hex('c'),
  sched: hex('d'),
  cool: hex('e'),
  facility: hex('f'),
  tech3: hex('1'),
  coolRow3: hex('2'),
  fixer: hex('3'),
  stranger: hex('9'),
};

const PEOPLE: [keyof typeof ID, string, Role, number[]][] = [
  ['lead', 'Shift lead', 'shift_lead', []],
  ['tech', 'Tech Ana', 'technician', []],
  ['sched', 'Scheduler agent', 'scheduler_agent', []],
  ['cool', 'Cooling agent', 'cooling_agent', []],
  ['facility', 'Facility', 'facility', []],
  ['tech3', 'Tech Row 3', 'technician', [3]],
  ['coolRow3', 'Cooling agent R3', 'cooling_agent', [3, 4]],
  ['fixer', 'Fixer agent', 'remediation_agent', []],
];

export function withPeople(s: MemStore): MemStore {
  bootstrapAdmin(s, ID.admin);
  for (const [key, name, role, rows] of PEOPLE) s.putActor({ identity: ID[key], name, role, rows });
  return s;
}

export function demo(spec: SiteSpec = DEMO_HALL): MemStore {
  const s = new MemStore();
  seed(s, buildSite(spec));
  return withPeople(s);
}

/** A brand-new database after `init` (the diagnostics test bed), with the test actors. */
export function freshDatabase(): MemStore {
  const s = new MemStore();
  initDatabase(s, ID.admin);
  return withPeople(s);
}

export const work = (kind: string, target: string, extra: Partial<{ startInMin: number; durationMin: number; dryRun: boolean; ticket: string }> = {}) => ({
  kind,
  target,
  startInMin: 0,
  durationMin: 0,
  dryRun: false,
  ticket: '',
  ...extra,
});
