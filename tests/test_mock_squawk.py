"""The simulated Squawk the agents act on: same hall as frontend/src/mock, and the
guard rules the fixer agent depends on (DESIGN.md §3-§6)."""

from __future__ import annotations

import pytest

from agents.squawk import SquawkUnavailable, OutOfScope
from agents.mock_squawk import JOB_ID, Actor, MockSquawk

FIXER = "fixer-agent"


@pytest.fixture
def br() -> MockSquawk:
    return MockSquawk()


def test_hall_matches_the_frontend_mock(br):
    assert len(br.site.racks) == 160 and len(br.site.node_rack) == 1280
    assert [r for r in br.site.downstream["cdu-3"] if br.site.racks[r].cooling_feeds[0][0] == "cdu-3"] == [
        f"rack-r1-{p}" for p in range(11, 16)
    ]
    assert all(br.site.racks[f"rack-r1-{p}"].cooling_feeds[1][0] == "cdu-4" for p in range(11, 16))
    assert br.site.racks["rack-r1-12"].nodes == tuple(f"node-{n}" for n in range(417, 425))
    owners = list(br.owner.values())
    assert sum(o.kind == "job" for o in owners) == 1000
    assert sum(o.kind == "free" for o in owners) == 160


def test_degraded_cdu3_leaves_its_five_racks_one_failure_from_an_outage(br):
    assert all(br.rack(r).level == "green" for r in br.site.racks)
    br.set_part_state("cdu-3", "degraded")
    yellow = [r for r in br.racks_below("cdu-3") if br.rack(r).level == "yellow"]
    assert yellow == [f"rack-r1-{p}" for p in range(11, 16)]
    assert "CDU-4" in br.rack("rack-r1-12").reason


def test_cdu4_maintenance_is_refused_with_both_blockers(br):
    br.set_part_state("cdu-3", "degraded")
    lock = br.protect("scheduler-agent", JOB_ID, 72 * 60).lease
    check = br.simulate("cooling-agent", "cdu-4")
    assert check.verdict == "deny"
    assert check.reason.startswith("CDU-4 is the only cooling feed for 5 racks (CDU-3 degraded)")
    assert "protected for job-train-1" in check.reason
    assert {(b.kind, b.id) for b in check.blockers} == {("part_repair", "cdu-3"), ("lease_ends", lock.id)}
    assert check.earliest_safe == "after CDU-3 repair and after protection ends (T+72h)"


def test_cdu4_maintenance_needs_a_shift_lead_once_everything_is_healthy(br):
    check = br.simulate("cooling-agent", "cdu-4")
    assert check.verdict == "warn" and "one failure from an outage" in check.reason
    decision = br.request_lease("cooling-agent", target="cdu-4", minutes=120, routine=True)
    assert not decision.granted and br.leases_on("cdu-4") == []


def test_shift_lead_approval_grants_a_warn(br):
    br.request_approval(FIXER, "cdu-4", 120, "routine service", requested_for="cooling-agent")
    approval = br.events[-1].data["approval"]
    with pytest.raises(OutOfScope):
        br.approve(FIXER, approval)  # agents can't approve
    decision = br.approve("shift-lead", approval)
    assert decision.granted and decision.lease.actor == "cooling-agent"
    assert "Approved by shift-lead" in decision.reason


def test_servicing_a_part_that_is_already_down_is_allowed(br):
    br.set_part_state("cdu-3", "degraded")
    assert br.simulate(FIXER, "cdu-3").verdict == "allow"


def test_node_leases(br):
    assert br.request_lease(FIXER, target="node-1205", minutes=240).granted  # free spare
    assert br.simulate(FIXER, "node-417").verdict == "deny"  # runs job-train-1
    assert br.simulate(FIXER, "node-1131").verdict == "warn"  # tenant-gamma, still working
    br.set_node_state("node-1131", "failed")
    assert br.simulate(FIXER, "node-1131").verdict == "allow"  # tenant node already down
    assert br.simulate("cooling-agent", "node-1205").verdict == "deny"  # fixer holds it


def test_asking_twice_returns_the_same_lease(br):
    first = br.request_lease(FIXER, target="node-1205", minutes=240)
    second = br.request_lease(FIXER, target="node-1205", minutes=240)
    assert second.granted and second.lease == first.lease and len(br.leases_on("node-1205")) == 1


def test_stale_protection_can_be_released_only_after_the_job_finishes(br):
    lock = br.protect("scheduler-agent", JOB_ID, 72 * 60).lease
    refused = br.release_lease(FIXER, lock.id)
    assert not refused.ok and "running" in refused.reason
    br.set_job_status(JOB_ID, "stopped")
    assert not br.release_lease(FIXER, lock.id).ok  # a stopped job may restart
    br.set_job_status(JOB_ID, "finished")
    assert br.release_lease(FIXER, lock.id).ok
    assert br.protection_leases(JOB_ID) == []


def test_only_the_holder_releases_a_maintenance_lease(br):
    lease = br.request_lease(FIXER, target="node-1205", minutes=240).lease
    assert not br.release_lease("cooling-agent", lease.id).ok
    assert br.release_lease(FIXER, lease.id).ok


def test_diagnosis(br):
    br.set_node_state("node-1205", "failed")
    assert br.diagnose_failure("node-1205").classification == "isolated"

    br.set_part_state("cdu-3", "degraded")
    d = br.diagnose_failure("node-417")
    assert (d.classification, d.cause, len(d.at_risk)) == ("shared_cause", "cdu-3", 39)
    assert d.send == "mechanical tech to CDU-3"

    br.set_node_state("node-1206", "failed")  # same rack as node-1205, minutes apart
    d = br.diagnose_failure("node-1206")
    assert d.classification == "shared_cause" and d.cause == "pdu-r10-a"


def test_leases_expire_with_an_event(br):
    lease = br.request_lease(FIXER, target="node-1205", minutes=60).lease
    br.advance(60)
    assert br.lease(lease.id) is None
    assert br.events[-1].type == "lease_expired" and br.events[-1].subject == lease.id


def test_scope_is_checked_first_and_every_action_is_audited():
    br = MockSquawk(actors=(Actor(FIXER, "remediation_agent", rows=frozenset({9})),))
    with pytest.raises(OutOfScope):
        br.request_lease(FIXER, target="node-1205", minutes=60)  # row 10
    assert br.audit[-1]["verdict"] == "out_of_scope" and br.leases == {}
    with pytest.raises(OutOfScope):
        br.request_lease("someone", target="node-1131", minutes=60)
    assert br.request_lease(FIXER, target="node-1129", minutes=60).granted is False  # tenant, warn
    assert [a["call"] for a in br.audit] == ["request_lease"] * 3


def test_unreachable_squawk_raises(br):
    br.available = False
    with pytest.raises(SquawkUnavailable):
        br.get_events()
