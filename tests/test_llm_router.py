"""The model tiers, in order: our Nemotron on Brev, then Nemotron 3.5 Super (free) and
Nemotron 3 Ultra (free) on OpenRouter; LLM_FREE_ONLY keeps testing off Brev. Offline:
every server is faked with httpx.MockTransport."""

from __future__ import annotations

import json
import logging

import httpx
import openai
import pytest

from agents.config import OLD_MODEL_VARS, SUPER_FREE, ULTRA_FREE, Endpoint, Settings, load_settings
from agents.llm import ModelRouter, ModelUnavailable, make_client

BREV = Endpoint("brev", "openai_compatible", "http://localhost:8000/v1", "", "nvidia/nemotron-3-super-120b-a12b")
SUPER = Endpoint("super", "openrouter", "https://openrouter.ai/api/v1", "sk-or-test", SUPER_FREE)
ULTRA = Endpoint("ultra", "openrouter", "https://openrouter.ai/api/v1", "sk-or-test", ULTRA_FREE)
MODEL_VARS = (
    "LLM_FREE_ONLY", "BREV_BASE_URL", "BREV_API_KEY", "BREV_MODEL", "SUPER_MODEL", "ULTRA_MODEL", "OPENROUTER_API_KEY",
    "AGENT_FALLBACK_MODELS", "LLM_TIER_TIMEOUT", "LLM_PRIMARY_TIMEOUT", *OLD_MODEL_VARS,
)  # fmt: skip


def settings(*tiers: Endpoint, effort: str = "low") -> Settings:
    return Settings(
        tiers=tiers or (BREV, SUPER, ULTRA),
        fallback_models=(),
        reasoning_effort=effort,
        temperature=0.6,
        tier_timeout=60,
        failover_cooldown=120,
        spacetime_host="http://127.0.0.1:3000",
        spacetime_db="",
        spacetime_token="",
    )


def completion(model: str, text: str) -> dict:
    return {
        "id": "c",
        "object": "chat.completion",
        "created": 0,
        "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
    }


class FakeServer:
    """Answers chat completions, or fails in a chosen way. Records every request body."""

    def __init__(self, model: str, fail: str | None = None) -> None:
        self.model, self.fail, self.bodies = model, fail, []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.bodies.append(json.loads(request.content))
        if self.fail == "down":
            raise httpx.ConnectError("connection refused", request=request)
        if self.fail:
            return httpx.Response(int(self.fail), json={"error": {"message": "nope"}})
        return httpx.Response(200, json=completion(self.model, f"hello from {self.model}"))


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def servers(**fail: str | None) -> dict[str, FakeServer]:
    """One fake server per tier; brev="down" makes Brev unreachable, and so on."""
    return {t.role: FakeServer(t.model, fail.get(t.role)) for t in (BREV, SUPER, ULTRA)}


def router(fakes: dict[str, FakeServer], s: Settings | None = None, clock: Clock | None = None, sleeps: list[float] | None = None) -> ModelRouter:
    s = s or settings()
    clients = {
        t.role: make_client(t, max_retries=0, http_client=httpx.Client(transport=httpx.MockTransport(fakes[t.role])))
        for t in s.tiers
    }
    pauses = sleeps if sleeps is not None else []
    return ModelRouter(s, clock=clock or Clock(), sleep=pauses.append, clients=clients)


MSGS = [{"role": "user", "content": "hi"}]


def test_healthy_brev_serves_everything():
    fakes = servers()
    reply = router(fakes).chat(MSGS)
    assert reply.endpoint == BREV and reply.failover_reason is None
    assert reply.message.content == f"hello from {BREV.model}"
    assert len(fakes["brev"].bodies) == 1 and fakes["super"].bodies == [] and fakes["ultra"].bodies == []


@pytest.mark.parametrize("fail", ["down", "503", "429", "404", "401"])
def test_brev_outage_goes_to_super_not_ultra(fail):
    fakes = servers(brev=fail)
    reply = router(fakes).chat(MSGS)
    assert reply.endpoint == SUPER and reply.failover_reason.startswith("brev: ")
    assert reply.message.content == f"hello from {SUPER.model}"
    assert fakes["ultra"].bodies == []


