#!/usr/bin/env python3
"""JARVIS brain — wraps Anthropic Messages API with tool use and memory.

Invoked once per voice turn:
    jarvis-think.py "<user text>"

Reads:
    ASSISTANT_DIR     base dir (default ~/.jarvis)
    CONFIG_FILE       settings.json path
    HISTORY_FILE      conversation.json path
    ANTHROPIC_API_KEY (required)

Writes:
    HISTORY_FILE      appends user + assistant turns
    speak intermediate updates via $ASSISTANT_DIR/bin/jarvis (when in voice mode)

Prints:
    final assistant text to stdout

Tool use loop is capped at MAX_TOOL_ROUNDS to bound voice latency. The full
back-and-forth (tool_use + tool_result blocks) lives only in memory for the
current turn — only the final assistant text is persisted to HISTORY_FILE,
keeping the on-disk conversation human-readable across sessions.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import secrets
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
BIN_DIR = ASSISTANT_DIR / "bin"
HISTORY_FILE = Path(os.environ["HISTORY_FILE"]) if os.environ.get("HISTORY_FILE") else (
    ASSISTANT_DIR / "cache" / "conversation.json"
)
CONFIG_FILE = Path(os.environ.get("CONFIG_FILE", str(ASSISTANT_DIR / "config" / "settings.json")))

DEFAULT_MODEL = "claude-haiku-4-5-20251001"
MAX_TOOL_ROUNDS = 5
MAX_TOKENS = 1024

# Parallel tool execution (Innovation 5). Within a single round, Claude can
# emit multiple tool_use blocks; they're independent by construction since
# none has seen another's result yet. Threading them shaves the slow ones
# (network-bound: search_contacts, recall on a large store) off the critical
# path. Sequential when JARVIS_PARALLEL_TOOLS=0, when there's only one tool
# in the round (no win from pool overhead), or when the pool itself fails.
PARALLEL_TOOLS_ENABLED = os.environ.get("JARVIS_PARALLEL_TOOLS", "1") == "1"
PARALLEL_TOOLS_TIMEOUT_S = float(os.environ.get("JARVIS_PARALLEL_TOOLS_TIMEOUT_S", "20"))
PARALLEL_TOOLS_HINT = (
    "When the user gives a compound request with multiple independent "
    "actions (e.g. 'set a timer AND remind me about X', 'check the time "
    "and pull up Karina's contact'), decompose it into separate tool "
    "calls in a single response and let them all execute. Don't ask for "
    "confirmation on each individual action — only on irreversible ones."
)

# Watson's auto-memory dirs (file-per-fact pattern, indexed by MEMORY.md).
# Both are loaded into the cacheable system block as a separate breakpoint —
# changes there invalidate only the auto-memory cache, not the personality.
AUTO_MEMORY_DIRS = [
    Path.home() / ".claude" / "projects" / "-Users-watsonwheeler" / "memory",
    Path.home() / ".claude" / "projects" / "-Users-watsonwheeler-jarvis" / "memory",
]
# Bound the per-file size returned by the read_memory_file tool — paranoia
# against a single bloated file blowing out the context.
MAX_MEMORY_FILE_BYTES = 12000


# ── memory module: import sibling jarvis_memory.py without bin/ on PYTHONPATH ─
def _load_memory_module():
    src = BIN_DIR / "jarvis_memory.py"
    if not src.exists():
        # development worktree fallback
        src = Path(__file__).parent / "jarvis_memory.py"
    spec = importlib.util.spec_from_file_location("jarvis_memory", src)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod

memory_mod = _load_memory_module()
Memory = memory_mod.Memory


# ── outcome ledger: best-effort import; emit() is a no-op when missing ──
LIB_DIR = ASSISTANT_DIR / "lib"


def _load_ledger_module():
    src = LIB_DIR / "outcome_ledger.py"
    if not src.exists():
        # development worktree fallback: repo lib/ is sibling to bin/
        src = Path(__file__).parent.parent / "lib" / "outcome_ledger.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("outcome_ledger", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    except Exception:
        return None


_ledger_mod = _load_ledger_module()


def _load_primitive_module():
    src = LIB_DIR / "primitive.py"
    if not src.exists():
        src = Path(__file__).parent.parent / "lib" / "primitive.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("primitive", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    except Exception:
        return None


_primitive_mod = _load_primitive_module()


def _load_tool_selector_module():
    src = LIB_DIR / "tool_selector.py"
    if not src.exists():
        src = Path(__file__).parent.parent / "lib" / "tool_selector.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("tool_selector", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    except Exception:
        return None


_tool_selector_mod = _load_tool_selector_module()


# ── demo-mode fixtures: optional, gated by JARVIS_DEMO=1 ──────────────
def _load_demo_module():
    src = LIB_DIR / "demo_data.py"
    if not src.exists():
        src = Path(__file__).parent.parent / "lib" / "demo_data.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("demo_data", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    except Exception:
        return None


_demo_mod = _load_demo_module()


# ── model router: lazy-loaded; absent file → API path is the only path. ──
def _load_router_module():
    src = LIB_DIR / "model_router.py"
    if not src.exists():
        src = Path(__file__).parent.parent / "lib" / "model_router.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("model_router", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    except Exception:
        return None


_router_mod = _load_router_module()


# Bucketing for the outcome ledger. Tools without an entry get bucketed by
# their tool name (so e.g. `recall` rolls up under `recall`); the six working
# capabilities cluster their related tools so reconciliation health is reported
# per capability, not per tool.
TOOL_CAPABILITY_MAP: dict[str, str] = {
    "remember": "memory",
    "recall": "memory",
    "read_memory_file": "memory",
    "search_contacts": "contacts",
    "lookup_contact": "contacts",
    "relationship_brief": "contacts",
    "enrich_contact": "contacts",
    "network_search": "network",
    "network_map": "network",
    "relationship_score": "network",
    "network_suggest": "network",
    "enrich_network": "network",
    "network_alerts": "network",
    "check_email": "email",
    "draft_email": "email",
    "send_email": "email",
    "reply_email": "email",
    "check_calendar": "calendar",
    "create_event": "calendar",
    "update_event": "calendar",
    "delete_event": "calendar",
    "check_telegram": "telegram",
    "telegram_digest": "telegram",
    "telegram_search": "telegram",
    "send_telegram": "telegram",
    "check_social": "social",
    "social_digest": "social",
    "social_search": "social",
    "social_post": "social",
    "social_reply": "social",
    "network_search": "network",
    "network_map": "network",
    "relationship_score": "network",
    "network_suggest": "network",
    "enrich_network": "network",
    "network_alerts": "network",
    "linkedin_enrich": "network",
    "linkedin_sync": "network",
    "linkedin_monitor": "network",
    "linkedin_changes": "network",
    "linkedin_search": "network",
    "extract_commitments": "commitments",
    "add_commitment": "commitments",
    "list_commitments": "commitments",
    "complete_commitment": "commitments",
    "commitment_report": "commitments",
    "trello_sync": "commitments",
    "trello_boards": "commitments",
    "trello_add": "commitments",
    "trello_move": "commitments",
    "apple_add_reminder": "apple",
    "apple_list_reminders": "apple",
    "apple_complete_reminder": "apple",
    "apple_save_note": "apple",
    "apple_read_note": "apple",
    "apple_contacts_search": "apple",
    "imessage_check": "messaging",
    "imessage_read": "messaging",
    "imessage_send": "messaging",
    "imessage_search_contacts": "messaging",
    "stripe_dashboard": "stripe",
    "stripe_customers": "stripe",
    "stripe_customer": "stripe",
    "stripe_revenue": "stripe",
    "stripe_alerts": "stripe",
    "meeting_prep": "meeting_prep",
    "meeting_prep_settings": "meeting_prep",
    "create_workflow": "workflows",
    "list_workflows": "workflows",
    "run_workflow": "workflows",
    "update_workflow": "workflows",
    "delete_workflow": "workflows",
    "web_search": "research",
    "research_topic": "research",
    "execute_plan": "orchestrator",
    "get_briefing": "briefing",
    "check_notifications": "notifications",
    "dismiss_notification": "notifications",
    "notification_preferences": "notifications",
    "style_apply": "style",
    "style_status": "style",
    "set_timer": "timer",
    "set_reminder": "timer",
    "run_command": "shell",
    "get_time": "clock",
    "get_date": "clock",
    "extract_commitments": "commitments",
    "add_commitment": "commitments",
    "list_commitments": "commitments",
    "complete_commitment": "commitments",
    "commitment_report": "commitments",
    "trello_sync": "trello",
    "trello_boards": "trello",
    "trello_add": "trello",
    "trello_move": "trello",
    "apple_add_reminder": "apple",
    "apple_list_reminders": "apple",
    "apple_complete_reminder": "apple",
    "apple_save_note": "apple",
    "apple_read_note": "apple",
    "imessage_check": "imessage",
    "imessage_read": "imessage",
    "imessage_send": "imessage",
    "imessage_search_contacts": "imessage",
    "apple_contacts_search": "apple",
}


# ── context module: lazy-loaded, optional. Disabled if file missing. ──
_context_mod = None


def _load_context_module():
    global _context_mod
    if _context_mod is not None:
        return _context_mod
    src = BIN_DIR / "jarvis-context.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_context", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _context_mod = mod
        return mod
    except Exception:
        return None


# ── feedback module: lazy-loaded, optional. Provides system_prompt_hint(). ──
_feedback_mod = None


def _load_feedback_module():
    global _feedback_mod
    if _feedback_mod is not None:
        return _feedback_mod
    src = BIN_DIR / "jarvis-feedback.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_feedback", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _feedback_mod = mod
        return mod
    except Exception:
        return None


# ── metacog module: per-domain accuracy + calibration ────────────────
_metacog_mod = None


def _load_metacog_module():
    global _metacog_mod
    if _metacog_mod is not None:
        return _metacog_mod
    src = BIN_DIR / "jarvis-metacog.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_metacog", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _metacog_mod = mod
        return mod
    except Exception:
        return None


# ── autopsy module: lessons learned from past failures ───────────────
_autopsy_mod = None


def _load_autopsy_module():
    global _autopsy_mod
    if _autopsy_mod is not None:
        return _autopsy_mod
    src = BIN_DIR / "jarvis-autopsy.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_autopsy", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _autopsy_mod = mod
        return mod
    except Exception:
        return None


# ── skills module: learned workflows ────────────────────────────────
_skills_mod = None


def _load_skills_module():
    global _skills_mod
    if _skills_mod is not None:
        return _skills_mod
    src = BIN_DIR / "jarvis-skills.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_skills_learned", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _skills_mod = mod
        return mod
    except Exception:
        return None


# ── synthesize module: distilled user profile (Sonnet-built, weekly) ─
_synth_mod = None


def _load_synth_module():
    global _synth_mod
    if _synth_mod is not None:
        return _synth_mod
    src = BIN_DIR / "jarvis-synthesize.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_synthesize", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _synth_mod = mod
        return mod
    except Exception:
        return None


# ── evolve module: pending self-improvement draft (user-approval gated) ─
_evolve_mod = None


def _load_evolve_module():
    global _evolve_mod
    if _evolve_mod is not None:
        return _evolve_mod
    src = BIN_DIR / "jarvis-evolve.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_evolve", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _evolve_mod = mod
        return mod
    except Exception:
        return None


# ── tool implementations ──────────────────────────────────────────────
def _voice_speak(text: str, force: bool = False) -> None:
    """Speak via the jarvis CLI (best-effort, won't raise)."""
    jbin = BIN_DIR / "jarvis"
    if not jbin.exists():
        return
    args = [str(jbin), "--speak" if force else None, text] if force else [str(jbin), text]
    args = [a for a in args if a is not None]
    try:
        subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    except Exception:
        pass


def _tool_remember(args: dict, mem: Memory) -> dict:
    text = (args.get("text") or "").strip()
    if not text:
        return {"error": "text is required"}
    tags = args.get("tags") or []
    rec = mem.remember(text, tags=tags, source="voice")
    return {"id": rec["id"], "saved": True}


def _tool_recall(args: dict, mem: Memory) -> dict:
    query = args.get("query") or ""
    limit = int(args.get("limit") or 5)
    hits = mem.recall(query, limit=limit) if query else mem.recent(limit)
    return {
        "memories": [
            {"id": r["id"], "created_at": r["created_at"][:10], "text": r["text"]}
            for r in hits
        ],
        "count": len(hits),
    }


def _tool_get_time(_args: dict, _mem: Memory) -> dict:
    now = datetime.now().astimezone()
    return {
        "iso": now.isoformat(timespec="seconds"),
        "human": now.strftime("%-I:%M %p %Z"),
        "weekday": now.strftime("%A"),
    }


def _tool_get_date(_args: dict, _mem: Memory) -> dict:
    now = datetime.now().astimezone()
    return {
        "iso": now.date().isoformat(),
        "human": now.strftime("%A, %B %-d, %Y"),
    }


def _command_is_safe(command: str, allowlist: list[str]) -> bool:
    """Return True if command starts with any allowed prefix."""
    cmd = command.strip()
    return any(cmd == p or cmd.startswith(p + " ") for p in allowlist)


def _tool_run_command(args: dict, _mem: Memory) -> dict:
    command = (args.get("command") or "").strip()
    reason = args.get("reason") or ""
    if not command:
        return {"error": "command is required"}

    cfg = _load_config()
    allowlist = cfg.get("command_allowlist") or []
    auto_confirm = bool(cfg.get("auto_confirm_commands"))

    needs_prompt = not (auto_confirm or _command_is_safe(command, allowlist))
    if needs_prompt:
        prompt = f"\n  JARVIS wants to run: {command}"
        if reason:
            prompt += f"\n  Reason: {reason}"
        prompt += "\n  Allow? [y/N]: "
        try:
            with open("/dev/tty", "r+") as tty:
                tty.write(prompt)
                tty.flush()
                answer = tty.readline().strip().lower()
        except OSError:
            # No tty (e.g. invoked from LaunchAgent) — refuse silently for safety
            return {"executed": False, "reason": "no tty for confirmation"}
        if answer not in ("y", "yes"):
            return {"executed": False, "reason": "user denied"}

    try:
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True, timeout=20
        )
    except subprocess.TimeoutExpired:
        return {"executed": True, "exit_code": -1, "stdout": "", "stderr": "command timed out after 20s"}

    out = (result.stdout or "")[:2000]
    err = (result.stderr or "")[:2000]
    return {
        "executed": True,
        "exit_code": result.returncode,
        "stdout": out,
        "stderr": err,
    }


def _tool_read_memory_file(args: dict, _mem: Memory) -> dict:
    """Read one file from Watson's auto-memory dirs by name. The MEMORY.md index
    in the system prompt lists what's available — pick names from there."""
    name = (args.get("name") or "").strip()
    if not name:
        return {"error": "name is required"}
    # Defense against path traversal — we only accept bare filenames.
    if "/" in name or ".." in name or name.startswith("."):
        return {"error": "name must be a bare filename, no path separators"}
    if not name.endswith(".md"):
        name = name + ".md"
    for d in AUTO_MEMORY_DIRS:
        path = d / name
        if path.exists() and path.is_file():
            try:
                content = path.read_text(encoding="utf-8")
            except Exception as e:
                return {"error": f"read failed: {e}"}
            truncated = False
            if len(content) > MAX_MEMORY_FILE_BYTES:
                content = content[:MAX_MEMORY_FILE_BYTES] + "\n\n... (truncated)"
                truncated = True
            return {
                "name": name,
                "dir": d.name,
                "content": content,
                "truncated": truncated,
            }
    return {"error": f"not found in either auto-memory dir: {name}"}


