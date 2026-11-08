"""The Squawk interface over SpacetimeDB's HTTP API: the live backend in place of MockSquawk.

Reads go to `POST /v1/database/<db>/sql`, actions to `POST /v1/database/<db>/call/<reducer>`
(a JSON array of arguments), with `Authorization: Bearer <SPACETIME_TOKEN>`. The token is one
SpacetimeDB identity, registered by the admin as `fixer-agent` with role `remediation_agent`
(`python -m agents.squawk_http setup`). Host, database and token come from .env
(agents/config.py), so the same code runs against a local server or Maincloud.

Reducers return no values, so a call whose answer the agent needs passes a `ticket` (or reads
its own newest row in the decision feed) and reads the row back. Every read is a lookup by key
or by an indexed column; events are read with `WHERE seq > ?`, never by polling whole tables.

The backend decides every verdict. This file only maps rows to the dataclasses in squawk.py
(DESIGN.md §8.4) and the agent's calls to reducer arguments. It fails closed: anything that
stops it from reading or writing Squawk raises SquawkUnavailable, and the agent acts on nothing.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any, Protocol

import httpx

from .squawk import (
    Blocker,
    Check,
    Decision,
    Diagnosis,
    Event,
    FeatureView,
    JobView,
    Lease,
    LeaseDecision,
    NodeView,
    OutOfScope,
    Owner,
    Page,
    RackView,
    SquawkUnavailable,
    label,
)

FIXER_NAME = "fixer-agent"
FIXER_ROLE = "remediation_agent"
# Each agent: its actor name, role and the .env variable that holds its own token.
AGENTS = {
    "fixer": (FIXER_NAME, FIXER_ROLE, "SPACETIME_TOKEN"),
    "update": ("update-agent", "update_agent", "SPACETIME_UPDATE_TOKEN"),
    # An external agent behind the MCP server: least privilege by default (setup --role to widen).
    "mcp": ("mcp-agent", "viewer", "SPACETIME_MCP_TOKEN"),
}
LIVE = ("active", "granted")
SOFTWARE_KINDS = ("sw_online", "sw_exclusive", "switch_firmware")  # work statuses that hold a lease
MAX_DATA = 4000  # record_event's limit on the JSON data, in characters


class ReducerRefused(RuntimeError):
    """A reducer rejected the call before doing anything (bad request, wrong role, not allowed).
    Nothing was written. Safety verdicts are not this: a deny is a committed row."""


# ---------------------------------------------------------------- transport


class Transport(Protocol):
    def sql(self, query: str) -> list[dict[str, Any]]: ...
    def call(self, reducer: str, args: list[Any]) -> None: ...


class HttpTransport:
    """SpacetimeDB's HTTP API. The token never appears in errors or logs."""

    def __init__(self, host: str, db: str, token: str, *, timeout: float = 10.0, client: httpx.Client | None = None) -> None:
        if not db:
            raise ValueError("SPACETIME_DB is not set")
        self.base = f"{host.rstrip('/')}/v1/database/{db}"
        self.host, self.db = host, db
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        self.client = client or httpx.Client(headers=headers, timeout=timeout)

    def sql(self, query: str) -> list[dict[str, Any]]:
        resp = self._post(f"{self.base}/sql", content=query.encode())
        if resp.status_code != 200:
            # A read we can't make is a Squawk we can't trust: fail closed.
            raise SquawkUnavailable(f"Squawk read failed ({resp.status_code}): {resp.text[:200]}")
        statements = resp.json()
        if not statements:
            return []
        first = statements[0]
        names = [_column(e) for e in first["schema"]["elements"]]
        return [dict(zip(names, (_value(v) for v in row))) for row in first["rows"]]

    def call(self, reducer: str, args: list[Any]) -> None:
        resp = self._post(f"{self.base}/call/{reducer}", json=args)
        if resp.status_code == 200:
            return
        if resp.status_code in (401, 403):
            raise OutOfScope(f"Squawk refused this identity for {reducer}: {resp.text[:200]}")
        if resp.status_code == 530 or 400 <= resp.status_code < 500 and resp.status_code != 404:
            raise ReducerRefused(resp.text.strip()[:300] or f"{reducer} refused ({resp.status_code})")
        raise SquawkUnavailable(f"Squawk call {reducer} failed ({resp.status_code}): {resp.text[:200]}")

    def _post(self, url: str, **kwargs: Any) -> httpx.Response:
        try:
            resp = self.client.post(url, **kwargs)
        except httpx.HTTPError as exc:
            raise SquawkUnavailable(f"Squawk unreachable at {self.host} ({type(exc).__name__})") from None
        if resp.status_code == 404:
            raise SquawkUnavailable(f"Database '{self.db}' not found on {self.host}")
        return resp


