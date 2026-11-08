// In-memory Store for tests and the scale benchmark. It keeps the same indexes the
// SpacetimeDB tables declare (rack.rowNum, node.rack/ownerKind/ownerId, downstream.part,
// work.status, claim.resource/work), so timings reflect index lookups, not scans.

import { DEFAULT_SETTINGS } from '../src/core/commands';
import type { New, Store } from '../src/core/store';
import type {
  ActorRow,
  AisleRow,
  AssignmentRow,
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
} from '../src/core/types';

function addTo<K, V>(m: Map<K, Set<V>>, k: K, v: V) {
  let s = m.get(k);
  if (!s) m.set(k, (s = new Set()));
  s.add(v);
}
function removeFrom<K, V>(m: Map<K, Set<V>>, k: K, v: V) {
  m.get(k)?.delete(v);
}

export class MemStore implements Store {
  parts = new Map<string, PartRow>();
  aisles = new Map<string, AisleRow>();
  racks = new Map<string, RackRow>();
  racksByRow = new Map<number, string[]>();
  nodes = new Map<string, NodeRow>();
  nodesByOwnerId = new Map<string, Set<string>>();
  nodesByOwnerKind = new Map<string, Set<string>>();
  downstream = new Map<string, string[]>();
  margins = new Map<string, MarginRow>();
  jobs = new Map<string, JobRow>();
  works = new Map<bigint, WorkRow>();
  worksByStatus = new Map<string, Set<bigint>>();
  claims = new Map<bigint, ClaimRow>();
  claimsByResource = new Map<string, Set<bigint>>();
  claimsByWork = new Map<bigint, Set<bigint>>();
  assignments = new Map<bigint, AssignmentRow>();
  failures: FailureRow[] = [];
  diagnoses = new Map<bigint, DiagnosisRow>();
  placements = new Map<bigint, PlacementRow>();
  decisions: DecisionRow[] = [];
  audits: AuditInput[] = [];
  actors = new Map<string, ActorRow>();
  incidents = new Map<number, IncidentRow>();
  scenarioRow: ScenarioRow | undefined;
  settingsRow: SettingsRow | undefined;
  nowMin = 0;
  private ids = { work: 0n, claim: 0n, failure: 0n, diagnosis: 0n, placement: 0n, decision: 0n };

  part(id: string) {
    return this.parts.get(id);
  }
  rack(id: string) {
    return this.racks.get(id);
  }
  node(id: string) {
    return this.nodes.get(id);
  }
  aisle(id: string) {
    return this.aisles.get(id);
  }
  racksInRow(rowNum: number) {
    return (this.racksByRow.get(rowNum) ?? []).map((id) => this.racks.get(id)!);
  }
  downstreamRacks(partId: string) {
    return [...(this.downstream.get(partId) ?? [])];
  }

  now() {
    return this.nowMin;
  }
  setNow(min: number) {
    this.nowMin = min;
  }
  settings() {
    return this.settingsRow ?? { ...DEFAULT_SETTINGS };
  }
  putSettings(row: SettingsRow) {
    this.settingsRow = { ...row };
  }
  actor(identity: string) {
    return this.actors.get(identity);
  }
  actorByName(name: string) {
    return [...this.actors.values()].find((a) => a.name === name);
  }
  hasAdmin() {
    return [...this.actors.values()].some((a) => a.role === 'admin');
  }
  putActor(row: ActorRow) {
    this.actors.set(row.identity, { ...row });
  }
  job(id: string) {
    return this.jobs.get(id);
  }
  putJob(row: JobRow) {
    this.jobs.set(row.id, { ...row });
  }
  nodesOwnedBy(ownerId: string) {
    return [...(this.nodesByOwnerId.get(ownerId) ?? [])].map((id) => this.nodes.get(id)!);
  }
  freeNodes() {
    return [...(this.nodesByOwnerKind.get('free') ?? [])].map((id) => this.nodes.get(id)!);
  }
  putPart(row: PartRow) {
    this.parts.set(row.id, { ...row });
  }
  putNode(row: NodeRow) {
    const old = this.nodes.get(row.id);
    if (old) {
      removeFrom(this.nodesByOwnerId, old.ownerId, old.id);
      removeFrom(this.nodesByOwnerKind, old.ownerKind, old.id);
    }
    this.nodes.set(row.id, { ...row });
    addTo(this.nodesByOwnerId, row.ownerId, row.id);
    addTo(this.nodesByOwnerKind, row.ownerKind, row.id);
  }
  putAisle(row: AisleRow) {
    this.aisles.set(row.id, { ...row });
  }
  margin(rack: string) {
    return this.margins.get(rack);
  }
  putMargin(row: MarginRow) {
    this.margins.set(row.rack, { ...row });
  }

