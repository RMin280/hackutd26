# Blast Radius: Design

*Status: v0.5, 2026-11-07. Locked scope, big-job failure story, scalability built in. Backend on SpacetimeDB; work scopes and concurrency rules added (§4.4).*

## 1. Summary

Blast Radius is air traffic control for datacenter work, for humans and AI agents alike.

**Locked scope:**

> Every action is checked before it happens, and when a node in a big job fails, we find the real cause and a safe place to restart.

It keeps one live map of the facility (power, cooling and network → racks → nodes → jobs) and answers three questions:

| Question | Feature | Section |
| --- | --- | --- |
| "Is this action safe right now?" | Action check + leases | §4 |
| "What does this failure actually mean?" | Shared-cause diagnosis | §5 |
| "Where is it safe to restart?" | Safe placement + protection lease | §6 |

Everything is deterministic: no prediction, no ML, no sensor trends. Every answer carries a one-line reason.

## 2. Problems addressed

1. **Nobody referees shared backup.** Technicians, contractors, job schedulers and AI agents from different vendors each see only their own slice of the facility. Agents can message each other where someone wired it up, but talking isn't coordinating: nothing is the single authority on which backups are left and who has claimed them, and people aren't in those agent channels.
2. **Big jobs restart blindly.** Synchronous AI training jobs stop when one node dies. At scale this is constant: Meta's Llama 3 run on 16,384 GPUs hit 419 unexpected interruptions in 54 days, about one every three hours. Schedulers swap in a spare and restart without asking *why*. If the cause was shared (cooling loop, power unit, switch), the job crashes again on the next node in that branch.
3. **Finding the real cause is slow.** It means a person digging through separate facility, network and scheduler tools while the job sits idle.

Not addressed on purpose: sensor dashboards, alarm aggregation, failure prediction, job packing (Slurm/Kubernetes do that).

## 3. Facility model (`spacetimedb/src/core/site.ts`)

### 3.1 Parts

| Group | Types | Example IDs |
| --- | --- | --- |
| Power | `utility`, `switchgear`, `ups`, `pdu` | `util-a`, `ups-a`, `pdu-r3-a` |
| Cooling | `chiller`, `cdu` | `chiller-1`, `cdu-3` |
| Network | `spine`, `leaf` | `sw-spine-1`, `sw-leaf-r3` |
| Compute | `rack`, `node` | `rack-r3-07`, `node-417` |
| Work | `job`, `tenant` | `job-train-1`, `tenant-acme` |

Each part has `id`, `type`, `state` (`ok` | `degraded` | `failed` | `maintenance`) and `row` where physical.

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
- `downstream[part]`: every rack and node below a part.
- `job_nodes[job]` and `node_job[node]`.

On a state change to part `p`, only `downstream[p]` racks are recomputed. Nothing in a request path scans the whole facility (§7).

### 3.4 Demo hall

10 rows × 16 racks × 8 nodes = **1,280 nodes**. Power A/B per row. Each CDU serves 5 racks as primary, with a neighbouring CDU as backup. One leaf switch per row. Rows pair up back-to-back around an enclosed hot aisle: `ha-1` = Rows 1–2 … `ha-5` = Rows 9–10.

- `job-train-1`: a 1,000-node training job across Rows 1–8.
- Other tenants fill some remaining nodes; about 150 spares are available in Rows 9–10 and scattered elsewhere.

## 4. Action check (`guard.ts`)

### 4.1 `simulate(action)`

Applies the action (a part goes offline) on top of current state and active leases. It recomputes margins **only for `downstream[target]`**, then returns:

- racks whose margin drops (before → after),
- jobs and tenants exposed,
- conflicting leases,
- verdict: `allow` | `warn` (a rack drops to yellow) | `deny` (a rack goes red, or a protected rack drops below full backup),
- `reason` and, for denies, `earliest_safe_time`.

### 4.2 Leases

`request_lease(actor, action, window)`:

1. Check auth and scope (§9).
2. `simulate` with every lease overlapping the window.
3. `deny` → refuse with the reason and the earliest time the conflicting lease or repair ends.
4. `warn` → grant only with a named human approval (Iteration 1: a `shift_lead` key).
5. `allow` → grant.

Lease types:
- **Maintenance lease:** takes a part offline for a window.
- **Protection lease:** held by the scheduler agent for a running job's racks (§6.3). Any maintenance that would drop a protected rack below full backup is denied for the lease's duration.

Leases auto-expire and are written to the audit log.

### 4.3 Events

