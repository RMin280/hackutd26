"""Records what the live backend answers to the fixer's reads during the maintenance scenario,
for tests/test_squawk_http.py. Needs a local server with the module published, the fixer's
identity in .env (`python -m agents.squawk_http setup`), and the spacetime CLI as admin.

    .venv/bin/python tests/fixtures/record_spacetime.py            # database from .env
    .venv/bin/python tests/fixtures/record_spacetime.py --db squawk-fixer-test

It runs `scenario_goto maintenance 6` (all seven steps; this resets that database's hall),
then the reads the fixer's triage makes, and writes tests/fixtures/spacetime_maintenance.json.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from agents.config import load_settings  # noqa: E402
from agents.fixer.triage import triage  # noqa: E402
from agents.squawk_http import HttpSquawk, HttpTransport  # noqa: E402

OUT = Path(__file__).with_name("spacetime_maintenance.json")
NODES = ("node-1118", "node-1205", "node-1131", "node-417", "node-233", "node-1010")


class Recorder(HttpTransport):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.queries: dict[str, list[dict[str, Any]]] = {}
        self.calls: list[list[Any]] = []

    def sql(self, query: str) -> list[dict[str, Any]]:
        rows = super().sql(query)
        self.queries[query] = rows
        return rows

    def call(self, reducer: str, args: list[Any]) -> None:
        self.calls.append([reducer, args])
        super().call(reducer, args)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db")
    parser.add_argument("--server", default="local")
    args = parser.parse_args()
    s = load_settings()
    db = args.db or s.spacetime_db
    subprocess.run(["spacetime", "call", "--server", args.server, db, "scenario_goto", "maintenance", "6"], check=True, capture_output=True)

    t = Recorder(s.spacetime_host, db, s.spacetime_token)
    br = HttpSquawk(t)
    events = br.get_events(0)
    for e in events:
        triage(e, br)  # the reads triage makes, including the fixer's diagnosis of node-1118
    for n in NODES:
        node = br.node(n)
        br.rack(node.rack)
        br.leases_on(n)
    for part in ("cdu-3", "ups-b"):
        br.racks_below(part)
    br.now
    OUT.write_text(json.dumps({"db_note": "recorded from the maintenance scenario, step 7", "queries": t.queries, "calls": t.calls}, indent=1) + "\n")
    print(f"Wrote {OUT.relative_to(ROOT)}: {len(t.queries)} queries, {len(t.calls)} calls")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
