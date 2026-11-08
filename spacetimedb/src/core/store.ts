// The core logic reads and writes through this interface. ../index.ts implements it
// over SpacetimeDB tables (every lookup is a primary-key or index lookup); the tests
// implement it over Maps. Nothing here scans the whole facility except the explicit
// bulk calls used by seeding and placement's single pass over free nodes.

import type {
  ActorRow,
  AisleRow,
  AuditInput,
  ClaimRow,
  DecisionRow,
  DiagnosisRow,
  FailureRow,
  IncidentRow,
  JobRow,
  MarginRow,
  NodeRow,
  PartRow,
  PlacementRow,
  RackRow,
  ScenarioRow,
  SettingsRow,
  SiteData,
  WorkRow,
} from './types';

export type New<T> = Omit<T, 'id'>;

export interface Store {
  // ---- facility map (written once by seeding)
  part(id: string): PartRow | undefined;
  rack(id: string): RackRow | undefined;
  node(id: string): NodeRow | undefined;
  aisle(id: string): AisleRow | undefined;
  racksInRow(rowNum: number): RackRow[];
  downstreamRacks(partId: string): string[];

  // ---- live state
  now(): number;
  setNow(min: number): void;
  settings(): SettingsRow; // returns defaults when the row doesn't exist yet
  putSettings(row: SettingsRow): void;
  actor(identity: string): ActorRow | undefined;
  actorByName(name: string): ActorRow | undefined; // the requester named in a book_for_others request
  hasAdmin(): boolean;
  putActor(row: ActorRow): void;
  job(id: string): JobRow | undefined;
  putJob(row: JobRow): void;
  nodesOwnedBy(ownerId: string): NodeRow[];
  freeNodes(): NodeRow[];
  putPart(row: PartRow): void;
  putNode(row: NodeRow): void;
  putAisle(row: AisleRow): void;
  margin(rack: string): MarginRow | undefined;
  putMargin(row: MarginRow): void;

  // ---- work, claims and results
  work(id: bigint): WorkRow | undefined;
  workByStatus(status: string): WorkRow[];
  insertWork(row: New<WorkRow>): WorkRow;
  putWork(row: WorkRow): void;
  claimsOn(resource: string): ClaimRow[];
  insertClaim(row: New<ClaimRow>): void;
  deleteClaimsOf(work: bigint): void;
  failuresSince(min: number): FailureRow[];
  insertFailure(row: New<FailureRow>): void;
  diagnosis(id: bigint): DiagnosisRow | undefined;
  insertDiagnosis(row: New<DiagnosisRow>): DiagnosisRow;
  placement(id: bigint): PlacementRow | undefined;
  insertPlacement(row: New<PlacementRow>): PlacementRow;
  putPlacement(row: PlacementRow): void;
  insertDecision(row: Omit<DecisionRow, 'seq'>): void;
  scenario(): ScenarioRow | undefined;
  putScenario(row: ScenarioRow): void;
  putIncident(row: IncidentRow): void;
  insertAudit(row: AuditInput): void; // append-only; the adapter stamps wall-clock time

  // ---- bulk (seeding / reset only)
  clearFacility(): void; // everything except actors, settings, the scenario row and the audit log
  loadSite(site: SiteData, margins: MarginRow[]): void;
}
