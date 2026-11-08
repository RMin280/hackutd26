"""The dependency agent: Nemotron responds to gray failures in services we rely on,
planning its own steps toward each issue's goal. The loop, the planning rules and the
fail-closed behavior are shared with every agent (agents/common/loop.py).
"""

from __future__ import annotations

from typing import Any

from ..squawk import Squawk
from ..common.issues import Issue
from ..common.loop import MAX_MODEL_CALLS, Model, Outcome, run_agent
from ..common.loop import system_prompt as _system_prompt
from .playbooks import PLAYBOOKS, TOOLS
from .triage import DEPENDENCY

INTRO = (
    "You are the dependency agent for Squawk, the safety interlock of a simulated datacenter. Our own tests "
    "found that a service we rely on isn't doing what it says. Reach the goal below using only the tools you're given."
)


def system_prompt(kind: str) -> str:
    return _system_prompt(INTRO, PLAYBOOKS[kind])


def run_dependency(
    issue: Issue,
    br: Squawk,
    model: Model,
    *,
    prober: Any,
    actor: str = DEPENDENCY,
    start_seq: int = 0,
    max_model_calls: int = MAX_MODEL_CALLS,
) -> Outcome:
    return run_agent(
        issue,
        br,
        model,
        intro=INTRO,
        playbooks=PLAYBOOKS,
        registry=TOOLS,
        actor=actor,
        start_seq=start_seq,
        max_model_calls=max_model_calls,
        extra={"prober": prober},
    )
