"""The machinery every agent shares: the per-issue Run, tools bound to the issue,
playbooks, and the ToolBox, which is the model's only way to act.

The model plans its own steps. Its first move is submit_plan, which code checks: only
this playbook's tools, every action after its check, the goal covered, and a way to
stop. It then has to follow that plan, or call revise_plan before doing anything the
plan doesn't say. Every action goes through Squawk, and after a refusal only the
playbook's follow-ups are allowed. These rules live here in code, not in the prompt.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any, Callable

from ..squawk import Squawk, Blocker, Event, OutOfScope
from .issues import Issue

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
    """One agent run on one issue."""

    issue: Issue
    br: Squawk
    actor: str
    start_seq: int  # events after this one belong to this run
    status: str = "open"  # open | fixed | handed_off | waiting
    summary: str = ""
    refused: str | None = None  # verdict of the last refused action: "deny" or "warn"
    last_check: str | None = None  # verdict of the last recheck (fixer)
    blockers: tuple[Blocker, ...] = ()  # keep_waiting: what has to clear
    plan: list[PlanStep] | None = None  # steps still to do
    plans: list[list[PlanStep]] = field(default_factory=list)  # every accepted plan, first to last
    done: list[str] = field(default_factory=list)  # tools that ran in this run
    steps: list[dict[str, Any]] = field(default_factory=list)  # every tool call and its result
    extra: dict[str, Any] = field(default_factory=dict)  # agent-specific helpers, e.g. a prober

    @property
    def facts(self) -> dict[str, Any]:
        return self.issue.facts


Handler = Callable[[Run, dict[str, Any]], dict[str, Any]]


def tool_schema(name: str, description: str, properties: dict[str, Any], required: tuple[str, ...] | list[str]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": list(required)},
        },
    }


def text_param(description: str) -> dict[str, Any]:
    return {"type": "string", "description": description}


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    handler: Handler
    params: dict[str, dict[str, Any]] = field(default_factory=dict)
    required: tuple[str, ...] = ()
    acts: bool = False  # changes something, so Squawk may refuse it
    needs: tuple[str, ...] = ()  # checks that must run first: look before you leap
    offered: Callable[[Run], bool] = lambda run: True
    gate: Callable[[Run], str | None] = lambda run: None  # why it isn't allowed right now

    def schema(self) -> dict[str, Any]:
        return tool_schema(self.name, self.description, self.params, self.required)


def events_by(run: Run, type: str, subject: str | None = None) -> list[Event]:
    """This run's own events of a type (optionally about one subject), for the done checks."""
    return [
        e
        for e in run.br.get_events(run.start_seq)
        if e.type == type and e.actor == run.actor and (subject is None or e.subject == subject)
    ]


def _escalate(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    run.br.escalate(run.actor, run.issue.subject, "shift lead", args["reason"])
    run.status, run.summary = "handed_off", args["reason"]
    return {"ok": True, "reason": "Handed to the shift lead."}


def _finish(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    run.status, run.summary = "fixed", args["summary"]
    return {"ok": True}


COMMON_TOOLS: dict[str, Tool] = {
    "escalate": Tool(
        "escalate",
        "Hand this issue to the shift lead and stop. Always allowed. Use it when the facts don't fit the goal or Squawk refuses an action.",
        _escalate,
        {"reason": text_param("One line naming the deciding facts.")},
        ("reason",),
    ),
    "finish": Tool("finish", "Stop because the goal is reached. Always allowed.", _finish, {"summary": text_param("One line naming the deciding facts.")}, ("summary",)),
}


@dataclass(frozen=True)
class Playbook:
    kind: str
    goal: str  # what "done" means; goes into the system prompt
    tools: tuple[str, ...]
    must_include: tuple[str, ...]  # a first plan has to contain these (when offered)
    after_refusal: frozenset[str]  # the only tools allowed once an action is refused
    verify: Callable[[Run], str | None]  # None when really done, else what isn't true


class ToolBox:
    def __init__(self, run: Run, playbook: Playbook, registry: dict[str, Tool]) -> None:
        self.run, self.playbook = run, playbook
        self.tools = {n: registry[n] for n in playbook.tools if registry[n].offered(run)}

    def schemas(self) -> list[dict[str, Any]]:
        step = {
            "type": "object",
            "properties": {
                "tool": {"type": "string", "enum": list(self.tools)},
                "why": text_param("One line: why this step."),
                "when": text_param("Only for a step that depends on a result, e.g. 'if the check says warn'. Leave it out for steps you'll always take."),
            },
            "required": ["tool", "why"],
        }
        steps = {"type": "array", "items": step, "minItems": 1, "maxItems": MAX_PLAN_STEPS, "description": "Your steps, in order."}
        return [
            tool_schema("submit_plan", "Your first move: the steps you'll take to reach the goal, in order. Code checks the plan before you can act.", {"steps": steps}, ("steps",)),
            tool_schema(
                "revise_plan",
                "Replace your remaining steps when a result changes what you should do. Required before doing anything your plan doesn't say.",
                {"steps": steps, "reason": text_param("One line: what changed.")},
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
            return {"error": f"Squawk refused the last action ({run.refused}). Allowed now: {', '.join(sorted(self.playbook.after_refusal))}."}

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
    head = str(result.get("verdict") or result.get("classification") or result.get("level") or result.get("status") or result.get("state") or "")
    reason = str(result.get("reason", ""))
    if not head or reason.lower().startswith(head.lower()):
        return reason or head
    head = head.upper() if head in ("allow", "warn", "deny") else head
    return f"{head}. {reason}" if reason else head
