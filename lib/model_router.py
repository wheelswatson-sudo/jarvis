#!/usr/bin/env python3
"""Model router — pick the cheapest backend that can handle a given task.

Three tiers:
    TIER_1_LOCAL   small (3B) on-device model — extraction, routing,
                   classification. Fast, free, runs on CPU/Metal.
    TIER_2_LOCAL   mid (14B) on-device model — synthesis, planning,
                   briefing. Slower than 3B but still local.
    API_FALLBACK   Anthropic Messages API — anything unclassified, or
                   anything where the local model returned a low-confidence
                   answer.

Public API (callers in jarvis-think.py and elsewhere):
    backend = route(task_type, context=None)        # ModelBackend enum
    backend = route_for_tool(tool_name)             # convenience for the
                                                      tool-call hot path
    accept = should_escalate(backend, confidence)   # confidence-based
                                                      fallback
    record_decision(task_type, backend, latency_ms, accepted)

Routing decisions land in the outcome ledger so we can later audit which
tasks the local model actually handled and which ones bounced to the API.

Config: ~/.jarvis/config/model-routing.json. Created with safe defaults
on first read if missing. Override the tier of an individual tool by
adding it under `overrides`."""
from __future__ import annotations

import importlib.util
import json
import os
import threading
from enum import Enum
from pathlib import Path
from typing import Any

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
CONFIG_PATH = ASSISTANT_DIR / "config" / "model-routing.json"
LIB_DIR = ASSISTANT_DIR / "lib"

# Confidence below this on a Tier-1 result triggers escalation. Tunable
# from config.json. We default low because the 3B model is meant to handle
# the easy cases, and being too eager to escalate defeats the purpose.
DEFAULT_CONFIDENCE_THRESHOLD = 0.55


class ModelBackend(str, Enum):
    TIER_1_LOCAL = "tier1_local"
    TIER_2_LOCAL = "tier2_local"
    API_FALLBACK = "api_fallback"


# ── task-type taxonomy ────────────────────────────────────────────────
# Cognitive complexity buckets — the task name is what callers pass to
# `route()` when they don't have a specific tool in hand.
TIER_1_TASK_TYPES = {
    "commitment_extraction",
    "notification_scoring",
    "tool_routing",
    "entity_extraction",
    "cron_parsing",
    "style_fingerprinting",
    "contact_matching",
    "sentiment_classification",
    "urgency_scoring",
}

TIER_2_TASK_TYPES = {
    "orchestrator_planning",
    "briefing_synthesis",
    "meeting_prep",
    "research_synthesis",
    "complex_conversation",
}


# ── default tool → tier mapping ───────────────────────────────────────
# 80 tools from jarvis-think.py grouped by cognitive load. Tier 1 = pure
# extraction or arg-shaping (the 3B model picks the right call and fills
# its slots). Tier 2 = synthesis (briefings, planning, message-writing
# that benefits from a larger model). Anything not listed defaults to
# API_FALLBACK so we never silently route a new tool to a model that
# wasn't trained on it.
_TIER_1_TOOLS = {
    # memory + recall — simple extraction
    "remember", "recall", "read_memory_file",
    # clock — trivial routing
    "get_time", "get_date",
    # contacts — name → record matching
    "search_contacts", "lookup_contact", "apple_contacts_search",
    "imessage_search_contacts", "enrich_contact",
    # timers/reminders — cron parsing
    "set_timer", "set_reminder",
    "apple_add_reminder", "apple_list_reminders", "apple_complete_reminder",
    # calendar — event extraction + cron parsing
    "check_calendar", "create_event", "update_event", "delete_event",
    # email — routing/triage; *composing* replies stays Tier 2
    "check_email", "draft_email",
    # telegram/imessage/social — tool routing on inbound
    "check_telegram", "telegram_search",
    "imessage_check", "imessage_read",
    "check_social", "social_search",
    # notifications — scoring + dispatch
    "check_notifications", "dismiss_notification", "notification_preferences",
    # style status — classification
    "style_apply", "style_status",
    # network/linkedin lookups — contact matching, no synthesis
    "network_search", "relationship_score", "network_alerts",
    "linkedin_search", "linkedin_changes", "linkedin_sync",
    "linkedin_monitor", "linkedin_enrich",
    # commitments — extraction
    "extract_commitments", "add_commitment", "list_commitments",
    "complete_commitment",
    # trello — routing
    "trello_sync", "trello_boards", "trello_add", "trello_move",
    # apple notes — read + small saves
    "apple_save_note", "apple_read_note",
    # stripe — single-record lookups
    "stripe_customers", "stripe_customer", "stripe_alerts",
    # workflows — routing
    "create_workflow", "list_workflows", "run_workflow",
    "update_workflow", "delete_workflow",
    # meeting prep settings — config CRUD
    "meeting_prep_settings",
    # web search — routing only; the heavy lifting is research_topic
    "web_search",
    # shell — routing decision; the command itself runs as-is
    "run_command",
}

