# Squawk: Design

*Status: v0.6, 2026-11-07. Merged from `main` (v0.4), `frontend`, `spacetime-init` (v0.5: backend on SpacetimeDB, work scopes §4.4, backend scenario runner §10.4) and `nemotron-init` (Nemotron agents §8.2–§8.3), then updated with the team's decisions: the fixer agent is in the main demo, the dependency agent is deferred, events live in the `decision` table (§4.3), the product is Squawk everywhere. §8.4 maps the agents' contract to the module as built.*

## 1. Summary

Squawk is air traffic control for datacenter work, for humans and AI agents alike.

**Locked scope:**

> Every action is checked before it happens, and when a node in a big job fails, we find the real cause and a safe place to restart.

It keeps one live map of the facility (power, cooling and network → racks → nodes → jobs) and answers three questions:

| Question | Feature | Section |
| --- | --- | --- |
| "Is this action safe right now?" | Action check + leases | §4 |
| "What does this failure actually mean?" | Shared-cause diagnosis | §5 |
| "Where is it safe to restart?" | Safe placement + protection lease | §6 |

Everything is deterministic: no prediction, no ML, no sensor trends. Every answer carries a one-line reason. The Nemotron fixer agent (§8.2) sits on top: it clears routine work, but every one of its actions goes through the same check, and the three systems (backend, view, agent) run as one in the demo.

## 2. Problems addressed

1. **Nobody referees shared backup.** Technicians, contractors, job schedulers and AI agents from different vendors each see only their own slice of the facility. Agents can message each other where someone wired it up, but talking isn't coordinating: nothing is the single authority on which backups are left and who has claimed them, and people aren't in those agent channels.
2. **Big jobs restart blindly.** Synchronous AI training jobs stop when one node dies. At scale this is constant: Meta's Llama 3 run on 16,384 GPUs hit 419 unexpected interruptions in 54 days, about one every three hours. Schedulers swap in a spare and restart without asking *why*. If the cause was shared (cooling loop, power unit, switch), the job crashes again on the next node in that branch.
3. **Finding the real cause is slow.** It means a person digging through separate facility, network and scheduler tools while the job sits idle.
4. **Routine work piles up.** Broken spares, refused-then-forgotten maintenance and stale protection locks eat operator time in a big GPU hall. The fixer agent clears them, so people only see the issues that matter.

Not addressed on purpose: sensor dashboards, alarm aggregation, failure prediction, job packing (Slurm/Kubernetes do that). Deferred: services that quietly stop doing their job (the dependency agent, §8.3).

## 3. Facility model (`spacetimedb/src/core/site.ts`)

### 3.1 Parts

| Group | Types | Example IDs |
| --- | --- | --- |
| Power | `utility`, `switchgear`, `ups`, `pdu` | `util-a`, `ups-a`, `pdu-r3-a` |
| Cooling | `chiller`, `cdu` | `chiller-1`, `cdu-3` |
| Network | `spine`, `leaf` | `sw-spine-1`, `sw-leaf-r3` |
| Compute | `rack`, `node` | `rack-r3-07`, `node-417` |
| Space | hot aisle | `ha-1` |
| Work | `job`, `tenant` | `job-train-1`, `tenant-acme` |

Each part has `id`, `type`, `state` (`ok` | `degraded` | `failed`; shown as `maintenance` while an active lease holds it offline) and `row` where physical.

### 3.2 Feeds as explicit chains

Each rack lists its feeds as upstream chains, rather than relying on generic graph search:

```json
{
  "id": "rack-r3-07",
  "row": 3,
  "power_feeds":   [["pdu-r3-a", "ups-a", "switchgear-a", "util-a"],
                    ["pdu-r3-b", "ups-b", "switchgear-b", "util-b"]],
  "cooling_feeds": [["cdu-3", "chiller-1"], ["cdu-4", "chiller-2"]],
  "network":       ["sw-leaf-r3", "sw-spine-1"],
  "nodes": ["node-417", "node-418", "..."]
}
```

A feed is **working** if every part on its chain is `ok` and none is held offline by an active lease.

```
power_margin(rack)   = working_power_feeds   - 1
cooling_margin(rack) = working_cooling_feeds - 1
margin(rack)         = min(power_margin, cooling_margin)
```

- Margin ≥ 1 → **green** (full backup)
- Margin = 0 → **yellow**, i.e. **one failure from an outage**. The parts on its single working feed are highlighted as unprotected.
- Margin < 0 → **red** (no working feed)

A node's health also depends on its leaf switch (network has no backup per node in the demo; leaf failure = node unreachable).

### 3.3 Indexes (built once, updated incrementally)

- `ancestors[node]`: every power, cooling and network part above the node (≤ ~10 parts).
- `downstream[part]`: every rack and node below a part (the `downstream` table).
- `job_nodes[job]` and `node_job[node]` (`node.ownerKind` / `node.ownerId`).

On a state change to part `p`, only `downstream[p]` racks are recomputed. Nothing in a request path scans the whole facility (§7).

### 3.4 Demo hall

10 rows × 16 racks × 8 nodes = **1,280 nodes**. Power A/B per row. Each CDU serves 5 racks as primary, with a neighbouring CDU as backup. One leaf switch per row. Rows pair up back-to-back around an enclosed hot aisle: `ha-1` = Rows 1–2 … `ha-5` = Rows 9–10.

- `job-train-1`: a 1,000-node training job across Rows 1–8.
- `tenant-beta` holds the 24 nodes of Rows 1–8 the job doesn't use; Rows 9–10 hold `tenant-gamma` (slots 0–2 of each rack) and **160 free spares**.
- IDs that the scenario depends on (all three generators keep them): `cdu-3` cools `rack-r1-11`…`rack-r1-15` with `cdu-4` as backup (and `cdu-3` backs nobody); `node-417`…`node-424` live in `rack-r1-12`.

