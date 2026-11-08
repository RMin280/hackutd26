"""The dependency agent's four playbooks: each issue type's goal, its tools (bound to the
degraded feature), the check each action needs first, and the deterministic check that
decides whether it's really done.

List tools return a count plus a few examples, never every row, so the model's context
stays the same size however big the hall is. The planning rules and the ToolBox are
shared with every agent (agents/common/playbook.py).
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from ..squawk import fmt_time, label
from ..common.playbook import COMMON_TOOLS, Playbook, Run, Tool, events_by, text_param

EXAMPLES = 8  # rows a list tool shows; the count covers the rest


def _since(run: Run) -> int:
    """Minute of the last passing test before this issue: the start of the blind window."""
    value = run.facts.get("last_good_minute")
    return value if value is not None else 0


def _summary(items: list[Any]) -> dict[str, Any]:
    return {"count": len(items), "examples": items[:EXAMPLES], "more": max(0, len(items) - EXAMPLES)}


def _retest_feature(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    prober = run.extra["prober"]
    feature = run.br.feature(run.issue.subject)
    passed, detail = prober.probe(feature.id, run.br.now)
    seen = run.br.record_test(run.actor, feature.id, passed, detail, prober.says(feature.service))
    return {"passed": passed, "state": seen.state, "reason": detail}


def _suspect_pages(run: Run) -> list[Any]:
    return [p for p in run.br.pages_since(_since(run), "text") if p.status == "sent"]


def _list_suspect_pages(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    pages = _suspect_pages(run)
    run.extra["suspect_pages"] = [p.id for p in pages]
    return {
        **_summary([{"page": p.id, "to": p.to, "about": p.subject, "sent_at": fmt_time(p.sent_at)} for p in pages]),
        "reason": f"{len(pages)} page(s) went out by text since the last good test at {fmt_time(_since(run))}.",
    }


def _resend_pages(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    ids = run.extra.get("suspect_pages", [])
    results = [(pid, run.br.resend_page(run.actor, pid, "email")) for pid in ids]
    failed = [pid for pid, d in results if not d.ok]
    return {
        "ok": not failed,
        "resent": len(ids) - len(failed),
        "failed": failed,
        "reason": f"Re-sent {len(ids) - len(failed)} of {len(ids)} page(s) by email." if ids else "No pages to re-send.",
    }


def _notify_shift_lead(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    return asdict(run.br.notify(run.actor, "shift lead", run.issue.subject, args["message"]))


def _blind_racks(run: Run) -> list[Any]:
    feature = run.br.feature(run.issue.subject)
    below = dict.fromkeys(r for part in feature.covers for r in run.br.racks_below(part))
    return [view for view in (run.br.rack(r) for r in below) if view.unconfirmed and view.level != "green"]


def _list_racks_without_confirmed_backup(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    racks = _blind_racks(run)
    rows = sorted({r.row for r in racks})
    return {
        **_summary([{"rack": r.id, "level": r.level, "unconfirmed": [label(p) for p in r.unconfirmed]} for r in racks]),
        "rows": rows,
        "reason": f"{len(racks)} racks in rows {', '.join(map(str, rows)) or 'none'} can't confirm their backup.",
    }


def _list_leases_on_stale_data(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    """Maintenance granted since the last fresh reading on parts that feed racks now blind."""
    blind = {r.id for r in _blind_racks(run)}
    risky = []
    for e in run.br.get_events(0):
        target = e.data.get("target")
        if e.type != "lease_granted" or e.time < _since(run) or not target or target.startswith("node-"):
            continue  # node leases never touch rack backup
        if run.br.lease(e.data["lease"]) is not None and blind & set(run.br.racks_below(target)):
            risky.append({"lease": e.data["lease"], "target": label(target), "holder": e.data.get("holder", e.actor), "granted_at": fmt_time(e.time)})
    return {**_summary(risky), "reason": f"{len(risky)} active lease(s) were granted on readings that are now stale."}


def _dispatch_controls_engineer(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    return asdict(run.br.dispatch_tech(run.actor, run.facts["gateway"], "controls engineer", args["note"]))


def _list_changes_since_last_sync(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    changes = [
        {"what": e.type.replace("lease_", "lease "), "subject": label(e.subject), "by": e.actor, "at": fmt_time(e.time)}
        for e in run.br.get_events(0)
        if e.type in ("lease_granted", "lease_released") and e.time >= _since(run)
    ]
    return {**_summary(changes), "reason": f"{len(changes)} facility change(s) since the last good update at {fmt_time(_since(run))}."}


def _page_security_owner(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    return asdict(run.br.notify(run.actor, "security owner", run.issue.subject, args["message"]))


TOOLS: dict[str, Tool] = {
    **{
        t.name: t
        for t in (
            Tool(
                "retest_feature",
                "Run our test of this feature again and record the result. Squawk sets the feature's state from it.",
                _retest_feature,
            ),
            Tool(
                "list_suspect_pages",
                "Pages sent by text since the last good test: they may never have arrived.",
                _list_suspect_pages,
                needs=("retest_feature",),
            ),
            Tool(
                "resend_pages",
                "Re-send every page from list_suspect_pages by email.",
                _resend_pages,
                {"note": text_param("One line on why.")},
                acts=True,
                needs=("list_suspect_pages",),
            ),
            Tool(
                "notify_shift_lead",
                "Tell the shift lead what happened and what you did.",
                _notify_shift_lead,
                {"message": text_param("Two or three plain sentences.")},
                ("message",),
                acts=True,
                needs=("retest_feature",),
            ),
            Tool(
                "list_racks_without_confirmed_backup",
                "Racks below this gateway's CDUs that can no longer confirm their backup.",
                _list_racks_without_confirmed_backup,
                needs=("retest_feature",),
            ),
            Tool(
                "list_leases_on_stale_data",
                "Active maintenance leases granted since the last fresh reading on parts that feed those racks.",
                _list_leases_on_stale_data,
                needs=("retest_feature",),
            ),
            Tool(
                "dispatch_controls_engineer",
                "Send a controls engineer to the stale gateway.",
                _dispatch_controls_engineer,
                {"note": text_param("One or two lines for the engineer.")},
                ("note",),
                acts=True,
                needs=("retest_feature",),
            ),
            Tool(
                "list_changes_since_last_sync",
                "Facility changes (leases granted or released) since the revoked-key list last updated.",
                _list_changes_since_last_sync,
                needs=("retest_feature",),
            ),
            Tool(
                "page_security_owner",
                "Page the security owner.",
                _page_security_owner,
                {"message": text_param("Two or three plain sentences.")},
                ("message",),
                acts=True,
                needs=("retest_feature",),
            ),
        )
    },
    **COMMON_TOOLS,
}


def _working(run: Run) -> bool:
    return run.br.feature(run.issue.subject).state == "working"


def _told(run: Run, to: str) -> bool:
    return any(e.data.get("to") == to for e in events_by(run, "notified"))


def _verify_paging(run: Run) -> str | None:
    if not _working(run):
        unsent = [p.id for p in _suspect_pages(run)]
        if unsent:
            return f"{', '.join(unsent)} still haven't been re-sent"
    if not _told(run, "shift lead"):
        return "the shift lead wasn't told"
    return None


def _always_to_a_person(what: str):
    def verify(run: Run) -> str | None:
        return None if _working(run) else f"{what} always go to the shift lead"

    return verify


def _verify_recovered(run: Run) -> str | None:
    if not _working(run):
        return f"{label(run.issue.subject)} failed its retest"
    if not _told(run, "shift lead"):
        return "the shift lead wasn't told"
    return None


PLAYBOOKS: dict[str, Playbook] = {
    "paging_degraded": Playbook(
        "paging_degraded",
        "Text paging says it's up, but our test page by text wasn't delivered. Squawk already sends new pages by email.\n"
        "Done means: every page sent by text since the last good test has been re-sent by email, and the shift lead knows "
        "which pages may have been missed. Retest first; if text paging passes the retest, tell the shift lead it was a "
        "one-off and finish.",
        ("retest_feature", "list_suspect_pages", "resend_pages", "notify_shift_lead", "escalate", "finish"),
        ("retest_feature", "list_suspect_pages", "notify_shift_lead"),
        frozenset({"notify_shift_lead", "escalate"}),
        _verify_paging,
    ),
    "cooling_readings_stale": Playbook(
        "cooling_readings_stale",
        "One building management gateway's readings are stale while the system says it's up, so Squawk treats that "
        "gateway's CDUs as unknown, and racks that rely on them can't confirm their backup. You can't fix the gateway.\n"
        "Done means: a retest confirms it, you've gathered the racks without confirmed backup and any leases granted on "
        "stale readings, a controls engineer is on the way, and you've handed it to the shift lead with those facts "
        "(escalate). If the retest passes, finish instead.",
        ("retest_feature", "list_racks_without_confirmed_backup", "list_leases_on_stale_data", "dispatch_controls_engineer", "escalate", "finish"),
        ("retest_feature", "list_racks_without_confirmed_backup", "list_leases_on_stale_data", "dispatch_controls_engineer", "escalate"),
        frozenset({"escalate"}),
        _always_to_a_person("stale cooling readings"),
    ),
    "revocation_stale": Playbook(
        "revocation_stale",
        "The key service says it's up, but its revoked-key list hasn't updated in time, so a revoked key might still work. "
        "Squawk is already failing closed: facility changes need a shift lead until the list is current.\n"
        "Done means: a retest confirms it, you've listed the facility changes made since the last good update, the "
        "security owner has been paged, and you've handed it to the shift lead (escalate). If the retest passes, finish instead.",
        ("retest_feature", "list_changes_since_last_sync", "page_security_owner", "escalate", "finish"),
        ("retest_feature", "list_changes_since_last_sync", "page_security_owner", "escalate"),
        frozenset({"escalate"}),
        _always_to_a_person("security issues"),
    ),
    "dependency_recovered": Playbook(
        "dependency_recovered",
        "A feature that was degraded passes its test again.\n"
        "Done means: a second test confirms it and the shift lead knows it's clear. If the retest fails, escalate: it's flapping.",
        ("retest_feature", "notify_shift_lead", "escalate", "finish"),
        ("retest_feature", "notify_shift_lead"),
        frozenset({"escalate"}),
        _verify_recovered,
    ),
}
