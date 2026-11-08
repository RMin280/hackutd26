"""What runs where, what's vulnerable, and what's already been patched. All code, no model.

- COMPONENTS: each software component's work kind in Squawk (DESIGN.md §4.4) and scope.
- Advisory: one security advisory from the feed. Its title and summary are untrusted text.
- Fleet: versions by row (the inventory) plus every patch window the update agent has
  finished, read from Squawk's own feed. So the state is durable (a restarted agent
  rebuilds it from the feed) and the backend stays the single source of truth for what
  actually ran. Only our own lease_granted rows count, so nobody can fake a patch by
  writing a note.

Matching is by version group (component x row), never node by node: an advisory is checked
against a few dozen groups however many nodes the hall has.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from ..squawk import Event

DATA = Path(__file__).with_name("data")
VERSION = re.compile(r"[\w+-]+(?:\.[\w+-]+)*")
TAG = re.compile(rf"^patch (?P<adv>[\w.-]+): (?P<component>\w+) (?P<version>{VERSION.pattern})")
ROLLBACK = re.compile(rf"^rollback (?P<adv>[\w.-]+): (?P<component>\w+) (?P<version>{VERSION.pattern})")
HOLD = re.compile(r"^hold (?P<adv>[\w.-]+): ")
CANARY_SIZE = {"node": 2, "row": 1, "leaf": 1}  # the first wave of a fix (rollout.CANARY)
log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Component:
    name: str
    label: str
    kind: Literal["sw_online", "sw_exclusive", "switch_firmware"]
    scope: Literal["row", "node", "leaf"]  # what one booking targets
    minutes: int  # the patch window


COMPONENTS: dict[str, Component] = {
    c.name: c
    for c in (
        Component("monitoring_agent", "monitoring agent", "sw_online", "row", 30),  # live patch, no reboot
        Component("gpu_driver", "GPU driver", "sw_exclusive", "node", 90),  # reboots the node
        Component("bmc_firmware", "BMC firmware", "sw_exclusive", "node", 60),
        Component("leaf_os", "leaf switch OS", "switch_firmware", "leaf", 60),  # reboots the switch
    )
}

SEVERITIES = ("low", "medium", "high", "critical")


def version_key(v: str) -> tuple:
    """550.54.15 < 550.90.07 < 551.0; numeric parts compare as numbers."""
    # (0, n) for numbers, (1, text) otherwise: never compares an int with a str
    return tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in re.split(r"[.\-+]", str(v)) if p)


def older(v: str, than: str) -> bool:
    return version_key(v) < version_key(than)


@dataclass(frozen=True)
class Advisory:
    id: str
    component: str
    fixed: str
    severity: str
    cvss: float
    exploited: bool  # reported exploited in the wild (a fact from the feed, not a forecast)
    title: str = ""  # untrusted
    summary: str = ""  # untrusted
    requires: dict[str, str] = field(default_factory=dict)  # prerequisite component -> minimum version

    @property
    def urgent(self) -> bool:
        return self.severity == "critical" or self.exploited


def load_advisories(path: Path = DATA / "advisories.json") -> list[Advisory]:
    raw = json.loads(Path(path).read_text())
    out = []
    for a in raw["advisories"]:
        if not re.fullmatch(r"[\w.-]{3,40}", str(a.get("id", ""))):
            log.warning("Skipping an advisory with an unusable id: %r", str(a.get("id", ""))[:60])
            continue  # an id goes into notes and Squawk rows: keep it plain
        versions = [str(a.get("fixed", "")), *map(str, (a.get("requires") or {}).values())]
        if not all(VERSION.fullmatch(v) for v in versions):
            log.warning("Skipping %s: a fixed version isn't a plain version string", a["id"])
            continue  # a version the patch tag can't carry would never count as patched
        sev = str(a.get("severity", "")).lower()
        out.append(
            Advisory(
                id=a["id"],
                component=str(a["component"]),
                fixed=str(a["fixed"]),
                severity=sev if sev in SEVERITIES else "high",  # unknown severity: treat as serious
                cvss=float(a.get("cvss") or 0),
                exploited=bool(a.get("exploited")),
                title=str(a.get("title", ""))[:300],
                summary=str(a.get("summary", ""))[:1000],
                requires={str(k): str(v) for k, v in (a.get("requires") or {}).items()},
            )
        )
    order = {s: i for i, s in enumerate(SEVERITIES)}
    return sorted(out, key=lambda a: (-a.exploited, -order[a.severity], -a.cvss, a.id))  # worst first


@dataclass(frozen=True)
class Fault:
    """A simulated install fault: the first `fails` windows bringing `component` on `target` to
    `version` end with the post-install check failing. Stands in for fleet management's health
    check after a patch (DCIM / Redfish / the node's own agent in production)."""

    component: str
    version: str
    target: str
    fails: int
    symptom: str  # what the check reports: untrusted text, fenced before the model sees it


@dataclass(frozen=True)
class Window:
    """One of our own windows on a target: a patch attempt or a rollback."""

    seq: int
    kind: Literal["patch", "rollback"]
    version: str
    start: int
    until: int
    lease: str


# What a target's last window says, once read against the clock.
Status = Literal["running", "ok", "failed", "rolling_back", "rolled_back"]


@dataclass
class Fleet:
    rows: tuple[int, ...]
    baseline: dict[str, dict[int, str]]  # component -> row -> version
    actor: str = "update-agent"
    faults: dict[tuple[str, str, str], Fault] = field(default_factory=dict)  # (component, target, version) -> fault
    history: dict[tuple[str, str], list[Window]] = field(default_factory=dict)  # (component, target) -> our windows, oldest first
    leases: dict[str, tuple[tuple[str, str], int]] = field(default_factory=dict)  # lease id -> (key, ends)
    holds: dict[str, tuple[str, int, int]] = field(default_factory=dict)  # target -> (lease, start, ends): kept out after a failure
    order: dict[tuple[str, str], list[str]] = field(default_factory=dict)  # (component, version) -> targets in booking order

    @classmethod
    def load(cls, path: Path = DATA / "inventory.json", actor: str = "update-agent") -> "Fleet":
        raw = json.loads(Path(path).read_text())
        rows = tuple(int(r) for r in raw["rows"])
        base = {
            name: {r: str(spec.get("rows", {}).get(str(r), spec["default"])) for r in rows}
            for name, spec in raw["components"].items()
        }
        faults = {}
        for f in raw.get("install_faults", []):
            fault = Fault(str(f["component"]), str(f["version"]), str(f["target"]), int(f.get("fails", 1)), str(f.get("symptom", ""))[:300])
            faults[(fault.component, fault.target, fault.version)] = fault
        return cls(rows, base, actor, faults)

    def observe(self, e: Event) -> None:
        """Our own granted windows, from the feed. A window counts once it has ended."""
        if e.type == "lease_released":  # ended early or cancelled before its window ran: it didn't happen
            lease = str(e.data.get("lease") or e.subject)
            got = self.leases.pop(lease, None)
            if got and e.time < got[1]:
                self.history[got[0]] = [w for w in self.history.get(got[0], []) if w.lease != lease]
                if not self.history[got[0]]:
                    del self.history[got[0]]
            for target, (held, _, _) in list(self.holds.items()):
                if held == lease:
                    del self.holds[target]
            return
        # Our own windows: booked by us, or approved by a shift lead for us (the holder is us).
        holder = e.data.get("holder", e.actor)
        if e.type != "lease_granted" or holder != self.actor:
            return
        note, target = str(e.data.get("note") or ""), str(e.data.get("target"))
        start, until, lease = int(e.data.get("start") or e.time), int(e.data.get("until") or 0), str(e.data.get("lease") or "")
        if HOLD.match(note):
            self.holds[target] = (lease, start, until)
            return
        m = TAG.match(note) or ROLLBACK.match(note)
        if not m or m["component"] not in COMPONENTS:
            return
        key = (m["component"], target)
        kind = "rollback" if note.startswith("rollback ") else "patch"
        self.history.setdefault(key, []).append(Window(e.seq, kind, m["version"], start, until, lease))
        if kind == "patch":
            seen = self.order.setdefault((m["component"], m["version"]), [])
            if target not in seen:
                seen.append(target)
        if lease:
            self.leases[lease] = (key, until)

    # ---- what a target runs

    def status(self, component: str, target: str, now: int) -> Status | None:
        """What our last window on a target says at `now`; None when we never booked one."""
        windows = self.history.get((component, target))
        if not windows:
            return None
        last = windows[-1]
        if last.kind == "rollback":
            return "rolling_back" if last.until > now else "rolled_back"
        if last.until > now:
            return "running"
        return "failed" if self.attempt(component, target, last.version, now) <= self._fails(component, target, last.version) else "ok"

    def attempt(self, component: str, target: str, version: str, now: int | None = None) -> int:
        """Patch windows booked to bring a target to `version` (ended by `now`, when given)."""
        return sum(1 for w in self.history.get((component, target), []) if w.kind == "patch" and w.version == version and (now is None or w.until <= now))

    def _fails(self, component: str, target: str, version: str) -> int:
        f = self.faults.get((component, target, version))
        return f.fails if f else 0

    def symptom(self, component: str, target: str, version: str) -> str:
        f = self.faults.get((component, target, version))
        return f.symptom if f else "the post-install check failed"

    def last_window(self, component: str, target: str) -> Window | None:
        windows = self.history.get((component, target))
        return windows[-1] if windows else None

    def version(self, component: str, row: int, target: str, now: int) -> str:
        """The version on a target (node, row-N or leaf) in a row, at time `now`. A failed or
        rolled-back window leaves the version it found."""
        base = self.baseline.get(component, {}).get(row, "0")
        for key in ((component, target), (component, f"row-{row}")):
            if self.status(*key, now) == "ok":
                got = self.history[key][-1].version
                if not older(got, base):
                    base = got
        return base

    def scheduled(self, component: str, target: str) -> bool:
        """A window for it is booked (running, done or still to come)."""
        return (component, target) in self.history

    def in_flight(self, adv: "Advisory", now: int) -> list[tuple[str, int]]:
        """Our windows for this advisory's fix (or its prerequisites) that haven't ended: (lease, until)."""
        wanted = {adv.component: adv.fixed, **adv.requires}
        out = []
        for lease, (key, until) in self.leases.items():
            windows = self.history.get(key)
            last = windows[-1] if windows else None
            if until > now and last and last.lease == lease and key[0] in wanted and last.version == wanted[key[0]]:
                out.append((lease, until))
        return out

    def later_windows(self, target: str, now: int) -> list[str]:
        """Our patch windows on a target that haven't started yet (any component): cancelled when an earlier one fails."""
        return [w.lease for (c, t), ws in self.history.items() if t == target for w in ws if w.kind == "patch" and w.start > now and w.lease]

    def held(self, target: str, now: int) -> tuple[str, int] | None:
        """Our hold on a target, if one covers `now`: (lease, ends)."""
        got = self.holds.get(target)
        return (got[0], got[2]) if got and got[1] <= now < got[2] else None

    def booked(self, component: str, version: str) -> int:
        """Targets ever booked to bring a component to a version (canary done once this is > 0)."""
        return len(self.order.get((component, version), []))

    def canary(self, component: str, version: str, target: str) -> bool:
        """The target was in the first wave of this fix."""
        return target in self.order.get((component, version), [])[: CANARY_SIZE[COMPONENTS[component].scope]]

    def failures(self, adv: "Advisory", now: int) -> list[tuple[str, str]]:
        """(component, target) of this advisory (its fix or a prerequisite) whose last window failed.
        Walks only the targets we booked, never the hall."""
        wanted = {adv.component: adv.fixed, **adv.requires}
        return [
            key
            for key, ws in self.history.items()
            if key[0] in wanted and ws[-1].version == wanted[key[0]] and self.status(*key, now) == "failed"
        ]

    def broken(self, adv: "Advisory", target: str, now: int) -> Status | None:
        """A target this advisory's rollout must leave alone: its fix or a prerequisite failed, is
        being rolled back, or was rolled back (left for a person)."""
        for comp in (adv.component, *adv.requires):
            st = self.status(comp, target, now)
            if st in ("failed", "rolling_back", "rolled_back"):
                return st
            if st == "running" and self.attempt(comp, target, self.history[(comp, target)][-1].version) > 1:
                return "failed"  # a retry is running: still the failure's, not a new wave's
        return None

    def affected_rows(self, adv: Advisory) -> list[int]:
        """Rows whose baseline is older than the fix: the version groups to look at."""
        base = self.baseline.get(adv.component, {})
        return [r for r in self.rows if older(base.get(r, "0"), adv.fixed)]


def patch_note(adv: Advisory, component: str, version: str, extra: str = "", kind: str = "patch") -> str:
    """The note on every booking: a fixed tag the fleet reads back, then free text.
    kind: patch | rollback (back to `version`) | hold (kept out of service after a failure)."""
    tag = f"{kind} {adv.id}: {component} {version}"
    return f"{tag}. {extra}".strip()[:400] if extra else tag


def describe(adv: Advisory) -> dict[str, Any]:
    c = COMPONENTS.get(adv.component)
    return {
        "advisory": adv.id,
        "component": c.label if c else adv.component,
        "fixed_in": adv.fixed,
        "severity": adv.severity,
        "cvss": adv.cvss,
        "exploited_in_the_wild": adv.exploited,
        "needs_reboot": bool(c and c.kind != "sw_online"),
        "prerequisites": {COMPONENTS[k].label if k in COMPONENTS else k: v for k, v in adv.requires.items()},
    }