_TIER_2_TOOLS = {
    # synthesis-heavy briefings
    "get_briefing",
    "telegram_digest", "social_digest",
    "stripe_dashboard", "stripe_revenue",
    "commitment_report",
    # research + network mapping
    "research_topic", "network_map", "network_suggest", "enrich_network",
    # composing outbound — tone matters
    "send_email", "reply_email",
    "send_telegram", "imessage_send",
    "social_post", "social_reply",
    # meeting prep + relationship briefs — full synthesis
    "meeting_prep", "relationship_brief",
    # orchestrator
    "execute_plan",
}

# Map each task-type to a default backend.
_TASK_TYPE_BACKEND: dict[str, ModelBackend] = {
    **{t: ModelBackend.TIER_1_LOCAL for t in TIER_1_TASK_TYPES},
    **{t: ModelBackend.TIER_2_LOCAL for t in TIER_2_TASK_TYPES},
}


# ── config load ───────────────────────────────────────────────────────
_DEFAULT_CONFIG = {
    "tier1_model": "qwen2.5-3b-jarvis",
    "tier2_model": "qwen2.5-14b-jarvis",
    "api_model": "claude-haiku-4-5-20251001",
    "local_endpoint": "http://127.0.0.1:8741/v1/chat/completions",
    "confidence_threshold": DEFAULT_CONFIDENCE_THRESHOLD,
    "force_backend": None,            # "api_fallback" pins everything to API
    "disable_local": False,           # kill switch
    "overrides": {},                  # {"tool_name": "tier1_local"|...}
}

_config_lock = threading.Lock()
_cached_config: dict | None = None
_config_mtime: float = 0.0


