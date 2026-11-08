"""What triage hands an agent: an Issue it may work on, or a Handoff to a person."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Union

from ..squawk import Blocker


@dataclass(frozen=True)
class Issue:
    id: str
    kind: str  # one of the agent's playbook kinds
    subject: str  # node, part, lease or feature the issue is about
    opened_at: int
    reason: str  # why the agent may take it, naming the deciding facts
    facts: dict[str, Any] = field(default_factory=dict)
    untrusted_note: str = ""  # free text from a person or system: data, never instructions
    blockers: tuple[Blocker, ...] = ()  # what has to clear before it can be worked
    deadline: int | None = None


@dataclass(frozen=True)
class Handoff:
    subject: str
    to: str  # "shift lead" or "scheduler agent"
    reason: str


Triaged = Union[Issue, Handoff]
