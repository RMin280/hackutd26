"""Check the agent setup: Python, packages, each model tier in order (our Nemotron on
Brev, then Nemotron 3.5 Super (free) and Nemotron 3 Ultra (free) on OpenRouter), a real
tool-call round trip, and (optionally) the SpacetimeDB database.

    .venv\\Scripts\\python -m agents.check_setup     # PowerShell
    .venv/Scripts/python -m agents.check_setup       # Git Bash
    ... --no-llm    skip all model requests
    ... --all       run the round trip on every ready tier, not just the first

With LLM_FREE_ONLY=true only the free tiers are checked, and Brev is never contacted.
Exits 0 when the agents can run: some tier works and the last tier is ready. A broken last
tier always fails the check, since it's what keeps the demo running when the others drop.
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
import time
from pathlib import Path
from typing import Any, Callable

REQUIRED_PACKAGES = ("openai", "httpx", "dotenv", "pydantic", "mcp")

# A stand-in for the real check_risk tool (DESIGN.md §8), just to prove tool calling works.
CHECK_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "check_risk",
        "description": "Backup margins, unprotected parts and active leases for a rack, row or job.",
        "parameters": {
            "type": "object",
            "properties": {
                "scope": {"type": "string", "description": "A rack, row or job id, e.g. rack-r3-07"},
            },
            "required": ["scope"],
        },
    },
}
FAKE_RESULT = {
    "scope": "rack-r3-07",
    "margin": 1,
    "level": "green",
    "active_leases": [],
    "reason": "Both power feeds and both cooling feeds are working: full backup.",
}


class Report:
    def __init__(self) -> None:
        self.failed = False
        self.warned = False

    def ok(self, msg: str) -> None:
        print(f"[ok]   {msg}")

    def fail(self, msg: str, fix: str = "") -> None:
        self.failed = True
        self._print("[FAIL]", msg, fix)

    def warn(self, msg: str, fix: str = "") -> None:
        self.warned = True
        self._print("[!!]  ", msg, fix)

    def skip(self, msg: str, fix: str = "") -> None:
        self._print("[--]  ", msg, fix)

    def info(self, msg: str) -> None:
        print(f"       {msg}")

    @staticmethod
    def _print(tag: str, msg: str, fix: str) -> None:
        print(f"{tag} {msg}")
        if fix:
            print(f"       -> {fix}")


def check_python(r: Report) -> None:
    v = sys.version_info
    if v >= (3, 11):
        r.ok(f"Python {v.major}.{v.minor}.{v.micro}")
    else:
        r.fail(f"Python {v.major}.{v.minor} found; 3.11+ needed", "uv venv .venv --python 3.11")


def check_packages(r: Report) -> bool:
    missing = []
    for name in REQUIRED_PACKAGES:
        try:
            importlib.import_module(name)
        except ImportError:
            missing.append(name)
    if missing:
        r.fail(
            f"Missing packages: {', '.join(missing)}",
            "uv pip install -r requirements.txt   (or: pip install -r requirements.txt)",
        )
        return False
    import openai

    r.ok(f"Packages installed (openai {openai.__version__})")
    return True


def check_openrouter(ep: Any, env_file: Path, bad: Callable[..., None], r: Report) -> bool:
    """Key accepted, free-model quota, and the model is live with tool calling. No model requests."""
    import httpx

    if not ep.api_key:
        where = ".env" if env_file.exists() else ".env (copy .env.example to .env first)"
        bad(f"{ep.role}: OPENROUTER_API_KEY is empty", f"Create a key at https://openrouter.ai/settings/keys and paste it into {where}")
        return False
    if not ep.api_key.startswith("sk-or-"):
        bad(f"{ep.role}: OPENROUTER_API_KEY doesn't look like an OpenRouter key", "It starts with sk-or-; re-copy it from https://openrouter.ai/settings/keys")
        return False
    try:
        key = httpx.get(f"{ep.base_url}/key", headers={"Authorization": f"Bearer {ep.api_key}"}, timeout=15)
        model = httpx.get(f"{ep.base_url}/models/{ep.model}/endpoints", timeout=15)
    except httpx.HTTPError as exc:
        bad(f"{ep.role}: couldn't reach OpenRouter ({type(exc).__name__})", "Check the network connection")
        return False
    if key.status_code == 401:
        bad(f"{ep.role}: OpenRouter rejected the key (401)", "Re-copy OPENROUTER_API_KEY into .env")
        return False
    if key.status_code != 200:
        bad(f"{ep.role}: OpenRouter key check returned {key.status_code}")
        return False
    endpoints = ((model.json().get("data") or {}).get("endpoints") or []) if model.status_code == 200 else []
    if not endpoints:
        bad(f"{ep.role}: OpenRouter has no live endpoint for {ep.model}", "Check the model name in .env")
        return False
    if not any("tools" in (e.get("supported_parameters") or []) for e in endpoints):
        bad(f"{ep.role}: {ep.model} doesn't list tool calling", "The agents need tools; pick another model")
        return False

    r.ok(f"{ep.role}: OpenRouter key accepted; {ep.model} is live with tool calling")
    daily = (key.json().get("data") or {}).get("free_model_daily_requests") or {}
    if daily:
        r.info(f"Free-model requests today: {daily.get('used')} used of {daily.get('limit')} ({daily.get('remaining')} left; resets 00:00 UTC)")
    else:
        r.info("Free-model limits: 20/min and 50/day (1,000/day once 10 credits are bought)")
    return True


def check_server(ep: Any, bad: Callable[..., None], r: Report) -> bool:
    """A NIM / vLLM server (e.g. on Brev): reachable, and serving the configured model."""
    import httpx

    var = f"{ep.role.upper()}_MODEL"
    local = any(h in ep.base_url for h in ("localhost", "127.0.0.1"))
    headers = {"Authorization": f"Bearer {ep.api_key}"} if ep.api_key else {}
    try:
        resp = httpx.get(f"{ep.base_url}/models", headers=headers, timeout=10)
    except httpx.HTTPError as exc:
        fix = (
            "Start the Brev machine, then in Ubuntu run `brev port-forward <machine> --port 8000:8000`"
            if local
            else "Check the base URL and that the server is running"
        )
        bad(f"{ep.role}: no model server answers at {ep.base_url} ({type(exc).__name__})", fix)
        return False
    if resp.status_code in (401, 403):
        bad(f"{ep.role}: {ep.base_url} rejected the API key ({resp.status_code})", f"Check {ep.role.upper()}_API_KEY in .env")
        return False
    if resp.status_code != 200:
        if not ep.model:
            bad(f"{ep.role}: {var} is empty and the server doesn't list its models", f"Set {var} in .env")
            return False
        r.skip(f"{ep.role}: server doesn't list models ({resp.status_code}); the round trip will confirm {ep.model}")
        return True
    served = [str(m.get("id")) for m in (resp.json().get("data") or [])]
    if ep.model not in served:
        bad(f"{ep.role}: {ep.model or f'{var} (empty)'} isn't served at {ep.base_url}", f"Set {var} to one of: {', '.join(served) or 'none listed'}")
        return False
    r.ok(f"{ep.role}: {ep.base_url} serves {ep.model}")
    return True


def check_round_trip(ep: Any, settings: Any, bad: Callable[..., None], r: Report) -> bool:
    """Two real requests: the model calls a tool, then answers from the tool's result."""
    from .llm import EndpointNotConfigured, complete, describe_error, history_entry, make_client

    try:
        client = make_client(ep, timeout=180, max_retries=0)  # no unchecked retries
    except EndpointNotConfigured as exc:
        bad(f"{ep.role}: {exc}")
        return False
    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": (
                "You are a datacenter operations agent connected to Squawk. "
                "Always check with a tool before answering. Answer in one short sentence."
            ),
        },
        {"role": "user", "content": "Can a technician work on rack-r3-07 right now? Check it first."},
    ]

    from .budget import Budget, BudgetExceeded

    budget = Budget(settings.budget, settings.usage_file or None, paid_fallbacks=bool(settings.fallback_models))  # these count too
    t0 = time.perf_counter()
    try:
        held = budget.check(ep, messages, 2048)
        try:
            first = complete(client, ep, settings, messages, tools=[CHECK_TOOL], max_tokens=2048)
        except Exception:
            budget.settle(ep, held, failed=True)
            raise
        budget.settle(ep, held, first)
    except BudgetExceeded as exc:
        bad(f"{ep.role}: {exc}")
        return False
    except Exception as exc:  # noqa: BLE001 - report any client error in plain words
        bad(f"{ep.role}: model request failed", describe_error(exc, ep))
        return False
    msg = first.choices[0].message
    if not msg.tool_calls:
        bad(f"{ep.role}: the model answered without calling the tool", "Retry once; if it repeats, raise AGENT_REASONING_EFFORT")
        return False
    call = msg.tool_calls[0]
    r.ok(f"{ep.role}: {first.model} called {call.function.name}({call.function.arguments}) in {time.perf_counter() - t0:.1f}s")

    messages.append(history_entry(msg))
    for c in msg.tool_calls:
        messages.append({"role": "tool", "tool_call_id": c.id, "content": json.dumps(FAKE_RESULT)})
    t1 = time.perf_counter()
    try:
        held = budget.check(ep, messages, 2048)
        try:
            second = complete(client, ep, settings, messages, tools=[CHECK_TOOL], max_tokens=2048)
        except Exception:
            budget.settle(ep, held, failed=True)
            raise
        budget.settle(ep, held, second)
    except Exception as exc:  # noqa: BLE001
        bad(f"{ep.role}: follow-up request failed", describe_error(exc, ep))
        return False
    answer = " ".join((second.choices[0].message.content or "").split())
    if not answer:
        bad(f"{ep.role}: the model returned an empty answer after the tool result")
        return False
    r.ok(f'{ep.role}: used the tool result in {time.perf_counter() - t1:.1f}s: "{answer[:160]}"')
    return True