Ordered list (the `decision` table): `{seq, atMin, actor, title, verdict, reason, focus}`, one row per request, verdict, diagnosis, placement and state change. The view and connected agents **subscribe** to it and SpacetimeDB pushes new rows; agents without a live connection read it by `seq`.

### 4.4 Work scopes and concurrency

Every request names a **kind** of work and a **target**. The kind sets the scope: which locks it claims for its window, whether it can share nodes with running jobs, and what it takes offline.

| Kind | Target | Scope | Runs alongside jobs? | Effect on backup |
| --- | --- | --- | --- | --- |
| `node_repair` (GPU, DIMM, PSU swap) | node | the node | No: drain it first | node offline |
| `rack_work` (rack power strip, ToR, rear door) | rack | the rack and its nodes | No | its nodes offline |
| `hot_aisle_work` (containment, busway) | `ha-N` | both rows of the aisle | Yes | every rack in both rows loses one cooling feed of headroom |
| `facility_work` (CDU, chiller, PDU, UPS, switchgear, leaf/spine swap) | part | the part and every rack below it | Power/cooling: the backup check decides. Leaf/spine: no | racks below lose that feed |
| `switch_firmware` (leaf/spine OS upgrade) | leaf/spine | every node below the switch | No | nodes below unreachable |
| `sw_online` (agent update, live patch, staged firmware) | node, rack, row, job | those nodes | **Yes** | none |
| `sw_exclusive` (OS/kernel + reboot, GPU driver, BIOS/BMC/NIC firmware) | node, rack, row | those nodes | **No: runs alone** | nodes offline |