  work(id: bigint) {
    const w = this.works.get(id);
    return w ? { ...w } : undefined;
  }
  workByStatus(status: string) {
    return [...(this.worksByStatus.get(status) ?? [])].map((id) => ({ ...this.works.get(id)! }));
  }
  insertWork(row: New<WorkRow>) {
    const w = { ...row, id: ++this.ids.work };
    this.works.set(w.id, w);
    addTo(this.worksByStatus, w.status, w.id);
    return { ...w };
  }
  putWork(row: WorkRow) {
    const old = this.works.get(row.id);
    if (old) removeFrom(this.worksByStatus, old.status, old.id);
    this.works.set(row.id, { ...row });
    addTo(this.worksByStatus, row.status, row.id);
  }
  claimsOn(resource: string) {
    return [...(this.claimsByResource.get(resource) ?? [])].map((id) => this.claims.get(id)!);
  }
  insertClaim(row: New<ClaimRow>) {
    const c = { ...row, id: ++this.ids.claim };
    this.claims.set(c.id, c);
    addTo(this.claimsByResource, c.resource, c.id);
    addTo(this.claimsByWork, c.work, c.id);
  }
  deleteClaimsOf(work: bigint) {
    for (const id of this.claimsByWork.get(work) ?? []) {
      const c = this.claims.get(id);
      if (c) removeFrom(this.claimsByResource, c.resource, id);
      this.claims.delete(id);
    }
    this.claimsByWork.delete(work);
  }
  assignment(work: bigint) {
    return this.assignments.get(work);
  }
  putAssignment(row: AssignmentRow) {
    this.assignments.set(row.work, { ...row, repaired: [...row.repaired] });
  }
  failuresSince(min: number) {
    return this.failures.filter((f) => f.atMin >= min);
  }
  insertFailure(row: New<FailureRow>) {
    this.failures.push({ ...row, id: ++this.ids.failure });
  }
  diagnosis(id: bigint) {
    return this.diagnoses.get(id);
  }
  insertDiagnosis(row: New<DiagnosisRow>) {
    const d = { ...row, id: ++this.ids.diagnosis };
    this.diagnoses.set(d.id, d);
    return d;
  }
  placement(id: bigint) {
    return this.placements.get(id);
  }
  insertPlacement(row: New<PlacementRow>) {
    const p = { ...row, id: ++this.ids.placement };
    this.placements.set(p.id, p);
    return p;
  }
  putPlacement(row: PlacementRow) {
    this.placements.set(row.id, { ...row });
  }
  insertDecision(row: Omit<DecisionRow, 'seq'>) {
    this.decisions.push({ ...row, seq: ++this.ids.decision });
  }
  insertAudit(row: AuditInput) {
    this.audits.push({ ...row });
  }
  scenario() {
    return this.scenarioRow ? { ...this.scenarioRow } : undefined;
  }
  putScenario(row: ScenarioRow) {
    this.scenarioRow = { ...row };
  }
  putIncident(row: IncidentRow) {
    this.incidents.set(row.id, { ...row });
  }

  clearFacility() {
    for (const m of [
      this.parts,
      this.aisles,
      this.racks,
      this.racksByRow,
      this.nodes,
      this.nodesByOwnerId,
      this.nodesByOwnerKind,
      this.downstream,
      this.margins,
      this.jobs,
      this.works,
      this.worksByStatus,
      this.claims,
      this.claimsByResource,
      this.claimsByWork,
      this.assignments,
      this.diagnoses,
      this.placements,
      this.incidents,
    ] as Map<unknown, unknown>[]) {
      m.clear();
    }
    this.failures = [];
    this.decisions = [];
  }
  loadSite(site: SiteData, margins: MarginRow[]) {
    for (const p of site.parts) this.putPart(p);
    for (const a of site.aisles) this.putAisle(a);
    for (const r of site.racks) {
      this.racks.set(r.id, { ...r });
      const xs = this.racksByRow.get(r.rowNum);
      if (xs) xs.push(r.id);
      else this.racksByRow.set(r.rowNum, [r.id]);
    }
    for (const n of site.nodes) this.putNode(n);
    for (const d of site.downstream) {
      const xs = this.downstream.get(d.part);
      if (xs) xs.push(d.rack);
      else this.downstream.set(d.part, [d.rack]);
    }
    for (const m of margins) this.putMargin(m);
    for (const j of site.jobs) this.putJob(j);
  }
}
