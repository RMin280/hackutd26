"""Vulnerability watch: which advisories need the update agent now. Code only, no model.

An advisory becomes an issue when some of the hall still runs a version older than its fix
and something can be done: a target is ready to patch, or an owner or the shift lead
hasn't been told yet. Advisories for software we have no patch procedure for go to a
person. The advisory's own text is untrusted and only ever reaches the model fenced.
"""

from __future__ import annotations

from ..common.issues import Handoff, Issue, Triaged
from ..squawk import Squawk
from .fleet import COMPONENTS, Advisory, Fleet, describe
from .rollout import exposure, room_for_spares, spare_reserve

UPDATER = "update-agent"
SHIFT_LEAD = "shift lead"


def triage(adv: Advisory, fleet: Fleet, br: Squawk, parked: dict[str, str], told: set[str]) -> Triaged | None:
    unknown = [c for c in (adv.component, *adv.requires) if c not in COMPONENTS]
    if unknown:
        return Handoff(adv.id, SHIFT_LEAD, f"{adv.id} ({adv.severity}) needs {', '.join(unknown)}, which has no patch procedure here; a person plans it.")
    comp = COMPONENTS[adv.component]
    ex = exposure(adv, fleet, br, parked)
    if ex.total == 0:
        return None  # patched, or every window is booked
    owners = sorted(o for o in {*ex.held, *ex.parked} if o not in told)
    needs_person = any(o.startswith("job-") for o in {*ex.held, *ex.parked}) or bool(ex.parked)
    tell_lead = SHIFT_LEAD not in told and (adv.urgent or needs_person)
    if not owners and not tell_lead and (not ex.ready or (comp.scope == "node" and room_for_spares(br) <= 0)):
        return None  # nothing to do until an owner frees its nodes or spares come back above the reserve
    rows = sorted(fleet.affected_rows(adv))
    reason = (
        f"{adv.id} ({adv.severity}, CVSS {adv.cvss}{', exploited' if adv.exploited else ''}) leaves {ex.total} {comp.label} "
        f"targets in rows {', '.join(map(str, rows))} on versions older than {adv.fixed}: {len(ex.ready)} can be patched "
        f"now without touching a job or tenant"
        + (f"; {sum(ex.held.values()) + sum(ex.parked.values())} wait for their owners" if ex.held or ex.parked else "")
        + "."
    )
    facts = {
        **describe(adv),
        "rows": rows,
        **ex.summary(),
        "free_spares": len(br.free_spares()) if comp.scope == "node" else None,
        "spare_reserve": spare_reserve() if comp.scope == "node" else None,
        "owners": owners,  # not yet told
        "tell_shift_lead": tell_lead,
        "shift_lead_told": SHIFT_LEAD in told,
        "urgent": adv.urgent,
    }
    note = f"{adv.title}\n{adv.summary}".strip()
    return Issue(f"vulnerable_software:{adv.id}:{br.now}", "vulnerable_software", adv.id, br.now, reason, facts, untrusted_note=note)


# ---------------------------------------------------------------- a failed install

MAX_ATTEMPTS = 2  # windows per target and version: the first try and one retry; then roll back


def row_of(target: str, br: Squawk) -> int:
    """The row a target (node, row-N or sw-leaf-rN) sits in."""
    if target.startswith("row-"):
        return int(target[4:])
    if target.startswith("sw-leaf-r"):
        return int(target[9:])
    return br.node(target).row


def triage_failure(adv: Advisory, fleet: Fleet, br: Squawk, component: str, target: str, *, lead_told: bool, others: int) -> Issue:
    """A patch window ended with the post-install check failing. Always an issue: the target is
    held out of service and this advisory's rollout is halted until it is resolved. Code fixes the
    target, the versions and how many tries are left; the model picks retry, roll back or hand off."""
    comp = COMPONENTS[component]
    version = {adv.component: adv.fixed, **adv.requires}[component]
    tries = fleet.attempt(component, target, version)
    previous = fleet.baseline.get(component, {}).get(row_of(target, br), "0")
    canary = fleet.canary(component, version, target)
    reason = (
        f"{comp.label} {version} failed its post-install check on {target} (attempt {tries} of {MAX_ATTEMPTS})"
        + (", in the canary wave" if canary else "")
        + f". {target} is held out of service and the rollout of {adv.id} is halted until this is resolved."
    )
    facts = {
        **describe(adv),
        "target": target,
        "failed_component": comp.label,
        "version_tried": version,
        "previous_version": previous,
        "attempts_used": tries,
        "max_attempts": MAX_ATTEMPTS,
        "retry_allowed": tries < MAX_ATTEMPTS,
        "canary": canary,
        "other_failed_or_rolled_back": others,
        "rollout_halted": True,
        "held_out_of_service": comp.scope == "node",
        "shift_lead_told": lead_told,
        "must_tell_shift_lead": not lead_told and (canary or tries >= MAX_ATTEMPTS),
    }
    note = fleet.symptom(component, target, version)
    return Issue(f"patch_failed:{target}:{version}:{tries}", "patch_failed", target, br.now, reason, facts, untrusted_note=note)
