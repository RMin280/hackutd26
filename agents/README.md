# Agents

LLM agents for Squawk talk to two NVIDIA Nemotron endpoints over the OpenAI-compatible chat API:

| Role | Where | Why |
| --- | --- | --- |
| **Primary** | Our own Nemotron on an **NVIDIA Brev** GPU machine (NIM or vLLM) | No daily cap; runs on our Brev credits |
| **Backup** | **Nemotron 3 Ultra (free)** on OpenRouter | Takes over automatically while Brev is down, cold or overloaded |

`agents/llm.py`'s `ModelRouter` sends every request to the primary. On an outage-type error (unreachable, timeout, 5xx, 429, model missing, bad key, or not set up yet) it resends the same request to the backup and stays there for `LLM_FAILOVER_COOLDOWN` seconds before trying the primary again. Bad requests (400) are raised, not retried elsewhere. If both fail, it raises `ModelUnavailable` and the agent acts on nothing and escalates (fail closed).

The model only proposes tool calls and writes explanations; Squawk makes every safety decision; the agent runtime enforces it. The facility itself lives in the teammate's SpacetimeDB module.

## Fixer agent: low-criticality fixes

`agents/fixer/` watches Squawk events, decides deterministically which ones are low-criticality issues, and has Nemotron fix those through Squawk. Everything else goes to the shift lead, or to the scheduler agent for job nodes.

**Low means:** every rack keeps full backup, nothing in a running job is touched, and Squawk allows every action. Code decides this (`triage.py`), never the model.

| Issue | Trigger | What the agent does | Hands off instead when |
| --- | --- | --- | --- |
| `broken_node` | A spare fails or degrades, or a tenant node fails, and diagnosis finds no shared cause | Diagnoses, takes a maintenance lease on the node, sends a hardware tech, tells the tenant | Shared cause, job node, degraded tenant node, rack below full backup or protected, lease refused |
| `node_repaired` | A node under the agent's lease reports ok | Checks the rack, releases the lease so placement can use the node again | Same node failed twice in 24 h |
| `maintenance_refused` | A routine request is refused with blockers | Waits (no model calls) until the blockers clear, rechecks; books it for the requester on allow, asks the shift lead to approve on warn | Still blocked after 24 h |
| `stale_protection` | A job finishes while its protection lock still holds | Confirms the job finished, releases the lock | The job only stopped (it may restart) |

**How Nemotron works an issue.** It gets the issue's facts, its goal (what "done" means) and its tools. It never gets a list of steps.
1. **Plan:** it writes its own plan with `submit_plan`: steps in order, a one-line why for each, and a condition on any step that depends on a result. Code rejects a plan that uses a tool outside the playbook, acts before checking, leaves part of the goal out, or has no way to stop. Nemotron gets the reasons and fixes the plan. The accepted plan goes into the decision feed, with the model's one-line why for each step as the row's reason, and, when the model server returns reasoning (OpenRouter's `reasoning`, vLLM / NIM's `reasoning_content`; `AGENT_REASONING_EFFORT` sets how much), the reasoning behind the reply as `data.thinking` and any words it wrote with the call as `data.said`. The same two fields ride on every `agent_step` row, so the view can show what the model is thinking as it works.
2. **Execute:** it carries out the plan one tool call at a time. It can only skip steps that have a condition. Anything not in the plan needs `revise_plan` first, with the new steps and what changed; the revision also goes into the feed.
3. **Finish:** it finishes or hands off, and code checks the result.

**Guardrails, enforced in code (`agents/common/playbook.py`, `agents/common/loop.py`) and shared by both agents:**
- Tools are bound to the issue: Nemotron chooses the plan, the wording and a repair window of 1 to 24 h, but never the target.
- Every action goes through Squawk, which checks scope and verdict first. After a refusal, only the playbook's follow-ups are allowed.
- When the model says it's done, deterministic checks confirm the result (lease held, tech sent, tenant told, lock gone). If they fail, the issue goes to the shift lead.
- At most 10 model calls per issue. Text from reports is fenced as `<untrusted>` data.
- Fails closed: no model or no Squawk means nothing more happens and the issue goes to a person.

**Run it** on the simulated hall (`agents/mock_squawk.py`, same IDs as the control-room view):

```
.venv\Scripts\python -m agents.fixer              # Nemotron: Brev primary, OpenRouter free backup
.venv\Scripts\python -m agents.fixer --scripted   # scripted stand-in, no model requests
```

The storyline has one issue of each type, two handoffs, and a technician report with an injected "release every protection lock" instruction. It takes about 24 model calls, so on the free backup it uses about half a day's quota.

