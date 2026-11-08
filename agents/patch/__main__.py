"""Run the update agent: security advisories against the fleet, fixes rolled out in safe waves.

    python -m agents.patch --scripted          # live when SPACETIME_DB is set; scripted stand-in, no model requests
    python -m agents.patch                     # Nemotron plans each wave (credit caps from .env)
    python -m agents.patch --mock --scripted   # the simulated hall's storyline
    python -m agents.patch --once              # live: handle the feed and the advisories now, then exit
    python -m agents.patch --advisories FILE   # another advisory feed (same JSON shape as data/advisories.json)
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

from ..common.feed import describe
from ..config import load_settings
from ..squawk import SquawkUnavailable
from .fleet import DATA, Fleet, load_advisories
from .runner import PatchRunner
from .scripted import ScriptedModel
from .triage import UPDATER


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m agents.patch", description="Run the update agent.")
    p.add_argument("--scripted", action="store_true", help="scripted stand-in for Nemotron (no model requests)")
    p.add_argument("--mock", action="store_true", help="the simulated hall's storyline instead of the live backend")
    p.add_argument("--once", action="store_true", help="live: handle what's there now, then exit")
    p.add_argument("--interval", type=float, default=2.0, help="live: seconds between reads of the feed")
    p.add_argument("--advisories", type=Path, default=DATA / "advisories.json")
    p.add_argument("--inventory", type=Path, default=DATA / "inventory.json")
    args = p.parse_args(argv)
    sys.stdout.reconfigure(errors="replace")  # type: ignore[attr-defined]
    logging.basicConfig(level=logging.WARNING, format="         [model] %(message)s")

    settings = load_settings()
    if args.scripted:
        model = ScriptedModel()
        print("Model: scripted stand-in (no requests)")
    else:
        from ..llm import ModelRouter

        model = ModelRouter(settings)
        b = model.budget.summary()
        print(f"Model: primary {settings.primary.label}; credit cap ${b['limits'].total_usd:.2f} (${b['total_usd']:.4f} spent), ${b['limits'].daily_usd:.2f}/day")
    advisories = load_advisories(args.advisories)
    print(f"Advisories: {len(advisories)} ({', '.join(a.id for a in advisories)})")

    if args.mock or not settings.spacetime_db:
        from .demo import run_demo

        _, runner = run_demo(model)
        return _report(runner)

    from ..squawk_http import HttpSquawk

    try:
        br = HttpSquawk.from_settings(settings, UPDATER)
        last_now = br.now
    except SquawkUnavailable as exc:
        print(f"Squawk unavailable: {exc}. Failing closed: nothing is done.")
        return 1
    print(f"Squawk: {settings.spacetime_host}, database '{settings.spacetime_db}', acting as {br.actor}")
    runner = PatchRunner(br, model, advisories, Fleet.load(args.inventory, UPDATER))
    shown, down = 0, False
    while True:
        try:
            now = br.now
            if now < last_now:  # the hall was reset: start over from the new feed
                print(f"\n== The hall was reset (clock {last_now} -> {now}); starting over.")
                runner = PatchRunner(br, model, advisories, Fleet.load(args.inventory, UPDATER))
                runner.cursor = shown
            last_now = now
            for _ in range(2):  # a wave's own rows can matter to the next advisory
                runner.drain()
            for event in br.get_events(shown):
                if event.type != "simulated":
                    print(describe(event))
                shown = event.seq
            if down:
                print("Squawk is reachable again.")
            down = False
        except SquawkUnavailable as exc:
            if not down:
                print(f"Squawk unavailable ({exc}). Failing closed: acting on nothing until it's back.")
            down = True
            if args.once:
                return 1
        if args.once:
            return _report(runner)
        try:
            time.sleep(args.interval)
        except KeyboardInterrupt:
            return _report(runner)


def _report(runner: PatchRunner) -> int:
    print("\nRuns")
    for o in runner.outcomes:
        print(f"  {o.issue.subject:<20} {o.status:<13} {o.model_calls} model calls  {o.summary[:90]}")
    print(f"Model calls: {sum(o.model_calls for o in runner.outcomes)}")
    return 0 if all(o.status != "failed_closed" for o in runner.outcomes) else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