def check_endpoint(ep: Any, settings: Any, env_file: Path, r: Report, *, soft: bool, round_trip: bool) -> bool:
    bad = r.warn if soft else r.fail
    ready = check_openrouter(ep, env_file, bad, r) if ep.is_openrouter else check_server(ep, bad, r)
    if ready and round_trip:
        ready = check_round_trip(ep, settings, bad, r)
    return ready


def check_spacetime(r: Report, settings: Any) -> None:
    import httpx

    host, db = settings.spacetime_host, settings.spacetime_db
    try:
        ping = httpx.get(f"{host}/v1/ping", timeout=3)
    except httpx.HTTPError:
        if db:
            r.fail(f"SPACETIME_DB is set but no SpacetimeDB server answers at {host}", "Start it (`spacetime start`) or fix SPACETIME_HOST")
        else:
            r.skip(
                f"No SpacetimeDB server at {host} (optional until the backend module is published)",
                "Local: `spacetime start`. Remote: set SPACETIME_HOST and SPACETIME_DB in .env",
            )
        return
    r.ok(f"SpacetimeDB server answers at {host} (ping {ping.status_code})")
    if not db:
        r.skip("SPACETIME_DB not set", "Ask your teammate for the database name and add it to .env")
        return

    headers = {"Authorization": f"Bearer {settings.spacetime_token}"} if settings.spacetime_token else {}
    try:
        resp = httpx.get(f"{host}/v1/database/{db}/schema", params={"version": 9}, headers=headers, timeout=10)
    except httpx.HTTPError as exc:
        r.fail(f"Schema request failed ({type(exc).__name__})")
        return
    if resp.status_code == 404:
        r.fail(f"Database '{db}' not found on {host}", "Check SPACETIME_DB, or publish the module there")
        return
    if resp.status_code != 200:
        r.fail(f"Schema request returned {resp.status_code}: {resp.text[:200]}")
        return
    schema = resp.json()
    tables = [str(t.get("name")) for t in schema.get("tables", [])]
    reducers = [str(x.get("name")) for x in schema.get("reducers", [])]
    r.ok(f"Database '{db}': {len(tables)} tables, {len(reducers)} reducers")
    r.info("tables: " + (", ".join(tables) or "none"))
    r.info("reducers: " + (", ".join(reducers) or "none"))
    missing = [x for x in ("request_work", "release_work", "record_event", "diagnose_failure") if x not in reducers]
    if missing:
        r.fail(f"The module lacks the fixer's reducers: {', '.join(missing)}", "Publish the current module: bash dev.sh publish")
        return
    check_squawk_reads(r, settings)


