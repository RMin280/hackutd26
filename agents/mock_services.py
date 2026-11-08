"""The services Squawk and the agents rely on, for the simulated hall: what each one
depends on, the features we use, and how we test each feature from our side
(agents/DEPENDENCY_AGENT.md).

SERVICES and FEATURES are part of the map Squawk keeps, like a rack's feed
chains. SimulatedServices is the outside world: each dependency's true state, which the
services never report (their own health check always says "up"). Only our tests reveal
it, and Squawk only knows what those tests recorded.
"""

from __future__ import annotations

from dataclasses import dataclass

TEST_INTERVAL = 5  # simulated minutes between scheduled tests
READING_MAX_AGE = 5  # building management readings must be younger than this
LIST_MAX_AGE = 15  # the revoked-key list must be younger than this
CDUS_PER_GATEWAY = 8


@dataclass(frozen=True)
class Service:
    id: str
    name: str
    depends_on: tuple[str, ...]


@dataclass(frozen=True)
class Feature:
    id: str
    service: str
    name: str
    needs: tuple[str, ...]  # dependencies it can't work without
    test: str  # delivery | reading_age | list_age
    used_by: tuple[str, ...]
    covers: tuple[str, ...] = ()  # parts whose state it reports


SERVICES: dict[str, Service] = {
    s.id: s
    for s in (
        Service("paging", "Paging service", ("sms-gateway", "email-relay")),
        Service("bms", "Building management system", tuple(f"fieldbus-{g}" for g in range(1, 5))),
        Service("keys", "Key service", ("key-db", "revocation-feed")),
    )
}

FEATURES: dict[str, Feature] = {
    f.id: f
    for f in (
        Feature("paging.text", "paging", "Text paging", ("sms-gateway",), "delivery", ("fixer: send a tech", "notices to tenants and the shift lead")),
        Feature("paging.email", "paging", "Email paging", ("email-relay",), "delivery", ("fallback when text paging is down",)),
        *(
            Feature(
                f"bms.cooling.{g}",
                "bms",
                f"CDU readings through gateway {g}",
                (f"fieldbus-{g}",),
                "reading_age",
                ("Squawk backup margins",),
                tuple(f"cdu-{c}" for c in range((g - 1) * CDUS_PER_GATEWAY + 1, g * CDUS_PER_GATEWAY + 1)),
            )
            for g in range(1, 5)
        ),
        Feature("keys.revocation", "keys", "Refusing revoked keys", ("revocation-feed",), "list_age", ("every Squawk call",)),
    )
}

DEPENDENCIES: tuple[str, ...] = tuple(dict.fromkeys(d for s in SERVICES.values() for d in s.depends_on))


def feature_covering(part: str) -> str | None:
    """The feature that reports this part's state, if any (a CDU's gateway feature)."""
    return next((f.id for f in FEATURES.values() if part in f.covers), None)


class SimulatedServices:
    """The outside world. The scenario breaks dependencies here; nothing announces it."""

    def __init__(self) -> None:
        self.state = {d: "ok" for d in DEPENDENCIES}
        self.down_since: dict[str, int] = {}

    def says(self, service: str) -> str:
        return "up"  # a gray failure: the service's own health check never notices

    def set_dependency(self, dependency: str, state: str, now: int) -> None:
        self.state[dependency] = state
        if state == "ok":
            self.down_since.pop(dependency, None)
        else:
            self.down_since.setdefault(dependency, now)

    def probe(self, feature_id: str, now: int) -> tuple[bool, str]:
        """Exercise the feature the way we use it, from our side. Returns (passed, detail)."""
        f = FEATURES[feature_id]
        service = SERVICES[f.service].name
        down = [d for d in f.needs if self.state[d] != "ok"]
        if f.test == "delivery":
            channel = f.id.split(".")[1]
            if down:
                return False, f"{service} says it's up, but a test page by {channel} wasn't delivered within 2 min."
            return True, f"Test page by {channel} delivered."
        age = max((now - self.down_since[d] for d in down), default=0)
        limit, what = (READING_MAX_AGE, "newest CDU reading") if f.test == "reading_age" else (LIST_MAX_AGE, "revoked-key list")
        if age >= limit:
            return False, f"{service} says it's up, but its {what} is {age} min old (limit {limit})."
        return True, f"The {what} is {age} min old."
