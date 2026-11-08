"""Model access for the agents, over the OpenAI-compatible chat API.

ModelRouter tries the model tiers in order (agents/config.py): our Nemotron on Brev,
then NVIDIA Nemotron 3.5 Super (free) and Nemotron 3 Ultra (free) on OpenRouter. A tier
that is unreachable, overloaded, not set up or over a credit cap is skipped for a
cooldown, and the same request goes to the next tier. The last tier is always tried.
With LLM_FREE_ONLY=true only the free tiers are in the chain, so testing never touches Brev.

The model only proposes tool calls and writes explanations. Squawk makes every
safety decision and the agent runtime enforces it, so nothing here holds safety logic
(CLAUDE.md: "LLMs may call tools; they never make the decision"). If every tier fails,
ModelUnavailable reaches the agent, which then does nothing and escalates.
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

from .budget import Budget, BudgetExceeded
from .config import Endpoint, Settings

log = logging.getLogger(__name__)

APP_TITLE = "Squawk agents"
FREE_TIER_INTERVAL = 60 / 20  # seconds between requests to an OpenRouter :free model (20/min)
# Provider-specific reasoning fields on assistant messages. OpenRouter asks for its
# reasoning_details back unmodified; other servers get none of them.
_REASONING_KEYS = ("reasoning", "reasoning_content", "reasoning_details")


class EndpointNotConfigured(RuntimeError):
    """The endpoint is missing a key or model name in .env."""


class ModelUnavailable(RuntimeError):
    """No tier could answer. Agents treat this as fail-closed: act on nothing, escalate."""


# Errors meaning "this tier can't serve us right now", so the next tier should try.
# Bad requests (400/422) are bugs on our side: they are raised, not sent elsewhere.
FAILOVER_ERRORS: tuple[type[Exception], ...] = (
    openai.APIConnectionError,  # includes timeouts
    openai.InternalServerError,  # 5xx
    openai.RateLimitError,  # 429
    openai.NotFoundError,  # model not served there
    openai.AuthenticationError,  # 401
    openai.PermissionDeniedError,  # 403
    EndpointNotConfigured,
    BudgetExceeded,  # the credit cap: a free tier may still answer, else fail closed
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
        raise EndpointNotConfigured(f"{endpoint.role.upper()}_MODEL is not set in .env (use a name the server lists at /v1/models).")
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
        # usage.include: OpenRouter reports each request's real cost, which the budget records.
        body: dict[str, Any] = {"reasoning": {"effort": settings.reasoning_effort}, "usage": {"include": True}}
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
    failover_reason: str | None = None  # why earlier tiers were skipped, if any were

    @property
    def message(self) -> ChatCompletionMessage:
        return self.completion.choices[0].message


class ModelRouter:
    """Tiers in order; on an outage-type error, the same request goes to the next tier."""

    def __init__(
        self,
        settings: Settings,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        clients: dict[str, OpenAI] | None = None,
        budget: Budget | None = None,
    ) -> None:
        self.settings = settings
        self.budget = budget or Budget(settings.budget, settings.usage_file or None, paid_fallbacks=bool(settings.fallback_models))
        self._clock = clock
        self._sleep = sleep
        self._clients: dict[str, OpenAI] = dict(clients or {})
        self._down: dict[str, tuple[float, str]] = {}  # tier -> (skipped until, why it failed)
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
        if not s.tiers:
            raise ModelUnavailable("No model tier is enabled. With LLM_FREE_ONLY=true, SUPER_MODEL and ULTRA_MODEL must be :free models.")
        args = (messages, tools, tool_choice, max_tokens)
        skipped: list[str] = []  # why each earlier tier didn't answer
        *earlier, last = s.tiers
        for tier in earlier:
            until, why = self._down.get(tier.role, (float("-inf"), ""))
            if self._clock() < until:
                skipped.append(f"{tier.role} cooling down after: {why}")
                continue
            try:
                return Reply(self._send(tier, *args), tier, "; ".join(skipped) or None)
            except FAILOVER_ERRORS as exc:
                reason = describe_error(exc, tier)
                skipped.append(f"{tier.role}: {reason}")
                self._down[tier.role] = (self._clock() + s.failover_cooldown, reason)
                log.warning("Model tier %s skipped for %.0f s: %s", tier.role, s.failover_cooldown, reason)
        try:  # the last tier has no cooldown: while it's down every request fails closed anyway
            return Reply(self._send(last, *args), last, "; ".join(skipped) or None)
        except FAILOVER_ERRORS as exc:
            skipped.append(f"{last.role}: {describe_error(exc, last)}")
            raise ModelUnavailable("; ".join(skipped)) from exc

    def _send(self, endpoint: Endpoint, messages, tools, tool_choice, max_tokens) -> ChatCompletion:
        reserved = self.budget.check(endpoint, messages, max_tokens)  # before anything is sent
        try:
            self._pace(endpoint)
            response = complete(
                self._client(endpoint),
                endpoint,
                self.settings,
                messages,
                tools=tools,
                tool_choice=tool_choice,
                max_tokens=max_tokens,
            )
        except BaseException as exc:
            # A timeout or an empty reply may still be billed: keep the worst case. A refusal
            # before any work (no connection, 401, 403, 404, 429, bad request) is refunded.
            self.budget.settle(endpoint, reserved, failed=isinstance(exc, (openai.APITimeoutError, openai.InternalServerError)))
            raise
        self.budget.settle(endpoint, reserved, response)
        return response

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
            if endpoint.role != self.settings.tiers[-1].role:
                # With another tier waiting, fail over fast: short connect timeout, no retries.
                timeout = httpx.Timeout(self.settings.tier_timeout, connect=5.0)
                self._clients[endpoint.role] = make_client(endpoint, timeout=timeout, max_retries=0)
            elif self.budget.worst_case(endpoint, [], 1) > 0:
                # Metered: no hidden SDK retries, each would be a request the budget didn't check.
                self._clients[endpoint.role] = make_client(endpoint, max_retries=0)
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

    if isinstance(exc, (EndpointNotConfigured, BudgetExceeded)):
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
