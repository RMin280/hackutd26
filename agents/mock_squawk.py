"""In-process stand-in for Squawk over the simulated demo hall (DESIGN.md §3.4).

It lets the agents run end to end before the teammate's SpacetimeDB module exists, the
way frontend/src/mock stands in for the UI. Same IDs and rules as that mock, plus what
the fixer agent needs (maintenance leases on single nodes, routine requests, shift-lead
approvals, finished jobs, an event list and an audit log) and what the dependency agent
needs (features of the services we rely on, as our tests last saw them, and pages).

Three rules come from those features. A CDU whose readings are stale counts as unknown,
and unknown never counts as backup. While text paging is degraded, new pages go by
email. While the revoked-key list is stale, facility changes need a shift lead.

Rules follow DESIGN.md: margins come from explicit feed chains, a check touches only the
racks below its target, every verdict carries a one-line reason. Time is simulated
minutes moved forward by the scenario (advance); nothing reads the wall clock.
"""

from __future__ import annotations

import itertools
from dataclasses import asdict, dataclass, replace
from typing import Any, NamedTuple

from .squawk import (
    SquawkUnavailable,
    Blocker,
    Check,
    Decision,
    Diagnosis,
    Event,
    FeatureView,
    JobView,
    Lease,
    LeaseDecision,
    NodeView,
    OutOfScope,
    Owner,
    Page,
    RackView,
    fmt_time,
    label,
)
from .mock_services import FEATURES, feature_covering

ROWS, RACKS_PER_ROW, NODES_PER_RACK, RACKS_PER_CDU = 10, 16, 8, 5
CDU_COUNT = ROWS * RACKS_PER_ROW // RACKS_PER_CDU  # 32
JOB_ID, JOB_SIZE = "job-train-1", 1000
FAILURE_WINDOW = 120  # minutes of recent failures that diagnosis looks at (DESIGN.md §5)
BRANCH_TYPES = ("pdu", "cdu", "leaf")  # specific enough that two failures under one point to it
SEND_BY_TYPE = {
    "cdu": "mechanical tech",
    "chiller": "mechanical tech",
    "pdu": "electrical tech",
    "ups": "electrical tech",
    "switchgear": "electrical tech",
    "utility": "electrical tech",
    "leaf": "network engineer",
    "spine": "network engineer",
}


# --- Facility map ----------------------------------------------------------------------


@dataclass(frozen=True)
class Rack:
    id: str
    row: int
    pos: int
    power_feeds: tuple[tuple[str, ...], ...]  # upstream chains, nearest part first
    cooling_feeds: tuple[tuple[str, ...], ...]
    network: tuple[str, str]  # leaf, spine
    nodes: tuple[str, ...]


@dataclass(frozen=True)
class Site:
    part_type: dict[str, str]
    part_row: dict[str, int | None]
    racks: dict[str, Rack]  # in floor order
    node_rack: dict[str, str]
    downstream: dict[str, tuple[str, ...]]  # part -> racks below it (DESIGN.md §3.3)
    ancestors: dict[str, tuple[str, ...]]  # rack -> every part above it


def rack_id(row: int, pos: int) -> str:
    return f"rack-r{row}-{pos:02d}"


# rack-r1-12 (the second rack on CDU-3) holds node-417..424, swapped with rack 52.
_SCENARIO_RACK, _SWAP_RACK = 11, (417 - 1) // NODES_PER_RACK


def _node_base(g: int) -> int:
    if g == _SCENARIO_RACK:
        g = _SWAP_RACK
    elif g == _SWAP_RACK:
        g = _SCENARIO_RACK
    return g * NODES_PER_RACK + 1


def backup_cdu(primary: int) -> int:
    """Neighbouring backup CDU, chosen so CDU-4 backs CDU-3 and CDU-3 backs nobody."""
    if primary % 4 == 2 or primary == CDU_COUNT:
        return primary - 1
    return primary + 1


def _chiller(cdu: int) -> str:
    return "chiller-1" if cdu % 2 else "chiller-2"


