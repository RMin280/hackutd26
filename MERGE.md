# Merging `nemotron-init`

*For the frontend and SpacetimeDB teammates. Checked against `main` at `c0a85f7` (PR #1, frontend "refined look"), 2026-11-07.*

## In short

- This branch adds two AI agents (Python, under `agents/`) and their tests. It doesn't touch `frontend/`.
- It merges cleanly with `main` (trial merge against `c0a85f7`: no conflicts).
- For the agents' work to show up in the control-room view, three pieces have to meet: the SpacetimeDB module (§3), a small adapter on this branch (§6), and the frontend's subscription plus a few display additions (§4, §5).

## 1. What this branch adds

| Path | What it is |
| --- | --- |
| `agents/llm.py`, `agents/config.py` | Model access: our Nemotron on a Brev GPU machine first, Nemotron 3 Ultra (free) on OpenRouter as automatic backup |
| `agents/fixer/` | The fixer agent: fixes four low-criticality issue types only through Squawk, planning its own steps (DESIGN.md §8.2) |
| `agents/dependency/` | The dependency agent: catches services that say they're up while a feature we rely on is broken, and responds through Squawk (DESIGN.md §8.3, `agents/DEPENDENCY_AGENT.md`) |
| `agents/common/` | What both agents share: planning rules, tools bound to the issue, the model loop, the event loop |
| `agents/squawk.py` | The interface the agents code against: every read, check and action they need from Squawk |
| `agents/mock_squawk.py`, `agents/mock_services.py` | A simulated hall and the services it relies on, implementing that interface (same IDs as the frontend mock), used until SpacetimeDB exists |
| `agents/check_setup.py` | `python -m agents.check_setup`: checks keys, models and SpacetimeDB reachability |
| `agents/README.md`, `agents/DEPENDENCY_AGENT.md` | How the agents work, plus the full SpacetimeDB contract |
| `tests/` | 83 tests (`pytest`) |
| `requirements.txt`, `pytest.ini`, `.env.example` | Python setup; `.env` itself is gitignored |
| `CLAUDE.md`, `DESIGN.md`, `HANDOFF.md` | Edited: stack, layout and commands; two rows in the Build list; §4.3 event types, §8.1-§8.3, §12; a few lines in HANDOFF |

## 2. Merge notes

- **No frontend files changed**, so there are no code conflicts with the frontend work.
- **Docs are the only likely conflicts.** If another branch edits the same lines of `CLAUDE.md`, `DESIGN.md` or `HANDOFF.md`, keep both sides.
- **Python setup files:** if the SpacetimeDB branch adds its own `requirements.txt`, `pytest.ini` or `tests/`, combine the entries.
- **Keys:** everyone makes their own `.env` from `.env.example`. Never commit `.env` or paste keys into code.

## 3. For the SpacetimeDB branch

The full contract (tables, reducers, rules) is in [`agents/README.md`](agents/README.md#spacetimedb-contract-for-the-backend) and [`agents/DEPENDENCY_AGENT.md`](agents/DEPENDENCY_AGENT.md#spacetimedb-additions). Checklist:

- [ ] **Tables:**
  - `node`, `rack_margin` (with `unconfirmed` parts), `part_rack`.
  - `job`: status gains `finished`.
  - `lease`: target can be a **node**; gains `routine`.
  - `node_failure`, `event`.
  - `check_result` / `diagnosis` / `lease_decision`, keyed by `request_id` (reducers can't return values).
  - For the dependency agent: `service`, `service_dependency`, `feature`, `feature_state`, `page`.
- [ ] **Reducers:**
  - `simulate`, `diagnose_failure`, `request_lease` (with `on_behalf_of`), `release_lease`, `request_approval`, `approve`, `dispatch_tech`, `notify`, `escalate`, `record`.
  - For the dependency agent: `record_test`, `resend_page`.
- [ ] **Identities and roles:** one identity per actor: `fixer-agent` (remediation_agent), `dependency-agent` (dependency_watch), `cooling-agent`, `scheduler-agent`, `shift-lead`. The permissions per role are `PERMISSIONS` in `agents/mock_squawk.py`.
- [ ] **Rules the module enforces:**
  - Each call checks the caller's role and rows first, and every call is audited.
  - Node maintenance is denied if the node runs a running job, warned if a tenant node is still working, and allowed if it's a spare or already down.
  - A protection lock can be released by its holder or a shift lead, or by the remediation agent once its job is `finished`.
  - Booking `on_behalf_of` needs `book_for_others`, and the check runs as the requester.
  - The module sets a feature's state from `record_test`; agents never set it.
  - A CDU whose readings are stale is unknown, and unknown never counts as backup. Refusals caused by it carry a `feature_ok` blocker.
  - New pages go by email while text paging is degraded, and come back unconfirmed when both channels are.
  - While the revoked-key list is out of date, facility changes need a shift lead.
- [ ] **Events:** write the rows below; the agents and the frontend both read them.
- [ ] **Then tell the agents side** the host, database name and how to get each agent's identity token, so the adapter in §6 can be written.

| Event `type` | `subject` | `data` fields | Written by |
| --- | --- | --- | --- |
| `state_change` | node or part | `kind` (node/part), `state`, `previous`, `note` (free text, untrusted) | facility / scenario |
| `lease_granted` | target part or node, or the job | `lease`, `target`, `verdict`, `until`, `routine`, `holder`, `approved_by`; protection leases: `job`, `racks` (count) | Squawk |
| `lease_denied` | target | `verdict` (deny/warn), `routine`, `minutes`, `note`, `earliest_safe`, `blockers` | Squawk |
| `lease_released`, `lease_expired` | lease id | `lease_type`, `target`, `job`, `holder`, `note` | Squawk |
| `release_denied` | lease id | none (the reason says why) | Squawk |
| `job_status` | job | `status` (running/stopped/finished), `previous` | scenario / scheduler |
| `feature_state` | feature id, e.g. `bms.cooling.3` | `feature`, `service`, `state` (degraded/working), `previous`, `previous_since`, `last_good`, `covers`, `service_says` | Squawk, from a recorded test |
| `tech_dispatched` | node, part or gateway | `trade`, `note`, `page`, `channel`, `page_status` | an agent |
| `notified` | node, part or feature | `to`, `message`, `page`, `channel`, `page_status` | an agent |
| `page_resent` | what the page was about | `page`, `to`, `channel`, `first_sent` | dependency agent |
| `approval_requested` | part | `approval`, `minutes`, `requested_for`, `summary` | fixer agent |
| `escalated` | node, part, lease or feature | `to` (shift lead / scheduler agent) | an agent |
| `agent_plan` | the issue's subject | `steps` (`tool`, `why`, `when`), `revision`, `change` | an agent |
| `agent_step` | the issue's subject | none (the reason has the gist) | an agent |
| `agent` | the issue's subject | `issue`, `status` (started/waiting/fixed/handed_off/failed_closed), `model_calls`, `served_by` | an agent |

Every event also has `seq`, `time` (simulated minutes), `actor` and a one-line `reason`.

## 4. For the frontend branch

Today the view replays its own scripted scenario and the agents run separately, so nothing they do appears in the view. Once the SpacetimeDB module exists:

- [ ] **Subscribe:** replace the scenario player in `store.ts` with a SpacetimeDB subscription that fills `world` and `events` (the spot is already marked in `store.ts`).
- [ ] **Turn event rows into `DecisionEvent`s.** A suggested mapping follows; the look is yours to decide.

| Event `type` | Title, e.g. | Verdict | Focus |
| --- | --- | --- | --- |
| `state_change` | "node-1205 failed" | failed → `failure`, degraded → `warn`, ok → `info` | the node or part |
| `lease_granted` | "node-1205 out of service", "CDU-4 maintenance approved" | `allow` (`warn` when a shift lead approved a warn) | the target, or the job's racks |
| `lease_denied` | "CDU-4 maintenance denied" | `deny` or `warn` | the part |
| `lease_released`, `lease_expired` | "lease-1 released" | `info` | the target, or the job's racks |
| `feature_state` | "Gateway 3 readings degraded", "Text paging recovered" | new: `degraded` (gold) / `recovered` (ok) | the covered CDUs, or the service's card |
| `tech_dispatched` | "Hardware tech sent to node-1205" (add "by email" when `channel` is email) | `info`, or new `unconfirmed` (gold) when `page_status` is unconfirmed | the node |
| `notified` | "Told tenant-gamma" | `info` / `unconfirmed` | the subject |
| `page_resent` | "Re-sent page-1 to the hardware tech by email" | `info` | the subject |
| `approval_requested` | "Shift lead asked to approve CDU-4" | `warn` | the part |
| `escalated` | "Handed node-233 to the scheduler agent" | new: `handoff` (gold) | the subject |
| `agent_plan` | "Plan: diagnose → lease → tech → tenant" | new: `plan` (azure) | the subject |
| `agent_step` | the reason as-is | `info` | the subject |
| `agent` | "Fixed node-1205" / "Waiting" / "Handed off" | new: `fixed` (azure) / `info` / `handoff` | the subject |

To turn a subject into a focus target: a node id becomes `{kind: 'node'}`; a part id becomes `{kind: 'part'}`; a protection lease or a job becomes `{kind: 'racks', ids: <the job's racks>}`; a feature becomes its covered parts.
- [ ] **`format.ts`:** add `plan`, `handoff`, `fixed`, `degraded`, `unconfirmed` and `recovered` to `VERDICT`. Suggested tones follow the colour rules already there: azure for an agent's own actions, gold for anything that needs a person or isn't confirmed.
- [ ] **`types.ts`:**
  - Add `'fixer'`, `'dependency'` and `'shift_lead'` to `ActorKind`. The feed shows the actor's name, so the kind only keeps the types right.
  - `Lease.target` can now be a node id, and `Lease` gains `routine?` and `note?`.
  - `JobStatus.status` gains `'finished'`.
  - `Margin` gains `unconfirmed?: string[]`.
- [ ] **Map and node card:** show a node with an active maintenance lease as out of service. This is derived from `leases`, with no new node state. The node card's role line could read "Out of service · lease-3 until T+4h08m".
- [ ] **Optional but worth it for judges:** let an `agent_plan` row expand into its numbered steps. The agents writing their own plans are the Nemotron highlight.

## 5. Dependency agent

Built on this branch and waiting on approval; see [`agents/DEPENDENCY_AGENT.md`](agents/DEPENDENCY_AGENT.md). Its SpacetimeDB pieces are already in §3. On the frontend it also needs:

- **Services panel:** a "Services we rely on" sidebar section, where each row shows what the service says, what we observed (`feature_state`), a one-line reason and since when. Clicking a row opens a service card with its dependencies, each feature's last test, and who relies on it.
- **"Can't confirm" look:** for CDUs covered by a degraded feature, and for racks whose `unconfirmed` list isn't empty. It needs to look different from gold and red, so they don't read as failed.
- **Unconfirmed-page marker:** on a node whose page is `unconfirmed`.
- **Fail-closed banner:** shown while `keys.revocation` is degraded: "Every facility change needs a shift lead until key revocation is current."
- **Legend entries:** for the new looks.

## 6. Who does what

| Piece | Owner | Status |
| --- | --- | --- |
| SpacetimeDB tables, reducers and rules from the contract | SpacetimeDB teammate | Module on `spacetime-init`; gaps listed in DESIGN.md §8.4 |
| HTTP adapter so the agents use SpacetimeDB instead of the simulated hall | Agents (`nemotron-init`) | Next: after the DESIGN.md §8.4 additions |
| Subscription, agent events in the decision feed, and §5 | Frontend teammate | Not started |
| Brev machine as the primary model | Agents | Waiting on a Brev machine; the free OpenRouter backup works now |
| Fixer agent | Agents | Built |
| Dependency agent | Agents | Built; **deferred** until the fixer is live |
| MCP server | Unassigned | If time, last |

## 7. Try it now (no backend needed)

```
uv venv .venv --python 3.11
uv pip install -r requirements.txt
copy .env.example .env
.venv\Scripts\python -m agents.fixer --scripted
.venv\Scripts\python -m agents.dependency --scripted
.venv\Scripts\python -m pytest
```

`--scripted` sends no model requests. To run on Nemotron, put your own OpenRouter key in `.env` and drop `--scripted`.