**Adding an issue type to an agent:** a rule in its `triage.py`; a `Playbook` (goal, tools, must-include steps, done check) and its tools in its `playbooks.py`; a plan and policy in its `scripted.py`; tests. The planning rules, the model loop and the event loop are shared in `agents/common/`.

## Update agent: security advisories, patched in safe waves

`agents/patch/` keeps the hall's software ahead of known vulnerabilities without causing the outage a careless patch would. It is its own Squawk actor (`update-agent`, role `update_agent`: `sw_online`, `sw_exclusive` and `switch_firmware` only, no hardware or facility work, no booking for others).

**Vulnerability watch (code, no model calls).** Advisories (`agents/patch/data/advisories.json`, simulated, IDs `SQK-SIM-…`; production reads a vendor / NVD / CISA KEV feed) are matched against the fleet inventory (`data/inventory.json`, one version per row and component; production imports it from fleet management). Matching works on version groups (component × row), so it costs the same for 1,280 nodes or 12,544. What has been patched comes from Squawk's own feed (the agent's granted windows that have ended), so a restarted agent carries on where it was. Advisories are worked worst first: exploited, then critical, then by CVSS.

**Rollout rules, enforced in code (`rollout.py`):**
- **Canary first:** the first wave of an advisory is 2 nodes, 1 row or 1 switch; later waves (the model picks 1–16) follow only once the previous wave's windows have ended.
- **Spare reserve:** a node-level wave never takes the free healthy spares below `PATCH_SPARE_RESERVE` (40, the demo job's restart size), so a job that fails mid-rollout can always be re-placed.
- **Owners first:** nodes a running job or a working tenant holds are never waved. Squawk refuses them anyway; the agent tells the job's scheduler or the tenant once, and the shift lead when draining a job is the only way forward. Switch firmware above a running job waits for the job to finish.
- **Prerequisites in order:** the GPU driver fix needs BMC firmware 3.2.0, so each node gets the firmware window and the driver window right after it, two checked bookings that never overlap.
- **Halt on refusal:** a wave stops at the first booking refused because of another window instead of repeating the refusal.
- **Urgent advisories** (critical or exploited) always reach the shift lead; online live patches (the monitoring agent) roll out alongside running jobs.

**Failed installs (`triage.triage_failure`, the `patch_failed` playbook).** A patch window can end with the post-install check failing. In the simulation, `data/inventory.json` → `install_faults` lists those checks: the canary node-1029's GPU driver fails once, and node-1037's fails twice. In production this is fleet management's health check. What happens next:
- **Code first, no model:** the agent says what failed in a row titled "Patch failed on node-…". It cancels that node's later windows (a driver after a failed firmware update) and holds the node out of service with a 2-hour `sw_exclusive` window, so it is never offered as a spare. The advisory's rollout is halted: no new wave while a failure is open.
- **Nemotron chooses** between `retry_patch` (the same fix again, at most 2 tries per target, enforced in code), `roll_back` (the version the node ran before: it works again but stays exposed) and `escalate`. Each choice swaps the hold for a window Squawk checks; a refused window puts the hold back. Code requires telling the shift lead about a failed canary or any rollback before the run can end with `keep_waiting`. The model never picks the target or a version, and the symptom text is fenced as untrusted.
- **Code reads the result** when the window ends. A pass resumes the rollout. A rollback leaves the node to a person. A rolled-back canary, or 2 rollbacks, stops the advisory and hands it to the shift lead.
- The view's popup follows it over the node (`frontend/src/scene/fixes.ts`): failure → hold → plan → retry or rollback → Fixed or Handed off. `python -m agents.patch --mock --scripted` plays the whole story.
- Not modelled: a failed online (row) or switch upgrade is retried or rolled back the same way but isn't held, because holding a whole row or a switch is a person's call.

**Nemotron's part** is the same plan → execute → done-check loop as the fixer (`agents/common/`): it plans each wave, picks the wave size, writes the notices, and chooses to wait or finish. It never picks a target. Code refuses `keep_waiting` until the owners and (when needed) the shift lead are told, and refuses "finished" while anything patchable is left. Advisory text is untrusted and fenced. About 6 model calls per wave, roughly $0.003 on Nemotron 3 Super.

```
python -m agents.squawk_http setup --agent update   # once per database: the update agent's own identity
python -m agents.patch --scripted                   # live when SPACETIME_DB is set (--once: handle now and exit)
python -m agents.patch                              # Nemotron plans the waves
python -m agents.patch --mock --scripted            # the storyline on the simulated hall
```

**Both agents at once** (on stage): `python -m agents` runs the fixer and the update agent in one process, each with its own identity, sharing one model router and one credit ledger (`--scripted`, `--once` as above).

## Credit caps (`agents/budget.py`)

Every model request from any agent is checked before it is sent: its worst-case cost (prompt size plus `max_tokens` at the endpoint's price) must fit under `AGENT_BUDGET_USD` (lifetime, default $20), `AGENT_DAILY_BUDGET_USD` ($5) and `AGENT_DAILY_REQUESTS` (600). After the reply, the real cost is recorded (OpenRouter reports it; otherwise tokens × `MODEL_PRICE_*`). The ledger, `.agent_usage.json` (gitignored), is shared by every agent process on the machine under a lock. A damaged ledger refuses rather than resetting. Past a cap, the router fails over to a free backup if there is one, else the agent fails closed and hands off. `check_setup` prints what's been spent.

## MCP server: Squawk for agents we didn't write

`python -m agents.mcp_server` exposes the seven tools of DESIGN.md §8.1 (`check_risk`, `simulate`, `request_lease`, `release_lease`, `get_events`, `diagnose_failure`, `safe_placement`) over MCP: stdio by default, or `--http --port 8765` (bound to 127.0.0.1; put it behind the tailnet, never the internet). It holds one identity (`SPACETIME_MCP_TOKEN`), registered by the admin with the role that external agent should have: `python -m agents.squawk_http setup --agent mcp --role technician` (default `viewer`, read only). Squawk checks that role on every call and audits it. The server adds input checks (ids, work kinds, bounds), 60 calls a minute, and returns Squawk's refusals as results; an unreachable Squawk stays an error so a client never acts on silence. It works with `mcp` 1.x (`FastMCP`) and 2.x (`MCPServer`).

## Dependency audit for this repo

`python -m agents.deps` checks the agents' Python packages against OSV.dev and the backend's and the view's npm packages with `npm audit`, and exits 1 on anything high or critical (usable in CI). `--json` for machines; `--explain` adds a short upgrade plan from Nemotron (one request, under the same caps). Nothing is upgraded automatically.

## Dependency agent: gray failures in services we rely on

`agents/dependency/` runs scheduled tests of the features we use from three services: text and email paging, building management readings for each CDU gateway, and the revoked-key list. The tests are code and cost no model calls. Squawk sets each feature's state from the results. When a service says it's up but a feature is broken, the dependency agent responds:
- **Paging:** re-sends pages that went out during the blind window.
- **Stale readings:** gathers the racks that can't confirm backup, and hands off.
- **Stale revoked-key list:** Squawk fails closed, and the agent pages security.
- **Recovery:** confirms it with a second test.

It runs on the same planning, guardrails and fail-closed rules as the fixer. The full design is in [`DEPENDENCY_AGENT.md`](DEPENDENCY_AGENT.md).

```
.venv\Scripts\python -m agents.dependency              # Nemotron; the fixer runs alongside
.venv\Scripts\python -m agents.dependency --scripted   # scripted stand-in, no model requests
```

## Against the Nemotron judging criteria

| Criterion | Where it shows |
| --- | --- |
| Beyond a chatbot | Nobody prompts the agents. They wake on facility events and on their own scheduled tests, act, and hand off what isn't theirs. |
| Multi-step workflows | For each issue, Nemotron writes its own plan, carries it out, and revises it when a result changes things. Two agents coordinate through Squawk without talking to each other. The dependency agent re-sends a page the fixer sent while paging was silently broken. The fixer queues a maintenance request until the dependency agent's tests show the CDU readings are fresh again. |
| Tool integration | Function calling against Squawk's API (diagnosis, what-if checks, leases, dispatch, paging, approvals, test results), with every call checked and audited. Model access spans two services, our Nemotron on Brev and OpenRouter as backup, with automatic failover. Once the SpacetimeDB module lands, the same tools call its HTTP API. |
| Real-world applicability | The agents clear the routine work that piles up in big GPU halls, and catch services that quietly stop doing their job. They never act outside the safety interlock, and fail closed when they can't trust what they see. |

## Setup

```
uv venv .venv --python 3.11
uv pip install -r requirements.txt
copy .env.example .env
.venv\Scripts\python -m agents.check_setup
```

Without uv: `python -m venv .venv` then `.venv\Scripts\pip install -r requirements.txt`. In Git Bash use `.venv/Scripts/python`.

`check_setup` checks both endpoints and sends two real requests (a tool call, then a follow-up that uses the tool's result) to the primary, or to the backup when the primary isn't ready. `--backup` also tests the backup when the primary works; `--no-llm` sends no model requests. It also reports whether a SpacetimeDB server and database are reachable.

## Primary: Nemotron on Brev

Brev credits pay for GPU machines by the hour. The Brev CLI runs on Windows only inside WSL Ubuntu.

1. PowerShell: `wsl --install -d Ubuntu-22.04`, then open Ubuntu and create a Linux user.
2. In Ubuntu: `bash -c "$(curl -fsSL https://raw.githubusercontent.com/brevdev/brev-cli/main/bin/install-latest.sh)"`, then `brev login`.
3. In the Brev console, create a GPU machine sized for the model (NVIDIA's minimums): **Nano** one 80 GB GPU, **Super** about 2× H100, **Ultra** 4× B200 or 8× H100. Check the hourly price first.
4. Serve Nemotron on port 8000 (NIM container, or vLLM with `--enable-auto-tool-choice` and the tool-call parser named on the model card).
5. In Ubuntu, keep this running: `brev port-forward <machine> --port 8000:8000`. WSL forwards it to Windows' `localhost:8000`.
6. In `.env`, set `AGENT_MODEL` to the id listed at `http://localhost:8000/v1/models`, then run `check_setup`.

Stop the machine when you're done: it bills while it runs.

## Backup: Nemotron 3 Ultra (free) on OpenRouter

Create a key at https://openrouter.ai/settings/keys and paste it after `OPENROUTER_API_KEY=` in `.env`.

| Credits ever bought | Requests/min | Requests/day |
| --- | --- | --- |
| Fewer than 10 | 20 | 50 |
| 10 or more | 20 | 1,000 |

An agent run costs about one request per step. `check_setup` shows today's remaining count.

## SpacetimeDB contract (for the backend)

The agents code against `agents/squawk.py` (`Squawk`). `MockSquawk` implements it in-process; `agents/squawk_http.py` (`HttpSquawk`) implements it over the live module, with no change to the agents.

**Run the fixer live** (server running, module published):

```
python -m agents.squawk_http setup --db squawk   # once per database: new identity, token into .env, register_actor as fixer-agent (needs the admin CLI)
python -m agents.check_setup --no-llm            # reads the clock and the feed as the fixer
# Maincloud instead (the token is per server, so this makes a new identity; then the admin registers it there):
# python -m agents.squawk_http setup --host https://maincloud.spacetimedb.com --db hackutd26-2he95 --server maincloud
python -m agents.fixer --scripted                # live whenever SPACETIME_DB is set; --mock for the storyline, --once to handle the feed and exit
```

Then run a scenario (`spacetime call --server local squawk scenario_start maintenance`, then `scenario_next maintenance` ×7). The fixer takes node-1118 out of service and sends a tech, releases job-train-1's stale protection lock, and queues the UPS-B request until the PDU-R10-A swap ends; after `advance_clock`, it rechecks and hands the shift lead a `warn`. It starts from the beginning of the feed (`--from-now` skips what's there), drops queued requests when the hall is reset, and fails closed while Squawk is unreachable.

**How the adapter maps the contract** (actual module, which differs from the original proposal below in places): lease ids are the work ids as `#12`; `simulate` is `request_work(..., dry_run=true)`; a request on a part is checked and booked as the actor whose routine request it was (`on_behalf_of`); `request_approval` is a booking for the requester that comes back `warn` and waits in `needs_approval`; `dispatch_tech`, `notify`, `escalate` and `record` are `record_event`. Events come from the `decision` table (`WHERE seq > ?`), normalized so a lease release is about the lease and blockers are `{kind, id, until}`. The connection acts only as its own actor. The dependency agent's calls raise `NotImplementedError` (deferred). `tests/test_squawk_http.py` checks it against `MockSquawk` on recorded backend answers; re-record with `tests/fixtures/record_spacetime.py`.

The original proposal for the module (kept for reference):

Python has no maintained SpacetimeDB SDK, so agents use its HTTP API: `POST /v1/database/<db>/sql` to read, `POST /v1/database/<db>/call/<reducer>` (JSON array of arguments) to act, and `POST /v1/identity` for each agent's token (`Authorization: Bearer <token>`). Reducers don't return values, so a call whose answer the agent needs takes a `request_id`, and the module writes the answer to a table keyed by it.

**Tables the agents read**

| Table | Columns | For |
| --- | --- | --- |
| `node` | id, rack, row, slot, state, owner_kind (job / tenant / free), owner_id | `node()` |
| `rack_margin` | rack, power, cooling, margin, level, protected_by, reason; updated only for racks below a changed part | `rack()` |
| `part_rack` | part, rack (the `downstream` index) | `racks_below()` |
| `job` | id, status (running / stopped / **finished**), nodes, since | `job()` |
| `lease` | id, type, actor, target (part **or node**), racks, job, start, end, **routine**, note | `lease()`, `leases_on()`, `protection_leases()` |
| `node_failure` | node, time | `failures_since()` |
| `event` | seq, time, type, actor, subject, reason, data (JSON) | `get_events(since)` |
| `check_result`, `diagnosis`, `lease_decision` | request_id plus the fields in `squawk.py` | answers to the reducers below |

**Reducers the agents call** (each checks the caller's role and rows first, and audits the call)

| Reducer | Writes |
| --- | --- |
| `simulate(request_id, target)` | `check_result`: verdict, reason, earliest_safe, blockers |
| `diagnose_failure(request_id, node)` | `diagnosis` (DESIGN.md §5) |
| `request_lease(request_id, target, minutes, routine, note, on_behalf_of)` | `lease` if granted, `lease_decision`, and a `lease_granted` / `lease_denied` event (with verdict, routine, earliest_safe, blockers) |
| `release_lease(lease_id, note)` | `lease_released` or `release_denied` event |
| `request_approval(target, minutes, summary, requested_for)` / `approve(approval_id)` | `approval_requested` event; on approve, the lease plus `lease_granted` (shift lead only) |
| `dispatch_tech(target, trade, note)`, `notify(to, subject, message)`, `escalate(subject, to, reason)`, `record(type, subject, reason, data)` | one event each |

**Rules the module enforces (not the agent).** Node maintenance: deny if the node runs a running job, warn if a tenant node is still working, allow if it's a spare or already down. A protection lock can be released by its holder or a shift lead, or by the remediation agent once its job is `finished`. `on_behalf_of` needs the `book_for_others` permission, and the check runs as the requester. Role permissions are in `mock_squawk.py` (`PERMISSIONS`).

## Settings (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `LLM_PROVIDER` | `openrouter` | Primary's provider: `openai_compatible` (Brev, NIM, vLLM, build.nvidia.com) or `openrouter` |
| `LLM_BASE_URL` | OpenRouter, or `http://localhost:8000/v1` | Primary's server URL |
| `LLM_API_KEY` | empty | Primary's key, if its server needs one |
| `AGENT_MODEL` | Ultra (free) on OpenRouter; required otherwise | Primary's model id |
| `BACKUP_LLM_PROVIDER` | empty (no backup) | Backup's provider |
| `BACKUP_AGENT_MODEL` | Ultra (free) on OpenRouter | Backup's model id |
| `BACKUP_LLM_BASE_URL`, `BACKUP_LLM_API_KEY` | empty | Only for an `openai_compatible` backup |
| `OPENROUTER_API_KEY` | empty | Key for whichever endpoint uses OpenRouter |
| `AGENT_FALLBACK_MODELS` | empty | OpenRouter only: models it tries if the requested one is down |
| `LLM_PRIMARY_TIMEOUT` | `60` | Seconds before a hanging primary counts as down |
| `LLM_FAILOVER_COOLDOWN` | `120` | Seconds to stay on the backup after the primary fails |
| `AGENT_REASONING_EFFORT` | `low` | `none` / `minimal` / `low` / `medium` / `high`; on NIM/vLLM only `none` matters (thinking off) |
| `AGENT_TEMPERATURE` | `0.6` | Sampling temperature |
| `SPACETIME_HOST` | `http://127.0.0.1:3000` | SpacetimeDB server (`spacetime start` runs one locally) |
| `SPACETIME_DB` | empty | Database name the module is published under |
| `SPACETIME_TOKEN` | empty | The fixer's identity token (`python -m agents.squawk_http setup`) |
| `SPACETIME_UPDATE_TOKEN` | empty | The update agent's identity token (`setup --agent update`) |
| `NVIDIA_API_KEY` | empty | Key for `LLM_PROVIDER=nvidia` (NVIDIA's hosted API, build.nvidia.com) |
| `AGENT_BUDGET_USD`, `AGENT_DAILY_BUDGET_USD`, `AGENT_DAILY_REQUESTS` | `20`, `5`, `600` | Credit caps for metered model endpoints |
| `MODEL_PRICE_IN_PER_M`, `MODEL_PRICE_OUT_PER_M` | `0.10`, `0.50` | USD per million tokens when the provider doesn't report cost |
| `AGENT_USAGE_FILE` | `.agent_usage.json` | The shared spending ledger |
| `PATCH_SPARE_RESERVE` | `40` | Free healthy spares the update agent never takes offline |
