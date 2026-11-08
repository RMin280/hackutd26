"""Rolling a fix out in waves. Code picks every target; the model picks only the wave size
(within bounds) and the wording. Squawk checks every booking.

Rules that keep a patch from becoming the outage:
- Canary first: the first wave of an advisory is tiny (2 nodes, 1 row, 1 switch). Later
  waves wait until the previous wave's windows have ended.
- Spare reserve: a node-level wave never takes the hall's free healthy spares below
  PATCH_SPARE_RESERVE (default 40, the demo job's restart needs 40). A job that fails mid-rollout
  can always be re-placed.
- Owners first: nodes a job or tenant holds aren't waved at all. A running job's nodes wait
  for it to finish (or a person decides to drain); a tenant's wait for the tenant's window.
- Halt on refusal: a wave stops at the first booking refused because of another window;
  the rest of it waits for the next wave instead of flooding the feed with the same refusal.
- Prerequisites in order: when the fix needs another component first (driver needs BMC
  firmware), each node gets the prerequisite window, then the fix right after it, booked as
  two checked requests, so they never overlap.

Reads per wave: one query for free spares and one per affected row; never a hall scan.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

from ..squawk import Blocker, Squawk
from .fleet import CANARY_SIZE, COMPONENTS, Advisory, Fleet, older, patch_note

def spare_reserve() -> int:
    """Free healthy spares a node-level wave never dips below (PATCH_SPARE_RESERVE)."""
    return max(0, int(os.getenv("PATCH_SPARE_RESERVE", "40")))


MAX_WAVE = 16
CANARY = CANARY_SIZE
APPROVAL = "shift lead approval"  # parked owner for a request that came back warn


@dataclass(frozen=True)
class Booking:
    kind: str
    target: str
    component: str
    version: str
    start_in: int
    minutes: int
    row: int


@dataclass
class Exposure:
    """Where an advisory stands right now."""

    ready: list[tuple[str, int]]  # (target, row) that could be patched now, in order
    held: dict[str, int]  # owner (job or tenant) -> nodes or targets it holds back
    under_repair: int = 0
    parked: dict[str, int] = field(default_factory=dict)  # owner -> targets Squawk refused for them
    scheduled: int = 0  # targets with a patch window booked (done, running or to come)
    failed: list[str] = field(default_factory=list)  # the install failed: the failure's own run handles them
    rolled_back: list[str] = field(default_factory=list)  # back on the old version, left for a person
    total: int = 0  # vulnerable targets left, including held, parked, failed and rolled back

    def summary(self) -> dict[str, Any]:
        return {
            "ready_now": len(self.ready),
            "held_by_owners": dict(self.held),
            "refused_for_owners": dict(self.parked),
            "under_repair": self.under_repair,
            "already_scheduled": self.scheduled,
            "failed_installs": len(self.failed),
            "rolled_back": len(self.rolled_back),
            "still_vulnerable": self.total,
        }


def target_for(scope: str, row: int, node: str = "") -> str:
    return node if scope == "node" else f"row-{row}" if scope == "row" else f"sw-leaf-r{row}"


def exposure(adv: Advisory, fleet: Fleet, br: Squawk, parked: dict[str, str] | None = None) -> Exposure:
    """What's vulnerable, by version group; node-level groups are read one row at a time."""
    comp, now, parked = COMPONENTS[adv.component], br.now, parked or {}
    ex = Exposure([], {})
    for row in fleet.affected_rows(adv):
        if comp.scope != "node":
            t = target_for(comp.scope, row)
            if not older(fleet.version(adv.component, row, t, now), adv.fixed):
                continue
            ex.total += 1
            if _broken(adv, fleet, t, now, ex):
                pass
            elif fleet.scheduled(adv.component, t):
                ex.scheduled += 1
            elif t in parked:
                ex.parked[parked[t]] = ex.parked.get(parked[t], 0) + 1
            else:
                ex.ready.append((t, row))
            continue
        for n in br.nodes_in_row(row):
            if not older(fleet.version(adv.component, row, n.id, now), adv.fixed):
                continue
            ex.total += 1
            if _broken(adv, fleet, n.id, now, ex):
                pass
            elif fleet.scheduled(adv.component, n.id):
                ex.scheduled += 1
            elif n.owner.kind != "free":
                ex.held[n.owner.id] = ex.held.get(n.owner.id, 0) + 1
            elif n.state != "ok":
                ex.under_repair += 1
            elif n.id in parked:
                ex.parked[parked[n.id]] = ex.parked.get(parked[n.id], 0) + 1
            else:
                ex.ready.append((n.id, row))
    ex.total -= ex.scheduled
    return ex


