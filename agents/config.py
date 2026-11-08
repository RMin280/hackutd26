"""Agent settings, read from the environment and the gitignored .env file.

Real environment variables win over .env. Secrets never appear in code or logs
(CLAUDE.md security rules).

Model access is a chain of three Nemotron tiers, tried in this order (agents/llm.py):
  brev   our Nemotron on an NVIDIA Brev GPU machine (NIM or vLLM, port-forwarded), or any
         other OpenAI-compatible server: BREV_BASE_URL, BREV_API_KEY, BREV_MODEL
  super  NVIDIA Nemotron 3.5 Super (free) on OpenRouter: SUPER_MODEL, OPENROUTER_API_KEY
  ultra  NVIDIA Nemotron 3 Ultra (free) on OpenRouter: ULTRA_MODEL, OPENROUTER_API_KEY

LLM_FREE_ONLY=true (testing) keeps only the free OpenRouter tiers, so no request reaches
Brev and testing spends no Brev credits.

Spending on metered endpoints is capped by agents/budget.py (AGENT_BUDGET_USD and friends).
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

from .budget import Limits, limits_from_env

log = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = REPO_ROOT / ".env"

USAGE_FILE = REPO_ROOT / ".agent_usage.json"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
# A model server on a Brev machine, after `brev port-forward <machine> --port 8000:8000`.
LOCAL_SERVER_URL = "http://localhost:8000/v1"
SUPER_FREE = "nvidia/nemotron-3.5-super-vl:free"  # "NVIDIA: Nemotron 3.5 Super VL (free)"
ULTRA_FREE = "nvidia/nemotron-3-ultra-550b-a55b:free"  # "NVIDIA: Nemotron 3 Ultra (free)"
DEFAULT_SPACETIME_HOST = "http://127.0.0.1:3000"
REASONING_EFFORTS = ("none", "minimal", "low", "medium", "high")
# The primary + backup settings the tiers replaced. Ignored now, with a warning.
OLD_MODEL_VARS = (
    "LLM_PROVIDER",
    "LLM_BASE_URL",
    "LLM_API_KEY",
    "AGENT_MODEL",
    "BACKUP_LLM_PROVIDER",
    "BACKUP_LLM_BASE_URL",
    "BACKUP_LLM_API_KEY",
    "BACKUP_AGENT_MODEL",
    "NVIDIA_API_KEY",
)


@dataclass(frozen=True)
class Endpoint:
    role: str  # the tier: "brev", "super" or "ultra"
    provider: str  # "openai_compatible" (Brev: NIM / vLLM) or "openrouter"
    base_url: str
    api_key: str
    model: str

    @property
    def is_openrouter(self) -> bool:
        return self.provider == "openrouter"

    @property
    def is_free(self) -> bool:
        """An OpenRouter :free model: costs nothing and uses no Brev credits."""
        return self.is_openrouter and self.model.endswith(":free")

    @property
    def label(self) -> str:
        return f"{self.role} ({self.provider}, {self.model or 'no model set'})"

    @property
    def display(self) -> str:
        """The model and where it ran, as the view shows it next to the agent's plan."""
        if self.provider == "local":
            return "scripted stand-in, no model"
        where = "OpenRouter" if self.is_openrouter else "our own server (Brev)"
        return f"{self.model or 'unnamed model'} via {where}"


@dataclass(frozen=True)
class Settings:
    tiers: tuple[Endpoint, ...]  # tried in this order; the last one is always tried
    fallback_models: tuple[str, ...]  # OpenRouter's own in-provider fallbacks (none when free_only)
    reasoning_effort: str
    temperature: float
    tier_timeout: float  # seconds before a hanging tier (all but the last) counts as down
    failover_cooldown: float  # seconds a failed tier is skipped before it is tried again
    spacetime_host: str
    spacetime_db: str
    spacetime_token: str
    spacetime_update_token: str = ""  # the update agent's own identity (agents/patch)
    budget: Limits = Limits()
    usage_file: str = ""  # the shared spending ledger; empty = in memory only (tests)
    free_only: bool = False  # LLM_FREE_ONLY: only the free OpenRouter tiers (testing)

    @property
    def tiers_label(self) -> str:
        chain = " -> ".join(t.label for t in self.tiers) or "none"
        return chain + (" [LLM_FREE_ONLY: free tiers only, Brev is never called]" if self.free_only else "")


def _env(name: str, default: str = "") -> str:
    """Value of an env var, or the default when it's unset or blank."""
    return os.getenv(name, "").strip() or default


def _flag(name: str) -> bool:
    value = _env(name, "false").lower()
    if value in ("1", "true", "yes", "on"):
        return True
    if value in ("0", "false", "no", "off"):
        return False
    raise ValueError(f"{name} must be true or false; got {value!r}")


def load_settings(env_file: Path | None = ENV_FILE) -> Settings:
    if env_file is not None and env_file.exists():
        load_dotenv(env_file, override=False)

    effort = _env("AGENT_REASONING_EFFORT", "low").lower()
    if effort not in REASONING_EFFORTS:
        raise ValueError(
            f"AGENT_REASONING_EFFORT must be one of {', '.join(REASONING_EFFORTS)}; got {effort!r}"
        )
    old = [name for name in OLD_MODEL_VARS if _env(name)]
    if old:
        log.warning("Ignoring old model settings: %s. The tiers are set with BREV_*, SUPER_MODEL and ULTRA_MODEL now (see .env.example).", ", ".join(old))

    openrouter_key = _env("OPENROUTER_API_KEY")
    every = (
        # The model must match a name the Brev server lists at /v1/models.
        Endpoint("brev", "openai_compatible", _env("BREV_BASE_URL", LOCAL_SERVER_URL).rstrip("/"), _env("BREV_API_KEY"), _env("BREV_MODEL")),
        Endpoint("super", "openrouter", OPENROUTER_BASE_URL, openrouter_key, _env("SUPER_MODEL", SUPER_FREE)),
        Endpoint("ultra", "openrouter", OPENROUTER_BASE_URL, openrouter_key, _env("ULTRA_MODEL", ULTRA_FREE)),
    )
    free_only = _flag("LLM_FREE_ONLY")
    tiers = every
    if free_only:
        tiers = tuple(t for t in every if t.is_free)
        for t in every:
            if t.is_openrouter and not t.is_free:
                log.warning("LLM_FREE_ONLY: leaving out %s, whose model %s isn't a :free model.", t.role, t.model)

    return Settings(
        tiers=tiers,
        # OpenRouter may serve these paid models in place of a :free one, so testing never uses them.
        fallback_models=() if free_only else tuple(m.strip() for m in _env("AGENT_FALLBACK_MODELS").split(",") if m.strip()),
        reasoning_effort=effort,
        temperature=float(_env("AGENT_TEMPERATURE", "0.6")),
        tier_timeout=float(_env("LLM_TIER_TIMEOUT", _env("LLM_PRIMARY_TIMEOUT", "90"))),
        failover_cooldown=float(_env("LLM_FAILOVER_COOLDOWN", "120")),
        spacetime_host=_env("SPACETIME_HOST", DEFAULT_SPACETIME_HOST).rstrip("/"),
        spacetime_db=_env("SPACETIME_DB"),
        spacetime_token=_env("SPACETIME_TOKEN"),
        spacetime_update_token=_env("SPACETIME_UPDATE_TOKEN"),
        budget=limits_from_env(_env),
        usage_file=_env("AGENT_USAGE_FILE", str(USAGE_FILE)),
        free_only=free_only,
    )
