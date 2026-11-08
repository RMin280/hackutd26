"""Watches Blast Radius events, triages each one, gives low-criticality issues to the fixer
agent and hands everything else to a person or the scheduler agent.

A refused routine request waits here, with no model calls, until what blocked it clears
(a repair, or a lease ending), then the agent rechecks it.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..blast_radius import BlastRadius, BlastRadiusUnavailable, Blocker, Event, fmt_time, label
from .agent import MAX_MODEL_CALLS, Model, Outcome, run_fixer
from .triage import FIXER, Handoff, Issue, triage


@dataclass
class Waiting:
    issue: Issue
    blockers: set[Blocker]


class FixerRunner:
    def __init__(self, br: BlastRadius, model: Model, *, actor: str = FIXER, max_model_calls: int = MAX_MODEL_CALLS) -> None:
        self.br, self.model, self.actor, self.max_model_calls = br, model, actor, max_model_calls
        self.cursor = 0  # last event handled
        self.waiting: dict[str, Waiting] = {}
        self.outcomes: list[Outcome] = []

    def drain(self) -> list[Outcome]:
        """Handle every new event, including the ones our own actions cause, until quiet."""
        new: list[Outcome] = []
        while True:
            events = self.br.get_events(self.cursor)
            if not events:
                break
            for event in events:
                self.cursor = event.seq
                new += self._handle(event)
        self._give_up_on_stale_waits()
        return new

    def _handle(self, event: Event) -> list[Outcome]:
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

    def _run(self, issue: Issue) -> Outcome:
        self._record(issue.subject, f"Taking {issue.kind}. {issue.reason}", issue=issue.id, status="started")
        outcome = run_fixer(issue, self.br, self.model, actor=self.actor, start_seq=self.cursor, max_model_calls=self.max_model_calls)
        self.outcomes.append(outcome)
        if outcome.status == "waiting":
            self._wait(issue, outcome.blockers)
        else:
            self._record(
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
        self._record(
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
                self._record(
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

    def _record(self, subject: str, reason: str, **data: object) -> None:
        try:
            self.br.record(self.actor, "agent", subject, reason, **data)
        except BlastRadiusUnavailable:
            pass  # failing closed: the outcome still reaches the caller


def _clears(b: Blocker, e: Event, now: int) -> bool:
    if b.kind == "part_repair":
        return e.type == "state_change" and e.subject == b.id and e.data.get("state") == "ok"
    if b.kind == "lease_ends":
        return (e.type in ("lease_released", "lease_expired") and e.subject == b.id) or (b.until is not None and now >= b.until)
    return False


def describe_blockers(blockers: tuple[Blocker, ...]) -> str:
    parts = [
        f"{label(b.id)} is repaired" if b.kind == "part_repair" else f"{b.id} ends" + (f" ({fmt_time(b.until)})" if b.until is not None else "")
        for b in blockers
    ]
    return " and ".join(parts) or "nothing"
