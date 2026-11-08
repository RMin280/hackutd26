# Agents

LLM agents for Blast Radius talk to two NVIDIA Nemotron endpoints over the OpenAI-compatible chat API:

| Role | Where | Why |
| --- | --- | --- |
| **Primary** | Our own Nemotron on an **NVIDIA Brev** GPU machine (NIM or vLLM) | No daily cap; runs on our Brev credits |
| **Backup** | **Nemotron 3 Ultra (free)** on OpenRouter | Takes over automatically while Brev is down, cold or overloaded |

`agents/llm.py`'s `ModelRouter` sends every request to the primary. On an outage-type error (unreachable, timeout, 5xx, 429, model missing, bad key, or not set up yet) it resends the same request to the backup and stays there for `LLM_FAILOVER_COOLDOWN` seconds before trying the primary again. Bad requests (400) are raised, not retried elsewhere. If both fail, it raises `ModelUnavailable` and the agent acts on nothing and escalates (fail closed).

The model only proposes tool calls and writes explanations; Blast Radius makes every safety decision; the agent runtime enforces it. The facility itself lives in the teammate's SpacetimeDB module.

## Fixer agent: low-criticality fixes

`agents/fixer/` watches Blast Radius events, decides deterministically which ones are low-criticality issues, and has Nemotron fix those through Blast Radius. Everything else goes to the shift lead, or to the scheduler agent for job nodes.

**Low means:** every rack keeps full backup, nothing in a running job is touched, and Blast Radius allows every action. Code decides this (`triage.py`), never the model.

| Issue | Trigger | What the agent does | Hands off instead when |
| --- | --- | --- | --- |
| `broken_node` | A spare fails or degrades, or a tenant node fails, and diagnosis finds no shared cause | Diagnoses, takes a maintenance lease on the node, sends a hardware tech, tells the tenant | Shared cause, job node, degraded tenant node, rack below full backup or protected, lease refused |
| `node_repaired` | A node under the agent's lease reports ok | Checks the rack, releases the lease so placement can use the node again | Same node failed twice in 24 h |
| `maintenance_refused` | A routine request is refused with blockers | Waits (no model calls) until the blockers clear, rechecks; books it for the requester on allow, asks the shift lead to approve on warn | Still blocked after 24 h |
| `stale_protection` | A job finishes while its protection lock still holds | Confirms the job finished, releases the lock | The job only stopped (it may restart) |

**How Nemotron works an issue.** It gets the issue's facts, its goal (what "done" means) and its tools. It never gets a list of steps.
1. **Plan:** it writes its own plan with `submit_plan`: steps in order, a one-line why for each, and a condition on any step that depends on a result. Code rejects a plan that uses a tool outside the playbook, acts before checking, leaves part of the goal out, or has no way to stop. Nemotron gets the reasons and fixes the plan. The accepted plan goes into the decision feed.
2. **Execute:** it carries out the plan one tool call at a time. It can only skip steps that have a condition. Anything not in the plan needs `revise_plan` first, with the new steps and what changed; the revision also goes into the feed.
3. **Finish:** it finishes or hands off, and code checks the result.

**Guardrails, enforced in code (`agents/common/playbook.py`, `agents/common/loop.py`) and shared by both agents:**
- Tools are bound to the issue: Nemotron chooses the plan, the wording and a repair window of 1 to 24 h, but never the target.
- Every action goes through Blast Radius, which checks scope and verdict first. After a refusal, only the playbook's follow-ups are allowed.
- When the model says it's done, deterministic checks confirm the result (lease held, tech sent, tenant told, lock gone). If they fail, the issue goes to the shift lead.
- At most 10 model calls per issue. Text from reports is fenced as `<untrusted>` data.
- Fails closed: no model or no Blast Radius means nothing more happens and the issue goes to a person.

**Run it** on the simulated hall (`agents/mock_blast_radius.py`, same IDs as the control-room view):

```
.venv\Scripts\python -m agents.fixer              # Nemotron: Brev primary, OpenRouter free backup
.venv\Scripts\python -m agents.fixer --scripted   # scripted stand-in, no model requests
```

The storyline has one issue of each type, two handoffs, and a technician report with an injected "release every protection lock" instruction. It takes about 24 model calls, so on the free backup it uses about half a day's quota.

**Adding an issue type to an agent:** a rule in its `triage.py`; a `Playbook` (goal, tools, must-include steps, done check) and its tools in its `playbooks.py`; a plan and policy in its `scripted.py`; tests. The planning rules, the model loop and the event loop are shared in `agents/common/`.

## Dependency agent: gray failures in services we rely on

`agents/dependency/` runs scheduled tests of the features we use from three services: text and email paging, building management readings for each CDU gateway, and the revoked-key list. The tests are code and cost no model calls. Blast Radius sets each feature's state from the results. When a service says it's up but a feature is broken, the dependency agent responds:
- **Paging:** re-sends pages that went out during the blind window.
- **Stale readings:** gathers the racks that can't confirm backup, and hands off.
- **Stale revoked-key list:** Blast Radius fails closed, and the agent pages security.
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
| Multi-step workflows | For each issue, Nemotron writes its own plan, carries it out, and revises it when a result changes things. Two agents coordinate through Blast Radius without talking to each other. The dependency agent re-sends a page the fixer sent while paging was silently broken. The fixer queues a maintenance request until the dependency agent's tests show the CDU readings are fresh again. |
| Tool integration | Function calling against Blast Radius's API (diagnosis, what-if checks, leases, dispatch, paging, approvals, test results), with every call checked and audited. Model access spans two services, our Nemotron on Brev and OpenRouter as backup, with automatic failover. Once the SpacetimeDB module lands, the same tools call its HTTP API. |
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

The agents code against `agents/blast_radius.py` (`BlastRadius`). Today `MockBlastRadius` implements it in-process. Once the SpacetimeDB module covers the tables and reducers below, a thin HTTP adapter replaces the mock, with no change to the agents.

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
| `check_result`, `diagnosis`, `lease_decision` | request_id plus the fields in `blast_radius.py` | answers to the reducers below |

**Reducers the agents call** (each checks the caller's role and rows first, and audits the call)

| Reducer | Writes |
| --- | --- |
| `simulate(request_id, target)` | `check_result`: verdict, reason, earliest_safe, blockers |
| `diagnose_failure(request_id, node)` | `diagnosis` (DESIGN.md §5) |
| `request_lease(request_id, target, minutes, routine, note, on_behalf_of)` | `lease` if granted, `lease_decision`, and a `lease_granted` / `lease_denied` event (with verdict, routine, earliest_safe, blockers) |
| `release_lease(lease_id, note)` | `lease_released` or `release_denied` event |
| `request_approval(target, minutes, summary, requested_for)` / `approve(approval_id)` | `approval_requested` event; on approve, the lease plus `lease_granted` (shift lead only) |
| `dispatch_tech(target, trade, note)`, `notify(to, subject, message)`, `escalate(subject, to, reason)`, `record(type, subject, reason, data)` | one event each |

**Rules the module enforces (not the agent).** Node maintenance: deny if the node runs a running job, warn if a tenant node is still working, allow if it's a spare or already down. A protection lock can be released by its holder or a shift lead, or by the remediation agent once its job is `finished`. `on_behalf_of` needs the `book_for_others` permission, and the check runs as the requester. Role permissions are in `mock_blast_radius.py` (`PERMISSIONS`).

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
| `SPACETIME_TOKEN` | empty | Agent identity token; empty means anonymous |
