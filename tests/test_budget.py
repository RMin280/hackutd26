"""The credit guard (agents/budget.py): no request is sent once a cap would be crossed, real
costs are recorded, a damaged ledger refuses rather than resetting, and the router fails
over to a free tier or fails closed."""

from __future__ import annotations

import json
import os
import threading
from types import SimpleNamespace

import pytest

from agents.budget import Budget, BudgetExceeded, Limits, is_metered
from agents.config import Endpoint, Settings
from agents.llm import ModelRouter, ModelUnavailable

PAID = Endpoint("super", "openrouter", "https://openrouter.ai/api/v1", "sk-or-test", "nvidia/nemotron-3-super-120b-a12b")
FREE = Endpoint("ultra", "openrouter", "https://openrouter.ai/api/v1", "sk-or-test", "nvidia/nemotron-3-ultra-550b-a55b:free")
BREV = Endpoint("brev", "openai_compatible", "http://localhost:8000/v1", "", "nemotron")
MSGS = [{"role": "user", "content": "x" * 3000}]


def completion(prompt=1000, out=500, cost=None):
    usage = SimpleNamespace(prompt_tokens=prompt, completion_tokens=out, model_extra={"cost": cost} if cost is not None else {})
    return SimpleNamespace(usage=usage)


def test_free_and_local_models_cost_nothing():
    assert not is_metered(FREE) and not is_metered(BREV) and is_metered(PAID)
    assert Budget().worst_case(FREE, MSGS, 4096) == 0


def test_requests_stop_before_the_cap_is_crossed():
    b = Budget(Limits(total_usd=0.01, daily_usd=1, daily_requests=100, price_in_per_m=1, price_out_per_m=1))
    for _ in range(4):
        b.settle(PAID, b.check(PAID, MSGS, 1000), completion(1000, 1000))  # $0.002 each
    with pytest.raises(BudgetExceeded, match="Credit cap"):
        b.check(PAID, MSGS, 1000)  # worst case would cross $0.01


def test_daily_request_cap_applies_even_to_free_models():
    b = Budget(Limits(daily_requests=2))
    for _ in range(2):
        b.settle(FREE, b.check(FREE, MSGS, 100), completion())
    with pytest.raises(BudgetExceeded, match="request cap"):
        b.check(FREE, MSGS, 100)


def test_the_reported_cost_wins_over_the_estimate():
    b = Budget(Limits(price_in_per_m=1, price_out_per_m=1))
    assert b.record(PAID, completion(1000, 1000, cost=0.5)) == 0.5
    assert b.summary()["total_usd"] == 0.5


def test_the_ledger_is_shared_and_a_damaged_one_refuses(tmp_path):
    path = tmp_path / "usage.json"
    one, two = Budget(path=path), Budget(path=path)
    one.record(PAID, completion(cost=0.25))
    two.record(PAID, completion(cost=0.25))
    assert json.loads(path.read_text())["total_usd"] == 0.5 and two.summary()["total_requests"] == 2
    path.write_text("{not json")
    with pytest.raises(BudgetExceeded, match="unreadable"):
        one.check(PAID, MSGS, 10)


def test_concurrent_agents_never_lose_a_charge(tmp_path):
    path = tmp_path / "usage.json"

    def spend():
        b = Budget(path=path)
        for _ in range(20):
            b.record(PAID, completion(cost=0.01))

    threads = [threading.Thread(target=spend) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert json.loads(path.read_text())["requests"] == 80


def test_a_lock_file_being_deleted_is_waited_for_not_raised(tmp_path, monkeypatch):
    real_open, opens = os.open, []

    def open_once_denied(path, flags, *args):
        opens.append(path)
        if len(opens) == 1:
            raise PermissionError(13, "Access is denied")  # Windows, while another agent deletes the lock
        return real_open(path, flags, *args)

    monkeypatch.setattr("agents.budget.os.open", open_once_denied)
    assert Budget(path=tmp_path / "usage.json").record(PAID, completion(cost=0.01)) == 0.01
    assert len(opens) >= 2


def settings(*tiers: Endpoint) -> Settings:
    return Settings(tiers, (), "low", 0.6, 30, 60, "", "", "", budget=Limits(total_usd=0.0001))


class NeverCalled:
    class chat:
        class completions:
            @staticmethod
            def create(**kwargs):
                raise AssertionError("a request was sent past the cap")


def test_the_router_fails_closed_without_sending_when_the_cap_is_reached():
    r = ModelRouter(settings(PAID), clients={"super": NeverCalled()})
    with pytest.raises(ModelUnavailable, match="Credit cap"):
        r.chat(MSGS)


def test_the_router_falls_back_to_a_free_tier_when_a_paid_tier_is_capped():
    sent = []

    class Free:
        class chat:
            class completions:
                @staticmethod
                def create(**kwargs):
                    from openai.types.chat import ChatCompletion

                    sent.append(kwargs["model"])
                    return ChatCompletion.model_validate(
                        {"id": "x", "object": "chat.completion", "created": 0, "model": kwargs["model"],
                         "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "ok"}}]}
                    )  # fmt: skip

    r = ModelRouter(settings(PAID, FREE), clients={"super": NeverCalled(), "ultra": Free()}, sleep=lambda s: None)
    reply = r.chat(MSGS)
    assert reply.endpoint == FREE and sent == [FREE.model] and "Credit cap" in (reply.failover_reason or "")


def test_a_reservation_holds_the_last_dollar_for_whoever_got_there_first(tmp_path):
    path = tmp_path / "usage.json"
    lim = Limits(total_usd=0.003, price_in_per_m=1, price_out_per_m=1)
    one, two = Budget(lim, path), Budget(lim, path)
    held = one.check(PAID, [], 2000)  # $0.002 reserved, not yet spent
    with pytest.raises(BudgetExceeded):
        two.check(PAID, [], 2000)  # the other agent sees the reservation
    one.settle(PAID, held, completion(0, 500))  # really cost $0.0005: the rest is released
    two.check(PAID, [], 2000)


def test_failed_requests_keep_or_refund_their_reservation():
    b = Budget(Limits(price_in_per_m=1, price_out_per_m=1))
    held = b.check(PAID, [], 1000)
    b.settle(PAID, held, failed=True)  # a timeout may be billed: kept
    assert b.summary()["total_usd"] == pytest.approx(held, abs=1e-5)
    b.settle(PAID, b.check(PAID, [], 1000))  # refused before any work: refunded
    assert b.summary()["total_usd"] == pytest.approx(held, abs=1e-5)
    b.settle(PAID, b.check(PAID, [], 1000), SimpleNamespace(usage=None))  # metered, no usage: worst case kept
    assert b.summary()["total_usd"] == pytest.approx(2 * held, abs=1e-5)


def test_free_models_with_paid_fallbacks_count_and_reported_costs_always_count():
    assert is_metered(FREE, paid_fallbacks=True)
    assert Budget().settle(FREE, 0.0, completion(cost=0.02)) == 0.02  # a :free request served by a paid fallback
