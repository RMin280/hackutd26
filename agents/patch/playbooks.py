"""The update agent's playbook: roll one advisory's fix out through Squawk, one wave per run.

Tools are bound to the issue's advisory. Code picks the targets, the order, the canary and
the spare reserve (rollout.py); the model chooses the wave size, the wording, and whether
the run ends waiting for the next wave or finished. Deterministic checks decide whether
"finished" is true.
"""

from __future__ import annotations

from typing import Any

from ..common.playbook import COMMON_TOOLS, Playbook, Run, Tool, events_by, text_param
from ..squawk import Blocker, fmt_time
from .fleet import COMPONENTS, Advisory, Fleet
from .rollout import MAX_WAVE, Exposure, book_wave, exposure, plan_wave

SHIFT_LEAD = "shift lead"


def _ctx(run: Run) -> tuple[Advisory, Fleet, dict[str, str]]:
    return run.extra["advisory"], run.extra["fleet"], run.extra["parked"]


def _check_wave(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    adv, fleet, parked = _ctx(run)
    ex = exposure(adv, fleet, run.br, parked)
    wave = plan_wave(adv, fleet, run.br, args.get("size", 8), ex)
    run.extra["wave"], run.extra["exposure"] = wave, ex
    out: dict[str, Any] = {
        "reason": f"Next wave: {len(wave.targets)} of {len(ex.ready)} ready targets ({wave.limit_reason}); {ex.total} still vulnerable.",
        "wave_targets": len(wave.targets),
        "canary": wave.canary,
        "limited_by": wave.limit_reason,
        "first_targets": wave.targets[:4],
        "bookings": len(wave.bookings),
        **ex.summary(),
    }
    if wave.bookings:  # one representative what-if; every booking is checked again for real
        b = wave.bookings[0]
        check = run.br.simulate_work(run.actor, b.kind, b.target)
        run.last_check = check.verdict
        out["sample_check"] = {"target": b.target, "verdict": check.verdict, "reason": check.reason}
    else:
        run.last_check = "deny"
    return out


def _book_wave(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    adv, fleet, parked = _ctx(run)
    wave = run.extra.get("wave")
    if wave is None or not wave.bookings:
        return {"ok": False, "verdict": "deny", "reason": "No wave to book: check_wave found nothing that can be patched now."}
    res = book_wave(adv, wave, run.br, run.actor, args.get("note", ""))
    parked.update(res.parked)
    run.extra.setdefault("waits", []).extend(res.waits)
    run.extra["booked"] = run.extra.get("booked", 0) + len(res.granted)
    until = max((g["until"] for g in res.granted), default=None)
    out: dict[str, Any] = {
        "ok": bool(res.granted),
        "granted": len(res.granted),
        "refused": len(res.refused),
        "halted": res.halted,
        "parked_for": sorted(set(res.parked.values())),
        "wave_ends": fmt_time(until) if until is not None else None,
        "refusals": res.refused[:3],
    }
    if not res.granted:
        out["verdict"] = res.refused[0]["verdict"] if res.refused else "deny"
    return out


def _owners_to_tell(run: Run) -> list[str]:
    told = run.extra.get("told", set())
    return [o for o in run.facts.get("owners", []) if o not in told]


def _notify_owners(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    owners = _owners_to_tell(run)
    for o in owners:
        run.br.notify(run.actor, recipient(o), run.issue.subject, args["message"])
        run.extra.setdefault("told", set()).add(o)
    return {"ok": True, "told": owners}


def _notify_shift_lead(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    run.br.notify(run.actor, SHIFT_LEAD, run.issue.subject, args["message"])
    run.extra.setdefault("told", set()).add(SHIFT_LEAD)
    return {"ok": True}


def _keep_waiting(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    waits: list[Blocker] = list(run.extra.get("waits", []))
    if not waits:  # nothing booked to wait for (the reserve is used up elsewhere): look again in an hour
        waits = [Blocker("lease_ends", "recheck", run.br.now + 60)]
    run.status, run.blockers = "waiting", tuple(dict.fromkeys(waits))
    run.summary = args.get("note") or "Next wave after this one's windows end."
    return {"ok": True, "reason": "Queued until the current wave ends."}


def _must_tell_lead(run: Run) -> bool:
    """Urgent advisories, and targets Squawk refused for a running job (draining it is a person's call)."""
    if SHIFT_LEAD in run.extra.get("told", set()):
        return False
    return bool(run.facts.get("tell_shift_lead")) or any(o.startswith("job-") for o in run.extra["parked"].values())


def _after_check(run: Run) -> str | None:
    if "check_wave" not in run.done:
        return "only after check_wave"
    if _owners_to_tell(run):
        return "only after notify_owners (their nodes wait for them)"
    if _must_tell_lead(run):
        return "only after notify_shift_lead (urgent, or a running job holds targets)"
    return None


TOOLS: dict[str, Tool] = {
    **{
        t.name: t
        for t in (
            Tool(
                "check_wave",
                "Work out the next wave for this advisory (code picks the targets: canary first, spare reserve kept) and what-if check it with Squawk.",
                _check_wave,
                {"size": {"type": "integer", "minimum": 1, "maximum": MAX_WAVE, "description": f"Most targets in this wave, 1 to {MAX_WAVE}. The first wave is a canary however large you ask."}},
            ),
            Tool(
                "book_wave",
                "Book the checked wave's patch windows with Squawk. Each booking is checked; refused ones are reported, not retried.",
                _book_wave,
                {"note": text_param("One line for the work note.")},
                acts=True,
                needs=("check_wave",),
            ),
            Tool(
                "notify_owners",
                "Tell the jobs' scheduler and the tenants whose nodes still run the vulnerable version that their nodes wait for them (drain or a maintenance window).",
                _notify_owners,
                {"message": text_param("One or two plain sentences: what's vulnerable, and what they need to do.")},
                ("message",),
                acts=True,
                offered=lambda run: bool(_owners_to_tell(run)),
            ),
            Tool(
                "notify_shift_lead",
                "Tell the shift lead about this advisory: urgent ones, and anything that needs a person (draining a job, a tenant window).",
                _notify_shift_lead,
                {"message": text_param("One or two plain sentences naming the advisory, its severity and what's left.")},
                ("message",),
                acts=True,
                offered=lambda run: SHIFT_LEAD not in run.extra.get("told", set()),
            ),
            Tool(
                "keep_waiting",
                "End this run until the wave's windows end (or a job finishes); the next wave is checked then. Only after check_wave.",
                _keep_waiting,
                {"note": text_param("One line on what it waits for.")},
                gate=_after_check,
            ),
        )
    },
    **COMMON_TOOLS,
}


def _verify(run: Run) -> str | None:
    """'finish' means the fleet is done for now: nothing left that can be patched without its owner."""
    adv, fleet, parked = _ctx(run)
    if _must_tell_lead(run):
        return "the shift lead wasn't told"
    if _owners_to_tell(run):
        return f"{', '.join(_owners_to_tell(run))} weren't told"
    ex: Exposure = exposure(adv, fleet, run.br, parked)
    if ex.ready:
        return f"{len(ex.ready)} {COMPONENTS[adv.component].label} targets can still be patched (keep_waiting for the next wave instead)"
    jobs = [o for o in ex.held if o.startswith("job-")]
    if jobs:
        return f"nodes of {', '.join(jobs)} still wait for it to finish (keep_waiting instead)"
    return None


PLAYBOOKS: dict[str, Playbook] = {
    "vulnerable_software": Playbook(
        "vulnerable_software",
        "A security advisory affects software in the hall. Roll its fix out without causing an outage.\n"
        "Each run handles one wave: check_wave (code picks the targets: a small canary first, then larger waves, always "
        "keeping enough free spares to restart a failed job), then book_wave. Squawk refuses anything that would take a "
        "running job's or a working tenant's nodes, so those are left to their owners: tell them once with notify_owners. "
        "If the advisory is urgent (critical or exploited) or needs a person, tell the shift lead once with notify_shift_lead.\n"
        "Done means: end with keep_waiting while targets remain (the next wave follows when this one's windows end), "
        "or finish once nothing is left that can be patched without its owner.",
        ("check_wave", "book_wave", "notify_owners", "notify_shift_lead", "keep_waiting", "escalate", "finish"),
        ("check_wave",),  # who must be told is enforced by keep_waiting's gate and the done check
        frozenset({"notify_owners", "notify_shift_lead", "keep_waiting", "escalate"}),
        _verify,
    ),
}


JOB_PREFIX = "scheduler for "


def recipient(owner: str) -> str:
    """A job's nodes are its scheduler's to drain; a tenant is told directly."""
    return JOB_PREFIX + owner if owner.startswith("job-") else owner


def told(e, actor: str, advisory_id: str) -> str | None:
    """The owner (or shift lead) one of our notified rows told about an advisory, if it is one."""
    if e.type != "notified" or e.actor != actor or e.subject != advisory_id:
        return None
    to = str(e.data.get("to", ""))
    return to[len(JOB_PREFIX):] if to.startswith(JOB_PREFIX) else to


__all__ = ["PLAYBOOKS", "TOOLS", "events_by", "recipient", "told"]
