# HANDOFF.md

*Last updated: 2026-11-07. Read this first if you're picking up Blast Radius: a teammate joining, a new Claude Code session, or you after a break.*

## 1. The project in 30 seconds

**Blast Radius** is our entry for the NMC² data center challenge: *air traffic control for datacenter work, for humans and AI agents alike.*

**Locked scope:**

> Every action is checked before it happens, and when a node in a big job fails, we find the real cause and a safe place to restart.

In plain words:
1. **It checks before anyone acts.** Technicians, job schedulers and AI agents ask first. If an action would leave servers with no backup, the answer is no, with the reason and when it'll be safe.
2. **When something breaks, it figures out why.** One bad node, or a shared cause like a cooling unit that will take out its neighbours next?
3. **It finds a safe place to restart.** Healthy, fully backed-up racks away from the problem, locked so nobody does maintenance on them mid-job.

**One sentence for anyone:** "Blast Radius makes sure every person and AI agent in a datacenter checks before they act, and when something fails, it finds the real cause and a safe place to start again."

## 2. Where things are

| File | What it is | Status |
| --- | --- | --- |
| `CLAUDE.md` | Rules for Claude Code: locked scope, frozen feature list, scope and scalability rules, security rules, stack, repo layout | **Current** |
| `DESIGN.md` | Source of truth: facility model, algorithms, MCP tools, security, scenario, scale limits, roadmap | **Current** (v0.4) |
| `FRONTEND.md` | Control-room view features in P0 / P1 / P2 tiers, what not to build, endpoints, build order | **Current** |
| `.claude/skills/blast-radius-dev/SKILL.md` | Step-by-step workflow Claude Code follows when changing code | **Current** |
| `three-playground.html` | Standalone three.js sandbox of the demo hall that plays the story with 4 buttons. Exploration only | Prototype |
| `agents/` | Nemotron model router (Brev primary, OpenRouter free backup), the fixer agent for low-criticality issues, a simulated Blast Radius it runs on, and the SpacetimeDB contract in `agents/README.md` | **Current** (branch `nemotron-init`) |
| Team doc: [Blast Radius — Team Pitch & Explainer](https://claude.ai/artifact/333tugs6RPJvKxT4egcKVG) | Explainer for teammates | **Partly outdated:** the demo plan section is current; the story and pitch sections still tell the old "3am battery" version. Use the pitch in §6 below. |

**If documents disagree, `DESIGN.md` wins, then `CLAUDE.md`.**

## 3. How we got here (key decisions and why)

| Decision | Why |
| --- | --- |
| Started as a "safety check" for actions on shared backup | Most outages come from a second action taking away the last backup; nothing referees between people, contractors and agents from different vendors |
| Added AI agents as first-class users via **MCP** | Agents are starting to act on facilities; they need the same check as humans. MCP is the standard way for agents to call tools |
| **Not Jira, not a scheduler replacement, not a dashboard** | Ticketing and change boards approve days ahead; the challenge rules out data aggregation; Slurm/Kubernetes already pack jobs. We give them a safe set plus a reason |
| **No prediction** | Mentors said predictive failure modeling doesn't work. Everything we do is a deterministic what-if on the current map. "One failure from an outage" means a rack is on its last backup *now*, not a forecast |
| Pivoted the hero story to the **1,000-node job failure** | Mentors said scheduling at scale is a big problem: when one node of a 1,000-node job fails, "you can't just reschedule, you have to figure it out." This made diagnosis + safe placement the core |
| **Security built in from day one** | Clients rank security first. Blast Radius approves physical actions and holds a map of every weak point, so it's a control plane |
| Split into **iterations** and **froze the feature list** | Scope creep is our #1 risk. The allocator, signed approvals, handoffs, software layers, look-ahead, grid mode and the AI assistant are all roadmap |
| **Scalability rules + performance tests** | Scalability is our #2 concern. The computing scales because every question touches only one branch of a shallow map; tests make sure nobody breaks that |
| Wording: "each agent sees only its own slice; nothing referees" | Agents *can* message each other; claiming they can't is wrong. Talking isn't coordinating, and humans aren't in those channels |
| 2D SVG map first; three.js 3D only as a P2 toggle | 3D is impressive but costs time and readability; the 2D map is the safe fallback |

## 4. Mentor / judge feedback so far

1. **Predictive failure modeling doesn't work.** → We don't predict. Say so explicitly in the pitch.
2. **Scheduling is a really big problem at scale.** → Our core is now failure diagnosis + safe restart placement for big jobs.
3. **"If you schedule a job with 1,000 nodes and one fails, you can't just reschedule; you have to figure it out."** → That sentence is our demo.

Add new feedback here. New ideas from mentors go to the roadmap (`DESIGN.md` §11) unless they serve the locked sentence.

## 5. What's in Iteration 1 (this weekend) vs roadmap

**Build:**
- Facility map down to nodes and network switches (demo hall: 10 rows × 16 racks × 8 nodes = 1,280 nodes; `job-train-1` on 1,000 nodes in Rows 1–8)
- Action check: remaining backup, simulate, leases with earliest safe time, protection locks
- Failure diagnosis: shared cause vs isolated, at-risk nodes, who to send (hardcoded by cause)
- Safe placement: healthy, full-backup, outside the affected branch, no booked maintenance
- MCP server with 7 tools: `check_risk`, `simulate`, `request_lease`, `release_lease`, `get_events`, `diagnose_failure`, `safe_placement`
- Scripted scheduler agent (naive mode vs Blast Radius mode) and cooling agent
- Fixer agent (Nemotron): 4 low-criticality issue types fixed only through Blast Radius (DESIGN.md §8.2)
- One key per actor, row-level scopes, audit log
- Control-room view: FRONTEND.md P0 + P1
- One-click scenario + 100k-GPU scale test

**Roadmap only:** job allocator, signed approvals and full security hardening, shift handoff, software layers (OS/VM/container), look-ahead and playbooks, grid mode, AI technician assistant, real integrations, SSO, multi-site.

**Minimum demo (protect above everything):**
1. A node in the 1,000-node job fails → shared cooling cause found, at-risk nodes listed.
2. Safe restart nodes returned on healthy racks and locked.
3. The cooling agent's maintenance request that would remove the last backup is refused, with a reason and the earliest safe time.

## 6. The pitch (current version)

**One-liner:** "Blast Radius is air traffic control for datacenter work: every person and AI agent checks with it before acting, and when something fails, it finds the real cause, a safe place to recover, and sends the right person to fix it."

**Structure (~2.5 min):**
1. **Hook:** datacenters have a backup for everything; outages happen when someone takes away the last one without knowing it.
2. **Problem:** everyone sees only their own slice; nobody referees. At scale, failures are constant: Meta's Llama 3 run on 16,384 GPUs hit 419 unexpected interruptions in 54 days.
3. **Solution, three things (count on fingers):** check every action; figure out what a failure means; send the work to the right place.
4. **Why trust it:** "We don't predict failures." Deterministic, every answer has a reason; agents connect via MCP.
5. **Demo:** naive scheduler crashes twice on the same cooling loop; Blast Radius diagnoses, restarts once on locked healthy racks, and refuses the cooling agent's unsafe maintenance.
6. **Close:** "Agents are about to run datacenters. Blast Radius makes sure they, and we, never use up the same safety margin twice."

**Template version:** "When operators start letting AI agents act on their facilities, datacenter teams struggle to trust those agents with real control because each agent, and each person, only sees its own slice of the facility, and nothing referees when two of them need the same backup. Our solution helps them put every agent and technician through one shared safety check, with clear limits on what each can do, improving how much work can be safely automated without adding outage risk."

**Note:** the full pitch mentions "assigns the repair to Maria". The allocator is roadmap, so in the demo say "sends a cooling tech" unless it gets built.

## 7. Answers to have ready

- **"Isn't this Jira or a scheduler?"** Those record and plan work days ahead, or pack jobs. We decide in real time what's safe based on what's broken now, and hand the scheduler a safe set.
- **"Doesn't DCIM software already do this?"** Tools like Sunbird simulate failures for planning. None sits in front of every action and says no, for humans and agents alike.
- **"What if an agent ignores it?"** Iteration 1: agents fail closed and every action is logged. Roadmap: signed approvals that equipment refuses to act without.
- **"Is it scalable?"** Every question touches only the failed part's branch, a few dozen components, no matter how big the site. We skip job packing on purpose. Scale tests on a simulated 100k-GPU site enforce the limits (quote the measured numbers).
- **"What can't it catch?"** A wrong cable pulled by hand, or a shared weak point that isn't in the facility map. It's only as good as the map; production imports the map from the systems that already know the layout.
- **"Do agents really not see each other?"** They can message where someone wired it up, but talking isn't coordinating. Like pilots on the radio: the tower still decides who gets the runway.

## 8. Next steps (in order)

1. **Settle team questions** (5 min): owners for the four areas (see team doc demo plan), **who owns "no" on scope**, confirm the stack (Python + FastAPI + MCP SDK, React + Vite + TS).
2. **Create the repo** with `CLAUDE.md`, `DESIGN.md`, `FRONTEND.md`, `HANDOFF.md` and `.claude/skills/blast-radius-dev/SKILL.md`.
3. **First build task:** `data/site.json` (demo hall) + `backend/facility.py` (indexes) + `backend/guard.py` (margins, simulate), tested from the command line.
4. In parallel: `tools/gen_site.py` + `tests/test_scale.py` skeleton, so performance limits are enforced from day one.
5. Then: `diagnose.py` → `placement.py` → MCP server → scripted agents → scenario runner.
6. Frontend in FRONTEND.md's build order: static map → live SSE → decision feed → controls → cards → rack panel.
7. **Halfway checkpoint:** if the minimum demo doesn't run end to end, cut to it.
8. **At ~75% of the time:** feature freeze. Rehearse, record measured scale numbers, put them in the pitch.
9. Optional, after a full rehearsal works: 3D toggle (start from `three-playground.html`), side-by-side mode.

## 9. Open questions

- Team owners and the "no" owner (see §8).
- Stack confirmation.
- Demo hall size: is 1,280 nodes enough spares to make placement convincing?
- Is anyone strong in three.js? If not, skip 3D entirely.
- Do we update the team doc's story and pitch sections to the big-job version before sharing it further?

## 10. Rules that are easy to forget

- If it's not in the "Build" column, don't code it. Write it into `DESIGN.md` §11.
- No request scans the whole facility; recompute only what's downstream of a change.
- Every decision returns a one-line reason naming the deciding facts.
- Never call `datetime.now()` in core logic.
- No charts, no sensor data, no prediction, no ticket boards.
- Frontend holds no safety logic; it only displays what the backend decides.
- Say "safety interlock", "one failure from an outage", "each agent sees only its own slice". Don't say "preventive maintenance", "predicts failures", "agents can't talk to each other".
