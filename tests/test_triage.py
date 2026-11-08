"""Deterministic triage: each of the four low-criticality types, and each case that must
go to a person or the scheduler agent instead."""

from __future__ import annotations

import pytest

from agents.fixer.triage import FIXER, Handoff, Issue, triage
from agents.mock_squawk import JOB_ID, MockSquawk


@pytest.fixture
def br() -> MockSquawk:
    return MockSquawk()


def last(br: MockSquawk):
    return triage(br.events[-1], br)


def only(items, cls):
    assert len(items) == 1 and isinstance(items[0], cls), items
    return items[0]


# 1. Broken spare or tenant node ----------------------------------------------------------


def test_failed_spare_is_low(br):
    br.set_node_state("node-1205", "failed", note="fans loud")
    issue = only(last(br), Issue)
    assert issue.kind == "broken_node" and issue.subject == "node-1205"
    assert issue.facts["owner"] == "a free spare" and issue.facts["tenant"] is None
    assert issue.untrusted_note == "fans loud"


def test_degraded_spare_is_low(br):
    br.set_node_state("node-1205", "degraded")
    assert only(last(br), Issue).kind == "broken_node"


def test_failed_tenant_node_is_low_and_names_the_tenant(br):
    br.set_node_state("node-1131", "failed")
    assert only(last(br), Issue).facts["tenant"] == "tenant-gamma"


def test_degraded_tenant_node_goes_to_a_person(br):
    br.set_node_state("node-1010", "degraded")
    handoff = only(last(br), Handoff)
    assert handoff.to == "shift lead" and "tenant-beta" in handoff.reason


def test_job_node_goes_to_the_scheduler_agent(br):
    br.set_node_state("node-233", "degraded")
    assert only(last(br), Handoff).to == "scheduler agent"


def test_shared_cause_goes_to_a_person(br):
    br.set_node_state("node-1205", "failed")
    br.set_node_state("node-1206", "failed")  # same rack minutes later: PDU-R10-A
    assert "Shared cause" in only(last(br), Handoff).reason


def test_node_on_a_rack_below_full_backup_goes_to_a_person(br):
    br.set_part_state("cdu-31", "degraded")  # rack-r10-07's primary CDU
    br.set_node_state("node-1205", "failed")
    assert "Not low" in only(last(br), Handoff).reason


# 2. Repaired node back to the spare pool -------------------------------------------------


def test_repaired_node_under_our_lease_is_low(br):
    br.set_node_state("node-1205", "failed")
    br.request_lease(FIXER, target="node-1205", minutes=240)
    br.advance(60)
    br.set_node_state("node-1205", "ok")
    issue = only(last(br), Issue)
    assert issue.kind == "node_repaired" and issue.facts["lease"] == br.leases_on("node-1205")[0].id


def test_repaired_node_without_our_lease_needs_nothing(br):
    br.set_node_state("node-1205", "failed")
    br.set_node_state("node-1205", "ok")
    assert last(br) == []


def test_node_that_failed_twice_in_a_day_goes_to_a_person(br):
    br.set_node_state("node-1205", "failed")
    br.request_lease(FIXER, target="node-1205", minutes=24 * 60)
    br.advance(100)
    br.set_node_state("node-1205", "ok")
    br.advance(200)
    br.set_node_state("node-1205", "failed")
    br.advance(300)
    br.set_node_state("node-1205", "ok")
    assert "failed 2 times in 24 h" in only(last(br), Handoff).reason


# 3. Refused routine maintenance ----------------------------------------------------------


def test_refused_routine_maintenance_is_requeued_with_its_blockers(br):
    br.set_part_state("cdu-3", "degraded")
    lock = br.protect("scheduler-agent", JOB_ID, 72 * 60).lease
    br.request_lease("cooling-agent", target="cdu-4", minutes=120, routine=True, note="filter swap")
    issue = only(last(br), Issue)
    assert issue.kind == "maintenance_refused" and issue.facts["requester"] == "cooling-agent"
    assert {b.id for b in issue.blockers} == {"cdu-3", lock.id}
    assert issue.deadline == 24 * 60 and issue.untrusted_note == "filter swap"


def test_refused_urgent_maintenance_stays_with_the_requester(br):
    br.set_part_state("cdu-3", "degraded")
    br.request_lease("cooling-agent", target="cdu-4", minutes=120, routine=False)
    assert last(br) == []


def test_routine_warn_stays_with_the_requester(br):
    br.request_lease("cooling-agent", target="cdu-4", minutes=120, routine=True)  # warn
    assert last(br) == []


# 4. Stale protection lock ----------------------------------------------------------------


def test_finished_job_with_a_lock_is_low(br):
    lock = br.protect("scheduler-agent", JOB_ID, 72 * 60).lease
    br.advance(150)
    br.set_job_status(JOB_ID, "finished")
    issue = only(last(br), Issue)
    assert issue.kind == "stale_protection" and issue.subject == lock.id


def test_stopped_job_keeps_its_lock(br):
    br.protect("scheduler-agent", JOB_ID, 72 * 60)
    br.set_job_status(JOB_ID, "stopped")
    assert last(br) == []


# Everything else -------------------------------------------------------------------------


def test_degraded_part_goes_to_a_person_with_its_impact(br):
    br.set_part_state("cdu-3", "degraded")
    assert "5 racks one failure from an outage" in only(last(br), Handoff).reason


def test_own_events_are_ignored(br):
    br.request_lease(FIXER, target="node-1205", minutes=60)
    br.record(FIXER, "agent", "node-1205", "note to self")
    assert last(br) == []
