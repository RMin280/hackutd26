"""The fixer agent: Nemotron fixes low-criticality issues through Squawk, planning
its own steps toward each issue's goal. The loop, the planning rules and the fail-closed
behavior are shared with every agent (agents/common/loop.py).
"""

from __future__ import annotations

from ..squawk import Squawk
from ..common.issues import Issue
from ..common.loop import MAX_MODEL_CALLS, Model, Outcome, issue_message, run_agent
from ..common.loop import system_prompt as _system_prompt
from .playbooks import PLAYBOOKS, TOOLS
from .triage import FIXER

__all__ = ["INTRO", "MAX_MODEL_CALLS", "Model", "Outcome", "issue_message", "run_fixer", "system_prompt"]

INTRO = (
    "You are the fixer agent for Squawk, the safety interlock of a simulated datacenter. Squawk has "
    "already triaged this issue as low criticality. Reach the goal below using only the tools you're given."
)


def system_prompt(kind: str) -> str:
    return _system_prompt(INTRO, PLAYBOOKS[kind])


def run_fixer(
    issue: Issue,
    br: Squawk,
    model: Model,
    *,
    actor: str = FIXER,
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
    )
