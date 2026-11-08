"""Model access for the agents, over the OpenAI-compatible chat API.

ModelRouter sends every request to the primary endpoint (our Nemotron on Brev). If the
primary is unreachable, overloaded or not set up, it resends the same request to the
backup (NVIDIA Nemotron 3 Ultra (free) on OpenRouter) and stays on the backup for a
cooldown before trying the primary again.

The model only proposes tool calls and writes explanations. Blast Radius makes every
safety decision and the agent runtime enforces it, so nothing here holds safety logic
(CLAUDE.md: "LLMs may call tools; they never make the decision"). If both endpoints
fail, ModelUnavailable reaches the agent, which then does nothing and escalates.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Callable

import httpx
import openai
from openai import OpenAI
from openai.types.chat import ChatCompletion, ChatCompletionMessage

from .config import Endpoint, Settings

log = logging.getLogger(__name__)

APP_TITLE = "Blast Radius agents"
FREE_TIER_INTERVAL = 60 / 20  # seconds between requests to an OpenRouter :free model (20/min)
# Provider-specific reasoning fields on assistant messages. OpenRouter asks for its
# reasoning_details back unmodified; other servers get none of them.
_REASONING_KEYS = ("reasoning", "reasoning_content", "reasoning_details")


class EndpointNotConfigured(RuntimeError):
    """The endpoint is missing a key or model name in .env."""


class ModelUnavailable(RuntimeError):
    """No endpoint could answer. Agents treat this as fail-closed: act on nothing, escalate."""


# Errors meaning "this endpoint can't serve us right now", so the backup should try.
# Bad requests (400/422) are bugs on our side: they are raised, not sent elsewhere.
FAILOVER_ERRORS: tuple[type[Exception], ...] = (
    openai.APIConnectionError,  # includes timeouts
    openai.InternalServerError,  # 5xx
    openai.RateLimitError,  # 429
    openai.NotFoundError,  # model not served there
    openai.AuthenticationError,  # 401
    openai.PermissionDeniedError,  # 403
    EndpointNotConfigured,
)


def make_client(
    endpoint: Endpoint,
    *,
    timeout: float | httpx.Timeout = 180.0,
    max_retries: int = 2,
    http_client: httpx.Client | None = None,
) -> OpenAI:
    if endpoint.is_openrouter and not endpoint.api_key:
        raise EndpointNotConfigured("OPENROUTER_API_KEY is not set in .env.")
    if not endpoint.model:
        var = "AGENT_MODEL" if endpoint.role == "primary" else "BACKUP_AGENT_MODEL"
        raise EndpointNotConfigured(f"{var} is not set in .env (use a name the server lists at /v1/models).")
    return OpenAI(
        # A port-forwarded NIM or vLLM server needs no key, but the SDK wants a string.
        api_key=endpoint.api_key or "none",
        base_url=endpoint.base_url,
        timeout=timeout,
        max_retries=max_retries,  # the SDK backs off and retries 429, 5xx and timeouts
        default_headers={"X-Title": APP_TITLE} if endpoint.is_openrouter else {},
        http_client=http_client,
    )


def _messages_for(endpoint: Endpoint, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    keep = {"reasoning_details"} if endpoint.is_openrouter else set()
    out = []
    for m in messages:
        if m.get("role") == "assistant" and any(k in m for k in _REASONING_KEYS):
            m = {k: v for k, v in m.items() if k not in _REASONING_KEYS or k in keep}
        out.append(m)
    return out


def _extra_body(endpoint: Endpoint, settings: Settings) -> dict[str, Any]:
    if endpoint.is_openrouter:
        body: dict[str, Any] = {"reasoning": {"effort": settings.reasoning_effort}}
        if settings.fallback_models:
            body["models"] = [endpoint.model, *settings.fallback_models]
        return body
    # NIM / vLLM: Nemotron 3's chat template turns thinking off with enable_thinking=False.
    if settings.reasoning_effort == "none":
        return {"chat_template_kwargs": {"enable_thinking": False}}
    return {}


def complete(
    client: OpenAI,
    endpoint: Endpoint,
    settings: Settings,
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None = None,
    tool_choice: str | dict[str, Any] = "auto",
    max_tokens: int = 4096,
) -> ChatCompletion:
    """One chat completion against one endpoint, with no failover."""
    kwargs: dict[str, Any] = {
        "model": endpoint.model,
        "messages": _messages_for(endpoint, messages),
        "temperature": settings.temperature,
        "max_tokens": max_tokens,
    }
    extra_body = _extra_body(endpoint, settings)
    if extra_body:
        kwargs["extra_body"] = extra_body
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = tool_choice

    response = client.chat.completions.create(**kwargs)
    if not response.choices:
        raise openai.InternalServerError(
            f"The {endpoint.role} model server returned no choices.",
            response=httpx.Response(502, request=httpx.Request("POST", endpoint.base_url)),
            body=None,
        )
    return response


@dataclass(frozen=True)
class Reply:
    completion: ChatCompletion
    endpoint: Endpoint
    failover_reason: str | None = None  # why the primary was skipped, if it was

    @property
    def message(self) -> ChatCompletionMessage:
        return self.completion.choices[0].message


class ModelRouter:
    """Primary first; on an outage-type error, the same request goes to the backup."""

    def __init__(
        self,
        settings: Settings,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        clients: dict[str, OpenAI] | None = None,
    ) -> None:
        self.settings = settings
        self._clock = clock
        self._sleep = sleep
        self._clients: dict[str, OpenAI] = dict(clients or {})
        self._primary_down_until = float("-inf")
        self._down_reason = ""
        self._last_sent: dict[str, float] = {}

    def chat(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | dict[str, Any] = "auto",
        max_tokens: int = 4096,
    ) -> Reply:
        s = self.settings
        args = (messages, tools, tool_choice, max_tokens)
        if s.backup is not None and self._clock() < self._primary_down_until:
            return self._send_to_backup(*args, reason=f"primary cooling down after: {self._down_reason}")
        try:
            return Reply(self._send(s.primary, *args), s.primary)
        except FAILOVER_ERRORS as exc:
            reason = describe_error(exc, s.primary)
            if s.backup is None:
                raise ModelUnavailable(f"Primary: {reason}") from exc
            self._primary_down_until = self._clock() + s.failover_cooldown
            self._down_reason = reason
            log.warning("Primary model unavailable; using the backup for %.0f s. Reason: %s", s.failover_cooldown, reason)
            return self._send_to_backup(*args, reason=reason)

    def _send_to_backup(self, messages, tools, tool_choice, max_tokens, *, reason: str) -> Reply:
        backup = self.settings.backup
        assert backup is not None
        try:
            return Reply(self._send(backup, messages, tools, tool_choice, max_tokens), backup, reason)
        except FAILOVER_ERRORS as exc:
            raise ModelUnavailable(f"Primary: {reason} Backup: {describe_error(exc, backup)}") from exc

    def _send(self, endpoint: Endpoint, messages, tools, tool_choice, max_tokens) -> ChatCompletion:
        self._pace(endpoint)
        return complete(
            self._client(endpoint),
            endpoint,
            self.settings,
            messages,
            tools=tools,
            tool_choice=tool_choice,
            max_tokens=max_tokens,
        )

    def _pace(self, endpoint: Endpoint) -> None:
        """Space requests to OpenRouter's free models under their 20/min limit."""
        if not (endpoint.is_openrouter and endpoint.model.endswith(":free")):
            return
        last = self._last_sent.get(endpoint.role)
        if last is not None:
            wait = last + FREE_TIER_INTERVAL - self._clock()
            if wait > 0:
                self._sleep(wait)
        self._last_sent[endpoint.role] = self._clock()

    def _client(self, endpoint: Endpoint) -> OpenAI:
        if endpoint.role not in self._clients:
            if endpoint.role == "primary" and self.settings.backup is not None:
                # With a backup waiting, fail over fast: short connect timeout, no retries.
                timeout = httpx.Timeout(self.settings.primary_timeout, connect=5.0)
                self._clients[endpoint.role] = make_client(endpoint, timeout=timeout, max_retries=0)
            else:
                self._clients[endpoint.role] = make_client(endpoint)
        return self._clients[endpoint.role]


