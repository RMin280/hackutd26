"""The event loop every agent shares: read new Blast Radius events from a cursor and hand
each one to the agent's handle(). Agents never talk to each other; they react to each
other's events, so settle() keeps draining until no runner sees anything new.
"""

from __future__ import annotations

from typing import Any, Sequence

from ..blast_radius import BlastRadius, BlastRadiusUnavailable, Event
from .loop import Outcome


class EventRunner:
    def __init__(self, br: BlastRadius, actor: str) -> None:
        self.br, self.actor = br, actor
        self.cursor = 0  # last event handled
        self.outcomes: list[Outcome] = []

    def drain(self) -> list[Outcome]:
        """Handle every new event, including the ones our own actions cause, until quiet."""
        new = self.tick()
        while True:
            events = self.br.get_events(self.cursor)
            if not events:
                break
            for event in events:
                self.cursor = event.seq
                new += self.handle(event)
        new += self.after()
        return new

    def tick(self) -> list[Outcome]:
        """Runs before reading events: scheduled work, such as tests."""
        return []

    def handle(self, event: Event) -> list[Outcome]:
        raise NotImplementedError

    def after(self) -> list[Outcome]:
        """Runs once the events are drained: deadlines and the like."""
        return []

    def record(self, subject: str, reason: str, **data: Any) -> None:
        try:
            self.br.record(self.actor, "agent", subject, reason, **data)
        except BlastRadiusUnavailable:
            pass  # failing closed: the outcome still reaches the caller


def settle(runners: Sequence[EventRunner]) -> list[Outcome]:
    """Drain every runner until a full pass moves no cursor."""
    new: list[Outcome] = []
    while True:
        before = [r.cursor for r in runners]
        for r in runners:
            new += r.drain()
        if [r.cursor for r in runners] == before:
            return new
