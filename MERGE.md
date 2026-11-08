# Merging `nemotron-init`

*For the frontend and SpacetimeDB teammates. Checked against `main` at `c0a85f7` (PR #1, frontend "refined look"), 2026-11-07.*

## In short

- This branch adds the AI agents (Python, under `agents/`) and their tests. It doesn't touch `frontend/`.
- It merges cleanly with `main` (trial merge against `c0a85f7`: no conflicts).
- For the agents' work to show up in the control-room view, three pieces have to meet: the SpacetimeDB module (§3), a small adapter on this branch (§6), and the frontend's subscription plus a few display additions (§4).

## 1. What this branch adds

| Path | What it is |
| --- | --- |
| `agents/llm.py`, `agents/config.py` | Model access: our Nemotron on a Brev GPU machine first, Nemotron 3 Ultra (free) on OpenRouter as automatic backup |
| `agents/fixer/` | The fixer agent: fixes four low-criticality issue types only through Blast Radius, planning its own steps (DESIGN.md §8.2) |
| `agents/blast_radius.py` | The interface the agents code against: every read, check and action they need from Blast Radius |
| `agents/mock_blast_radius.py` | A simulated hall implementing that interface (same IDs as the frontend mock), used until SpacetimeDB exists |
| `agents/check_setup.py` | `python -m agents.check_setup`: checks keys, models and SpacetimeDB reachability |
| `agents/README.md` | How the agents work, plus the full SpacetimeDB contract |
| `agents/DEPENDENCY_AGENT.md` | Proposal for a second agent that catches hidden partial failures in services we rely on (not built) |
| `tests/` | 70 tests (`pytest`) |
| `requirements.txt`, `pytest.ini`, `.env.example` | Python setup; `.env` itself is gitignored |
| `CLAUDE.md`, `DESIGN.md`, `HANDOFF.md` | Edited: stack, layout and commands; one row in the Build list; §4.3 event types, §8.1-§8.2, §12; two lines in HANDOFF |

## 2. Merge notes

- **No frontend files changed**, so there are no code conflicts with the frontend work.
- **Docs are the only likely conflicts.** If another branch edits the same lines of `CLAUDE.md`, `DESIGN.md` or `HANDOFF.md`, keep both sides.
- **Python setup files:** if the SpacetimeDB branch adds its own `requirements.txt`, `pytest.ini` or `tests/`, combine the entries.
- **Keys:** everyone makes their own `.env` from `.env.example`. Never commit `.env` or paste keys into code.

## 3. For the SpacetimeDB branch

The full contract (tables, reducers, rules) is in [`agents/README.md`](agents/README.md#spacetimedb-contract-for-the-backend). Checklist:

- [ ] **Tables:** `node`, `rack_margin`, `part_rack`, `job` (status gains `finished`), `lease` (target can be a **node**; gains `routine`), `node_failure`, `event`, and `check_result` / `diagnosis` / `lease_decision` keyed by `request_id` (reducers can't return values).
- [ ] **Reducers:** `simulate`, `diagnose_failure`, `request_lease` (with `on_behalf_of`), `release_lease`, `request_approval`, `approve`, `dispatch_tech`, `notify`, `escalate`, `record`.
- [ ] **Identities and roles:** one identity per actor: `fixer-agent` (remediation_agent), `cooling-agent`, `scheduler-agent`, `shift-lead`. The permissions per role are `PERMISSIONS` in `agents/mock_blast_radius.py`.
- [ ] **Rules the module enforces:** each call checks the caller's role and rows first, and every call is audited. Node maintenance is denied if the node runs a running job, warned if a tenant node is still working, and allowed if it's a spare or already down. A protection lock can be released by its holder or a shift lead, or by the remediation agent once its job is `finished`. Booking `on_behalf_of` needs `book_for_others`, and the check runs as the requester.
- [ ] **Events:** write the rows below; the agents and the frontend both read them.
- [ ] **Then tell the agents side** the host, database name and how to get each agent's identity token, so the adapter in §6 can be written.

| Event `type` | `subject` | `data` fields | Written by |
| --- | --- | --- | --- |
| `state_change` | node or part | `kind` (node/part), `state`, `previous`, `note` (free text, untrusted) | facility / scenario |
| `lease_granted` | target part or node, or the job | `lease`, `target`, `verdict`, `until`, `routine`, `holder`, `approved_by`; protection leases: `job`, `racks` (count) | Blast Radius |
| `lease_denied` | target | `verdict` (deny/warn), `routine`, `minutes`, `note`, `earliest_safe`, `blockers` | Blast Radius |
| `lease_released`, `lease_expired` | lease id | `lease_type`, `target`, `job`, `holder`, `note` | Blast Radius |
| `release_denied` | lease id | none (the reason says why) | Blast Radius |
| `job_status` | job | `status` (running/stopped/finished), `previous` | scenario / scheduler |
| `tech_dispatched` | node or part | `trade`, `note` | fixer agent |
| `notified` | node or part | `to`, `message` | fixer agent |
| `approval_requested` | part | `approval`, `minutes`, `requested_for`, `summary` | fixer agent |
| `escalated` | node, part or lease | `to` (shift lead / scheduler agent) | fixer agent |
| `agent_plan` | node, part or lease | `steps` (`tool`, `why`, `when`), `revision`, `change` | fixer agent |
| `agent_step` | node, part or lease | none (the reason has the gist) | fixer agent |
| `agent` | node, part or lease | `issue`, `status` (started/waiting/fixed/handed_off/failed_closed), `model_calls`, `served_by` | fixer agent |

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
| `tech_dispatched` | "Hardware tech sent to node-1205" | `info` | the node |
| `notified` | "Told tenant-gamma" | `info` | the subject |
| `approval_requested` | "Shift lead asked to approve CDU-4" | `warn` | the part |
| `escalated` | "Handed node-233 to the scheduler agent" | new: `handoff` (gold) | the subject |
| `agent_plan` | "Plan: diagnose → lease → tech → tenant" | new: `plan` (azure) | the subject |
| `agent_step` | the reason as-is | `info` | the subject |
| `agent` | "Fixed node-1205" / "Waiting" / "Handed off" | new: `fixed` (azure) / `info` / `handoff` | the subject |

To turn a subject into a focus target: a node id becomes `{kind: 'node'}`; a part id becomes `{kind: 'part'}`; a protection lease or a job becomes `{kind: 'racks', ids: <the job's racks>}`.
- [ ] **`format.ts`:** add `plan`, `handoff` and `fixed` to `VERDICT`. Suggested tones follow the colour rules already there: azure for the agent's own actions, gold for anything that needs a person.
- [ ] **`types.ts`:**
  - Add `'fixer'` and `'shift_lead'` to `ActorKind`. The feed shows the actor's name, so the kind only keeps the types right.
  - `Lease.target` can now be a node id, and `Lease` gains `routine?` and `note?`.
  - `JobStatus.status` gains `'finished'`.
- [ ] **Map and node card:** show a node with an active maintenance lease as out of service. This is derived from `leases`, with no new node state. The node card's role line could read "Out of service · lease-3 until T+4h08m".
- [ ] **Optional but worth it for judges:** let an `agent_plan` row expand into its numbered steps. The agent writing its own plan is the Nemotron highlight.

## 5. Proposed next: dependency agent (not built yet)

Drafted, and waiting on approval and the scope owner's sign-off. It's a second agent that catches services which say they're up while a feature we rely on is broken (paging, building management readings, revoked keys). The full proposal is in [`agents/DEPENDENCY_AGENT.md`](agents/DEPENDENCY_AGENT.md). If it goes ahead:

- **SpacetimeDB:**
  - **Tables:** `service`, `service_dependency`, `feature`, `feature_state`, `page`.
  - **Reducers:** `record_test`, `resend_page`.
  - **Rules:** unknown parts don't count as backup; notifications over a degraded channel come back unconfirmed; while the revoked-key list is stale, facility changes need a shift lead.
- **Frontend:**
  - **Verdicts:** `degraded` and `unconfirmed` (gold), `recovered` (ok).
  - **Services panel:** a "Services we rely on" sidebar section, where each row shows what the service says, what we observed, a one-line reason and since when. Clicking a row opens a service card.
  - **"Can't confirm" look:** for unknown CDUs and for racks that lose confirmed backup. It needs to look different from gold and red, so they don't read as failed.
  - **Unconfirmed-page marker:** on a node whose tech page never arrived.
  - **Fail-closed banner:** shown while the revoked-key list is stale.
  - **Legend entries:** for the new looks.

## 6. Who does what

| Piece | Owner | Status |
| --- | --- | --- |
| SpacetimeDB tables, reducers and rules from the contract | SpacetimeDB teammate | No branch on GitHub yet |
| HTTP adapter so the agents use SpacetimeDB instead of the simulated hall | Agents (`nemotron-init`) | Waiting on the module |
| Subscription and agent events in the decision feed | Frontend teammate | Not started |
| Brev machine as the primary model | Agents | Waiting on a Brev machine; the free OpenRouter backup works now |
| Dependency agent | Agents | Drafted, waiting on approval |
| MCP server (frozen Build list) | Unassigned | Not started |

## 7. Try it now (no backend needed)

```
uv venv .venv --python 3.11
uv pip install -r requirements.txt
copy .env.example .env
.venv\Scripts\python -m agents.fixer --scripted
.venv\Scripts\python -m pytest
```

`--scripted` sends no model requests. To run it on Nemotron, put your own OpenRouter key in `.env` and drop `--scripted`.
