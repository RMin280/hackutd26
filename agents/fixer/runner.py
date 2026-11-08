"""Watches Blast Radius events, triages each one, gives low-criticality issues to the fixer
agent and hands everything else to a person or the scheduler agent.

A refused routine request waits here, with no model calls, until what blocked it clears
(a repair, a lease ending, or stale readings becoming fresh again), then the agent
rechecks it.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..blast_radius import BlastRadius, Blocker, Event, fmt_time, label
from ..common.loop import MAX_MODEL_CALLS, Model, Outcome
from ..common.runner import EventRunner
from .agent import run_fixer
from .triage import FIXER, Handoff, Issue, triage


@dataclass
class Waiting:
    issue: Issue
    blockers: set[Blocker]


class FixerRunner(EventRunner):
    def __init__(self, br: BlastRadius, model: Model, *, actor: str = FIXER, max_model_calls: int = MAX_MODEL_CALLS) -> None:
        super().__init__(br, actor)
        self.model, self.max_model_calls = model, max_model_calls
        self.waiting: dict[str, Waiting] = {}

    def handle(self, event: Event) -> list[Outcome]:
        out: list[Outcome] = []
        for item in triage(event, self.br, self.actor):
            if isinstance(item, Handoff):
                self.br.escalate(self.actor, item.subject, item.to, item.reason)
            elif item.kind == "maintenance_refused":
                self._wait(item, item.blockers)
            else:
                out.append(self._run(item))
        for issue in self._unblocked_by(event):
            out.append(self._run(issue))
        return out

    def after(self) -> list[Outcome]:
        self._give_up_on_stale_waits()
        return []

    def _run(self, issue: Issue) -> Outcome:
        self.record(issue.subject, f"Taking {issue.kind}. {issue.reason}", issue=issue.id, status="started")
        outcome = run_fixer(issue, self.br, self.model, actor=self.actor, start_seq=self.cursor, max_model_calls=self.max_model_calls)
        self.outcomes.append(outcome)
        if outcome.status == "waiting":
            self._wait(issue, outcome.blockers)
        else:
            self.record(
                issue.subject,
                f"{outcome.status.upper().replace('_', ' ')}: {outcome.summary}",
                issue=issue.id,
                status=outcome.status,
                model_calls=outcome.model_calls,
                served_by=list(outcome.served_by),
            )
        return outcome

    def _wait(self, issue: Issue, blockers: tuple[Blocker, ...]) -> None:
        self.waiting[issue.id] = Waiting(issue, set(blockers))
        requester = issue.facts.get("requester", "the requester")
        self.record(
            issue.subject,
            f"Queued {requester}'s routine {label(issue.subject)} request until {describe_blockers(blockers)}. No model calls while it waits.",
            issue=issue.id,
            status="waiting",
        )

    def _unblocked_by(self, event: Event) -> list[Issue]:
        ready = []
        for key, w in list(self.waiting.items()):
            cleared = {b for b in w.blockers if _clears(b, event, self.br.now)}
            if not cleared:
                continue
            w.blockers -= cleared
            if w.blockers:
                self.record(
                    w.issue.subject,
                    f"{describe_blockers(tuple(cleared))}, but the {label(w.issue.subject)} request still waits until {describe_blockers(tuple(w.blockers))}.",
                    issue=w.issue.id,
                    status="waiting",
                )
            else:
                del self.waiting[key]
                ready.append(w.issue)
        return ready

    def _give_up_on_stale_waits(self) -> None:
        for key, w in list(self.waiting.items()):
            if w.issue.deadline is not None and self.br.now >= w.issue.deadline:
                del self.waiting[key]
                self.br.escalate(
                    self.actor,
                    w.issue.subject,
                    "shift lead",
                    f"Still blocked after 24 h: the routine {label(w.issue.subject)} request is waiting for {describe_blockers(tuple(w.blockers))}.",
                )


def _clears(b: Blocker, e: Event, now: int) -> bool:
    if b.kind == "part_repair":
        return e.type == "state_change" and e.subject == b.id and e.data.get("state") == "ok"
    if b.kind == "lease_ends":
        return (e.type in ("lease_released", "lease_expired") and e.subject == b.id) or (b.until is not None and now >= b.until)
    if b.kind == "feature_ok":
        return e.type == "feature_state" and e.subject == b.id and e.data.get("state") == "working"
    return False


def _describe(b: Blocker) -> str:
    if b.kind == "part_repair":
        return f"{label(b.id)} is repaired"
    if b.kind == "feature_ok":
        return f"{label(b.id)} are fresh again" if b.id.startswith("bms.cooling.") else f"{label(b.id)} works again"
    return f"{b.id} ends" + (f" ({fmt_time(b.until)})" if b.until is not None else "")


def describe_blockers(blockers: tuple[Blocker, ...]) -> str:
    return " and ".join(_describe(b) for b in blockers) or "nothing"