def _column(element: dict[str, Any]) -> str:
    name = element.get("name")
    return name.get("some", "") if isinstance(name, dict) else str(name or "")


def _value(v: Any) -> Any:
    # Options come as {"some": x} / {"none": []}; nothing the agents read uses them today.
    if isinstance(v, dict) and len(v) == 1:
        if "some" in v:
            return _value(v["some"])
        if "none" in v:
            return None
    return v


def q(text: str) -> str:
    """A SQL string literal."""
    return "'" + str(text).replace("'", "''") + "'"


# ---------------------------------------------------------------- row mapping


def lease_id(work_id: Any) -> str:
    """Work #12 is lease '#12', the same name the backend uses in its reasons and blockers."""
    return f"#{int(work_id)}"


def work_id(lease: str) -> int:
    m = re.fullmatch(r"#?(\d+)", str(lease).strip())
    if not m:
        raise ValueError(f"Not a Squawk lease id: {lease!r}")
    return int(m.group(1))


def blocker(ref: str, end: Any = None) -> Blocker:
    """Backend blocker {ref, text, end} -> squawk.Blocker. '#12' is a lease that has to end;
    any other ref is a part to repair, or a job/tenant that holds the nodes (it clears when
    that lease ends, so the fixer waits on it and hands off at its deadline)."""
    if ref.startswith("#"):
        return Blocker("lease_ends", ref, None if end is None else int(end))
    if ref.startswith(("job-", "tenant-")):
        return Blocker("lease_ends", ref, None)
    return Blocker("part_repair", ref)


def event_from_row(row: dict[str, Any]) -> Event:
    """A decision row as the agents' Event. Normalized to squawk.py's contract: lease ids are
    '#N', blockers are Blocker fields, an empty earliest_safe is None, and lease_released /
    lease_expired are about the lease (the backend's subject, a job or target, moves to `about`)."""
    try:
        data = json.loads(row.get("data") or "{}")
    except json.JSONDecodeError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    subject = str(row.get("subject") or "")
    if str(data.get("lease") or "").isdigit():
        data["lease"] = lease_id(data["lease"])
    if str(data.get("protection") or "").isdigit():
        data["protection"] = lease_id(data["protection"])
    if "blockers" in data:
        data["blockers"] = [
            {"kind": b.kind, "id": b.id, "until": b.until}
            for b in (blocker(str(x.get("ref", "")), x.get("end")) for x in data.get("blockers") or [] if isinstance(x, dict))
        ]
    if "earliest_safe" in data and not data["earliest_safe"]:
        data["earliest_safe"] = None
    if row.get("type") in ("lease_released", "lease_expired") and data.get("lease"):
        data["about"], subject = subject, data["lease"]
    return Event(
        seq=int(row["seq"]),
        time=int(row["at_min"]),
        type=str(row.get("type") or ""),
        actor=str(row.get("actor") or ""),
        subject=subject,
        reason=str(row.get("reason") or ""),
        data=data,
    )


def node_from_row(row: dict[str, Any]) -> NodeView:
    kind = row["owner_kind"] if row["owner_kind"] in ("job", "tenant", "free") else "free"
    return NodeView(row["id"], row["rack"], int(row["row_num"]), row["state"], Owner(kind, row["owner_id"] or ""))


def rack_from_rows(margin: dict[str, Any], row_num: int) -> RackView:
    protected = (lease_id(margin["protected_by"]),) if int(margin["protected_by"] or 0) else ()
    return RackView(
        id=margin["rack"],
        row=row_num,
        power_margin=int(margin["power"]),
        cooling_margin=int(margin["cooling"]),
        margin=int(margin["margin"]),
        level=margin["level"],
        protected_by=protected,
        reason=_margin_reason(margin),
    )