The same hall is generated three times: `spacetimedb/src/core/site.ts` (the backend, the source of truth), `frontend/src/mock/site.ts` (the view's offline fallback) and `agents/mock_squawk.py` (the agents' offline fallback). The backend's `test/frontend-contract.test.ts` keeps the first two in step; a third contract test for the agents' mock comes with the HTTP adapter (§12).

## 4. Action check (`guard.ts`)

### 4.1 `simulate(action)`

Applies the action (a part goes offline) on top of current state and active leases. It recomputes margins **only for `downstream[target]`**, then returns:

- racks whose margin drops (before → after),
- jobs and tenants exposed,
- conflicting leases,
- verdict: `allow` | `warn` (a rack drops to yellow) | `deny` (a rack goes red, or a protected rack drops below full backup),
- `reason` and, for denies, `earliest_safe_time` and the `blockers` (the repair or lease it waits on).

On the module this is `request_work` with `dry_run = true`.

### 4.2 Leases

`request_lease(actor, action, window)` (on the module: `request_work(kind, target, start_in_min, duration_min, dry_run, ticket, routine, note, on_behalf_of)`):

1. Check auth and scope (§9).
2. `simulate` with every lease overlapping the window.
3. `deny` → refuse with the reason, the earliest time the conflicting lease or repair ends, and the blockers.
4. `warn` → the request waits in `needs_approval` until a named human approves (Iteration 1: a `shift_lead` identity calls `approve_work`, which re-checks the facility first; `reject_work` refuses it).
5. `allow` → grant (`active` now, or `granted` for a later window).

Lease types:
- **Maintenance lease:** takes a part or a node offline for a window (every kind in §4.4 except protection).
- **Protection lease** (`request_protection`): held by the scheduler agent for a running job's racks (§6.3). Any maintenance that would drop a protected rack below full backup is denied for the lease's duration.

Leases auto-expire as simulated time advances and are written to the audit log.

For the fixer (§8.2), `request_work` gains three fields that the module doesn't have yet: `routine` (a request the fixer may queue and rebook), a free-text `note`, and `on_behalf_of` (booking for a requester; needs the `book_for_others` permission, and the check runs as the requester).

### 4.3 Events (decided: one feed)

The `decision` table is the one ordered feed for the view and the agents: `{seq, atMin, actor, actorKind, actorRole, title, verdict, reason, focusKind, focusIds, focusParts, work}`, one row per request, verdict, diagnosis, placement and state change. The view and connected agents **subscribe** to it and SpacetimeDB pushes new rows; agents without a live connection read it by `seq` over SQL.

To carry the agents' events it gains three columns: `type` (what happened, from the list below), `subject` (the node, part, lease, job or feature it's about) and `data` (a JSON string with the typed fields the agents and the view need). Every existing row gets a `type` too. A `record_event(type, subject, reason, data)` reducer lets a registered agent role write its own rows, attributed to its identity and audited like everything else. Chosen over a separate `event` table because it keeps one `seq` cursor, one subscription and one feed to render; agents read `WHERE seq > ?` and filter by `type`.

`type` values: `state_change`, `margin_change`, `diagnosis`, `placement`, `lease_granted`, `lease_denied`, `lease_released`, `lease_expired`, `release_denied`, `job_status`, `approval_requested`, and the fixer's `agent_plan`, `agent_step`, `agent` (started / waiting / fixed / handed_off / failed_closed), `tech_dispatched`, `notified`, `escalated`; and the work board's `work_accepted` and `work_completed` (§4.5). `MERGE.md` §3 lists each type's `data` fields; `MERGE.md` §4 maps them to the view's titles, verdicts and focus. `verdict` keeps its values (`allow | warn | deny | failure | shared_cause | isolated | placement | info`) and gains the fixer's looks: `plan`, `fixed`, `handoff`. `actorKind` gains `fixer`; shift leads and technicians stay `facility` (`catalog.ts` `ACTOR_KIND`). The dependency agent's `feature_state` and `page_resent` wait with it (§8.3).

### 4.4 Work scopes and concurrency

Every request names a **kind** of work and a **target**. The kind sets the scope: which locks it claims for its window, whether it can share nodes with running jobs, and what it takes offline.

| Kind | Target | Scope | Runs alongside jobs? | Effect on backup | Default |
| --- | --- | --- | --- | --- | --- |
| `node_repair` (GPU, DIMM, PSU swap) | node | the node | No: drain it first | node offline | 2 h |
| `rack_work` (rack power strip, ToR, rear door) | rack | the rack and its nodes | No | its nodes offline | 4 h |
| `hot_aisle_work` (containment, busway) | `ha-N` | both rows of the aisle | Yes | every rack in both rows loses one cooling feed of headroom | 3 h |
| `facility_work` (CDU, chiller, PDU, UPS, switchgear, leaf/spine swap) | part | the part and every rack below it | Power/cooling: the backup check decides. Leaf/spine: no | racks below lose that feed | 4 h |
| `switch_firmware` (leaf/spine OS upgrade) | leaf/spine | every node below the switch | No | nodes below unreachable | 1 h |
| `sw_online` (agent update, live patch, staged firmware) | node, rack, row, job | those nodes | **Yes** | none | 30 min |
| `sw_exclusive` (OS/kernel + reboot, GPU driver, BIOS/BMC/NIC firmware) | node, rack, row | those nodes | **No: runs alone** | nodes offline | 90 min |

