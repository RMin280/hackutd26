"""Scripted stand-in for Nemotron in the dependency storyline: fixed plans and policies for
the dependency agent's four issue types, plus the fixer's (the fixer runs alongside).
Used by the tests and `python -m agents.dependency --scripted` (no requests).
"""

from __future__ import annotations

from typing import Any

from ..common.scripted import Done, PlanFn, Policy, Step, called, last, step
from ..common.scripted import ScriptedModel as _ScriptedModel
from ..fixer.scripted import PLANS as FIXER_PLANS
from ..fixer.scripted import POLICIES as FIXER_POLICIES


def _plan_paging(f: dict[str, Any]) -> list[dict[str, str]]:
    return [
        step("retest_feature", "Confirm text paging really is failing."),
        step("list_suspect_pages", "Find pages that went out by text since the last good test."),
        step("resend_pages", "Those pages may never have arrived.", "if there are any"),
        step("notify_shift_lead", "Say which pages may have been missed."),
        step("finish", "Done once pages are re-sent and the shift lead knows."),
    ]


def _plan_cooling(f: dict[str, Any]) -> list[dict[str, str]]:
    return [
        step("retest_feature", "Confirm the readings really are stale."),
        step("list_racks_without_confirmed_backup", "The shift lead needs to know which racks are blind."),
        step("list_leases_on_stale_data", "Approvals made on stale readings may not hold."),
        step("dispatch_controls_engineer", "Someone has to fix the gateway."),
        step("escalate", "Blast Radius can't see part of the hall; a person owns this."),
    ]


def _plan_revocation(f: dict[str, Any]) -> list[dict[str, str]]:
    return [
        step("retest_feature", "Confirm the revoked-key list really is out of date."),
        step("list_changes_since_last_sync", "Facility changes since then need a review."),
        step("page_security_owner", "Security needs to know now."),
        step("escalate", "Security always goes to a person."),
    ]


def _plan_recovered(f: dict[str, Any]) -> list[dict[str, str]]:
    return [
        step("retest_feature", "A second passing test before calling it clear."),
        step("escalate", "Failing again means it's flapping.", "if the retest fails"),
        step("notify_shift_lead", "Tell the shift lead it's clear."),
        step("finish", "Done once the shift lead knows."),
    ]


def _paging(f: dict[str, Any], done: Done) -> Step:
    if "retest_feature" not in called(done):
        return "retest_feature", {}
    if last(done, "retest_feature").get("passed"):
        if "revise_plan" not in called(done):
            steps = [step("notify_shift_lead", "Say it was a one-off."), step("finish", "Nothing needs re-sending.")]
            return "revise_plan", {"steps": steps, "reason": f"{f['name']} passed the retest"}
        if "notify_shift_lead" not in called(done):
            return "notify_shift_lead", {"message": f"{f['name']} failed one scheduled test and passed the retest; treating it as a one-off."}
        return "finish", {"summary": f"{f['name']} passed the retest; it was a one-off."}
    if "list_suspect_pages" not in called(done):
        return "list_suspect_pages", {}
    pages = last(done, "list_suspect_pages")
    if pages.get("count") and "resend_pages" not in called(done):
        return "resend_pages", {"note": "Sent by text while text paging was failing."}
    if "notify_shift_lead" not in called(done):
        who = ", ".join(f"{p['page']} to {p['to']} ({p['sent_at']})" for p in pages.get("examples", []))
        return "notify_shift_lead", {
            "message": f"{f['name']} has been failing since its last good test at {f['last_good_test']}. "
            f"Re-sent {pages.get('count', 0)} page(s) by email{': ' + who if who else ''}. New pages go by email until it's fixed."
        }
    return "finish", {"summary": f"Re-sent {pages.get('count', 0)} page(s) by email and told the shift lead; {f['name']} is still down."}


def _cooling(f: dict[str, Any], done: Done) -> Step:
    if "retest_feature" not in called(done):
        return "retest_feature", {}
    if last(done, "retest_feature").get("passed"):
        return "finish", {"summary": f"{f['name']} passed the retest; readings are fresh."}
    for tool in ("list_racks_without_confirmed_backup", "list_leases_on_stale_data"):
        if tool not in called(done):
            return tool, {}
    if "dispatch_controls_engineer" not in called(done):
        return "dispatch_controls_engineer", {"note": f"{f['gateway_name']} stopped delivering CDU readings; the BMS still says it's up."}
    racks, leases = last(done, "list_racks_without_confirmed_backup"), last(done, "list_leases_on_stale_data")
    return "escalate", {
        "reason": f"{f['cdus']} can't be confirmed: {racks['count']} racks in rows {', '.join(map(str, racks['rows']))} have no confirmed backup, "
        f"{leases['count']} lease(s) were granted on stale readings, and a controls engineer is on the way to {f['gateway_name']}."
    }


def _revocation(f: dict[str, Any], done: Done) -> Step:
    if "retest_feature" not in called(done):
        return "retest_feature", {}
    if last(done, "retest_feature").get("passed"):
        return "finish", {"summary": "The revoked-key list passed the retest; it's current."}
    if "list_changes_since_last_sync" not in called(done):
        return "list_changes_since_last_sync", {}
    changes = last(done, "list_changes_since_last_sync")
    if "page_security_owner" not in called(done):
        return "page_security_owner", {
            "message": f"The revoked-key list hasn't updated since {f['last_good_test']}. {changes['count']} facility change(s) since then need a review. "
            "Blast Radius is failing closed until it's current."
        }
    return "escalate", {"reason": f"Revoked-key list stale since {f['last_good_test']}: security owner paged, {changes['count']} change(s) to review, Blast Radius failing closed."}


def _recovered(f: dict[str, Any], done: Done) -> Step:
    if "retest_feature" not in called(done):
        return "retest_feature", {}
    if not last(done, "retest_feature").get("passed"):
        return "escalate", {"reason": f"{f['name']} failed its retest right after recovering: flapping."}
    if "notify_shift_lead" not in called(done):
        return "notify_shift_lead", {"message": f"{f['name']}: working again (degraded since {f['degraded_since']}), and a second test confirms it."}
    return "finish", {"summary": f"{f['name']}: confirmed working again; shift lead told."}


PLANS: dict[str, PlanFn] = {
    "paging_degraded": _plan_paging,
    "cooling_readings_stale": _plan_cooling,
    "revocation_stale": _plan_revocation,
    "dependency_recovered": _plan_recovered,
}

POLICIES: dict[str, Policy] = {
    "paging_degraded": _paging,
    "cooling_readings_stale": _cooling,
    "revocation_stale": _revocation,
    "dependency_recovered": _recovered,
}


class ScriptedModel(_ScriptedModel):
    """Answers for both agents, since the dependency storyline runs the fixer too."""

    def __init__(self) -> None:
        super().__init__({**FIXER_PLANS, **PLANS}, {**FIXER_POLICIES, **POLICIES})
