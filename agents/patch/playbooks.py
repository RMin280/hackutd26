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
from .fleet import COMPONENTS, Advisory, Fleet, patch_note
from .rollout import MAX_WAVE, Exposure, book_wave, exposure, plan_wave
from .triage import MAX_ATTEMPTS

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


# ---------------------------------------------------------------- a failed install
#
# Code has already held the target out of service (a hold window) and halted the advisory's
# rollout. The model reads the check, then picks: retry once, roll back to the old version, or
# hand off. Code fixes the target, both versions and the number of tries; Squawk checks the window.

HOLD_MIN = 120  # how long a failed target is held out of service while it waits for a decision


def _fail_ctx(run: Run) -> tuple[Advisory, Fleet, str, str, str]:
    x = run.extra
    return x["advisory"], x["fleet"], x["component"], x["target"], x["version"]


def _check_target(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    adv, fleet, component, target, version = _fail_ctx(run)
    comp = COMPONENTS[component]
    tries = fleet.attempt(component, target, version)
    head = f"{target}: {comp.label} {version} failed after attempt {tries} of {MAX_ATTEMPTS}"
    out: dict[str, Any] = {
        "target": target,
        "attempts_used": tries,
        "retry_allowed": tries < MAX_ATTEMPTS,
        "rollback_to": run.facts["previous_version"],
    }
    if run.extra.get("hold"):  # our own hold would make any what-if overlap; the swap is checked when it's booked
        until = fmt_time(run.extra["hold_until"])
        out.update(held_until=until, reason=f"{head}; held out of service until {until}. A retry or rollback replaces the hold, and Squawk checks that window.")
        return out
    check = run.br.simulate_work(run.actor, comp.kind, target)
    run.last_check = check.verdict
    out.update(window_verdict=check.verdict, reason=f"{head}; a new window would be {check.verdict}: {check.reason}")
    return out


def _rebook(run: Run, note: str, why: str) -> dict[str, Any]:
    """Swap the hold for a real window, right away so the target is never free in between.
    A refused window puts the hold back."""
    adv, fleet, component, target, version = _fail_ctx(run)
    comp = COMPONENTS[component]
    hold = run.extra.get("hold")
    if hold:
        run.br.release_lease(run.actor, hold, why)
        run.extra["hold"] = None
    d = run.br.request_work(run.actor, comp.kind, target, minutes=comp.minutes, note=note)
    if not d.granted or not d.lease:
        if comp.scope == "node":
            back = run.br.request_work(run.actor, comp.kind, target, minutes=HOLD_MIN, note=patch_note(adv, component, version, "kept out of service after a failed install", kind="hold"))
            run.extra["hold"] = back.lease.id if back.granted and back.lease else None
        return {"ok": False, "granted": False, "verdict": d.verdict, "reason": d.reason, "earliest_safe": d.earliest_safe}
    run.extra["waits"] = [Blocker("lease_ends", d.lease.id, d.lease.end)]
    run.extra["booked_fix"] = True
    return {"ok": True, "granted": True, "lease": d.lease.id, "window_ends": fmt_time(d.lease.end), "reason": d.reason}


def _retry_patch(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    adv, fleet, component, target, version = _fail_ctx(run)
    out = _rebook(run, patch_note(adv, component, version, args.get("note", "")), "retrying the install")
    run.extra["chose"] = "retry"
    return out


def _roll_back(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    adv, fleet, component, target, version = _fail_ctx(run)
    out = _rebook(run, patch_note(adv, component, run.facts["previous_version"], args.get("note", ""), kind="rollback"), "rolling back")
    run.extra["chose"] = "rollback"
    return out


def _tell_lead_about_failure(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    run.br.notify(run.actor, SHIFT_LEAD, run.issue.subject, args["message"])
    run.extra["lead_told"] = True
    return {"ok": True}


def _lead_needed(run: Run) -> bool:
    """A failed canary, and any rollback, is the shift lead's to know about."""
    if run.extra.get("lead_told") or run.facts.get("shift_lead_told"):
        return False
    return bool(run.facts.get("canary")) or run.extra.get("chose") == "rollback"


def _wait_for_fix(run: Run, args: dict[str, Any]) -> dict[str, Any]:
    run.status, run.blockers = "waiting", tuple(run.extra["waits"])
    run.summary = args.get("note") or "Checked again when the window ends."
    return {"ok": True, "reason": "Checked again when the window ends."}


def _after_fix_booked(run: Run) -> str | None:
    if not run.extra.get("booked_fix"):
        return "only after retry_patch or roll_back booked a window"
    if _lead_needed(run):
        return "only after notify_shift_lead (a failed canary or a rollback)"
    return None


FAILURE_TOOLS: dict[str, Tool] = {
    **{
        t.name: t
        for t in (
            Tool(
                "check_target",
                "Read where the failed target stands: tries used and left, the version a rollback restores, and Squawk's verdict on a new window.",
                _check_target,
            ),
            Tool(
                "retry_patch",
                f"Install the same fix on the same target again, in a new window checked by Squawk. At most {MAX_ATTEMPTS} tries per target.",
                _retry_patch,
                {"note": text_param("One line for the work note: why a retry should work.")},
                acts=True,
                needs=("check_target",),
                gate=lambda run: None if run.extra["fleet"].attempt(run.extra["component"], run.extra["target"], run.extra["version"]) < MAX_ATTEMPTS else f"only within {MAX_ATTEMPTS} tries (they're used up: roll back or escalate)",
            ),
            Tool(
                "roll_back",
                "Put the version the target ran before back on, in a window checked by Squawk. The target works again but stays exposed to the advisory until a person plans the fix.",
                _roll_back,
                {"note": text_param("One line for the work note.")},
                acts=True,
                needs=("check_target",),
            ),
            Tool(
                "notify_shift_lead",
                "Tell the shift lead about this failure: required for a failed canary and for any rollback.",
                _tell_lead_about_failure,
                {"message": text_param("One or two plain sentences: which target, what failed, and what you did.")},
                ("message",),
                acts=True,
                offered=lambda run: not run.facts.get("shift_lead_told"),
            ),
            Tool(
                "keep_waiting",
                "End this run until the retry or rollback window ends; code checks the result then.",
                _wait_for_fix,
                {"note": text_param("One line on what it waits for.")},
                gate=_after_fix_booked,
            ),
        )
    },
    "escalate": COMMON_TOOLS["escalate"],
}

PLAYBOOKS["patch_failed"] = Playbook(
    "patch_failed",
    "A patch window ended and the post-install check failed on one target. Code has already held it out of service "
    "and halted the advisory's rollout. Decide what to do with that one target: check_target first, then either "
    f"retry_patch (same fix again; at most {MAX_ATTEMPTS} tries per target, so only when retry_allowed is true and the "
    "symptom looks like it could pass a second time) or roll_back (back to the version it ran before: it works again but "
    "stays exposed to the advisory). Tell the shift lead with notify_shift_lead if this was the canary wave or you roll back. "
    "Done means: end with keep_waiting once a retry or rollback window is booked (code checks the result when it ends), "
    "or escalate if neither fits.",
    ("check_target", "retry_patch", "roll_back", "notify_shift_lead", "keep_waiting", "escalate"),
    ("check_target",),
    frozenset({"roll_back", "notify_shift_lead", "keep_waiting", "escalate"}),  # keep_waiting still needs a booked window
    lambda run: "a retry or rollback still has to be booked and checked",
)


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


__all__ = ["FAILURE_TOOLS", "HOLD_MIN", "PLAYBOOKS", "TOOLS", "events_by", "recipient", "told"]