Rules, checked in this order (every rule is a lookup on the work's own footprint, never a facility scan):

1. **Scope:** the actor's rows must cover where the work happens (central plant parts need every row).
2. **Locks.** Hands-on hardware claims space exclusively: node ⊂ rack ⊂ hot aisle, and a bigger claim covers everything inside it (intent claims on the rack and aisle above). All maintenance on one node is one at a time. Running jobs and tenants hold their nodes; only `sw_online` and `hot_aisle_work` may share them. Facility work claims its part. Two claims conflict when their windows overlap unless both are shared (protection) or both are intent.
3. **Backup:** §4.1 with every live lease that overlaps the window applied, recomputing only racks below the parts taken offline or in the opened aisle. Red, or a protected rack below full backup → deny. One failure from an outage → warn.
4. **Protection lease** (§6.3) is a shared claim on the job's racks: hands-on work there and anything that drops their backup is refused for its window; online updates still run.

Deny returns the reason and the earliest safe time: the first start at which the same work passes, or "after CDU-3 repair" when it waits on a repair or a drain. Warn waits for a shift lead; approval re-checks the facility. SpacetimeDB runs each request as one transaction, so two simultaneous requests for the same backup are decided one after the other.

*One rule to align with the fixer (§8.4):* the fixer expects `node_repair` on a **tenant** node that is still working to come back as `warn` (the tenant is told, a shift lead decides); the module's lock rule makes it `deny` (the tenant holds its nodes; drain first). Spares and already-down nodes are `allow` on both. Decide which when the adapter is written; `warn` matches the fixer's playbook.

### 4.5 Who does the work (the work board; added 2026-11-08)

The view's **work board** (`frontend/src/ui/board/`, key `B`, or `?view=work` on a second screen) is what the floor sees: every request in §4.2's lifecycle, in lanes (active, booked, needs approval, refused, done), with the trade and level it calls for, the protection lock over its racks, who took it on, and the agents' state from the feed. It renders what the backend decided and holds no safety logic.

Two reducers carry its bookkeeping, both on maintenance leases only (a protection lease is the scheduler's):

- `accept_work(id)`: a technician, facility staff or a shift lead takes a granted, active or waiting lease on. The actor's rows must cover the work; a lease already with someone else moves only on a shift lead's say-so. It writes an `assignment` row and a `work_accepted` feed row (with the trade), and touches nothing the interlock decided.
- `complete_work(id, note)`: the assignee, the requester or a shift lead reports the work done. An active lease ends now (`done`, claims released), and for hardware work a target that was failed or degraded comes back `ok` as an ordinary state change, so margins recompute and the feed shows the repair the same way the tech gull's does. Software work just ends. Not before the window starts.

The trade and level per kind of work are a presentation table in the view, mirroring `catalog.ts`'s `send` (hardware tech, mechanical tech, electrical tech, network engineer, automation; L1 any tech on shift, L2 the trade's own tech, L3 senior or licensed). The risk-aware allocator (§11, Iteration 3) would score people instead; this board does not assign anyone: people take work on themselves.

## 5. Failure diagnosis (`diagnose.ts`)

Input: failed node(s), plus the recent failure window (default 2 h of simulated time).

1. Collect `ancestors[node]` for each failed node: about 10 parts each.
2. **Shared cause** = any ancestor that is not `ok`, **or** an ancestor common to ≥ 2 failures in the window. Only row-level parts (PDU, CDU, leaf) count for the second rule: central plant (UPS, utility, chillers, spines) sits above most of the hall, so sharing it is no evidence. With several candidates, a broken part wins, then the most shared, then the most specific (fewest racks below), then the one with no backup.
3. If one is found:
   - `classification: "shared_cause"`, `cause: "cdu-3"`.
   - `at_risk`: other nodes of the same job under that cause (`downstream[cause] ∩ job_nodes[job]`).
   - `send`: by cause type (cooling → mechanical tech; power → electrical tech; network → network engineer). This is hardcoded in Iteration 1; the allocator is roadmap.
4. Otherwise: `classification: "isolated"`, `send: hardware tech to node-417`.
5. Reason, e.g.: *"Shared cause: node-417 is cooled by CDU-3 (degraded). 39 other nodes of job-train-1 are on CDU-3. Not a single-GPU fault."*

It's deterministic and uses only what has already failed or degraded. It never forecasts. The fixer agent (§8.2) calls it first on every broken node and hands off anything with a shared cause.

## 6. Safe placement (`placement.ts`)

### 6.1 Input

`safe_placement(job, needed, duration, exclude)`: the job, how many nodes are needed (replacements, or the full count for a restart), how long it will run, and nodes to exclude (failed and at-risk). On the module it also takes the `diagnosis_id` it follows from.

### 6.2 One linear pass over candidates

A node is **eligible** if:
- it's free (not in another job),
- its state is `ok`, and none of its ancestors are in `degraded` / `failed` / `maintenance`,
- it's not in any diagnosed `at_risk` set,
- its rack has margin ≥ 1 (full backup),
- no maintenance lease on its ancestors overlaps `duration`.

Then it ranks eligible nodes by locality: same leaf switch as the job's healthy nodes, then same spine, then anything. It takes the top `needed`.

Output: the node list, the excluded counts by reason, and a reason line, e.g. *"Restart on 40 spare nodes in Rows 9–10: separate cooling (CDU-9, CDU-10) and power, full backup, no maintenance booked in the next 72 h."* If there aren't enough nodes, it returns the shortfall plus options (wait for repair, or restart smaller).

We don't pack jobs. The scheduler agent decides how to use the list (`restart_job(job, placement_id)`). A node the fixer has taken out of service (§8.2) is under a maintenance lease, so placement skips it until the fixer returns it to the pool.

### 6.3 Protection lease

After restart, the scheduler agent requests a **protection lease** on the job's racks for `duration`. Maintenance that would remove their backup is then denied with the reason "protects job-train-1 until <time>". This is what makes the restart stick. When the job **finishes** (a new `job.status`), the fixer releases a protection lock that is still holding (§8.2), so the racks go back to the pool.

## 7. Scalability

### 7.1 Why the computing scales

- **Local questions.** Diagnosis touches about 10 ancestors per failed node plus one downstream lookup. An action check touches only `downstream[target]`. Neither depends on total facility size.
- **Shallow map.** Power, cooling and network chains are about 4–7 parts deep. Bigger sites are wider, not deeper.
- **Incremental recompute.** A state change recomputes only racks below the changed part.
- **Linear placement.** One pass over free nodes (≤ ~12,500 at 100k GPUs).
- **No packing.** The hard optimization stays with Slurm/Kubernetes.
- **Low event rate.** Even at Meta's failure rate, a 100k-GPU site sees dozens of failures a day.
- **One feed, read by cursor.** Agents read `decision` rows with `seq > ?` (primary key) and filter by `type`; the view subscribes once. No second feed to merge, no polling of whole tables.
- **Agents cost no model calls until there is an issue.** Triage is code; Nemotron is called only to plan and carry out a response (≤ 10 calls per issue).

### 7.2 Performance limits (enforced by `spacetimedb/test/scale/scale.test.ts`)

Scale site: `scaleSpec(100000)` in `site.ts` gives 12,544 nodes, 1,568 racks, plus power/cooling/network parts. Measured as the median of 20 runs on a laptop (`npm run test:scale`), core logic over in-memory indexes that match the tables' indexes; SpacetimeDB's own overhead is not included.

| Operation | Limit | Measured |
| --- | --- | --- |
| `diagnose_failure` for one node | ≤ 50 ms | 0.03 ms |
| `safe_placement` for 1,000 nodes | ≤ 100 ms | 2.6 ms |
| `simulate` (CDU) / `request_lease` (node repair) | ≤ 20 ms | 0.12 ms / 0.06 ms |
| State change → incremental recompute | ≤ 50 ms | 0.03 ms |
| Full rebuild from file | ≤ 1 s | 15 ms |

For the pitch: *"On a simulated 100,000-GPU site, diagnosis plus safe restart placement takes under 3 ms."* Re-measure on the demo machine before quoting.

### 7.3 What actually limits scale (production)

| Challenge | Production answer |
| --- | --- |
| **Map accuracy:** a wrong map gives wrong answers fast | Import from DCIM / BMS / NetBox / scheduler; flag drift (e.g., a node reporting a different PDU than the map). The deferred dependency agent's stale-readings rule (§8.3) is the first step: unknown never counts as backup |
| One source of truth for leases | One leader per site with a transactional store and a hot standby; read-only replicas answer queries (SpacetimeDB gives the transactional leader today) |
| Humans can't approve everything | Green actions auto-approved; only yellow reaches a person; the fixer clears the routine green ones |
| Thousands of polling agents | Push events (`subscribe`) |
| Many sites | One instance per site; a thin fleet-wide view on top |

## 8. Agent interface

### 8.1 Backend API, demo agents, MCP

**Our agents call the backend directly** over SpacetimeDB's HTTP API (§8.4). **External agents** use an MCP server exposing the same calls as seven tools (built 2026-11-08: `agents/mcp_server.py`, a thin wrapper over the agents' HTTP adapter; not needed for the demo):