def test_brev_and_super_down_ultra_serves():
    fakes = servers(brev="down", super="503")
    reply = router(fakes).chat(MSGS)
    assert reply.endpoint == ULTRA
    assert "brev: " in reply.failover_reason and "super: " in reply.failover_reason
    assert [len(f.bodies) for f in fakes.values()] == [1, 1, 1]


def test_failed_tier_is_skipped_during_its_cooldown_then_retried():
    clock, fakes = Clock(), servers(brev="down")
    r = router(fakes, clock=clock)
    r.chat(MSGS)
    reply = r.chat(MSGS)
    assert len(fakes["brev"].bodies) == 1  # the second call skipped Brev
    assert reply.endpoint == SUPER and "brev cooling down after: " in reply.failover_reason

    fakes["brev"].fail = None  # the Brev machine comes back
    clock.now = 121.0  # cooldown is 120 s
    assert r.chat(MSGS).endpoint == BREV
    assert len(fakes["brev"].bodies) == 2


def test_the_last_tier_has_no_cooldown():
    fakes = servers(super="503", ultra="503")
    r = router(fakes, settings(SUPER, ULTRA))
    with pytest.raises(ModelUnavailable):
        r.chat(MSGS)
    fakes["ultra"].fail = None  # Ultra recovers at once; Super is still cooling down
    assert r.chat(MSGS).endpoint == ULTRA
    assert len(fakes["super"].bodies) == 1 and len(fakes["ultra"].bodies) == 2


def test_free_requests_are_spaced_under_20_a_minute():
    clock, sleeps, fakes = Clock(), [], servers(brev="down")
    r = router(fakes, clock=clock, sleeps=sleeps)
    r.chat(MSGS)
    clock.now = 1.0
    r.chat(MSGS)
    assert sleeps == [2.0]  # 3 s spacing, 1 s already passed
    assert len(fakes["super"].bodies) == 2


def test_brev_is_not_paced():
    sleeps: list[float] = []
    r = router(servers(), sleeps=sleeps)
    r.chat(MSGS)
    r.chat(MSGS)
    assert sleeps == []


def test_bad_request_is_raised_not_failed_over():
    fakes = servers(brev="400")
    with pytest.raises(openai.BadRequestError):
        router(fakes).chat(MSGS)
    assert fakes["super"].bodies == [] and fakes["ultra"].bodies == []


def test_every_tier_down_is_model_unavailable():
    fakes = servers(brev="down", super="503", ultra="429")
    with pytest.raises(ModelUnavailable, match="brev: .*super: .*ultra: "):
        router(fakes).chat(MSGS)


def test_a_single_tier_down_is_model_unavailable():
    with pytest.raises(ModelUnavailable, match="ultra: "):
        router(servers(ultra="down"), settings(ULTRA)).chat(MSGS)


def test_no_tier_enabled_is_model_unavailable():
    s = Settings(**{**settings().__dict__, "tiers": ()})
    with pytest.raises(ModelUnavailable, match="No model tier"):
        ModelRouter(s, clock=Clock()).chat(MSGS)


def test_brev_without_model_name_fails_over_without_a_request():
    unnamed = Endpoint("brev", "openai_compatible", BREV.base_url, "", "")
    fakes = servers()
    s = settings(unnamed, SUPER, ULTRA)
    clients = {t.role: make_client(t, max_retries=0, http_client=httpx.Client(transport=httpx.MockTransport(fakes[t.role]))) for t in (SUPER, ULTRA)}
    reply = ModelRouter(s, clock=Clock(), sleep=lambda _: None, clients=clients).chat(MSGS)
    assert reply.endpoint == SUPER
    assert "BREV_MODEL is not set" in reply.failover_reason


def test_each_server_gets_only_its_own_extras():
    fakes = servers(brev="down")
    history = [
        {"role": "user", "content": "hi"},
        {
            "role": "assistant",
            "content": "ok",
            "reasoning_content": "vllm thoughts",
            "reasoning_details": [{"type": "reasoning.text", "text": "openrouter thoughts"}],
        },
        {"role": "user", "content": "again"},
    ]
    router(fakes, settings(effort="none")).chat(history)

    sent_to_brev, sent_to_openrouter = fakes["brev"].bodies[0], fakes["super"].bodies[0]
    # Brev (vLLM/NIM): Nemotron's own thinking switch, no reasoning fields in history.
    assert sent_to_brev["chat_template_kwargs"] == {"enable_thinking": False}
    assert "reasoning" not in sent_to_brev
    assert not {"reasoning_content", "reasoning_details"} & set(sent_to_brev["messages"][1])
    # OpenRouter: its unified reasoning param, and its own reasoning_details passed back.
    assert sent_to_openrouter["reasoning"] == {"effort": "none"}
    assert "chat_template_kwargs" not in sent_to_openrouter
    assert "reasoning_details" in sent_to_openrouter["messages"][1]
    assert "reasoning_content" not in sent_to_openrouter["messages"][1]


