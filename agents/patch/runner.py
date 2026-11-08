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
from ..squawk import Blocker, Event, Squawk, SquawkUnavailable, fmt_time
from .fleet import COMPONENTS, Advisory, Fleet, patch_note
from .playbooks import FAILURE_TOOLS, HOLD_MIN, PLAYBOOKS, SHIFT_LEAD, TOOLS, told
from .rollout import exposure
from .triage import UPDATER, Handoff, triage, triage_failure

INTRO = (
    "You are the update agent for Squawk, the safety interlock of a simulated datacenter. A security advisory "
    "affects software in the hall. Patch it in safe waves using only the tools you're given; Squawk checks "
    "every booking, and code picks the targets."
)
FAIL_INTRO = (
    "You are the update agent for Squawk, the safety interlock of a simulated datacenter. A patch you rolled out "
    "failed its post-install check on one target. Decide how to recover it using only the tools you're given; "
    "Squawk checks every booking, and code picks the target and the versions."
)
RETRY_AFTER_S = 300  # after failing closed (no model, no Squawk), wait this long before trying the advisory again
STOP_AFTER_ROLLBACKS = 2  # an advisory whose canary was rolled back, or with this many rollbacks, stops for a person


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
        # Failed installs, by target: (advisory, component) until a retry passes or a rollback lands.
        self.failed: dict[str, tuple[str, str]] = {}
        self.fail_waiting: dict[str, set[Blocker]] = {}
        self.fail_handed: set[str] = set()  # handed to a person: kept held, no new runs
        self.fail_told: set[str] = set()  # targets whose failure the shift lead heard about
        self.fail_seen: set[tuple[str, int]] = set()  # (target, attempt) already announced
        self.stopped: set[str] = set()  # advisories stopped after failed installs

    def handle(self, event: Event) -> list[Outcome]:
        self.fleet.observe(event)
        for adv in self.advisories:
            who = told(event, self.actor, adv.id)
            if who:
                self.told[adv.id].add(who)
        if event.actor == self.actor and event.subject in self.failed:  # durable across a restart: read from the feed
            if event.type == "notified" and event.data.get("to") == SHIFT_LEAD:
                self.fail_told.add(event.subject)
            elif event.type == "escalated":
                self.fail_handed.add(event.subject)
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
        for target, blockers in list(self.fail_waiting.items()):
            left = {b for b in blockers if not _clears(b, event)}
            if left != blockers:
                self._fail_wait(target, left)
        return []

    def after(self) -> list[Outcome]:
        now = self.br.now
        for adv_id, blockers in list(self.waiting.items()):  # windows that ended without an event yet
            self._wait_on(adv_id, {b for b in blockers if b.until is None or b.until > now})
        for target, blockers in list(self.fail_waiting.items()):
            self._fail_wait(target, {b for b in blockers if b.until is None or b.until > now})
        out = []
        for adv in self.advisories:  # failed installs first: they halt their advisory's rollout
            if adv.id not in self.stopped:
                out += self._failures(adv, now)
        for adv in self.advisories:  # worst first
            if adv.id not in self.dirty or adv.id in self.waiting or self.retry_at.get(adv.id, 0) > self.clock():
                continue
            if adv.id in self.stopped or any(a == adv.id for a, _ in self.failed.values()):
                continue  # halted: no new wave while one of its installs is failed
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
        if adv.id not in self.started or adv.id in self.completed:
            return
        ex = exposure(adv, self.fleet, self.br)
        if ex.total == 0:
            self.completed.add(adv.id)
            self.record(adv.id, f"FIXED: every target of {adv.id} now runs {adv.fixed} or newer; its patch windows have all ended.", status="fixed")
        elif ex.total == len(ex.rolled_back) and not ex.failed:
            self.completed.add(adv.id)
            self.record(
                adv.id,
                f"HANDED OFF: {adv.id} is rolled out everywhere except {', '.join(ex.rolled_back)}, rolled back after failed installs; a person plans those.",
                status="handed_off",
            )  # fmt: skip

    # ---- failed installs

    def _failures(self, adv: Advisory, now: int) -> list[Outcome]:
        """Resolve the advisory's failed installs that are settled, then work the new ones."""
        version = {adv.component: adv.fixed, **adv.requires}
        for target, (adv_id, component) in list(self.failed.items()):
            if adv_id != adv.id or target in self.fail_waiting:
                continue
            st = self.fleet.status(component, target, now)
            label = COMPONENTS[component].label
            if st == "ok":
                del self.failed[target]
                self.dirty.add(adv.id)
                tries = self.fleet.attempt(component, target, version[component], now)
                self.record(target, f"FIXED: {target} passed its check on {label} {version[component]} at attempt {tries}; the rollout of {adv.id} resumes.", status="fixed")
            elif st == "rolled_back":
                del self.failed[target]
                self.dirty.add(adv.id)
                back = self.fleet.last_window(component, target)
                self.record(
                    target,
                    f"ROLLED BACK: {target} is back on {label} {back.version if back else 'its old version'} and in service; it stays exposed to {adv.id} until a person plans the fix.",
                    status="handed_off",
                )  # fmt: skip
                self._maybe_stop(adv, component, target, now)
        out = []
        for component, target in self.fleet.failures(adv, now):
            if target in self.fail_waiting:
                continue
            self.failed[target] = (adv.id, component)
            hold = self._contain(adv, component, target, now)
            if target in self.fail_handed or self.retry_at.get(target, 0) > self.clock():
                continue
            issue = triage_failure(
                adv, self.fleet, self.br, component, target,
                lead_told=target in self.fail_told, others=sum(1 for a, _ in self.failed.values() if a == adv.id) - 1,
            )  # fmt: skip
            out.append(self._run_failure(adv, issue, component, target, hold))
        return out

    def _contain(self, adv: Advisory, component: str, target: str, now: int) -> tuple[str | None, int | None]:
        """Code, not the model: cancel the target's later windows (a fix after a failed prerequisite),
        say what failed once, and keep a node out of service under our hold."""
        comp = COMPONENTS[component]
        version = {adv.component: adv.fixed, **adv.requires}[component]
        tries = self.fleet.attempt(component, target, version, now)
        if (target, tries) not in self.fail_seen:
            self.fail_seen.add((target, tries))
            for lease in self.fleet.later_windows(target, now):
                self.br.release_lease(self.actor, lease, f"cancelled: {comp.label} {version} failed on {target} first")
            self.record(
                target,
                f"{comp.label} {version} failed its post-install check on {target} (attempt {tries}): "
                f"{self.fleet.symptom(component, target, version)} "
                + (f"{target} is held out of service; " if comp.scope == "node" else "")
                + f"the rollout of {adv.id} is halted.",
                status="patch_failed", advisory=adv.id, attempt=tries,
            )  # fmt: skip
        if comp.scope != "node":
            return None, None
        held = self.fleet.held(target, now)
        if held:
            return held
        d = self.br.request_work(
            self.actor, comp.kind, target, minutes=HOLD_MIN,
            note=patch_note(adv, component, version, "kept out of service after a failed install", kind="hold"),
        )  # fmt: skip
        if d.granted and d.lease:
            self.fleet.holds[target] = (d.lease.id, d.lease.start, d.lease.end)
            return d.lease.id, d.lease.end
        return None, None

    def _maybe_stop(self, adv: Advisory, component: str, target: str, now: int) -> None:
        """A rolled-back canary, or too many rollbacks, stops the advisory: a person plans the rest."""
        version = {adv.component: adv.fixed, **adv.requires}[component]
        rolled = exposure(adv, self.fleet, self.br).rolled_back
        canary = self.fleet.canary(component, version, target)
        if adv.id in self.stopped or not (canary or len(rolled) >= STOP_AFTER_ROLLBACKS):
            return
        self.stopped.add(adv.id)
        why = f"the canary {target} was rolled back" if canary else f"{len(rolled)} targets were rolled back ({', '.join(rolled)})"
        try:
            self.br.escalate(self.actor, adv.id, SHIFT_LEAD, f"Stopped the rollout of {adv.id}: {why}. No more waves until a person looks at the fix.")
        except SquawkUnavailable:
            pass

    def _run_failure(self, adv: Advisory, issue, component: str, target: str, hold: tuple[str | None, int | None]) -> Outcome:
        version = {adv.component: adv.fixed, **adv.requires}[component]
        extra = {
            "advisory": adv, "fleet": self.fleet, "component": component, "target": target, "version": version,
            "hold": hold[0], "hold_until": hold[1],
        }  # fmt: skip
        outcome = run_agent(
            issue, self.br, self.model, intro=FAIL_INTRO, playbooks=PLAYBOOKS, registry=FAILURE_TOOLS, actor=self.actor,
            start_seq=self.cursor, max_model_calls=self.max_model_calls, extra=extra,
        )  # fmt: skip
        self.outcomes.append(outcome)
        if outcome.status == "waiting":
            self._fail_wait(target, set(outcome.blockers))
            ends = [b.until for b in outcome.blockers if b.until is not None]
            when = f" when its window ends at {fmt_time(max(ends))}" if ends else ""
            self.record(target, f"Booked; code checks {target} again{when}. No model calls while it waits.", issue=issue.id, status="booked")
        elif outcome.status == "handed_off":
            self.fail_handed.add(target)
        elif outcome.status == "failed_closed":
            self.retry_at[target] = self.clock() + RETRY_AFTER_S
        return outcome

    def _fail_wait(self, target: str, blockers: set[Blocker]) -> None:
        if blockers:
            self.fail_waiting[target] = blockers
        else:
            self.fail_waiting.pop(target, None)

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
