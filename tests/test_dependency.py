"""The dependency agent: services that say they're up while a feature we use is broken.
Our tests from our side, what Squawk does with their results, triage, and the
storyline with the fixer running alongside."""

from __future__ import annotations

import pytest

from agents.common.issues import Handoff, Issue
from agents.dependency.agent import run_dependency
from agents.dependency.demo import run_demo
from agents.dependency.scripted import ScriptedModel
from agents.dependency.triage import triage
from agents.mock_squawk import JOB_ID, MockSquawk
from agents.mock_services import FEATURES, SimulatedServices

DEP, FIXER = "dependency-agent", "fixer-agent"


def run_tests(br: MockSquawk, world: SimulatedServices) -> None:
    for fid in FEATURES:
        br.record_test(DEP, fid, *world.probe(fid, br.now), world.says(FEATURES[fid].service))


@pytest.fixture
def hall() -> tuple[MockSquawk, SimulatedServices]:
    br, world = MockSquawk(), SimulatedServices()
    run_tests(br, world)  # baseline: everything passes, quietly
    return br, world


def degrade(br: MockSquawk, world: SimulatedServices, dependency: str, at: int) -> None:
    world.set_dependency(dependency, "down", br.now)
    br.advance(at)
    run_tests(br, world)


def only(items, cls):
    assert len(items) == 1 and isinstance(items[0], cls), items
    return items[0]


# What our tests see ----------------------------------------------------------------------


def test_services_always_say_up_and_only_our_tests_see_the_break():
    world = SimulatedServices()
    world.set_dependency("sms-gateway", "down", 0)
    assert world.says("paging") == "up"
    assert world.probe("paging.text", 0)[0] is False
    assert world.probe("paging.email", 0)[0] is True


def test_age_limits():
    world = SimulatedServices()
    world.set_dependency("fieldbus-3", "down", 60)
    assert world.probe("bms.cooling.3", 64)[0] is True
    passed, detail = world.probe("bms.cooling.3", 65)
    assert not passed and "5 min old" in detail and "says it's up" in detail
    world.set_dependency("revocation-feed", "down", 95)
    assert world.probe("keys.revocation", 109)[0] is True
    assert world.probe("keys.revocation", 110)[0] is False


# What Squawk does with the results ------------------------------------------------


def test_squawk_sets_the_state_and_logs_only_changes(hall):
    br, world = hall
    assert not [e for e in br.events if e.type == "feature_state"]  # the baseline is quiet
    degrade(br, world, "sms-gateway", 5)
    br.advance(10)
    run_tests(br, world)  # still failing: no second event
    world.set_dependency("sms-gateway", "ok", 10)
    br.advance(15)
    run_tests(br, world)
    changes = [(e.subject, e.data["state"]) for e in br.events if e.type == "feature_state"]
    assert changes == [("paging.text", "degraded"), ("paging.text", "working")]
    assert br.events[-1].data["previous_since"] == 5 and br.feature("paging.text").recovered_at == 15


def test_agents_cant_record_tests():
    br = MockSquawk()
    with pytest.raises(Exception, match="may not record test"):
        br.record_test(FIXER, "paging.text", False, "made up")


def test_stale_readings_make_cdus_unknown_and_unknown_never_counts_as_backup(hall):
    br, world = hall
    degrade(br, world, "fieldbus-3", 65)
    assert br.feature("bms.cooling.3").state == "degraded"
    one_left = br.rack("rack-r8-04")  # primary CDU-24 (unknown), backup CDU-25
    assert (one_left.level, one_left.unconfirmed) == ("yellow", ("cdu-24",))
    assert "Can't confirm backup" in one_left.reason
    assert br.rack("rack-r6-01").level == "red"  # CDU-17 and CDU-18 both unknown
    check = br.simulate("cooling-agent", "cdu-25")
    assert check.verdict == "deny" and "CDU-24 unconfirmed" in check.reason
    assert check.earliest_safe == "once CDU readings are fresh"
    assert [(b.kind, b.id) for b in check.blockers] == [("feature_ok", "bms.cooling.3")]


def test_pages_fall_back_to_email_and_can_be_resent(hall):
    br, world = hall
    br.dispatch_tech(FIXER, "node-1205", "hardware tech", "isolated fault")  # page-1, by text
    degrade(br, world, "sms-gateway", 5)
    br.notify(DEP, "shift lead", "paging.text", "heads up")  # page-2 goes by email
    assert (br.pages["page-1"].channel, br.pages["page-2"].channel) == ("text", "email")
    assert [p.id for p in br.pages_since(0, "text")] == ["page-1"]
    assert br.resend_page(DEP, "page-1").ok and br.pages["page-1"].status == "resent"
    assert br.events[-1].type == "page_resent"

    degrade(br, world, "email-relay", 10)
    br.notify(DEP, "shift lead", "paging.text", "anyone?")
    assert br.pages["page-3"].status == "unconfirmed"
    refused = br.resend_page(DEP, "page-3")
    assert not refused.ok and "email is down too" in refused.reason


