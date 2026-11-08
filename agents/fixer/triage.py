"""Deterministic triage: which events are low-criticality issues the fixer agent may fix on
its own, which go to a person (or the scheduler agent), and which need nothing.

The model never decides this. Low means every rack keeps full backup, nothing in a
running job is touched, and (checked again per action) Squawk allows every action.
Reads here touch only the event's own node, rack, part or job: no facility-wide scans.
"""

from __future__ import annotations

from ..squawk import Squawk, Blocker, Event, fmt_time, label
from ..common.issues import Handoff, Issue, Triaged

__all__ = ["FIXER", "KINDS", "Handoff", "Issue", "Triaged", "triage"]

FIXER = "fixer-agent"
FLAP_WINDOW = 24 * 60  # a node failing twice in this window goes to a person
REQUEUE_DEADLINE = 24 * 60  # a re-queued routine request gives up after this long

KINDS = ("broken_node", "node_repaired", "maintenance_refused", "stale_protection")


def triage(event: Event, br: Squawk, fixer: str = FIXER) -> list[Triaged]:
    if event.actor == fixer:
        return []  # never react to our own actions
    if event.type == "state_change" and event.data.get("kind") == "node":
        return _node_change(event, br, fixer)
    if event.type == "state_change" and event.data.get("kind") == "part":
        return _part_change(event, br)
    if event.type == "lease_denied":
        return _lease_denied(event)
    if event.type == "job_status" and event.data.get("status") == "finished":
        return _job_finished(event, br)
    return []


def _node_change(event: Event, br: Squawk, fixer: str) -> list[Triaged]:
    node = br.node(event.subject)
    state = event.data.get("state")

    if state in ("failed", "degraded"):
        if any(lease.actor == fixer for lease in br.leases_on(node.id)):
            return []  # already out of service under our lease (e.g. replaying the feed after a restart)
        if node.owner.kind == "job":
            return [Handoff(node.id, "scheduler agent", f"Not low: {node.id} runs {node.owner.id}, so the scheduler agent's diagnose, place and protect flow handles it.")]
        if node.owner.kind == "tenant" and state == "degraded":
            return [Handoff(node.id, "shift lead", f"Not low: {node.id} is degraded but still running {node.owner.id}'s work; repairing it would interrupt them.")]
        diagnosis = br.diagnose_failure(node.id)
        if diagnosis.classification != "isolated":
            return [Handoff(node.id, "shift lead", f"Not low: {diagnosis.reason}")]
        rack = br.rack(node.rack)
        if rack.level != "green":
            return [Handoff(node.id, "shift lead", f"Not low: {node.rack} is below full backup. {rack.reason}")]
        if rack.protected_by:
            return [Handoff(node.id, "shift lead", f"Not low: {node.rack} is protected for a running job ({', '.join(rack.protected_by)}).")]
        whose = "a free spare" if node.owner.kind == "free" else f"{node.owner.id}'s node"
        return [
            Issue(
                id=f"broken_node:{node.id}:{event.seq}",
                kind="broken_node",
                subject=node.id,
                opened_at=event.time,
                reason=f"Low: {node.id} is {whose}, nothing above it is unhealthy, no recent failure shares its PDU, CDU or leaf, and {node.rack} has full backup.",
                facts={
                    "node": node.id,
                    "state": state,
                    "rack": node.rack,
                    "row": node.row,
                    "owner": whose,
                    "tenant": node.owner.id if node.owner.kind == "tenant" else None,
                    "rack_backup": rack.reason,
                    "diagnosis": diagnosis.reason,
                },
                untrusted_note=str(event.data.get("note") or ""),
            )
        ]

    if state == "ok":
        ours = [lease for lease in br.leases_on(node.id) if lease.actor == fixer]
        if not ours:
            return []
        failures = br.failures_since(node.id, event.time - FLAP_WINDOW)
        if failures >= 2:
            return [Handoff(node.id, "shift lead", f"Not low: {node.id} failed {failures} times in 24 h, which points at bad hardware; a person decides on replacement.")]
        rack = br.rack(node.rack)
        if rack.level != "green":
            return [Handoff(node.id, "shift lead", f"Not low: {node.id} is repaired but {node.rack} is below full backup. {rack.reason}")]
        return [
            Issue(
                id=f"node_repaired:{node.id}:{event.seq}",
                kind="node_repaired",
                subject=node.id,
                opened_at=event.time,
                reason=f"Low: {node.id} reports ok again after a repair under {ours[0].id}, {'failed once' if failures else 'had no failures'} in 24 h, and {node.rack} has full backup.",
                facts={
                    "node": node.id,
                    "rack": node.rack,
                    "lease": ours[0].id,
                    "lease_ends": fmt_time(ours[0].end),
                    "failures_last_24h": failures,
                    "rack_backup": rack.reason,
                },
                untrusted_note=str(event.data.get("note") or ""),
            )
        ]
    return []


def _part_change(event: Event, br: Squawk) -> list[Triaged]:
    state = event.data.get("state")
    if state not in ("degraded", "failed"):
        return []
    levels = [br.rack(r).level for r in br.racks_below(event.subject)]
    yellow, red = levels.count("yellow"), levels.count("red")
    impact = f"{yellow} racks one failure from an outage" + (f", {red} with no working feed" if red else "")
    return [Handoff(event.subject, "shift lead", f"Not low: {label(event.subject)} is {state}, leaving {impact}.")]


def _lease_denied(event: Event) -> list[Triaged]:
    d = event.data
    if not d.get("routine") or d.get("verdict") != "deny":
        return []  # urgent requests, and warns waiting on a shift lead, stay with the requester
    blockers = tuple(Blocker(**b) for b in d.get("blockers") or ())
    if not blockers:
        return [Handoff(event.subject, "shift lead", f"Not low: {event.actor}'s routine request was refused with nothing to wait for. {event.reason}")]
    target = d["target"]
    return [
        Issue(
            id=f"maintenance_refused:{target}:{event.seq}",
            kind="maintenance_refused",
            subject=target,
            opened_at=event.time,
            reason=f"Low: a routine request from {event.actor} was refused, but only for now (earliest safe: {d.get('earliest_safe')}); nothing is broken by waiting.",
            facts={
                "requester": event.actor,
                "target": target,
                "minutes": d.get("minutes"),
                "refused_at": fmt_time(event.time),
                "refused_because": event.reason,
                "earliest_safe": d.get("earliest_safe"),
            },
            untrusted_note=str(d.get("note") or ""),
            blockers=blockers,
            deadline=event.time + REQUEUE_DEADLINE,
        )
    ]


def _job_finished(event: Event, br: Squawk) -> list[Triaged]:
    job = br.job(event.subject)
    return [
        Issue(
            id=f"stale_protection:{lease.id}:{event.seq}",
            kind="stale_protection",
            subject=lease.id,
            opened_at=event.time,
            reason=f"Low: {job.id} finished at {fmt_time(job.since)}, but {lease.id} still locks {len(lease.racks)} racks until {fmt_time(lease.end)}, blocking maintenance for nothing.",
            facts={
                "lease": lease.id,
                "holder": lease.actor,
                "job": job.id,
                "job_status": job.status,
                "finished_at": fmt_time(job.since),
                "racks_locked": len(lease.racks),
                "lock_ends": fmt_time(lease.end),
            },
        )
        for lease in br.protection_leases(job.id)
    ]