def _margin_reason(m: dict[str, Any]) -> str:
    # The margin table has no reason column yet (DESIGN.md §8.4), so it's written here, in
    # MockSquawk's words, from the backend's own numbers.
    if m["level"] == "green":
        return f"Full backup: {int(m['power']) + 1} working power feeds and {int(m['cooling']) + 1} working cooling feeds."
    if m["level"] == "yellow":
        parts = ", ".join(label(p) for p in m.get("unprotected") or []) or "one feed"
        return f"One failure from an outage: the only working feed runs through {parts}."
    down = " or ".join(k for k in ("power", "cooling") if int(m[k]) < 0)
    return f"No working {down} feed."


def lease_from_row(w: dict[str, Any]) -> Lease:
    protection = w["kind"] == "protection"
    return Lease(
        id=lease_id(w["id"]),
        type="protection" if protection else "maintenance",
        actor=w["actor"],
        start=int(w["start_min"]),
        end=int(w["end_min"]),
        target=None if protection else w["target"],
        racks=tuple(w.get("racks") or ()),
        job=w.get("job") or None,
        routine=bool(w.get("routine")),
        note=w.get("note") or "",
        kind=w.get("kind") or "",
    )


def diagnosis_from_row(node: str, d: dict[str, Any]) -> Diagnosis:
    return Diagnosis(
        node=node,
        classification="shared_cause" if d["classification"] == "shared_cause" else "isolated",
        cause=d.get("cause") or None,
        at_risk=tuple(d.get("at_risk") or ()),
        send=d.get("send") or "",
        reason=d.get("reason") or "",
    )


def _fit(data: dict[str, Any]) -> str:
    """JSON for record_event, cut to its 4,000-character limit by shortening long strings."""
    text = json.dumps(data, default=str)
    limit = 400
    while len(text) > MAX_DATA and limit >= 25:
        data = _shorten(data, limit)
        text = json.dumps(data, default=str)
        limit //= 2
    return text if len(text) <= MAX_DATA else json.dumps({"truncated": True})


def _shorten(v: Any, limit: int) -> Any:
    if isinstance(v, str):
        return v if len(v) <= limit else v[: limit - 1] + "…"
    if isinstance(v, dict):
        return {k: _shorten(x, limit) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_shorten(x, limit) for x in v]
    return v


# ---------------------------------------------------------------- the adapter


