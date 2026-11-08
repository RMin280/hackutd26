# Blast Radius backend (SpacetimeDB)

The backend is one SpacetimeDB module written in TypeScript. Tables hold the facility map and everything the control-room view shows. Reducers are the only way to change anything, and each reducer runs as one transaction. So when two actors ask for the same backup at the same moment, SpacetimeDB runs one request after the other: the second one sees the first one's lease and is refused.

```
spacetimedb/
├── src/index.ts          # tables, the Store adapter over ctx.db, reducers
├── src/core/             # the logic: plain functions, no SpacetimeDB imports, no wall clock
│   ├── site.ts           # demo hall generator (same IDs as frontend/src/mock/site.ts) + scale sites
│   ├── catalog.ts        # kinds of work, their scopes, roles
│   ├── footprint.ts      # kind + target -> locks claimed and what goes offline
│   ├── margins.ts        # remaining backup per rack (feed chains), incremental recompute
│   ├── guard.ts          # the interlock: locks, backup check, verdict, reason, earliest safe time
│   ├── diagnose.ts       # shared-cause diagnosis
│   ├── placement.ts      # safe restart placement
│   ├── commands.ts       # one function per reducer
│   ├── scenario.ts       # the presenter's "big job failure" run, both modes, as scripted actors
│   └── lab.ts            # the diagnostics test bed a fresh database starts with
└── test/                 # node:test via tsx; an in-memory Store with the same indexes
```

## Run it