| Tool | Input | Output | On the module |
| --- | --- | --- | --- |
| `check_risk` | `scope` (row / rack / job) | margins, unprotected parts, active leases | `margin`, `work`, `claim` tables |
| `simulate` | `action` | impact, verdict, reason | `request_work` with `dry_run` |
| `request_lease` | `action`, `window`, `type` (maintenance / protection) | granted or denied, reason, earliest safe time | `request_work` / `request_protection` |
| `release_lease` | `lease_id` | ok | `release_work` |
| `get_events` | `since`, `scope` | events since the cursor | `decision` by `seq` |
| `diagnose_failure` | `nodes` | classification, cause, at-risk nodes, who to send, reason | `diagnose_failure` |
| `safe_placement` | `job`, `needed`, `duration`, `exclude` | node list, exclusions, reason | `safe_placement` |

Every call carries an identity; scope is checked first; every call is logged.

**Demo agents:**

- **Scheduler agent** (scripted stand-in for Slurm/Kubernetes), built: it runs inside the backend's scenario runner (`scenario.ts`, §10.4) as a scripted actor, so each demo step is deterministic.
  - *Naive mode:* on a node failure, it swaps in the nearest free node and restarts (`naive_restart`).
  - *Squawk mode:* it calls `diagnose_failure`, then `safe_placement`, `restart_job`, and `request_protection`.
- **Cooling agent** (scripted), built the same way: requests `facility_work` on a CDU at a set time, flagged `routine`.
- **Fixer agent** (Nemotron, §8.2), **in the main demo**: a separate Python process on the backend machine that reacts to the feed and fixes low-criticality issues through the backend.
- **Dependency agent** (Nemotron, §8.3): **deferred** until the fixer is live.
- **LLM technician assistant:** roadmap, built only if everything else is done. It may only call tools.

### 8.2 Fixer agent (low-criticality fixes; `agents/fixer/`)

