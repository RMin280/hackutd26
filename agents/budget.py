"""Credit guard for model requests: the agents never spend more than the caps in .env.

Every request is checked *before* it is sent against a worst-case cost (prompt size plus
max_tokens at the endpoint's price), and its real cost is recorded after (OpenRouter
reports it; otherwise tokens x price). Once a daily or lifetime cap would be crossed, the
request is refused with BudgetExceeded, a ModelUnavailable: the agent fails closed and
the issue goes to a person, exactly as when both endpoints are down.

The ledger is a small JSON file (AGENT_USAGE_FILE, gitignored) shared by every agent
process on the machine, guarded by a lock file. check() reserves the worst case under the
lock and settle() replaces it with the real cost, so parallel agents can't both spend the
last dollar. Nothing here sees prompts or keys; it stores counts and dollars only.

Defaults keep a $60 account safe: $20 lifetime, $5 a day, 600 requests a day. Prices
default to a little above Nemotron 3 Super on OpenRouter (about $0.09 in / $0.45 out per
million tokens), so estimates err high. Free (:free) models and our own Brev server cost
nothing per token (Brev bills GPU hours, which this can't see).
"""

from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterator

if TYPE_CHECKING:
    from .config import Endpoint


class BudgetExceeded(RuntimeError):
    """A cap would be crossed. Raised as a ModelUnavailable by the router (fail closed)."""


@dataclass(frozen=True)
class Limits:
    total_usd: float = 20.0  # lifetime cap for this ledger
    daily_usd: float = 5.0
    daily_requests: int = 600
    price_in_per_m: float = 0.10  # USD per million prompt tokens
    price_out_per_m: float = 0.50  # USD per million completion tokens


def is_metered(endpoint: "Endpoint", paid_fallbacks: bool = False) -> bool:
    """Whether requests to this endpoint cost money per token. With OpenRouter fallback models
    configured, even a :free request may be served by a paid model, so it counts as metered."""
    local = any(h in endpoint.base_url for h in ("localhost", "127.0.0.1", "[::1]"))
    if local:
        return False  # a port-forwarded Brev server bills by the hour, not per token
    return paid_fallbacks or not endpoint.model.endswith(":free")


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _empty() -> dict[str, Any]:
    return {"total_usd": 0.0, "requests": 0, "days": {}}