Rules, checked in this order (every rule is a lookup on the work's own footprint, never a facility scan):

1. **Scope:** the actor's rows must cover where the work happens (central plant parts need every row).
2. **Locks.** Hands-on hardware claims space exclusively: node ⊂ rack ⊂ hot aisle, and a bigger claim covers everything inside it (intent claims on the rack and aisle above). All maintenance on one node is one at a time. Running jobs and tenants hold their nodes; only `sw_online` and `hot_aisle_work` may share them. Facility work claims its part. Two claims conflict when their windows overlap unless both are shared (protection) or both are intent.
3. **Backup:** §4.1 with every live lease that overlaps the window applied, recomputing only racks below the parts taken offline or in the opened aisle. Red, or a protected rack below full backup → deny. One failure from an outage → warn.
4. **Protection lease** (§6.3) is a shared claim on the job's racks: hands-on work there and anything that drops their backup is refused for its window; online updates still run.

Deny returns the reason and the earliest safe time: the first start at which the same work passes, or "after CDU-3 repair" when it waits on a repair or a drain. Warn waits for a shift lead; approval re-checks the facility. SpacetimeDB runs each request as one transaction, so two simultaneous requests for the same backup are decided one after the other.

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

It's deterministic and uses only what has already failed or degraded. It never forecasts.

## 6. Safe placement (`placement.ts`)

### 6.1 Input

`safe_placement(job, needed, duration, exclude)`: the job, how many nodes are needed (replacements, or the full count for a restart), how long it will run, and nodes to exclude (failed and at-risk).

### 6.2 One linear pass over candidates

A node is **eligible** if:
- it's free (not in another job),
- its state is `ok`, and none of its ancestors are in `degraded` / `failed` / `maintenance`,
- it's not in any diagnosed `at_risk` set,
- its rack has margin ≥ 1 (full backup),
- no maintenance lease on its ancestors overlaps `duration`.

Then it ranks eligible nodes by locality: same leaf switch as the job's healthy nodes, then same spine, then anything. It takes the top `needed`.

Output: the node list, the excluded counts by reason, and a reason line, e.g. *"Restart on 40 spare nodes in Rows 9–10: separate cooling (CDU-9, CDU-10) and power, full backup, no maintenance booked in the next 72 h."* If there aren't enough nodes, it returns the shortfall plus options (wait for repair, or restart smaller).

We don't pack jobs. The scheduler agent decides how to use the list.

### 6.3 Protection lease

After restart, the scheduler agent requests a **protection lease** on the job's racks for `duration`. Maintenance that would remove their backup is then denied with the reason "protects job-train-1 until <time>". This is what makes the restart stick.

## 7. Scalability

### 7.1 Why the computing scales

- **Local questions.** Diagnosis touches about 10 ancestors per failed node plus one downstream lookup. An action check touches only `downstream[target]`. Neither depends on total facility size.
- **Shallow map.** Power, cooling and network chains are about 4–7 parts deep. Bigger sites are wider, not deeper.
- **Incremental recompute.** A state change recomputes only racks below the changed part.
- **Linear placement.** One pass over free nodes (≤ ~12,500 at 100k GPUs).
- **No packing.** The hard optimization stays with Slurm/Kubernetes.
- **Low event rate.** Even at Meta's failure rate, a 100k-GPU site sees dozens of failures a day.

### 7.2 Performance limits (enforced by `spacetimedb/test/scale/scale.test.ts`)

Scale site: `scaleSpec(100000)` in `site.ts` gives 12,544 nodes, 1,568 racks, plus power/cooling/network parts. Measured as the median of 20 runs on a laptop.

| Operation | Limit |
| --- | --- |
| `diagnose_failure` for one node | ≤ 50 ms |
| `safe_placement` for 1,000 nodes | ≤ 100 ms |
| `simulate` / `request_lease` | ≤ 20 ms |
| State change → incremental recompute | ≤ 50 ms |
| Full rebuild from file | ≤ 1 s |

These numbers go in the pitch once measured: *"On a simulated 100,000-GPU site, diagnosis plus safe restart takes X ms."*

### 7.3 What actually limits scale (production)

| Challenge | Production answer |
| --- | --- |
| **Map accuracy:** a wrong map gives wrong answers fast | Import from DCIM / BMS / NetBox / scheduler; flag drift (e.g., a node reporting a different PDU than the map) |
| One source of truth for leases | One leader per site with a transactional store and a hot standby; read-only replicas answer queries |
| Humans can't approve everything | Green actions auto-approved; only yellow reaches a person |
| Thousands of polling agents | Push events (`subscribe`) |
| Many sites | One instance per site; a thin fleet-wide view on top |

## 8. Agent interface (MCP tools, Iteration 1)

| Tool | Input | Output |
| --- | --- | --- |
| `check_risk` | `scope` (row / rack / job) | margins, unprotected parts, active leases |
| `simulate` | `action` | impact, verdict, reason |
| `request_lease` | `action`, `window`, `type` (maintenance / protection) | granted or denied, reason, earliest safe time |
| `release_lease` | `lease_id` | ok |
| `get_events` | `since`, `scope` | events since the cursor |
| `diagnose_failure` | `nodes` | classification, cause, at-risk nodes, who to send, reason |
| `safe_placement` | `job`, `needed`, `duration`, `exclude` | node list, exclusions, reason |

Every call carries an API key; scope is checked first; every call is logged.

On SpacetimeDB each tool maps to a reducer or a table read: `simulate` = `request_work` with `dry_run`, `request_lease` = `request_work` / `request_protection`, `release_lease` = `release_work`, `get_events` = the `decision` table by `seq`, `check_risk` = the `margin`, `work` and `claim` tables. The MCP server is a thin adapter over SpacetimeDB's HTTP API: it calls the reducer with a `ticket`, then reads the result row from `work`.

### 8.1 Demo agents

- **Scheduler agent** (scripted stand-in for Slurm/Kubernetes):
  - *Naive mode:* on a node failure, it swaps in the nearest free node and restarts.
  - *Blast Radius mode:* it calls `diagnose_failure`, then `safe_placement`, restarts, and requests a protection lease.
- **Cooling agent** (scripted): requests a maintenance lease on a CDU at a set time.
- **LLM technician assistant:** roadmap, built only if everything else is done. It may only call tools.

## 9. Security (Iteration 1 baseline)

Blast Radius approves or blocks physical actions and holds a map of every weak point, so it's built like a control plane from day one.

- **Identity:** one SpacetimeDB identity per human and per agent; the private `actor` table maps it to a role and rows. No shared keys; no anonymous calls.
- **Scope:** each key lists allowed rows and a role (`technician`, `shift_lead`, `scheduler_agent`, `cooling_agent`, `viewer`). Scope is checked before any work.
- **Audit log:** append-only; every request, verdict, lease and reason, with actor and time.
- **Untrusted text:** free text never changes a verdict; tools take structured actions only.
- **Fail closed:** agents don't act if Blast Radius is unreachable.
- **Sensitive topology:** only scoped roles read the full map; tenants see only their own jobs' exposure.
- **Secrets:** environment variables or an ignored file; tokens never logged.

Roadmap (Iteration 2): signed lease tokens that equipment systems verify ("no lease, no action"), a hash-chained log with verification, two-person overrides, logged break-glass, rate limits and auto-suspend, SSO/mTLS.

## 10. Demo

### 10.1 Control-room view

1. **Floor map:** healthy racks stay neutral; a rack one failure from an outage gets a gold top and one with no working feed a red top. Unprotected parts are highlighted, job nodes are blue, and protected racks get an azure top and a lock.
2. **Decision feed:** every request, diagnosis and placement with its verdict and reason.
3. **Mode toggle:** naive scheduler vs Blast Radius, run on the same scenario.

No charts and no sensor readings.

### 10.2 Scenario: "Big job failure" (`data/scenarios/big_job_failure.json`)

1. `job-train-1` runs on 1,000 nodes in Rows 1–8.
2. T+0: `cdu-3` → degraded. Its 5 racks drop to yellow (one failure from an outage); `cdu-4` is now their only cooling feed and is highlighted.
3. T+10m: `node-417` (on CDU-3) fails → the job stops.
4. **Naive mode:** the scheduler swaps in a free node on the same loop and restarts. At T+50m `node-422` (also CDU-3) fails, and the job stops again.
5. **Blast Radius mode:**
   - `diagnose_failure(node-417)` → shared cause `cdu-3`; 39 other job nodes at risk; send a mechanical tech to CDU-3.
   - `safe_placement` → 40 replacement nodes in Rows 9–10 on separate cooling and power, full backup.
   - The scheduler restarts and takes a protection lease on the job's racks.
   - T+30m: the cooling agent requests maintenance on `cdu-4`. **Denied**: "CDU-4 is the only cooling feed for 5 racks (CDU-3 degraded); taking it offline makes them red. It would also drop 5 racks protected for job-train-1 below full backup. Earliest safe time: after CDU-3 repair, and not before T+72h13m."
6. Result shown: one restart instead of repeated crashes, and no second outage.

### 10.3 Minimum demo (protect above everything)

Steps 5a, 5b and 5d. Everything else is a bonus.

### 10.4 Backend scenario runner and diagnostics test bed

The scenario runs on the backend (`scenario_start` / `scenario_next` / `scenario_goto`): each step acts as a scripted actor through the normal reducers, and the view only renders the tables. A fresh database instead holds a **diagnostics test bed**: the demo hall at T+3h with five incidents (degraded CDU, failed PDU, two correlated failures under a leaf with no alarm, an isolated node with an older failure outside the window, a tenant node under a failed CDU). The private `incident` table is the answer key for grading diagnostic agents. Details: `spacetimedb/README.md`.

## 11. Roadmap (not built this weekend)

| Iteration | Contents |
| --- | --- |
| 2: Enforcement + security | Signed lease tokens verified by equipment systems; hash-chained log; two-person override; break-glass; abuse rules; prompt-injection handling for an LLM assistant |
| 3: Risk-aware job allocator | People and agents scored on skills, certs, seniority, workload and current risk; agent trust levels (act alone / propose / assist); coverage gaps |
| 4: Ahead-of-time checks | Look-ahead on planned leases; time-at-risk escalation; playbook engine; shift handoff screen |
| 5: Software layers | OS / VM / container in the map; symptom routing to physical causes (software *maintenance* scopes, online vs drain-required, are already in Iteration 1: §4.4) |
| 6: Production | Grid emergency mode; near-miss learning; DCIM/BMS/NetBox/Slurm import with drift checks; SSO/mTLS; multi-site; push events |

New ideas go into this table, not into the code.

## 12. Testing

- **Guard:** margins on hand-built racks (2 feeds, 1 feed, 0 feeds); simulate verdicts; overlapping and back-to-back leases; protection lease blocks maintenance.
- **Test bed:** every incident diagnoses to its answer key.
- **Contract:** the backend scenario, mapped through the view's `live/mapping.ts`, equals the frontend mock at every step.
- **Scopes:** node, rack and hot-aisle claims exclude each other; two node repairs in one rack don't; online updates share nodes with jobs, drain-required ones don't; one maintenance item per node; hot-aisle work costs a cooling feed of headroom.
- **Diagnose:** a degraded ancestor is found; a common ancestor across two failures is found; an isolated failure is classified isolated; the at-risk set is correct.
- **Placement:** excludes at-risk, yellow/red racks, booked maintenance and busy nodes; prefers locality; reports a shortfall.
- **Security:** missing or invalid key refused; out-of-scope row refused; every call logged; free text doesn't change verdicts.
- **Scenario:** naive mode crashes twice; Blast Radius mode restarts once and the cooling lease is denied.
- **Scale (`-m scale`):** every limit in §7.2.

## 13. Open questions

- Team owners for the four build areas, and who owns "no" on scope?
- ~~Confirm stack~~ Decided: SpacetimeDB (TypeScript module) backend, React + Vite + TS frontend.
- Should the demo hall be bigger to show more spares? (Default: 1,280 nodes.)