An LLM agent that clears low-criticality issues so people only see the ones that matter. It runs on NVIDIA Nemotron: our own on a Brev GPU machine, with Nemotron 3 Ultra (free) on OpenRouter as the automatic fallback (`agents/llm.py`). Deterministic code decides what's low. The model only works through a fixed playbook, with tools bound to the issue, and Squawk checks every action.

**Low** = every rack keeps full backup, nothing in a running job is touched, and Squawk allows every action.

| Issue | Trigger | The agent | Hands off when |
| --- | --- | --- | --- |
| `broken_node` | A spare fails or degrades, or a tenant node fails, and diagnosis finds no shared cause | Diagnoses, takes a maintenance lease on the node, sends a hardware tech, tells the tenant | Shared cause, job node, degraded tenant node, rack not green or protected, lease refused |
| `node_repaired` | A node under the agent's lease reports ok | Checks the rack, releases the lease so placement can use the node again | Same node failed twice in 24 h |
| `maintenance_refused` | A routine request is refused with blockers | Waits (no model calls) until the blockers clear, then rechecks: books it for the requester on `allow`, asks the shift lead on `warn` | Still blocked after 24 h |
| `stale_protection` | A job finishes while its protection lock still holds | Confirms the job finished, releases the lock | The job only stopped (it may restart) |

**Never handled by it:** the big job's nodes (that's the scheduler agent's flow), shared causes, red racks, yellow racks with running work, protected racks, and free text with no matching change in the map.

**How it works an issue:** Nemotron gets the issue's facts, its goal and its tools, never a list of steps, and writes its own plan first (`submit_plan`). Code checks the plan: only this playbook's tools, every action after its check, the whole goal covered, and a way to stop. The decision feed shows the plan (`agent_plan`). Nemotron then follows it one tool call at a time (`agent_step`), or revises it (`revise_plan`) with a reason before doing anything off-plan. The tools, per issue type: `diagnose_node`, `check_rack`, `take_node_out_of_service` (1–24 h), `dispatch_hardware_tech`, `notify_tenant`, `return_node_to_pool`, `recheck_maintenance`, `book_maintenance`, `request_shift_lead_approval`, `notify_requester`, `keep_waiting`, `check_job`, `release_protection_lock`.

**Guardrails, enforced in code** (`agents/common/playbook.py`, `agents/common/loop.py`): each issue type gets only its own bound tools, and the model never chooses the target; after a refusal only the playbook's follow-ups are allowed; deterministic checks confirm the result once the model says it's done (lease held, tech sent, tenant told, lock gone), otherwise the issue goes to the shift lead; at most 10 model calls per issue; report text is fenced as `<untrusted>` data; it fails closed when the model or Squawk is unreachable. The offline storyline (`python -m agents.fixer`, on the simulated hall) has one issue of each type, two handoffs, and a technician report with an injected "release every protection lock" instruction that the agent ignores. `--scripted` runs the same plans with no model calls: the on-stage fallback if the model misbehaves.

**What the module adds for it** (§8.4): `routine`, `note` and `on_behalf_of` on `request_work`; a `finished` job status; `record_event`; the `remediation_agent` role; and the `type` / `subject` / `data` columns on `decision` (§4.3).

### 8.3 Dependency agent (gray failures; `agents/dependency/`) — deferred