def _load_config(force: bool = False) -> dict:
    """Read and cache routing config. File is created with defaults on
    first call if missing. Re-read when mtime changes so a hot-edit takes
    effect without restarting the caller."""
    global _cached_config, _config_mtime
    with _config_lock:
        try:
            stat = CONFIG_PATH.stat()
            mtime = stat.st_mtime
        except FileNotFoundError:
            mtime = 0.0
        if not force and _cached_config is not None and mtime == _config_mtime:
            return _cached_config

        if not CONFIG_PATH.exists():
            try:
                CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
                CONFIG_PATH.write_text(
                    json.dumps(_DEFAULT_CONFIG, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
            except OSError:
                pass
            cfg = dict(_DEFAULT_CONFIG)
        else:
            try:
                cfg = {**_DEFAULT_CONFIG, **json.loads(CONFIG_PATH.read_text(encoding="utf-8"))}
            except (OSError, json.JSONDecodeError):
                cfg = dict(_DEFAULT_CONFIG)

        _cached_config = cfg
        _config_mtime = mtime
    return cfg


# ── ledger emit (best-effort) ─────────────────────────────────────────
_ledger_mod = None


def _get_ledger():
    global _ledger_mod
    if _ledger_mod is not None:
        return _ledger_mod
    src = LIB_DIR / "outcome_ledger.py"
    if not src.exists():
        src = Path(__file__).parent / "outcome_ledger.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("outcome_ledger", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _ledger_mod = mod
        return mod
    except Exception:
        return None


# ── public routing API ────────────────────────────────────────────────
def route(task_type: str, context: dict | None = None) -> ModelBackend:
    """Pick a backend for a generic task type. Anything we don't recognise
    falls through to the API so we never silently downgrade a brand-new
    capability to a model that wasn't trained on it."""
    cfg = _load_config()
    if cfg.get("disable_local"):
        return ModelBackend.API_FALLBACK
    forced = cfg.get("force_backend")
    if forced:
        try:
            return ModelBackend(forced)
        except ValueError:
            pass

    backend = _TASK_TYPE_BACKEND.get(task_type or "", ModelBackend.API_FALLBACK)

    # Context-based escalations: if the caller flagged the input as long
    # or as needing reasoning, push up a tier. Cheap fences against the
    # 3B model getting handed something it'll mangle.
    if context:
        if context.get("force_api"):
            return ModelBackend.API_FALLBACK
        if context.get("complex") and backend == ModelBackend.TIER_1_LOCAL:
            backend = ModelBackend.TIER_2_LOCAL
        # Heuristic: messages over ~6k chars (~1500 tokens) deserve the
        # bigger model. The 3B's context window is fine, but its synthesis
        # quality drops fast above that.
        text = (context.get("user_text") or "") if isinstance(context, dict) else ""
        if isinstance(text, str) and len(text) > 6000 and backend == ModelBackend.TIER_1_LOCAL:
            backend = ModelBackend.TIER_2_LOCAL

    return backend


def route_for_tool(tool_name: str, context: dict | None = None) -> ModelBackend:
    """Convenience: pick a backend for a specific Jarvis tool. Honours the
    `overrides` config block so the user can pin a tool to a tier without
    code changes."""
    cfg = _load_config()
    if cfg.get("disable_local"):
        return ModelBackend.API_FALLBACK

    overrides = cfg.get("overrides") or {}
    if tool_name in overrides:
        try:
            return ModelBackend(overrides[tool_name])
        except ValueError:
            pass

    if tool_name in _TIER_1_TOOLS:
        backend = ModelBackend.TIER_1_LOCAL
    elif tool_name in _TIER_2_TOOLS:
        backend = ModelBackend.TIER_2_LOCAL
    else:
        backend = ModelBackend.API_FALLBACK

    if context and context.get("complex") and backend == ModelBackend.TIER_1_LOCAL:
        backend = ModelBackend.TIER_2_LOCAL
    if context and context.get("force_api"):
        backend = ModelBackend.API_FALLBACK
    return backend


def should_escalate(backend: ModelBackend, confidence: float | None) -> ModelBackend | None:
    """Given a result from `backend` with self-reported `confidence`,
    return the next tier to retry on (or None if the answer should stand).

    Tier 1 → Tier 2. Tier 2 → API. API has nowhere to go."""
    if confidence is None:
        return None
    cfg = _load_config()
    threshold = float(cfg.get("confidence_threshold", DEFAULT_CONFIDENCE_THRESHOLD))
    if confidence >= threshold:
        return None
    if backend == ModelBackend.TIER_1_LOCAL:
        return ModelBackend.TIER_2_LOCAL
    if backend == ModelBackend.TIER_2_LOCAL:
        return ModelBackend.API_FALLBACK
    return None


def model_name_for(backend: ModelBackend) -> str:
    """Resolve the configured model id for a given backend."""
    cfg = _load_config()
    if backend == ModelBackend.TIER_1_LOCAL:
        return cfg.get("tier1_model") or _DEFAULT_CONFIG["tier1_model"]
    if backend == ModelBackend.TIER_2_LOCAL:
        return cfg.get("tier2_model") or _DEFAULT_CONFIG["tier2_model"]
    return cfg.get("api_model") or _DEFAULT_CONFIG["api_model"]


def local_endpoint() -> str:
    return _load_config().get("local_endpoint") or _DEFAULT_CONFIG["local_endpoint"]


# ── decision logging ──────────────────────────────────────────────────
def record_decision(task_type: str, backend: ModelBackend,
                    latency_ms: int | float | None = None,
                    accepted: bool = True,
                    extra: dict | None = None) -> None:
    """Emit one outcome-ledger row tagged cap='router' so we can audit
    which tier handled each request and how often we escalated."""
    led = _get_ledger()
    if led is None:
        return
    ctx: dict[str, Any] = {"task_type": task_type, "backend": backend.value,
                           "model": model_name_for(backend)}
    if extra:
        ctx.update(extra)
    try:
        led.emit(
            cap="router",
            action=task_type or "unknown",
            status="success" if accepted else "skipped",
            latency_ms=latency_ms,
            context=ctx,
        )
    except Exception:
        pass


# ── stats helpers (for the model_stats tool) ──────────────────────────
def routing_stats(hours: float = 24.0) -> dict:
    """Aggregate routing decisions over the last `hours`. Returns counts
    per backend, escalation rate, and p95 latency by backend."""
    led = _get_ledger()
    if led is None:
        return {"error": "outcome ledger not available"}
    try:
        rows = led.query(cap="router", hours=hours)
    except Exception as e:
        return {"error": f"ledger query failed: {e}"}

    by_backend: dict[str, int] = {}
    latencies: dict[str, list[int]] = {}
    escalations = 0
    total = 0
    for r in rows:
        ctx = r.get("context") or {}
        b = ctx.get("backend") or "unknown"
        by_backend[b] = by_backend.get(b, 0) + 1
        total += 1
        if r.get("status") == "skipped":
            escalations += 1
        lat = r.get("latency_ms")
        if isinstance(lat, (int, float)):
            latencies.setdefault(b, []).append(int(lat))

    def _p95(xs: list[int]) -> int | None:
        if not xs:
            return None
        xs = sorted(xs)
        idx = max(0, int(round(0.95 * (len(xs) - 1))))
        return xs[idx]

    return {
        "hours": hours,
        "total_decisions": total,
        "by_backend": by_backend,
        "escalation_rate": (escalations / total) if total else 0.0,
        "p95_latency_ms": {b: _p95(xs) for b, xs in latencies.items()},
        "config_path": str(CONFIG_PATH),
        "config": {k: v for k, v in _load_config().items()
                   if k not in ("overrides",)},
    }


__all__ = [
    "ModelBackend",
    "route",
    "route_for_tool",
    "should_escalate",
    "model_name_for",
    "local_endpoint",
    "record_decision",
    "routing_stats",
]
