"""Playbooks for the four low-criticality issue types, and the ToolBox: the model's only
way to act.

Each issue type has a goal (what "done" means), the tools the model gets, the check each
action needs first, what's still allowed after Blast Radius refuses something, and the
deterministic checks that decide, once the model says it's done, whether the issue
really is fixed.

The model plans its own steps. Its first move is submit_plan, which code checks against
the goal and the tools: nothing outside the playbook, every action after its check, and
a way to stop. It then has to follow that plan, or call revise_plan before doing
anything the plan doesn't say. Tools are bound to the issue, every action goes through
Blast Radius, and after a refusal only the playbook's follow-ups are allowed. These
rules live here in code, not in the prompt.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any, Callable

from ..blast_radius import BlastRadius, Blocker, Event, LeaseDecision, OutOfScope, fmt_time, label
from .triage import Issue

MAX_TEXT = 400  # characters kept from any note or message the model writes
MAX_PLAN_STEPS = 8
PLAN_TOOLS = ("submit_plan", "revise_plan")
TERMINAL = ("finish", "escalate", "keep_waiting")  # a plan has to end in one of these
ALWAYS = ("finish", "escalate")  # stopping and handing off are never blocked by the plan


@dataclass(frozen=True)
class PlanStep:
    tool: str
    why: str
    when: str = ""  # condition for a step that depends on a result; empty means always


@dataclass
class Run:
    """One fixer run on one issue."""

    issue: Issue
    br: BlastRadius
    actor: str
    start_seq: int  # events after this one belong to this run
    status: str = "open"  # open | fixed | handed_off | waiting
    summary: str = ""
    refused: str | None = None  # verdict of the last refused action: "deny" or "warn"
    last_check: str | None = None  # verdict of the last recheck_maintenance
    blockers: tuple[Blocker, ...] = ()  # keep_waiting: what has to clear
    plan: list[PlanStep] | None = None  # steps still to do
    plans: list[list[PlanStep]] = field(default_factory=list)  # every accepted plan, first to last
    done: list[str] = field(default_factory=list)  # tools that ran in this run
    steps: list[dict[str, Any]] = field(default_factory=list)  # every tool call and its result

    @property
    def facts(self) -> dict[str, Any]:
        return self.issue.facts


Handler = Callable[[Run, dict[str, Any]], dict[str, Any]]


def _schema(name: str, description: str, properties: dict[str, Any], required: tuple[str, ...] | list[str]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": list(required)},
        },
    }


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    handler: Handler
    params: dict[str, dict[str, Any]] = field(default_factory=dict)
    required: tuple[str, ...] = ()
    acts: bool = False  # changes something, so Blast Radius may refuse it
    needs: tuple[str, ...] = ()  # checks that must run first: look before you leap
    offered: Callable[[Run], bool] = lambda run: True
    gate: Callable[[Run], str | None] = lambda run: None  # why it isn't allowed right now

    def schema(self) -> dict[str, Any]:
        return _schema(self.name, self.description, self.params, self.required)


def _text(description: str) -> dict[str, Any]:
    return {"type": "string", "description": description}


# --- Tool handlers (all bound to run.issue) ---------------------------------------------


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


def _escalate(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    run.br.escalate(run.actor, run.issue.subject, "shift lead", args["reason"])
    run.status, run.summary = "handed_off", args["reason"]
    return {"ok": True, "reason": "Handed to the shift lead."}


def _finish(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    run.status, run.summary = "fixed", args["summary"]
    return {"ok": True}


def _after_warn(run: Run) -> str | None:
    return None if "warn" in (run.last_check, run.refused) else "only after recheck_maintenance says warn"


def _after_deny(run: Run) -> str | None:
    return None if run.last_check == "deny" else "only after recheck_maintenance says deny"


TOOLS: dict[str, Tool] = {
    t.name: t
    for t in (
        Tool("diagnose_node", "Blast Radius's diagnosis of this issue's node: isolated or shared cause, with the reason.", _diagnose_node),
        Tool("check_rack", "Backup margins and protection locks for this issue's rack.", _check_rack),
        Tool(
            "take_node_out_of_service",
            "Ask Blast Radius for a maintenance lease on this issue's node, so no scheduler or agent uses it during repair. Blast Radius may refuse.",
            _take_node_out_of_service,
            {
                "hours": {"type": "integer", "minimum": 1, "maximum": 24, "description": "Repair window in hours, 1 to 24."},
                "note": _text("One line on why."),
            },
            ("hours",),
            acts=True,
            needs=("diagnose_node",),
        ),
        Tool(
            "dispatch_hardware_tech",
            "Send a hardware technician to this issue's node.",
            _dispatch_hardware_tech,
            {"note": _text("One or two lines for the technician.")},
            ("note",),
            acts=True,
            needs=("take_node_out_of_service",),
        ),
        Tool(
            "notify_tenant",
            "Tell the tenant whose node this is what happened and what's being done.",
            _notify_tenant,
            {"message": _text("One or two plain sentences.")},
            ("message",),
            acts=True,
            offered=lambda run: bool(run.facts.get("tenant")),
        ),
        Tool(
            "return_node_to_pool",
            "Release your maintenance lease on this issue's node so placement can use it as a spare again.",
            _return_node_to_pool,
            {"note": _text("One line on why.")},
            acts=True,
            needs=("check_rack",),
        ),
        Tool("recheck_maintenance", "Ask Blast Radius whether the refused maintenance would be allowed now.", _recheck_maintenance),
        Tool(
            "book_maintenance",
            "Book the maintenance for the requester, who then holds the lease. Blast Radius refuses it unless its check allows it.",
            _book_maintenance,
            {"note": _text("One line on why.")},
            acts=True,
            needs=("recheck_maintenance",),
        ),
        Tool(
            "request_shift_lead_approval",
            "Hand the shift lead a ready-to-approve request. Only after recheck_maintenance says warn.",
            _request_shift_lead_approval,
            {"summary": _text("One line: what it would leave at risk, and for how long.")},
            ("summary",),
            acts=True,
            needs=("recheck_maintenance",),
            gate=_after_warn,
        ),
        Tool(
            "notify_requester",
            "Tell the requester where their maintenance request stands.",
            _notify_requester,
            {"message": _text("One or two plain sentences.")},
            ("message",),
            acts=True,
            needs=("recheck_maintenance",),
        ),
        Tool(
            "keep_waiting",
            "Leave the request queued until what blocks it clears. Only after recheck_maintenance says deny.",
            _keep_waiting,
            {"note": _text("One line on what it waits for.")},
            needs=("recheck_maintenance",),
            gate=_after_deny,
        ),
        Tool("check_job", "Status of the job this protection lock was for, and the lock itself.", _check_job),
        Tool(
            "release_protection_lock",
            "Release the stale protection lock. Blast Radius refuses unless the job has finished.",
            _release_protection_lock,
            {"note": _text("One line on why.")},
            acts=True,
            needs=("check_job",),
        ),
        Tool(
            "escalate",
            "Hand this issue to the shift lead and stop. Always allowed. Use it when the facts don't fit the goal or Blast Radius refuses an action.",
            _escalate,
            {"reason": _text("One line naming the deciding facts.")},
            ("reason",),
        ),
        Tool("finish", "Stop because the goal is reached. Always allowed.", _finish, {"summary": _text("One line naming the deciding facts.")}, ("summary",)),
    )
}


# --- Checks after the model says it's done -----------------------------------------------


def _ours(run: Run, type: str, subject: str) -> list[Event]:
    return [e for e in run.br.get_events(run.start_seq) if e.type == type and e.subject == subject and e.actor == run.actor]


def _verify_broken_node(run: Run) -> str | None:
    node, tenant = run.issue.subject, run.facts.get("tenant")
    if not any(x.actor == run.actor for x in run.br.leases_on(node)):
        return f"{node} isn't out of service under a lease"
    if not _ours(run, "tech_dispatched", node):
        return f"no technician was sent to {node}"
    if tenant and not any(e.data.get("to") == tenant for e in _ours(run, "notified", node)):
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
    if not booked and not _ours(run, "approval_requested", target):
        return f"{label(target)} is neither booked nor waiting on the shift lead"
    if not any(e.data.get("to") == requester for e in _ours(run, "notified", target)):
        return f"{requester} wasn't told"
    return None


def _verify_stale_protection(run: Run) -> str | None:
    if run.br.lease(run.issue.subject) is not None:
        return f"{run.issue.subject} still locks its racks"
    return None


@dataclass(frozen=True)
class Playbook:
    kind: str
    goal: str  # what "done" means; goes into the system prompt
    tools: tuple[str, ...]
    must_include: tuple[str, ...]  # a first plan has to contain these (when offered)
    after_refusal: frozenset[str]  # the only tools allowed once an action is refused
    verify: Callable[[Run], str | None]  # None when really fixed, else what isn't true


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
        "Done means one of three outcomes. If Blast Radius allows it now, it's booked for the requester. If it says warn, "
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


# --- The model's only way to act ----------------------------------------------------------


class ToolBox:
    def __init__(self, run: Run, playbook: Playbook) -> None:
        self.run, self.playbook = run, playbook
        self.tools = {n: TOOLS[n] for n in playbook.tools if TOOLS[n].offered(run)}

    def schemas(self) -> list[dict[str, Any]]:
        step = {
            "type": "object",
            "properties": {
                "tool": {"type": "string", "enum": list(self.tools)},
                "why": _text("One line: why this step."),
                "when": _text("Only for a step that depends on a result, e.g. 'if the check says warn'. Leave it out for steps you'll always take."),
            },
            "required": ["tool", "why"],
        }
        steps = {"type": "array", "items": step, "minItems": 1, "maxItems": MAX_PLAN_STEPS, "description": "Your steps, in order."}
        return [
            _schema("submit_plan", "Your first move: the steps you'll take to reach the goal, in order. Code checks the plan before you can act.", {"steps": steps}, ("steps",)),
            _schema(
                "revise_plan",
                "Replace your remaining steps when a result changes what you should do. Required before doing anything your plan doesn't say.",
                {"steps": steps, "reason": _text("One line: what changed.")},
                ("steps", "reason"),
            ),
            *(t.schema() for t in self.tools.values()),
        ]

    def call(self, name: str, raw_args: str | None) -> dict[str, Any]:
        result = self._call(name, raw_args)
        self.run.steps.append({"tool": name, "args": raw_args, "result": result})
        return result

    def _call(self, name: str, raw_args: str | None) -> dict[str, Any]:
        run = self.run
        if run.status != "open":
            return {"error": "This run is already over."}
        if name in PLAN_TOOLS:
            return self._plan(name, raw_args)
        tool = self.tools.get(name)
        if tool is None:
            run.br.record(run.actor, "agent_step", run.issue.subject, f"Blocked: the model asked for {name}, which this issue's playbook doesn't allow.")
            return {"error": f"{name} isn't available for this issue. Available: {', '.join(self.tools)}."}
        if run.refused and name not in self.playbook.after_refusal and name not in ALWAYS:
            return {"error": f"Blast Radius refused the last action ({run.refused}). Allowed now: {', '.join(sorted(self.playbook.after_refusal))}."}

        index = None
        if name not in ALWAYS:
            if run.plan is None:
                return {"error": "Plan first: call submit_plan with the steps you'll take."}
            index, problem = self._find_in_plan(name)
            if problem:
                return {"error": problem}
            missing = [n for n in tool.needs if n not in run.done]
            if missing:
                return {"error": f"{name} needs {', '.join(missing)} first: check before you act."}
        why_not = tool.gate(run)
        if why_not:
            return {"error": f"{name} is allowed {why_not}."}
        try:
            args = _parse_args(tool, raw_args)
        except ValueError as exc:
            return {"error": str(exc)}

        try:
            result = tool.handler(run, args)
        except OutOfScope as exc:
            run.refused = "deny"
            result = {"verdict": "deny", "reason": str(exc), "ok": False}
        if tool.acts and (result.get("granted") is False or result.get("ok") is False):
            run.refused = result.get("verdict", "deny")
        if index is not None and run.plan is not None:
            run.plan = run.plan[index + 1 :]
        run.done.append(name)
        if not tool.acts and name not in ("escalate", "finish", "keep_waiting"):
            run.br.record(run.actor, "agent_step", run.issue.subject, f"{name}: {_gist(result)}")
        return result

    def _find_in_plan(self, name: str) -> tuple[int | None, str | None]:
        """The next step has to be this tool. Steps skipped on the way must be conditional."""
        plan = self.run.plan or []
        for i, step in enumerate(plan):
            if step.tool == name:
                skipped = [s.tool for s in plan[:i] if not s.when]
                if skipped:
                    return None, f"Your plan does {skipped[0]} before {name}. Do that first, or call revise_plan."
                return i, None
        return None, f"{name} isn't in your plan. If a result changed what you should do, call revise_plan first."

    def _plan(self, name: str, raw: str | None) -> dict[str, Any]:
        run = self.run
        revising = name == "revise_plan"
        if revising and run.plan is None:
            return {"error": "There's no plan to revise yet: call submit_plan."}
        if not revising and run.plan is not None:
            return {"error": "You already have a plan. Use revise_plan to change it."}
        try:
            args = json.loads(raw or "{}")
        except json.JSONDecodeError:
            return {"accepted": False, "errors": ["Arguments must be a JSON object."]}
        if not isinstance(args, dict):
            return {"accepted": False, "errors": ["Arguments must be a JSON object."]}
        try:
            steps = _parse_steps(args.get("steps"))
        except ValueError as exc:
            return {"accepted": False, "errors": [str(exc)]}
        reason = " ".join(str(args.get("reason") or "").split())[:MAX_TEXT]
        errors = self._check_plan(steps, revising)
        if revising and not reason:
            errors.append("Say what changed in reason.")
        if errors:
            return {"accepted": False, "errors": errors}

        run.plan = steps
        run.plans.append(steps)
        head = f"Revised plan ({reason})" if revising else "Plan"
        run.br.record(
            run.actor,
            "agent_plan",
            run.issue.subject,
            f"{head}: {' -> '.join(s.tool for s in steps)}",
            steps=[asdict(s) for s in steps],
            revision=len(run.plans) - 1,
            change=reason,
        )
        return {"accepted": True, "steps": len(steps)}

    def _check_plan(self, steps: list[PlanStep], revising: bool) -> list[str]:
        errors = []
        if len(steps) > MAX_PLAN_STEPS:
            errors.append(f"Keep the plan to {MAX_PLAN_STEPS} steps or fewer.")
        names = [s.tool for s in steps]
        for i, step in enumerate(steps, 1):
            tool = self.tools.get(step.tool)
            if tool is None:
                errors.append(f"Step {i}: {step.tool} isn't available for this issue.")
                continue
            for need in tool.needs:
                if need not in names[: i - 1] and need not in self.run.done:
                    errors.append(f"Step {i}: {step.tool} needs {need} earlier in the plan (check before you act).")
        if not revising:  # a revision follows new facts, so only the first plan must cover the goal
            missing = [t for t in self.playbook.must_include if t in self.tools and t not in names]
            if missing:
                errors.append(f"The goal also needs: {', '.join(missing)}.")
        if not any(n in TERMINAL for n in names):
            errors.append(f"End the plan with {', '.join(TERMINAL[:-1])} or {TERMINAL[-1]}.")
        return errors


def _parse_steps(value: Any) -> list[PlanStep]:
    if not isinstance(value, list) or not value:
        raise ValueError("steps must be a non-empty list.")
    out = []
    for i, step in enumerate(value, 1):
        if not isinstance(step, dict) or not isinstance(step.get("tool"), str) or not step["tool"].strip():
            raise ValueError(f"Step {i} needs a tool name.")
        why = " ".join(str(step.get("why") or "").split())[:MAX_TEXT]
        if not why:
            raise ValueError(f"Step {i} needs a one-line why.")
        out.append(PlanStep(step["tool"].strip(), why, " ".join(str(step.get("when") or "").split())[:MAX_TEXT]))
    return out


def _parse_args(tool: Tool, raw: str | None) -> dict[str, Any]:
    try:
        args = json.loads(raw or "{}")
    except json.JSONDecodeError:
        raise ValueError("Arguments must be a JSON object.") from None
    if not isinstance(args, dict):
        raise ValueError("Arguments must be a JSON object.")
    out: dict[str, Any] = {}
    for key, spec in tool.params.items():
        if key not in args or args[key] is None:
            if key in tool.required:
                raise ValueError(f"{key} is required.")
            continue
        value = args[key]
        if spec["type"] == "integer":
            try:
                value = int(value)
            except (TypeError, ValueError):
                raise ValueError(f"{key} must be a whole number.") from None
            if not spec["minimum"] <= value <= spec["maximum"]:
                raise ValueError(f"{key} must be between {spec['minimum']} and {spec['maximum']}.")
        else:
            value = " ".join(str(value).split())[:MAX_TEXT]
            if key in tool.required and not value:
                raise ValueError(f"{key} can't be empty.")
        out[key] = value
    return out


def _gist(result: dict[str, Any]) -> str:
    """One line from a read tool's result, for the decision feed."""
    head = str(result.get("verdict") or result.get("classification") or result.get("level") or result.get("status") or "")
    reason = str(result.get("reason", ""))
    if not head or reason.lower().startswith(head.lower()):
        return reason or head
    head = head.upper() if head in ("allow", "warn", "deny") else head
    return f"{head}. {reason}" if reason else head
