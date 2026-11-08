"""A deterministic stand-in for Nemotron: submits a fixed plan per issue type, then
follows a fixed policy.

Used by the tests and by each agent's --scripted mode (no model requests). Real runs use
Nemotron through agents.llm.ModelRouter, which writes its own plans. It answers the way
a model does: one tool call per reply, chosen from the issue's facts and the tool
results so far.
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable

from openai.types.chat import ChatCompletion

from ..config import Endpoint
from ..llm import Reply

SCRIPTED = Endpoint("scripted", "local", "", "", "playbook")

Done = list[tuple[str, dict[str, Any]]]  # (tool name, result) so far, oldest first
Step = tuple[str, dict[str, Any]]
Policy = Callable[[dict[str, Any], Done], Step]
PlanFn = Callable[[dict[str, Any]], list[dict[str, str]]]


class ScriptedModel:
    def __init__(self, plans: dict[str, PlanFn], policies: dict[str, Policy]) -> None:
        self.plans, self.policies = plans, policies
        self.requests = 0

    def chat(self, messages: list[dict[str, Any]], *, tools=None, tool_choice="auto", max_tokens=4096) -> Reply:
        self.requests += 1
        kind, facts = _issue(messages)
        done = _done(messages)
        if not any(n == "submit_plan" and r.get("accepted") for n, r in done):
            name, args = "submit_plan", {"steps": self.plans[kind](facts)}
        else:
            name, args = self.policies[kind](facts, done)
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


def step(tool: str, why: str, when: str = "") -> dict[str, str]:
    return {"tool": tool, "why": why, **({"when": when} if when else {})}


def called(done: Done) -> set[str]:
    return {n for n, _ in done}


def last(done: Done, name: str) -> dict[str, Any] | None:
    return next((r for n, r in reversed(done) if n == name), None)


def _issue(messages: list[dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    text = next(m["content"] for m in messages if m["role"] == "user" and str(m["content"]).startswith("Issue "))
    kind = re.match(r"Issue \S+ \((\w+)\)", text).group(1)
    facts = json.loads(re.search(r"```json\n(.*?)\n```", text, re.S).group(1))
    return kind, facts


def _done(messages: list[dict[str, Any]]) -> Done:
    names = {c["id"]: c["function"]["name"] for m in messages if m["role"] == "assistant" for c in m.get("tool_calls") or ()}
    return [(names[m["tool_call_id"]], json.loads(m["content"])) for m in messages if m["role"] == "tool"]
