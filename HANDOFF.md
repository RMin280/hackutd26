# HANDOFF.md

*Last updated: 2026-11-07, late. Merged across the `main`, `frontend`, `spacetime-init` and `nemotron-init` branches and updated with the decisions in §3. Read this first if you're picking up Squawk: a teammate joining, a new Claude Code session, or you after a break.*

## 1. The project in 30 seconds

**Squawk** is our entry for the NMC² data center challenge: *air traffic control for datacenter work, for humans and AI agents alike.*

**Locked scope:**

> Every action is checked before it happens, and when a node in a big job fails, we find the real cause and a safe place to restart.

In plain words:
1. **It checks before anyone acts.** Technicians, job schedulers and AI agents ask first. If an action would leave servers with no backup, the answer is no, with the reason and when it'll be safe.
2. **When something breaks, it figures out why.** One bad node, or a shared cause like a cooling unit that will take out its neighbours next?
3. **It finds a safe place to restart.** Healthy, fully backed-up racks away from the problem, locked so nobody does maintenance on them mid-job.
4. **It clears the routine work.** A Nemotron fixer agent handles low-criticality issues on its own, through those same checks, so people only see what matters.

It is one system: the backend decides, the view shows, the agent acts through it.

**One sentence for anyone:** "Squawk makes sure every person and AI agent in a datacenter checks before they act, and when something fails, it finds the real cause and a safe place to start again."

## 2. Where things are

### 2.1 Branches (as of 2026-11-07, repo `RMin280/hackutd26`)

| Branch | Head | What's on it | Merge status |
| --- | --- | --- | --- |
| `main` | `c0a85f7` | Original docs (the Python-plan versions) + the frontend after PR #1 "refined look" | — |
| `frontend` | `2352cd7` | The Nov 7 visual pass: Squawk rebrand on screen, seagull crew (`Staff.tsx`), hot-aisle doors, server LEDs, camera work. Branched from `main` | Merges into `main` cleanly (trial merge: no conflicts) |
| `spacetime-init` | `e0c38ea` | The backend (`spacetimedb/`), `dev.sh`, the view's live mode (`frontend/src/live/`) with **generated bindings** (`frontend/src/module_bindings/`), docs (DESIGN v0.5). Branched from `main` after PR #1 | Merges cleanly after `frontend` (only `frontend/README.md` and `package-lock.json` touched by both, and git resolves them) |
| `nemotron-init` | `9efe385` | The Nemotron agents (`agents/`, `tests/`, `MERGE.md`, `.env.example`). Branched from the first commit, so it carries an older copy of `frontend/` that merges away. No frontend code changed | Conflicts **only in `CLAUDE.md` and `DESIGN.md`** (stack, layout, commands; §4.3 events). `HANDOFF.md` auto-merges but ends up stale. The merged docs are the resolution |

Merge order: `frontend` → `spacetime-init` → `nemotron-init` into one integration branch, then the rename (§8 step 2), then the three merged docs, then PR to `main`.

### 2.2 Files

