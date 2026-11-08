// The backend's rows as the frontend's live mapping receives them (one array per table).

import type { Tables } from '../../frontend/src/live/mapping';
import type { MemStore } from './memstore';

export function tablesOf(s: MemStore): Tables {
  let id = 0n;
  const downstream = [...s.downstream].flatMap(([part, racks]) => racks.map((rack) => ({ id: ++id, part, rack })));
  return {
    part: [...s.parts.values()],
    rack: [...s.racks.values()],
    node: [...s.nodes.values()],
    downstream,
    margin: [...s.margins.values()],
    job: [...s.jobs.values()],
    work: [...s.works.values()],
    assignment: [...s.assignments.values()],
    diagnosis: [...s.diagnoses.values()],
    placement: [...s.placements.values()],
    decision: s.decisions,
    clock: [{ id: 0, nowMin: s.now() }],
    scenario: s.scenarioRow ? [s.scenarioRow] : [],
  };
}