def check_squawk_reads(r: Report, settings: Any) -> None:
    """The fixer's own reads through agents/squawk_http.py, with its token: the clock and the feed."""
    from .squawk import SquawkUnavailable
    from .squawk_http import HttpSquawk, identity_of

    if not settings.spacetime_token:
        r.fail("SPACETIME_TOKEN not set: the fixer has no identity", "Run: python -m agents.squawk_http setup")
        return
    try:
        who = identity_of(settings.spacetime_token)
    except ValueError:
        r.fail("SPACETIME_TOKEN isn't a SpacetimeDB token", "Run: python -m agents.squawk_http setup --new")
        return
    try:
        br = HttpSquawk.from_settings(settings)
        now, events = br.now, br.get_events(0)
    except SquawkUnavailable as exc:
        r.fail(f"The fixer can't read Squawk: {exc}")
        return
    last = f", newest seq {events[-1].seq}" if events else ""
    r.ok(f"Fixer reads Squawk as identity {who[:12]}…: clock T+{now}m, {len(events)} events in the feed{last}")
    r.info(f"Registration (fixer-agent, remediation_agent) is checked on its first action; `python -m agents.squawk_http setup` does it.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check the Squawk agent setup.")
    parser.add_argument("--no-llm", action="store_true", help="skip all model requests")
    parser.add_argument("--all", action="store_true", help="run the round trip on every ready tier, not just the first")
    args = parser.parse_args(argv)
    sys.stdout.reconfigure(errors="replace")  # type: ignore[attr-defined]  # model text on cp1252 consoles

    r = Report()
    print("Squawk agent setup check\n")
    check_python(r)
    if not check_packages(r):
        return 1

    from .config import ENV_FILE, load_settings

    try:
        settings = load_settings()
    except ValueError as exc:
        r.fail(str(exc))
        return 1
    tiers = settings.tiers
    print("\nModel tiers, tried in this order:")
    for i, t in enumerate(tiers, 1):
        print(f"  {i}. {t.role:<6} {t.provider} at {t.base_url}, model {t.model or '(not set)'}")
    if settings.free_only:
        print("  LLM_FREE_ONLY=true (testing): only the free OpenRouter tiers; Brev is never contacted.")
    print()

    trips = not args.no_llm
    serving = None  # the first tier that passes: the one the agents start on
    for i, t in enumerate(tiers):
        # A broken tier with another after it is a warning: the agents fail over past it.
        ready = check_endpoint(t, settings, ENV_FILE, r, soft=i < len(tiers) - 1, round_trip=trips and (args.all or serving is None))
        if ready and serving is None:
            serving = t
    if not trips:
        r.skip("Model round trips skipped (--no-llm)")
    if not tiers:
        r.fail("No model tier is enabled", "With LLM_FREE_ONLY=true, SUPER_MODEL and ULTRA_MODEL must end in :free")
    elif serving is None:
        r.failed = True
    elif serving is not tiers[0]:
        r.warn(f"{tiers[0].role} isn't ready, so the agents will start on {serving.role} until it is.")

    from .budget import Budget

    b = Budget(settings.budget, settings.usage_file or None).summary()
    lim = b["limits"]
    r.info(
        f"Credits: ${b['total_usd']:.4f} of ${lim.total_usd:.2f} spent ({b['total_requests']} requests); today ${b['today_usd']:.4f} of "
        f"${lim.daily_usd:.2f}, {b['today_requests']}/{lim.daily_requests} requests. Caps: AGENT_BUDGET_USD, AGENT_DAILY_BUDGET_USD."
    )
    check_spacetime(r, settings)

    if r.failed:
        print("\nSome checks failed: follow the -> lines above.")
    elif r.warned:
        print("\nThe agents can run; see the [!!] lines.")
    else:
        print("\nAll checks passed.")
    return 1 if r.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
