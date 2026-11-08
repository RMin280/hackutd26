"""A deterministic stand-in for Nemotron: submits a fixed plan per issue type, then
follows it.

Used by the tests and by `python -m agents.fixer --scripted` (no model requests). Real
runs use Nemotron through agents.llm.ModelRouter, which writes its own plans. It answers
the way a model does: one tool call per reply, chosen from the issue's facts and the
tool results so far.
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable

from openai.types.chat import ChatCompletion

from ..blast_radius import label
from ..config import Endpoint
from ..llm import Reply

SCRIPTED = Endpoint("scripted", "local", "", "", "playbook")

Done = list[tuple[str, dict[str, Any]]]  # (tool name, result) so far, oldest first
Step = tuple[str, dict[str, Any]]


class ScriptedModel:
    def __init__(self) -> None:
        self.requests = 0

    def chat(self, messages: list[dict[str, Any]], *, tools=None, tool_choice="auto", max_tokens=4096) -> Reply:
        self.requests += 1
        kind, facts = _issue(messages)
        done = _done(messages)
        if not any(n == "submit_plan" and r.get("accepted") for n, r in done):
            name, args = "submit_plan", {"steps": PLANS[kind](facts)}
        else:
            name, args = POLICIES[kind](facts, done)
        completion = ChatCompletion.model_validate(
            {
                "id": f"scripted-{self.requests}",
                "object": "chat.completion",
                "created": 0,
                "model": SCRIPTED.model,
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "tool_calls",
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {"id": f"call_{self.requests}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
                            ],
                        },
                    }
                ],
            }
        )
        return Reply(completion, SCRIPTED)


def _issue(messages: list[dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    text = next(m["content"] for m in messages if m["role"] == "user" and str(m["content"]).startswith("Issue "))
    kind = re.match(r"Issue \S+ \((\w+)\)", text).group(1)
    facts = json.loads(re.search(r"```json\n(.*?)\n```", text, re.S).group(1))
    return kind, facts


def _done(messages: list[dict[str, Any]]) -> Done:
    names = {c["id"]: c["function"]["name"] for m in messages if m["role"] == "assistant" for c in m.get("tool_calls") or ()}
    return [(names[m["tool_call_id"]], json.loads(m["content"])) for m in messages if m["role"] == "tool"]


def _last(done: Done, name: str) -> dict[str, Any] | None:
    return next((r for n, r in reversed(done) if n == name), None)


def _broken_node(f: dict[str, Any], done: Done) -> Step:
    called = {n for n, _ in done}
    if "diagnose_node" not in called:
        return "diagnose_node", {}
    diagnosis = _last(done, "diagnose_node")
    if diagnosis.get("classification") != "isolated":
        return "escalate", {"reason": f"Not isolated after all. {diagnosis.get('reason')}"}
    if "take_node_out_of_service" not in called:
        return "take_node_out_of_service", {"hours": 4, "note": f"Hardware repair of {f['node']}."}
    lease = _last(done, "take_node_out_of_service")
    if not lease.get("granted"):
        return "escalate", {"reason": f"Blast Radius refused the lease: {lease.get('reason')}"}
    if "dispatch_hardware_tech" not in called:
        return "dispatch_hardware_tech", {"note": f"{f['node']} in {f['rack']} is {f['state']}, isolated fault. Out of service until {lease.get('until')}."}
    if f.get("tenant") and "notify_tenant" not in called:
        return "notify_tenant", {"message": f"{f['node']} is {f['state']}. It's out of service and a technician is on the way; please run on your other nodes meanwhile."}
    return "finish", {"summary": f"{f['node']} is out of service under {lease.get('lease')} and a hardware tech is on the way: isolated fault, rack keeps full backup."}


def _node_repaired(f: dict[str, Any], done: Done) -> Step:
    called = {n for n, _ in done}
    if "check_rack" not in called:
        return "check_rack", {}
    rack = _last(done, "check_rack")
    if rack.get("level") != "green":
        return "escalate", {"reason": f"{f['rack']} is below full backup. {rack.get('reason')}"}
    if "return_node_to_pool" not in called:
        return "return_node_to_pool", {"note": "Repair finished and the node reports ok."}
    released = _last(done, "return_node_to_pool")
    if not released.get("ok"):
        return "escalate", {"reason": released.get("reason", "release refused")}
    return "finish", {"summary": f"{f['node']} is back in the spare pool; {f['rack']} has full backup."}


def _maintenance_refused(f: dict[str, Any], done: Done) -> Step:
    called = {n for n, _ in done}
    target = label(f["target"])
    if "recheck_maintenance" not in called:
        return "recheck_maintenance", {}
    check = _last(done, "recheck_maintenance")
    if check.get("verdict") == "allow":
        if "book_maintenance" not in called:
            return "book_maintenance", {"note": "Routine request re-booked after its blockers cleared."}
        booked = _last(done, "book_maintenance")
        if not booked.get("granted"):
            return "escalate", {"reason": booked.get("reason", "booking refused")}
        if "notify_requester" not in called:
            return "notify_requester", {"message": f"Your {target} maintenance is booked until {booked.get('until')}."}
        return "finish", {"summary": f"Booked {f['requester']}'s {target} maintenance: Blast Radius allows it now."}
    if check.get("verdict") == "warn":
        if "request_shift_lead_approval" not in called:
            return "request_shift_lead_approval", {"summary": f"{target} maintenance for {f['requester']}: {check.get('reason')}"}
        if "notify_requester" not in called:
            return "notify_requester", {"message": f"Your {target} maintenance is no longer blocked, but it needs shift lead approval: {check.get('reason')}"}
        return "finish", {"summary": f"{target} maintenance is unblocked and waiting on the shift lead. {check.get('reason')}"}
    return "keep_waiting", {"note": f"Still blocked. {check.get('reason')}"}


def _stale_protection(f: dict[str, Any], done: Done) -> Step:
    called = {n for n, _ in done}
    if "check_job" not in called:
        return "check_job", {}
    job = _last(done, "check_job")
    if job.get("status") != "finished":
        return "escalate", {"reason": f"{f['job']} is {job.get('status')}, not finished."}
    if "release_protection_lock" not in called:
        return "release_protection_lock", {"note": f"{f['job']} finished; the lock isn't needed."}
    released = _last(done, "release_protection_lock")
    if not released.get("ok"):
        return "escalate", {"reason": released.get("reason", "release refused")}
    return "finish", {"summary": f"Released {f['lease']}: {f['job']} finished, so its {f['racks_locked']} racks can take maintenance again."}


def _step(tool: str, why: str, when: str = "") -> dict[str, str]:
    return {"tool": tool, "why": why, **({"when": when} if when else {})}


def _plan_broken_node(f: dict[str, Any]) -> list[dict[str, str]]:
    steps = [
        _step("diagnose_node", "Confirm the failure is isolated before acting."),
        _step("escalate", "A shared cause isn't low criticality.", "if the diagnosis isn't isolated"),
        _step("take_node_out_of_service", "Keep schedulers and agents off it during repair."),
        _step("dispatch_hardware_tech", "Get the node repaired."),
    ]
    if f.get("tenant"):
        steps.append(_step("notify_tenant", f"{f['tenant']} should move work to other nodes."))
    return steps + [_step("finish", "Done once the lease, tech and notice are in place.")]


def _plan_node_repaired(f: dict[str, Any]) -> list[dict[str, str]]:
    return [
        _step("check_rack", "Only return it if the rack has full backup."),
        _step("escalate", "A rack below full backup isn't low criticality.", "if the rack isn't green"),
        _step("return_node_to_pool", "Release the lease so placement can use it."),
        _step("finish", "Done once the lease is released."),
    ]


def _plan_maintenance_refused(f: dict[str, Any]) -> list[dict[str, str]]:
    return [
        _step("recheck_maintenance", "See what Blast Radius says now that the blockers cleared."),
        _step("book_maintenance", "Book it for the requester.", "if the check says allow"),
        _step("request_shift_lead_approval", "A warn needs a person's approval.", "if the check says warn"),
        _step("keep_waiting", "Still blocked, so queue it again.", "if the check says deny"),
        _step("notify_requester", "Tell them where the request stands.", "if it was booked or sent for approval"),
        _step("finish", "Done once the requester knows.", "if it was booked or sent for approval"),
    ]


def _plan_stale_protection(f: dict[str, Any]) -> list[dict[str, str]]:
    return [
        _step("check_job", "Make sure the job really finished; a stopped job may restart."),
        _step("escalate", "A running or stopped job still needs its lock.", "if the job isn't finished"),
        _step("release_protection_lock", "Free its racks for maintenance."),
        _step("finish", "Done once the lock is gone."),
    ]


PLANS: dict[str, Callable[[dict[str, Any]], list[dict[str, str]]]] = {
    "broken_node": _plan_broken_node,
    "node_repaired": _plan_node_repaired,
    "maintenance_refused": _plan_maintenance_refused,
    "stale_protection": _plan_stale_protection,
}

POLICIES: dict[str, Callable[[dict[str, Any], Done], Step]] = {
    "broken_node": _broken_node,
    "node_repaired": _node_repaired,
    "maintenance_refused": _maintenance_refused,
    "stale_protection": _stale_protection,
}