def _tool_search_contacts(args: dict, _mem: Memory) -> dict:
    query = (args.get("query") or "").strip()
    if not query:
        return {"error": "query is required"}
    recall_bin = BIN_DIR / "jarvis-recall"
    if not recall_bin.exists():
        return {"error": "jarvis-recall not installed", "query": query}
    try:
        result = subprocess.run(
            [str(recall_bin), "who", query],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            return {"error": (result.stderr or "lookup failed").strip()[:500]}
        return json.loads(result.stdout or "{}")
    except subprocess.TimeoutExpired:
        return {"error": "contact lookup timed out"}
    except json.JSONDecodeError:
        return {"error": "could not parse jarvis-recall output"}


_TIMER_RE = re.compile(r"^\s*(\d+)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)?\s*$", re.I)


def _parse_duration_to_seconds(text: str) -> int | None:
    m = _TIMER_RE.match(text)
    if not m:
        return None
    n = int(m.group(1))
    unit = (m.group(2) or "s").lower()
    if unit.startswith("m") and not unit.startswith("min") and unit != "m":
        unit = "min"
    if unit in ("s", "sec", "secs", "seconds"):
        return n
    if unit in ("m", "min", "mins", "minutes"):
        return n * 60
    if unit in ("h", "hr", "hrs", "hours"):
        return n * 3600
    return None


def _schedule_proactive_alert(seconds: int, message: str) -> None:
    """Spawn a detached `sleep N && jarvis-notify MSG` so the alert reaches
    the user via the notification pipeline (volume ducking, queueing when
    in conversation). Falls back to `jarvis --speak` if jarvis-notify is
    missing — keeps timers working on installs without proactive support."""
    notify_bin = BIN_DIR / "jarvis-notify"
    jbin = BIN_DIR / "jarvis"
    if notify_bin.exists():
        cmd = f'sleep {seconds} && {shlex.quote(str(notify_bin))} {shlex.quote(message)}'
    else:
        cmd = f'sleep {seconds} && {shlex.quote(str(jbin))} --speak {shlex.quote(message)}'
    subprocess.Popen(
        ["bash", "-c", cmd],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def _tool_set_timer(args: dict, _mem: Memory) -> dict:
    duration = args.get("duration") or args.get("seconds")
    if isinstance(duration, (int, float)):
        seconds = int(duration)
    else:
        seconds = _parse_duration_to_seconds(str(duration or ""))
    if seconds is None or seconds <= 0:
        return {"error": "duration must be positive (e.g. 90, '5min', '2 hours')"}
    label = (args.get("label") or "Timer").strip()

    jbin = BIN_DIR / "jarvis"
    if not jbin.exists():
        return {"error": "jarvis CLI not found"}

    msg = f"{label}, sir. Your timer has expired."
    try:
        _schedule_proactive_alert(seconds, msg)
    except Exception as e:
        return {"error": f"failed to start timer: {e}"}

    fires_at = (datetime.now().astimezone() + timedelta(seconds=seconds)).strftime("%-I:%M %p")
    return {"set": True, "label": label, "seconds": seconds, "fires_at": fires_at}


_REMINDER_REL = re.compile(r"^\s*in\s+(\d+)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)\s*$", re.I)


def _parse_when(when: str) -> datetime | None:
    when = (when or "").strip()
    if not when:
        return None
    # "in 5 minutes" / "in 30 seconds"
    rel = _REMINDER_REL.match(when)
    if rel:
        seconds = _parse_duration_to_seconds(f"{rel.group(1)} {rel.group(2)}")
        if seconds:
            return datetime.now().astimezone() + timedelta(seconds=seconds)
    # ISO 8601
    try:
        dt = datetime.fromisoformat(when)
        if dt.tzinfo is None:
            dt = dt.astimezone()
        return dt
    except ValueError:
        pass
    # "HH:MM" today (or tomorrow if past)
    try:
        h, m = when.split(":")[:2]
        now = datetime.now().astimezone()
        target = now.replace(hour=int(h), minute=int(m), second=0, microsecond=0)
        if target <= now:
            target += timedelta(days=1)
        return target
    except (ValueError, IndexError):
        pass
    return None


def _tool_set_reminder(args: dict, _mem: Memory) -> dict:
    when_str = args.get("when") or ""
    message = (args.get("message") or "").strip()
    if not message:
        return {"error": "message is required"}
    target = _parse_when(when_str)
    if target is None:
        return {"error": f"could not parse 'when': {when_str!r}. Try 'in 5 minutes', '15:30', or ISO 8601."}

    seconds = int((target - datetime.now().astimezone()).total_seconds())
    if seconds <= 0:
        return {"error": "reminder time is in the past"}

    jbin = BIN_DIR / "jarvis"
    if not jbin.exists():
        return {"error": "jarvis CLI not found"}

    spoken = f"Reminder, sir. {message}"
    try:
        _schedule_proactive_alert(seconds, spoken)
    except Exception as e:
        return {"error": f"failed to schedule reminder: {e}"}

    return {
        "scheduled": True,
        "fires_at": target.strftime("%A %-I:%M %p %Z"),
        "in_seconds": seconds,
        "message": message,
    }


# ── External agent loaders (Innovations 7 + 8) ──────────────────────
# Email and calendar live in their own files so users without Google API
# credentials never pay their import cost. Lazy-loaded — first call to a
# tool triggers the import; subsequent calls use the cached module.
_email_mod = None
_calendar_mod = None
_orch_mod = None
_briefing_mod = None
_research_mod = None
_telegram_mod = None
_style_mod = None
_contacts_mod = None
_notif_mod = None
_social_mod = None
_commitments_mod = None
_trello_mod = None
_apple_mod = None


def _load_email_module():
    global _email_mod
    if _email_mod is not None:
        return _email_mod
    src = BIN_DIR / "jarvis-email.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_email", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _email_mod = mod
        return mod
    except Exception as e:
        sys.stderr.write(f"jarvis-think: email module load failed ({e})\n")
        return None


def _load_calendar_module():
    global _calendar_mod
    if _calendar_mod is not None:
        return _calendar_mod
    src = BIN_DIR / "jarvis-calendar.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_calendar", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _calendar_mod = mod
        return mod
    except Exception as e:
        sys.stderr.write(f"jarvis-think: calendar module load failed ({e})\n")
        return None


def _load_orchestrator_module():
    global _orch_mod
    if _orch_mod is not None:
        return _orch_mod
    src = BIN_DIR / "jarvis-orchestrate.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_orchestrate", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _orch_mod = mod
        return mod
    except Exception as e:
        sys.stderr.write(f"jarvis-think: orchestrator module load failed ({e})\n")
        return None


def _load_briefing_module():
    global _briefing_mod
    if _briefing_mod is not None:
        return _briefing_mod
    src = BIN_DIR / "jarvis-briefing.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_briefing", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _briefing_mod = mod
        return mod
    except Exception as e:
        sys.stderr.write(f"jarvis-think: briefing module load failed ({e})\n")
        return None


def _load_research_module():
    global _research_mod
    if _research_mod is not None:
        return _research_mod
    src = BIN_DIR / "jarvis-research.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_research", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _research_mod = mod
        return mod
    except Exception as e:
        sys.stderr.write(f"jarvis-think: research module load failed ({e})\n")
        return None


def _load_telegram_module():
    global _telegram_mod
    if _telegram_mod is not None:
        return _telegram_mod
    src = BIN_DIR / "jarvis-telegram.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_telegram", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _telegram_mod = mod
        return mod
    except Exception as e:
        sys.stderr.write(f"jarvis-think: telegram module load failed ({e})\n")
        return None


def _load_contacts_module():
    global _contacts_mod
    if _contacts_mod is not None:
        return _contacts_mod
    src = BIN_DIR / "jarvis-contacts.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_contacts", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _contacts_mod = mod
        return mod
    except Exception as e:
        sys.stderr.write(f"jarvis-think: contacts module load failed ({e})\n")
        return None


def _maybe_note_contact(channel: str, handle: str, summary: str = "") -> None:
    """Best-effort: tap the contacts module to record one interaction.
    Silent on every failure mode — we don't want a contacts hiccup to
    surface as a tool error."""
    if not handle:
        return
    if os.environ.get("JARVIS_CONTACTS_AUTONOTE", "1") != "1":
        return
    mod = _load_contacts_module()
    if mod is None:
        return
    try:
        mod.note_interaction(channel=channel, handle=handle, summary=summary)
    except Exception as e:
        sys.stderr.write(f"jarvis-think: note_interaction skipped ({e})\n")


def _load_style_module():
    global _style_mod
    if _style_mod is not None:
        return _style_mod
    src = BIN_DIR / "jarvis-style.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_style", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _style_mod = mod
        return mod
    except Exception as e:
        sys.stderr.write(f"jarvis-think: style module load failed ({e})\n")
        return None


def _load_notifications_module():
    global _notif_mod
    if _notif_mod is not None:
        return _notif_mod
    src = BIN_DIR / "jarvis-notifications.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_notifications", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _notif_mod = mod
        return mod
    except Exception as e:
        sys.stderr.write(f"jarvis-think: notifications module load failed ({e})\n")
        return None


def _load_social_module():
    global _social_mod
    if _social_mod is not None:
        return _social_mod
    src = BIN_DIR / "jarvis-social.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_social", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _social_mod = mod
        return mod
    except Exception as e:
        sys.stderr.write(f"jarvis-think: social module load failed ({e})\n")
        return None


def _load_network_module():
    global _network_mod
    if _network_mod is not None:
        return _network_mod
    src = BIN_DIR / "jarvis-network.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_network", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _network_mod = mod
        return mod
    except Exception as e:
        sys.stderr.write(f"jarvis-think: network module load failed ({e})\n")
        return None


def _load_commitments_module():
    global _commitments_mod
    if _commitments_mod is not None:
        return _commitments_mod
    src = BIN_DIR / "jarvis-commitments.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-commitments.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_commitments", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _commitments_mod = mod
        return mod
    except Exception as e:
        sys.stderr.write(f"jarvis-think: commitments module load failed ({e})\n")
        return None


def _load_trello_module():
    global _trello_mod
    if _trello_mod is not None:
        return _trello_mod
    src = BIN_DIR / "jarvis-trello.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-trello.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_trello", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _trello_mod = mod
        return mod
    except Exception as e:
        sys.stderr.write(f"jarvis-think: trello module load failed ({e})\n")
        return None


def _load_apple_module():
    global _apple_mod
    if _apple_mod is not None:
        return _apple_mod
    src = BIN_DIR / "jarvis-apple.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-apple.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_apple", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _apple_mod = mod
        return mod
    except Exception as e:
        sys.stderr.write(f"jarvis-think: apple module load failed ({e})\n")
        return None


def _maybe_apply_style(text: str, channel: str | None) -> tuple[str, dict | None]:
    """Run text through jarvis-style.apply_style if the module + profile
    are present. Returns (final_text, style_result) — style_result is None
    when the module isn't available so callers can tell apart 'didn't run'
    from 'ran but passed through'. Best-effort: any failure returns the
    original text untouched."""
    if os.environ.get("JARVIS_STYLE_AUTOAPPLY", "1") != "1":
        return text, None
    mod = _load_style_module()
    if mod is None:
        return text, None
    try:
        res = mod.apply_style(text, channel=channel)
    except Exception as e:
        sys.stderr.write(f"jarvis-think: apply_style failed ({e})\n")
        return text, None
    if not isinstance(res, dict) or res.get("error"):
        return text, res if isinstance(res, dict) else None
    styled = (res.get("styled") or text).strip() or text
    return styled, res


def _tool_check_email(args: dict, _mem: Memory) -> dict:
    """Email-triage migration proof — uses the primitive layer for outcome
    tracking. The central _execute_one_tool wrap already emits to the ledger
    on every call; this handler stays tiny because the primitive layer covers
    the cross-capability concerns."""
    mod = _load_email_module()
    if mod is None:
        return {"error": "jarvis-email module not installed"}
    return mod.check_email(
        max_results=int(args.get("max_results") or 5),
        query=args.get("query") or "is:unread",
    )


def _tool_draft_email(args: dict, _mem: Memory) -> dict:
    """Pulls relevant context (memory + contacts + email history) via
    primitive.retrieve() before drafting so Claude has the recipient's
    history attached to the draft preview."""
    mod = _load_email_module()
    if mod is None:
        return {"error": "jarvis-email module not installed"}
    body = args.get("body") or ""
    styled_body, style_res = _maybe_apply_style(body, channel="email") if body else (body, None)
    out = mod.draft_email(
        to=args.get("to") or "",
        subject=args.get("subject") or "",
        body=styled_body,
        thread_id=args.get("thread_id"),
    )
    if isinstance(out, dict) and style_res and not style_res.get("passthrough"):
        out["style_applied"] = True

    # Attach prior context for the recipient so the next round of Claude has
    # what it needs to refine the draft. Best-effort — never blocks the draft.
    if isinstance(out, dict) and not out.get("error") and _primitive_mod is not None:
        recipient = args.get("to") or ""
        subject = args.get("subject") or ""
        query = " ".join(s for s in (recipient, subject) if s).strip()
        if query:
            try:
                hits = _primitive_mod.retrieve(
                    query, sources=["memory", "contacts", "email"], limit=3,
                )
                if hits:
                    out["prior_context"] = [
                        {"source": h["source"], "text": h["text"][:200]}
                        for h in hits
                    ]
            except Exception:
                pass
    return out


def _tool_send_email(args: dict, _mem: Memory) -> dict:
    """Records the send via primitive.remember() so the next 'who did I
    email about X' query has a fast KV hit, and updates contact memory
    via the existing channel."""
    mod = _load_email_module()
    if mod is None:
        return {"error": "jarvis-email module not installed"}
    out = mod.send_email(
        draft_id=args.get("draft_id"),
        to=args.get("to"),
        subject=args.get("subject"),
        body=args.get("body"),
        confirm=bool(args.get("confirm")),
    )
    if isinstance(out, dict) and out.get("sent"):
        recipient = args.get("to") or ""
        if recipient:
            _maybe_note_contact("email", recipient,
                                summary=(args.get("subject") or "")[:200])
        # Drop a primitive memory pointer so the next session can fast-path
        # "what did I send to <recipient>" without re-querying Gmail.
        if _primitive_mod is not None and recipient:
            try:
                _primitive_mod.remember(
                    f"last_email_to:{recipient}",
                    {
                        "subject": args.get("subject") or "",
                        "thread_id": out.get("thread_id"),
                        "message_id": out.get("message_id"),
                    },
                    ttl_days=30,
                )
            except Exception:
                pass
    return out


def _tool_reply_email(args: dict, _mem: Memory) -> dict:
    mod = _load_email_module()
    if mod is None:
        return {"error": "jarvis-email module not installed"}
    thread_id = args.get("thread_id")
    body = args.get("body")
    if not thread_id or not body:
        return {"error": "thread_id and body required"}
    out = mod.reply_email(thread_id=thread_id, body=body,
                          confirm=bool(args.get("confirm")))
    # No `to` on a reply call — the recipient is on the thread headers.
    # We rely on enrich_contact's email harvester to pick the exchange up
    # next time, so don't try to reverse-lookup the address here.
    return out


def _tool_check_calendar(args: dict, _mem: Memory) -> dict:
    mod = _load_calendar_module()
    if mod is None:
        return {"error": "jarvis-calendar module not installed"}
    return mod.check_calendar(
        date=args.get("date"),
        days=int(args.get("days") or 1),
        calendar_id=args.get("calendar_id") or "primary",
    )


def _tool_create_event(args: dict, _mem: Memory) -> dict:
    mod = _load_calendar_module()
    if mod is None:
        return {"error": "jarvis-calendar module not installed"}
    summary = args.get("summary")
    start = args.get("start")
    if not summary or not start:
        return {"error": "summary and start required"}
    return mod.create_event(
        summary=summary,
        start=start,
        end=args.get("end"),
        attendees=args.get("attendees") or [],
        location=args.get("location"),
        description=args.get("description"),
        calendar_id=args.get("calendar_id") or "primary",
    )


def _tool_update_event(args: dict, _mem: Memory) -> dict:
    mod = _load_calendar_module()
    if mod is None:
        return {"error": "jarvis-calendar module not installed"}
    event_id = args.get("event_id")
    if not event_id:
        return {"error": "event_id required"}
    return mod.update_event(
        event_id=event_id,
        summary=args.get("summary"),
        start=args.get("start"),
        end=args.get("end"),
        attendees=args.get("attendees"),
        location=args.get("location"),
        description=args.get("description"),
        calendar_id=args.get("calendar_id") or "primary",
    )


def _tool_delete_event(args: dict, _mem: Memory) -> dict:
    mod = _load_calendar_module()
    if mod is None:
        return {"error": "jarvis-calendar module not installed"}
    event_id = args.get("event_id")
    if not event_id:
        return {"error": "event_id required"}
    return mod.delete_event(
        event_id=event_id,
        confirm=bool(args.get("confirm")),
        calendar_id=args.get("calendar_id") or "primary",
    )


def _tool_execute_plan(args: dict, _mem: Memory) -> dict:
    mod = _load_orchestrator_module()
    if mod is None:
        return {"error": "jarvis-orchestrate module not installed"}
    goal = (args.get("goal") or "").strip()
    if not goal:
        return {"error": "goal is required"}
    return mod.execute_plan(goal)


def _tool_get_briefing(args: dict, _mem: Memory) -> dict:
    mod = _load_briefing_module()
    if mod is None:
        return {"error": "jarvis-briefing module not installed"}
    # Default behavior: return today's briefing if it exists; otherwise
    # generate it on demand. This keeps "what's my day look like" snappy
    # when the cron has already run, and still works on cold-start.
    rec = mod.get_today()
    if rec.get("error"):
        rec = mod.generate_today(force=False)
    if rec.get("error"):
        return rec
    if args.get("mark_delivered"):
        try:
            mod.mark_delivered()
            rec["marked_delivered"] = True
        except Exception as e:
            rec["mark_delivered_error"] = str(e)
    return rec


def _tool_web_search(args: dict, _mem: Memory) -> dict:
    mod = _load_research_module()
    if mod is None:
        return {"error": "jarvis-research module not installed"}
    return mod.web_search(
        query=args.get("query") or "",
        max_results=int(args.get("max_results") or 5),
    )


def _tool_research_topic(args: dict, _mem: Memory) -> dict:
    mod = _load_research_module()
    if mod is None:
        return {"error": "jarvis-research module not installed"}
    return mod.research_topic(
        topic=args.get("topic") or "",
        depth=args.get("depth") or "quick",
    )


def _tool_check_telegram(args: dict, _mem: Memory) -> dict:
    mod = _load_telegram_module()
    if mod is None:
        return {"error": "jarvis-telegram module not installed"}
    return mod.check_telegram(
        group_name=args.get("group_name"),
        hours=int(args.get("hours") or 4),
    )


def _tool_telegram_digest(args: dict, _mem: Memory) -> dict:
    mod = _load_telegram_module()
    if mod is None:
        return {"error": "jarvis-telegram module not installed"}
    return mod.telegram_digest(
        hours=int(args.get("hours") or 12),
        priority=args.get("priority") or "all",
    )


def _tool_telegram_search(args: dict, _mem: Memory) -> dict:
    mod = _load_telegram_module()
    if mod is None:
        return {"error": "jarvis-telegram module not installed"}
    query = args.get("query") or ""
    if not query:
        return {"error": "query is required"}
    return mod.telegram_search(
        query=query,
        group_name=args.get("group_name"),
        hours=int(args.get("hours") or 48),
    )


def _tool_check_notifications(args: dict, _mem: Memory) -> dict:
    mod = _load_notifications_module()
    if mod is None:
        return {"error": "jarvis-notifications module not installed"}
    return mod.get_notifications(filter=args.get("filter"))


def _tool_dismiss_notification(args: dict, _mem: Memory) -> dict:
    mod = _load_notifications_module()
    if mod is None:
        return {"error": "jarvis-notifications module not installed"}
    nid = (args.get("id") or "").strip()
    if not nid:
        return {"error": "id is required"}
    return mod.dismiss(nid)


def _tool_notification_preferences(args: dict, _mem: Memory) -> dict:
    mod = _load_notifications_module()
    if mod is None:
        return {"error": "jarvis-notifications module not installed"}
    if args.get("show"):
        return mod.get_rules()
    rules = args.get("rules") or {}
    if not isinstance(rules, dict):
        return {"error": "rules must be an object"}
    return mod.set_rules(rules)


def _tool_lookup_contact(args: dict, _mem: Memory) -> dict:
    mod = _load_contacts_module()
    if mod is None:
        return {"error": "jarvis-contacts module not installed"}
    name = (args.get("name") or "").strip()
    if not name:
        return {"error": "name is required"}
    return mod.lookup_contact(name)


def _tool_relationship_brief(args: dict, _mem: Memory) -> dict:
    mod = _load_contacts_module()
    if mod is None:
        return {"error": "jarvis-contacts module not installed"}
    name = (args.get("name") or "").strip()
    if not name:
        return {"error": "name is required"}
    return mod.relationship_brief(name)


def _tool_enrich_contact(args: dict, _mem: Memory) -> dict:
    mod = _load_contacts_module()
    if mod is None:
        return {"error": "jarvis-contacts module not installed"}
    name = (args.get("name") or "").strip()
    if not name:
        return {"error": "name is required"}
    return mod.enrich_contact(name, force=bool(args.get("force")))


def _tool_contact_sync(args: dict, _mem: Memory) -> dict:
    """Sync from Apple Contacts — Apple is the source of truth for who
    exists in Jarvis's relationship memory."""
    mod = _load_contacts_module()
    if mod is None:
        return {"error": "jarvis-contacts module not installed"}
    if not hasattr(mod, "sync_from_apple_contacts"):
        return {"error": "contacts module is too old; missing sync_from_apple_contacts"}
    enrich = args.get("enrich")
    enrich = True if enrich is None else bool(enrich)
    limit = args.get("limit")
    limit = int(limit) if limit not in (None, "") else None
    return mod.sync_from_apple_contacts(enrich=enrich, limit=limit)


def _tool_apollo_enrich(args: dict, _mem: Memory) -> dict:
    mod = _load_contacts_module()
    if mod is None:
        return {"error": "jarvis-contacts module not installed"}
    if not hasattr(mod, "apollo_enrich"):
        return {"error": "contacts module is too old; missing apollo_enrich"}
    name = (args.get("name") or "").strip()
    if not name:
        return {"error": "name is required"}
    return mod.apollo_enrich(name, force=bool(args.get("force")))


# ── approve_message: outbound message gate ─────────────────────────────
APPROVALS_DIR = ASSISTANT_DIR / "approvals"
APPROVALS_FILE = APPROVALS_DIR / "pending.json"
APPROVAL_TTL_S = 24 * 3600  # auto-expire pending approvals after 24h


def _load_pending_approvals() -> dict:
    if not APPROVALS_FILE.exists():
        return {}
    try:
        data = json.loads(APPROVALS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    # Drop expired entries on read.
    now = time.time()
    out = {}
    for k, v in data.items():
        try:
            ts = datetime.fromisoformat(v.get("created_at", "")).timestamp()
        except Exception:
            ts = 0
        if now - ts < APPROVAL_TTL_S:
            out[k] = v
    return out


def _save_pending_approvals(data: dict) -> None:
    APPROVALS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = APPROVALS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, APPROVALS_FILE)


def _dispatch_approved_message(rec: dict) -> dict:
    """When the user approves, fire the underlying channel send tool."""
    channel = rec.get("channel")
    recipient = rec.get("recipient") or ""
    draft = rec.get("draft") or ""
    subject = rec.get("subject") or ""
    if channel == "email":
        mod = _load_email_module()
        if mod is None:
            return {"error": "jarvis-email module not installed"}
        return mod.send_email(to=recipient, subject=subject, body=draft, confirm=True)
    if channel == "imessage":
        mod = _load_apple_module()
        if mod is None:
            return {"error": "jarvis-apple module not installed"}
        return mod.imessage_send(recipient, draft, confirm=True)
    if channel == "telegram":
        mod = _load_telegram_module()
        if mod is None:
            return {"error": "jarvis-telegram module not installed"}
        return mod.send_telegram(recipient, draft, confirm=True)
    if channel == "social":
        # Recipient encodes "platform:item_id" so we can route to the
        # right cached post (twitter/linkedin/etc.) without a separate
        # field. Mirrors the social_reply tool signature.
        mod = _load_social_module()
        if mod is None:
            return {"error": "jarvis-social module not installed"}
        if not hasattr(mod, "social_reply"):
            return {"error": "jarvis-social is missing social_reply"}
        platform, _, item_id = recipient.partition(":")
        if not platform or not item_id:
            return {"error": "social recipient must be 'platform:item_id' "
                             "(e.g. 'twitter:abc123')"}
        return mod.social_reply(platform=platform, item_id=item_id,
                                message=draft, confirm=True)
    return {"error": f"approve_message can't dispatch channel {channel!r} yet"}


def _tool_approve_message(args: dict, _mem: Memory) -> dict:
    """Two-phase outbound-message gate.

    Phase 1 — submit a draft for approval:
        approve_message(channel, recipient, draft, [subject])
        Persists the draft, returns voice-prompt copy for Jarvis to read
        aloud, and asks the user to say 'send' / 'change' / 'cancel'.

    Phase 2 — record the user's decision:
        approve_message(approval_id, decision="approve"|"reject")
        On 'approve', dispatches via the channel's send tool (with
        confirm=True) and clears the pending entry.
        On 'reject', clears the pending entry without sending.
    """
    decision = (args.get("decision") or "").strip().lower()
    approval_id = (args.get("approval_id") or "").strip()

    # Phase 2 — decision on existing approval.
    if decision or approval_id:
        if not approval_id:
            return {"error": "approval_id is required when decision is provided"}
        if decision not in ("approve", "reject"):
            return {"error": "decision must be 'approve' or 'reject'"}
        pending = _load_pending_approvals()
        rec = pending.get(approval_id)
        if not rec:
            return {"error": f"no pending approval with id {approval_id!r} "
                             f"(may have expired after 24h)"}
        if decision == "reject":
            pending.pop(approval_id, None)
            _save_pending_approvals(pending)
            return {"ok": True, "decision": "rejected", "approval_id": approval_id}
        # Approved — dispatch and clear.
        sent = _dispatch_approved_message(rec)
        pending.pop(approval_id, None)
        _save_pending_approvals(pending)
        return {
            "ok": bool(sent.get("sent") or sent.get("ok")),
            "decision": "approved",
            "approval_id": approval_id,
            "channel": rec.get("channel"),
            "recipient": rec.get("recipient"),
            "send_result": sent,
        }

    # Phase 1 — new draft submission.
    channel = (args.get("channel") or "").strip().lower()
    recipient = (args.get("recipient") or "").strip()
    draft = (args.get("draft") or "").strip()
    subject = (args.get("subject") or "").strip()
    if channel not in ("email", "imessage", "telegram", "social"):
        return {"error": "channel must be one of: email, imessage, telegram, social"}
    if not recipient:
        return {"error": "recipient is required"}
    if not draft:
        return {"error": "draft is required"}
    if channel == "email" and not subject:
        return {"error": "subject is required for email drafts"}
    if channel == "social" and ":" not in recipient:
        return {"error": "for channel='social', recipient must be "
                         "'platform:item_id' (e.g. 'twitter:abc123' from "
                         "the cached post that's being replied to)"}

    aid = secrets.token_urlsafe(8)
    pending = _load_pending_approvals()
    pending[aid] = {
        "id": aid,
        "channel": channel,
        "recipient": recipient,
        "subject": subject or None,
        "draft": draft,
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    _save_pending_approvals(pending)

    channel_label = {
        "email": "an email",
        "imessage": "an iMessage",
        "telegram": "a Telegram",
        "social": "a social reply",
    }[channel]
    if channel == "email":
        prompt = (f"I have {channel_label} for {recipient} — "
                  f"subject {subject!r}. Should I read the draft, "
                  f"send it, or change it?")
    else:
        preview = draft if len(draft) <= 240 else draft[:237] + "..."
        prompt = (f"I have {channel_label} for {recipient}: {preview!r}. "
                  f"Send it, or change it?")
    return {
        "ok": True,
        "awaiting_approval": True,
        "approval_id": aid,
        "channel": channel,
        "recipient": recipient,
        "subject": subject or None,
        "draft": draft,
        "voice_prompt": prompt,
        "next_action": (
            "Read the voice_prompt aloud and wait for Watson to respond. "
            "If he says 'send' / 'yes' / 'approved', call approve_message "
            f"again with approval_id={aid!r} and decision='approve'. If he "
            "says 'change' / 'reject' / 'no', call with decision='reject' "
            "and then redraft."
        ),
    }


def _tool_style_apply(args: dict, _mem: Memory) -> dict:
    mod = _load_style_module()
    if mod is None:
        return {"error": "jarvis-style module not installed"}
    text = args.get("text") or ""
    if not text:
        return {"error": "text is required"}
    return mod.apply_style(text, channel=args.get("channel"))


def _tool_style_status(_args: dict, _mem: Memory) -> dict:
    mod = _load_style_module()
    if mod is None:
        return {"error": "jarvis-style module not installed"}
    return mod.status()


def _tool_check_social(args: dict, _mem: Memory) -> dict:
    mod = _load_social_module()
    if mod is None:
        return {"error": "jarvis-social module not installed"}
    return mod.check_social(
        platform=args.get("platform"),
        hours=int(args.get("hours") or 4),
    )


def _tool_social_digest(args: dict, _mem: Memory) -> dict:
    mod = _load_social_module()
    if mod is None:
        return {"error": "jarvis-social module not installed"}
    return mod.social_digest(
        hours=int(args.get("hours") or 12),
        platform=args.get("platform"),
    )


def _tool_social_search(args: dict, _mem: Memory) -> dict:
    mod = _load_social_module()
    if mod is None:
        return {"error": "jarvis-social module not installed"}
    query = args.get("query") or ""
    if not query:
        return {"error": "query is required"}
    return mod.social_search(
        query=query,
        platform=args.get("platform"),
        hours=int(args.get("hours") or 48),
    )


def _tool_social_reply(args: dict, _mem: Memory) -> dict:
    mod = _load_social_module()
    if mod is None:
        return {"error": "jarvis-social module not installed"}
    platform = args.get("platform")
    item_id = args.get("item_id")
    message = args.get("message")
    if not platform or not item_id or not message:
        return {"error": "platform, item_id, and message required"}
    confirm = bool(args.get("confirm"))
    final_message = message
    if not confirm:
        final_message, _ = _maybe_apply_style(message, channel=None)
    return mod.social_reply(
        platform=platform, item_id=item_id,
        message=final_message, confirm=confirm,
    )


def _tool_social_post(args: dict, _mem: Memory) -> dict:
    mod = _load_social_module()
    if mod is None:
        return {"error": "jarvis-social module not installed"}
    platform = args.get("platform")
    message = args.get("message")
    if not platform or not message:
        return {"error": "platform and message required"}
    confirm = bool(args.get("confirm"))
    final_message = message
    if not confirm:
        final_message, _ = _maybe_apply_style(message, channel=None)
    return mod.social_post(
        platform=platform, message=final_message, confirm=confirm,
    )


def _tool_send_telegram(args: dict, _mem: Memory) -> dict:
    mod = _load_telegram_module()
    if mod is None:
        return {"error": "jarvis-telegram module not installed"}
    group = args.get("group_name")
    message = args.get("message")
    if not group or not message:
        return {"error": "group_name and message required"}
    # Style only the preview round (confirm=false). Once the user has
    # approved the wording, send_telegram with confirm=true posts the
    # exact text — never silently rewrite an approved message.
    confirm = bool(args.get("confirm"))
    styled_message = message
    style_res: dict | None = None
    if not confirm:
        styled_message, style_res = _maybe_apply_style(message, channel="telegram")
    out = mod.send_telegram(
        group_name=group,
        message=styled_message,
        reply_to=args.get("reply_to"),
        confirm=confirm,
    )
    if isinstance(out, dict) and style_res and not style_res.get("passthrough"):
        out["style_applied"] = True
    return out


# ── Social media handlers ──────────────────────────────────────────
def _tool_check_social(args: dict, _mem: Memory) -> dict:
    mod = _load_social_module()
    if mod is None:
        return {"error": "jarvis-social module not installed"}
    return mod.check_social(
        platform=args.get("platform"),
        hours=int(args.get("hours") or 4),
    )


def _tool_social_digest(args: dict, _mem: Memory) -> dict:
    mod = _load_social_module()
    if mod is None:
        return {"error": "jarvis-social module not installed"}
    return mod.social_digest(hours=int(args.get("hours") or 12))


def _tool_social_search(args: dict, _mem: Memory) -> dict:
    mod = _load_social_module()
    if mod is None:
        return {"error": "jarvis-social module not installed"}
    query = args.get("query") or ""
    if not query:
        return {"error": "query is required"}
    return mod.social_search(
        query=query,
        platform=args.get("platform"),
        hours=int(args.get("hours") or 48),
    )


def _tool_social_post(args: dict, _mem: Memory) -> dict:
    mod = _load_social_module()
    if mod is None:
        return {"error": "jarvis-social module not installed"}
    platform = args.get("platform")
    content = args.get("content")
    if not platform or not content:
        return {"error": "platform and content required"}
    return mod.social_post(
        platform=platform,
        content=content,
        confirm=bool(args.get("confirm")),
    )


def _tool_social_reply(args: dict, _mem: Memory) -> dict:
    mod = _load_social_module()
    if mod is None:
        return {"error": "jarvis-social module not installed"}
    platform = args.get("platform")
    item_id = args.get("item_id")
    message = args.get("message")
    if not platform or not item_id or not message:
        return {"error": "platform, item_id, and message required"}
    return mod.social_reply(
        platform=platform,
        item_id=item_id,
        message=message,
        confirm=bool(args.get("confirm")),
    )


# ── Network intelligence handlers ──────────────────────────────────
def _tool_network_search(args: dict, _mem: Memory) -> dict:
    mod = _load_network_module()
    if mod is None:
        return {"error": "jarvis-network module not installed"}
    query = (args.get("query") or "").strip()
    if not query and not args.get("filters"):
        return {"error": "query or filters required"}
    filters = args.get("filters") or {}
    if not isinstance(filters, dict):
        return {"error": "filters must be an object"}
    return mod.network_search(
        query=query,
        filters=filters,
        limit=int(args.get("limit") or 10),
    )


def _tool_network_map(args: dict, _mem: Memory) -> dict:
    mod = _load_network_module()
    if mod is None:
        return {"error": "jarvis-network module not installed"}
    return mod.network_map(
        focus=args.get("focus"),
        limit=int(args.get("limit") or 20),
    )


def _tool_relationship_score(args: dict, _mem: Memory) -> dict:
    mod = _load_network_module()
    if mod is None:
        return {"error": "jarvis-network module not installed"}
    name = (args.get("name") or "").strip()
    if not name:
        return {"error": "name is required"}
    return mod.relationship_score(name)


def _tool_network_suggest(args: dict, _mem: Memory) -> dict:
    mod = _load_network_module()
    if mod is None:
        return {"error": "jarvis-network module not installed"}
    goal = (args.get("goal") or "").strip()
    if not goal:
        return {"error": "goal is required"}
    return mod.network_suggest(goal)


def _tool_enrich_network(args: dict, _mem: Memory) -> dict:
    mod = _load_network_module()
    if mod is None:
        return {"error": "jarvis-network module not installed"}
    return mod.enrich_network(
        force=bool(args.get("force")),
        cap=int(args["cap"]) if args.get("cap") else None,
    )


def _tool_network_alerts(args: dict, _mem: Memory) -> dict:
    mod = _load_network_module()
    if mod is None:
        return {"error": "jarvis-network module not installed"}
    return mod.network_alerts(refresh=bool(args.get("refresh")))


# ── commitments tools ───────────────────────────────────────────────
def _tool_extract_commitments(args: dict, _mem: Memory) -> dict:
    mod = _load_commitments_module()
    if mod is None:
        return {"error": "jarvis-commitments not installed"}
    text = (args.get("text") or "").strip()
    if not text:
        return {"error": "text is required"}
    return mod.extract_commitments(
        text,
        source_type=(args.get("source_type") or "conversation"),
        context=args.get("context"),
        dry_run=bool(args.get("dry_run", False)),
    )


def _tool_add_commitment(args: dict, _mem: Memory) -> dict:
    mod = _load_commitments_module()
    if mod is None:
        return {"error": "jarvis-commitments not installed"}
    text = (args.get("text") or "").strip()
    if not text:
        return {"error": "text is required"}
    tags = args.get("tags") or []
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]
    return mod.add_commitment(
        text, due=args.get("due"),
        priority=args.get("priority") or "medium",
        contact=args.get("contact"), tags=tags,
        owner=args.get("owner") or "watson",
        notes=args.get("notes"),
    )


def _tool_list_commitments(args: dict, _mem: Memory) -> dict:
    mod = _load_commitments_module()
    if mod is None:
        return {"error": "jarvis-commitments not installed"}
    return mod.list_commitments(
        status=args.get("status") or "open",
        owner=args.get("owner"),
        contact=args.get("contact"),
        days_ahead=args.get("days_ahead", 7),
        limit=int(args.get("limit") or 50),
    )


def _tool_complete_commitment(args: dict, _mem: Memory) -> dict:
    mod = _load_commitments_module()
    if mod is None:
        return {"error": "jarvis-commitments not installed"}
    target = (args.get("id_or_text") or args.get("id") or args.get("text") or "").strip()
    if not target:
        return {"error": "id_or_text is required"}
    return mod.complete_commitment(target, sync=bool(args.get("sync", True)))


def _tool_commitment_report(args: dict, _mem: Memory) -> dict:
    mod = _load_commitments_module()
    if mod is None:
        return {"error": "jarvis-commitments not installed"}
    return mod.commitment_report(days=int(args.get("days") or 7))


# ── trello tools ────────────────────────────────────────────────────
def _tool_trello_sync(_args: dict, _mem: Memory) -> dict:
    mod = _load_trello_module()
    if mod is None:
        return {"error": "jarvis-trello not installed"}
    return mod.trello_sync()


def _tool_trello_boards(_args: dict, _mem: Memory) -> dict:
    mod = _load_trello_module()
    if mod is None:
        return {"error": "jarvis-trello not installed"}
    return mod.trello_boards()


def _tool_trello_add(args: dict, _mem: Memory) -> dict:
    mod = _load_trello_module()
    if mod is None:
        return {"error": "jarvis-trello not installed"}
    text = (args.get("text") or "").strip()
    if not text:
        return {"error": "text is required"}
    return mod.trello_add(
        text, list_name=args.get("list") or "todo",
        due=args.get("due"),
        commitment_id=args.get("commitment_id"),
    )


def _tool_trello_move(args: dict, _mem: Memory) -> dict:
    mod = _load_trello_module()
    if mod is None:
        return {"error": "jarvis-trello not installed"}
    card = (args.get("card") or args.get("card_id") or "").strip()
    list_name = (args.get("list") or "doing").strip()
    if not card:
        return {"error": "card id is required"}
    return mod.trello_move(card, list_name=list_name)


# ── apple tools ─────────────────────────────────────────────────────
def _tool_apple_add_reminder(args: dict, _mem: Memory) -> dict:
    mod = _load_apple_module()
    if mod is None:
        return {"error": "jarvis-apple not installed"}
    text = (args.get("text") or "").strip()
    if not text:
        return {"error": "text is required"}
    return mod.apple_add_reminder(
        text, due=args.get("due"),
        list=args.get("list") or "Jarvis",
        priority=args.get("priority"),
        notes=args.get("notes"),
    )


def _tool_apple_list_reminders(args: dict, _mem: Memory) -> dict:
    mod = _load_apple_module()
    if mod is None:
        return {"error": "jarvis-apple not installed"}
    return mod.apple_list_reminders(
        list=args.get("list") or "Jarvis",
        include_completed=bool(args.get("include_completed", False)),
        limit=int(args.get("limit") or 20),
    )


def _tool_apple_complete_reminder(args: dict, _mem: Memory) -> dict:
    mod = _load_apple_module()
    if mod is None:
        return {"error": "jarvis-apple not installed"}
    target = (args.get("text_or_id") or args.get("text") or args.get("id") or "").strip()
    if not target:
        return {"error": "text_or_id is required"}
    return mod.apple_complete_reminder(target, list=args.get("list") or "Jarvis")


def _tool_apple_save_note(args: dict, _mem: Memory) -> dict:
    mod = _load_apple_module()
    if mod is None:
        return {"error": "jarvis-apple not installed"}
    title = (args.get("title") or "").strip()
    content = args.get("content") or ""
    if not title:
        return {"error": "title is required"}
    return mod.apple_save_note(title, content,
                               folder=args.get("folder") or "Jarvis")


def _tool_apple_read_note(args: dict, _mem: Memory) -> dict:
    mod = _load_apple_module()
    if mod is None:
        return {"error": "jarvis-apple not installed"}
    title = (args.get("title") or "").strip()
    if not title:
        return {"error": "title is required"}
    return mod.apple_read_note(title, folder=args.get("folder") or "Jarvis")


# ── iMessage tools ─────────────────────────────────────────────────
def _tool_imessage_check(args: dict, _mem: Memory) -> dict:
    mod = _load_apple_module()
    if mod is None:
        return {"error": "jarvis-apple not installed"}
    return mod.imessage_check(
        contact=args.get("contact"),
        hours=float(args.get("hours") or 24),
        limit=int(args.get("limit") or 20),
        unread_only=bool(args.get("unread_only", False)),
    )


def _tool_imessage_read(args: dict, _mem: Memory) -> dict:
    mod = _load_apple_module()
    if mod is None:
        return {"error": "jarvis-apple not installed"}
    contact = (args.get("contact") or "").strip()
    if not contact:
        return {"error": "contact is required"}
    return mod.imessage_read(contact, limit=int(args.get("limit") or 50))


def _tool_imessage_send(args: dict, _mem: Memory) -> dict:
    mod = _load_apple_module()
    if mod is None:
        return {"error": "jarvis-apple not installed"}
    contact = (args.get("contact") or "").strip()
    message = (args.get("message") or "").strip()
    if not contact or not message:
        return {"error": "contact and message are required"}
    if not bool(args.get("confirm", False)):
        # Mirror send_email/send_telegram contract: refuse to ship a
        # draft without an explicit confirm flag from the model.
        return {"error": "confirm=true required (preview-then-confirm flow)",
                "preview": {"contact": contact, "message": message}}
    return mod.imessage_send(contact, message, confirm=True,
                             service=args.get("service") or "iMessage")


def _tool_imessage_search_contacts(args: dict, _mem: Memory) -> dict:
    mod = _load_apple_module()
    if mod is None:
        return {"error": "jarvis-apple not installed"}
    q = (args.get("query") or "").strip()
    if not q:
        return {"error": "query is required"}
    return mod.imessage_search_contacts(q)


def _tool_apple_contacts_search(args: dict, _mem: Memory) -> dict:
    mod = _load_apple_module()
    if mod is None:
        return {"error": "jarvis-apple not installed"}
    q = (args.get("query") or "").strip()
    if not q:
        return {"error": "query is required"}
    return mod.apple_contacts_search(q, limit=int(args.get("limit") or 10))


# Tool registry — name → (handler, schema)
TOOLS: dict[str, tuple[Any, dict]] = {
    "remember": (
        _tool_remember,
        {
            "name": "remember",
            "description": (
                "Save a durable fact about the user (preferences, identity, ongoing "
                "projects, important people). Use this when the user shares something "
                "you would want to recall in a future conversation. Do NOT use for "
                "ephemeral/in-session details."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The fact, written so it's self-contained when read months later."},
                    "tags": {"type": "array", "items": {"type": "string"}, "description": "Optional category tags (e.g. 'preference', 'identity', 'project')."},
                },
                "required": ["text"],
            },
        },
    ),
    "recall": (
        _tool_recall,
        {
            "name": "recall",
            "description": (
                "Search the user's memory store by keyword + recency. Use when you "
                "need to check whether you already know something about the user. "
                "Returns up to `limit` matches."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What to look for."},
                    "limit": {"type": "integer", "description": "Max results (default 5)."},
                },
            },
        },
    ),
    "get_time": (
        _tool_get_time,
        {
            "name": "get_time",
            "description": "Get the current local time (with timezone).",
            "input_schema": {"type": "object", "properties": {}},
        },
    ),
    "get_date": (
        _tool_get_date,
        {
            "name": "get_date",
            "description": "Get today's date and weekday.",
            "input_schema": {"type": "object", "properties": {}},
        },
    ),
    "run_command": (
        _tool_run_command,
        {
            "name": "run_command",
            "description": (
                "Execute a shell command on the user's machine. Requires explicit user "
                "confirmation unless the command matches the configured allowlist. "
                "Use sparingly — for read-only inspection, simple file ops, or quick "
                "lookups. Output is truncated to 2KB per stream."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The full shell command."},
                    "reason": {"type": "string", "description": "One-line reason shown to the user during the confirmation prompt."},
                },
                "required": ["command"],
            },
        },
    ),
    "read_memory_file": (
        _tool_read_memory_file,
        {
            "name": "read_memory_file",
            "description": (
                "Read a specific memory file from Watson's auto-memory directories "
                "by name. Use this when the MEMORY.md index (already loaded in your "
                "system prompt) points to a file whose details you need — e.g. "
                "'feedback_ea_obsessed' for the EA-obsession standing instructions, "
                "or 'project_voice_latency_rework' for context on recent voice changes. "
                "Pick names directly from the indices. The .md suffix is optional."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Bare filename like 'feedback_ea_obsessed' or 'project_jarvis'. No path separators.",
                    },
                },
                "required": ["name"],
            },
        },
    ),
    "search_contacts": (
        _tool_search_contacts,
        {
            "name": "search_contacts",
            "description": (
                "Look up a person in the user's Apple Contacts + Messages history "
                "via jarvis-recall. Returns identity, last interaction, and notes "
                "if available. Use when the user names someone you don't remember."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Name or partial name."},
                },
                "required": ["query"],
            },
        },
    ),
    "set_timer": (
        _tool_set_timer,
        {
            "name": "set_timer",
            "description": (
                "Schedule a spoken alert after a relative duration. Returns the "
                "scheduled fire time. Survives the conversation ending; lost on "
                "machine reboot."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "duration": {"type": "string", "description": "e.g. '90', '5min', '2 hours'."},
                    "label": {"type": "string", "description": "What the timer is for."},
                },
                "required": ["duration"],
            },
        },
    ),
    "set_reminder": (
        _tool_set_reminder,
        {
            "name": "set_reminder",
            "description": (
                "Schedule a spoken reminder at an absolute or relative time. Accepts "
                "'in 5 minutes', 'HH:MM' (today or next), or ISO 8601 timestamp. "
                "Survives conversation ending; lost on machine reboot."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "when": {"type": "string", "description": "When to fire."},
                    "message": {"type": "string", "description": "What to say."},
                },
                "required": ["when", "message"],
            },
        },
    ),
    "check_email": (
        _tool_check_email,
        {
            "name": "check_email",
            "description": (
                "Fetch and summarize recent Gmail messages. Default returns the "
                "user's unread inbox. Use `query` for Gmail search syntax (e.g. "
                "'from:dalton', 'is:starred', 'newer_than:1d'). Read-only — does "
                "not mark anything as read."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "max_results": {"type": "integer", "description": "1-25 (default 5)."},
                    "query": {"type": "string", "description": "Gmail search query."},
                },
            },
        },
    ),
    "draft_email": (
        _tool_draft_email,
        {
            "name": "draft_email",
            "description": (
                "Save an email as a draft. Returns a draft_id you can pass to "
                "send_email after the user confirms. Always draft first, read "
                "the draft back to the user, and only send on explicit yes."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "to": {"type": "string", "description": "Recipient email."},
                    "subject": {"type": "string"},
                    "body": {"type": "string"},
                    "thread_id": {"type": "string", "description": "Optional thread to attach to."},
                },
                "required": ["to", "subject", "body"],
            },
        },
    ),
    "send_email": (
        _tool_send_email,
        {
            "name": "send_email",
            "description": (
                "Send a previously-saved draft (preferred), or compose+send in "
                "one shot. REQUIRES confirm=true — without it, the call is "
                "refused as a safety net. Workflow: call draft_email, read the "
                "draft to the user, ask 'Should I send it, sir?', then call "
                "send_email with confirm=true after a clear yes."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "draft_id": {"type": "string"},
                    "to": {"type": "string"},
                    "subject": {"type": "string"},
                    "body": {"type": "string"},
                    "confirm": {"type": "boolean", "description": "Must be true to actually send."},
                },
            },
        },
    ),
    "reply_email": (
        _tool_reply_email,
        {
            "name": "reply_email",
            "description": (
                "Send a reply on an existing Gmail thread. Pulls the recipient + "
                "subject + headers from the latest message in the thread, so "
                "you only supply thread_id + body. Same confirm=true safety as "
                "send_email."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "thread_id": {"type": "string"},
                    "body": {"type": "string"},
                    "confirm": {"type": "boolean"},
                },
                "required": ["thread_id", "body"],
            },
        },
    ),
    "check_calendar": (
        _tool_check_calendar,
        {
            "name": "check_calendar",
            "description": (
                "List Google Calendar events for a date range. Default: today. "
                "Use `date` for the starting day (ISO 'YYYY-MM-DD' or 'tomorrow') "
                "and `days` for how many days to include. Read-only."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "date": {"type": "string", "description": "Starting day (default: today)."},
                    "days": {"type": "integer", "description": "How many days to include (default: 1)."},
                    "calendar_id": {"type": "string", "description": "Calendar to read (default: 'primary')."},
                },
            },
        },
    ),
    "create_event": (
        _tool_create_event,
        {
            "name": "create_event",
            "description": (
                "Create a calendar event. Time inputs accept ISO 8601, 'HH:MM' "
                "(today/tomorrow if past), 'tomorrow at HH:MM', 'in N minutes', "
                "or bare 'YYYY-MM-DD' for all-day. If `end` is omitted, defaults "
                "to start + 30 minutes."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string", "description": "Event title."},
                    "start": {"type": "string", "description": "When it starts."},
                    "end": {"type": "string", "description": "When it ends (optional)."},
                    "attendees": {"type": "array", "items": {"type": "string"},
                                   "description": "Attendee emails."},
                    "location": {"type": "string"},
                    "description": {"type": "string"},
                    "calendar_id": {"type": "string"},
                },
                "required": ["summary", "start"],
            },
        },
    ),
    "update_event": (
        _tool_update_event,
        {
            "name": "update_event",
            "description": (
                "Patch an existing event by id. Only the named fields are "
                "modified — others are preserved. Use check_calendar first to "
                "find the right event_id."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "event_id": {"type": "string"},
                    "summary": {"type": "string"},
                    "start": {"type": "string"},
                    "end": {"type": "string"},
                    "attendees": {"type": "array", "items": {"type": "string"}},
                    "location": {"type": "string"},
                    "description": {"type": "string"},
                    "calendar_id": {"type": "string"},
                },
                "required": ["event_id"],
            },
        },
    ),
    "delete_event": (
        _tool_delete_event,
        {
            "name": "delete_event",
            "description": (
                "Cancel a calendar event. REQUIRES confirm=true — without it "
                "the call is refused. Workflow: confirm the event with the "
                "user out loud, then call again with confirm=true."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "event_id": {"type": "string"},
                    "confirm": {"type": "boolean"},
                    "calendar_id": {"type": "string"},
                },
                "required": ["event_id"],
            },
        },
    ),
    "execute_plan": (
        _tool_execute_plan,
        {
            "name": "execute_plan",
            "description": (
                "Decompose a high-level goal into a multi-step plan and execute it. "
                "Use this for ambiguous or compound goals like 'prepare for my 2pm "
                "meeting', 'close the deal with Corbin', or 'research that company "
                "before my call' — anything where you'd otherwise need to chain "
                "3+ tool calls together. Sonnet plans the dependency graph, the "
                "orchestrator runs read-only tools (calendar, email, recall, "
                "search_contacts, web_search, research_topic) in parallel where "
                "possible, and returns a synthesized summary. The orchestrator "
                "NEVER takes irreversible action — it only prepares context. For "
                "simple factual asks ('what's the time', 'check my unread email'), "
                "call the underlying tool directly instead."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "goal": {
                        "type": "string",
                        "description": "Watson's high-level goal in natural language.",
                    },
                },
                "required": ["goal"],
            },
        },
    ),
    "get_briefing": (
        _tool_get_briefing,
        {
            "name": "get_briefing",
            "description": (
                "Return today's morning briefing — calendar, important email, "
                "pending notifications, recent memory, weather. The cron job "
                "generates it before Watson wakes up; if it hasn't run yet, "
                "this tool generates it on demand. Use when Watson asks 'what "
                "does my day look like', 'brief me', 'what's on the docket', or "
                "any greeting that warrants leading with the day's plan. Pass "
                "mark_delivered=true after reading the briefing aloud so we "
                "don't deliver it twice."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "mark_delivered": {
                        "type": "boolean",
                        "description": "Set true after speaking the briefing to record delivery.",
                    },
                },
            },
        },
    ),
    "web_search": (
        _tool_web_search,
        {
            "name": "web_search",
            "description": (
                "Search the web for a single query and return a Haiku-summarized "
                "answer with source links. Use for quick lookups that need fresh "
                "information ('what's the weather in Austin', 'who won the game "
                "last night', 'price of gold today'). For deeper multi-source "
                "research, use research_topic instead."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The search query."},
                    "max_results": {"type": "integer", "description": "1-10 (default 5)."},
                },
                "required": ["query"],
            },
        },
    ),
    "research_topic": (
        _tool_research_topic,
        {
            "name": "research_topic",
            "description": (
                "Multi-query deep research on a topic. Haiku expands the topic "
                "into 3-5 sub-queries, fetches the top results from each, then "
                "Sonnet synthesizes a structured findings block with citations. "
                "Use when Watson asks to 'research that company', 'find me the "
                "best X', or otherwise wants depth, not just one search hit. "
                "depth='quick' is 3 sub-queries × 1 page each; 'thorough' is 5 × "
                "2. Slower than web_search — only use when depth is warranted."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "topic": {"type": "string", "description": "The research topic."},
                    "depth": {
                        "type": "string",
                        "enum": ["quick", "thorough"],
                        "description": "quick (default) or thorough.",
                    },
                },
                "required": ["topic"],
            },
        },
    ),
    "check_telegram": (
        _tool_check_telegram,
        {
            "name": "check_telegram",
            "description": (
                "Pull recent messages from Watson's monitored Telegram group "
                "chats. Reads from the local cache — instant, no network. "
                "Pass `group_name` to filter to one group (fuzzy match on "
                "title); leave it empty to pull from every monitored group. "
                "Returns raw messages — for a summarized read, use "
                "telegram_digest instead. Use this when Watson asks 'what "
                "did so-and-so say in the X group' or wants the actual text."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "group_name": {
                        "type": "string",
                        "description": "Optional group title to filter by (fuzzy).",
                    },
                    "hours": {
                        "type": "integer",
                        "description": "How far back to look (default 4).",
                    },
                },
            },
        },
    ),
    "telegram_digest": (
        _tool_telegram_digest,
        {
            "name": "telegram_digest",
            "description": (
                "AI-summarized digest of Watson's monitored Telegram groups: "
                "one block per active group with summary, action items "
                "directed at Watson, urgency flag, and key topics. Prefer "
                "this over multiple check_telegram calls when Watson asks "
                "'what's happening in the team chats', 'catch me up on "
                "Telegram', or 'any updates from the team'. Filter by "
                "priority ('high' / 'normal' / 'low' / 'all') to focus on "
                "the tier that matters."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "hours": {
                        "type": "integer",
                        "description": "Window in hours (default 12).",
                    },
                    "priority": {
                        "type": "string",
                        "enum": ["all", "high", "normal", "low"],
                        "description": "Filter to groups at this priority (default 'all').",
                    },
                },
            },
        },
    ),
    "telegram_search": (
        _tool_telegram_search,
        {
            "name": "telegram_search",
            "description": (
                "Substring search across recent Telegram messages in Watson's "
                "monitored groups. Returns each hit with one message of "
                "context on either side. Use when Watson asks 'did anyone "
                "mention X in the team chat' or 'search the founders group "
                "for the term sheet'."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Substring to search for (case-insensitive).",
                    },
                    "group_name": {
                        "type": "string",
                        "description": "Optional group title to scope the search.",
                    },
                    "hours": {
                        "type": "integer",
                        "description": "Window in hours (default 48).",
                    },
                },
                "required": ["query"],
            },
        },
    ),
    "check_notifications": (
        _tool_check_notifications,
        {
            "name": "check_notifications",
            "description": (
                "List Watson's queued notifications from the smart "
                "notification bus — score, source, sender, content, "
                "and route (interrupt/queue/batch). Use when Watson "
                "asks 'anything urgent', 'what's pending', 'any "
                "notifications', or before he wraps up the day. "
                "Filter values: 'pending' (default), 'high' (above "
                "interrupt threshold), 'low' (below queue threshold), "
                "'all', a source name ('email', 'telegram', 'calendar'), "
                "or 'delivered' / 'dropped' for the audit trail."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "filter": {
                        "type": "string",
                        "description": "pending | high | low | all | <source>",
                    },
                },
            },
        },
    ),
    "dismiss_notification": (
        _tool_dismiss_notification,
        {
            "name": "dismiss_notification",
            "description": (
                "Mark a queued notification as dismissed. Use after "
                "Watson hears about it and tells you to drop it, or "
                "after relaying a queued item out loud. Pass the id "
                "from check_notifications. Note: dismiss is the right "
                "call after Watson 'handles' or 'ignores' an item; "
                "for items that were spoken to him, the sender code "
                "already marks them delivered."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Notification id from check_notifications."},
                },
                "required": ["id"],
            },
        },
    ),
    "notification_preferences": (
        _tool_notification_preferences,
        {
            "name": "notification_preferences",
            "description": (
                "Inspect or update Watson's notification rules. Pass "
                "show=true to read the current rules. To change rules, "
                "pass `rules` as an object — the keys are merged into "
                "the stored config. Useful keys: "
                "`source_filters`={'telegram':'queue_only'} (never "
                "interrupt for that source), `sender_overrides`={'corbin@…':'high'} "
                "(force a sender to high importance), `quiet_hours`={'start':'22:00','end':'07:00'}, "
                "`interrupt_threshold` and `queue_threshold` (integers). "
                "Use when Watson says things like 'don't interrupt me "
                "for Telegram unless it's from Corbin' or 'no notifications "
                "after 10pm'."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "show": {"type": "boolean", "description": "Read current rules without modifying."},
                    "rules": {
                        "type": "object",
                        "description": "Partial rules object to merge in.",
                    },
                },
            },
        },
    ),
    "lookup_contact": (
        _tool_lookup_contact,
        {
            "name": "lookup_contact",
            "description": (
                "Pull Watson's stored contact record for someone — name, "
                "email, telegram handle, relationship label, last "
                "interaction, communication preference, recent topics. "
                "This is a richer lookup than `search_contacts` (which "
                "hits Apple Contacts + Messages history): contacts are "
                "Watson's curated relationship memory. Use when the "
                "user names someone you'd want a profile on. Returns "
                "{found: false} if no match — fall back to search_contacts."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string",
                             "description": "Name, email, or @telegram handle (fuzzy)."},
                },
                "required": ["name"],
            },
        },
    ),
    "relationship_brief": (
        _tool_relationship_brief,
        {
            "name": "relationship_brief",
            "description": (
                "Voice-ready summary of Watson's relationship with someone: "
                "who they are in his life, last interaction, open threads, "
                "talking points. Use when Watson asks 'prepare for my call "
                "with X', 'what's going on with X', 'remind me about X', or "
                "before drafting a message to someone. Auto-builds the "
                "brief on first call (Haiku synthesis over email + "
                "Telegram + memory) and caches it for ~7 days."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                },
                "required": ["name"],
            },
        },
    ),
    "enrich_contact": (
        _tool_enrich_contact,
        {
            "name": "enrich_contact",
            "description": (
                "Force-rebuild a contact's stored profile from current "
                "interaction history. Use only when Watson asks to "
                "'refresh' or 'update' someone's record, or after a "
                "major event with that person. Normal flow uses "
                "relationship_brief, which auto-refreshes when stale."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "force": {"type": "boolean",
                              "description": "Re-synthesize even if fresh."},
                },
                "required": ["name"],
            },
        },
    ),
    "contact_sync": (
        _tool_contact_sync,
        {
            "name": "contact_sync",
            "description": (
                "Sync Apple Contacts → Jarvis. Apple Contacts is the "
                "source of truth for who exists; LinkedIn-only "
                "connections are ignored. Adds new records for people "
                "not yet on file, patches in missing email/phone/org "
                "for existing records, and (when APOLLO_API_KEY is set) "
                "auto-enriches each NEW record via Apollo.io. Never "
                "deletes. Use when Watson says 'sync my contacts', "
                "'pull from Apple Contacts', or after he adds a batch "
                "of new contacts on his phone."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "enrich": {
                        "type": "boolean",
                        "description": "If true (default), call Apollo on each new record."
                    },
                    "limit": {
                        "type": "number",
                        "description": "Cap total contacts processed; useful for testing."
                    },
                },
            },
        },
    ),
    "apollo_enrich": (
        _tool_apollo_enrich,
        {
            "name": "apollo_enrich",
            "description": (
                "Look up one contact in Apollo.io's People Match API "
                "and patch in title, seniority, LinkedIn URL, phone, "
                "and organization. Costs 1 Apollo credit. Use when "
                "Watson asks to 'enrich X', 'pull X's title', or "
                "'who does X work for'. Skips silently if APOLLO_API_KEY "
                "isn't set or the contact was enriched within the last 7 "
                "days (use force=true to override)."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "force": {"type": "boolean",
                              "description": "Bypass the 7-day freshness check."},
                },
                "required": ["name"],
            },
        },
    ),
    "approve_message": (
        _tool_approve_message,
        {
            "name": "approve_message",
            "description": (
                "Two-phase outbound-message gate. ALWAYS use this BEFORE "
                "sending any text/email/telegram/social message on Watson's "
                "behalf — never call send_email / imessage_send / "
                "send_telegram / social_reply directly without an approval "
                "round-trip first.\n\n"
                "Phase 1 (submit a draft): pass `channel`, `recipient`, "
                "`draft` (and `subject` for email). Returns a voice_prompt "
                "for Jarvis to read aloud and an `approval_id` token. "
                "Speak the prompt and WAIT for Watson's reply.\n\n"
                "Phase 2 (record his decision): pass `approval_id` plus "
                "`decision`='approve' or 'reject'. On 'approve' the gate "
                "fires the channel's send_* tool with confirm=true and "
                "returns the result. On 'reject' the gate just clears "
                "the pending entry — Watson will dictate the revision next."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "channel": {
                        "type": "string",
                        "enum": ["email", "imessage", "telegram", "social"],
                        "description": "Outbound channel. Required for Phase 1."
                    },
                    "recipient": {
                        "type": "string",
                        "description": (
                            "Email address, iMessage handle (phone or "
                            "email), telegram group name, or — for "
                            "channel='social' — the cached post "
                            "identifier formatted as 'platform:item_id' "
                            "(e.g. 'twitter:abc123'). Required for Phase 1."
                        )
                    },
                    "draft": {
                        "type": "string",
                        "description": "The message body Jarvis composed. Required for Phase 1."
                    },
                    "subject": {
                        "type": "string",
                        "description": "Email subject line. Required when channel=email."
                    },
                    "approval_id": {
                        "type": "string",
                        "description": "Token from Phase 1. Required for Phase 2."
                    },
                    "decision": {
                        "type": "string",
                        "enum": ["approve", "reject"],
                        "description": (
                            "Watson's verdict. 'approve' fires the send. "
                            "'reject' clears the pending draft."
                        )
                    },
                },
            },
        },
    ),
    "style_apply": (
        _tool_style_apply,
        {
            "name": "style_apply",
            "description": (
                "Rewrite a piece of text in Watson's personal voice — pulls "
                "his style profile (built from sent email + Telegram) and "
                "asks Haiku to match cadence, register, and signature "
                "phrases. Use ONLY when Watson asks for a one-off rewrite "
                "('make this sound like me', 'rewrite this in my voice'). "
                "draft_email and send_telegram already auto-apply style; "
                "don't double-style."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "The draft text to rewrite.",
                    },
                    "channel": {
                        "type": "string",
                        "enum": ["email", "telegram"],
                        "description": "Optional channel hint to weight the rewrite.",
                    },
                },
                "required": ["text"],
            },
        },
    ),
    "style_status": (
        _tool_style_status,
        {
            "name": "style_status",
            "description": (
                "Diagnostic snapshot of Watson's style profile — when it "
                "was built, how many samples, channel breakdown, current "
                "tone summary. Use only if Watson asks 'do you know my "
                "writing style yet' or to confirm the profile is fresh."
            ),
            "input_schema": {"type": "object", "properties": {}},
        },
    ),
    "send_telegram": (
        _tool_send_telegram,
        {
            "name": "send_telegram",
            "description": (
                "Send a message to one of Watson's monitored Telegram groups. "
                "REQUIRES confirm=true — without it the call returns a "
                "preview for Watson to approve. Workflow: call with "
                "confirm=false (or omit it), read the preview to Watson, "
                "ask 'Should I send it, sir?', then re-call with "
                "confirm=true after a clear yes. Pass reply_to=<message_id> "
                "to thread under a specific message."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "group_name": {
                        "type": "string",
                        "description": "Group title (fuzzy match).",
                    },
                    "message": {
                        "type": "string",
                        "description": "The text to send.",
                    },
                    "reply_to": {
                        "type": "integer",
                        "description": "Optional message_id to reply to.",
                    },
                    "confirm": {
                        "type": "boolean",
                        "description": "Must be true to actually send.",
                    },
                },
                "required": ["group_name", "message"],
            },
        },
    ),
    "check_social": (
        _tool_check_social,
        {
            "name": "check_social",
            "description": (
                "Pull recent items from Watson's social media monitoring "
                "(Twitter, LinkedIn, Instagram, RSS). Reads the local "
                "cache — instant, no network. Pass `platform` to filter "
                "to one ('twitter' / 'linkedin' / 'instagram' / 'rss'); "
                "leave empty for everything enabled. Returns raw items — "
                "for a summarized read, use social_digest. Use this when "
                "Watson wants the actual posts/tweets/headlines."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "platform": {
                        "type": "string",
                        "enum": ["twitter", "linkedin", "instagram", "rss"],
                        "description": "Optional platform filter.",
                    },
                    "hours": {
                        "type": "integer",
                        "description": "How far back to look (default 4).",
                    },
                },
            },
        },
    ),
    "social_digest": (
        _tool_social_digest,
        {
            "name": "social_digest",
            "description": (
                "AI-summarized digest of Watson's social activity: one "
                "block per platform with summary, action items, urgency "
                "flag, and key topics. Prefer this over multiple "
                "check_social calls when Watson asks 'what's happening "
                "online', 'catch me up on Twitter', 'any RSS news', "
                "'anything in my feeds'. Pass `platform` to scope to one."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "hours": {
                        "type": "integer",
                        "description": "Window in hours (default 12).",
                    },
                    "platform": {
                        "type": "string",
                        "enum": ["twitter", "linkedin", "instagram", "rss"],
                    },
                },
            },
        },
    ),
    "social_search": (
        _tool_social_search,
        {
            "name": "social_search",
            "description": (
                "Substring search across recent social cache (matches "
                "text and author). Use when Watson asks 'did anyone "
                "tweet about X', 'is X mentioned in my feeds', "
                "'search RSS for the term sheet', etc."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Substring to search for (case-insensitive).",
                    },
                    "platform": {
                        "type": "string",
                        "enum": ["twitter", "linkedin", "instagram", "rss"],
                    },
                    "hours": {
                        "type": "integer",
                        "description": "Window in hours (default 48).",
                    },
                },
                "required": ["query"],
            },
        },
    ),
    "social_reply": (
        _tool_social_reply,
        {
            "name": "social_reply",
            "description": (
                "Reply to a specific tweet/post/comment. REQUIRES "
                "confirm=true — without it, returns a styled preview "
                "for Watson to approve. Workflow: call with confirm=false "
                "first, read the preview to Watson, ask 'Should I send "
                "it, sir?', re-call with confirm=true after a clear yes. "
                "Pull item_id from check_social or social_digest. "
                "RSS is read-only — never call this with platform='rss'."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "platform": {
                        "type": "string",
                        "enum": ["twitter", "linkedin", "instagram"],
                    },
                    "item_id": {
                        "type": "string",
                        "description": "Tweet id / post URN / comment id.",
                    },
                    "message": {
                        "type": "string",
                    },
                    "confirm": {
                        "type": "boolean",
                        "description": "Must be true to actually send.",
                    },
                },
                "required": ["platform", "item_id", "message"],
            },
        },
    ),
    "network_search": (
        _tool_network_search,
        {
            "name": "network_search",
            "description": (
                "Semantic search across Watson's professional network — "
                "matches the query against skills, expertise areas, "
                "intro targets, tags, topics, brief, and notes for every "
                "tracked contact. Returns ranked candidates with the "
                "match reasoning attached. Use when Watson asks 'who in "
                "my network knows X', 'who can help with Y', 'who do I "
                "know in the Z space'. Filter by `trust_level` "
                "(inner_circle | trusted | professional | acquaintance | "
                "cold), `tags`, `min_strength` (0..1), `channel`, and "
                "`recency_days`. Pass an empty query plus filters to "
                "list contacts in a tier or above a strength floor."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What you're looking for (skill, "
                                       "topic, capability).",
                    },
                    "filters": {
                        "type": "object",
                        "description": "Optional filters: trust_level "
                                       "(string or list), tags (list), "
                                       "min_strength (number), channel, "
                                       "recency_days (number).",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default 10).",
                    },
                },
            },
        },
    ),
    "network_map": (
        _tool_network_map,
        {
            "name": "network_map",
            "description": (
                "Generate a structured overview of Watson's network. With "
                "no `focus`, returns top contacts grouped by trust tier "
                "(inner_circle, trusted, professional, acquaintance, "
                "cold) — 'the lay of my network'. With `focus` (e.g. "
                "'fundraising', 'engineering hires'), returns who's "
                "relevant plus the suggested approach order ranked by "
                "match × strength. Use when Watson asks 'give me the "
                "lay of my network', 'who's in my inner circle', or "
                "'show me my fundraising contacts'."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "focus": {
                        "type": "string",
                        "description": "Optional topic to focus the map on.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max contacts per tier or per "
                                       "focus block (default 20).",
                    },
                },
            },
        },
    ),
    "relationship_score": (
        _tool_relationship_score,
        {
            "name": "relationship_score",
            "description": (
                "Deep one-person snapshot: relationship strength (0..1), "
                "trajectory (growing | stable | fading), days since last "
                "interaction, score components (frequency, recency, "
                "depth, reciprocity), open threads, talking points, and "
                "a concrete next-action suggestion (action, channel, "
                "urgency). Pulls fresh email + Telegram + memory history "
                "before scoring. Use when Watson asks 'how's my "
                "relationship with X', 'what's my standing with Y', "
                "'should I reach out to Z'. Stronger than "
                "`relationship_brief` for analytical questions; "
                "`relationship_brief` is still better for the voice-ready "
                "summary."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Name, email, or @telegram handle "
                                       "(fuzzy).",
                    },
                },
                "required": ["name"],
            },
        },
    ),
    "network_suggest": (
        _tool_network_suggest,
        {
            "name": "network_suggest",
            "description": (
                "Given a goal, propose who in Watson's network to "
                "leverage and in what order. Sonnet plans a strategy "
                "grounded in the network slice (only real contacts — "
                "never invented). Returns a strategy paragraph, ordered "
                "approach list (each entry: name, reason, channel, "
                "first_move), a fallback if the primary path stalls, and "
                "watch-outs. Use when Watson asks 'who should I talk to "
                "about X', 'how do I close the Y deal', 'I need an intro "
                "to Z'."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "goal": {
                        "type": "string",
                        "description": "What Watson wants to accomplish.",
                    },
                },
                "required": ["goal"],
            },
        },
    ),
    "enrich_network": (
        _tool_enrich_network,
        {
            "name": "enrich_network",
            "description": (
                "Batch-refresh the network layer: recompute relationship "
                "strength + trust tiers for every contact, rebuild the "
                "mutual-contacts graph, and run Haiku skill / expertise "
                "extraction on stale records. Caps the Haiku passes per "
                "run via JARVIS_NETWORK_BATCH_CAP (default 12). Normally "
                "runs weekly via jarvis-improve — only call manually "
                "when Watson asks to 'refresh the network' or after "
                "loading a batch of new contacts. Pass `force=true` to "
                "re-run the Haiku pass on already-enriched records."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "force": {
                        "type": "boolean",
                        "description": "Re-run Haiku enrichment even on "
                                       "fresh records.",
                    },
                    "cap": {
                        "type": "integer",
                        "description": "Override the per-run Haiku cap.",
                    },
                },
            },
        },
    ),
    "network_alerts": (
        _tool_network_alerts,
        {
            "name": "network_alerts",
            "description": (
                "Return current network alerts: fading relationships "
                "(inner_circle past 30 days, trusted past 60), pending "
                "follow-ups from open threads, and intro opportunities "
                "Watson's contacts have surfaced. Each alert has a "
                "priority (high | normal | low) and the contact name. "
                "Use when Watson asks 'who am I neglecting', 'what "
                "follow-ups do I owe', 'any relationship alerts'. Pass "
                "`refresh=true` to recompute from people.json instead "
                "of the cached file."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "refresh": {
                        "type": "boolean",
                        "description": "Recompute from people.json.",
                    },
                },
            },
        },
    ),
    "extract_commitments": (
        _tool_extract_commitments,
        {
            "name": "extract_commitments",
            "description": (
                "Pull commitments out of a chunk of text (conversation, "
                "email body, iMessage thread). Returns candidate items "
                "with owner / due / priority / contact. Use proactively "
                "when Watson reads or pastes something with promises in "
                "it. dry_run=true returns candidates without saving — "
                "set false (default) to persist immediately."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "source_type": {
                        "type": "string",
                        "enum": ["conversation", "email", "imessage", "manual"],
                    },
                    "context": {"type": "string"},
                    "dry_run": {"type": "boolean"},
                },
                "required": ["text"],
            },
        },
    ),
    "add_commitment": (
        _tool_add_commitment,
        {
            "name": "add_commitment",
            "description": (
                "Manually log a commitment Watson is making or has been "
                "given. Use when Watson says 'remind me to X by Y', "
                "'make sure I send the proposal Friday'. The natural-"
                "language `due` (today / tomorrow / Friday / 2026-05-01 / "
                "in 3 days) is parsed locally."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "text": {"type": "string",
                             "description": "Imperative phrase: 'send the proposal'"},
                    "due": {"type": "string"},
                    "priority": {"type": "string",
                                 "enum": ["high", "medium", "low"]},
                    "contact": {"type": "string",
                                "description": "Person this commitment touches."},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "owner": {"type": "string",
                              "description": "'watson' or another person's name."},
                    "notes": {"type": "string"},
                },
                "required": ["text"],
            },
        },
    ),
    "list_commitments": (
        _tool_list_commitments,
        {
            "name": "list_commitments",
            "description": (
                "Query the commitment store. Default returns Watson's "
                "open items due in the next 7 days, overdue first. Use "
                "when Watson asks 'what's on my plate', 'what do I owe "
                "Corbin', 'what's due this week'. Set status='all' to "
                "include completed items."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "status": {"type": "string",
                               "enum": ["open", "done", "overdue",
                                        "cancelled", "all"]},
                    "owner": {"type": "string"},
                    "contact": {"type": "string"},
                    "days_ahead": {"type": "integer",
                                   "description": "Horizon in days (default 7)."},
                    "limit": {"type": "integer"},
                },
            },
        },
    ),
    "complete_commitment": (
        _tool_complete_commitment,
        {
            "name": "complete_commitment",
            "description": (
                "Mark a commitment done. Accepts the canonical id "
                "(cmt_...) OR a fuzzy text match — 'send Corbin the "
                "proposal' will match the open item with that text. "
                "Triggers Trello + Apple Reminders sync so the mirrors "
                "close too. Use when Watson says 'done', 'sent that', "
                "'taken care of'."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "id_or_text": {"type": "string"},
                    "sync": {"type": "boolean",
                             "description": "Default true. Set false to skip Trello/Reminders propagation."},
                },
                "required": ["id_or_text"],
            },
        },
    ),
    "commitment_report": (
        _tool_commitment_report,
        {
            "name": "commitment_report",
            "description": (
                "Snapshot of overdue / due-today / due-this-week / what "
                "others owe Watson / recently completed. Use for the "
                "morning briefing or wrap-up review. Returns counts and "
                "the items themselves."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "days": {"type": "integer",
                             "description": "Look-ahead window for 'this week'. Default 7."},
                },
            },
        },
    ),
    "trello_sync": (
        _tool_trello_sync,
        {
            "name": "trello_sync",
            "description": (
                "Reconcile the canonical commitment store against the "
                "configured Trello board: push new cards, pull "
                "completion signals, import unknown dated cards. "
                "Idempotent. Use when Watson asks 'sync my Trello' or "
                "after a batch of commitment edits. The self-improvement "
                "daemon also runs this on every tier-1 pass."
            ),
            "input_schema": {"type": "object", "properties": {}},
        },
    ),
    "trello_boards": (
        _tool_trello_boards,
        {
            "name": "trello_boards",
            "description": (
                "List Watson's open Trello boards. Use when he asks "
                "'what's on my Trello' or as the first step of setup. "
                "Cheap — single API call."
            ),
            "input_schema": {"type": "object", "properties": {}},
        },
    ),
    "trello_add": (
        _tool_trello_add,
        {
            "name": "trello_add",
            "description": (
                "Create a single Trello card directly. Prefer "
                "add_commitment + trello_sync for the normal path; use "
                "this only when Watson explicitly wants a Trello-only "
                "card (no commitment tracking)."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "list": {"type": "string",
                             "enum": ["todo", "doing", "done"]},
                    "due": {"type": "string",
                            "description": "YYYY-MM-DD."},
                    "commitment_id": {"type": "string"},
                },
                "required": ["text"],
            },
        },
    ),
    "trello_move": (
        _tool_trello_move,
        {
            "name": "trello_move",
            "description": (
                "Move a Trello card to another list (todo/doing/done)."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "card": {"type": "string",
                             "description": "Trello card id."},
                    "list": {"type": "string",
                             "enum": ["todo", "doing", "done"]},
                },
                "required": ["card", "list"],
            },
        },
    ),
    "apple_add_reminder": (
        _tool_apple_add_reminder,
        {
            "name": "apple_add_reminder",
            "description": (
                "Create a reminder in Apple Reminders. Lands in the "
                "'Jarvis' list by default so it shows up on Watson's "
                "iPhone. Use when Watson explicitly asks for a Reminders "
                "entry; for general 'remember to X by Y' prefer "
                "add_commitment which mirrors here automatically."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "due": {"type": "string",
                            "description": "YYYY-MM-DD or relative (today/tomorrow/Friday)."},
                    "list": {"type": "string"},
                    "priority": {"type": "string",
                                 "enum": ["high", "medium", "low"]},
                    "notes": {"type": "string"},
                },
                "required": ["text"],
            },
        },
    ),
    "apple_list_reminders": (
        _tool_apple_list_reminders,
        {
            "name": "apple_list_reminders",
            "description": (
                "Read open reminders from a Reminders list (default "
                "'Jarvis'). Use when Watson asks 'what's in my "
                "reminders'."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "list": {"type": "string"},
                    "include_completed": {"type": "boolean"},
                    "limit": {"type": "integer"},
                },
            },
        },
    ),
    "apple_complete_reminder": (
        _tool_apple_complete_reminder,
        {
            "name": "apple_complete_reminder",
            "description": (
                "Mark a Reminders item complete. Fuzzy-matches by name "
                "within the target list. Prefer complete_commitment for "
                "the normal path so all mirrors close together."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "text_or_id": {"type": "string"},
                    "list": {"type": "string"},
                },
                "required": ["text_or_id"],
            },
        },
    ),
    "apple_save_note": (
        _tool_apple_save_note,
        {
            "name": "apple_save_note",
            "description": (
                "Save a note (meeting prep, briefing, research summary) "
                "to Apple Notes. Lands in the 'Jarvis' folder by "
                "default. Use when Watson says 'save this to Notes', or "
                "when an orchestrator plan produces a long-form artifact "
                "worth keeping."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "content": {"type": "string"},
                    "folder": {"type": "string"},
                },
                "required": ["title", "content"],
            },
        },
    ),
    "apple_read_note": (
        _tool_apple_read_note,
        {
            "name": "apple_read_note",
            "description": (
                "Read a note from Apple Notes. Fuzzy-matches title in "
                "the target folder, falls through to all notes if not "
                "in folder."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "folder": {"type": "string"},
                },
                "required": ["title"],
            },
        },
    ),
    "imessage_check": (
        _tool_imessage_check,
        {
            "name": "imessage_check",
            "description": (
                "Recent inbound iMessages from the local chat.db, "
                "newest first. Optionally filter by `contact` (phone "
                "number, email, or substring of either). Use when "
                "Watson asks 'check my messages', 'any new texts', "
                "'what did Karina text'. unread_only=true narrows to "
                "what hasn't been read yet."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "contact": {"type": "string"},
                    "hours": {"type": "number"},
                    "limit": {"type": "integer"},
                    "unread_only": {"type": "boolean"},
                },
            },
        },
    ),
    "imessage_read": (
        _tool_imessage_read,
        {
            "name": "imessage_read",
            "description": (
                "Two-sided thread with one contact, oldest to newest, "
                "for catching up on a specific conversation."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "contact": {"type": "string"},
                    "limit": {"type": "integer"},
                },
                "required": ["contact"],
            },
        },
    ),
    "imessage_send": (
        _tool_imessage_send,
        {
            "name": "imessage_send",
            "description": (
                "Send an iMessage via Messages.app. Same preview-then-"
                "confirm flow as send_email and send_telegram: first "
                "call WITHOUT confirm=true to preview the styled draft "
                "to Watson, then call again with confirm=true after he "
                "approves. NEVER set confirm=true on the first round."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "contact": {"type": "string",
                                "description": "Phone (+1...) or email handle."},
                    "message": {"type": "string"},
                    "service": {"type": "string",
                                "enum": ["iMessage", "SMS"]},
                    "confirm": {"type": "boolean",
                                "description": "True only after Watson has approved the preview."},
                },
                "required": ["contact", "message"],
            },
        },
    ),
    "imessage_search_contacts": (
        _tool_imessage_search_contacts,
        {
            "name": "imessage_search_contacts",
            "description": (
                "Find iMessage handles (phones / emails) Watson has "
                "messaged before, ranked by message volume. Use to "
                "resolve 'message Corbin' to a specific phone number."
            ),
            "input_schema": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    ),
    "apple_contacts_search": (
        _tool_apple_contacts_search,
        {
            "name": "apple_contacts_search",
            "description": (
                "Search the native Apple Contacts address book "
                "directly. Returns name, organization, all phones, "
                "emails. Heavier than the curated relationship_brief — "
                "use when Watson asks for a number/email that isn't in "
                "his curated graph."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer"},
                },
                "required": ["query"],
            },
        },
    ),
}


