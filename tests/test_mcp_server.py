"""The MCP server (agents/mcp_server.py): seven tools over the HTTP adapter, input checked,
rate limited, refusals returned as results, an unreachable Squawk kept as an error."""

from __future__ import annotations

import asyncio

import pytest

from agents.mcp_server import Gateway, RateLimited, build, refusals_as_results
from agents.squawk import SquawkUnavailable
from agents.squawk_http import HttpSquawk, ReducerRefused


class Backend:
    def __init__(self) -> None:
        self.calls: list = []

    def sql(self, query: str):
        if query.startswith("SELECT * FROM work WHERE ticket"):
            kind, target, *_ = self.calls[-1][1]
            return [{"id": 5, "ticket": "t", "kind": kind, "target": target, "actor": "mcp-agent", "status": "simulated", "verdict": "deny",
                     "reason": "CDU-4 is the only cooling feed.", "earliest_safe": "after CDU-3 repair", "blockers": ["cdu-3"],
                     "start_min": 0, "end_min": 0, "racks": [], "job": "", "routine": False, "note": ""}]  # fmt: skip
        if query.startswith("SELECT * FROM decision WHERE seq"):
            assert "LIMIT" in query or "seq > 0" not in query, "since=0 must be a bounded read"
            return []
        raise AssertionError(query)

    def call(self, reducer, args):
        self.calls.append((reducer, args))
        if reducer == "safe_placement":
            raise ReducerRefused("mcp-agent (viewer) is not allowed to ask for a placement.")


def gw(rate: int = 60) -> Gateway:
    return Gateway(HttpSquawk(Backend(), "mcp-agent"), rate=rate, clock=lambda: 0.0)


def test_the_seven_tools():
    names = [t.name for t in asyncio.run(build(gw()).list_tools())]
    assert names == ["check_risk", "simulate", "request_lease", "release_lease", "get_events", "diagnose_failure", "safe_placement"]


def test_simulate_maps_the_backends_answer():
    out = gw().simulate("facility_work", "CDU-4")
    assert (out["verdict"], out["granted"], out["earliest_safe"]) == ("deny", False, "after CDU-3 repair")
    assert out["blockers"] == [{"kind": "part_repair", "id": "cdu-3", "until": None}]


def test_bad_input_never_reaches_squawk():
    g = gw()
    for bad in ("cdu-4'; DROP TABLE work; --", "", "x" * 80, "../etc"):
        assert "error" in refusals_as_results(g.simulate)("facility_work", bad)
    assert "error" in refusals_as_results(g.simulate)("rm_rf", "cdu-4")
    assert g.br.t.calls == []


def test_refusals_come_back_as_results():
    assert refusals_as_results(gw().safe_placement)("job-train-1", 8) == {"refused": True, "reason": "mcp-agent (viewer) is not allowed to ask for a placement."}


def test_rate_limit():
    g = gw(rate=3)
    for _ in range(3):
        g.get_events(0)
    with pytest.raises(RateLimited):
        g.get_events(0)


def test_an_unreachable_squawk_stays_an_error():
    class Down:
        def sql(self, q):
            raise SquawkUnavailable("Squawk unreachable")

    g = Gateway(HttpSquawk(Down(), "mcp-agent"))
    with pytest.raises(SquawkUnavailable):
        refusals_as_results(g.get_events)(0)
