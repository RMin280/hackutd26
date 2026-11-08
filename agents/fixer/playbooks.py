"""The fixer agent's four playbooks: each issue type's goal, its tools (bound to the
issue), the check each action needs first, what's still allowed after Squawk
refuses something, and the deterministic check that decides whether it's really fixed.

The planning rules and the ToolBox they run in are shared by every agent
(agents/common/playbook.py).
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from ..squawk import LeaseDecision, fmt_time, label
from ..common.playbook import COMMON_TOOLS, Playbook, Run, Tool, events_by, text_param


def _lease_result(d: LeaseDecision) -> dict[str, Any]:
    out: dict[str, Any] = {"granted": d.granted, "verdict": d.verdict, "reason": d.reason}
    if d.lease:
        out.update(lease=d.lease.id, holder=d.lease.actor, until=fmt_time(d.lease.end))
    if d.earliest_safe:
        out["earliest_safe"] = d.earliest_safe
    return out


def _diagnose_node(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    return asdict(run.br.diagnose_failure(run.issue.subject))


def _check_rack(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    return asdict(run.br.rack(run.facts["rack"]))


def _take_node_out_of_service(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    return _lease_result(run.br.request_lease(run.actor, target=run.issue.subject, minutes=args["hours"] * 60, note=args.get("note", "")))


def _dispatch_hardware_tech(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    return asdict(run.br.dispatch_tech(run.actor, run.issue.subject, "hardware tech", args["note"]))


def _notify_tenant(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    return asdict(run.br.notify(run.actor, run.facts["tenant"], run.issue.subject, args["message"]))


def _return_node_to_pool(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    return asdict(run.br.release_lease(run.actor, run.facts["lease"], args.get("note", "")))


def _recheck_maintenance(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    check = run.br.simulate(run.actor, run.issue.subject)
    run.last_check, run.blockers = check.verdict, check.blockers
    out: dict[str, Any] = {"verdict": check.verdict, "reason": check.reason}
    if check.earliest_safe:
        out["earliest_safe"] = check.earliest_safe
    return out


def _book_maintenance(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    decision = run.br.request_lease(
        run.actor,
        target=run.issue.subject,
        minutes=run.facts["minutes"],
        routine=True,
        note=args.get("note", ""),
        on_behalf_of=run.facts["requester"],
    )
    return _lease_result(decision)


def _request_shift_lead_approval(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    f = run.facts
    return asdict(run.br.request_approval(run.actor, run.issue.subject, f["minutes"], args["summary"], requested_for=f["requester"]))


def _notify_requester(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    return asdict(run.br.notify(run.actor, run.facts["requester"], run.issue.subject, args["message"]))


def _keep_waiting(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    run.status = "waiting"
    run.summary = args.get("note") or f"Still blocked until {', '.join(b.id for b in run.blockers)} clears."
    return {"ok": True, "reason": "Queued again until what blocks it clears."}


def _check_job(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    job = run.br.job(run.facts["job"])
    lock = run.br.lease(run.issue.subject)
    return {
        "job": job.id,
        "status": job.status,
        "since": fmt_time(job.since),
        "lock": None if lock is None else {"id": lock.id, "holder": lock.actor, "racks": len(lock.racks), "ends": fmt_time(lock.end)},
    }


def _release_protection_lock(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    return asdict(run.br.release_lease(run.actor, run.issue.subject, args.get("note", "")))


def _after_warn(run: Run) -> str | None:
    return None if "warn" in (run.last_check, run.refused) else "only after recheck_maintenance says warn"


def _after_deny(run: Run) -> str | None:
    return None if run.last_check == "deny" else "only after recheck_maintenance says deny"


TOOLS: dict[str, Tool] = {
    **{
        t.name: t
        for t in (
            Tool("diagnose_node", "Squawk's diagnosis of this issue's node: isolated or shared cause, with the reason.", _diagnose_node),
            Tool("check_rack", "Backup margins and protection locks for this issue's rack.", _check_rack),
            Tool(
                "take_node_out_of_service",
                "Ask Squawk for a maintenance lease on this issue's node, so no scheduler or agent uses it during repair. Squawk may refuse.",
                _take_node_out_of_service,
                {
                    "hours": {"type": "integer", "minimum": 1, "maximum": 24, "description": "Repair window in hours, 1 to 24."},
                    "note": text_param("One line on why."),
                },
                ("hours",),
                acts=True,
                needs=("diagnose_node",),
            ),
            Tool(
                "dispatch_hardware_tech",
                "Send a hardware technician to this issue's node.",
                _dispatch_hardware_tech,
                {"note": text_param("One or two lines for the technician.")},
                ("note",),
                acts=True,
                needs=("take_node_out_of_service",),
            ),
            Tool(
                "notify_tenant",
                "Tell the tenant whose node this is what happened and what's being done.",
                _notify_tenant,
                {"message": text_param("One or two plain sentences.")},
                ("message",),
                acts=True,
                offered=lambda run: bool(run.facts.get("tenant")),
            ),
            Tool(
                "return_node_to_pool",
                "Release your maintenance lease on this issue's node so placement can use it as a spare again.",
                _return_node_to_pool,
                {"note": text_param("One line on why.")},
                acts=True,
                needs=("check_rack",),
            ),
            Tool("recheck_maintenance", "Ask Squawk whether the refused maintenance would be allowed now.", _recheck_maintenance),
            Tool(
                "book_maintenance",
                "Book the maintenance for the requester, who then holds the lease. Squawk refuses it unless its check allows it.",
                _book_maintenance,
                {"note": text_param("One line on why.")},
                acts=True,
                needs=("recheck_maintenance",),
            ),
            Tool(
                "request_shift_lead_approval",
                "Hand the shift lead a ready-to-approve request. Only after recheck_maintenance says warn.",
                _request_shift_lead_approval,
                {"summary": text_param("One line: what it would leave at risk, and for how long.")},
                ("summary",),
                acts=True,
                needs=("recheck_maintenance",),
                gate=_after_warn,
            ),
            Tool(
                "notify_requester",
                "Tell the requester where their maintenance request stands.",
                _notify_requester,
                {"message": text_param("One or two plain sentences.")},
                ("message",),
                acts=True,
                needs=("recheck_maintenance",),
            ),
            Tool(
                "keep_waiting",
                "Leave the request queued until what blocks it clears. Only after recheck_maintenance says deny.",
                _keep_waiting,
                {"note": text_param("One line on what it waits for.")},
                needs=("recheck_maintenance",),
                gate=_after_deny,
            ),
            Tool("check_job", "Status of the job this protection lock was for, and the lock itself.", _check_job),
            Tool(
                "release_protection_lock",
                "Release the stale protection lock. Squawk refuses unless the job has finished.",
                _release_protection_lock,
                {"note": text_param("One line on why.")},
                acts=True,
                needs=("check_job",),
            ),
        )
    },
    **COMMON_TOOLS,
}


def _verify_broken_node(run: Run) -> str | None:
    node, tenant = run.issue.subject, run.facts.get("tenant")
    if not any(x.actor == run.actor for x in run.br.leases_on(node)):
        return f"{node} isn't out of service under a lease"
    if not events_by(run, "tech_dispatched", node):
        return f"no technician was sent to {node}"
    if tenant and not any(e.data.get("to") == tenant for e in events_by(run, "notified", node)):
        return f"{tenant} wasn't told"
    return None


def _verify_node_repaired(run: Run) -> str | None:
    node = run.issue.subject
    if any(x.actor == run.actor for x in run.br.leases_on(node)):
        return f"{node} is still out of service"
    return None


def _verify_maintenance(run: Run) -> str | None:
    target, requester = run.issue.subject, run.facts["requester"]
    booked = any(x.actor == requester for x in run.br.leases_on(target))
    if not booked and not events_by(run, "approval_requested", target):
        return f"{label(target)} is neither booked nor waiting on the shift lead"
    if not any(e.data.get("to") == requester for e in events_by(run, "notified", target)):
        return f"{requester} wasn't told"
    return None


def _verify_stale_protection(run: Run) -> str | None:
    if run.br.lease(run.issue.subject) is not None:
        return f"{run.issue.subject} still locks its racks"
    return None


PLAYBOOKS: dict[str, Playbook] = {
    "broken_node": Playbook(
        "broken_node",
        "A single node outside any running job has failed or degraded, and triage found no shared cause.\n"
        "Done means: the node is out of service under your lease (so no scheduler or agent uses it during repair), "
        "a hardware tech is on the way, and its tenant, if it has one, has been told.\n"
        "Confirm the failure is isolated before taking the node out of service; if it isn't, escalate. "
        "About 4 hours is a typical repair window.",
        ("diagnose_node", "take_node_out_of_service", "dispatch_hardware_tech", "notify_tenant", "escalate", "finish"),
        ("take_node_out_of_service", "dispatch_hardware_tech", "notify_tenant"),
        frozenset({"escalate"}),
        _verify_broken_node,
    ),
    "node_repaired": Playbook(
        "node_repaired",
        "A node you took out of service reports ok again.\n"
        "Done means: your lease on it is released, so placement can use it as a spare again. Only do that if its rack "
        "still has full backup (level green); if it doesn't, escalate.",
        ("check_rack", "return_node_to_pool", "escalate", "finish"),
        ("return_node_to_pool",),
        frozenset({"escalate"}),
        _verify_node_repaired,
    ),
    "maintenance_refused": Playbook(
        "maintenance_refused",
        "A routine maintenance request was refused earlier, and what blocked it has cleared.\n"
        "Done means one of three outcomes. If Squawk allows it now, it's booked for the requester. If it says warn, "
        "the shift lead has a ready-to-approve request (never book a warn yourself). If it's still refused (deny), it goes "
        "back to waiting with keep_waiting. Unless it goes back to waiting, tell the requester where it stands.\n"
        "Recheck before anything else.",
        ("recheck_maintenance", "book_maintenance", "request_shift_lead_approval", "notify_requester", "keep_waiting", "escalate", "finish"),
        ("recheck_maintenance", "notify_requester"),
        frozenset({"request_shift_lead_approval", "notify_requester", "keep_waiting", "escalate"}),
        _verify_maintenance,
    ),
    "stale_protection": Playbook(
        "stale_protection",
        "A protection lock is still held for a job that has finished.\n"
        "Done means: the lock is released, so its racks can take maintenance again. Only release it once you've confirmed "
        "the job finished; if the job is running or stopped (a stopped job may restart), escalate.",
        ("check_job", "release_protection_lock", "escalate", "finish"),
        ("release_protection_lock",),
        frozenset({"escalate"}),
        _verify_stale_protection,
    ),
}
