"""Run the fixer agent: against the live backend when SPACETIME_DB is set in .env, otherwise
on the simulated hall's storyline.

    python -m agents.fixer              # Nemotron: Brev, then the free Super and Ultra on OpenRouter
    python -m agents.fixer --scripted   # scripted stand-in, no model requests
    python -m agents.fixer --mock       # the simulated hall's storyline, even with SPACETIME_DB set
    python -m agents.fixer --once       # live: handle what's in the feed now, then exit
"""

from __future__ import annotations

import argparse
import logging
import sys
import time

from ..common.feed import describe
from ..common.loop import Outcome
from ..config import load_settings
from ..llm import ModelRouter
from ..squawk import SquawkUnavailable
from .demo import run_demo
from .runner import FixerRunner
from .scripted import ScriptedModel


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m agents.fixer", description="Run the fixer agent on the live backend or the simulated hall.")
    parser.add_argument("--scripted", action="store_true", help="use a scripted stand-in for Nemotron (no model requests)")
    parser.add_argument("--mock", action="store_true", help="run the simulated hall's storyline instead of the live backend")
    parser.add_argument("--once", action="store_true", help="live: handle the events in the feed now, then exit")
    parser.add_argument("--from-now", action="store_true", help="live: skip events already in the feed")
    parser.add_argument("--interval", type=float, default=2.0, help="live: seconds between reads of the feed (default 2)")
    args = parser.parse_args(argv)
    sys.stdout.reconfigure(errors="replace")  # type: ignore[attr-defined]
    logging.basicConfig(level=logging.WARNING, format="         [model] %(message)s")

    settings = load_settings()
    if args.scripted:
        model = ScriptedModel()
        print("Model: scripted stand-in (no requests)")
    else:
        model = ModelRouter(settings)
        print(f"Model tiers: {settings.tiers_label}")

    if args.mock or not settings.spacetime_db:
        if not args.mock:
            print("SPACETIME_DB isn't set, so this runs the simulated hall's storyline (--mock).")
        _, runner = run_demo(model)
        return _report(runner.outcomes)
    return live(model, settings, once=args.once, from_now=args.from_now, interval=args.interval)


def live(model, settings, *, once: bool, from_now: bool, interval: float) -> int:
    from ..squawk_http import HttpSquawk

    try:
        br = HttpSquawk.from_settings(settings)
        seen = br.get_events(0) if from_now else []
        start = seen[-1].seq if seen else 0
        last_now = br.now
    except SquawkUnavailable as exc:
        print(f"Squawk unavailable: {exc}. Failing closed: nothing is done.")
        return 1
    print(f"Squawk: {settings.spacetime_host}, database '{settings.spacetime_db}', acting as {br.actor}")
    runner = FixerRunner(br, model)
    runner.cursor = shown = start
    down = False
    while True:
        try:
            now = br.now
            if now < last_now:  # the hall was reset (scenario_start): old waits are void
                print(f"\n== The hall was reset (clock {last_now} -> {now}); dropping {len(runner.waiting)} queued requests.")
                runner.waiting.clear()
            last_now = now
            runner.drain()
            for event in br.get_events(shown):
                print(describe(event))
                shown = event.seq
            if down:
                print("Squawk is reachable again.")
            down = False
        except SquawkUnavailable as exc:
            if not down:
                print(f"Squawk unavailable ({exc}). Failing closed: acting on nothing until it's back.")
            down = True
            if once:
                return 1
        if once:
            return _report(runner.outcomes)
        try:
            time.sleep(interval)
        except KeyboardInterrupt:
            return _report(runner.outcomes)


def _report(outcomes: list[Outcome]) -> int:
    print("\nOutcomes")
    for o in outcomes:
        served = ", ".join(o.served_by) or "-"
        print(f"  {o.issue.kind:<20} {o.issue.subject:<10} {o.status:<13} {o.model_calls} model calls  ({served})")
    return 0 if all(o.status != "failed_closed" for o in outcomes) else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
