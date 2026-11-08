# Dependency agent (proposal)

*Status: drafted 2026-11-07, **not built**. It needs approval of the services and issue types below, and the scope owner's sign-off: it's outside CLAUDE.md's frozen Build list (the closest roadmap item is Iteration 5). It doesn't touch the minimum demo.*

A second Nemotron agent, `dependency-agent`, with its own key and permissions in Blast Radius. It watches the services that Blast Radius and the agents depend on, and catches **gray failures**: a service says it's up, but a feature we use is broken because something it depends on failed.

It works the same way as the fixer:
- Code decides what's broken.
- Nemotron plans and carries out the response, with tools bound to the issue.
- Blast Radius checks every action.
- Code confirms the result.

It stays within CLAUDE.md's hard rules: no dashboards or charts, just "is this feature working right now", and no prediction, only what's already broken.

## Services it watches (simulated)

| Service | Depends on | Feature we rely on | How we test it from our side | Who relies on it |
| --- | --- | --- | --- | --- |
| Paging | SMS gateway, email relay | Paging by text (email as the fallback) | Send a test page; it must arrive within 2 min | The fixer's "send a tech", tenant notices, shift-lead approvals |
| Building management system (BMS) | 4 network gateways to the CDUs, 8 CDUs each | CDU states for Blast Radius's map | Each gateway's newest reading must be under 5 min old | Every backup margin, safety check and placement |
| Key service | Key database, feed of revoked keys | Refusing revoked keys | List updated within 15 min, and a known-revoked test key must be refused | Every Blast Radius call (the security case) |

The tests run on a schedule, in code. In the simulation, what they find follows a hidden true state that the service itself doesn't report. Wherever a service is shown, its own "up" appears next to what we observed.

## Issue types

| # | Issue | What code does automatically | What the agent does | Alone or handed off |
| --- | --- | --- | --- | --- |
| 1 | **Silent paging failure.** Paging says up, but the test page never arrives | Marks text paging degraded; pages sent by text now come back "unconfirmed" | Finds pages sent since the last good test, re-sends them by email, tells the shift lead | Alone. Hands off if email fails too |
| 2 | **Stale cooling readings.** The BMS says up, but one gateway's readings are over 5 min old | Marks that gateway's CDUs "unknown". Blast Radius stops counting them as backup, so their racks show "can't confirm" and maintenance that relies on them is refused | Retests to confirm, lists the racks that lost confirmed backup, rechecks leases granted since the last fresh reading, sends a controls engineer to the gateway | Hands off to the shift lead with that list, because Blast Radius can't see part of the hall |
| 3 | **Revoked-key list out of date.** The key service says up, but the list is old or the revoked test key gets through | Blast Radius fails closed: every facility change needs a shift lead until the list is current. Reads still work | Confirms with the test key, lists facility changes made since the last good update, pages the security owner | Always hands off, because it's security |
| 4 | **Dependency recovered.** A degraded feature passes its test again | Marks it working, and Blast Radius goes back to normal | Confirms with a second test and tells the shift lead it's clear | Alone. Hands off if it fails again within 30 min |

**Optional #5: scheduler node health.** The scheduler keeps listing nodes as healthy even when its link to their management controllers is down. The agent would mark those nodes "unknown" so safe placement skips them. This ties straight into the minimum demo's restart placement, but that placement logic lives in the frontend mock and the SpacetimeDB backend, not in the agents' simulated hall.

## Working with the fixer, through Blast Radius only

- **Paging outage:** the fixer's page to a tech comes back unconfirmed, and the dependency agent re-sends it by email.
- **Stale readings:** a routine maintenance request that relies on the unknown CDUs is refused "until CDU readings are fresh". The fixer queues it like any refused request. Once the dependency agent confirms the readings are back (#4), the fixer rechecks it and books it.

## Mock data

This goes into the agents' simulated hall first (`agents/mock_blast_radius.py`), with the same shapes in SpacetimeDB later.
- **New data:** services; their dependencies, each with a hidden true state the service doesn't report; features, with what each needs and who uses it; test results; each feature's current state; and pages, with the channel they went out on and whether they were confirmed.
- **CDU state gains "unknown":** an unknown feed doesn't count as working backup.

```json
{
  "id": "bms",
  "name": "Building management system",
  "depends_on": ["fieldbus-1", "fieldbus-2", "fieldbus-3", "fieldbus-4"],
  "features": [
    { "id": "bms.cooling.3", "needs": ["fieldbus-3"], "covers": ["cdu-17", "...", "cdu-24"], "used_by": ["Blast Radius margins"] }
  ],
  "test": { "kind": "reading_age", "max_minutes": 5 }
}
```

**Storyline** (a separate run, in the same hall):
1. **T+40m:** the SMS gateway goes down, and paging still says up (#1).
2. **T+45m:** a spare node fails. The fixer sends a tech, the page comes back unconfirmed, and it's re-sent by email.
3. **T+60m:** gateway 3 goes quiet, and the BMS still says up (#2). The cooling agent's routine request is refused, and the fixer queues it.
4. **T+80m:** gateway 3 comes back (#4), and the fixer rechecks the queued request.
5. **T+100m:** the revoked-key feed stalls (#3), and Blast Radius fails closed.

## SpacetimeDB additions

- **Tables:**
  - `service`
  - `service_dependency`
  - `feature`
  - `feature_state`: state, reason, since, last test, last good
  - `page`: who it went to, channel, when it was sent, whether it was confirmed
- **Reducers:**
  - `record_test(feature, passed, detail)`: the module sets the feature's state from the result; the agent never sets it directly.
  - `resend_page(page, channel)`
- **Rules the module enforces:**
  - Unknown parts don't count as backup.
  - Notifications sent over a degraded channel come back unconfirmed.
  - While the revoked-key list is out of date, facility changes need a shift lead.

## Frontend

The frontend teammate owns this. The pieces it needs are listed in [MERGE.md §5](../MERGE.md#5-proposed-next-dependency-agent-not-built-yet).
