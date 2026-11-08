"""Contract tests for agents/squawk_http.py, the Squawk interface over SpacetimeDB's HTTP API.

The fixture (tests/fixtures/spacetime_maintenance.json, made by record_spacetime.py) holds what
the live backend answered to the fixer's reads after the maintenance scenario. The same calls
run against MockSquawk driven through the same story, and both must agree: the same hall, the
same issues for the fixer, the same blockers. The rest checks the wire format, the reducer
arguments, and failing closed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from agents.fixer.triage import FIXER, Issue, triage
from agents.mock_squawk import DEMO_ACTORS, JOB_ID, Actor, MockSquawk
from agents.squawk import Blocker, OutOfScope, SquawkUnavailable
from agents.squawk_http import HttpSquawk, HttpTransport, ReducerRefused, blocker, event_from_row, identity_of, q

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "spacetime_maintenance.json").read_text())
REQUESTER = "Facility tech"


class Replay:
    """Answers the recorded queries; any other read fails the test. Calls are only collected."""

    def __init__(self, queries: dict[str, list[dict[str, Any]]]) -> None:
        self.queries, self.calls = queries, []

    def sql(self, query: str) -> list[dict[str, Any]]:
        assert query in self.queries, f"unrecorded query: {query}"
        return self.queries[query]

    def call(self, reducer: str, args: list[Any]) -> None:
        self.calls.append((reducer, args))


def live() -> HttpSquawk:
    return HttpSquawk(Replay(FIXTURE["queries"]))


def mock_story() -> MockSquawk:
    """The backend's maintenance scenario on the simulated hall: the steps that reach the fixer
    (protection, the routine UPS-B refusal, the broken spare, the finished job). It skips the
    hot-aisle request and the PDU-R10-A swap, so Row 10 differs and isn't compared."""
    br = MockSquawk((*DEMO_ACTORS, Actor(REQUESTER, "cooling_agent")))
    br.protect("scheduler-agent", JOB_ID, 4 * 60)
    br.advance(10)
    br.request_lease(REQUESTER, target="ups-b", minutes=4 * 60, routine=True, note="Quarterly battery test")
    br.advance(20)
    br.set_node_state("node-1118", "failed")
    br.advance(60)
    br.set_job_status(JOB_ID, "finished")
    return br


def issues(br) -> list[Issue]:
    return [i for e in br.get_events(0) for i in triage(e, br) if isinstance(i, Issue)]


# ---------------------------------------------------------------- same hall, same answers


@pytest.mark.parametrize("node", ["node-1118", "node-1205", "node-1131", "node-417", "node-233", "node-1010"])
def test_nodes_match_the_simulated_hall(node):
    a, b = live().node(node), mock_story().node(node)
    assert (a.id, a.rack, a.row, a.owner, a.state) == (b.id, b.rack, b.row, b.owner, b.state)


def test_racks_and_feeds_match_the_simulated_hall():
    a, b = live(), mock_story()
    assert a.racks_below("cdu-3") == b.racks_below("cdu-3")
    assert sorted(a.racks_below("ups-b")) == sorted(b.racks_below("ups-b"))
    for rack in ("rack-r9-12", "rack-r9-14", "rack-r1-12", "rack-r2-14", "rack-r8-15"):
        ra, rb = a.rack(rack), b.rack(rack)
        assert (ra.row, ra.level, ra.power_margin, ra.cooling_margin, ra.margin) == (rb.row, rb.level, rb.power_margin, rb.cooling_margin, rb.margin)
        assert bool(ra.protected_by) == bool(rb.protected_by)
        assert ra.reason


def test_job_and_protection_match():
    a, b = live(), mock_story()
    ja, jb = a.job(JOB_ID), b.job(JOB_ID)
    assert (ja.status, ja.nodes, ja.since) == (jb.status, jb.nodes, jb.since) == ("finished", 0, 60)
    (pa,), (pb,) = a.protection_leases(JOB_ID), b.protection_leases(JOB_ID)
    assert pa.id.startswith("#") and pa.type == pb.type == "protection"
    assert (pa.job, pa.start, pa.end, len(pa.racks)) == (pb.job, pb.start, pb.end, len(pb.racks))


def test_the_fixer_sees_the_same_issues_on_both():
    a, b = live(), mock_story()
    ia, ib = issues(a), issues(b)
    assert [i.kind for i in ia] == [i.kind for i in ib] == ["maintenance_refused", "broken_node", "stale_protection"]
    refused_a, broken_a, stale_a = ia
    refused_b, broken_b, stale_b = ib
    # The refused UPS-B request waits on the protection lock, by its id in each backend.
    (lock_a,), (lock_b,) = a.protection_leases(JOB_ID), b.protection_leases(JOB_ID)
    assert refused_a.subject == refused_b.subject == "ups-b"
    assert refused_a.blockers == (Blocker("lease_ends", lock_a.id, 240),)
    assert refused_b.blockers == (Blocker("lease_ends", lock_b.id, 240),)
    assert refused_a.facts["requester"] == refused_b.facts["requester"] == REQUESTER
    assert refused_a.facts["minutes"] == refused_b.facts["minutes"] == 240
    assert broken_a.subject == broken_b.subject == "node-1118"
    assert broken_a.facts["owner"] == broken_b.facts["owner"] == "a free spare"
    assert (stale_a.subject, stale_b.subject) == (lock_a.id, lock_b.id)