def build_site() -> Site:
    """10 rows x 16 racks x 8 nodes, power A/B per row, one leaf per row, each CDU
    primary for 5 racks with a neighbouring CDU as backup (same as frontend/src/mock)."""
    part_type: dict[str, str] = {}
    part_row: dict[str, int | None] = {}

    def add(pid: str, ptype: str, row: int | None = None) -> None:
        part_type.setdefault(pid, ptype)
        part_row.setdefault(pid, row)

    for side in "ab":
        add(f"util-{side}", "utility")
        add(f"switchgear-{side}", "switchgear")
        add(f"ups-{side}", "ups")
    add("chiller-1", "chiller")
    add("chiller-2", "chiller")
    add("sw-spine-1", "spine")
    add("sw-spine-2", "spine")
    for c in range(1, CDU_COUNT + 1):
        add(f"cdu-{c}", "cdu", (c - 1) * RACKS_PER_CDU // RACKS_PER_ROW + 1)

    racks: dict[str, Rack] = {}
    node_rack: dict[str, str] = {}
    for row in range(1, ROWS + 1):
        add(f"pdu-r{row}-a", "pdu", row)
        add(f"pdu-r{row}-b", "pdu", row)
        add(f"sw-leaf-r{row}", "leaf", row)
        for pos in range(1, RACKS_PER_ROW + 1):
            g = (row - 1) * RACKS_PER_ROW + (pos - 1)
            rid = rack_id(row, pos)
            primary = g // RACKS_PER_CDU + 1
            backup = backup_cdu(primary)
            nodes = tuple(f"node-{_node_base(g) + s}" for s in range(NODES_PER_RACK))
            for n in nodes:
                node_rack[n] = rid
            racks[rid] = Rack(
                rid,
                row,
                pos,
                power_feeds=(
                    (f"pdu-r{row}-a", "ups-a", "switchgear-a", "util-a"),
                    (f"pdu-r{row}-b", "ups-b", "switchgear-b", "util-b"),
                ),
                cooling_feeds=((f"cdu-{primary}", _chiller(primary)), (f"cdu-{backup}", _chiller(backup))),
                network=(f"sw-leaf-r{row}", "sw-spine-1" if row <= 5 else "sw-spine-2"),
                nodes=nodes,
            )

    ancestors: dict[str, tuple[str, ...]] = {}
    downstream: dict[str, list[str]] = {p: [] for p in part_type}
    for rid, r in racks.items():
        above = tuple(dict.fromkeys(p for chain in (*r.power_feeds, *r.cooling_feeds, r.network) for p in chain))
        ancestors[rid] = above
        for p in above:
            downstream[p].append(rid)
    return Site(part_type, part_row, racks, node_rack, {p: tuple(v) for p, v in downstream.items()}, ancestors)


def initial_owners(site: Site) -> dict[str, Owner]:
    """job-train-1 on the first 1,000 nodes (Rows 1-8), tenant-beta on the rest of Row 8,
    tenant-gamma on 3 nodes per rack in Rows 9-10, the other 160 nodes free spares."""
    owners: dict[str, Owner] = {}
    in_job = 0
    for r in site.racks.values():
        for slot, n in enumerate(r.nodes):
            if r.row <= 8:
                if in_job < JOB_SIZE:
                    owners[n] = Owner("job", JOB_ID)
                    in_job += 1
                else:
                    owners[n] = Owner("tenant", "tenant-beta")
            else:
                owners[n] = Owner("tenant", "tenant-gamma") if slot < 3 else Owner("free")
    return owners


# --- Identities (data/identities.json in the real build) ---------------------------------


@dataclass(frozen=True)
class Actor:
    name: str
    role: str
    rows: frozenset[int] | None = None  # None: every row


PERMISSIONS: dict[str, set[str]] = {
    "remediation_agent": {
        "maintenance",
        "book_for_others",
        "release_stale_protection",
        "dispatch",
        "notify",
        "request_approval",
        "escalate",
        "record",
    },
    "cooling_agent": {"maintenance", "notify", "record"},
    "scheduler_agent": {"protection", "notify", "escalate", "record"},
    "shift_lead": {"maintenance", "approve", "release_any", "dispatch", "notify", "escalate", "record"},
    "dependency_watch": {"record_tests", "dispatch", "notify", "escalate", "record"},
    "facility": {"facility", "record"},
}

DEMO_ACTORS = (
    Actor("fixer-agent", "remediation_agent"),
    Actor("dependency-agent", "dependency_watch"),
    Actor("cooling-agent", "cooling_agent"),
    Actor("scheduler-agent", "scheduler_agent"),
    Actor("shift-lead", "shift_lead"),
    Actor("facility", "facility"),
)


class Margin(NamedTuple):
    power: int
    cooling: int
    margin: int
    level: str
    unprotected: tuple[str, ...]  # parts on the single working feed (yellow racks)


# --- The stand-in ----------------------------------------------------------------------


class MockSquawk:
    def __init__(self, actors: tuple[Actor, ...] = DEMO_ACTORS) -> None:
        self.site = build_site()
        self.actors = {a.name: a for a in actors}
        self.part_state = {p: "ok" for p in self.site.part_type}
        self.node_state = {n: "ok" for n in self.site.node_rack}
        self.owner = initial_owners(self.site)
        self.jobs: dict[str, dict[str, Any]] = {JOB_ID: {"status": "running", "since": 0, "nodes": JOB_SIZE}}
        self.leases: dict[str, Lease] = {}
        self.approvals: dict[str, dict[str, Any]] = {}
        self.features_seen: dict[str, dict[str, Any]] = {
            fid: {"state": "untested", "reason": "Not tested yet.", "since": None, "last_test": None, "last_good": None, "recovered_at": None, "says": "up"}
            for fid in FEATURES
        }
        self.pages: dict[str, Page] = {}
        self.events: list[Event] = []
        self.audit: list[dict[str, Any]] = []
        self.available = True  # tests flip this to simulate an outage
        self._now = 0
        self._failures: dict[str, list[int]] = {}
        self._ids = itertools.count(1)
        self._page_ids = itertools.count(1)

    @property
    def now(self) -> int:
        return self._now

    # Reads ---------------------------------------------------------------------------

    def get_events(self, since: int = 0) -> list[Event]:
        self._up()
        return self.events[since:]  # seq n lives at index n - 1

    def node(self, node_id: str) -> NodeView:
        self._up()
        rid = self.site.node_rack[node_id]
        return NodeView(node_id, rid, self.site.racks[rid].row, self.node_state[node_id], self.owner[node_id])

    def rack(self, rack_id: str) -> RackView:
        self._up()
        m = self._margin(rack_id)
        protected = tuple(lease.id for lease in self._protection_by_rack().get(rack_id, ()))
        unknown = self._unknown_parts()
        unconfirmed = tuple(p for p in self.site.ancestors[rack_id] if p in unknown)
        return RackView(
            rack_id, self.site.racks[rack_id].row, m.power, m.cooling, m.margin, m.level, protected, _margin_reason(m, unconfirmed), unconfirmed
        )

    def racks_below(self, part_id: str) -> list[str]:
        self._up()
        return list(self.site.downstream[part_id])

    def job(self, job_id: str) -> JobView:
        self._up()
        j = self.jobs[job_id]
        return JobView(job_id, j["status"], j["nodes"], j["since"])

    def lease(self, lease_id: str) -> Lease | None:
        self._up()
        lease = self.leases.get(lease_id)
        return lease if lease and self._active(lease) else None

    def leases_on(self, target: str) -> list[Lease]:
        self._up()
        return [x for x in self.leases.values() if x.type == "maintenance" and x.target == target and self._active(x)]

    def protection_leases(self, job_id: str) -> list[Lease]:
        self._up()
        return [x for x in self.leases.values() if x.type == "protection" and x.job == job_id and self._active(x)]

    def failures_since(self, node_id: str, since: int) -> int:
        self._up()
        return sum(1 for t in self._failures.get(node_id, ()) if t >= since)

    def diagnose_failure(self, node_id: str) -> Diagnosis:
        """Shared cause = an unhealthy part above the node, or a PDU/CDU/leaf above it that
        another failure in the last 2 h also sits under. Uses only what already failed."""
        self._up()
        above = self.site.ancestors[self.site.node_rack[node_id]]
        cause = next((p for p in above if self.part_state[p] != "ok"), None)
        partner = None
        if cause is None:
            for other, times in self._failures.items():
                if other == node_id or not any(self._now - t <= FAILURE_WINDOW for t in times):
                    continue
                common = [
                    p
                    for p in self.site.ancestors[self.site.node_rack[other]]
                    if p in above and self.site.part_type[p] in BRANCH_TYPES
                ]
                if common:
                    cause, partner = common[0], other
                    break
        if cause is None:
            return Diagnosis(
                node_id,
                "isolated",
                None,
                (),
                f"hardware tech to {node_id}",
                f"Isolated: every part above {node_id} is ok and no other failure in the last "
                f"{FAILURE_WINDOW // 60} h shares its PDU, CDU or leaf.",
            )

        ptype = self.site.part_type[cause]
        at_risk = tuple(
            n
            for r in self.site.downstream[cause]
            for n in self.site.racks[r].nodes
            if n != node_id and self.owner[n].kind == "job" and self.node_state[n] == "ok"
        )
        verb = "cooled" if ptype in ("cdu", "chiller") else "connected" if ptype in ("leaf", "spine") else "powered"
        if partner is None:
            why = f"{node_id} is {verb} by {label(cause)} ({self.part_state[cause]})."
        else:
            why = f"{node_id} and {partner} failed within {FAILURE_WINDOW // 60} h, both under {label(cause)}."
        other = "other " if self.owner[node_id].kind == "job" else ""
        exposure = f" {len(at_risk)} {other}nodes of {JOB_ID} are on {label(cause)}." if at_risk else ""
        return Diagnosis(
            node_id,
            "shared_cause",
            cause,
            at_risk,
            f"{SEND_BY_TYPE[ptype]} to {label(cause)}",
            f"Shared cause: {why}{exposure} Not a single-node fault.",
        )

    def simulate(self, actor: str, target: str) -> Check:
        entry, a = self._enter(actor, "simulate", target=target)
        check = self._check(target, a)
        entry.update(verdict=check.verdict, reason=check.reason)
        return check

    def feature(self, feature_id: str) -> FeatureView:
        self._up()
        f, seen = FEATURES[feature_id], self.features_seen[feature_id]
        return FeatureView(
            f.id,
            f.service,
            f.name,
            seen["state"],
            seen["reason"],
            seen["since"],
            seen["last_test"],
            seen["last_good"],
            seen["recovered_at"],
            seen["says"],
            f.needs,
            f.covers,
            f.used_by,
        )

    def features(self) -> list[FeatureView]:
        return [self.feature(fid) for fid in FEATURES]

    def pages_since(self, since: int, channel: str | None = None) -> list[Page]:
        self._up()
        return [p for p in self.pages.values() if p.sent_at >= since and (channel is None or p.channel == channel)]

    # Actions ---------------------------------------------------------------------------

    def request_lease(
        self,
        actor: str,
        *,
        target: str,
        minutes: int,
        routine: bool = False,
        note: str = "",
        on_behalf_of: str | None = None,
    ) -> LeaseDecision:
        """A maintenance lease takes a part or node offline. allow: granted. warn: needs a
        shift lead (request_approval, then approve). deny: refused, with blockers.
        on_behalf_of books it for another actor, who then holds it (re-queued requests)."""
        perm = "maintenance" if on_behalf_of is None else "book_for_others"
        entry, a = self._enter(actor, "request_lease", perm=perm, target=target, minutes=minutes, routine=routine, on_behalf_of=on_behalf_of)
        holder = a if on_behalf_of is None else self.actors.get(on_behalf_of)
        if holder is None:
            entry.update(verdict="out_of_scope", reason=f"Unknown actor {on_behalf_of!r}.")
            raise OutOfScope(f"Unknown actor {on_behalf_of!r}.")
        own = [x for x in self.leases_on(target) if x.actor == holder.name]
        if own:
            reason = f"{holder.name} already holds {own[0].id} on {label(target)} until {fmt_time(own[0].end)}."
            entry.update(verdict="allow", reason=reason, granted=True, lease=own[0].id)
            return LeaseDecision(True, "allow", reason, own[0])
        if minutes <= 0:
            check = Check("deny", "A lease needs a window longer than 0 minutes.")
        elif self._fail_closed() and "approve" not in PERMISSIONS.get(a.role, set()):
            check = Check("warn", "The revoked-key list is out of date, so facility changes need a shift lead until it's current.")
        else:
            check = self._check(target, holder)
        if check.verdict != "allow":
            reason = check.reason
            entry.update(verdict=check.verdict, reason=reason, granted=False)
            self._emit(
                "lease_denied",
                a.name,
                target,
                reason,
                target=target,
                verdict=check.verdict,
                routine=routine,
                minutes=minutes,
                note=note,
                earliest_safe=check.earliest_safe,
                blockers=[asdict(b) for b in check.blockers],
            )
            return LeaseDecision(False, check.verdict, reason, None, check.earliest_safe, check.blockers)
        lease = self._grant(holder.name, target, minutes, routine, note)
        entry.update(verdict="allow", reason=check.reason, granted=True, lease=lease.id)
        self._emit("lease_granted", a.name, target, check.reason, lease=lease.id, target=target, verdict="allow", until=lease.end, routine=routine, holder=holder.name, note=note)
        return LeaseDecision(True, "allow", check.reason, lease)

    def request_approval(self, actor: str, target: str, minutes: int, summary: str, requested_for: str) -> Decision:
        entry, a = self._enter(actor, "request_approval", perm="request_approval", target=target, minutes=minutes, requested_for=requested_for)
        approval_id = f"approval-{next(self._ids)}"
        self.approvals[approval_id] = {"target": target, "minutes": minutes, "requested_for": requested_for, "status": "pending"}
        reason = f"Asked the shift lead to approve {label(target)} offline for {minutes} min for {requested_for}."
        entry.update(verdict="allow", reason=reason, approval=approval_id)
        self._emit("approval_requested", a.name, target, reason, approval=approval_id, minutes=minutes, requested_for=requested_for, summary=summary)
        return Decision(True, reason)

    def approve(self, actor: str, approval_id: str) -> LeaseDecision:
        """Shift lead approves a warn: re-checks now, then grants the lease to the requester."""
        entry, a = self._enter(actor, "approve", perm="approve", approval=approval_id)
        ap = self.approvals.get(approval_id)
        if not ap or ap["status"] != "pending":
            reason = f"{approval_id} isn't pending."
            entry.update(verdict="deny", reason=reason)
            return LeaseDecision(False, "deny", reason)
        requester = self.actors[ap["requested_for"]]
        check = self._check(ap["target"], requester)
        if check.verdict == "deny":
            ap["status"] = "refused"
            entry.update(verdict="deny", reason=check.reason)
            self._emit("lease_denied", a.name, ap["target"], check.reason, target=ap["target"], verdict="deny", routine=False, minutes=ap["minutes"], blockers=[asdict(b) for b in check.blockers])
            return LeaseDecision(False, "deny", check.reason, None, check.earliest_safe, check.blockers)
        ap["status"] = "approved"
        lease = self._grant(requester.name, ap["target"], ap["minutes"], True, f"approved by {a.name}")
        reason = f"{check.reason.removesuffix(' Needs shift lead approval.')} Approved by {a.name}."
        entry.update(verdict=check.verdict, reason=reason, granted=True, lease=lease.id)
        self._emit("lease_granted", a.name, ap["target"], reason, lease=lease.id, target=ap["target"], verdict=check.verdict, until=lease.end, holder=requester.name, approved_by=a.name)
        return LeaseDecision(True, check.verdict, reason, lease)

    def protect(self, actor: str, job_id: str, minutes: int) -> LeaseDecision:
        """Protection lease on a running job's racks (the scheduler agent's call, §6.3)."""
        entry, a = self._enter(actor, "protect", perm="protection", job=job_id, minutes=minutes)
        racks = tuple(dict.fromkeys(self.site.node_rack[n] for n, o in self.owner.items() if o.kind == "job" and o.id == job_id))
        lease = Lease(f"lease-{next(self._ids)}", "protection", a.name, self._now, self._now + minutes, racks=racks, job=job_id)
        self.leases[lease.id] = lease
        reason = f"Protects {len(racks)} racks of {job_id} until {fmt_time(lease.end)}. Maintenance that would remove their backup is refused."
        entry.update(verdict="allow", reason=reason, lease=lease.id)
        self._emit("lease_granted", a.name, job_id, reason, lease=lease.id, job=job_id, racks=len(racks), until=lease.end, verdict="allow")
        return LeaseDecision(True, "allow", reason, lease)

    def release_lease(self, actor: str, lease_id: str, note: str = "") -> Decision:
        lease = self.leases.get(lease_id)
        entry, a = self._enter(actor, "release_lease", target=lease.target if lease else None, lease=lease_id)
        if lease is None or not self._active(lease):
            return self._refuse_release(entry, a.name, lease_id, f"{lease_id} isn't active.")
        perms = PERMISSIONS.get(a.role, set())
        if lease.actor == a.name:
            reason = f"{a.name} released its own {lease_id}."
        elif "release_any" in perms:
            reason = f"{a.name} released {lease_id}, held by {lease.actor}."
        elif lease.type == "protection" and "release_stale_protection" in perms:
            job = self.jobs.get(lease.job or "")
            if self._fail_closed():
                return self._refuse_release(entry, a.name, lease_id, "The revoked-key list is out of date, so releasing someone else's lock needs a shift lead until it's current.")
            if not job or job["status"] != "finished":
                status = job["status"] if job else "unknown"
                return self._refuse_release(entry, a.name, lease_id, f"{lease.job} is {status}, so its protection stays until {fmt_time(lease.end)}.")
            reason = f"{lease.job} finished at {fmt_time(job['since'])}, so the lock no longer protects running work."
        else:
            return self._refuse_release(entry, a.name, lease_id, f"Only {lease.actor} or a shift lead can release {lease_id}.")
        del self.leases[lease_id]
        entry.update(verdict="allow", reason=reason)
        self._emit("lease_released", a.name, lease_id, reason, lease_type=lease.type, target=lease.target, job=lease.job, holder=lease.actor, note=note)
        return Decision(True, reason)

    def dispatch_tech(self, actor: str, target: str, trade: str, note: str) -> Decision:
        entry, a = self._enter(actor, "dispatch_tech", perm="dispatch", target=target, trade=trade)
        page = self._send_page(a.name, trade, target, note)
        reason = f"Sent a {trade} to {label(target)}{_how(page)}."
        entry.update(verdict="allow", reason=reason, page=page.id)
        self._emit("tech_dispatched", a.name, target, reason, trade=trade, note=note, page=page.id, channel=page.channel, page_status=page.status)
        return Decision(True, reason)

    def notify(self, actor: str, to: str, subject: str, message: str) -> Decision:
        entry, a = self._enter(actor, "notify", perm="notify", to=to, subject=subject)
        page = self._send_page(a.name, to, subject, message)
        reason = f"Told {to} about {label(subject)}{_how(page)}."
        entry.update(verdict="allow", reason=reason, page=page.id)
        self._emit("notified", a.name, subject, reason, to=to, message=message, page=page.id, channel=page.channel, page_status=page.status)
        return Decision(True, reason)

    def resend_page(self, actor: str, page_id: str, channel: str = "email") -> Decision:
        entry, a = self._enter(actor, "resend_page", perm="notify", page=page_id, channel=channel)
        page = self.pages.get(page_id)
        problem = None
        if page is None:
            problem = f"{page_id} doesn't exist."
        elif channel not in ("text", "email"):
            problem = f"There's no {channel} paging."
        elif self.features_seen[f"paging.{channel}"]["state"] == "degraded":
            problem = f"Paging by {channel} is down too."
        if problem:
            entry.update(verdict="deny", reason=problem)
            return Decision(False, problem)
        self.pages[page_id] = replace(page, status="resent")
        reason = f"Re-sent {page_id} to {page.to} by {channel} (first sent at {fmt_time(page.sent_at)} by {page.channel})."
        entry.update(verdict="allow", reason=reason)
        self._emit("page_resent", a.name, page.subject, reason, page=page_id, to=page.to, channel=channel, first_sent=page.sent_at)
        return Decision(True, reason)

    def record_test(self, actor: str, feature_id: str, passed: bool, detail: str, service_says: str = "up") -> FeatureView:
        """Our own test of a feature. Squawk sets the feature's state from the result
        (never the agent) and writes an event whenever the state changes."""
        entry, a = self._enter(actor, "record_test", perm="record_tests", feature=feature_id, passed=passed)
        seen = self.features_seen[feature_id]
        previous, previous_since, state = seen["state"], seen["since"], "working" if passed else "degraded"
        seen.update(last_test=self._now, says=service_says, reason=detail)
        if passed:
            seen["last_good"] = self._now
        if state != previous:
            seen.update(state=state, since=self._now)
            if previous == "degraded":
                seen["recovered_at"] = self._now
            if previous != "untested" or state == "degraded":  # the first passing test is just a baseline
                f = FEATURES[feature_id]
                self._emit(
                    "feature_state",
                    a.name,
                    feature_id,
                    detail,
                    feature=feature_id,
                    service=f.service,
                    state=state,
                    previous=previous,
                    previous_since=previous_since,
                    last_good=seen["last_good"],
                    covers=list(f.covers),
                    service_says=service_says,
                )
        entry.update(verdict="allow", reason=detail)
        return self.feature(feature_id)

    def escalate(self, actor: str, subject: str, to: str, reason: str) -> Decision:
        entry, a = self._enter(actor, "escalate", perm="escalate", subject=subject, to=to)
        entry.update(verdict="allow", reason=reason)
        self._emit("escalated", a.name, subject, reason, to=to)
        return Decision(True, f"Handed {label(subject)} to the {to}.")

    def record(self, actor: str, type: str, subject: str, reason: str, **data: Any) -> Event:
        entry, a = self._enter(actor, "record", perm="record", type=type, subject=subject)
        entry.update(verdict="allow", reason=reason)
        return self._emit(type, a.name, subject, reason, **data)

    # Facility simulation (the scenario's hand, not an agent call) ----------------------

    def set_part_state(self, part: str, state: str, note: str = "") -> None:
        self._enter("facility", "set_part_state", perm="facility", target=part, state=state)
        previous, self.part_state[part] = self.part_state[part], state
        self._emit("state_change", "facility", part, f"{label(part)} {state}.", kind="part", state=state, previous=previous, note=note)

    def set_node_state(self, node: str, state: str, note: str = "") -> None:
        self._enter("facility", "set_node_state", perm="facility", target=node, state=state)
        previous, self.node_state[node] = self.node_state[node], state
        if state == "failed":
            self._failures.setdefault(node, []).append(self._now)
        self._emit("state_change", "facility", node, f"{node} {state}.", kind="node", state=state, previous=previous, note=note)

    def set_job_status(self, job_id: str, status: str) -> None:
        self._enter("facility", "set_job_status", perm="facility", job=job_id, status=status)
        previous = self.jobs[job_id]["status"]
        self.jobs[job_id].update(status=status, since=self._now)
        self._emit("job_status", "facility", job_id, f"{job_id} {status}.", status=status, previous=previous)

    def advance(self, to: int) -> None:
        """Move simulated time forward; leases that ended are expired, with an event each."""
        if to < self._now:
            raise ValueError("Simulated time only moves forward.")
        self._now = to
        for lease in [x for x in self.leases.values() if x.end <= to]:
            del self.leases[lease.id]
            self._emit(
                "lease_expired",
                "facility",
                lease.id,
                f"{lease.id} ({lease.type}, held by {lease.actor}) ended at {fmt_time(lease.end)}.",
                at=lease.end,
                lease_type=lease.type,
                target=lease.target,
                job=lease.job,
                holder=lease.actor,
            )

    # Internals -------------------------------------------------------------------------

    def _up(self) -> None:
        if not self.available:
            raise SquawkUnavailable("Squawk is unreachable.")

    def _enter(self, actor_name: str, call: str, *, perm: str | None = None, target: str | None = None, **args: Any):
        """Audit the call, then check the caller's identity, role and rows before any work."""
        self._up()
        entry: dict[str, Any] = {"time": self._now, "actor": actor_name, "call": call, "target": target, **args}
        self.audit.append(entry)
        actor = self.actors.get(actor_name)
        problem = None
        if actor is None:
            problem = f"Unknown actor {actor_name!r}: every caller needs its own key."
        elif perm and perm not in PERMISSIONS.get(actor.role, set()):
            problem = f"{actor_name} ({actor.role}) may not {call.replace('_', ' ')}."
        elif target is not None and actor.rows is not None and self._row_of(target) not in actor.rows:
            problem = f"{label(target)} is outside {actor_name}'s rows."
        if problem:
            entry.update(verdict="out_of_scope", reason=problem)
            raise OutOfScope(problem)
        return entry, actor

    def _row_of(self, target: str) -> int | None:
        if target in self.site.node_rack:
            return self.site.racks[self.site.node_rack[target]].row
        return self.site.part_row.get(target)

    def _emit(self, type: str, actor: str, subject: str, reason: str, *, at: int | None = None, **data: Any) -> Event:
        event = Event(len(self.events) + 1, self._now if at is None else at, type, actor, subject, reason, data)
        self.events.append(event)
        return event

    def _grant(self, holder: str, target: str, minutes: int, routine: bool, note: str) -> Lease:
        lease = Lease(f"lease-{next(self._ids)}", "maintenance", holder, self._now, self._now + minutes, target=target, routine=routine, note=note)
        self.leases[lease.id] = lease
        return lease

    def _refuse_release(self, entry: dict[str, Any], actor: str, lease_id: str, reason: str) -> Decision:
        entry.update(verdict="deny", reason=reason)
        self._emit("release_denied", actor, lease_id, reason)
        return Decision(False, reason)

    def _active(self, lease: Lease) -> bool:
        return lease.start <= self._now < lease.end

    def _unknown_parts(self) -> set[str]:
        """Parts whose state can't be confirmed, because the feature reporting them is degraded."""
        return {p for fid, seen in self.features_seen.items() if seen["state"] == "degraded" for p in FEATURES[fid].covers}

    def _fail_closed(self) -> bool:
        return self.features_seen["keys.revocation"]["state"] == "degraded"

    def _send_page(self, by: str, to: str, subject: str, message: str) -> Page:
        """Text first; email while text paging is degraded; unconfirmed when both are."""
        text_ok = self.features_seen["paging.text"]["state"] != "degraded"
        email_ok = self.features_seen["paging.email"]["state"] != "degraded"
        channel, status = ("text", "sent") if text_ok else ("email", "sent") if email_ok else ("text", "unconfirmed")
        page = Page(f"page-{next(self._page_ids)}", to, subject, message, channel, self._now, status, by)
        self.pages[page.id] = page
        return page

    def _protection_by_rack(self) -> dict[str, list[Lease]]:
        out: dict[str, list[Lease]] = {}
        for lease in self.leases.values():
            if lease.type == "protection" and self._active(lease):
                for r in lease.racks:
                    out.setdefault(r, []).append(lease)
        return out

    def _margin(self, rack_id: str, extra_offline: str | None = None) -> Margin:
        """remaining backup = working feeds - 1, per DESIGN.md §3.2."""
        r = self.site.racks[rack_id]
        offline = {x.target for x in self.leases.values() if x.type == "maintenance" and self._active(x)}
        offline |= self._unknown_parts()  # a part we can't confirm never counts as backup
        if extra_offline:
            offline.add(extra_offline)

        def working(chain: tuple[str, ...]) -> bool:
            return all(self.part_state[p] == "ok" and p not in offline for p in chain)

        pw = [c for c in r.power_feeds if working(c)]
        cw = [c for c in r.cooling_feeds if working(c)]
        power, cooling = len(pw) - 1, len(cw) - 1
        margin = min(power, cooling)
        level = "green" if margin >= 1 else "yellow" if margin == 0 else "red"
        unprotected = (pw[0] if power == 0 else ()) + (cw[0] if cooling == 0 else ())
        return Margin(power, cooling, margin, level, unprotected)

    def _check(self, target: str, actor: Actor) -> Check:
        """What happens if target goes offline now. Touches only the racks below it."""
        if target not in self.site.node_rack and target not in self.site.part_type:
            return Check("deny", f"{target} isn't in the facility map.")
        for x in self.leases_on(target):
            if x.actor != actor.name:
                return Check(
                    "deny",
                    f"{label(target)} is already offline under {x.id} ({x.actor}) until {fmt_time(x.end)}.",
                    f"after {fmt_time(x.end)}",
                    (Blocker("lease_ends", x.id, x.end),),
                )
        return self._check_node(target) if target in self.site.node_rack else self._check_part(target)

    def _check_node(self, node: str) -> Check:
        owner, state = self.owner[node], self.node_state[node]
        if owner.kind == "job" and self.jobs[owner.id]["status"] == "running":
            return Check("deny", f"{node} runs {owner.id}; taking it offline stops the whole job.", f"after {owner.id} moves off {node}")
        if owner.kind == "tenant" and state != "failed":
            return Check("warn", f"{node} is still running {owner.id}'s work; taking it offline interrupts them. Needs shift lead approval.")
        what = {
            "free": "a free spare",
            "tenant": f"{owner.id}'s node and already down",
            "job": f"in {owner.id}, which is {self.jobs.get(owner.id, {}).get('status')}",
        }[owner.kind]
        return Check("allow", f"{node} can go offline: it's {what}, and no rack loses backup.")

    def _check_part(self, part: str) -> Check:
        name = label(part)
        protected = self._protection_by_rack()
        dropped = []
        for rid in self.site.downstream[part]:
            before, after = self._margin(rid), self._margin(rid, extra_offline=part)
            if after.margin < before.margin:
                dropped.append((rid, after.level))
        red = [rid for rid, level in dropped if level == "red"]
        locked = [rid for rid, level in dropped if rid in protected and level != "green"]

        if red or locked:
            unknown = self._unknown_parts()
            above_red = list(dict.fromkeys(p for rid in red for p in self.site.ancestors[rid]))
            repair = [p for p in above_red if self.part_state[p] != "ok"]
            blind = [p for p in above_red if p in unknown and self.part_state[p] == "ok"]
            stale = list(dict.fromkeys(f for f in (feature_covering(p) for p in blind) if f))
            locks = list({lease.id: lease for rid in locked for lease in protected[rid]}.values())
            reason = ""
            if red:
                kind = "cooling" if self.site.part_type[part] in ("cdu", "chiller") else "power"
                causes = [f"{label(p)} {self.part_state[p]}" for p in repair] + [f"{label(p)} unconfirmed" for p in blind]
                why = f" ({', '.join(causes)})" if causes else ""
                reason = f"{name} is the only {kind} feed for {len(red)} racks{why}; taking it offline makes them red."
            if locked:
                jobs = ", ".join(dict.fromkeys(lease.job or "a job" for lease in locks))
                lead = " It would also drop" if reason else f"Taking {name} offline drops"
                reason += f"{lead} {len(locked)} racks protected for {jobs} below full backup."
            safe = [f"after {', '.join(label(p) for p in repair)} repair"] if repair else []
            if stale:
                safe.append("once CDU readings are fresh")
            if locks:
                safe.append(f"after protection ends ({fmt_time(max(lease.end for lease in locks))})")
            blockers = (
                tuple(Blocker("part_repair", p) for p in repair)
                + tuple(Blocker("feature_ok", f) for f in stale)
                + tuple(Blocker("lease_ends", lease.id, lease.end) for lease in locks)
            )
            return Check("deny", reason, " and ".join(safe), blockers)

        yellow = [rid for rid, level in dropped if level == "yellow"]
        if yellow:
            return Check("warn", f"Taking {name} offline leaves {len(yellow)} racks one failure from an outage. Needs shift lead approval.")
        return Check("allow", f"{name} can go offline: every rack below it keeps full backup.")


def _how(page: Page) -> str:
    if page.status == "unconfirmed":
        return ", but no paging channel is confirmed working"
    return " (by email: text paging is down)" if page.channel == "email" else ""


def _margin_reason(m: Margin, unconfirmed: tuple[str, ...] = ()) -> str:
    if unconfirmed and m.level != "green":
        return f"Can't confirm backup: readings for {', '.join(label(p) for p in unconfirmed)} are stale, so they don't count."
    if m.level == "green":
        return f"Full backup: {m.power + 1} working power feeds and {m.cooling + 1} working cooling feeds."
    if m.level == "yellow":
        return f"One failure from an outage: the only working feed runs through {', '.join(label(p) for p in m.unprotected)}."
    down = " or ".join(k for k, v in (("power", m.power), ("cooling", m.cooling)) if v < 0)
    return f"No working {down} feed."