def test_a_stale_revoked_key_list_fails_closed(hall):
    br, world = hall
    lock = br.protect("scheduler-agent", JOB_ID, 72 * 60).lease
    br.set_job_status(JOB_ID, "finished")
    degrade(br, world, "revocation-feed", 15)
    asked = br.request_lease("cooling-agent", target="cdu-27", minutes=60, routine=True)
    assert not asked.granted and asked.verdict == "warn" and "revoked-key list is out of date" in asked.reason
    assert not br.release_lease(FIXER, lock.id).ok  # even a finished job's lock
    br.request_approval(FIXER, "cdu-27", 60, "filter swap", requested_for="cooling-agent")
    assert br.approve("shift-lead", br.events[-1].data["approval"]).granted  # a person still can


# Triage ----------------------------------------------------------------------------------


def last_triage(br):
    return triage(br.events[-1], br)


def test_text_paging_down_is_for_the_agent(hall):
    br, world = hall
    degrade(br, world, "sms-gateway", 5)
    assert only(last_triage(br), Issue).kind == "paging_degraded"


def test_no_paging_channel_at_all_goes_to_a_person(hall):
    br, world = hall
    degrade(br, world, "email-relay", 5)
    assert "fallback" in only(last_triage(br), Handoff).reason
    degrade(br, world, "sms-gateway", 10)
    assert "No working paging channel" in only(last_triage(br), Handoff).reason


def test_stale_readings_and_revoked_keys_are_for_the_agent(hall):
    br, world = hall
    degrade(br, world, "fieldbus-3", 5)
    degrade(br, world, "fieldbus-3", 10)
    cooling = only(last_triage(br), Issue)
    assert cooling.kind == "cooling_readings_stale" and cooling.facts["racks_without_confirmed_backup"] == 45
    degrade(br, world, "revocation-feed", 25)
    degrade(br, world, "revocation-feed", 40)
    assert only(last_triage(br), Issue).kind == "revocation_stale"


def test_recovery_then_flapping(hall):
    br, world = hall
    degrade(br, world, "sms-gateway", 5)
    world.set_dependency("sms-gateway", "ok", 10)
    br.advance(10)
    run_tests(br, world)
    assert only(last_triage(br), Issue).kind == "dependency_recovered"
    degrade(br, world, "sms-gateway", 20)  # 10 min after recovering
    assert "flapping" in only(last_triage(br), Handoff).reason


# The agent -------------------------------------------------------------------------------


def test_a_retest_that_passes_is_a_one_off(hall):
    br, world = hall
    degrade(br, world, "sms-gateway", 5)
    (issue,) = last_triage(br)
    world.set_dependency("sms-gateway", "ok", 5)  # back before the agent looks
    outcome = run_dependency(issue, br, ScriptedModel(), prober=world, start_seq=len(br.events))
    assert outcome.status == "fixed" and len(outcome.plans) == 2  # it revised its plan
    assert any(e.type == "notified" and e.data["to"] == "shift lead" for e in br.events)


def test_storyline_both_agents_through_squawk():
    br, dependency, fixer = run_demo(ScriptedModel(), out=lambda line: None)
    assert [(o.issue.kind, o.issue.subject, o.status) for o in dependency.outcomes] == [
        ("paging_degraded", "paging.text", "fixed"),
        ("cooling_readings_stale", "bms.cooling.3", "handed_off"),
        ("dependency_recovered", "bms.cooling.3", "fixed"),
        ("revocation_stale", "keys.revocation", "handed_off"),
    ]
    assert [(o.issue.kind, o.issue.subject, o.status) for o in fixer.outcomes] == [
        ("broken_node", "node-1205", "fixed"),
        ("maintenance_refused", "cdu-25", "fixed"),
    ]
    # The fixer's page from the blind window, and only that page, was re-sent by email.
    assert [e.data["page"] for e in br.events if e.type == "page_resent"] == ["page-1"]
    assert br.pages["page-1"].by == FIXER and br.pages["page-1"].status == "resent"
    # Stale readings: a controls engineer sent, and the shift lead owns it.
    assert any(e.type == "tech_dispatched" and e.subject == "fieldbus-3" for e in br.events)
    handed = {e.subject for e in br.events if e.type == "escalated" and e.actor == DEP}
    assert handed == {"bms.cooling.3", "keys.revocation"}
    assert any(e.type == "notified" and e.data["to"] == "security owner" for e in br.events)
    # The fixer queued CDU-25 until the readings recovered, then routed it to the shift lead.
    approved = [e for e in br.events if e.type == "lease_granted" and e.subject == "cdu-25"]
    assert [(e.actor, e.time) for e in approved] == [("shift-lead", 100)]
    # Failing closed: the last request needed a shift lead.
    denied = [e for e in br.events if e.type == "lease_denied"]
    assert denied[-1].subject == "cdu-9" and denied[-1].data["verdict"] == "warn"
