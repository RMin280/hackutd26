"""The update agent's event loop: watch advisories against the fleet, roll each fix out one
wave per run, and wait between waves with no model calls.

State that matters is in Squawk: which windows were booked and ended (the fleet reads its
own lease_granted rows) and who was told (its own notified rows). A restarted agent reads
the feed from the start and carries on where it was, without re-notifying anyone.
"""

from __future__ import annotations

import time

from ..common.loop import MAX_MODEL_CALLS, Model, Outcome, run_agent
from ..common.runner import EventRunner
from ..squawk import Blocker, Event, Squawk, fmt_time
from .fleet import COMPONENTS, Advisory, Fleet
from .playbooks import PLAYBOOKS, TOOLS, told
from .rollout import exposure
from .triage import UPDATER, Handoff, triage

INTRO = (
    "You are the update agent for Squawk, the safety interlock of a simulated datacenter. A security advisory "
    "affects software in the hall. Patch it in safe waves using only the tools you're given; Squawk checks "
    "every booking, and code picks the targets."
)
RETRY_AFTER_S = 300  # after failing closed (no model, no Squawk), wait this long before trying the advisory again


class PatchRunner(EventRunner):
    def __init__(
        self,
        br: Squawk,
        model: Model,
        advisories: list[Advisory],
        fleet: Fleet,
        *,
        actor: str = UPDATER,
        max_model_calls: int = MAX_MODEL_CALLS,
        clock=time.monotonic,
    ) -> None:
        super().__init__(br, actor)
        self.model, self.max_model_calls, self.clock = model, max_model_calls, clock
        self.advisories, self.fleet = advisories, fleet
        self.fleet.actor = actor
        self.dirty: set[str] = {a.id for a in advisories}  # advisories to triage at the end of this drain
        self.waiting: dict[str, set[Blocker]] = {}
        self.parked: dict[str, dict[str, str]] = {a.id: {} for a in advisories}
        self.told: dict[str, set[str]] = {a.id: set() for a in advisories}
        self.retry_at: dict[str, float] = {}
        self.handed: set[str] = set()
        self.started: set[str] = set()  # advisories this agent has worked
        self.completed: set[str] = set()

    def handle(self, event: Event) -> list[Outcome]:
        self.fleet.observe(event)
        for adv in self.advisories:
            who = told(event, self.actor, adv.id)
            if who:
                self.told[adv.id].add(who)
        if event.type == "job_status" and event.data.get("status") == "finished":
            for adv in self.advisories:  # targets refused for this job can be tried again
                parked = self.parked[adv.id]
                for t in [t for t, owner in parked.items() if owner == event.subject]:
                    del parked[t]
                    self.dirty.add(adv.id)
        if event.type in ("lease_expired", "lease_released") or (event.type == "state_change" and event.data.get("state") == "ok"):
            for adv in self.advisories:  # spares may be back above the reserve
                if adv.component in COMPONENTS and COMPONENTS[adv.component].scope == "node":
                    self.dirty.add(adv.id)
        for adv_id, blockers in list(self.waiting.items()):
            left = {b for b in blockers if not _clears(b, event)}
            if left != blockers:
                self._wait_on(adv_id, left)
        return []

    def after(self) -> list[Outcome]:
        now = self.br.now
        for adv_id, blockers in list(self.waiting.items()):  # windows that ended without an event yet
            self._wait_on(adv_id, {b for b in blockers if b.until is None or b.until > now})
        out = []
        for adv in self.advisories:  # worst first
            if adv.id not in self.dirty or adv.id in self.waiting or self.retry_at.get(adv.id, 0) > self.clock():
                continue
            self.dirty.discard(adv.id)
            flying = self.fleet.in_flight(adv, now)
            if flying:  # a wave is still running (e.g. booked before a restart): the next one waits for it
                self._wait_on(adv.id, {Blocker("lease_ends", lease, until) for lease, until in flying})
                continue
            item = triage(adv, self.fleet, self.br, self.parked[adv.id], self.told[adv.id])
            if item is None:
                self._maybe_complete(adv)
                continue
            if isinstance(item, Handoff):
                if adv.id not in self.handed:
                    self.handed.add(adv.id)
                    self.br.escalate(self.actor, item.subject, item.to, item.reason)
                continue
            out.append(self._run(adv, item))
        return out

    def _maybe_complete(self, adv: Advisory) -> None:
        if adv.id in self.started and adv.id not in self.completed and exposure(adv, self.fleet, self.br).total == 0:
            self.completed.add(adv.id)
            self.record(adv.id, f"FIXED: every target of {adv.id} now runs {adv.fixed} or newer; its patch windows have all ended.", status="fixed")

    def _run(self, adv: Advisory, issue) -> Outcome:
        self.started.add(adv.id)
        self.record(issue.subject, f"Taking {adv.id}. {issue.reason}", issue=issue.id, status="started")
        extra = {"advisory": adv, "fleet": self.fleet, "parked": self.parked[adv.id], "told": self.told[adv.id]}
        outcome = run_agent(
            issue, self.br, self.model, intro=INTRO, playbooks=PLAYBOOKS, registry=TOOLS, actor=self.actor,
            start_seq=self.cursor, max_model_calls=self.max_model_calls, extra=extra,
        )  # fmt: skip
        self.outcomes.append(outcome)
        if outcome.status == "waiting":
            self._wait_on(adv.id, set(outcome.blockers))
            ends = [b.until for b in outcome.blockers if b.until is not None]
            when = f" (by {fmt_time(max(ends))})" if ends else ""
            self.record(adv.id, f"Waiting on {adv.id}: the next wave is checked once this one's windows end{when}. No model calls while it waits.", issue=issue.id, status="waiting")
        else:
            if outcome.status == "failed_closed":
                self.retry_at[adv.id] = self.clock() + RETRY_AFTER_S
                self.dirty.add(adv.id)
            self.record(
                adv.id,
                f"{outcome.status.upper().replace('_', ' ')}: {outcome.summary}",
                issue=issue.id, status=outcome.status, model_calls=outcome.model_calls, served_by=list(outcome.served_by),
            )  # fmt: skip
        return outcome

    def _wait_on(self, adv_id: str, blockers: set[Blocker]) -> None:
        if blockers:
            self.waiting[adv_id] = blockers
        else:
            self.waiting.pop(adv_id, None)
            self.dirty.add(adv_id)


def _clears(b: Blocker, e: Event) -> bool:
    if e.type in ("lease_expired", "lease_released") and e.subject == b.id:
        return True
    return e.type == "job_status" and e.subject == b.id and e.data.get("status") == "finished"
