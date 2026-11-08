"""Run every live agent against Squawk in one process: the fixer and the update agent, each
with its own identity, sharing one model router (so one credit ledger and one failover state).

    python -m agents --scripted     # no model requests
    python -m agents                # Nemotron (credit caps from .env)
    python -m agents --once         # handle what's in the feed now, then exit
"""

from __future__ import annotations

import argparse
import logging
import sys
import time

from .common.feed import describe
from .config import load_settings
from .fixer.runner import FixerRunner
from .fixer.scripted import ScriptedModel as FixerScript
from .patch.fleet import Fleet, load_advisories
from .patch.runner import PatchRunner
from .patch.scripted import ScriptedModel as PatchScript
from .patch.triage import UPDATER
from .squawk import SquawkUnavailable
from .squawk_http import FIXER_NAME, HttpSquawk


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m agents", description="Run the fixer and the update agent against the live backend.")
    p.add_argument("--scripted", action="store_true", help="scripted stand-ins, no model requests")
    p.add_argument("--once", action="store_true")
    p.add_argument("--interval", type=float, default=2.0)
    args = p.parse_args(argv)
    sys.stdout.reconfigure(errors="replace")  # type: ignore[attr-defined]
    logging.basicConfig(level=logging.WARNING, format="         [model] %(message)s")
    s = load_settings()
    if not s.spacetime_db:
        print("SPACETIME_DB isn't set in .env; for the offline storylines run `python -m agents.fixer --mock` or `python -m agents.patch --mock`.")
        return 1
    if args.scripted:
        fixer_model, patch_model = FixerScript(), PatchScript()
    else:
        from .llm import ModelRouter

        fixer_model = patch_model = ModelRouter(s)
        print(f"Model tiers: {s.tiers_label}")
    try:
        fixer_br, patch_br = HttpSquawk.from_settings(s, FIXER_NAME), HttpSquawk.from_settings(s, UPDATER)
        last_now = fixer_br.now
    except SquawkUnavailable as exc:
        print(f"Squawk unavailable: {exc}. Failing closed: nothing is done.")
        return 1
    print(f"Squawk: {s.spacetime_host}, database '{s.spacetime_db}': fixer-agent and update-agent")

    def fresh():
        return [FixerRunner(fixer_br, fixer_model), PatchRunner(patch_br, patch_model, load_advisories(), Fleet.load(actor=UPDATER))]

    runners, shown, down = fresh(), 0, False
    while True:
        try:
            now = fixer_br.now
            if now < last_now:
                print(f"\n== The hall was reset (clock {last_now} -> {now}); both agents start over.")
                runners = fresh()
                for r in runners:
                    r.cursor = shown
            last_now = now
            for _ in range(2):  # each agent's rows can matter to the other
                for r in runners:
                    r.drain()
            for e in fixer_br.get_events(shown):
                if e.type != "simulated":
                    print(describe(e))
                shown = e.seq
            down = False
        except SquawkUnavailable as exc:
            if not down:
                print(f"Squawk unavailable ({exc}). Failing closed until it's back.")
            down = True
        if args.once:
            break
        try:
            time.sleep(args.interval)
        except KeyboardInterrupt:
            break
    outcomes = [o for r in runners for o in r.outcomes]
    print(f"\n{len(outcomes)} runs, {sum(o.model_calls for o in outcomes)} model calls; failed closed: {sum(o.status == 'failed_closed' for o in outcomes)}")
    return 1 if down or any(o.status == "failed_closed" for o in outcomes) else 0


if __name__ == "__main__":
    raise SystemExit(main())