def _broken(adv: Advisory, fleet: Fleet, target: str, now: int, ex: Exposure) -> bool:
    """A failed or rolled-back target is never waved again: counted apart, still vulnerable."""
    st = fleet.broken(adv, target, now)
    if st is None:
        return False
    (ex.rolled_back if st == "rolled_back" else ex.failed).append(target)
    return True


def room_for_spares(br: Squawk) -> int:
    """Free healthy spares above the reserve: how many nodes a wave may take right now."""
    return len(br.free_spares()) - spare_reserve()


@dataclass
class Wave:
    bookings: list[Booking]
    targets: list[str]
    limit_reason: str  # what capped the wave, in a line
    canary: bool


def plan_wave(adv: Advisory, fleet: Fleet, br: Squawk, size: int, ex: Exposure) -> Wave:
    comp = COMPONENTS[adv.component]
    canary = fleet.booked(adv.component, adv.fixed) == 0
    cap = max(1, min(int(size), MAX_WAVE))
    why = f"wave size {cap}"
    if canary and cap > CANARY[comp.scope]:
        cap, why = CANARY[comp.scope], f"canary: the first wave is {CANARY[comp.scope]}"
    if comp.scope == "node":
        spare_now = len(br.free_spares())
        reserve = spare_reserve()
        room = spare_now - reserve
        if room < cap:
            cap = max(0, room)
            why = f"spare reserve: {spare_now} free healthy spares, {reserve} are kept for restarts"
    picked = ex.ready[:cap]
    bookings: list[Booking] = []
    for target, row in picked:
        start = 0
        if comp.scope == "node":  # prerequisites first, back to back
            for req, minimum in adv.requires.items():
                rc = COMPONENTS.get(req)
                if rc and older(fleet.version(req, row, target, br.now), minimum) and not fleet.scheduled(req, target):
                    bookings.append(Booking(rc.kind, target, req, minimum, start, rc.minutes, row))
                    start += rc.minutes
        bookings.append(Booking(comp.kind, target, adv.component, adv.fixed, start, comp.minutes, row))
    return Wave(bookings, [t for t, _ in picked], why, canary)


@dataclass
class WaveResult:
    granted: list[dict[str, Any]]  # lease, target, until
    refused: list[dict[str, Any]]  # target, reason
    waits: list[Blocker]  # what the next wave waits for
    parked: dict[str, str]  # target -> owner it is refused for
    halted: bool = False  # stopped at a refusal caused by another booked window


def book_wave(adv: Advisory, wave: Wave, br: Squawk, actor: str, note: str = "") -> WaveResult:
    """Books each target's windows in order; a fix is booked only if its prerequisite was."""
    res = WaveResult([], [], [], {})
    failed_targets: set[str] = set()
    for b in wave.bookings:
        if b.target in failed_targets:
            continue
        d = br.request_work(actor, b.kind, b.target, minutes=b.minutes, start_in=b.start_in, note=patch_note(adv, b.component, b.version, note))
        if d.granted and d.lease:
            res.granted.append({"lease": d.lease.id, "target": b.target, "component": b.component, "until": d.lease.end})
            res.waits.append(Blocker("lease_ends", d.lease.id, d.lease.end))
            continue
        failed_targets.add(b.target)
        res.refused.append({"target": b.target, "component": b.component, "verdict": d.verdict, "reason": d.reason})
        if d.verdict == "warn":
            res.parked[b.target] = APPROVAL  # filed for the shift lead: never file it twice
            continue
        owners = [x.id for x in d.blockers if not x.id.startswith(("#", "lease-")) and x.kind == "lease_ends"]
        leases = [x for x in d.blockers if x.id.startswith(("#", "lease-"))]
        if owners and not leases:
            # Held for a job or tenant: not retried until that owner changes (the runner unparks a
            # job's targets when it finishes). The rest of the advisory keeps going meanwhile.
            res.parked[b.target] = owners[0]
        res.waits.extend(leases)
        if leases:  # halt the wave: the rest would hit the same window (and a rollout stops on its first failure)
            res.halted = True
            break
    return res
