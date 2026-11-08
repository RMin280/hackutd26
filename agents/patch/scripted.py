"""The update agent's scripted stand-in for Nemotron: a fixed plan and policy, for the tests
and `python -m agents.patch --scripted` (no model requests)."""

from __future__ import annotations

from typing import Any

from ..common.scripted import Done, Step, called, last, step
from ..common.scripted import ScriptedModel as _ScriptedModel


def _plan(f: dict[str, Any]) -> list[dict[str, str]]:
    steps = [
        step("check_wave", "See which targets code picks for the next wave, and what Squawk says."),
        step("book_wave", "Patch what's safe now.", "if the wave has targets"),
    ]
    if f.get("owners"):
        steps.append(step("notify_owners", "Their nodes wait for them to drain or open a window."))
    if not f.get("shift_lead_told"):
        steps.append(step("notify_shift_lead", "Urgent, or a running job holds targets.", "" if f.get("tell_shift_lead") else "if Squawk refuses targets for a running job"))
    return steps + [
        step("keep_waiting", "More waves follow once this one's windows end.", "if targets remain"),
        step("finish", "Nothing left that can be patched without its owner.", "if nothing remains"),
    ]


def _policy(f: dict[str, Any], done: Done) -> Step:
    if "check_wave" not in called(done):
        return "check_wave", {"size": 8}
    w = last(done, "check_wave")
    if w.get("wave_targets") and "book_wave" not in called(done):
        return "book_wave", {"note": f"Rolling wave for {f['advisory']}."}
    held = {**(w.get("held_by_owners") or {}), **(w.get("refused_for_owners") or {})}
    if f.get("owners") and "notify_owners" not in called(done):
        return "notify_owners", {
            "message": f"{f['advisory']} ({f['severity']}): your nodes run a {f['component']} older than {f['fixed_in']}. "
            "Squawk keeps them out of the rollout until you drain them or open a maintenance window."
        }
    booked = last(done, "book_wave") or {}
    job_blocked = [o for o in booked.get("parked_for", []) if o.startswith("job-")]
    if (f.get("tell_shift_lead") or job_blocked) and "notify_shift_lead" not in called(done):
        waiting = f"; {sum(held.values())} targets wait for their owners" if held else ""
        if job_blocked:
            waiting += f"; {', '.join(job_blocked)} must finish or be drained before the rest"
        return "notify_shift_lead", {
            "message": f"{f['advisory']} ({f['severity']}, CVSS {f['cvss']}): rolling {f['component']} {f['fixed_in']} out in waves, canary first{waiting}."
        }
    remaining = (w.get("ready_now") or 0) - (w.get("wave_targets") or 0)
    if remaining > 0 or any(o.startswith("job-") for o in held) or job_blocked or booked.get("granted"):
        return "keep_waiting", {"note": f"{max(remaining, 0)} more ready after this wave."}
    return "finish", {"summary": f"{f['advisory']}: nothing left that can be patched without its owner; owners and the shift lead know."}


class ScriptedModel(_ScriptedModel):
    def __init__(self) -> None:
        super().__init__({"vulnerable_software": _plan}, {"vulnerable_software": _policy})