| File | What it is | Status |
| --- | --- | --- |
| `CLAUDE.md` | Rules for Claude Code: locked scope, frozen feature list, scope and scalability rules, security rules, stack, repo layout | **Current** (merged + decisions) |
| `DESIGN.md` | Source of truth: facility model, algorithms, the agents and their contract (§8), security, demo scenario with the fixer (§10.2), deployment (§10.5), roadmap | **Current** (v0.6) |
| `README.md`, `dev.sh` | How to run the backend and the view in live mode | **Current** (`spacetime-init`); rename pending |
| `spacetimedb/` | Backend: SpacetimeDB module (tables + reducers), the interlock with work scopes, diagnosis, placement, the presenter's scenario, the diagnostics test bed, tests. Start with its `README.md` | **Current** (`spacetime-init`). First real `spacetime publish` against a live server: **confirm** |
| `frontend/` | The control-room view (Squawk). `src/mock/` = offline fallback, `src/live/` = SpacetimeDB data source, `src/module_bindings/` = generated | Visuals on `frontend`, live mode on `spacetime-init`; **being combined** (§8 step 1) |
| `agents/` | Nemotron model router (Brev primary, OpenRouter free fallback), the fixer agent, the dependency agent (deferred), a simulated Squawk they run on, and the SpacetimeDB contract in `agents/README.md` | **Current** (`nemotron-init`); runs on its own simulated hall; **the HTTP adapter to the backend is the next build** |
| `MERGE.md` | What the backend and the view add for the agents' work to show up, plus merge notes for `nemotron-init` | **Current**, except §6 (the SpacetimeDB branch exists: `spacetime-init`) and §5 (dependency agent deferred) |
| `agents/DEPENDENCY_AGENT.md` | The dependency agent's design, storyline and backend/view needs | **Current**; deferred until the fixer is live |
| Project doc `frontend-status.md` (claude.ai project, not in the repo) | Frontend decisions and open items | **Partly stale**: the Nov 7 pass it calls "not committed yet" is commit `2352cd7`; its open question on renaming the docs is decided (Squawk) |
| Team doc: [Team Pitch & Explainer](https://claude.ai/artifact/333tugs6RPJvKxT4egcKVG) | Explainer for teammates | **Partly outdated:** the demo plan section is current; the story and pitch sections still tell the old "3am battery" version and use the old name. Use the pitch in §6 below |

Not in the repo, although older docs mentioned them: `FRONTEND.md`, the `.claude/skills/` workflow skill, `three-playground.html`, `data/site.json`, `backend/*.py`.

**If documents disagree, `DESIGN.md` wins, then `CLAUDE.md`.** Between branches, the code on `spacetime-init` is the backend's truth, `frontend` the view's, `nemotron-init` the agents'.

## 3. How we got here (key decisions and why)

| Decision | Why |
| --- | --- |
| Started as a "safety check" for actions on shared backup | Most outages come from a second action taking away the last backup; nothing referees between people, contractors and agents from different vendors |
| Added AI agents as first-class users | Agents are starting to act on facilities; they need the same check as humans |
| **Not Jira, not a scheduler replacement, not a dashboard** | Ticketing and change boards approve days ahead; the challenge rules out data aggregation; Slurm/Kubernetes already pack jobs. We give them a safe set plus a reason |
| **No prediction** | Mentors said predictive failure modeling doesn't work. Everything we do is a deterministic what-if on the current map. "One failure from an outage" means a rack is on its last backup *now*, not a forecast |
| Pivoted the hero story to the **1,000-node job failure** | Mentors said scheduling at scale is a big problem: when one node of a 1,000-node job fails, "you can't just reschedule, you have to figure it out." This made diagnosis + safe placement the core |
| **Security built in from day one** | Clients rank security first. Squawk approves physical actions and holds a map of every weak point, so it's a control plane |
| Split into **iterations** and **froze the feature list** | Scope creep is our #1 risk. The allocator, signed approvals, handoffs, software layers, look-ahead, grid mode and the AI assistant are all roadmap |
| **Scalability rules + performance tests** | Scalability is our #2 concern. The computing scales because every question touches only one branch of a shallow map; tests make sure nobody breaks that |
| Wording: "each agent sees only its own slice; nothing referees" | Agents *can* message each other; claiming they can't is wrong. Talking isn't coordinating, and humans aren't in those channels |
| **3D only** (three.js via React Three Fiber); the earlier "2D SVG first, 3D as a toggle" plan is dropped | The view is one full-screen 3D hall with a HUD; there is no 2D map. The presentation is the top priority, and the 3D hall is what sells it |
| **Backend on SpacetimeDB** (one TypeScript module) | Every reducer is a transaction, so two actors can never claim the same backup at the same instant: the second sees the first's lease. Clients subscribe to tables for live updates (replaces SSE). TypeScript matches the frontend and its mock engine |
| **The backend is the single source of truth** (2026-11-07) | Everything the view and the agents see comes from its tables. The view's mock and the agents' mock are offline fallbacks and leave the demo path once live mode works |
| **Scenario on the backend; fresh database = diagnostics test bed** | The view only renders; the backend runs each step as the scripted actors, checked step by step against the frontend mock. A fresh database holds five incidents with a private answer key so diagnostic agents can be tested and graded |
| **Scripted scheduler and cooling agents stay inside the backend's scenario runner** | Deterministic steps on stage (Space = one step), no extra processes, and the feed still reads as if those agents acted. The fixer is the only agent that runs as its own process |
| **Work scopes** for maintenance | Hardware claims space (node ⊂ rack ⊂ hot aisle) or a facility part; software is either online (shares nodes with jobs) or drain-required (runs alone); one maintenance item per node at a time. Then the backup check runs with every overlapping lease (DESIGN.md §4.4) |
| **Nemotron fixer agent in Python, behind a `Squawk` interface** | The Nemotron track wants agents that go beyond a chatbot: they wake on events, plan their own steps, use tools, and never act outside the interlock. Python because the model and tool-calling libraries are there; the interface so the mock hall works offline and the SpacetimeDB HTTP adapter drops in without touching the agent |
| **The fixer is in the main demo** (2026-11-07) | It works together with the backend and the view as one system; steps 7–9 of DESIGN.md §10.2 |
| **Dependency agent deferred** (2026-11-07) | Prioritize the fixer. It's built on `nemotron-init` and stays there; it comes back after the fixer is live (it needs five tables, two reducers, three rules and four view elements) |
| **Events: one feed, the `decision` table** (2026-11-07) | Chosen as the most scalable: one `seq` cursor for agents, one subscription for the view, nothing to merge. `decision` gains `type`, `subject`, `data`; a `record_event` reducer lets agent roles write rows (DESIGN.md §4.3) |
| **Our Nemotron on Brev first, Nemotron 3 Ultra (free) on OpenRouter as the automatic fallback** | No daily cap on Brev; the free tier (50 requests/day without credits) is the fallback and what works today. Both down → fail closed |
| **MCP server: if time, last** | Not needed for the demo; our agents call the backend's HTTP API directly. It's a thin wrapper over the same adapter, so it can be the last thing built |
| **Two machines over Tailscale** (2026-11-07) | A dedicated box runs SpacetimeDB, the fixer and the Brev port-forward; the presenter's machine runs the view against it. Nothing on the public internet |
| **Squawk, everywhere** (2026-11-07) | Screen, docs, pitch, database name and code identifiers. The old name is not used. The code rename is part of the merge (§8 step 2) |
| **Seagull crew, hot-aisle doors, LEDs** | Decoration that makes the hall feel alive on screen; no state, no clicks, hidden with `G` |

## 4. Mentor / judge feedback so far

1. **Predictive failure modeling doesn't work.** → We don't predict. Say so explicitly in the pitch.
2. **Scheduling is a really big problem at scale.** → Our core is now failure diagnosis + safe restart placement for big jobs.
3. **"If you schedule a job with 1,000 nodes and one fails, you can't just reschedule; you have to figure it out."** → That sentence is our demo.

Add new feedback here. New ideas from mentors go to the roadmap (`DESIGN.md` §11) unless they serve the locked sentence.

## 5. What's in Iteration 1 (this weekend) vs roadmap

**Build:**
- Facility map down to nodes and network switches (demo hall: 10 rows × 16 racks × 8 nodes = 1,280 nodes, five enclosed hot aisles; `job-train-1` on 1,000 nodes in Rows 1–8) — **done** (backend, view, agents' mock)
- Action check: remaining backup, simulate, leases with earliest safe time, protection locks, work scopes — **done** (backend)
- Failure diagnosis: shared cause vs isolated, at-risk nodes, who to send (hardcoded by cause) — **done** (backend)
- Safe placement: healthy, full-backup, outside the affected branch, no booked maintenance — **done** (backend)
- Scripted scheduler agent (naive vs Squawk mode) and cooling agent, as scripted actors in the backend's scenario runner — **done**
- One key per actor, row-level scopes, audit log — **done** (backend; scoped *reads* of topology are a known limit)
- One-click scenario + 100k-GPU scale test — **done** (backend; measured numbers in DESIGN.md §7.2)
- Control-room view: 3D hall, decision feed, cards, mode toggle, presenter keys — **done** on `frontend`; live mode **done** on `spacetime-init`; **combining them: in progress**
- Fixer agent (Nemotron) in the main demo — agent **built** on a simulated hall; **to do:** backend additions (DESIGN.md §8.4), the HTTP adapter, the view additions (DESIGN.md §10.1), scenario steps 7–9
- Two-machine deployment over Tailscale — **to do** (DESIGN.md §10.5, checklist in §8 below)
- MCP server (7 tools) — **if time, last**

**Roadmap only:** the dependency agent (built, deferred), job allocator, signed approvals and full security hardening, shift handoff, software layers (OS/VM/container), look-ahead and a deterministic playbook engine, grid mode, AI technician assistant, real integrations, SSO, multi-site.

**Minimum demo (protect above everything):**
1. A node in the 1,000-node job fails → shared cooling cause found, at-risk nodes listed.
2. Safe restart nodes returned on healthy racks and locked.
3. The cooling agent's maintenance request that would remove the last backup is refused, with a reason and the earliest safe time.

This runs end to end on the backend (`scenario_*`) and in the view's mock today. The fixer steps are the next layer, never a dependency of these three.

## 6. The pitch (current version)

**One-liner:** "Squawk is air traffic control for datacenter work: every person and AI agent checks with it before acting, and when something fails, it finds the real cause, a safe place to recover, and sends the right person to fix it."

**Structure (~2.5 min):**
1. **Hook:** datacenters have a backup for everything; outages happen when someone takes away the last one without knowing it.
2. **Problem:** everyone sees only their own slice; nobody referees. At scale, failures are constant: Meta's Llama 3 run on 16,384 GPUs hit 419 unexpected interruptions in 54 days.
3. **Solution, three things (count on fingers):** check every action; figure out what a failure means; send the work to the right place.
4. **Why trust it:** "We don't predict failures." Deterministic, every answer has a reason. On a simulated 100,000-GPU site, diagnosis plus safe placement takes under 3 ms (DESIGN.md §7.2; re-measure on the demo machine).
5. **Demo:** naive scheduler crashes twice on the same cooling loop; Squawk diagnoses, restarts once on locked healthy racks, and refuses the cooling agent's unsafe maintenance. Then the Nemotron fixer clears the routine work around it, writing its own plan into the feed and never acting outside the interlock, and closes the loop on the refused request once the repair is done.
6. **Close:** "Agents are about to run datacenters. Squawk makes sure they, and we, never use up the same safety margin twice."

**Template version:** "When operators start letting AI agents act on their facilities, datacenter teams struggle to trust those agents with real control because each agent, and each person, only sees its own slice of the facility, and nothing referees when two of them need the same backup. Our solution helps them put every agent and technician through one shared safety check, with clear limits on what each can do, improving how much work can be safely automated without adding outage risk."

**Notes:**
- The full pitch mentions "assigns the repair to Maria". The allocator is roadmap, so in the demo say "sends a cooling tech" unless it gets built.
- Nemotron track: `agents/README.md` maps the fixer to the judging criteria (beyond a chatbot, multi-step workflows, tool integration, real-world applicability). The expandable plan row in the feed is the thing to point at.
- Don't say "agents connect via MCP" unless the MCP server gets built; say "any agent connects through Squawk's API, and our Nemotron agent does".

## 7. Answers to have ready

- **"Isn't this Jira or a scheduler?"** Those record and plan work days ahead, or pack jobs. We decide in real time what's safe based on what's broken now, and hand the scheduler a safe set.
- **"Doesn't DCIM software already do this?"** Tools like Sunbird simulate failures for planning. None sits in front of every action and says no, for humans and agents alike.
- **"What if an agent ignores it?"** Iteration 1: agents fail closed and every action is logged. Roadmap: signed approvals that equipment refuses to act without.
- **"Is it scalable?"** Every question touches only the failed part's branch, a few dozen components, no matter how big the site. We skip job packing on purpose. Scale tests on a simulated 100k-GPU site enforce the limits (quote the measured numbers).
- **"What can't it catch?"** A wrong cable pulled by hand, or a shared weak point that isn't in the facility map. It's only as good as the map; production imports the map from the systems that already know the layout.
- **"Do agents really not see each other?"** They can message where someone wired it up, but talking isn't coordinating. Like pilots on the radio: the tower still decides who gets the runway.
- **"Why an LLM agent if everything is deterministic?"** The *decisions* are deterministic: what's safe, what a failure means, where to restart. The agent doesn't make those. It does the operator's routine work around them: notices an issue, plans the steps, calls the tools, hands off what isn't its job. Code decides what counts as an issue, checks the plan, and confirms the result; the model never picks a target or a verdict.
- **"What if the model goes rogue or gets prompt-injected?"** It only has the tools bound to the issue, every action is checked by Squawk, report text is fenced as untrusted, and the storyline includes an injected "release every protection lock" instruction that it ignores.
- **"Why two Nemotron endpoints?"** Our own model on Brev has no daily cap; the free OpenRouter Ultra is the automatic fallback. If both are down the agent stops and escalates; it never guesses.

## 8. Next steps (in order)

1. **Combine `frontend` + `spacetime-init`** (Claude, in progress): one integration branch; the Squawk view running the backend scenario in live mode; `frontend/README.md` = Squawk text + the live-mode section. Then merge `nemotron-init` on top (docs conflicts resolved by these merged docs).
2. **Rename to Squawk in code**, on the integration branch, in one sweep, then run `npm test` in `spacetimedb/` and `pytest`:
   - database name in `dev.sh`, `README.md`, `spacetimedb/README.md`, `frontend/.env.example`, `frontend/package.json` (`bindings` script) → `squawk`
   - the mode key and actor kind (`spacetimedb/src/core/{catalog,commands,lab,scenario,types}.ts`, `src/index.ts`, `spacetimedb/test/*`, `frontend/src/{store,model/types,mock/scenario,live/mapping,live/connection,live/config}.ts`, `frontend/src/ui/Sidebar.tsx`, `App.tsx`) → `squawk`; regenerate the bindings after
   - the agents: `agents/blast_radius.py` → `agents/squawk.py`, class `Squawk`, `MockSquawk`, `SquawkUnavailable`, `agents/mock_squawk.py`, `tests/test_mock_squawk.py`, every prompt string and docstring under `agents/`, `.env.example`
   - titles and package names (`spacetimedb/package.json`, `frontend/package.json`, `frontend/index.html`, console prefix and token key in `connection.ts`)
3. **Run the whole thing live once:** `bash dev.sh server`, then `bash dev.sh up`; confirm the first real `spacetime publish` works (the module type-checks against the `spacetimedb` 2.14 SDK first; keep the npm package no newer than the CLI) and the view runs the backend scenario.
4. **Backend additions for the fixer** (DESIGN.md §8.4, smallest first): `decision.type/subject/data` + `record_event` + the `remediation_agent` role; `routine`, `note`, `on_behalf_of`, `finished`, `request_approval`; the tenant-node `warn` rule. Regenerate the bindings.
5. **Agents' HTTP adapter** (`agents/squawk_http.py`): the `Squawk` interface over `POST /v1/database/squawk/sql` and `/call/<reducer>`, a `ticket` per request, `POST /v1/identity` once for the token; `register_actor` it as `fixer-agent`; `python -m agents.check_setup` against the live database; a contract test against `MockSquawk`.
6. **View additions for the fixer** (DESIGN.md §10.1): new `type`s in the feed, `plan`/`fixed`/`handoff` looks, `fixer` and `shift_lead` actor kinds, out-of-service nodes, the expandable plan row.
7. **Scenario steps 7–9** on the backend (`scenario.ts`) and the fixer reacting to them live. Rehearse on Nemotron; keep `--scripted` as the on-stage fallback.
8. **Deployment** (DESIGN.md §10.5): Tailscale on both machines; on machine A, SpacetimeDB listening on its tailnet address, the module published as `squawk`, the fixer with `SPACETIME_HOST` and its token in `.env`, the Brev port-forward; on machine B, `frontend/.env.local` pointing at machine A. Test from machine B before the rehearsal. Fallbacks: the view's mock (no backend) and `--scripted` (no model).
9. **Halfway checkpoint:** if the minimum demo doesn't run end to end *in live mode on the two machines*, cut to it (it already runs on the mock and on the backend separately).
10. **At ~75% of the time:** feature freeze. Rehearse, re-measure the scale numbers on the demo machine, put them in the pitch. Check the hall's dark tones on the venue screen; bundle Roboto (`npm i @fontsource/roboto`) so the font doesn't depend on venue Wi-Fi.
11. If time remains: the MCP server (7 tools) over the same adapter; side-by-side naive vs Squawk mode.

## 9. Open questions

1. Team owners for backend, agents, frontend and pitch; **who owns "no"** on scope. (The frontend + live-mode combination is assigned to Claude.)
2. MCP server: confirmed skip-unless-time, or do we want it for the pitch line?
3. Has `spacetime publish` run against a real server yet?
4. Is the Brev machine up, and which Nemotron size is on it (Nano / Super / Ultra)? Until then the demo runs on the free OpenRouter fallback (50 requests/day; the fixer storyline is ~24 calls).
5. Steps 7–9 of the demo (DESIGN.md §10.2): adjust the beats while building.
6. Demo hall size: is 1,280 nodes (160 spares) enough to make placement convincing?
7. Do we update the team doc's story and pitch sections before sharing it further?

## 10. Rules that are easy to forget

- If it's not in the "Build" column, don't code it. Write it into `DESIGN.md` §11.
- No request scans the whole facility; recompute only what's downstream of a change.
- Every decision returns a one-line reason naming the deciding facts.
- Never call `Date.now()` (or anything random) in core logic; time is the simulated `clock` table.
- No charts, no sensor data, no prediction, no ticket boards.
- Frontend holds no safety logic; it only displays what the backend decides.
- The model never decides: code triages, checks the plan and confirms the result; Squawk gives every verdict.
- One feed: everything goes through the `decision` table.
- Keys in `.env` only. Never commit `.env`, never paste a key into code or a doc.
- Say "Squawk", "safety interlock", "one failure from an outage", "each agent sees only its own slice". Don't say "preventive maintenance", "predicts failures", "agents can't talk to each other", or the old name.
