"""Agent settings, read from the environment and the gitignored .env file.

Real environment variables win over .env. Secrets never appear in code or logs
(CLAUDE.md security rules).

Two model endpoints, both spoken to over the OpenAI-compatible chat API:
  primary  where every request goes first (e.g. our Nemotron on a Brev GPU machine)
  backup   used automatically while the primary is down or overloaded
           (e.g. NVIDIA Nemotron 3 Ultra (free) on OpenRouter)

Each endpoint's provider is one of:
  openrouter         OpenRouter (key: OPENROUTER_API_KEY)
  openai_compatible  a Nemotron NIM or vLLM server (Brev), or any other OpenAI-compatible server
  nvidia             NVIDIA's hosted API (build.nvidia.com), key NVIDIA_API_KEY (starts nvapi-)

Spending on metered endpoints is capped by agents/budget.py (AGENT_BUDGET_USD and friends).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

from .budget import Limits, limits_from_env

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = REPO_ROOT / ".env"

PROVIDERS = ("openrouter", "openai_compatible", "nvidia")
NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"
USAGE_FILE = REPO_ROOT / ".agent_usage.json"
# "NVIDIA: Nemotron 3 Ultra (free)" on OpenRouter.
DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
# A model server on a Brev machine, after `brev port-forward <machine> --port 8000:8000`.
LOCAL_SERVER_URL = "http://localhost:8000/v1"
DEFAULT_SPACETIME_HOST = "http://127.0.0.1:3000"
REASONING_EFFORTS = ("none", "minimal", "low", "medium", "high")


@dataclass(frozen=True)
class Endpoint:
    role: str  # "primary" or "backup"
    provider: str
    base_url: str
    api_key: str
    model: str

    @property
    def is_openrouter(self) -> bool:
        return self.provider == "openrouter"

    @property
    def label(self) -> str:
        return f"{self.role} ({self.provider}, {self.model or 'no model set'})"

    @property
    def display(self) -> str:
        """The model and where it ran, as the view shows it next to the agent's plan."""
        if self.provider == "local":
            return "scripted stand-in, no model"
        where = "OpenRouter" if self.is_openrouter else "NVIDIA API" if self.provider == "nvidia" else "our own server (Brev)"
        return f"{self.model or 'unnamed model'} via {where}"


@dataclass(frozen=True)
class Settings:
    primary: Endpoint
    backup: Endpoint | None
    fallback_models: tuple[str, ...]  # OpenRouter's own in-provider fallbacks
    reasoning_effort: str
    temperature: float
    primary_timeout: float  # seconds; keeps failover quick when the primary hangs
    failover_cooldown: float  # seconds to stay on the backup after the primary fails
    spacetime_host: str
    spacetime_db: str
    spacetime_token: str
    spacetime_update_token: str = ""  # the update agent's own identity (agents/patch)
    budget: Limits = Limits()
    usage_file: str = ""  # the shared spending ledger; empty = in memory only (tests)


def _env(name: str, default: str = "") -> str:
    """Value of an env var, or the default when it's unset or blank."""
    return os.getenv(name, "").strip() or default


def _provider(name: str, default: str) -> str:
    value = _env(name, default).lower()
    if value and value not in PROVIDERS:
        raise ValueError(f"{name} must be one of {', '.join(PROVIDERS)}; got {value!r}")
    return value


def _endpoint(role: str, provider: str, base_url: str, api_key: str, model: str) -> Endpoint:
    if provider == "openrouter":
        return Endpoint(
            role,
            provider,
            (base_url or OPENROUTER_BASE_URL).rstrip("/"),
            _env("OPENROUTER_API_KEY"),
            model or DEFAULT_MODEL,
        )
    if provider == "nvidia":
        # NVIDIA's hosted API: the model must match a name https://integrate.api.nvidia.com/v1/models lists.
        return Endpoint(role, provider, (base_url or NVIDIA_BASE_URL).rstrip("/"), api_key or _env("NVIDIA_API_KEY"), model)
    # openai_compatible: the model must match a name the server lists at /v1/models.
    return Endpoint(role, provider, (base_url or LOCAL_SERVER_URL).rstrip("/"), api_key, model)


def load_settings(env_file: Path | None = ENV_FILE) -> Settings:
    if env_file is not None and env_file.exists():
        load_dotenv(env_file, override=False)

    effort = _env("AGENT_REASONING_EFFORT", "low").lower()
    if effort not in REASONING_EFFORTS:
        raise ValueError(
            f"AGENT_REASONING_EFFORT must be one of {', '.join(REASONING_EFFORTS)}; got {effort!r}"
        )

    primary = _endpoint(
        "primary",
        _provider("LLM_PROVIDER", "openrouter"),
        _env("LLM_BASE_URL"),
        _env("LLM_API_KEY"),
        _env("AGENT_MODEL"),
    )
    backup_provider = _provider("BACKUP_LLM_PROVIDER", "")
    backup = (
        _endpoint(
            "backup",
            backup_provider,
            _env("BACKUP_LLM_BASE_URL"),
            _env("BACKUP_LLM_API_KEY"),
            _env("BACKUP_AGENT_MODEL"),
        )
        if backup_provider
        else None
    )

    return Settings(
        primary=primary,
        backup=backup,
        fallback_models=tuple(m.strip() for m in _env("AGENT_FALLBACK_MODELS").split(",") if m.strip()),
        reasoning_effort=effort,
        temperature=float(_env("AGENT_TEMPERATURE", "0.6")),
        primary_timeout=float(_env("LLM_PRIMARY_TIMEOUT", "90")),
        failover_cooldown=float(_env("LLM_FAILOVER_COOLDOWN", "120")),
        spacetime_host=_env("SPACETIME_HOST", DEFAULT_SPACETIME_HOST).rstrip("/"),
        spacetime_db=_env("SPACETIME_DB"),
        spacetime_token=_env("SPACETIME_TOKEN"),
        spacetime_update_token=_env("SPACETIME_UPDATE_TOKEN"),
        budget=limits_from_env(_env),
        usage_file=_env("AGENT_USAGE_FILE", str(USAGE_FILE)),
    )
