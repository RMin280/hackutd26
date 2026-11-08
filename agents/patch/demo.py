"""The update agent's storyline on the simulated hall: three advisories (a critical, exploited
monitoring-agent flaw; a GPU driver fix that needs newer BMC firmware first; a leaf switch
OS fix), rolled out in waves while job-train-1 trains, then the job finishes. Two driver
installs fail their post-install check (inventory.json's install_faults): the canary node-1029
passes on a retry, and node-1037 fails twice and is rolled back for a person."""

from __future__ import annotations

from typing import Callable

from ..common.feed import describe
from ..mock_squawk import JOB_ID, MockSquawk
from ..squawk import fmt_time
from .fleet import Fleet, load_advisories
from .runner import Model, PatchRunner

STORY: tuple[tuple[int, str, Callable[[MockSquawk], None]], ...] = (
    (0, "Three advisories arrive while job-train-1 trains on Rows 1-8.", lambda br: None),
    (95, "The first windows (canaries) have ended.", lambda br: None),
    (250, "Later waves end.", lambda br: None),
    (400, "job-train-1 finishes; its nodes return to the pool.", lambda br: br.set_job_status(JOB_ID, "finished")),
    (600, "Everything booked so far has run.", lambda br: None),
    (760, "The second driver wave has ended.", lambda br: None),
    (860, "The retry window on node-1037 has ended.", lambda br: None),
    (960, "The rollback window has ended.", lambda br: None),
)


def run_demo(model: Model, out: Callable[[str], None] = print) -> tuple[MockSquawk, PatchRunner]:
    br = MockSquawk()
    runner = PatchRunner(br, model, load_advisories(), Fleet.load())
    shown = 0
    for at, caption, step in STORY:
        br.advance(at)
        out(f"\n== {fmt_time(at)}  {caption}")
        step(br)
        for _ in range(3):  # a run's own events can unblock the next one
            runner.drain()
        for event in br.get_events(shown):
            if event.type not in ("simulated",):
                out(describe(event))
            shown = event.seq
    return br, runner
