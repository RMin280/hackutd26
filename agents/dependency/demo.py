"""The dependency agent's storyline on the simulated hall, with the fixer running
alongside. Services fail in ways they don't report; scheduled tests catch them; the two
agents work through Squawk and never talk to each other directly.

    T+41  SMS gateway down (paging still says up)      -> fixer's page at T+42 re-sent by email
    T+60  gateway 3 quiet (BMS still says up)          -> CDU-17..24 unknown, handed to the shift lead
    T+70  routine CDU-25 maintenance refused           -> fixer queues it until readings are fresh
    T+80  gateway 3 back                               -> recovery confirmed; fixer rechecks CDU-25
    T+95  revoked-key feed stalls                      -> fail closed, security owner paged
"""

from __future__ import annotations

from typing import Callable

from ..squawk import fmt_time
from ..common.feed import describe
from ..common.loop import Model
from ..common.runner import settle
from ..fixer.runner import FixerRunner
from ..mock_squawk import MockSquawk
from ..mock_services import SimulatedServices
from .runner import DependencyRunner

Step = Callable[[MockSquawk, SimulatedServices], None]


def _nothing(br: MockSquawk, world: SimulatedServices) -> None:
    pass


def _approve_cdu25(br: MockSquawk, world: SimulatedServices) -> None:
    asked = [e for e in br.events if e.type == "approval_requested" and e.subject == "cdu-25"]
    if asked:
        br.approve("shift-lead", asked[-1].data["approval"])


STORY: tuple[tuple[int, str, Step], ...] = (
    (0, "All services pass their tests. The fixer and the dependency agent are watching.", _nothing),
    (40, "Scheduled tests run; everything passes.", _nothing),
    (41, "The SMS gateway goes down. The paging service still says it's up.", lambda br, w: w.set_dependency("sms-gateway", "down", br.now)),
    (42, "node-1205, a free spare, fails. The fixer pages a hardware tech by text.", lambda br, w: br.set_node_state("node-1205", "failed")),
    (45, "Scheduled tests run.", _nothing),
    (60, "Gateway 3 goes quiet. The building management system still says it's up.", lambda br, w: w.set_dependency("fieldbus-3", "down", br.now)),
    (65, "Scheduled tests run.", _nothing),
    (
        70,
        "The cooling agent asks for routine maintenance on CDU-25.",
        lambda br, w: br.request_lease("cooling-agent", target="cdu-25", minutes=120, routine=True, note="Pump seal replacement."),
    ),
    (80, "Gateway 3 comes back.", lambda br, w: w.set_dependency("fieldbus-3", "ok", br.now)),
    (95, "The revoked-key feed stalls. The key service still says it's up.", lambda br, w: w.set_dependency("revocation-feed", "down", br.now)),
    (100, "The shift lead approves the CDU-25 maintenance.", _approve_cdu25),
    (110, "Scheduled tests run.", _nothing),
    (
        112,
        "The cooling agent asks for routine maintenance on CDU-9.",
        lambda br, w: br.request_lease("cooling-agent", target="cdu-9", minutes=60, routine=True, note="Filter swap."),
    ),
)


def run_demo(model: Model, out: Callable[[str], None] = print) -> tuple[MockSquawk, DependencyRunner, FixerRunner]:
    br, world = MockSquawk(), SimulatedServices()
    dependency, fixer = DependencyRunner(br, model, world), FixerRunner(br, model)
    shown = 0
    for at, caption, step in STORY:
        br.advance(at)
        out(f"\n== {fmt_time(at)}  {caption}")
        step(br, world)
        settle([dependency, fixer])
        for event in br.get_events(shown):
            out(describe(event))
            shown = event.seq
    return br, dependency, fixer