class HttpSquawk:
    """squawk.Squawk over a SpacetimeDB transport. One identity, one actor: calls made in any
    other actor's name are refused here, before they reach the backend."""

    def __init__(self, transport: Transport, actor: str = FIXER_NAME) -> None:
        self.t, self.actor = transport, actor

    @classmethod
    def from_settings(cls, settings: Any, actor: str = FIXER_NAME) -> "HttpSquawk":
        agent = next((k for k, (name, _, _) in AGENTS.items() if name == actor), None)
        if agent is None:  # never fall back to another agent's identity
            raise SquawkUnavailable(f"No identity is configured for actor {actor!r}.")
        var = AGENTS[agent][2]
        token = {"SPACETIME_TOKEN": settings.spacetime_token, "SPACETIME_UPDATE_TOKEN": settings.spacetime_update_token}.get(var) or os.getenv(var, "")
        if not settings.spacetime_db:
            raise SquawkUnavailable("SPACETIME_DB is not set in .env")
        if not token:
            raise SquawkUnavailable(f"{var} is not set in .env: run `python -m agents.squawk_http setup --agent {agent}`")
        return cls(HttpTransport(settings.spacetime_host, settings.spacetime_db, token), actor)

    # Reads -----------------------------------------------------------------------------

    @property
    def now(self) -> int:
        rows = self.t.sql("SELECT now_min FROM clock WHERE id = 0")
        return int(rows[0]["now_min"]) if rows else 0

    def get_events(self, since: int = 0) -> list[Event]:
        rows = self.t.sql(f"SELECT * FROM decision WHERE seq > {int(since)}")
        return [event_from_row(r) for r in sorted(rows, key=lambda r: int(r["seq"]))]

    def node(self, node_id: str) -> NodeView:
        return node_from_row(self._one(f"SELECT * FROM node WHERE id = {q(node_id)}", node_id))

    def rack(self, rack_id: str) -> RackView:
        margin = self._one(f"SELECT * FROM margin WHERE rack = {q(rack_id)}", rack_id)
        row = self._one(f"SELECT row_num FROM rack WHERE id = {q(rack_id)}", rack_id)
        return rack_from_rows(margin, int(row["row_num"]))

    def racks_below(self, part_id: str) -> list[str]:
        rows = self.t.sql(f"SELECT id, rack FROM downstream WHERE part = {q(part_id)}")
        return [r["rack"] for r in sorted(rows, key=lambda r: int(r["id"]))]

    def job(self, job_id: str) -> JobView:
        j = self._one(f"SELECT * FROM job WHERE id = {q(job_id)}", job_id)
        changes = self.t.sql(f"SELECT seq, at_min FROM decision WHERE type = 'job_status' AND subject = {q(job_id)}")
        since = int(max(changes, key=lambda r: int(r["seq"]))["at_min"]) if changes else 0
        status = j["status"] if j["status"] in ("running", "stopped", "finished") else "stopped"
        return JobView(job_id, status, int(j["nodes"]), since)

    def lease(self, lease: str) -> Lease | None:
        try:
            wid = work_id(lease)
        except ValueError:
            return None
        rows = self.t.sql(f"SELECT * FROM work WHERE id = {wid}")
        return lease_from_row(rows[0]) if rows and rows[0]["status"] in LIVE else None

    def leases_on(self, target: str) -> list[Lease]:
        rows = self.t.sql(f"SELECT * FROM work WHERE target = {q(target)} AND (status = 'active' OR status = 'granted')")
        return [lease_from_row(w) for w in sorted(rows, key=lambda w: int(w["id"])) if w["kind"] != "protection"]

    def protection_leases(self, job_id: str) -> list[Lease]:
        rows = self.t.sql(
            f"SELECT * FROM work WHERE kind = 'protection' AND job = {q(job_id)} AND (status = 'active' OR status = 'granted')"
        )
        return [lease_from_row(w) for w in sorted(rows, key=lambda w: int(w["id"]))]

    def failures_since(self, node_id: str, since: int) -> int:
        return len(self.t.sql(f"SELECT id FROM failure WHERE node = {q(node_id)} AND at_min >= {max(0, int(since))}"))

    def diagnose_failure(self, node_id: str) -> Diagnosis:
        self._call("diagnose_failure", [[node_id]])
        row = self._newest_own("diagnosis", node_id)
        if row is None or not str(row.data.get("diagnosis", "")).isdigit():
            raise SquawkUnavailable(f"Squawk diagnosed {node_id} but its diagnosis row can't be read back")
        d = self._one(f"SELECT * FROM diagnosis WHERE id = {int(row.data['diagnosis'])}", node_id)
        return diagnosis_from_row(node_id, d)

    def simulate(self, actor: str, target: str) -> Check:
        self._me(actor)
        kind, behalf = self._work_for(target)
        try:
            w = self._request_work(kind, target, 0, dry_run=True, routine=False, note="", on_behalf_of=behalf)
        except ReducerRefused as exc:
            return Check("deny", str(exc))
        return Check(w["verdict"], w["reason"], w["earliest_safe"] or None, self._blockers(w))

    # Dependency-agent reads: deferred with that agent (DESIGN.md §8.3); the module has no tables for them.

    def feature(self, feature_id: str) -> FeatureView:
        raise NotImplementedError("features are deferred with the dependency agent (DESIGN.md §8.3)")

    def features(self) -> list[FeatureView]:
        raise NotImplementedError("features are deferred with the dependency agent (DESIGN.md §8.3)")

    def pages_since(self, since: int, channel: str | None = None) -> list[Page]:
        raise NotImplementedError("pages are deferred with the dependency agent (DESIGN.md §8.3)")

    # Actions ---------------------------------------------------------------------------

    def request_lease(
        self,
        actor: str,
        *,
        target: str,
        minutes: int,
        routine: bool = False,
        note: str = "",
        on_behalf_of: str | None = None,
    ) -> LeaseDecision:
        self._me(actor)
        kind, _ = self._work_for(target)
        try:
            w = self._request_work(kind, target, minutes, dry_run=False, routine=routine, note=note, on_behalf_of=on_behalf_of or "")
        except ReducerRefused as exc:
            return LeaseDecision(False, "deny", str(exc))
        return self._decision(w)

    def request_work(
        self, actor: str, kind: str, target: str, *, minutes: int = 0, start_in: int = 0, note: str = ""
    ) -> LeaseDecision:
        """Software work booked as ourselves (the update agent). Squawk checks it like any request."""
        self._me(actor)
        if kind not in SOFTWARE_KINDS:
            raise OutOfScope(f"{kind} isn't software work; this agent books only {', '.join(SOFTWARE_KINDS)}.")
        try:
            w = self._request_work(kind, target, minutes, dry_run=False, routine=False, note=note, on_behalf_of="", start_in=start_in)
        except ReducerRefused as exc:
            return LeaseDecision(False, "deny", str(exc))
        return self._decision(w)

    def simulate_work(self, actor: str, kind: str, target: str) -> Check:
        self._me(actor)
        if kind not in SOFTWARE_KINDS:
            raise OutOfScope(f"{kind} isn't software work.")
        try:
            w = self._request_work(kind, target, 0, dry_run=True, routine=False, note="", on_behalf_of="")
        except ReducerRefused as exc:
            return Check("deny", str(exc))
        return Check(w["verdict"], w["reason"], w["earliest_safe"] or None, self._blockers(w))

    def nodes_in_row(self, row: int) -> list[NodeView]:
        rows = self.t.sql(f"SELECT * FROM node WHERE row_num = {int(row)}")
        return [node_from_row(r) for r in sorted(rows, key=lambda r: int(r.get("ord", 0)))]

    def free_spares(self) -> list[NodeView]:
        rows = self.t.sql("SELECT * FROM node WHERE owner_kind = 'free'")  # indexed: one query, not a hall scan
        ok = [r for r in rows if r["state"] == "ok" and not int(r.get("held_by") or 0)]
        return [node_from_row(r) for r in sorted(ok, key=lambda r: int(r.get("ord", 0)))]

    def _decision(self, w: dict[str, Any]) -> LeaseDecision:
        granted = w["status"] in LIVE
        return LeaseDecision(
            granted=granted,
            verdict=w["verdict"],
            reason=w["reason"],
            lease=lease_from_row(w) if granted else None,
            earliest_safe=w["earliest_safe"] or None,
            blockers=self._blockers(w),
        )

    def release_lease(self, actor: str, lease: str, note: str = "") -> Decision:
        self._me(actor)
        try:
            self._call("release_work", [work_id(lease), note])
        except (ReducerRefused, ValueError) as exc:
            return Decision(False, str(exc))
        return Decision(True, f"Released {lease}.")

    def request_approval(self, actor: str, target: str, minutes: int, summary: str, requested_for: str) -> Decision:
        """No separate reducer: a request booked for the requester that comes back `warn` waits
        in needs_approval, and the backend writes the approval_requested row (DESIGN.md §8.4)."""
        self._me(actor)
        kind, _ = self._work_for(target)
        try:
            w = self._request_work(kind, target, minutes, dry_run=False, routine=True, note=summary, on_behalf_of=requested_for)
        except ReducerRefused as exc:
            return Decision(False, str(exc))
        if w["status"] == "needs_approval":
            return Decision(True, f"Waiting on the shift lead (#{w['id']}). {w['reason']}")
        if w["status"] in LIVE:
            return Decision(True, f"Squawk allowed it outright and booked it for {requested_for} (#{w['id']}). {w['reason']}")
        return Decision(False, w["reason"])

    def dispatch_tech(self, actor: str, target: str, trade: str, note: str) -> Decision:
        reason = f"Sent a {trade} to {label(target)}."
        self.record(actor, "tech_dispatched", target, reason, trade=trade, note=note)
        return Decision(True, reason)

    def notify(self, actor: str, to: str, subject: str, message: str) -> Decision:
        reason = f"Told {to} about {label(subject)}."
        self.record(actor, "notified", subject, reason, to=to, message=message)
        return Decision(True, reason)

    def escalate(self, actor: str, subject: str, to: str, reason: str) -> Decision:
        self.record(actor, "escalated", subject, reason, to=to)
        return Decision(True, f"Handed to {to}.")

    def record(self, actor: str, type: str, subject: str, reason: str, **data: Any) -> Event:
        self._me(actor)
        try:
            self._call("record_event", [type, subject, reason, _fit(data)])
        except ReducerRefused as exc:
            raise OutOfScope(str(exc)) from None
        row = self._newest_own(type, subject)
        if row is None:
            raise SquawkUnavailable(f"Squawk recorded {type} on {subject} but the row can't be read back")
        return row

    def record_test(self, actor: str, feature_id: str, passed: bool, detail: str, service_says: str = "up") -> FeatureView:
        raise NotImplementedError("feature tests are deferred with the dependency agent (DESIGN.md §8.3)")

    def resend_page(self, actor: str, page_id: str, channel: str = "email") -> Decision:
        raise NotImplementedError("pages are deferred with the dependency agent (DESIGN.md §8.3)")

    # Helpers ---------------------------------------------------------------------------

    def _me(self, actor: str) -> None:
        if actor != self.actor:
            raise OutOfScope(f"This Squawk connection acts as {self.actor}, not {actor}.")

    def _call(self, reducer: str, args: list[Any]) -> None:
        self.t.call(reducer, args)

    def _one(self, query: str, what: str) -> dict[str, Any]:
        rows = self.t.sql(query)
        if not rows:
            raise KeyError(what)
        return rows[0]

    def _newest_own(self, type: str, subject: str) -> Event | None:
        """Our newest row of a type about a subject. Rows Squawk writes for us (a diagnosis)
        carry our name in data.by instead of actor."""
        rows = self.t.sql(f"SELECT * FROM decision WHERE type = {q(type)} AND subject = {q(subject)}")
        own = [e for e in map(event_from_row, rows) if self.actor in (e.actor, e.data.get("by"))]
        return max(own, key=lambda e: e.seq) if own else None

    def _work_for(self, target: str) -> tuple[str, str]:
        """The work kind for a target, and whom to check it as. A node is a node repair, done as
        ourselves. Anything else is the routine request someone else made on it, checked and
        booked as them (the fixer only rebooks others' requests: DESIGN.md §8.2)."""
        if target.startswith("node-"):
            return "node_repair", ""
        rows = self.t.sql(f"SELECT id, kind, actor FROM work WHERE target = {q(target)} AND routine = true")
        theirs = [w for w in rows if w["actor"] != self.actor and w["kind"] != "protection"]
        if not theirs:
            return "facility_work", ""
        w = max(theirs, key=lambda w: int(w["id"]))
        return w["kind"], w["actor"]

    def _request_work(
        self, kind: str, target: str, minutes: int, *, dry_run: bool, routine: bool, note: str, on_behalf_of: str, start_in: int = 0
    ) -> dict[str, Any]:
        ticket = f"{self.actor}-{uuid.uuid4().hex[:12]}"
        self._call("request_work", [kind, target, max(0, int(start_in)), max(0, int(minutes)), dry_run, ticket, routine, note, on_behalf_of])
        return self._one(f"SELECT * FROM work WHERE ticket = {q(ticket)}", ticket)

    def _blockers(self, w: dict[str, Any]) -> tuple[Blocker, ...]:
        out = []
        for ref in w.get("blockers") or []:
            end = None
            if ref.startswith("#") and ref[1:].isdigit():
                rows = self.t.sql(f"SELECT end_min FROM work WHERE id = {int(ref[1:])}")
                end = rows[0]["end_min"] if rows else None
            out.append(blocker(ref, end))
        return tuple(out)


