"""Failover between the primary model (Nemotron on Brev) and the backup (Nemotron 3
Ultra free on OpenRouter). Offline: both servers are faked with httpx.MockTransport."""

from __future__ import annotations

import json

import httpx
import openai
import pytest

from agents.config import Endpoint, Settings, load_settings
from agents.llm import ModelRouter, ModelUnavailable, make_client

BREV = Endpoint("primary", "openai_compatible", "http://localhost:8000/v1", "", "nvidia/nemotron-3-super-120b-a12b")
OPENROUTER = Endpoint("backup", "openrouter", "https://openrouter.ai/api/v1", "sk-or-test", "nvidia/nemotron-3-ultra-550b-a55b:free")


def settings(backup: Endpoint | None = OPENROUTER, effort: str = "low") -> Settings:
    return Settings(
        primary=BREV,
        backup=backup,
        fallback_models=(),
        reasoning_effort=effort,
        temperature=0.6,
        primary_timeout=60,
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


def router(
    primary: FakeServer,
    backup: FakeServer | None,
    s: Settings | None = None,
    clock: Clock | None = None,
    sleeps: list[float] | None = None,
) -> ModelRouter:
    s = s or settings(backup=OPENROUTER if backup else None)
    clients = {"primary": make_client(s.primary, max_retries=0, http_client=httpx.Client(transport=httpx.MockTransport(primary)))}
    if backup is not None:
        clients["backup"] = make_client(s.backup, max_retries=0, http_client=httpx.Client(transport=httpx.MockTransport(backup)))
    pauses = sleeps if sleeps is not None else []
    return ModelRouter(s, clock=clock or Clock(), sleep=pauses.append, clients=clients)


MSGS = [{"role": "user", "content": "hi"}]


def test_healthy_primary_serves_everything():
    brev, orr = FakeServer(BREV.model), FakeServer(OPENROUTER.model)
    reply = router(brev, orr).chat(MSGS)
    assert reply.endpoint.role == "primary" and reply.failover_reason is None
    assert reply.message.content == f"hello from {BREV.model}"
    assert len(brev.bodies) == 1 and orr.bodies == []


@pytest.mark.parametrize("fail", ["down", "503", "429", "404", "401"])
def test_outage_fails_over_to_backup(fail):
    brev, orr = FakeServer(BREV.model, fail=fail), FakeServer(OPENROUTER.model)
    reply = router(brev, orr).chat(MSGS)
    assert reply.endpoint.role == "backup"
    assert reply.failover_reason
    assert reply.message.content == f"hello from {OPENROUTER.model}"


def test_backup_stays_in_use_during_cooldown_then_primary_is_retried():
    clock = Clock()
    brev, orr = FakeServer(BREV.model, fail="down"), FakeServer(OPENROUTER.model)
    r = router(brev, orr, clock=clock)
    r.chat(MSGS)
    r.chat(MSGS)
    assert len(brev.bodies) == 1  # second call skipped the primary
    assert len(orr.bodies) == 2

    brev.fail = None  # the Brev machine comes back
    clock.now = 121.0  # cooldown is 120 s
    reply = r.chat(MSGS)
    assert reply.endpoint.role == "primary"
    assert len(brev.bodies) == 2


def test_free_backup_requests_are_spaced_under_20_a_minute():
    clock, sleeps = Clock(), []
    brev, orr = FakeServer(BREV.model, fail="down"), FakeServer(OPENROUTER.model)
    r = router(brev, orr, clock=clock, sleeps=sleeps)
    r.chat(MSGS)
    clock.now = 1.0
    r.chat(MSGS)
    assert sleeps == [2.0]  # 3 s spacing, 1 s already passed
    assert brev.bodies and len(orr.bodies) == 2


def test_brev_primary_is_not_paced():
    sleeps: list[float] = []
    r = router(FakeServer(BREV.model), FakeServer(OPENROUTER.model), sleeps=sleeps)
    r.chat(MSGS)
    r.chat(MSGS)
    assert sleeps == []


def test_bad_request_is_raised_not_failed_over():
    brev, orr = FakeServer(BREV.model, fail="400"), FakeServer(OPENROUTER.model)
    with pytest.raises(openai.BadRequestError):
        router(brev, orr).chat(MSGS)
    assert orr.bodies == []


def test_both_down_is_model_unavailable():
    brev, orr = FakeServer(BREV.model, fail="down"), FakeServer(OPENROUTER.model, fail="503")
    with pytest.raises(ModelUnavailable, match="Primary: .* Backup: "):
        router(brev, orr).chat(MSGS)


def test_no_backup_and_primary_down_is_model_unavailable():
    brev = FakeServer(BREV.model, fail="down")
    with pytest.raises(ModelUnavailable, match="Primary: "):
        router(brev, None).chat(MSGS)


def test_primary_without_model_name_fails_over():
    s = settings()
    s = Settings(**{**s.__dict__, "primary": Endpoint("primary", "openai_compatible", BREV.base_url, "", "")})
    orr = FakeServer(OPENROUTER.model)
    clients = {"backup": make_client(OPENROUTER, max_retries=0, http_client=httpx.Client(transport=httpx.MockTransport(orr)))}
    reply = ModelRouter(s, clock=Clock(), clients=clients).chat(MSGS)
    assert reply.endpoint.role == "backup"
    assert "AGENT_MODEL is not set" in reply.failover_reason


def test_each_server_gets_only_its_own_extras():
    brev, orr = FakeServer(BREV.model, fail="down"), FakeServer(OPENROUTER.model)
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
    router(brev, orr, s=settings(effort="none")).chat(history)

    sent_to_brev, sent_to_openrouter = brev.bodies[0], orr.bodies[0]
    # Brev (vLLM/NIM): Nemotron's own thinking switch, no reasoning fields in history.
    assert sent_to_brev["chat_template_kwargs"] == {"enable_thinking": False}
    assert "reasoning" not in sent_to_brev
    assert not {"reasoning_content", "reasoning_details"} & set(sent_to_brev["messages"][1])
    # OpenRouter: its unified reasoning param, and its own reasoning_details passed back.
    assert sent_to_openrouter["reasoning"] == {"effort": "none"}
    assert "chat_template_kwargs" not in sent_to_openrouter
    assert "reasoning_details" in sent_to_openrouter["messages"][1]
    assert "reasoning_content" not in sent_to_openrouter["messages"][1]


def test_load_settings_brev_primary_openrouter_backup(monkeypatch):
    for k, v in {
        "LLM_PROVIDER": "openai_compatible",
        "LLM_BASE_URL": "http://localhost:8000/v1/",
        "AGENT_MODEL": "nvidia/nemotron-3-super-120b-a12b",
        "BACKUP_LLM_PROVIDER": "openrouter",
        "BACKUP_AGENT_MODEL": "",
        "OPENROUTER_API_KEY": "sk-or-test",
    }.items():
        monkeypatch.setenv(k, v)
    s = load_settings(env_file=None)
    assert s.primary == Endpoint("primary", "openai_compatible", "http://localhost:8000/v1", "", "nvidia/nemotron-3-super-120b-a12b")
    assert s.backup == Endpoint("backup", "openrouter", "https://openrouter.ai/api/v1", "sk-or-test", "nvidia/nemotron-3-ultra-550b-a55b:free")


def test_load_settings_defaults_to_openrouter_only(monkeypatch):
    for k in ("LLM_PROVIDER", "LLM_BASE_URL", "AGENT_MODEL", "BACKUP_LLM_PROVIDER", "OPENROUTER_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    s = load_settings(env_file=None)
    assert s.primary.provider == "openrouter" and s.primary.model == "nvidia/nemotron-3-ultra-550b-a55b:free"
    assert s.backup is None


def test_load_settings_rejects_unknown_provider(monkeypatch):
    monkeypatch.setenv("BACKUP_LLM_PROVIDER", "brev")
    with pytest.raises(ValueError, match="BACKUP_LLM_PROVIDER"):
        load_settings(env_file=None)
