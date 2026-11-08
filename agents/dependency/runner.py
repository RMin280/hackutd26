"""Runs the scheduled feature tests, records each result in Squawk (which sets the
feature's state), and hands the issues those changes cause to the dependency agent or a
person.

Tests are code and cost no model calls. In the simulation, the prober is
SimulatedServices; in production it would exercise the real services from our side.
"""

from __future__ import annotations

from typing import Any

from ..squawk import Squawk, Event
from ..common.loop import MAX_MODEL_CALLS, Model, Outcome
from ..common.runner import EventRunner
from ..mock_services import TEST_INTERVAL
from .agent import run_dependency
from .triage import DEPENDENCY, Handoff, Issue, triage


class DependencyRunner(EventRunner):
    def __init__(
        self,
        br: Squawk,
        model: Model,
        prober: Any,
        *,
        actor: str = DEPENDENCY,
        max_model_calls: int = MAX_MODEL_CALLS,
        interval: int = TEST_INTERVAL,
    ) -> None:
        super().__init__(br, actor)
        self.model, self.prober, self.max_model_calls, self.interval = model, prober, max_model_calls, interval
        self.next_test = 0

    def tick(self) -> list[Outcome]:
        """Run every feature's test when one is due; the events they cause are handled next."""
        if self.br.now < self.next_test:
            return []
        self.next_test = (self.br.now // self.interval + 1) * self.interval
        for f in self.br.features():
            passed, detail = self.prober.probe(f.id, self.br.now)
            self.br.record_test(self.actor, f.id, passed, detail, self.prober.says(f.service))
        return []

    def handle(self, event: Event) -> list[Outcome]:
        out: list[Outcome] = []
        for item in triage(event, self.br, self.actor):
            if isinstance(item, Handoff):
                self.br.escalate(self.actor, item.subject, item.to, item.reason)
            else:
                out.append(self._run(item))
        return out

    def _run(self, issue: Issue) -> Outcome:
        self.record(issue.subject, f"Taking {issue.kind}. {issue.reason}", issue=issue.id, status="started")
        outcome = run_dependency(
            issue, self.br, self.model, prober=self.prober, actor=self.actor, start_seq=self.cursor, max_model_calls=self.max_model_calls
        )
        self.outcomes.append(outcome)
        self.record(
            issue.subject,
            f"{outcome.status.upper().replace('_', ' ')}: {outcome.summary}",
            issue=issue.id,
            status=outcome.status,
            model_calls=outcome.model_calls,
            served_by=list(outcome.served_by),
        )
        return outcome
