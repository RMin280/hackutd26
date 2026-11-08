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


@dataclass
class Fleet:
    rows: tuple[int, ...]
    baseline: dict[str, dict[int, str]]  # component -> row -> version
    actor: str = "update-agent"
    patched: dict[tuple[str, str], tuple[str, int]] = field(default_factory=dict)  # (component, target) -> (version, done at)
    leases: dict[str, tuple[tuple[str, str], int]] = field(default_factory=dict)  # lease id -> (key, ends)

    @classmethod
    def load(cls, path: Path = DATA / "inventory.json", actor: str = "update-agent") -> "Fleet":
        raw = json.loads(Path(path).read_text())
        rows = tuple(int(r) for r in raw["rows"])
        base = {
            name: {r: str(spec.get("rows", {}).get(str(r), spec["default"])) for r in rows}
            for name, spec in raw["components"].items()
        }
        return cls(rows, base, actor)

    def observe(self, e: Event) -> None:
        """Our own granted patch windows, from the feed. A window counts once it has ended."""
        if e.type == "lease_released":  # ended early or cancelled before its window ran: not patched
            got = self.leases.get(str(e.data.get("lease") or e.subject))
            if got and e.time < got[1]:
                self.patched.pop(got[0], None)
            return
        # Our own windows: booked by us, or approved by a shift lead for us (the holder is us).
        holder = e.data.get("holder", e.actor)
        if e.type != "lease_granted" or holder != self.actor:
            return
        m = TAG.match(str(e.data.get("note") or ""))
        if m and m["component"] in COMPONENTS:
            key, until = (m["component"], str(e.data.get("target"))), int(e.data.get("until") or 0)
            self.patched[key] = (m["version"], until)
            if e.data.get("lease"):
                self.leases[str(e.data["lease"])] = (key, until)

    def version(self, component: str, row: int, target: str, now: int) -> str:
        """The version on a target (node, row-N or leaf) in a row, at time `now`."""
        base = self.baseline.get(component, {}).get(row, "0")
        for key in ((component, target), (component, f"row-{row}")):
            got = self.patched.get(key)
            if got and got[1] <= now and not older(got[0], base):
                base = got[0]
        return base

    def scheduled(self, component: str, target: str) -> bool:
        """A patch window for it is booked (running, done or still to come)."""
        return (component, target) in self.patched

    def in_flight(self, adv: "Advisory", now: int) -> list[tuple[str, int]]:
        """Our windows for this advisory's fix (or its prerequisites) that haven't ended: (lease, until)."""
        wanted = {adv.component: adv.fixed, **adv.requires}
        out = []
        for lease, (key, until) in self.leases.items():
            got = self.patched.get(key)
            if until > now and got and key[0] in wanted and got[0] == wanted[key[0]]:
                out.append((lease, until))
        return out

    def booked(self, component: str, version: str) -> int:
        """Windows ever booked to bring a component to a version (canary done once this is > 0)."""
        return sum(1 for (c, _), (v, _) in self.patched.items() if c == component and v == version)

    def affected_rows(self, adv: Advisory) -> list[int]:
        """Rows whose baseline is older than the fix: the version groups to look at."""
        base = self.baseline.get(adv.component, {})
        return [r for r in self.rows if older(base.get(r, "0"), adv.fixed)]


def patch_note(adv: Advisory, component: str, version: str, extra: str = "") -> str:
    """The note on every booking: a fixed tag the fleet reads back, then free text."""
    tag = f"patch {adv.id}: {component} {version}"
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
