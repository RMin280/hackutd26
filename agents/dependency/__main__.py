"""Run the dependency agent's storyline on the simulated hall (the fixer runs alongside).

    python -m agents.dependency              # Nemotron: Brev primary, OpenRouter free backup
    python -m agents.dependency --scripted   # scripted stand-in, no model requests
"""

from __future__ import annotations

import argparse
import logging
import sys

from ..config import load_settings
from ..llm import ModelRouter
from .demo import run_demo
from .scripted import ScriptedModel


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m agents.dependency", description="Run the dependency agent's storyline on the simulated hall.")
    parser.add_argument("--scripted", action="store_true", help="use a scripted stand-in for Nemotron (no model requests)")
    args = parser.parse_args(argv)
    sys.stdout.reconfigure(errors="replace")  # type: ignore[attr-defined]
    logging.basicConfig(level=logging.WARNING, format="         [model] %(message)s")

    if args.scripted:
        model = ScriptedModel()
        print("Model: scripted stand-in (no requests)")
    else:
        settings = load_settings()
        model = ModelRouter(settings)
        backup = settings.backup.label if settings.backup else "none"
        print(f"Model: primary {settings.primary.label}; backup {backup}")

    _, dependency, fixer = run_demo(model)

    print("\nOutcomes")
    for agent, runner in (("dependency", dependency), ("fixer", fixer)):
        for o in runner.outcomes:
            served = ", ".join(o.served_by) or "-"
            print(f"  {agent:<11} {o.issue.kind:<23} {o.issue.subject:<16} {o.status:<13} {o.model_calls} model calls  ({served})")
    outcomes = dependency.outcomes + fixer.outcomes
    return 0 if all(o.status != "failed_closed" for o in outcomes) else 1


if __name__ == "__main__":
    raise SystemExit(main())
