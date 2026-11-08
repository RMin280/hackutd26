# Dependency agent

*Status: built on `nemotron-init` (2026-11-07), waiting on approval. It's outside CLAUDE.md's original frozen Build list (the closest roadmap item was Iteration 5), so the scope owner should sign off. It doesn't touch the minimum demo.*

A second Nemotron agent, `dependency-agent`, with its own key and permissions in Squawk. It watches the services that Squawk and the agents depend on, and catches **gray failures**: a service says it's up, but a feature we use is broken because something it depends on failed.

It works the same way as the fixer, on the same shared machinery (`agents/common/`):
- Code decides what's broken.
- Nemotron plans and carries out the response, with tools bound to the issue.
- Squawk checks every action.
- Code confirms the result.

It stays within CLAUDE.md's hard rules: no dashboards or charts, just "is this feature working right now", and no prediction, only what's already broken.

```
.venv\Scripts\python -m agents.dependency              # Nemotron; the fixer runs alongside
.venv\Scripts\python -m agents.dependency --scripted   # scripted stand-in, no model requests
```

## Services it watches (simulated)

| Service | Depends on | Feature we rely on | How we test it from our side | Who relies on it |
| --- | --- | --- | --- | --- |
| Paging | SMS gateway, email relay | Paging by text (email as the fallback) | Send a test page; it must arrive within 2 min | The fixer's "send a tech", tenant notices, shift-lead approvals |
| Building management system (BMS) | 4 network gateways to the CDUs, 8 CDUs each | CDU states for Squawk's map | Each gateway's newest reading must be under 5 min old | Every backup margin, safety check and placement |
| Key service | Key database, feed of revoked keys | Refusing revoked keys | The list must have updated within 15 min | Every Squawk call (the security case) |

The tests run every 5 simulated minutes, in code, and cost no model calls (`agents/dependency/runner.py`). In the simulation, what they find follows a hidden true state that the services never report (`agents/mock_services.py`). Squawk sets each feature's state from the test results; the agent never sets it directly.

## Issue types

| # | Issue | What code does automatically | What the agent does | Alone or handed off |
| --- | --- | --- | --- | --- |
| 1 | **Silent paging failure.** Paging says up, but the test page by text never arrives | Marks text paging degraded. New pages go by email automatically; a page only comes back "unconfirmed" if email is down too | Finds pages sent by text since the last good test, re-sends them by email, tells the shift lead | Alone. Hands off if email is down too |
| 2 | **Stale cooling readings.** The BMS says up, but one gateway's readings are 5 min old or more | Marks that gateway's CDUs "unknown". Squawk stops counting them as backup, so their racks show "can't confirm" and maintenance that relies on them is refused until the readings are fresh | Retests to confirm, lists the racks that lost confirmed backup and any leases granted on stale readings, sends a controls engineer to the gateway | Hands off to the shift lead with those facts, because Squawk can't see part of the hall |
| 3 | **Revoked-key list out of date.** The key service says up, but the list is 15 min old or more | Squawk fails closed: facility changes need a shift lead until the list is current. Reads still work | Confirms with a retest, lists facility changes made since the last good update, pages the security owner | Always hands off, because it's security |
| 4 | **Dependency recovered.** A degraded feature passes its test again | Marks it working, and Squawk goes back to normal | Confirms with a second test and tells the shift lead it's clear | Alone. Hands off if it fails again within 30 min (flapping) |

If a retest passes unexpectedly, the agent revises its plan, tells the shift lead it was a one-off, and finishes.

**Not built: scheduler node health** (the optional #5 in the draft). It needs the restart-placement logic, which lives in the frontend mock and the SpacetimeDB backend, not in the agents' simulated hall.

## Working with the fixer, through Squawk only

The two agents never talk to each other. They react to each other's events:
- **Paging outage:** the fixer's page to a tech went out by text just before the failure was caught. The dependency agent finds it and re-sends it by email.
- **Stale readings:** a routine maintenance request that relies on the unknown CDUs is refused "until CDU readings are fresh". The fixer queues it like any refused request, with no model calls. Once the dependency agent's tests show the readings are back (#4), the fixer rechecks it and routes it to the shift lead.

## Storyline (`python -m agents.dependency`)

1. **T+41m:** the SMS gateway goes down, and paging still says up.
2. **T+42m:** a spare node fails. The fixer pages a tech by text.
3. **T+45m:** the scheduled tests catch it (#1). The dependency agent re-sends the fixer's page by email and tells the shift lead.
4. **T+60m:** gateway 3 goes quiet, and the BMS still says up.
5. **T+65m:** the tests catch it (#2). CDU-17 to CDU-24 become unknown, and 45 racks in Rows 5 to 8 can't confirm their backup. A controls engineer is sent, and the shift lead takes it.
6. **T+70m:** the cooling agent's routine CDU-25 request is refused until readings are fresh. The fixer queues it.
7. **T+80m:** gateway 3 comes back (#4). The fixer rechecks CDU-25 and asks the shift lead to approve.
8. **T+95m:** the revoked-key feed stalls. **T+100m:** the shift lead approves CDU-25.
9. **T+110m:** the tests catch the stale list (#3). Squawk fails closed, the security owner is paged, and the shift lead takes it.
10. **T+112m:** the cooling agent's next request needs a shift lead.

It takes about 31 model calls across both agents. A live run of steps 1 to 3 on Nemotron 3 Ultra (free) used 11.

## SpacetimeDB additions

- **Tables:**
  - `service`
  - `service_dependency`
  - `feature`
  - `feature_state`: state, reason, since, last test, last good, recovered at, what the service says
  - `page`: who it went to, subject, message, channel, when it was sent, status (sent / unconfirmed / resent), who sent it
- **Reducers:**
  - `record_test(feature, passed, detail, service_says)`: the module sets the feature's state from the result, and writes a `feature_state` event when it changes.
  - `resend_page(page, channel)`
- **Rules the module enforces:**
  - Unknown parts don't count as backup. Refusals caused by them carry a `feature_ok` blocker, and the rack view lists its `unconfirmed` parts.
  - New pages go by email while text paging is degraded, and are unconfirmed when both channels are.
  - While the revoked-key list is out of date, facility changes need a shift lead.
- **Events:** `feature_state` and `page_resent`. `tech_dispatched` and `notified` gain `page`, `channel` and `page_status`.

## Frontend

The frontend teammate owns this. The pieces it needs are listed in [MERGE.md §5](../MERGE.md#5-dependency-agent).