def test_diagnosis_is_called_then_read_back():
    br = live()
    d = br.diagnose_failure("node-1118")
    assert br.t.calls == [("diagnose_failure", [["node-1118"]])]
    assert (d.node, d.classification, d.cause, d.at_risk) == ("node-1118", "isolated", None, ())
    assert d.send == "hardware tech to node-1118" and d.reason


def test_events_are_read_by_seq_in_order():
    events = live().get_events(0)
    assert [e.seq for e in events] == sorted(e.seq for e in events)
    assert {"lease_granted", "lease_denied", "approval_requested", "state_change", "job_status"} <= {e.type for e in events}


# ---------------------------------------------------------------- row mapping


def test_event_rows_are_normalized_to_the_contract():
    row = {
        "seq": 21,
        "at_min": 65,
        "actor": "fixer-agent",
        "type": "lease_released",
        "subject": "job-train-1",
        "reason": "Released.",
        "data": json.dumps({"lease": "7", "blockers": [{"ref": "#3", "text": "#3 ends", "end": 90}, {"ref": "cdu-3", "text": "CDU-3 repair", "end": None}], "earliest_safe": ""}),
    }
    e = event_from_row(row)
    assert (e.seq, e.time, e.subject) == (21, 65, "#7")  # a release is about the lease, as in MockSquawk
    assert e.data["about"] == "job-train-1"
    assert e.data["blockers"] == [{"kind": "lease_ends", "id": "#3", "until": 90}, {"kind": "part_repair", "id": "cdu-3", "until": None}]
    assert e.data["earliest_safe"] is None
    assert event_from_row({**row, "data": "not json"}).data == {}


def test_blockers():
    assert blocker("#12", 300) == Blocker("lease_ends", "#12", 300)
    assert blocker("cdu-3") == Blocker("part_repair", "cdu-3")
    assert blocker("tenant-gamma").kind == "lease_ends"


def test_sql_strings_are_quoted():
    assert q("node-1") == "'node-1'"
    assert q("x' OR '1'='1") == "'x'' OR ''1''=''1'"


def test_identity_comes_from_the_token_claims():
    import base64

    claims = base64.urlsafe_b64encode(json.dumps({"hex_identity": "ab" * 32}).encode()).decode().rstrip("=")
    assert identity_of(f"h.{claims}.s") == "ab" * 32
    with pytest.raises(ValueError):
        identity_of("not-a-token")


# ---------------------------------------------------------------- actions: reducer arguments


class Backend(Replay):
    """Replay plus a request_work that writes the row the real reducer would, with a set verdict."""

    def __init__(self, verdict: str = "allow", status: str = "active", blockers: tuple[str, ...] = ()) -> None:
        super().__init__({})
        self.verdict, self.status, self.blockers = verdict, status, list(blockers)

    def sql(self, query: str) -> list[dict[str, Any]]:
        if query.startswith("SELECT * FROM work WHERE ticket = "):
            reducer, a = self.calls[-1]
            return [self._work(42, a)]
        if query.startswith("SELECT id, kind, actor FROM work WHERE target = 'ups-b'"):
            return [{"id": 3, "kind": "facility_work", "actor": REQUESTER}]
        if query.startswith("SELECT id, kind, actor FROM work WHERE target"):
            return []
        if query == "SELECT end_min FROM work WHERE id = 1":
            return [{"end_min": 240}]
        if query.startswith("SELECT * FROM decision WHERE type = "):
            return [{"seq": 99, "at_min": 0, "actor": FIXER, "type": "notified", "subject": "ups-b", "reason": "", "data": "{}"}]
        raise AssertionError(f"unexpected query: {query}")

    def call(self, reducer: str, args: list[Any]) -> None:
        if reducer == "release_work" and args[0] == 13:
            raise ReducerRefused("Only Scheduler or a shift lead can release #13 while job-train-1 has not finished.")
        super().call(reducer, args)

    def _work(self, wid: int, a: list[Any]) -> dict[str, Any]:
        kind, target, _, minutes, dry, ticket, routine, note, behalf = a
        return {
            "id": wid, "ticket": ticket, "kind": kind, "target": target, "actor": behalf or FIXER, "status": "simulated" if dry else self.status,
            "verdict": self.verdict, "reason": f"{target}: {self.verdict}.", "earliest_safe": "T+4h" if self.verdict == "deny" else "",
            "blockers": self.blockers, "start_min": 60, "end_min": 60 + minutes, "racks": [], "job": "", "routine": routine, "note": note,
        }  # fmt: skip


