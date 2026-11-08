"""The fixer agent's scripted stand-in for Nemotron: a fixed plan per issue type, then a
fixed policy. Used by the tests and `python -m agents.fixer --scripted` (no requests).
"""

from __future__ import annotations

from typing import Any

from ..blast_radius import label
from ..common.scripted import SCRIPTED, Done, PlanFn, Policy, Step, called, last, step
from ..common.scripted import ScriptedModel as _ScriptedModel

__all__ = ["PLANS", "POLICIES", "SCRIPTED", "ScriptedModel"]


def _plan_broken_node(f: dict[str, Any]) -> list[dict[str, str]]:
    steps = [
        step("diagnose_node", "Confirm the failure is isolated before acting."),
        step("escalate", "A shared cause isn't low criticality.", "if the diagnosis isn't isolated"),
        step("take_node_out_of_service", "Keep schedulers and agents off it during repair."),
        step("dispatch_hardware_tech", "Get the node repaired."),
    ]
    if f.get("tenant"):
        steps.append(step("notify_tenant", f"{f['tenant']} should move work to other nodes."))
    return steps + [step("finish", "Done once the lease, tech and notice are in place.")]


def _plan_node_repaired(f: dict[str, Any]) -> list[dict[str, str]]:
    return [
        step("check_rack", "Only return it if the rack has full backup."),
        step("escalate", "A rack below full backup isn't low criticality.", "if the rack isn't green"),
        step("return_node_to_pool", "Release the lease so placement can use it."),
        step("finish", "Done once the lease is released."),
    ]


def _plan_maintenance_refused(f: dict[str, Any]) -> list[dict[str, str]]:
    return [
        step("recheck_maintenance", "See what Blast Radius says now that the blockers cleared."),
        step("book_maintenance", "Book it for the requester.", "if the check says allow"),
        step("request_shift_lead_approval", "A warn needs a person's approval.", "if the check says warn"),
        step("keep_waiting", "Still blocked, so queue it again.", "if the check says deny"),
        step("notify_requester", "Tell them where the request stands.", "if it was booked or sent for approval"),
        step("finish", "Done once the requester knows.", "if it was booked or sent for approval"),
    ]


def _plan_stale_protection(f: dict[str, Any]) -> list[dict[str, str]]:
    return [
        step("check_job", "Make sure the job really finished; a stopped job may restart."),
        step("escalate", "A running or stopped job still needs its lock.", "if the job isn't finished"),
        step("release_protection_lock", "Free its racks for maintenance."),
        step("finish", "Done once the lock is gone."),
    ]


def _broken_node(f: dict[str, Any], done: Done) -> Step:
    if "diagnose_node" not in called(done):
        return "diagnose_node", {}
    diagnosis = last(done, "diagnose_node")
    if diagnosis.get("classification") != "isolated":
        return "escalate", {"reason": f"Not isolated after all. {diagnosis.get('reason')}"}
    if "take_node_out_of_service" not in called(done):
        return "take_node_out_of_service", {"hours": 4, "note": f"Hardware repair of {f['node']}."}
    lease = last(done, "take_node_out_of_service")
    if not lease.get("granted"):
        return "escalate", {"reason": f"Blast Radius refused the lease: {lease.get('reason')}"}
    if "dispatch_hardware_tech" not in called(done):
        return "dispatch_hardware_tech", {"note": f"{f['node']} in {f['rack']} is {f['state']}, isolated fault. Out of service until {lease.get('until')}."}
    if f.get("tenant") and "notify_tenant" not in called(done):
        return "notify_tenant", {"message": f"{f['node']} is {f['state']}. It's out of service and a technician is on the way; please run on your other nodes meanwhile."}
    return "finish", {"summary": f"{f['node']} is out of service under {lease.get('lease')} and a hardware tech is on the way: isolated fault, rack keeps full backup."}


def _node_repaired(f: dict[str, Any], done: Done) -> Step:
    if "check_rack" not in called(done):
        return "check_rack", {}
    rack = last(done, "check_rack")
    if rack.get("level") != "green":
        return "escalate", {"reason": f"{f['rack']} is below full backup. {rack.get('reason')}"}
    if "return_node_to_pool" not in called(done):
        return "return_node_to_pool", {"note": "Repair finished and the node reports ok."}
    released = last(done, "return_node_to_pool")
    if not released.get("ok"):
        return "escalate", {"reason": released.get("reason", "release refused")}
    return "finish", {"summary": f"{f['node']} is back in the spare pool; {f['rack']} has full backup."}


def _maintenance_refused(f: dict[str, Any], done: Done) -> Step:
    target = label(f["target"])
    if "recheck_maintenance" not in called(done):
        return "recheck_maintenance", {}
    check = last(done, "recheck_maintenance")
    if check.get("verdict") == "allow":
        if "book_maintenance" not in called(done):
            return "book_maintenance", {"note": "Routine request re-booked after its blockers cleared."}
        booked = last(done, "book_maintenance")
        if not booked.get("granted"):
            return "escalate", {"reason": booked.get("reason", "booking refused")}
        if "notify_requester" not in called(done):
            return "notify_requester", {"message": f"Your {target} maintenance is booked until {booked.get('until')}."}
        return "finish", {"summary": f"Booked {f['requester']}'s {target} maintenance: Blast Radius allows it now."}
    if check.get("verdict") == "warn":
        if "request_shift_lead_approval" not in called(done):
            return "request_shift_lead_approval", {"summary": f"{target} maintenance for {f['requester']}: {check.get('reason')}"}
        if "notify_requester" not in called(done):
            return "notify_requester", {"message": f"Your {target} maintenance is no longer blocked, but it needs shift lead approval: {check.get('reason')}"}
        return "finish", {"summary": f"{target} maintenance is unblocked and waiting on the shift lead. {check.get('reason')}"}
    return "keep_waiting", {"note": f"Still blocked. {check.get('reason')}"}


def _stale_protection(f: dict[str, Any], done: Done) -> Step:
    if "check_job" not in called(done):
        return "check_job", {}
    job = last(done, "check_job")
    if job.get("status") != "finished":
        return "escalate", {"reason": f"{f['job']} is {job.get('status')}, not finished."}
    if "release_protection_lock" not in called(done):
        return "release_protection_lock", {"note": f"{f['job']} finished; the lock isn't needed."}
    released = last(done, "release_protection_lock")
    if not released.get("ok"):
        return "escalate", {"reason": released.get("reason", "release refused")}
    return "finish", {"summary": f"Released {f['lease']}: {f['job']} finished, so its {f['racks_locked']} racks can take maintenance again."}


PLANS: dict[str, PlanFn] = {
    "broken_node": _plan_broken_node,
    "node_repaired": _plan_node_repaired,
    "maintenance_refused": _plan_maintenance_refused,
    "stale_protection": _plan_stale_protection,
}

POLICIES: dict[str, Policy] = {
    "broken_node": _broken_node,
    "node_repaired": _node_repaired,
    "maintenance_refused": _maintenance_refused,
    "stale_protection": _stale_protection,
}


class ScriptedModel(_ScriptedModel):
    def __init__(self) -> None:
        super().__init__(PLANS, POLICIES)
