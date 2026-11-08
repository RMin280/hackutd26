"""Deterministic triage for the dependency agent: when our own tests change a feature's
state, decide whether the agent works it or a person gets it straight away.

Code decides this, never the model. Reads touch only the feature and the racks below
the parts it reports on: one issue per feature, however many parts it covers.
"""

from __future__ import annotations

from ..squawk import Squawk, Event, FeatureView, fmt_time, label
from ..common.issues import Handoff, Issue, Triaged

DEPENDENCY = "dependency-agent"
FLAP_WINDOW = 30  # a feature failing again this soon after recovering goes to a person
KINDS = ("paging_degraded", "cooling_readings_stale", "revocation_stale", "dependency_recovered")


def triage(event: Event, br: Squawk, actor: str = DEPENDENCY) -> list[Triaged]:
    if event.type != "feature_state":
        return []
    f = br.feature(event.subject)
    if event.data.get("state") == "degraded":
        return _degraded(event, f, br)
    if event.data.get("state") == "working" and event.data.get("previous") == "degraded":
        return [
            Issue(
                id=f"dependency_recovered:{f.id}:{event.seq}",
                kind="dependency_recovered",
                subject=f.id,
                opened_at=event.time,
                reason=f"{f.name}: the test passes again (degraded since {_when(event.data.get('previous_since'))}).",
                facts={**_facts(f, event), "degraded_since": _when(event.data.get("previous_since"))},
            )
        ]
    return []


def _degraded(event: Event, f: FeatureView, br: Squawk) -> list[Triaged]:
    if f.recovered_at is not None and event.time - f.recovered_at < FLAP_WINDOW:
        return [Handoff(f.id, "shift lead", f"Not for the agent: {f.name} failed again {event.time - f.recovered_at} min after recovering, so it's flapping. {event.reason}")]
    facts = _facts(f, event)

    if f.id == "paging.text":
        if br.feature("paging.email").state == "degraded":
            return [Handoff(f.id, "shift lead", f"No working paging channel: text and email paging are both down. {event.reason}")]
        return [
            Issue(
                id=f"paging_degraded:{f.id}:{event.seq}",
                kind="paging_degraded",
                subject=f.id,
                opened_at=event.time,
                reason=f"{f.name} is failing while the paging service says it's {f.service_says}. Email paging works, so pages sent by text since the last good test can be re-sent.",
                facts={**facts, "fallback": "email paging works; Squawk already sends new pages by email"},
            )
        ]
    if f.id == "paging.email":
        return [Handoff(f.id, "shift lead", f"Email paging, the fallback, is down; text paging still works. {event.reason}")]

    if f.id.startswith("bms.cooling."):
        below = dict.fromkeys(r for part in f.covers for r in br.racks_below(part))
        blind = [r for r in below if br.rack(r).level != "green"]
        return [
            Issue(
                id=f"cooling_readings_stale:{f.id}:{event.seq}",
                kind="cooling_readings_stale",
                subject=f.id,
                opened_at=event.time,
                reason=(
                    f"{f.name} went stale while the building management system says it's {f.service_says}. Squawk now treats "
                    f"{label(f.covers[0])} to {label(f.covers[-1])} as unknown, so {len(blind)} racks can't confirm their backup. "
                    "The agent gathers the facts and hands it to the shift lead."
                ),
                facts={
                    **facts,
                    "gateway": f.needs[0],
                    "gateway_name": label(f.needs[0]),
                    "cdus": f"{label(f.covers[0])} to {label(f.covers[-1])}",
                    "racks_without_confirmed_backup": len(blind),
                },
            )
        ]

    if f.id == "keys.revocation":
        return [
            Issue(
                id=f"revocation_stale:{f.id}:{event.seq}",
                kind="revocation_stale",
                subject=f.id,
                opened_at=event.time,
                reason=(
                    f"The key service says it's {f.service_says}, but its revoked-key list is out of date, so a revoked key might still work. "
                    "Squawk is failing closed: facility changes need a shift lead until it's current. Security always goes to a person."
                ),
                facts=facts,
            )
        ]

    return [Handoff(f.id, "shift lead", f"{f.name} is degraded and no playbook covers it. {event.reason}")]


def _facts(f: FeatureView, event: Event) -> dict:
    return {
        "feature": f.id,
        "name": f.name,
        "service": f.service,
        "service_says": f.service_says,
        "test_result": event.reason,
        "last_good_test": _when(f.last_good),
        "last_good_minute": f.last_good,
        "used_by": list(f.used_by),
    }


def _when(minute: int | None) -> str:
    return fmt_time(minute) if minute is not None else "never"