# ── config ────────────────────────────────────────────────────────────
def _load_config() -> dict:
    try:
        with CONFIG_FILE.open() as f:
            return json.load(f)
    except Exception:
        return {}


_PERSONALITY_DEFAULTS = {"humor": 75, "formality": 80, "proactivity": 70, "honesty": 90}


def _personality_calibration_block(cfg: dict) -> str:
    """Turn the four 0–100 sliders in settings.json into a short calibration
    line appended to the personality system prompt. Returns "" if every slider
    matches its default (no need to spend tokens stating the defaults)."""
    vals = {k: cfg.get(k, _PERSONALITY_DEFAULTS[k]) for k in _PERSONALITY_DEFAULTS}
    if all(vals[k] == _PERSONALITY_DEFAULTS[k] for k in vals):
        return ""
    return (
        "## Personality calibration (user preferences, 0–100 scale)\n"
        f"- humor: {vals['humor']} (higher = more wit and dry asides)\n"
        f"- formality: {vals['formality']} (higher = more 'sir', tighter register)\n"
        f"- proactivity: {vals['proactivity']} (higher = more anticipating, less asking)\n"
        f"- honesty: {vals['honesty']} (higher = more direct, less diplomatic)\n"
        "Modulate tone toward these values without naming them aloud."
    )