def test_node_lease_is_a_node_repair_as_the_fixer():
    b = Backend()
    d = HttpSquawk(b).request_lease(FIXER, target="node-1118", minutes=240, note="isolated")
    assert b.calls[0] == ("request_work", ["node_repair", "node-1118", 0, 240, False, b.calls[0][1][5], False, "isolated", ""])
    assert d.granted and d.lease and d.lease.id == "#42" and d.lease.actor == FIXER and d.lease.end == 300


def test_rebooking_runs_as_the_requester_with_the_requests_kind():
    b = Backend(verdict="deny", status="denied", blockers=("#1",))
    br = HttpSquawk(b)
    check = br.simulate(FIXER, "ups-b")
    reducer, args = b.calls[0]
    assert (reducer, args[0], args[4], args[8]) == ("request_work", "facility_work", True, REQUESTER)
    assert (check.verdict, check.earliest_safe, check.blockers) == ("deny", "T+4h", (Blocker("lease_ends", "#1", 240),))
    d = br.request_lease(FIXER, target="ups-b", minutes=240, routine=True, on_behalf_of=REQUESTER)
    assert not d.granted and d.lease is None and b.calls[1][1][8] == REQUESTER


def test_approval_request_is_a_booking_that_waits_on_the_shift_lead():
    b = Backend(verdict="warn", status="needs_approval")
    d = HttpSquawk(b).request_approval(FIXER, "ups-b", 240, "160 racks one failure from an outage", requested_for=REQUESTER)
    assert d.ok and "shift lead" in d.reason
    assert b.calls[0][1][6:] == [True, "160 racks one failure from an outage", REQUESTER]


def test_agent_events_go_through_record_event():
    b = Backend()
    br = HttpSquawk(b)
    br.notify(FIXER, REQUESTER, "ups-b", "Booked.")
    br.escalate(FIXER, "node-233", "shift lead", "Not low.")
    br.record(FIXER, "agent", "ups-b", "Waiting.", status="waiting", plan={"steps": ["x" * 3000, "y" * 3000]})
    assert [c[1][0] for c in b.calls] == ["notified", "escalated", "agent"]
    assert json.loads(b.calls[0][1][3]) == {"to": REQUESTER, "message": "Booked."}
    assert len(b.calls[2][1][3]) <= 4000 and json.loads(b.calls[2][1][3])["status"] == "waiting"


def test_refused_release_is_a_decision_not_a_crash():
    br = HttpSquawk(Backend())
    assert not br.release_lease(FIXER, "#13").ok
    assert br.release_lease(FIXER, "#14", "finished").ok


def test_it_acts_only_as_its_own_actor():
    br = HttpSquawk(Backend())
    with pytest.raises(OutOfScope):
        br.request_lease("shift-lead", target="node-1", minutes=60)
    with pytest.raises(OutOfScope):
        br.record("scheduler-agent", "agent", "x", "y")


# ---------------------------------------------------------------- the wire, and failing closed


def transport(handler) -> HttpTransport:
    return HttpTransport("http://squawk.test", "squawk", "secret-token", client=httpx.Client(transport=httpx.MockTransport(handler)))


def test_sql_wire_format_becomes_dicts():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(url=str(request.url), body=request.content.decode())
        return httpx.Response(200, json=[{"schema": {"elements": [{"name": {"some": "id"}, "algebraic_type": {"U32": []}}, {"name": {"some": "now_min"}, "algebraic_type": {"U32": []}}]}, "rows": [[0, 75]]}])

    assert transport(handler).sql("SELECT * FROM clock") == [{"id": 0, "now_min": 75}]
    assert seen == {"url": "http://squawk.test/v1/database/squawk/sql", "body": "SELECT * FROM clock"}


def test_reducer_calls_send_a_json_array():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(url=str(request.url), body=json.loads(request.content), auth=request.headers.get("authorization"))
        return httpx.Response(200)

    t = HttpTransport("http://squawk.test", "squawk", "secret-token")
    t.client = httpx.Client(transport=httpx.MockTransport(handler), headers={"Authorization": "Bearer secret-token"})
    t.call("release_work", [7, "done"])
    assert seen == {"url": "http://squawk.test/v1/database/squawk/call/release_work", "body": [7, "done"], "auth": "Bearer secret-token"}


def test_a_reducer_error_is_a_refusal():
    t = transport(lambda r: httpx.Response(530, text="Unknown identity. Register first."))
    with pytest.raises(ReducerRefused, match="Unknown identity"):
        t.call("record_event", [])


@pytest.mark.parametrize(
    "handler",
    [
        lambda r: (_ for _ in ()).throw(httpx.ConnectError("refused")),
        lambda r: httpx.Response(404, text="`squawk` not found"),
        lambda r: httpx.Response(502),
    ],
    ids=["unreachable", "no database", "server error"],
)
def test_fails_closed_when_squawk_cant_be_read(handler):
    br = HttpSquawk(transport(handler))
    with pytest.raises(SquawkUnavailable) as err:
        br.get_events(0)
    assert "secret-token" not in str(err.value)
    with pytest.raises(SquawkUnavailable):
        br.release_lease(FIXER, "#1")
