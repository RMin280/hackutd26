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