# ---------------------------------------------------------------- setup: python -m agents.squawk_http setup


def _set_env(env_file: Path, values: dict[str, str]) -> None:
    """Sets keys in .env (created from .env.example if missing), keeping everything else."""
    example = env_file.parent / ".env.example"
    text = env_file.read_text() if env_file.exists() else (example.read_text() if example.exists() else "")
    for key, value in values.items():
        line = f"{key}={value}"
        text, n = re.subn(rf"(?m)^{re.escape(key)}=.*$", line.replace("\\", "\\\\"), text)
        if not n:
            text += ("" if text.endswith("\n") or not text else "\n") + line + "\n"
    env_file.write_text(text)
    os.environ.update(values)  # this process reads the new values too


def setup(argv: list[str] | None = None) -> int:
    from .config import ENV_FILE, load_settings

    parser = argparse.ArgumentParser(
        prog="python -m agents.squawk_http setup",
        description="Give an agent its own SpacetimeDB identity (token saved to .env, never shown) and register it with its role.",
    )
    parser.add_argument("--agent", choices=sorted(AGENTS), default="fixer", help="which agent: fixer (fixer-agent) or update (update-agent)")
    parser.add_argument("--server", default="local", help="the spacetime CLI's name for the server (local, maincloud)")
    parser.add_argument("--host", help="server URL, e.g. https://maincloud.spacetimedb.com; saved to .env as SPACETIME_HOST")
    parser.add_argument("--db", help="database name; saved to .env as SPACETIME_DB")
    parser.add_argument("--new", action="store_true", help="get a new identity even if .env already has a token")
    parser.add_argument("--role", help="mcp only: the role to register the external agent with (default viewer: read only)")
    parser.add_argument("--name", help="mcp only: the actor name (default mcp-agent); also set SPACETIME_MCP_ACTOR to it")
    args = parser.parse_args(argv)
    name, role, var = AGENTS[args.agent]
    if args.agent == "mcp":
        role, name = args.role or role, args.name or name
    elif args.role or args.name:
        print("--role and --name are for --agent mcp; the fixer's and the update agent's roles are fixed.")
        return 1

    old_host = load_settings().spacetime_host
    if args.host:
        _set_env(ENV_FILE, {"SPACETIME_HOST": args.host.rstrip("/")})
    if args.db:
        _set_env(ENV_FILE, {"SPACETIME_DB": args.db})
    # A token only works on the server that issued it: a new server needs a new identity.
    switched = bool(args.host) and args.host.rstrip("/") != old_host
    settings = load_settings()
    db = args.db or settings.spacetime_db
    if not db:
        print("Set SPACETIME_DB in .env (or pass --db squawk) first.")
        return 1
    current = {"SPACETIME_UPDATE_TOKEN": settings.spacetime_update_token, "SPACETIME_TOKEN": settings.spacetime_token}.get(var, os.getenv(var, ""))
    token = "" if args.new or switched else current
    try:
        if token:
            who = identity_of(token)
        else:
            resp = httpx.post(f"{settings.spacetime_host}/v1/identity", timeout=10)
            resp.raise_for_status()
            token, who = resp.json()["token"], resp.json()["identity"]
            _set_env(ENV_FILE, {var: token})
            print(f"New identity for {name}; its token is saved in {ENV_FILE.name} as {var} (not shown).")
    except httpx.HTTPError as exc:
        print(f"Couldn't reach SpacetimeDB at {settings.spacetime_host} ({type(exc).__name__}). Is the server running?")
        return 1
    except (KeyError, ValueError) as exc:
        print(f"{var} in .env isn't a SpacetimeDB token ({exc}). Re-run with --new.")
        return 1
    if switched:
        others = [f"--agent {k}" for k, (_, _, v) in AGENTS.items() if v != var]
        print(f"The server changed, so the other agents' tokens in .env are for the old one: re-run setup with {', '.join(others)}.")

    cmd = ["spacetime", "call", "--server", args.server, db, "register_actor", who, name, role, "[]"]
    shown = " ".join(cmd[:-1]) + " '[]'"
    print(f"Identity: {who}")
    if not shutil.which("spacetime"):
        print(f"The spacetime CLI isn't on PATH. Ask the admin to run:\n  {shown}")
        return 1
    print(f"Registering it as {name} ({role}) with the CLI's identity, which must be the admin:\n  {shown}")
    done = subprocess.run(cmd, capture_output=True, text=True)
    if done.returncode != 0:
        print((done.stderr or done.stdout).strip()[-500:])
        print("Registration failed. Run the command above as the database's admin (the identity that published it), "
              "and make sure the module there knows the role (republish after pulling).")
        return 1
    print("Registered. Check it with: python -m agents.check_setup --no-llm")
    return 0


def identity_of(token: str) -> str:
    """The identity a SpacetimeDB token belongs to (its `hex_identity` claim). The token itself
    is never printed or logged."""
    try:
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (IndexError, ValueError) as exc:
        raise ValueError("not a JWT") from exc
    ident = str(claims.get("hex_identity") or "")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", ident):
        raise ValueError("no identity claim")
    return ident.lower()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "setup":
        raise SystemExit(setup(sys.argv[2:]))
    print("usage: python -m agents.squawk_http setup [--agent fixer|update|mcp] [--host URL] [--db NAME] [--server local|maincloud] [--new]")
    raise SystemExit(2)