def history_entry(message: ChatCompletionMessage) -> dict[str, Any]:
    """The assistant message as a dict to append to the conversation, reasoning fields
    included as returned (complete() drops the ones a given server shouldn't get)."""
    entry = message.model_dump(exclude_none=True)
    entry["role"] = "assistant"
    if not entry.get("tool_calls"):
        entry.pop("tool_calls", None)
    return entry


def describe_error(exc: Exception, endpoint: Endpoint) -> str:
    """A one-line, actionable explanation of a model-server error. Never includes a key."""
    detail = ""
    if isinstance(exc, openai.APIStatusError):
        body = exc.body if isinstance(exc.body, dict) else {}
        detail = str(body.get("message") or exc.message or "")[:300]
    where = "OpenRouter" if endpoint.is_openrouter else endpoint.base_url
    local = any(h in endpoint.base_url for h in ("localhost", "127.0.0.1"))

    if isinstance(exc, EndpointNotConfigured):
        return str(exc)
    if isinstance(exc, openai.AuthenticationError):
        if endpoint.is_openrouter:
            return "OpenRouter rejected the key (401). Re-copy OPENROUTER_API_KEY into .env; it starts with sk-or-."
        return f"{where} rejected the API key (401)."
    if isinstance(exc, openai.PermissionDeniedError):
        return f"{where} refused the request (403). {detail}".strip()
    if isinstance(exc, openai.RateLimitError):
        if endpoint.is_openrouter:
            return (
                "Rate limited (429). Free models allow 20 requests/min and 50/day, or 1,000/day once "
                "you have bought 10 credits."
            )
        return f"Rate limited (429) by {where}."
    if isinstance(exc, openai.NotFoundError):
        if "data policy" in detail.lower() or "privacy" in detail.lower():
            return (
                "No endpoint matches your OpenRouter privacy settings. Allow free endpoints at "
                "https://openrouter.ai/settings/privacy."
            )
        return f"Model {endpoint.model} not found at {where} (404). {detail}".strip()
    if isinstance(exc, openai.APIStatusError) and exc.status_code == 402:
        return "OpenRouter says the account needs credits (402). Check the model name ends in :free."
    if isinstance(exc, openai.APITimeoutError):
        return f"{where} timed out."
    if isinstance(exc, openai.APIConnectionError):
        if local:
            return (
                f"Nothing answers at {endpoint.base_url}. Is the Brev machine running, with "
                "`brev port-forward <machine> --port 8000:8000` open in Ubuntu?"
            )
        return f"Couldn't reach {where}."
    if isinstance(exc, openai.APIStatusError):
        return f"{where} returned {exc.status_code}. {detail}".strip()
    return f"{type(exc).__name__}: {exc}"
