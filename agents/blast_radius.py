"""What the agents need from Blast Radius: read, check and act calls behind one interface.

Two implementations: MockBlastRadius (agents/mock_blast_radius.py, the simulated demo
hall, in-process) today, and the teammate's SpacetimeDB module (over its HTTP API) later.
agents/README.md maps every call to the tables and reducers that module needs.

Blast Radius decides every verdict. Callers pass their actor name; the backend checks
that actor's role and rows before doing anything and writes every action to the audit
log (CLAUDE.md security rules). Time is simulated minutes since T+0.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

PartState = Literal["ok", "degraded", "failed", "maintenance"]
Verdict = Literal["allow", "warn", "deny"]


class BlastRadiusUnavailable(RuntimeError):
    """Blast Radius can't be reached. Agents fail closed: they act on nothing."""


class OutOfScope(PermissionError):
    """The actor's role or rows don't cover this call."""


@dataclass(frozen=True)
class Owner:
    kind: Literal["job", "tenant", "free"]
    id: str = ""


@dataclass(frozen=True)
class NodeView:
    id: str
    rack: str
    row: int
    state: PartState
    owner: Owner


@dataclass(frozen=True)
class RackView:
    id: str
    row: int
    power_margin: int
    cooling_margin: int
    margin: int
    level: Literal["green", "yellow", "red"]
    protected_by: tuple[str, ...]  # protection lease ids covering this rack
    reason: str
    unconfirmed: tuple[str, ...] = ()  # parts above it whose state can't be confirmed (stale readings)


@dataclass(frozen=True)
class Blocker:
    """Something that has to change before a refused action can be checked again."""

    kind: Literal["part_repair", "lease_ends", "feature_ok"]
    id: str  # the part to repair, the lease that has to end, or the feature that has to work again
    until: int | None = None  # minute the lease ends, if known


@dataclass(frozen=True)
class FeatureView:
    """A feature of a service we rely on, as our own tests last saw it."""

    id: str
    service: str
    name: str
    state: Literal["untested", "working", "degraded"]
    reason: str
    since: int | None  # minute the state last changed
    last_test: int | None
    last_good: int | None  # minute of the last passing test
    recovered_at: int | None  # minute it last went from degraded back to working
    service_says: str  # the service's own health report, e.g. "up"
    needs: tuple[str, ...]  # dependencies this feature needs
    covers: tuple[str, ...]  # parts whose state it reports (building management)
    used_by: tuple[str, ...]


@dataclass(frozen=True)
class Page:
    """One page to a person: a tech dispatch or a notice."""

    id: str
    to: str
    subject: str
    message: str
    channel: Literal["text", "email"]
    sent_at: int
    status: Literal["sent", "unconfirmed", "resent"]
    by: str


@dataclass(frozen=True)
class Check:
    verdict: Verdict
    reason: str
    earliest_safe: str | None = None
    blockers: tuple[Blocker, ...] = ()


@dataclass(frozen=True)
class Lease:
    id: str
    type: Literal["maintenance", "protection"]
    actor: str
    start: int
    end: int
    target: str | None = None  # part or node taken offline (maintenance)
    racks: tuple[str, ...] = ()  # racks protected (protection)
    job: str | None = None
    routine: bool = False
    note: str = ""


@dataclass(frozen=True)
class LeaseDecision:
    granted: bool
    verdict: Verdict
    reason: str
    lease: Lease | None = None
    earliest_safe: str | None = None
    blockers: tuple[Blocker, ...] = ()


@dataclass(frozen=True)
class Decision:
    ok: bool
    reason: str


@dataclass(frozen=True)
class Diagnosis:
    node: str
    classification: Literal["shared_cause", "isolated"]
    cause: str | None
    at_risk: tuple[str, ...]
    send: str
    reason: str


@dataclass(frozen=True)
class JobView:
    id: str
    status: Literal["running", "stopped", "finished"]
    nodes: int
    since: int  # minute the status last changed


