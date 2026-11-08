"""Run the fixer agent's storyline on the simulated hall.

    python -m agents.fixer              # Nemotron: Brev primary, OpenRouter free backup
    python -m agents.fixer --scripted   # scripted stand-in, no model requests
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
    parser = argparse.ArgumentParser(prog="python -m agents.fixer", description="Run the fixer agent on the simulated hall's storyline.")
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

    _, runner = run_demo(model)

    print("\nOutcomes")
    for o in runner.outcomes:
        served = ", ".join(o.served_by) or "-"
        print(f"  {o.issue.kind:<20} {o.issue.subject:<10} {o.status:<13} {o.model_calls} model calls  ({served})")
    return 0 if all(o.status != "failed_closed" for o in runner.outcomes) else 1


if __name__ == "__main__":
    raise SystemExit(main())
