#!/usr/bin/env python3
"""Predictive context engine — pre-builds priming context before the user speaks.

The system prompt already includes personality, memory, and live world state.
This module adds a tight predictive layer on top: time-of-day expectations,
weekday vs weekend mode, recent-topic carryover, and a count of pending
notifications. Concise on purpose — under ~150 words to keep the cache
breakpoint stable and the model focused.

Wired into jarvis-think.py's _build_system_blocks(). Output goes ABOVE the
personality block so it shapes interpretation rather than acting as background
data.

Usage in code:
    from jarvis_context import ContextEngine   (via importlib)
    block = ContextEngine().predict()          # str, may be empty

Standalone smoke test:
    python3 bin/jarvis-context.py
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Iterable

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
HISTORY_FILE = ASSISTANT_DIR / "cache" / "conversation.json"
PENDING_FILE = ASSISTANT_DIR / "notifications" / "pending.json"

MAX_RECENT_TOPICS = 3
MAX_TOPIC_CHARS = 60


def _time_of_day_hint(now: datetime) -> tuple[str, str]:
    """Return (label, hint) for the current hour."""
    h = now.hour
    if 6 <= h < 12:
        return "morning", "User likely wants: calendar, weather, overnight updates."
    if 12 <= h < 17:
        return "afternoon", "User likely in work mode — expect task and meeting queries."
    if 17 <= h < 22:
        return "evening", "User winding down — more personal/casual context."
    return "late", "Off-hours. Anything happening warrants brevity."


def _day_shape(now: datetime) -> str:
    weekday = now.strftime("%A")
    if weekday in ("Saturday", "Sunday"):
        return f"{weekday} — weekend, personal context."
    if weekday == "Monday":
        return "Monday — fresh-week energy, planning queries likely."
    if weekday == "Friday":
        return "Friday — wrap-up energy, week-review queries likely."
    return f"{weekday} — midweek, work context."


_TOPIC_NOISE_RE = re.compile(
    r"^(hey|hi|hello|jarvis|sir|please|thanks?|ok|okay|yes|no|yeah|nope|sure|"
    r"can you|could you|will you|would you|do you|i need|i want|tell me)\b",
    re.I,
)


def _summarize_user_turn(text: str) -> str:
    """Pull a short topic phrase out of one user turn. Heuristic — no NLP."""
    t = (text or "").strip()
    if not t:
        return ""
    # Drop leading filler so "hey Jarvis what's the Forge tier price" → "what's the Forge tier price"
    t = _TOPIC_NOISE_RE.sub("", t).strip(" ,.?!")
    if len(t) > MAX_TOPIC_CHARS:
        t = t[: MAX_TOPIC_CHARS - 1].rstrip() + "…"
    return t


def _recent_topics(history_path: Path = HISTORY_FILE,
                   limit: int = MAX_RECENT_TOPICS) -> list[str]:
    """Return the last `limit` non-empty user turns, summarized."""
    if not history_path.exists():
        return []
    try:
        with history_path.open() as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return []
    if isinstance(data, list):
        messages = data
    elif isinstance(data, dict):
        messages = data.get("messages") or []
    else:
        return []
    user_turns = [m for m in messages if isinstance(m, dict) and m.get("role") == "user"]
    summaries: list[str] = []
    for m in reversed(user_turns):
        s = _summarize_user_turn(m.get("content", ""))
        if s and s not in summaries:
            summaries.append(s)
        if len(summaries) >= limit:
            break
    return list(reversed(summaries))


def _pending_count(pending_path: Path = PENDING_FILE) -> int:
    if not pending_path.exists():
        return 0
    try:
        with pending_path.open() as f:
            queue = json.load(f)
    except (json.JSONDecodeError, OSError):
        return 0
    return len(queue) if isinstance(queue, list) else 0


def _persistent_convo_active() -> bool:
    flag = ASSISTANT_DIR / "state" / "convo_mode"
    try:
        return flag.read_text(encoding="utf-8").strip() == "1"
    except (FileNotFoundError, OSError):
        return False


_AMBIENT_HINTS = {
    "noisy_environment": "Environment: noisy. Keep responses brief and clear.",
    "car": "Environment: car / hands-free. Very concise; one fact per turn.",
    "meeting": "Environment: meeting in progress. Listen mode — only respond if directly addressed by name.",
}


def _learned_pattern_hint(now) -> str:
    """Lazy-load jarvis-patterns and ask for the current slot's hint.
    Returns '' if patterns module / data is missing — caller falls back
    to the static time-of-day rule."""
    src = ASSISTANT_DIR / "bin" / "jarvis-patterns.py"
    if not src.exists():
        return ""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("jarvis_patterns", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod.context_hint(now=now) or ""
    except Exception:
        return ""


def _ambient_hint() -> str:
    """Read the scene state written by bin/jarvis-ambient.py and return a
    one-line behavioral hint. Default (quiet_office) returns empty string —
    no need to clutter the context block when behavior is unchanged."""
    if os.environ.get("JARVIS_AMBIENT", "1") != "1":
        return ""
    scene_file = ASSISTANT_DIR / "state" / "ambient_scene"
    try:
        first = scene_file.read_text(encoding="utf-8").splitlines()[0]
    except (FileNotFoundError, OSError, IndexError):
        return ""
    label = first.split("\t", 1)[0].strip()
    return _AMBIENT_HINTS.get(label, "")


def _notifications_hint() -> str:
    """One-liner from the smart notification bus — high-priority pending
    counts so Claude leads with check_notifications when Watson asks
    'anything urgent'. Lazy-loaded; pays nothing when the bus is unused."""
    if os.environ.get("JARVIS_NOTIFICATIONS", "1") != "1":
        return ""
    src = ASSISTANT_DIR / "bin" / "jarvis-notifications.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-notifications.py"
    if not src.exists():
        return ""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("jarvis_notifications_ctx", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod.context_hint() or ""
    except Exception:
        return ""


def _telegram_hint() -> str:
    """One-liner when monitored Telegram groups have urgent traffic in the
    last hour. Lazy-loads jarvis-telegram so installs without the bot pay
    nothing. Heuristic-only — no Anthropic call from this hot path."""
    if os.environ.get("JARVIS_TELEGRAM", "1") != "1":
        return ""
    src = ASSISTANT_DIR / "bin" / "jarvis-telegram.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-telegram.py"
    if not src.exists():
        return ""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("jarvis_telegram", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod.context_hint() or ""
    except Exception:
        return ""


def _social_hint() -> str:
    """One-liner when there are unresponded mentions/DMs from the last 24h.
    Same lazy-load contract as the telegram hint. Default master gate is
    honoured by the module itself, so checking the env here is just an
    early-out for installs without any social token configured."""
    if os.environ.get("JARVIS_SOCIAL", "1") == "0":
        return ""
    src = ASSISTANT_DIR / "bin" / "jarvis-social.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-social.py"
    if not src.exists():
        return ""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("jarvis_social_ctx", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod.context_hint() or ""
    except Exception:
        return ""


_NAME_TOKEN_RE = re.compile(r"\b([A-Z][a-zA-Z'\-]{1,})\b")


def _detect_mentioned_names(text: str) -> list[str]:
    """Pull capitalized name-like tokens out of one user turn. Heuristic —
    looks at tokens that start uppercase and are at least 2 chars. Skips
    common sentence starters by checking the lower-cased blocklist."""
    if not text:
        return []
    blocked = {"sir", "i", "ok", "okay", "yes", "no", "the", "and", "but",
               "monday", "tuesday", "wednesday", "thursday", "friday",
               "saturday", "sunday", "january", "february", "march",
               "april", "may", "june", "july", "august", "september",
               "october", "november", "december", "jarvis"}
    names: list[str] = []
    seen: set[str] = set()
    for m in _NAME_TOKEN_RE.finditer(text):
        tok = m.group(1)
        norm = tok.lower()
        if norm in blocked or norm in seen:
            continue
        seen.add(norm)
        names.append(tok)
        if len(names) >= 4:
            break
    return names


def _network_hint(user_text: str | None = None) -> str:
    """One-liner from jarvis-network. Lazy-loaded; pays nothing on installs
    without the network module. Honors JARVIS_NETWORK gate."""
    if os.environ.get("JARVIS_NETWORK", "1") != "1":
        return ""
    src = ASSISTANT_DIR / "bin" / "jarvis-network.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-network.py"
    if not src.exists():
        return ""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("jarvis_network_ctx", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        names = _detect_mentioned_names(user_text or "")
        return mod.context_hint(mentioned_names=names or None) or ""
    except Exception:
        return ""


def _linkedin_hint(user_text: str | None = None) -> str:
    """One-liner from jarvis-linkedin when a mentioned contact has a
    recent role / headline / location change on file. Contacts only —
    linkedin_only profiles are filtered out by the module."""
    src = ASSISTANT_DIR / "bin" / "jarvis-linkedin.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-linkedin.py"
    if not src.exists():
        return ""
    names = _detect_mentioned_names(user_text or "")
    if not names:
        return ""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("jarvis_linkedin_ctx", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod.context_hint(mentioned_names=names) or ""
    except Exception:
        return ""


def _commitments_hint(user_text: str | None = None) -> str:
    """When a contact is named, surface any open commitments tied to
    them so the model leads with 'you owe X to Karina' instead of
    asking what to do next."""
    if os.environ.get("JARVIS_COMMITMENTS", "1") != "1":
        return ""
    src = ASSISTANT_DIR / "bin" / "jarvis-commitments.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-commitments.py"
    if not src.exists():
        return ""
    names = _detect_mentioned_names(user_text or "")
    if not names:
        return ""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "jarvis_commitments_ctx", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod.context_hint(mentioned_names=names) or ""
    except Exception:
        return ""


def _stripe_hint(user_text: str | None = None) -> str:
    """When a contact is named and they're a Stripe customer, surface
    their plan/MRR/status so Jarvis answers in revenue context, not just
    relationship context."""
    if os.environ.get("JARVIS_STRIPE", "1") == "0":
        return ""
    src = ASSISTANT_DIR / "bin" / "jarvis-stripe.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-stripe.py"
    if not src.exists():
        return ""
    names = _detect_mentioned_names(user_text or "")
    if not names:
        return ""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("jarvis_stripe_ctx", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod.context_hint(mentioned_names=names) or ""
    except Exception:
        return ""


def _imessage_hint(user_text: str | None = None) -> str:
    """When a contact is named, surface any unread iMessages from them
    so the model can proactively offer to read or reply."""
    if os.environ.get("JARVIS_IMESSAGE", "1") != "1":
        return ""
    src = ASSISTANT_DIR / "bin" / "jarvis-apple.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-apple.py"
    if not src.exists():
        return ""
    names = _detect_mentioned_names(user_text or "")
    if not names:
        return ""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("jarvis_apple_ctx", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod.context_hint(mentioned_names=names) or ""
    except Exception:
        return ""


def _capability_health_hint() -> str:
    """One-line hint when the reconciliation agent has flagged any capability.
    Reads ~/.jarvis/state/capability-reconciliation.json (written nightly by
    bin/jarvis-reconcile.py). Empty when nothing is flagged so the cache
    stays warm in the common case."""
    src = ASSISTANT_DIR / "bin" / "jarvis-reconcile.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-reconcile.py"
    if not src.exists():
        return ""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("jarvis_reconcile_ctx", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod.context_hint() or ""
    except Exception:
        return ""


def _workflows_hint() -> str:
    """One-liner from jarvis-workflows when a recurring workflow has
    failed on its last run. Empty when everything is healthy."""
    if os.environ.get("JARVIS_WORKFLOWS", "1") != "1":
        return ""
    src = ASSISTANT_DIR / "bin" / "jarvis-workflows.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-workflows.py"
    if not src.exists():
        return ""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("jarvis_workflows_ctx", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod.context_hint() or ""
    except Exception:
        return ""


def _meeting_prep_hint() -> str:
    """One-liner from jarvis-meeting-prep when a prep note is sitting in
    Apple Notes for an event in the next 30 minutes. Empty most of the
    time — only fires right before a prepped meeting."""
    if os.environ.get("JARVIS_MEETING_PREP", "1") != "1":
        return ""
    src = ASSISTANT_DIR / "bin" / "jarvis-meeting-prep.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-meeting-prep.py"
    if not src.exists():
        return ""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("jarvis_meeting_prep_ctx", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod.pending_prep_hint() or ""
    except Exception:
        return ""


def _briefing_hint() -> str:
    """Pull the briefing-pending one-liner from jarvis-briefing if today's
    briefing is sitting unread. Lazy-loaded — same pattern as patterns.py."""
    if os.environ.get("JARVIS_BRIEFING", "1") != "1":
        return ""
    src = ASSISTANT_DIR / "bin" / "jarvis-briefing.py"
    if not src.exists():
        # Repo path during development
        src = Path(__file__).parent / "jarvis-briefing.py"
    if not src.exists():
        return ""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("jarvis_briefing", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod.pending_briefing_hint() or ""
    except Exception:
        return ""


class ContextEngine:
    """Builds the predictive priming block for the system prompt."""

    def __init__(self, now: datetime | None = None,
                 user_text: str | None = None) -> None:
        self.now = now or datetime.now().astimezone()
        self.user_text = user_text

    def predict(self) -> str:
        """Return a ## Current Context block. Empty string if disabled."""
        if os.environ.get("JARVIS_PREDICTIVE_CONTEXT", "1") != "1":
            return ""

        tod_label, tod_hint = _time_of_day_hint(self.now)
        timestamp = self.now.strftime("%A, %-I:%M %p")

        lines: list[str] = []
        lines.append(f"It's {timestamp}.")
        lines.append(_day_shape(self.now))

        # Prefer a learned pattern hint when patterns.json has a match for
        # the current weekday + hour band. Static time-of-day rule is the
        # fallback for cold-start (no patterns yet).
        learned = _learned_pattern_hint(self.now)
        lines.append(learned if learned else tod_hint)

        topics = _recent_topics()
        if topics:
            lines.append("Recent topics: " + " · ".join(topics))

        pending = _pending_count()
        if pending:
            lines.append(f"Pending notifications queued: {pending}.")

        if _persistent_convo_active():
            lines.append("Persistent convo mode is active — conversational tone.")

        ambient = _ambient_hint()
        if ambient:
            lines.append(ambient)

        briefing = _briefing_hint()
        if briefing:
            lines.append(briefing)

        # Meeting prep — points at a saved Apple Note when a prepped
        # meeting is coming up within 30 minutes.
        prep = _meeting_prep_hint()
        if prep:
            lines.append(prep)

        # Workflow failures — surfaces when a scheduled workflow's
        # last run failed so Jarvis leads with "X is broken" if Watson
        # asks "anything wrong".
        workflows = _workflows_hint()
        if workflows:
            lines.append(workflows)

        telegram = _telegram_hint()
        if telegram:
            lines.append(telegram)

        social = _social_hint()
        if social:
            lines.append(social)

        notifications = _notifications_hint()
        if notifications:
            lines.append(notifications)

        cap_health = _capability_health_hint()
        if cap_health:
            lines.append(cap_health)

        # Network hint — keys off names mentioned in the current user turn
        # if available; falls back to surfacing a fading inner-circle alert.
        network = _network_hint(self.user_text)
        if network:
            lines.append(network)

        # LinkedIn hint — recent role/headline/location moves for a
        # mentioned contact. Empty when nothing fresh.
        linkedin = _linkedin_hint(self.user_text)
        if linkedin:
            lines.append(linkedin)

        # Commitments hint — open commitments with a mentioned contact.
        commitments = _commitments_hint(self.user_text)
        if commitments:
            lines.append(commitments)

        # iMessage hint — unread inbound messages from a mentioned
        # contact. Empty when nothing is sitting unread.
        imessage = _imessage_hint(self.user_text)
        if imessage:
            lines.append(imessage)

        # Stripe hint — when a mentioned contact is a paying customer,
        # surface their plan + MRR so the answer is grounded in revenue.
        stripe = _stripe_hint(self.user_text)
        if stripe:
            lines.append(stripe)

        body = "\n".join(lines).strip()
        if not body:
            return ""
        return "## Current Context\n\n" + body


def _smoke_test() -> int:
    block = ContextEngine().predict()
    if not block:
        print("(no block produced — JARVIS_PREDICTIVE_CONTEXT may be 0)")
        return 1
    print(block)
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(_smoke_test())