@dataclass(frozen=True)
class Event:
    seq: int
    time: int
    type: str
    actor: str
    subject: str
    reason: str
    data: dict[str, Any] = field(default_factory=dict)


class BlastRadius(Protocol):
    @property
    def now(self) -> int: ...

    # Reads
    def get_events(self, since: int = 0) -> list[Event]: ...
    def node(self, node_id: str) -> NodeView: ...
    def rack(self, rack_id: str) -> RackView: ...
    def racks_below(self, part_id: str) -> list[str]: ...
    def job(self, job_id: str) -> JobView: ...
    def lease(self, lease_id: str) -> Lease | None: ...
    def leases_on(self, target: str) -> list[Lease]: ...
    def protection_leases(self, job_id: str) -> list[Lease]: ...
    def failures_since(self, node_id: str, since: int) -> int: ...
    def diagnose_failure(self, node_id: str) -> Diagnosis: ...
    def simulate(self, actor: str, target: str) -> Check: ...
    def feature(self, feature_id: str) -> FeatureView: ...
    def features(self) -> list[FeatureView]: ...
    def pages_since(self, since: int, channel: str | None = None) -> list[Page]: ...

    # Actions
    def request_lease(
        self,
        actor: str,
        *,
        target: str,
        minutes: int,
        routine: bool = False,
        note: str = "",
        on_behalf_of: str | None = None,
    ) -> LeaseDecision: ...
    def release_lease(self, actor: str, lease_id: str, note: str = "") -> Decision: ...
    def dispatch_tech(self, actor: str, target: str, trade: str, note: str) -> Decision: ...
    def notify(self, actor: str, to: str, subject: str, message: str) -> Decision: ...
    def request_approval(self, actor: str, target: str, minutes: int, summary: str, requested_for: str) -> Decision: ...
    def escalate(self, actor: str, subject: str, to: str, reason: str) -> Decision: ...
    def record(self, actor: str, type: str, subject: str, reason: str, **data: Any) -> Event: ...
    def record_test(self, actor: str, feature_id: str, passed: bool, detail: str, service_says: str = "up") -> FeatureView: ...
    def resend_page(self, actor: str, page_id: str, channel: str = "email") -> Decision: ...


def label(part_id: str) -> str:
    """Display name used in reasons: cdu-3 -> CDU-3, sw-leaf-r3 -> Leaf R3 (CLAUDE.md IDs)."""
    for pattern, fmt in (
        (r"cdu-(\d+)", "CDU-{0}"),
        (r"pdu-r(\d+)-([ab])", "PDU-R{0}-{1}"),
        (r"ups-([ab])", "UPS-{0}"),
        (r"switchgear-([ab])", "Switchgear {0}"),
        (r"util-([ab])", "Utility {0}"),
        (r"chiller-(\d+)", "Chiller {0}"),
        (r"sw-leaf-r(\d+)", "Leaf R{0}"),
        (r"sw-spine-(\d+)", "Spine {0}"),
        (r"fieldbus-(\d+)", "Gateway {0}"),
        (r"bms\.cooling\.(\d+)", "Gateway {0} readings"),
        (r"paging\.text", "Text paging"),
        (r"paging\.email", "Email paging"),
        (r"keys\.revocation", "The revoked-key list"),
        (r"(sms)-gateway", "SMS gateway"),
        (r"email-(relay)", "Email relay"),
        (r"revocation-(feed)", "Revoked-key feed"),
    ):
        m = re.fullmatch(pattern, part_id)
        if m:
            return fmt.format(*(g.upper() for g in m.groups()))
    return part_id


def fmt_time(minutes: int) -> str:
    """Simulated time as T+45m, T+2h or T+4h05m."""
    h, m = divmod(int(minutes), 60)
    if not h:
        return f"T+{m}m"
    return f"T+{h}h" if not m else f"T+{h}h{m:02d}m"