class Budget:
    def __init__(self, limits: Limits = Limits(), path: str | Path | None = None, *, today=_today, paid_fallbacks: bool = False) -> None:
        self.limits, self.path, self._today = limits, Path(path) if path else None, today
        self.paid_fallbacks = paid_fallbacks
        self._memory = _empty()  # used when there is no ledger file (tests)

    # The router calls check before sending and settle after, around every request.

    def check(self, endpoint: "Endpoint", messages: list[dict[str, Any]], max_tokens: int) -> float:
        """Refuses a request whose worst case would cross a cap; otherwise reserves that worst case
        (and the request) in the ledger under the same lock, so parallel agents can't all spend
        the last dollar. Returns the reservation, to pass to settle()."""
        worst = self.worst_case(endpoint, messages, max_tokens)
        with self._ledger(write=True) as led:
            day = self._day(led)
            lim = self.limits
            if day["requests"] + 1 > lim.daily_requests:
                raise BudgetExceeded(f"Daily request cap reached ({lim.daily_requests}); raise AGENT_DAILY_REQUESTS to allow more.")
            if day["usd"] + worst > lim.daily_usd:
                raise BudgetExceeded(f"Daily credit cap reached (${day['usd']:.2f} of ${lim.daily_usd:.2f} spent today).")
            if led["total_usd"] + worst > lim.total_usd:
                raise BudgetExceeded(f"Credit cap reached (${led['total_usd']:.2f} of ${lim.total_usd:.2f} spent).")
            day["usd"] = round(day["usd"] + worst, 6)
            day["requests"] += 1
            led["total_usd"] = round(led["total_usd"] + worst, 6)
            led["requests"] += 1
        return worst

    def settle(self, endpoint: "Endpoint", reserved: float, completion: Any = None, *, failed: bool = False) -> float:
        """Replaces a reservation with the real cost. A request that failed after it may have been
        billed (a timeout, an empty reply) keeps its worst case; one refused before any work
        (connection, 401, 429) is refunded. Returns the cost kept."""
        if completion is not None:
            cost = self.cost_of(endpoint, completion, fallback=reserved)
        else:
            cost = reserved if failed else 0.0
        usage = getattr(completion, "usage", None)
        with self._ledger(write=True) as led:
            day = self._day(led)
            day["usd"] = round(max(0.0, day["usd"] - reserved + cost), 6)
            led["total_usd"] = round(max(0.0, led["total_usd"] - reserved + cost), 6)
            day["prompt_tokens"] = day.get("prompt_tokens", 0) + int(getattr(usage, "prompt_tokens", 0) or 0)
            day["completion_tokens"] = day.get("completion_tokens", 0) + int(getattr(usage, "completion_tokens", 0) or 0)
        return cost

    def record(self, endpoint: "Endpoint", completion: Any) -> float:
        """check + settle for a request that already happened (no reservation)."""
        return self.settle(endpoint, self.check(endpoint, [], 0), completion)

    def _day(self, led: dict[str, Any]) -> dict[str, Any]:
        return led["days"].setdefault(self._today(), {"usd": 0.0, "requests": 0, "prompt_tokens": 0, "completion_tokens": 0})

    # Costs.

    def worst_case(self, endpoint: "Endpoint", messages: list[dict[str, Any]], max_tokens: int) -> float:
        if not is_metered(endpoint, self.paid_fallbacks):
            return 0.0
        prompt_tokens = len(json.dumps(messages, default=str)) / 3  # errs high: ~4 chars per token
        return (prompt_tokens * self.limits.price_in_per_m + max_tokens * self.limits.price_out_per_m) / 1e6

    def cost_of(self, endpoint: "Endpoint", completion: Any, fallback: float = 0.0) -> float:
        usage = getattr(completion, "usage", None)
        reported = getattr(usage, "cost", None) if usage is not None else None
        if reported is None and usage is not None and getattr(usage, "model_extra", None):
            reported = usage.model_extra.get("cost")  # OpenRouter: the real charge in USD
        if isinstance(reported, (int, float)):
            return float(reported)  # whatever served it, a reported charge is recorded
        if not is_metered(endpoint, self.paid_fallbacks):
            return 0.0
        if usage is None:
            return fallback  # metered but unreported: keep the worst case
        p, c = int(usage.prompt_tokens or 0), int(usage.completion_tokens or 0)
        return (p * self.limits.price_in_per_m + c * self.limits.price_out_per_m) / 1e6

    def summary(self) -> dict[str, Any]:
        with self._ledger() as led:
            day = led["days"].get(self._today(), {"usd": 0.0, "requests": 0})
            return {  # spend includes reservations of requests in flight
                "today_usd": day["usd"],
                "today_requests": day["requests"],
                "total_usd": led["total_usd"],
                "total_requests": led["requests"],
                "limits": self.limits,
            }

    # The ledger file, under a lock shared by every agent process.

    @contextmanager
    def _ledger(self, write: bool = False) -> Iterator[dict[str, Any]]:
        if self.path is None:
            yield self._memory
            return
        with _locked(self.path.with_suffix(self.path.suffix + ".lock")):
            try:
                led = json.loads(self.path.read_text())
                if not isinstance(led, dict) or "days" not in led:
                    raise ValueError
            except FileNotFoundError:
                led = _empty()
            except ValueError:
                # A damaged ledger can't prove we're under the cap: refuse rather than reset it.
                raise BudgetExceeded(f"The usage ledger {self.path.name} is unreadable; fix or delete it deliberately.") from None
            yield led
            if write:
                tmp = self.path.with_suffix(".tmp")
                tmp.write_text(json.dumps(led, indent=1))
                os.replace(tmp, self.path)


@contextmanager
def _locked(lock: Path, timeout: float = 10.0) -> Iterator[None]:
    """A portable lock (Windows and Linux): exclusive creation of a lock file."""
    deadline = time.monotonic() + timeout
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except (FileExistsError, PermissionError):  # Windows reports a lock file being deleted as access denied
            try:  # a lock older than a minute was left by a crashed process
                if time.time() - lock.stat().st_mtime > 60:
                    lock.unlink(missing_ok=True)
                    continue
            except OSError:  # gone, or going: try again shortly
                pass
            if time.monotonic() > deadline:
                raise BudgetExceeded(
                    f"Couldn't lock the usage ledger in {timeout:.0f} s (another agent holds it, or its folder isn't writable); refusing to spend blind."
                ) from None
            time.sleep(0.05)
    try:
        yield
    finally:
        os.close(fd)
        lock.unlink(missing_ok=True)


def limits_from_env(get) -> Limits:
    d = Limits()
    return Limits(
        total_usd=float(get("AGENT_BUDGET_USD", str(d.total_usd))),
        daily_usd=float(get("AGENT_DAILY_BUDGET_USD", str(d.daily_usd))),
        daily_requests=int(get("AGENT_DAILY_REQUESTS", str(d.daily_requests))),
        price_in_per_m=float(get("MODEL_PRICE_IN_PER_M", str(d.price_in_per_m))),
        price_out_per_m=float(get("MODEL_PRICE_OUT_PER_M", str(d.price_out_per_m))),
    )