# Settings from the environment.


@pytest.fixture
def env(monkeypatch):
    """A clean model environment: nothing from the shell or .env leaks into these tests."""
    for name in MODEL_VARS:
        monkeypatch.delenv(name, raising=False)

    def set_env(**values: str) -> None:
        for k, v in values.items():
            monkeypatch.setenv(k, v)

    return set_env


def test_load_settings_full_chain_in_order(env):
    env(BREV_BASE_URL="http://localhost:8000/v1/", BREV_MODEL="nemotron-on-brev", OPENROUTER_API_KEY="sk-or-test")
    s = load_settings(env_file=None)
    assert s.tiers == (
        Endpoint("brev", "openai_compatible", "http://localhost:8000/v1", "", "nemotron-on-brev"),
        Endpoint("super", "openrouter", "https://openrouter.ai/api/v1", "sk-or-test", "nvidia/nemotron-3.5-super-vl:free"),
        Endpoint("ultra", "openrouter", "https://openrouter.ai/api/v1", "sk-or-test", "nvidia/nemotron-3-ultra-550b-a55b:free"),
    )
    assert not s.free_only


def test_free_only_leaves_brev_and_paid_fallbacks_out(env):
    env(LLM_FREE_ONLY="true", BREV_MODEL="nemotron-on-brev", OPENROUTER_API_KEY="sk-or-test", AGENT_FALLBACK_MODELS="nvidia/nemotron-3-super-120b-a12b")
    s = load_settings(env_file=None)
    assert [t.role for t in s.tiers] == ["super", "ultra"]
    assert s.free_only and s.fallback_models == ()
    assert "Brev is never called" in s.tiers_label


def test_free_only_never_sends_a_request_to_brev(env):
    env(LLM_FREE_ONLY="1", BREV_MODEL="nemotron-on-brev", OPENROUTER_API_KEY="sk-or-test")
    s = load_settings(env_file=None)
    fakes = servers()  # Brev is up and would answer, but must not be asked
    clients = {role: make_client(t, max_retries=0, http_client=httpx.Client(transport=httpx.MockTransport(fakes[role])))
               for role, t in (("brev", BREV), ("super", SUPER), ("ultra", ULTRA))}  # fmt: skip
    r = ModelRouter(s, clock=Clock(), sleep=lambda _: None, clients=clients)
    assert r.chat(MSGS).endpoint.role == "super"
    assert fakes["brev"].bodies == []


def test_free_only_leaves_out_a_paid_openrouter_model(env, caplog):
    env(LLM_FREE_ONLY="true", OPENROUTER_API_KEY="sk-or-test", SUPER_MODEL="nvidia/nemotron-3.5-super-vl")
    with caplog.at_level(logging.WARNING, logger="agents.config"):
        s = load_settings(env_file=None)
    assert [t.role for t in s.tiers] == ["ultra"]
    assert "isn't a :free model" in caplog.text


def test_free_only_must_be_true_or_false(env):
    env(LLM_FREE_ONLY="maybe")
    with pytest.raises(ValueError, match="LLM_FREE_ONLY"):
        load_settings(env_file=None)


def test_old_primary_backup_settings_are_ignored_with_a_warning(env, caplog):
    env(LLM_PROVIDER="openai_compatible", AGENT_MODEL="old-model", BACKUP_LLM_PROVIDER="openrouter", LLM_PRIMARY_TIMEOUT="45")
    with caplog.at_level(logging.WARNING, logger="agents.config"):
        s = load_settings(env_file=None)
    assert "AGENT_MODEL" in caplog.text and "BACKUP_LLM_PROVIDER" in caplog.text
    assert s.tiers[0].model == ""  # BREV_MODEL is what names Brev's model now
    assert s.tier_timeout == 45  # the old timeout name still works