You need the [SpacetimeDB CLI](https://spacetimedb.com/install) (2.x) and Node 22+. The quickest way is the repo root's `dev.sh` (`bash dev.sh server` in one terminal, `bash dev.sh up` in another; see the root `README.md`). By hand:

```bash
cd spacetimedb && npm install
npm test                       # unit, scenario, test bed and frontend contract tests (no SpacetimeDB needed)
npm run test:scale             # 100k-GPU performance limits

spacetime start                # local server on :3000, keep it running
spacetime publish --server local --module-path . blast-radius
spacetime logs --server local blast-radius
```

`spacetime publish` runs `tsc --noEmit` on this folder before it bundles, so a type error stops it; `npm run typecheck` shows the same errors. If the CLI isn't logged in, publish first asks to log in with spacetimedb.com: say yes (free, and it works with the local server). Keep the `spacetimedb` npm package no newer than the CLI (`spacetime --version`); `spacetime version upgrade` updates the CLI.

The first publish runs `init`. It loads the **diagnostics test bed** (below) and makes the publishing identity (your CLI) the admin. If you change a table's columns, republish with `--delete-data` (or `bash dev.sh fresh`) and `init` loads the test bed again.

Then open the control room (see `frontend/README.md`, "Live mode"): it shows whatever the database holds, and Space runs the demo scenario on the backend.

## Diagnostics test bed

A fresh database is the demo hall at T+3h with five incidents, so diagnostic agents have real cases to work on. Reload it any time with `spacetime call --server local blast-radius seed_diagnostics`.

| # | Incident | Failed nodes | What it tests | Answer (the engine's) |
| --- | --- | --- | --- | --- |
| 1 | Cooling loop degraded under the training job | `node-417` | a degraded part above a job node | shared cause `cdu-3`; 39 job nodes at risk; mechanical tech |
| 2 | Row 4 B-side PDU failed | `node-427` | a failed power part | shared cause `pdu-r4-b`; 127 at risk; electrical tech |
| 3 | Two failures in Row 6, no alarm | `node-731`, `node-660` | nothing marked broken: two failures in 2 h under one leaf | shared cause `sw-leaf-r6`; 126 at risk; network engineer |
| 4 | Single node failure in Row 8 | `node-923` | an older failure on the same leaf (`node-1007`, T+20m) falls outside the 2 h window | isolated; hardware tech to node-923 |
| 5 | Tenant node under a failed CDU | `node-1153` | a non-job node (tenant-gamma) | shared cause `cdu-29`; no job nodes at risk; mechanical tech |

`job-train-1` has been stopped since `node-660` failed at T+1h05m, and 36 racks are one failure from an outage (CDU-3, CDU-29, PDU-R4-B). The decision feed holds the ten events that led here.

**An agent works it like an operator would:**

1. Read what's broken: `SELECT * FROM failure`, `SELECT * FROM node WHERE state = 'failed'`, `SELECT * FROM part WHERE state != 'ok'`, plus `margin` and `decision`.
2. Call `diagnose_failure(nodes)` (as a `scheduler_agent` or `technician` identity), then read the newest row of `diagnosis`: classification, cause, at-risk nodes, who to send, and the one-line reason.
3. Optionally `safe_placement(...)` to find where the job can restart.

**Grading.** The answer key is the private `incident` table. An agent connected with its own identity can't read it. Read it as the owner with `spacetime sql --server local blast-radius "SELECT * FROM incident"` and compare `expect_classification`, `expect_cause` and `expect_send` with what the agent concluded. `test/lab.test.ts` checks that the engine itself gets all five right.

Diagnosis rules (DESIGN.md §5): a degraded or failed part above the node is the cause. Otherwise, a row-level part (PDU, CDU, leaf) shared with another failure in the last 2 h is the cause; the most specific one wins (the one with the fewest racks below it), and on a tie the one with no backup (the leaf). Central plant (UPS, utility, chillers, spines) sits above most of the hall, so sharing it counts for nothing. Anything else is isolated.

## The presenter's scenario

The control room's step list (DESIGN.md §10.2) now runs on the backend. Each step acts through the normal reducers as a scripted actor (Facility, Scheduler, Scheduler agent, Scheduler (naive), Cooling agent), so the decision feed and audit log read as if those agents had acted. `test/runner.test.ts` covers both modes, and `test/frontend-contract.test.ts` checks every step against the frontend's own mock engine, field by field.

| Reducer | Does |
| --- | --- |
| `scenario_start(mode)` | Clean demo hall at T+0, ready for step 1. `mode`: `naive` or `blast_radius` |
| `scenario_next(mode)` | Runs the next step. From the test bed (or the other mode) it starts a clean run first |
| `scenario_goto(mode, step)` | Reseeds and replays to step (0-based) in one transaction |
| `reset_demo()` | `scenario_start` in the current mode |
| `naive_restart(job, failed_node)` | What a scheduler does without Blast Radius: swap in the nearest free node, no diagnosis, no check |

The `scenario` table (one row) holds the mode, the step, the caption and the camera target; the view reads it. `bed` says what the hall holds: `demo`, `lab` (the test bed) or `scale`.

## The interlock by hand

Reducer names are snake_case on the CLI and camelCase in the client SDK (`conn.reducers.requestWork({...})`). Arguments are JSON values in parameter order:

```bash
DB="--server local blast-radius"
spacetime call $DB reset_demo                                                # clean hall (init loads the test bed)
spacetime call $DB set_part_state '"cdu-3"' '"degraded"'
spacetime call $DB report_node_failure '"node-417"'
spacetime call $DB diagnose_failure '["node-417"]'
spacetime call $DB safe_placement '"job-train-1"' 0 0 '[]' 1               # 1 = diagnosis id
spacetime call $DB restart_job '"job-train-1"' 1
spacetime call $DB request_protection '"job-train-1"' 0 '"restart-1"'
spacetime call $DB request_work '"facility_work"' '"cdu-4"' 0 0 false '"cool-1"'
spacetime sql  $DB "SELECT * FROM work"
spacetime sql  $DB "SELECT * FROM decision"
```

Your CLI identity is the admin, so it may call all of these, and every decision is attributed to it. To show separate actors, give each one its own identity (every SDK client gets one) and have it call `self_register(name, role, rows)`, or have the admin call `register_actor` with its identity. The control room registers itself as a shift lead this way. Open registration is a demo convenience; turn it off with `set_open_registration false` before anything real.

## Scopes: what each kind of work touches

Every request names a **kind** and a **target**. The kind decides the scope, which locks it claims, whether it can share nodes with running jobs, and what it takes offline.

| Kind | Category | Target | Scope | Runs alongside jobs? | Takes offline / effect on backup | Default |
| --- | --- | --- | --- | --- | --- | --- |
| `node_repair` | hardware | node | the node | No: drain it first | the node | 2 h |
| `rack_work` | hardware | rack | the rack (all 8 nodes) | No: drain the rack | every node in the rack | 4 h |
| `hot_aisle_work` | hardware | `ha-N` | the whole hot aisle (both rows, 32 racks) | Yes: nodes stay up | each rack in both rows loses one cooling feed of headroom | 3 h |
| `facility_work` | hardware | part | the part + every rack below it | Power/cooling: yes, the backup check decides. Leaf/spine: no | the part: racks below lose that feed; a switch takes its nodes off the network | 4 h |
| `switch_firmware` | software | leaf/spine | every node below the switch | No | the switch reboots; nodes below are unreachable | 1 h |
| `sw_online` | software | node, rack, `row-N`, job | those nodes | **Yes** (agent update, live patch, firmware staged for next reboot) | nothing | 30 min |
| `sw_exclusive` | software | node, rack, `row-N` | those nodes | **No: must run alone** (kernel/OS + reboot, GPU driver/CUDA, BIOS/BMC/NIC firmware) | the nodes | 90 min |

### The rules (DESIGN.md §4.4)

1. **Claims.** Work claims what it touches for its time window.
   - Hands-on hardware work claims **space** exclusively: a node, a rack or a hot aisle. A bigger claim covers everything inside it, so node work also takes an intent claim on its rack and aisle. A hot-aisle job therefore blocks any node or rack work in its two rows, and vice versa. Two node repairs in the same rack don't block each other.
   - Every kind of maintenance on a node claims the node's **service** exclusively: one maintenance item per node at a time, online or not.
   - A **running job or tenant** holds its nodes. `sw_online` and `hot_aisle_work` may share them; everything that takes a node or its network down needs it drained first.
   - Facility work claims the **part**.
   - Two claims conflict when their windows overlap, unless both are shared (protection + protection) or both are intent.
2. **Backup.** With every live lease that overlaps the window applied, the parts the work takes offline (or the hot aisle it opens) are removed and only the racks below them are recomputed. If any rack would go red, or a protected rack would drop below full backup, the request is denied. If a rack would be left one failure from an outage, the verdict is `warn`.
3. **Verdicts.** `allow` grants the lease (`active` now, or `granted` for later). `warn` waits in `needs_approval` until a shift lead calls `approve_work`, which re-checks the facility first. `deny` writes the reason and the **earliest safe time**: the first time the same work would pass, or "after CDU-3 repair" when it waits on a repair or a drain.
4. **Protection lease** (`request_protection`): a shared claim on the job's racks for its run. Hands-on work in those racks, and any work that drops their backup, is refused until it ends. Online updates still run.
5. **Simulated time.** Leases start and end as `advance_clock` moves time forward (they auto-expire). Core logic never reads the wall clock.

Example verdicts from the tests:

- `facility_work cdu-4` after CDU-3 degrades and the job is protected → **deny**: "CDU-4 is the only cooling feed for 5 racks (CDU-3 degraded); taking it offline makes them red. It would also drop 5 racks protected for job-train-1 below full backup." Earliest safe time: "after CDU-3 repair, and not before T+72h13m".
- `facility_work pdu-r3-b` while `pdu-r3-a` is out → **deny**, earliest safe time "T+4h (with shift lead approval)". The same request starting at T+4h is fine.
- `hot_aisle_work ha-5` → **warn**: "Opening Hot aisle 5 leaves 32 racks one failure from an outage". With a node repair in Row 9 → **deny** (the aisle covers the node's rack).
- `sw_exclusive rack-r3-07` → **deny**: "8 nodes in rack-r3-07 run job-train-1. Drain-required update can't run alongside jobs: drain them first." `sw_online job-train-1` → **allow**.

## Tables

All tables are public except `audit`, `actor`, `settings` and `incident`. Rows map one to one onto the view's types in `frontend/src/model/types.ts`; `frontend/src/live/mapping.ts` does the mapping:

| Frontend | Table |
| --- | --- |
| `Site.parts` / `partOrder` | `part` (sort by `ord`) |
| `Site.racks` / `rackOrder` | `rack` (sort by `ord`); `rowNum` is the frontend's `row`. Also `aisle` |
| `Site.nodes` / `nodeOrder` | `node` (sort by `ord`) |
| `Site.downstream` | `downstream` (one row per part → rack) |
| `World.now` | `clock.nowMin` (row id 0) |
| `World.partState` | `part.state`, or `'maintenance'` while `part.heldBy != 0` |
| `World.nodeState` | `node.state`, or `'maintenance'` while `node.heldBy != 0` |
| `World.owner` | `node.ownerKind` + `node.ownerId` |
| `World.margins` | `margin` (one row per rack, kept current by the backend) |
| `World.leases` | `work` rows with `status` `granted` or `active` (`kind = 'protection'` → `type: 'protection'`, `racks`, `job`) |
| `World.diagnosis` / `placement` | newest `diagnosis` / `placement` row |
| `World.job` | `job` |
| `World.deniedRequests` | count of `work` rows with `status = 'denied'` |
| `DecisionEvent[]` | `decision` (newest first by `seq`; `atMin` is the frontend's `time`, `focusKind` + `focusIds` its `focus`) |
| caption, step, mode, camera | `scenario` |

`claim` lists every live lock, so the view can outline locked racks, nodes and aisles. `failure` lists every node failure with its time. `work.ticket` is a caller-chosen id: an agent passes one with its request, then reads its verdict with `SELECT * FROM work WHERE ticket = '...'`.

## Reducers and roles

| Reducer (CLI name) | Who |
| --- | --- |
| `request_work(kind, target, start_in_min, duration_min, dry_run, ticket)` | technician: every kind · cooling_agent: `facility_work` on CDUs/chillers · scheduler_agent: `sw_online`, `sw_exclusive` · shift_lead, admin |
| `approve_work(id)`, `reject_work(id, note)` | shift_lead, admin |
| `release_work(id)` | whoever requested it, shift_lead, admin |
| `report_node_failure(node)` | scheduler_agent, facility, shift_lead, admin |
| `diagnose_failure(nodes)` | scheduler_agent, technician, shift_lead, admin |
| `safe_placement(job, needed, duration_min, exclude, diagnosis_id)`, `restart_job(job, placement_id)`, `naive_restart(job, failed_node)`, `request_protection(job, duration_min, ticket)` | scheduler_agent, shift_lead, admin |
| `set_part_state(part, state)`, `set_node_state(node, state)` | facility, shift_lead, admin |
| `advance_clock(minutes)` | shift_lead, admin |
| `scenario_start(mode)`, `scenario_next(mode)`, `scenario_goto(mode, step)`, `reset_demo()`, `seed_diagnostics()` | shift_lead, admin |
| `self_register(name, role, rows)` | anyone, while open registration is on (not admin) |
| `register_actor(identity, name, role, rows)`, `set_open_registration(open)`, `seed_scale_site(gpus)`, `claim_admin(name)` | admin (`claim_admin` only while there is none) |

Each SpacetimeDB identity is one actor: one key per human or agent, no shared keys. `rows` limits where an actor may act (empty = every row), and is checked before the safety check. A bad request (unknown identity, wrong role, unknown target) is rejected with an error and rolled back, so it shows up in `spacetime logs`. Every request that gets a verdict, including denials, is written to `work`, `decision` and the private, append-only `audit` table, which survives resets.

## Numbers (`npm run test:scale`, median of 20, simulated 100k-GPU site: 12,544 nodes, 1,568 racks)

| Operation | Measured | Limit |
| --- | --- | --- |
| diagnose_failure, one node | 0.03 ms | 50 ms |
| safe_placement, 1,000 nodes | 2.6 ms | 100 ms |
| simulate (CDU) | 0.12 ms | 20 ms |
| request_lease (node repair) | 0.06 ms | 20 ms |
| state change → incremental recompute | 0.03 ms | 50 ms |
| full rebuild | 15 ms | 1 s |

These time the core logic over in-memory indexes that match the tables' indexes. They don't include SpacetimeDB's own overhead.

## Known limits

- The SpacetimeDB layer (`src/index.ts`) type-checks against the `spacetimedb` 2.14 SDK source, and its reducers were run against a stand-in runtime. It hasn't run on a real SpacetimeDB server yet, so the first `spacetime publish` is its real test.
- The hot-aisle model is an assumption: open containment counts as losing one cooling feed of headroom for every rack in both rows.
- A request for a later window checks today's job placement and today's broken parts. There is no forecasting.
- Topology tables are public. Scoping who can read the map (DESIGN.md §9) needs SpacetimeDB views, which aren't built yet.
- `seed_scale_site` replaces the hall with a 98-row site; the 3D view only draws the 10-row demo hall, so keep the control room off a scale-seeded database.
- Multi-word column names may show up in snake_case in raw SQL (`expect_cause`, `row_num`). The client SDK uses camelCase.