# ── World state — what a sharp EA knows walking into the room ────────
# Injected fresh every turn as an UNCACHED system block, so the model never
# has to call get_time/get_date/etc. for ground-truth "now" facts. Order in
# the system array: cacheable personality first (cache hit), then live memory,
# then live world state. Block 0 stays byte-stable, so its cache survives.
PULSE_CACHE = Path.home() / ".jarvis" / "cache" / "pulse_summary.txt"
PULSE_CACHE_TTL_S = 30 * 60  # 30 minutes — pulse re-runs in background after this


def _pulse_summary() -> str:
    """Return the top-of-pulse summary lines (28 tracked / fresh / warm / stale).
    Caches to disk for 30 min because `jarvis-pulse check` takes ~400ms which
    is too slow for the voice hot path."""
    try:
        if PULSE_CACHE.exists():
            age = time.time() - PULSE_CACHE.stat().st_mtime
            if age < PULSE_CACHE_TTL_S:
                return PULSE_CACHE.read_text(encoding="utf-8").strip()
    except Exception:
        pass

    pulse_bin: Path | None = None
    for candidate in (BIN_DIR / "jarvis-pulse",
                      Path.home() / ".jarvis" / "bin" / "jarvis-pulse",
                      Path.home() / "jarvis" / "client" / "bin" / "jarvis-pulse"):
        if candidate.exists():
            pulse_bin = candidate
            break
    if pulse_bin is None:
        return ""

    try:
        result = subprocess.run(
            [str(pulse_bin), "check"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return ""
        lines = [l.strip() for l in result.stdout.splitlines() if l.strip()]
        # First two lines are the headline + bucket counts.
        summary = " | ".join(lines[:2])
        try:
            PULSE_CACHE.parent.mkdir(parents=True, exist_ok=True)
            PULSE_CACHE.write_text(summary, encoding="utf-8")
        except Exception:
            pass
        return summary
    except Exception:
        return ""


def _world_state_text() -> str:
    """Compact 'what a sharp EA knows walking in' snapshot. ~150-250 tokens.
    All local + 30-min-cached. No network. Order: most-actionable first."""
    parts: list[str] = []

    now = datetime.now().astimezone()
    parts.append(f"**Now:** {now.strftime('%A, %-d %B %Y, %-I:%M %p %Z')}.")

    h = now.hour
    if h < 5: tod = "wee hours"
    elif h < 8: tod = "early morning"
    elif h < 12: tod = "morning"
    elif h < 14: tod = "midday"
    elif h < 17: tod = "afternoon"
    elif h < 20: tod = "evening"
    elif h < 23: tod = "night"
    else: tod = "late night"
    # Day-of-week shape lets the model match Watson's typical cadence.
    weekday = now.strftime("%A")
    if weekday in ("Saturday", "Sunday"):
        dow_shape = "weekend"
    elif weekday == "Monday":
        dow_shape = "Monday — fresh-week energy"
    elif weekday == "Friday":
        dow_shape = "Friday — finish-line energy"
    else:
        dow_shape = "midweek"
    parts.append(f"**Tempo:** {tod}, {dow_shape}.")

    # Last conversation turn
    try:
        if HISTORY_FILE.exists():
            elapsed = int(time.time() - HISTORY_FILE.stat().st_mtime)
            if elapsed < 60:
                last = f"{elapsed}s ago"
            elif elapsed < 3600:
                last = f"{elapsed // 60}m ago"
            elif elapsed < 86400:
                last = f"{elapsed // 3600}h ago"
            else:
                last = f"{elapsed // 86400}d ago"
            parts.append(f"**Last turn:** {last}.")
    except Exception:
        pass

    # System health (mac)
    sys_bits: list[str] = []
    try:
        up = subprocess.run(["uptime"], capture_output=True, text=True, timeout=2).stdout
        m = re.search(r"up\s+((?:\d+\s+days?,?\s+)?\d+:\d+|(?:\d+\s+days?))", up)
        if m:
            sys_bits.append(f"uptime {m.group(1).strip()}")
    except Exception:
        pass
    try:
        batt = subprocess.run(["pmset", "-g", "batt"], capture_output=True, text=True, timeout=2).stdout
        bm = re.search(r"(\d+)%", batt)
        chg = "charging" if "; charging" in batt else \
              ("on AC" if "AC Power" in batt else
               ("discharging" if "; discharging" in batt else ""))
        if bm:
            sys_bits.append(f"battery {bm.group(1)}%" + (f" ({chg})" if chg else ""))
    except Exception:
        pass
    if sys_bits:
        parts.append(f"**Mac:** {', '.join(sys_bits)}.")

    pulse = _pulse_summary()
    if pulse:
        parts.append(f"**Pulse:** {pulse}")

    # Findings — epistemic spine. Read from disk cache (no fork-exec); the
    # cache is rewritten by jarvis-finding on every mutation. Surface only
    # when there's something due. Stale cache (>1h) → silent skip.
    try:
        cache = Path.home() / ".jarvis" / "findings" / ".cache" / "stats.json"
        if cache.exists():
            age = time.time() - cache.stat().st_mtime
            if age < 3600:
                s = json.loads(cache.read_text())
                if int(s.get("due") or 0) > 0:
                    parts.append(
                        f"**Findings:** active={s.get('active', 0)} · due={s.get('due', 0)} "
                        f"_(run `jarvis-finding due` to revisit)_"
                    )
    except Exception:
        pass

    body = "\n".join(parts)
    return (
        "## Live World State\n\n"
        f"{body}\n\n"
        "_This block is regenerated every turn. Treat it as ground truth for date, "
        "time, day-of-week, system health, and relationship pulse — never guess these. "
        "Ignore items not present here only if a tool is more current._"
    )


def _load_auto_memory_index() -> str:
    """Load MEMORY.md from each of Watson's auto-memory dirs as a single block.
    These indices are file-per-fact maps with hooks — the model reads them and
    knows what's available; for any specific file's body, it calls
    `read_memory_file`. We cache this block separately so changes to MEMORY.md
    don't invalidate the personality cache."""
    chunks: list[str] = []
    for d in AUTO_MEMORY_DIRS:
        idx = d / "MEMORY.md"
        if not idx.exists():
            continue
        try:
            content = idx.read_text(encoding="utf-8").strip()
        except Exception:
            continue
        if not content:
            continue
        # Section header tells the model which dir each entry comes from
        chunks.append(f"### {d.name}\n\n{content}")
    if not chunks:
        return ""
    return (
        "## Watson's Memory Indices\n\n"
        "_The following are the MEMORY.md indices from Watson's auto-memory "
        "directories. Each entry points to a separate file you can pull with "
        "the `read_memory_file` tool. Treat these as the table of contents for "
        "everything Jarvis is meant to remember about him long-term._\n\n"
        + "\n\n".join(chunks)
    )


def _build_system_blocks(data: dict, user_text: str) -> list[dict]:
    """System message layout (4 cache breakpoints, in order):
      1. Personality + rolling summary  — cached (stable across all turns)
      2. Auto-memory indices            — cached (rare changes; own breakpoint
                                          so a memory edit doesn't bust #1)
      3. Live retrieval-memory snippet  — uncached (query-driven)
      4. Live world state               — uncached (regenerated every turn)

    Tools array gets the 3rd cache breakpoint (in `_stream_anthropic`).
    Last assistant message gets the 4th (in `_with_history_cache_breakpoint`).

    Memory injection uses focused top-k priming (Memory.format_priming_block)
    rather than spray-and-pray recent+relevant. When no memory matches the
    current query strongly, nothing is injected — avoiding context noise."""
    base = (data.get("system") or "").strip()
    summary = (data.get("summary") or "").strip()
    calibration = _personality_calibration_block(_load_config())
    parts = [p for p in (base, calibration) if p]
    if summary:
        parts.append(f"## Conversation summary so far\n{summary}")
    cacheable = "\n\n".join(parts).strip()

    mem = Memory()
    primer = mem.format_priming_block(query=user_text, k=3)
    auto_mem = _load_auto_memory_index()

    blocks: list[dict] = []

    # Predictive context block — uncached, top of stack so it shapes
    # interpretation. Read from disk every turn (recent topics + pending
    # notifications change quickly). Empty when JARVIS_PREDICTIVE_CONTEXT=0.
    # NOTE: jarvis-patterns.py is loaded indirectly here, not at the top —
    # ContextEngine.predict() calls _learned_pattern_hint() which lazy-loads
    # patterns. So this single load wires in both context AND patterns.
    ctx_mod = _load_context_module()
    if ctx_mod is not None:
        try:
            ctx_block = ctx_mod.ContextEngine(user_text=user_text).predict()
            if ctx_block:
                blocks.append({"type": "text", "text": ctx_block})
        except Exception as e:
            sys.stderr.write(f"jarvis-think: context engine skipped ({e})\n")

    # Compound-request guidance lives behind the same gate as parallel
    # tool execution — only useful if the runtime will actually fan tools
    # out. Stays as its own short block so the personality cache breakpoint
    # below stays byte-stable.
    if PARALLEL_TOOLS_ENABLED:
        blocks.append({"type": "text", "text": PARALLEL_TOOLS_HINT})

    # Feedback-driven behavioral calibration — pulls from the rolling
    # profile.json. Returns "" when there isn't enough session data yet,
    # so the block silently no-ops on fresh installs. Uncached because
    # the profile updates after every convo session.
    fb_mod = _load_feedback_module()
    if fb_mod is not None:
        try:
            fb_hint = fb_mod.system_prompt_hint()
            if fb_hint:
                blocks.append({"type": "text", "text": fb_hint})
        except Exception as e:
            sys.stderr.write(f"jarvis-think: feedback hint skipped ({e})\n")

    # Per-domain self-calibration from metacog. Tells Claude where it's
    # been reliably right (be direct) vs wrong (express uncertainty).
    mc_mod = _load_metacog_module()
    if mc_mod is not None:
        try:
            mc_hint = mc_mod.system_prompt_hint()
            if mc_hint:
                blocks.append({"type": "text", "text": mc_hint})
        except Exception as e:
            sys.stderr.write(f"jarvis-think: metacog hint skipped ({e})\n")

    # Lessons learned from autopsied failures. Surfaces recurrent failure
    # types as one-liner reminders. Empty until 2+ occurrences of any type.
    ap_mod = _load_autopsy_module()
    if ap_mod is not None:
        try:
            ap_hint = ap_mod.system_prompt_hint()
            if ap_hint:
                blocks.append({"type": "text", "text": ap_hint})
        except Exception as e:
            sys.stderr.write(f"jarvis-think: autopsy hint skipped ({e})\n")

    # Learned skills — workflows Jarvis has codified from prior teach
    # moments. Lists the available triggers so Claude knows what's there.
    sk_mod = _load_skills_module()
    if sk_mod is not None:
        try:
            sk_hint = sk_mod.system_prompt_hint()
            if sk_hint:
                blocks.append({"type": "text", "text": sk_hint})
        except Exception as e:
            sys.stderr.write(f"jarvis-think: skills hint skipped ({e})\n")

    # Synthesized user profile — weekly Sonnet pass over memories +
    # conversation summary distilled into decisions/comms/values/etc.
    # Goes near the top of priming because it shapes every reply.
    sy_mod = _load_synth_module()
    if sy_mod is not None:
        try:
            sy_hint = sy_mod.system_prompt_hint()
            if sy_hint:
                blocks.append({"type": "text", "text": sy_hint})
        except Exception as e:
            sys.stderr.write(f"jarvis-think: synthesis hint skipped ({e})\n")

    # Pending self-improvement draft — when one exists, the hint primes
    # Claude to surface it once on the next user turn. NEVER auto-applies;
    # the actual approval flow runs `bin/jarvis-evolve.py --approve`.
    ev_mod = _load_evolve_module()
    if ev_mod is not None:
        try:
            ev_hint = ev_mod.system_prompt_hint()
            if ev_hint:
                blocks.append({"type": "text", "text": ev_hint})
        except Exception as e:
            sys.stderr.write(f"jarvis-think: evolve hint skipped ({e})\n")

    # Orchestrator confidence — fires only when recent multi-step plan
    # ok_rate has dipped below threshold over enough runs. Tells Claude
    # to lean on direct atomic tools instead of execute_plan until things
    # recover. Empty in the healthy case.
    orch_mod = _load_orchestrator_module()
    if orch_mod is not None:
        try:
            orch_hint = orch_mod.system_prompt_hint()
            if orch_hint:
                blocks.append({"type": "text", "text": orch_hint})
        except Exception as e:
            sys.stderr.write(f"jarvis-think: orchestrator hint skipped ({e})\n")

    if cacheable:
        blocks.append({
            "type": "text",
            "text": cacheable,
            "cache_control": {"type": "ephemeral"},
        })
    if auto_mem:
        blocks.append({
            "type": "text",
            "text": auto_mem,
            "cache_control": {"type": "ephemeral"},
        })
    if primer:
        blocks.append({"type": "text", "text": primer})
    ws = _world_state_text()
    if ws:
        blocks.append({"type": "text", "text": ws})
    return blocks


# ── Voice markup post-processor ───────────────────────────────────────
# Inserts ElevenLabs-supported <break time="..."/> SSML tags so the TTS
# layer pauses where the writing pauses. Applied only to the final
# assistant reply — never to tool inputs or persisted history.
_BREAK_OPENER_RE = re.compile(
    r'(?m)((?:^|(?<=[.!?])\s+)(?:Well,|Hmm,|Let me think,?))'
)


def _apply_voice_markup(text: str) -> str:
    if not text or os.environ.get("JARVIS_VOICE_MARKUP", "1") != "1":
        return text
    # Ellipses (unicode … or three+ ASCII dots) → long thinking pause.
    text = text.replace("…", '<break time="0.8s"/>')
    text = re.sub(r"\.{3,}", '<break time="0.8s"/>', text)
    # Em dash → short rhetorical pause.
    text = text.replace("—", '<break time="0.3s"/>')
    # Reflective sentence openers — pause after the comma.
    text = _BREAK_OPENER_RE.sub(r'\1<break time="0.5s"/>', text)
    return text


# ── Anthropic API call ────────────────────────────────────────────────
# We always stream (`stream: true`) so callers can fire TTS sentence-by-sentence
# as text arrives. The blocking wrapper drains the stream and returns the same
# {content, stop_reason, usage} shape the old code expected.
#
# Two cache_control breakpoints are emitted when JARVIS_PROMPT_CACHE=1 (default):
# one on the system prompt (personality + memory + summary) and one on the
# tools array. Together they trim ~200-500ms off voice latency once warm.
# The summarizer call passes an empty system string and is excluded from the
# system breakpoint automatically.
def _stream_anthropic(api_key: str, model: str, system,
                     messages: list[dict], tools: list[dict]):
    """Yields ('text_delta', str), ('block_stop', dict),
    ('message_stop', {'stop_reason', 'blocks', 'usage'})."""
    use_cache = os.environ.get("JARVIS_PROMPT_CACHE", "1") == "1"

    # cache_control on the last tool caches the entire tools array as a unit
    cached_tools = list(tools)
    if cached_tools and use_cache:
        cached_tools = cached_tools[:-1] + [
            {**cached_tools[-1], "cache_control": {"type": "ephemeral"}}
        ]

    # cache_control on the system prompt (string → list-of-blocks form). Skipped
    # for empty system (summarizer) since there's nothing worth caching.
    system_field: Any
    if use_cache and system:
        system_field = [{
            "type": "text",
            "text": system,
            "cache_control": {"type": "ephemeral"},
        }]
    else:
        system_field = system

    payload = json.dumps({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": system_field,
        "messages": messages,
        "tools": cached_tools,
        "stream": True,
    }).encode()
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    if use_cache:
        headers["anthropic-beta"] = "prompt-caching-2024-07-31"
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers=headers,
    )
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                blocks: list[dict] = []
                current: dict | None = None
                stop_reason: str | None = None
                usage: dict = {}
                while True:
                    raw = r.readline()
                    if not raw:
                        break
                    line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                    if not line.startswith("data: "):
                        continue
                    try:
                        data = json.loads(line[6:])
                    except json.JSONDecodeError:
                        continue
                    et = data.get("type")
                    if et == "content_block_start":
                        cb = dict(data.get("content_block") or {})
                        if cb.get("type") == "text":
                            cb.setdefault("text", "")
                        elif cb.get("type") == "tool_use":
                            cb["_input_json"] = ""
                            cb.setdefault("input", {})
                        current = cb
                    elif et == "content_block_delta" and current is not None:
                        d = data.get("delta") or {}
                        if d.get("type") == "text_delta":
                            chunk = d.get("text", "")
                            current["text"] = current.get("text", "") + chunk
                            if chunk:
                                yield ("text_delta", chunk)
                        elif d.get("type") == "input_json_delta":
                            current["_input_json"] += d.get("partial_json", "")
                    elif et == "content_block_stop":
                        if current is not None:
                            if current.get("type") == "tool_use":
                                raw_json = current.pop("_input_json", "") or "{}"
                                try:
                                    current["input"] = json.loads(raw_json)
                                except json.JSONDecodeError:
                                    current["input"] = {}
                            blocks.append(current)
                            yield ("block_stop", current)
                            current = None
                    elif et == "message_delta":
                        d = data.get("delta") or {}
                        if "stop_reason" in d:
                            stop_reason = d["stop_reason"]
                        u = data.get("usage") or {}
                        usage.update(u)
                    elif et == "message_stop":
                        yield ("message_stop", {
                            "stop_reason": stop_reason,
                            "blocks": blocks,
                            "usage": usage,
                        })
                        return
                # stream ended without message_stop — emit what we have
                yield ("message_stop", {
                    "stop_reason": stop_reason,
                    "blocks": blocks,
                    "usage": usage,
                })
                return
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(1 + attempt * 1.5)
                continue
            try:
                err = json.loads(e.read()).get("error", {}).get("message", str(e))
            except Exception:
                err = str(e)
            raise RuntimeError(f"API error {e.code}: {err}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            if attempt < 2:
                time.sleep(1 + attempt * 1.5)
                continue
            raise RuntimeError(f"network error: {e}") from e
    raise RuntimeError(f"unexpected: {last_err}")


def _call_anthropic(api_key: str, model: str, system,
                    messages: list[dict], tools: list[dict]) -> dict:
    """Blocking wrapper kept for the summarizer."""
    blocks: list[dict] = []
    stop_reason: str | None = None
    usage: dict = {}
    for evt, payload in _stream_anthropic(api_key, model, system, messages, tools):
        if evt == "message_stop":
            blocks = payload["blocks"]
            stop_reason = payload["stop_reason"]
            usage = payload["usage"]
    return {"content": blocks, "stop_reason": stop_reason, "usage": usage}


# ── Streaming TTS feeder ──────────────────────────────────────────────
# Spawns a single subprocess that reads sentences from stdin and pipes each
# through `jarvis --speak` sequentially. Because each `jarvis --speak` blocks
# until its mp3 stream finishes playing, sentences naturally serialize — no
# audio overlap. We push complete sentences as they emerge from the API stream
# so the user hears the first sentence while Claude is still generating.
_SENTENCE_END_RE = re.compile(r"[.!?](?=\s|$)")

# Chain-of-thought: model wraps private reasoning in <thinking>…</thinking>.
# We strip those blocks from the spoken stream and capture them for logging.
_THINK_OPEN = "<thinking>"
_THINK_CLOSE = "</thinking>"
_THINKING_BLOCK_RE = re.compile(r"<thinking>(.*?)</thinking>", re.DOTALL | re.IGNORECASE)


def _strip_thinking(text: str) -> tuple[str, list[str]]:
    """Pull <thinking>…</thinking> blocks out of `text`. Returns (clean, blocks)."""
    if not text or "<thinking>" not in text.lower():
        return text, []
    blocks = [m.strip() for m in _THINKING_BLOCK_RE.findall(text) if m.strip()]
    cleaned = _THINKING_BLOCK_RE.sub("", text)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned, blocks


def _log_thinking(blocks: list[str]) -> None:
    """Append reasoning blocks to ~/.jarvis/logs/reasoning.log. Best-effort."""
    if not blocks:
        return
    log_path = ASSISTANT_DIR / "logs" / "reasoning.log"
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with log_path.open("a", encoding="utf-8") as f:
            for blk in blocks:
                f.write(f"[{ts}] {blk}\n")
    except Exception:
        pass


class _TTSFeeder:
    """Streams sentences to a `jarvis --speak` bash subprocess as they finish.

    Two layers of filtering before audio fires:
      1. <thinking>…</thinking> blocks are stripped in real time — the
         reasoning goes to self.thinking_log (and gets persisted by run_turn),
         never to the speakers. Partial open/close tags are held back across
         chunk boundaries so a tag split mid-stream never leaks.
      2. The remaining spoken buffer is emitted on sentence terminators (or
         a comma after 80 chars) so first audio fires early.
    """

    def __init__(self) -> None:
        jbin = BIN_DIR / "jarvis"
        self.alive = jbin.exists()
        self.proc: subprocess.Popen | None = None
        # Buffers — mirror _SentenceStreamer's state machine.
        self._buf = ""              # spoken-text buffer (pending sentence detection)
        self._pending = ""          # raw chunk tail held back when a partial tag is possible
        self._think_buf = ""        # accumulator for the current open <thinking> block
        self._in_think = False
        self.thinking_log: list[str] = []
        if not self.alive:
            return
        # Bash loop: read line, force-speak it, repeat. --speak ignores the
        # voice on/off state so streaming works regardless of `jarvis off`.
        cmd = (
            'while IFS= read -r line; do '
            '  [ -n "$line" ] && "$0" --speak "$line" >/dev/null 2>&1; '
            'done'
        )
        try:
            # NOT start_new_session — we want SIGINT from the shell loop to
            # propagate to the feeder + its `mpv` child so Ctrl-C kills audio.
            self.proc = subprocess.Popen(
                ["bash", "-c", cmd, str(jbin)],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                text=True,
            )
        except Exception:
            self.alive = False
            self.proc = None

    def feed(self, text: str) -> None:
        if not (self.alive and self.proc and self.proc.stdin):
            return
        if not text:
            return
        self._pending += text
        self._consume()
        # Emit every complete sentence we can find.
        while True:
            m = _SENTENCE_END_RE.search(self._buf)
            if not m:
                # If the buffer is getting long without sentence terminator,
                # flush at the next comma to keep first-audio early.
                if len(self._buf) > 140:
                    cm = re.search(r",\s", self._buf[80:])
                    if cm:
                        idx = 80 + cm.end()
                        self._send(self._buf[:idx].rstrip())
                        self._buf = self._buf[idx:]
                        continue
                break
            end = m.end()
            # Consume the trailing whitespace too.
            while end < len(self._buf) and self._buf[end].isspace():
                end += 1
            sentence = self._buf[:end].strip()
            self._buf = self._buf[end:]
            if sentence:
                self._send(sentence)

    def _consume(self) -> None:
        """Drain self._pending into either self._buf (spoken) or self._think_buf
        (logged). Holds back the tail when it could be a partial open/close tag
        so we never speak half a `<thinking>` token."""
        while self._pending:
            if self._in_think:
                close_idx = self._pending.find(_THINK_CLOSE)
                if close_idx >= 0:
                    self._think_buf += self._pending[:close_idx]
                    self.thinking_log.append(self._think_buf.strip())
                    self._think_buf = ""
                    self._in_think = False
                    self._pending = self._pending[close_idx + len(_THINK_CLOSE):]
                else:
                    safe_len = max(0, len(self._pending) - (len(_THINK_CLOSE) - 1))
                    self._think_buf += self._pending[:safe_len]
                    self._pending = self._pending[safe_len:]
                    return
            else:
                open_idx = self._pending.find(_THINK_OPEN)
                if open_idx >= 0:
                    self._buf += self._pending[:open_idx]
                    self._in_think = True
                    self._pending = self._pending[open_idx + len(_THINK_OPEN):]
                else:
                    safe_len = max(0, len(self._pending) - (len(_THINK_OPEN) - 1))
                    self._buf += self._pending[:safe_len]
                    self._pending = self._pending[safe_len:]
                    return

    def flush(self) -> None:
        """Emit anything buffered (used at end of round / end of turn)."""
        # Stream is settling — anything in _pending is no longer a partial tag.
        if self._pending:
            if self._in_think:
                self._think_buf += self._pending
            else:
                self._buf += self._pending
            self._pending = ""
        if self._in_think and self._think_buf.strip():
            # Defensive: model emitted <thinking> without a matching close.
            self.thinking_log.append(self._think_buf.strip())
            self._think_buf = ""
            self._in_think = False
        if self._buf.strip():
            self._send(self._buf.strip())
        self._buf = ""

    def _send(self, sentence: str) -> None:
        if not (self.alive and self.proc and self.proc.stdin):
            return
        try:
            self.proc.stdin.write(sentence + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, ValueError, OSError):
            self.alive = False

    def close(self) -> None:
        """Flush, signal EOF, and wait for the queued audio to finish playing
        so the caller (shell loop) doesn't start re-listening over the speaker."""
        self.flush()
        if self.proc:
            if self.proc.stdin:
                try:
                    self.proc.stdin.close()
                except Exception:
                    pass
            try:
                # Cap the wait so a hung mpv can't pin the loop forever.
                self.proc.wait(timeout=120)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            except Exception:
                pass


# ── conversation persistence ──────────────────────────────────────────
# On-disk format (cache/conversation.json):
#   { "system":   "<personality>",
#     "summary":  "<rolling memo of older turns, may be empty>",
#     "messages": [ {"role": "user"|"assistant", "content": "..."}, ... ] }
# Legacy list format `[{role, content}, ...]` is migrated on read.
HISTORY_WINDOW = max(2, int(os.environ.get("JARVIS_HISTORY_WINDOW", "20")))
SUMMARY_TRIGGER = max(HISTORY_WINDOW + 2, int(os.environ.get("JARVIS_SUMMARY_TRIGGER", "30")))
SUMMARY_MODEL = os.environ.get("JARVIS_SUMMARY_MODEL", "claude-haiku-4-5-20251001")


def _empty_data() -> dict:
    return {"system": "", "summary": "", "messages": []}


def _load_history() -> dict:
    if not HISTORY_FILE.exists():
        return _empty_data()
    try:
        with HISTORY_FILE.open(encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:
        return _empty_data()

    # Migrate legacy list → dict on first read.
    if isinstance(raw, list):
        system = ""
        messages: list[dict] = []
        for m in raw:
            if m.get("role") == "system":
                system = m.get("content") or ""
            elif m.get("role") in ("user", "assistant"):
                messages.append({"role": m["role"], "content": m["content"]})
        return {"system": system, "summary": "", "messages": messages}

    raw.setdefault("system", "")
    raw.setdefault("summary", "")
    raw.setdefault("messages", [])
    return raw


def _save_history(data: dict) -> None:
    HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = HISTORY_FILE.with_suffix(HISTORY_FILE.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, HISTORY_FILE)


def _maybe_summarize(data: dict, api_key: str) -> None:
    """Compress older messages into a rolling memo when length exceeds trigger.
    Mutates `data` in place. Failures are swallowed — we never lose history."""
    messages = data.get("messages") or []
    if len(messages) <= SUMMARY_TRIGGER:
        return

    # Keep the recent window, but advance the boundary so it begins on a user
    # turn — Claude's API rejects message lists that don't start with `user`.
    boundary = len(messages) - HISTORY_WINDOW
    while boundary > 0 and messages[boundary].get("role") != "user":
        boundary -= 1
    if boundary <= 0:
        return

    to_summarize = messages[:boundary]
    recent = messages[boundary:]
    prior_summary = data.get("summary") or ""

    transcript = "\n\n".join(
        f"{m['role'].upper()}: {m.get('content', '')}" for m in to_summarize
    )
    prompt = (
        "You are compressing an ongoing conversation between a user and an AI "
        "assistant (JARVIS) into a running memo. Produce a tight third-person "
        "summary that preserves: facts about the user, decisions made, ongoing "
        "tasks, names, numbers, dates, and unresolved threads. Drop pleasantries "
        "and verbatim phrasing. Aim for under 250 words.\n\n"
        f"Existing memo (may be empty):\n{prior_summary or '(none yet)'}\n\n"
        f"New conversation chunk to fold in:\n{transcript}\n\n"
        "Return only the updated memo."
    )

    try:
        resp = _call_anthropic(
            api_key, SUMMARY_MODEL, "",
            [{"role": "user", "content": prompt}], [],
        )
    except Exception as e:
        sys.stderr.write(f"jarvis: summary skipped ({e})\n")
        return

    blocks = resp.get("content") or []
    new_summary = "\n".join(
        b.get("text", "") for b in blocks if b.get("type") == "text"
    ).strip()
    if not new_summary:
        return

    data["summary"] = new_summary
    data["messages"] = recent


# ── main turn ─────────────────────────────────────────────────────────
def _with_history_cache_breakpoint(convo: list[dict]) -> list[dict]:
    """Mark the last assistant message in `convo` with cache_control so the
    full prior conversation prefix is cached. The fresh user_text appended
    after this stays uncached. Caller appends the new user turn AFTER calling
    this. Up to 4 cache breakpoints allowed total: system, tools, history."""
    if not convo:
        return convo
    # Find the last assistant message (might not be the literal last item).
    for i in range(len(convo) - 1, -1, -1):
        if convo[i].get("role") != "assistant":
            continue
        msg = dict(convo[i])
        content = msg.get("content")
        if isinstance(content, str):
            msg["content"] = [{
                "type": "text", "text": content,
                "cache_control": {"type": "ephemeral"},
            }]
        elif isinstance(content, list) and content:
            new_content = list(content[:-1]) + [
                {**dict(content[-1]), "cache_control": {"type": "ephemeral"}}
            ]
            msg["content"] = new_content
        else:
            return convo
        out = list(convo)
        out[i] = msg
        return out
    return convo


# ── Parallel thought streams (Innovation 2) ──────────────────────────
# For open-ended / analytical queries, fire 3 Claude calls concurrently with
# different framings, then a cheap Haiku judge picks the most helpful. Trades
# 4× API spend for diverse perspectives on the kind of question that benefits
# most from them. Simple queries (under 15 words, no analytical keyword) skip
# this path entirely.
_PARALLEL_KEYWORDS_RE = re.compile(
    r'\b(should|how do i|how should|what do you think|what would you|'
    r'what\'?s the best|best way|trade.?off|pros?\s+and\s+cons?|'
    r'why (do|did|does|would|should)|recommend|suggest|advise|'
    r'analyz[ei]|compare|opinion|approach|strategy)\b',
    re.I,
)
PARALLEL_TIMEOUT_S = 8.0
PARALLEL_LOG = ASSISTANT_DIR / "logs" / "parallel.log"


def _is_complex_query(text: str) -> bool:
    """Heuristic: long-enough message OR contains an analytical keyword."""
    t = (text or "").strip()
    if not t:
        return False
    word_count = len(t.split())
    if word_count > 15:
        return True
    return bool(_PARALLEL_KEYWORDS_RE.search(t))


_STREAM_FRAMES = [
    ("A", ""),
    ("B", "\n\nThink creatively and offer unexpected angles. "
          "Surface useful framings the obvious answer would miss."),
    ("C", "\n\nPlay devil's advocate — lead with the strongest counter-argument "
          "to the most likely default position. Then, only after, offer your honest take."),
]


def _stream_one_response(api_key: str, model: str, system_text: str,
                        messages: list[dict], label: str) -> tuple[str, str]:
    """One parallel stream — text only, no tools, single round. Returns
    (label, text). Failures return (label, '') so the judge can skip."""
    try:
        text_acc = ""
        for evt, payload in _stream_anthropic(api_key, model, system_text, messages, []):
            if evt == "text_delta":
                text_acc += payload
            elif evt == "message_stop":
                blocks = payload.get("blocks") or []
                tps = [b.get("text", "") for b in blocks if b.get("type") == "text"]
                merged = "\n".join(t for t in tps if t).strip()
                if merged:
                    text_acc = merged
                break
        return label, text_acc
    except Exception as e:
        return label, ""


def _judge_responses(api_key: str, user_text: str,
                     candidates: list[tuple[str, str]]) -> str:
    """Ask Haiku to pick the most helpful response. Returns 'A' / 'B' / 'C'.
    On any error, default to 'A' (the analytical/normal stream)."""
    valid = [(lbl, txt) for lbl, txt in candidates if txt.strip()]
    if not valid:
        return "A"
    if len(valid) == 1:
        return valid[0][0]

    prompt_parts = [
        f"User asked: {user_text!r}\n",
        "Three candidate responses follow. Pick the one most helpful to the user.",
        "Reply with a single letter (A, B, or C) and nothing else.\n",
    ]
    for lbl, txt in valid:
        snippet = txt[:600] + ("…" if len(txt) > 600 else "")
        prompt_parts.append(f"=== {lbl} ===\n{snippet}\n")
    judge_prompt = "\n".join(prompt_parts)

    body = {
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 6,
        "messages": [{"role": "user", "content": judge_prompt}],
    }
    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
    except Exception:
        return valid[0][0]

    blocks = data.get("content") or []
    txt = "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip().upper()
    for ch in txt:
        if ch in ("A", "B", "C"):
            return ch
    return valid[0][0]


def _log_parallel(user_text: str, candidates: list[tuple[str, str]],
                  winner: str) -> None:
    try:
        PARALLEL_LOG.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        entry = {
            "ts": ts,
            "user": user_text,
            "winner": winner,
            "candidates": [{"label": lbl, "text": txt} for lbl, txt in candidates],
        }
        with PARALLEL_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _parallel_think(api_key: str, model: str,
                    system_blocks: list[dict],
                    convo: list[dict]) -> str:
    """Fire three Claude streams concurrently with different framings, then
    have Haiku pick. Returns the winning response text. Tools intentionally
    omitted — parallel mode targets open-ended analysis, not tool use."""
    import concurrent.futures as cf

    # Flatten system blocks back to a single string for the alternative
    # streams since we're not using cache_control for these short-lived
    # variants. Ordering preserved.
    system_text = "\n\n".join(
        b.get("text", "") for b in system_blocks if isinstance(b, dict) and b.get("type") == "text"
    )

    threads: list[cf.Future] = []
    with cf.ThreadPoolExecutor(max_workers=3) as pool:
        for label, addendum in _STREAM_FRAMES:
            sys_text = (system_text + addendum).strip() if addendum else system_text
            threads.append(pool.submit(
                _stream_one_response, api_key, model, sys_text, list(convo), label,
            ))
        candidates: list[tuple[str, str]] = []
        for fut in cf.as_completed(threads, timeout=PARALLEL_TIMEOUT_S + 1.0):
            try:
                candidates.append(fut.result(timeout=0.1))
            except Exception:
                pass

    # Order candidates A-B-C for the judge prompt regardless of finish order
    candidates.sort(key=lambda x: x[0])

    winner_label = _judge_responses(api_key, convo[-1]["content"], candidates)
    _log_parallel(convo[-1]["content"], candidates, winner_label)

    for lbl, txt in candidates:
        if lbl == winner_label and txt.strip():
            return txt.strip()
    # Fallback — first non-empty candidate
    for _, txt in candidates:
        if txt.strip():
            return txt.strip()
    return ""


def _ledger_status_for(result: dict) -> str:
    """Map a tool result dict to one of the ledger status enum values.

    `error` → failed. `needs_confirmation` → pending_confirm (irreversible
    tools refusing to fire without user yes). Otherwise → success."""
    if not isinstance(result, dict):
        return "success"
    if result.get("error"):
        return "failed"
    if result.get("needs_confirmation"):
        return "pending_confirm"
    return "success"


def _ledger_context_for(name: str, args: dict, result: dict) -> dict:
    """Build a small, non-PII context blob for the ledger row. We capture
    the tool name plus a few well-known identifier fields so the
    reconciliation agent can group failures by recipient/thread/event."""
    ctx: dict = {"tool": name}
    if isinstance(args, dict):
        for k in ("to", "thread_id", "event_id", "platform", "group_name",
                  "query", "topic", "name", "draft_id", "item_id"):
            v = args.get(k)
            if isinstance(v, (str, int)) and v != "":
                ctx[k] = v
    if isinstance(result, dict):
        for k in ("message_id", "draft_id", "thread_id", "event_id",
                  "id", "count"):
            v = result.get(k)
            if isinstance(v, (str, int)) and v != "":
                ctx.setdefault(f"r_{k}", v)
        if result.get("error"):
            ctx["error"] = str(result["error"])[:200]
    return ctx


def _execute_one_tool(b: dict, mem) -> dict:
    """Execute a single tool_use block and return the matching tool_result
    dict. Pulled into its own function so both the sequential and parallel
    paths share identical error semantics. Wraps each call with timing +
    outcome-ledger emit so every tool invocation lands in the audit trail."""
    name = b.get("name")
    args = b.get("input") or {}
    started = time.monotonic()

    # Demo mode: short-circuit external-API tools through fixtures so the
    # orchestrator + briefing demo without every key configured. Tools the
    # demo table doesn't list (memory, clock, timers, shell, workflows,
    # notifications) fall through to the real handler — they don't need
    # external credentials.
    demo_result = None
    if _demo_mod is not None and _demo_mod.is_demo() and name:
        try:
            demo_result = _demo_mod.demo_dispatch(name, args)
        except Exception as e:
            demo_result = {"error": f"demo dispatch failed for {name}: {e}", "demo": True}

    if demo_result is not None:
        result = demo_result
    else:
        handler_pair = TOOLS.get(name)
        if not handler_pair:
            result = {"error": f"unknown tool: {name}"}
        else:
            handler, _schema = handler_pair
            try:
                result = handler(args, mem)
            except Exception as e:
                result = {"error": f"tool {name} failed: {e}"}
    elapsed_ms = int((time.monotonic() - started) * 1000)

    if _ledger_mod is not None:
        try:
            cap = TOOL_CAPABILITY_MAP.get(name or "", name or "unknown")
            _ledger_mod.emit(
                cap=cap,
                action=name or "unknown",
                status=_ledger_status_for(result if isinstance(result, dict) else {}),
                context=_ledger_context_for(name or "", args, result if isinstance(result, dict) else {}),
                latency_ms=elapsed_ms,
            )
        except Exception:
            pass

    return {
        "type": "tool_result",
        "tool_use_id": b.get("id"),
        "content": json.dumps(result, ensure_ascii=False),
    }


def _run_tool_blocks(tool_blocks: list[dict], mem) -> list[dict]:
    """Run all tool_use blocks from one API round and return their
    tool_result dicts in matching order. Parallelizes via ThreadPoolExecutor
    when there are >1 tools and the gate is enabled — they're guaranteed
    independent within a single round."""
    if not tool_blocks:
        return []
    if len(tool_blocks) == 1 or not PARALLEL_TOOLS_ENABLED:
        return [_execute_one_tool(b, mem) for b in tool_blocks]

    try:
        import concurrent.futures as cf
        with cf.ThreadPoolExecutor(max_workers=min(8, len(tool_blocks))) as pool:
            futures = {pool.submit(_execute_one_tool, b, mem): i
                       for i, b in enumerate(tool_blocks)}
            ordered: list[dict | None] = [None] * len(tool_blocks)
            for fut in cf.as_completed(futures, timeout=PARALLEL_TOOLS_TIMEOUT_S):
                idx = futures[fut]
                try:
                    ordered[idx] = fut.result(timeout=0.1)
                except Exception as e:
                    b = tool_blocks[idx]
                    ordered[idx] = {
                        "type": "tool_result",
                        "tool_use_id": b.get("id"),
                        "content": json.dumps(
                            {"error": f"tool {b.get('name')} failed in pool: {e}"},
                            ensure_ascii=False,
                        ),
                    }
        # If anything timed out and is still None, drop in an explicit error
        # so Claude has a tool_result for every tool_use_id (API requires
        # the pairing to round-trip).
        for i, r in enumerate(ordered):
            if r is None:
                b = tool_blocks[i]
                ordered[i] = {
                    "type": "tool_result",
                    "tool_use_id": b.get("id"),
                    "content": json.dumps(
                        {"error": f"tool {b.get('name')} timed out"},
                        ensure_ascii=False,
                    ),
                }
        return [r for r in ordered if r is not None]
    except Exception as e:
        sys.stderr.write(f"jarvis-think: parallel tools fell back to sequential ({e})\n")
        return [_execute_one_tool(b, mem) for b in tool_blocks]


def run_turn(user_text: str) -> str:
    # Fast path — caller already has the response (e.g. speculator hit). Skip
    # the API entirely; just record the user/assistant exchange in history so
    # the rolling memo + cache stay coherent. Caller is responsible for TTS.
    prebaked = os.environ.get("JARVIS_PREBAKED_RESPONSE", "").strip()
    if prebaked:
        history = _load_history()
        history.setdefault("messages", []).append({"role": "user", "content": user_text})
        history["messages"].append({"role": "assistant", "content": prebaked})
        _save_history(history)
        return prebaked

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return "I cannot reach Claude — the ANTHROPIC_API_KEY is not set, sir."

    cfg = _load_config()
    model = cfg.get("claude_model") or DEFAULT_MODEL

    history = _load_history()

    # Seed personality on first turn so future turns + summaries have context.
    if not history.get("system"):
        try:
            personality_path = ASSISTANT_DIR / "config" / "personality.md"
            if personality_path.exists():
                history["system"] = personality_path.read_text(encoding="utf-8")
        except Exception:
            pass

    # Compress old turns before this one if we're past the trigger.
    _maybe_summarize(history, api_key)

    system = _build_system_blocks(history, user_text)

    # Working messages (tool round-trip) — does NOT touch persistent history
    # until the final assistant turn lands. Cache breakpoint goes on the last
    # assistant turn so the entire history prefix is cacheable across turns.
    convo: list[dict] = [
        {"role": m["role"], "content": m["content"]}
        for m in history.get("messages", [])
    ]
    convo = _with_history_cache_breakpoint(convo)
    convo.append({"role": "user", "content": user_text})

    mem = Memory()
    tool_schemas = [s for _, s in TOOLS.values()]

    voice_stream = os.environ.get("JARVIS_VOICE_STREAM") == "1"
    feeder = _TTSFeeder() if voice_stream else None

    # ── Dynamic tool loading ──────────────────────────────────────────
    # JARVIS_DYNAMIC_TOOLS=1 → keyword-classify the user text into capability
    # groups and ship only the relevant tool subset. Saves 60-80% of the
    # ~2.4K tool-definition tokens on simple turns. Self-healing: if the
    # model whiffs ("I don't have a tool…"), round 0 retries once with the
    # full toolset (text mode only — voice mode skips the retry because
    # we've already streamed the wrong answer to the speakers).
    dynamic_tools = (
        os.environ.get("JARVIS_DYNAMIC_TOOLS") == "1"
        and _tool_selector_mod is not None
    )
    selector_result = None
    active_tool_schemas = tool_schemas
    if dynamic_tools:
        try:
            max_tools_env = int(os.environ.get("JARVIS_DYNAMIC_TOOLS_MAX", "20"))
        except ValueError:
            max_tools_env = 20
        try:
            selector_result = _tool_selector_mod.select_tools(
                user_text,
                tool_schemas,
                history_messages=history.get("messages") or [],
                max_tools=max_tools_env,
                ledger_module=_ledger_mod,
            )
            if not selector_result.fallback:
                sel = set(selector_result.selected_names)
                active_tool_schemas = [
                    s for s in tool_schemas if s.get("name") in sel
                ]
            if os.environ.get("JARVIS_THINK_DEBUG") == "1":
                sys.stderr.write(
                    f"jarvis-think: dynamic-tools "
                    f"{len(active_tool_schemas)}/{len(tool_schemas)} selected, "
                    f"~{selector_result.tokens_saved} tokens saved "
                    f"(groups={selector_result.matched_groups}, "
                    f"fallback={selector_result.fallback})\n"
                )
        except Exception as e:
            sys.stderr.write(
                f"jarvis-think: tool_selector failed ({e}); using full set\n"
            )
            active_tool_schemas = tool_schemas
            selector_result = None

    # Parallel thought streams — for open-ended/analytical queries, fan out
    # 3 calls with different framings, judge, return the winner. No tools
    # in this path; complex analysis usually doesn't need them. Falls back
    # to the standard tool loop if parallel mode produces nothing usable.
    # Triggers: gate enabled AND (complex query OR domain confidence < 0.7).
    # Low-domain confidence → always fan out, even on simple questions, so
    # the judge can pick the best answer in an area we've been wrong on.
    parallel_gate = os.environ.get("JARVIS_PARALLEL_THINK", "1") == "1"
    low_conf_trigger = False
    mc_mod = _load_metacog_module()
    if parallel_gate and mc_mod is not None:
        try:
            low_conf_trigger = mc_mod.domain_confidence(user_text) < 0.7
        except Exception:
            low_conf_trigger = False
    if parallel_gate and (_is_complex_query(user_text) or low_conf_trigger):
        try:
            parallel_text = _parallel_think(api_key, model, system, convo)
        except Exception as e:
            sys.stderr.write(f"jarvis-think: parallel mode failed ({e}); falling back\n")
            parallel_text = ""
        if parallel_text:
            if feeder:
                feeder.feed(parallel_text)
                feeder.close()
            history.setdefault("messages", []).append({"role": "user", "content": user_text})
            history["messages"].append({"role": "assistant", "content": parallel_text})
            _save_history(history)
            return parallel_text

    final_text = ""
    retried_full_tools = False
    try:
        for round_idx in range(MAX_TOOL_ROUNDS + 1):
            # Retry budget: round 0 only, text-mode only, dynamic-tools only.
            # Voice mode can't retry because the first attempt's text already
            # left the speakers.
            retries_left = (
                1 if (round_idx == 0 and dynamic_tools and feeder is None
                      and selector_result is not None
                      and not selector_result.fallback)
                else 0
            )
            while True:
                round_text = ""
                blocks = []
                stop_reason = None
                usage = {}
                try:
                    # JARVIS_LOCAL_MODEL=1 routes the inference call through the
                    # local model server first; on any error we fall through to
                    # the Anthropic path so a missing/unhealthy local model never
                    # breaks the foreground turn. Buffered (non-streaming) for
                    # the local path — TTS feeder still works on the single
                    # text_delta yield.
                    local_events = _try_local_buffered(system, convo, active_tool_schemas)
                    if local_events is not None:
                        event_iter: Any = iter(local_events)
                    else:
                        event_iter = _stream_anthropic(api_key, model, system, convo, active_tool_schemas)
                    for evt, payload in event_iter:
                        if evt == "text_delta":
                            round_text += payload
                            if feeder:
                                feeder.feed(payload)
                        elif evt == "message_stop":
                            blocks = payload["blocks"]
                            stop_reason = payload["stop_reason"]
                            usage = payload["usage"] or {}
                except RuntimeError as e:
                    err_msg = f"I appear to be having a moment, sir — {e}"
                    if feeder:
                        feeder.feed(err_msg)
                    return err_msg

                # Optional debug: log cache effectiveness on stderr.
                if os.environ.get("JARVIS_THINK_DEBUG") == "1" and usage:
                    sys.stderr.write(
                        f"jarvis-think: in={usage.get('input_tokens')} "
                        f"cache_read={usage.get('cache_read_input_tokens', 0)} "
                        f"cache_create={usage.get('cache_creation_input_tokens', 0)} "
                        f"out={usage.get('output_tokens')} stop={stop_reason}\n"
                    )

                text_parts = [b.get("text", "") for b in blocks if b.get("type") == "text"]
                raw_text = "\n".join(t for t in text_parts if t).strip() or round_text.strip()
                final_text, think_blocks = _strip_thinking(raw_text)
                if think_blocks:
                    _log_thinking(think_blocks)

                # Self-heal: model said "I don't have a tool" → reload all
                # tools and re-do round 0. Costs one extra call; keeps the
                # selector safe to enable.
                if (retries_left > 0
                        and stop_reason != "tool_use"
                        and _tool_selector_mod is not None
                        and _tool_selector_mod.looks_like_tool_miss(final_text)):
                    retries_left -= 1
                    retried_full_tools = True
                    active_tool_schemas = tool_schemas
                    sys.stderr.write(
                        "jarvis-think: tool miss detected; retrying with full toolset\n"
                    )
                    if _ledger_mod is not None:
                        try:
                            _ledger_mod.emit(
                                cap="tool_selector",
                                action="retry_full_tools",
                                status="success",
                                context={
                                    "groups": (selector_result.matched_groups
                                               if selector_result else []),
                                    "selected_count": (len(selector_result.selected_names)
                                                       if selector_result else 0),
                                },
                            )
                        except Exception:
                            pass
                    continue
                break

            if stop_reason != "tool_use":
                break

            if round_idx >= MAX_TOOL_ROUNDS:
                final_text = (
                    "I have been chasing tools too many times for one turn, sir. "
                    "Let us try again with a clearer ask."
                )
                if feeder:
                    feeder.feed(final_text)
                break

            # Tools running — flush any preamble text now so the user hears
            # "let me check that, sir" while the tool executes.
            if feeder:
                feeder.flush()

            convo.append({"role": "assistant", "content": blocks})

            # Tool execution. Within a single round all tool_use blocks are
            # INDEPENDENT by construction — Claude emitted them before seeing
            # any result, so by definition none can depend on another's
            # output. Cross-round dependencies are already serialized by the
            # outer loop. So parallelism here is "fan out the round's tools."
            tool_blocks = [b for b in blocks if b.get("type") == "tool_use"]
            tool_results: list[dict] = _run_tool_blocks(tool_blocks, mem)
            convo.append({"role": "user", "content": tool_results})
    finally:
        if feeder:
            feeder.close()

    # Selector telemetry — one row per turn so cumulative savings are
    # queryable via `outcome_ledger query --cap tool_selector`. Emitted only
    # when the selector ran (gate on, module present).
    if _ledger_mod is not None and selector_result is not None:
        try:
            _ledger_mod.emit(
                cap="tool_selector",
                action="select",
                status="success",
                context={
                    "selected": len(active_tool_schemas),
                    "total": len(tool_schemas),
                    "tokens_full": selector_result.tokens_full,
                    "tokens_selected": selector_result.tokens_selected,
                    "tokens_saved": selector_result.tokens_saved,
                    "groups": selector_result.matched_groups,
                    "fallback": selector_result.fallback,
                    "retried_full": retried_full_tools,
                },
            )
        except Exception:
            pass

    # Persist only the user/assistant text exchange — tool round-trip stays
    # ephemeral so conversation.json remains human-readable. History stores
    # the raw text; voice markup is applied only on the way out so future
    # turns don't see SSML tags in their context.
    history.setdefault("messages", []).append({"role": "user", "content": user_text})
    history["messages"].append({"role": "assistant", "content": final_text})
    _save_history(history)

    _maybe_extract_commitments(user_text, final_text)

    reply = final_text or "I appear to be at a loss for words, sir."
    return _apply_voice_markup(reply)


_COMMITMENT_HINTS_RE = re.compile(
    r"\b(I'?ll |I will |let me |let's |we'?ll |we will |"
    r"can you |could you |would you |"
    r"by (?:tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
    r"end of (?:day|week)|eod|eow|next week|\d)|"
    r"deadline|due (?:by|on)|owe you|i owe|remind me)\b",
    re.I,
)


def _maybe_extract_commitments(user_text: str, assistant_text: str) -> None:
    """Spawn a detached commitment extraction pass when the turn smells
    like a promise. Best-effort, non-blocking — the extracted items go
    into items.json straight away so the next 'what's on my plate'
    surfaces them. The audit log records every candidate, kept or
    rejected, so the self-improvement loop can tune the trigger."""
    if not _gate("commitments", default=True):
        return
    if not (user_text or assistant_text):
        return
    combined = f"{user_text}\n\n{assistant_text}"
    if not _COMMITMENT_HINTS_RE.search(combined):
        return
    # Spawn detached so we don't pay 1-3s of Haiku latency on the
    # critical path. The extractor itself logs and persists.
    src = BIN_DIR / "jarvis-commitments.py"
    if not src.exists():
        return
    py = sys.executable or "python3"
    try:
        subprocess.Popen(
            [py, str(src), "extract", combined[:8000],
             "--source", "conversation"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception:
        pass


def _gate(name: str, default: bool = True) -> bool:
    raw = os.environ.get(f"JARVIS_{name.upper()}")
    if raw is None:
        return default
    return str(raw).strip().lower() not in ("0", "false", "no", "off", "")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: jarvis-think.py <user text>", file=sys.stderr)
        return 2
    user_text = argv[1]
    reply = run_turn(user_text)
    print(reply)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except KeyboardInterrupt:
        sys.exit(130)