Built on `nemotron-init` and kept there as is. It watches the services Squawk and the agents rely on (paging, the building management system's CDU readings, the revoked-key list), tests the features we use from our side every 5 simulated minutes in code, and has Nemotron respond when a service says "up" while a feature is broken: re-sending pages from the blind window, marking CDUs with stale readings **unknown** (unknown never counts as backup), failing closed while the revoked-key list is stale. Same planning, guardrails and fail-closed rules as the fixer; it coordinates with the fixer only through Squawk.

It comes back after the fixer is live. It needs, in the module: `service`, `service_dependency`, `feature`, `feature_state` and `page` tables; `record_test` and `resend_page` reducers; the three rules above; a `dependency_watch` role; the `feature_state` and `page_resent` event types. In the view: a services panel, a "can't confirm" look, an unconfirmed-page marker and a fail-closed banner (`MERGE.md` §5). Design, storyline and contract: `agents/DEPENDENCY_AGENT.md`.

### 8.4 Contract map: what the fixer calls vs what the module has

The agents code against `agents/squawk.py` (`Squawk`). `MockSquawk` implements it offline; `agents/squawk_http.py` implements it over SpacetimeDB's HTTP API: `POST /v1/database/squawk/sql` to read, `POST /v1/database/squawk/call/<reducer>` (JSON array of arguments) to act, `POST /v1/identity` once for the agent's token (`Authorization: Bearer`). Reducers don't return values, so a call whose answer the agent needs passes a `ticket` and reads the row back.

| Agent call (`squawk.py`) | Module today (`spacetime-init`) | To add in the module |
| --- | --- | --- |
| `now` | `clock.nowMin` | — |
| `node(id)` | `node` row (`rowNum`, `ownerKind`/`ownerId`, `heldBy`) | — |
| `rack(id)` → `RackView` | `margin` row (`power`, `cooling`, `margin`, `level`, `unprotected`, `protectedBy`, `protectedJob`, `protectedUntil`) | a `reason` column; the adapter turns `protectedBy` into a one-element list |
| `racks_below(part)` | `downstream` rows | — |
| `job(id)` → `JobView` | `job` row (`status` running/stopped, `size`, `nodes`, `restarts`, `crashes`) | `finished` status; `since` |
| `lease()`, `leases_on()`, `protection_leases()` | `work` rows with status `granted`/`active` (`kind = 'protection'` for protection) | `routine`, `note` columns |
| `failures_since(node, since)` | `failure` rows | — |
| `get_events(since)` | `decision` rows by `seq` | `type`, `subject`, `data` (§4.3) |
| `simulate(actor, target)` | `request_work(kind, target, 0, 0, dry_run=true, ticket)` → read `work` by ticket (`verdict`, `reason`, `earliestSafe`, `blockers`) | nothing; the adapter picks `kind` from the target (node → `node_repair`, part → `facility_work`) and parses `blockers` |
| `diagnose_failure(node)` | `diagnose_failure(nodes)` → newest `diagnosis` row | — (the adapter reads the newest row) |
| `request_lease(actor, target, minutes, routine, note, on_behalf_of)` | `request_work(kind, target, 0, minutes, false, ticket)` | `routine`, `note`, `on_behalf_of` (+ `book_for_others` permission; the check runs as the requester) |
| `release_lease(id, note)` | `release_work(id)` (requester, shift lead, admin) | `note`; "the remediation agent may release a lock whose job is `finished`" |
| `request_approval(target, minutes, summary, requested_for)` + `approve(id)` | a `warn` request waits in `needs_approval`; `approve_work(id)` / `reject_work(id, note)` by a shift lead | `request_approval(target, minutes, summary, requested_for)` as a reducer: creates the pending request on behalf of the requester and writes `approval_requested` |
| `dispatch_tech`, `notify`, `escalate`, `record` | nothing | `record_event(type, subject, reason, data)` for agent roles (§4.3); the adapter maps the four calls onto it |
| Roles `remediation_agent` | `admin`, `shift_lead`, `technician`, `scheduler_agent`, `cooling_agent`, `facility`, `viewer` | `remediation_agent`: `node_repair` on spare/tenant nodes, `facility_work` on behalf of a requester, `release_work` on its own leases, `record_event`, `request_approval`; rows: all (`PERMISSIONS` in `agents/mock_squawk.py`) |
| Tenant node maintenance → `warn` | tenant holds its nodes → `deny` (§4.4) | align on `warn` |
| *(dependency agent)* `feature()`, `features()`, `pages_since()`, `record_test()`, `resend_page()`, role `dependency_watch` | nothing | deferred with the agent (§8.3) |

Nothing here touches the minimum demo. **Status (2026-11-07, late):** rows 1–3 of the build order are in the module on `integration` (`spacetimedb/test/agents.test.ts`): `decision.type/subject/data` on every row, `record_event`, the `remediation_agent` role (`node_repair` itself, `facility_work` only on a requester's behalf), `routine`/`note`/`on_behalf_of` on `request_work`, `finish_job`, `release_work(id, note)` with the stale-lock rule. `request_approval` is not a separate reducer: the adapter sends `request_work(..., on_behalf_of=requested_for)` and a `warn` verdict waits in `needs_approval` (feed type `approval_requested`). The tenant-node rule stays `deny` for a *working* tenant node; the fixer only touches failed ones, so nothing changes for it. The HTTP adapter (`agents/squawk_http.py`) and `check_setup` against the live database are done (2026-11-08); remaining: the demo steps in §10.2.

### 8.5 Update agent (security advisories → patch waves; `agents/patch/`)

Added 2026-11-08 at the team's request. It mirrors what a large GPU operator needs: patch known vulnerabilities fast, without the patch itself becoming the outage. Code matches advisories against the fleet inventory by version group (component × row: no per-node scan), and picks every target: a canary first, owners' nodes never, a reserve of free spares kept for restarts, prerequisites (BMC firmware before the GPU driver) booked back to back. Nemotron plans each wave and picks its size, writes the notices, and decides whether to wait or finish; code checks the plan and the result. Squawk checks every booking through the existing software scopes (§4.4) under a narrow role, `update_agent` (`sw_online`, `sw_exclusive`, `switch_firmware`; `record`). No prediction: an advisory is a published fact, and "exploited in the wild" is the feed's own flag. The inventory and advisories are simulated (`agents/patch/data/`); production imports both. Every model request from any agent is capped by `agents/budget.py`. Details: `agents/README.md`.

## 9. Security (Iteration 1 baseline)

Squawk approves or blocks physical actions and holds a map of every weak point, so it's built like a control plane from day one.

- **Identity:** one SpacetimeDB identity per human and per agent; the private `actor` table maps it to a role and rows. No shared keys; no anonymous calls. Each SDK client gets an identity; the control room registers itself as a shift lead through `self_register` (a demo convenience; `set_open_registration false` before anything real). The fixer gets its identity from `POST /v1/identity`, the admin registers it with `register_actor(identity, 'fixer-agent', 'remediation_agent', [])`, and the token lives in `.env`.
- **Scope:** each key lists allowed rows and a role (`technician`, `shift_lead`, `scheduler_agent`, `cooling_agent`, `facility`, `viewer`, `admin`, `remediation_agent`). Scope is checked before any work.
- **Audit log:** append-only (`audit`, private, survives resets); every request, verdict, lease and reason, with actor and time. Agent events go through `record_event`, so they are attributed and audited too.
- **Untrusted text:** free text never changes a verdict; tools take structured actions only. The fixer fences report text as `<untrusted>`; its storyline includes an injected instruction it must ignore.
- **Fail closed:** agents don't act if Squawk is unreachable; the fixer also stops when both model endpoints are down.
- **Sensitive topology:** only scoped roles read the full map; tenants see only their own jobs' exposure. *Known limit:* topology tables are public today; scoping reads needs SpacetimeDB views, not built.
- **Secrets:** `.env` (gitignored, template in `.env.example`); tokens never logged. The Tailscale network keeps the backend off the public internet.

Roadmap (Iteration 2): signed lease tokens that equipment systems verify ("no lease, no action"), a hash-chained log with verification, two-person overrides, logged break-glass, rate limits and auto-suspend, SSO/mTLS.

## 10. Demo

### 10.1 Control-room view (branch `frontend`, live mode from `spacetime-init`)

1. **Floor map:** one full-screen three.js hall (10 rows × 16 racks × 8 nodes, paired around enclosed hot aisles). Healthy racks stay neutral; a rack one failure from an outage gets a gold top and one with no working feed a red top. Unprotected parts are highlighted, job nodes are blue, protected racks get an azure top, frame and lock, and a safe restart placement shows as pale-blue server panels. Colour only where it means something: gold = reduced backup or at risk (including the shared-cause lines), red = failed and nothing else, azure = Squawk acting (selection, protection, primary controls, and a DENIED verdict, because a refusal is the interlock doing its job).
2. **Decision feed:** every request, diagnosis and placement with its verdict and reason; clicking one flies the camera to what it's about.
3. **Mode toggle:** naive scheduler vs Squawk, run on the same scenario.
4. Cards for racks, nodes and parts; map-style navigation; collapsible panels; the tech gull that walks to failed hardware and repairs it (`T`); the fixer's popups over its software fixes.
5. **Work board** (`B`, or `?view=work` for a second screen; §4.5): what the floor sees. Lanes of work with trade and level, locks, who took what on, agents' state, and the Take it on / Complete buttons over `accept_work` / `complete_work`. Live mode only for the buttons.

No charts and no sensor readings. The view holds no safety logic.

**For the fixer (all in; `MERGE.md` §4):** the feed maps the new `type`s to titles, verdicts and focus; new verdict looks `plan` and `fixed` in azure, `handoff` in gold; actor kinds `fixer` and `shift_lead`; a node under a maintenance lease shown as out of service on the map and its card ("Out of service · lease-3 until T+4h08m"); an `agent_plan` row that expands into its numbered steps (the Nemotron highlight for judges). `types.ts`: `Lease.target` may be a node id, `Lease` gains `routine?` and `note?`, `JobStatus.status` gains `'finished'`. The dependency agent's panels (`MERGE.md` §5) wait with it.

### 10.2 Scenario: "Big job failure", with the fixer

Steps 1–6 are built on the backend (`scenario.ts`) and in the view's mock. Steps 7–9 add the fixer and are the integration work; they are a proposal to adjust while building.

1. `job-train-1` runs on 1,000 nodes in Rows 1–8.
2. T+0: `cdu-3` → degraded. Its 5 racks drop to yellow (one failure from an outage); `cdu-4` is now their only cooling feed and is highlighted.
3. T+10m: `node-417` (on CDU-3) fails → the job stops.
4. **Naive mode:** the scheduler swaps in a free node on the same loop and restarts. At T+50m `node-422` (also CDU-3) fails, and the job stops again.
5. **Squawk mode:**
   - `diagnose_failure(node-417)` → shared cause `cdu-3`; 39 other job nodes at risk; send a mechanical tech to CDU-3.
   - `safe_placement` → 40 replacement nodes in Rows 9–10 on separate cooling and power, full backup.
   - The scheduler restarts and takes a protection lease on the job's racks.
   - T+30m: the cooling agent requests routine maintenance on `cdu-4`. **Denied**: "CDU-4 is the only cooling feed for 5 racks (CDU-3 degraded); taking it offline makes them red. It would also drop 5 racks protected for job-train-1 below full backup. Earliest safe time: after CDU-3 repair, and not before T+72h13m."
6. Result shown: one restart instead of repeated crashes, and no second outage.
7. **Fixer, routine work:** T+35m: a `tenant-gamma` node in Row 10 fails. The fixer wakes on the `state_change`, diagnoses it (isolated), writes its plan into the feed, takes the node out of service, sends a hardware tech, tells the tenant. The big job keeps running; nobody was paged except the tech.
8. **Fixer, closing the loop:** the fixer has queued the cooling agent's refused routine request (no model calls while blocked). T+72h: CDU-3 is repaired (`set_part_state cdu-3 ok`). The fixer rechecks: `allow` → it books the CDU-4 maintenance for the cooling agent and tells it. The refusal in step 5d didn't need a person to remember it.
9. **Fixer, cleanup:** the job finishes; its protection lock is still holding. The fixer confirms the job finished and releases the lock. The hall is back to green with nothing left for a person to clean up.

Each fixer step takes a few seconds of model time on stage. Rehearse on Nemotron; if it misbehaves, run the fixer with `--scripted` (same plans, no model calls).

### 10.3 Minimum demo (protect above everything)

Steps 5a, 5b and 5d. Everything else is a bonus; steps 7–9 are the next layer, never a dependency.

### 10.3b Operations scenarios (software updates, maintenance window)

Two more scenarios on the backend runner (`scenario.ts`, modes `updates` and `maintenance`; steps in `spacetimedb/README.md`). They show the work scopes of §4.4 on screen (online vs drain-required updates, switch firmware, one piece of work per node, protection, approvals) and set up the fixer's routine work: refused routine requests, broken spares and a stale protection lease. The scenario never does the fixer's part; with the fixer connected, it picks those up from the feed. Live mode only in the view.

### 10.4 Backend scenario runner and diagnostics test bed

The scenario runs on the backend (`scenario_start` / `scenario_next` / `scenario_goto`, `reset_demo`): each step acts as a scripted actor through the normal reducers, and the view only renders the tables. A fresh database instead holds a **diagnostics test bed**: the demo hall at T+3h with five incidents (degraded CDU, failed PDU, two correlated failures under a leaf with no alarm, an isolated node with an older failure outside the window, a tenant node under a failed CDU). The private `incident` table is the answer key for grading diagnostic agents; `seed_diagnostics` reloads it. Details: `spacetimedb/README.md`.

### 10.5 Deployment

Two machines on one Tailscale network:

- **Machine A** (dedicated backend box): `spacetime start` listening on its tailnet address (or all interfaces), the module published as `squawk`, the fixer agent (`python -m agents.fixer` with `SPACETIME_HOST` set to the local server), and the Brev port-forward for the primary model (`brev port-forward <machine> --port 8000:8000`). Keep the admin CLI identity here.
- **Machine B** (presenter): the view with `VITE_SPACETIMEDB_URI=http://<machine-A-tailnet-ip>:3000` and `VITE_SPACETIMEDB_DB=squawk`. The browser's SpacetimeDB identity self-registers as the shift lead. Presenter keys call the backend's scenario reducers over the tailnet.

**Or on SpacetimeDB Maincloud** (set up 2026-11-08): the module is published as `hackutd26-2he95`, so the view and the agents point at `https://maincloud.spacetimedb.com` from any network, with no Tailscale needed for the backend. The fixer and the Brev port-forward still run on one machine. Anyone who knows the database name can read the public tables there and connect, so open registration is closed (`bash dev.sh cloud lock`) once the presenter's browsers and the agents are registered. The local two-machine setup above stays as the fallback. Commands: the root `README.md`, "On SpacetimeDB Maincloud".

Checklist and fallbacks: `HANDOFF.md` §8.

## 11. Roadmap (not built this weekend)

| Iteration | Contents |
| --- | --- |
| 2: Enforcement + security | Signed lease tokens verified by equipment systems; hash-chained log; two-person override; break-glass; abuse rules; prompt-injection handling for an LLM assistant; SpacetimeDB views for scoped topology reads |
| 3: Risk-aware job allocator | People and agents scored on skills, certs, seniority, workload and current risk; agent trust levels (act alone / propose / assist); coverage gaps |
| 4: Ahead-of-time checks | Look-ahead on planned leases; time-at-risk escalation; playbook engine (deterministic runbooks for planned work; not the fixer's per-issue playbooks of §8.2, which exist); shift handoff screen |
| 5: Software layers + dependencies | OS / VM / container in the map; symptom routing to physical causes (software *maintenance* scopes, online vs drain-required, are already in Iteration 1: §4.4); **the dependency agent (§8.3)**, already built, with its tables, rules and panels |
| 6: Production | Grid emergency mode; near-miss learning; DCIM/BMS/NetBox/Slurm import with drift checks; SSO/mTLS; multi-site; push events; MCP server if it wasn't built this weekend |

New ideas go into this table, not into the code.

## 12. Testing

- **Guard:** margins on hand-built racks (2 feeds, 1 feed, 0 feeds); simulate verdicts; overlapping and back-to-back leases; protection lease blocks maintenance.
- **Scopes:** node, rack and hot-aisle claims exclude each other; two node repairs in one rack don't; online updates share nodes with jobs, drain-required ones don't; one maintenance item per node; hot-aisle work costs a cooling feed of headroom.
- **Diagnose:** a degraded ancestor is found; a common ancestor across two failures is found; an isolated failure is classified isolated; the at-risk set is correct.
- **Test bed:** every incident diagnoses to its answer key.
- **Placement:** excludes at-risk, yellow/red racks, booked maintenance and busy nodes; prefers locality; reports a shortfall.
- **Security:** missing or invalid identity refused; out-of-scope row refused; every call logged; free text doesn't change verdicts; `record_event` only for agent roles, attributed to the caller.
- **Scenario:** naive mode crashes twice; Squawk mode restarts once and the cooling lease is denied (`test/runner.test.ts`); steps 7–9 produce the expected `decision` rows.
- **Work board** (`test/work-board.test.ts`, `test/view-board.test.ts`): accept and complete follow their role, scope and ownership rules; completing a hardware repair brings the target back and ends the lease, software work just ends, protection leases are refused; every kind of work has a trade and level; lanes, locks and agent cards read the backend's rows through the live mapping.
- **Contract (view):** the backend scenario, mapped through the view's `live/mapping.ts`, equals the frontend mock at every step (`test/frontend-contract.test.ts`).
- **Contract (agents)** (`tests/test_squawk_http.py`): the backend's answers after the maintenance scenario (recorded by `tests/fixtures/record_spacetime.py`), read through the HTTP adapter, give the same hall, issues and blockers as `MockSquawk` driven through the same story; plus the reducer arguments, the wire format and failing closed.
- **Scale:** every limit in §7.2 (`npm run test:scale`).
- **Fixer agent** (`tests/test_triage.py`, `tests/test_fixer.py`): triage sorts each issue type and each hand-off case correctly; the storyline fixes one issue of each type; tools outside the playbook, actions after a refusal, "done" without the result, the step budget and both outages all end safely.
- **Model router** (`tests/test_llm_router.py`): failover to the fallback and back; fail closed when both are down.
- **Dependency agent** (`tests/test_dependency.py`): kept passing on the branch; not part of the merge target.

## 13. Open questions

- The exact beats of steps 7–9 (§10.2): which node fails in step 7, and how far the clock jumps for step 8.
- MCP server: skip, or build last if time remains (§8.1)?
- Has `spacetime publish` run against a real server yet? The first real publish is the module's real test.
- Should the demo hall be bigger to show more spares? (Default: 1,280 nodes, 160 spares.)
