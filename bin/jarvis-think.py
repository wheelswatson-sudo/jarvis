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
}


# ── config ────────────────────────────────────────────────────────────
def _load_config() -> dict:
    try:
        with CONFIG_FILE.open() as f:
            return json.load(f)
    except Exception:
        return {}


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
    if summary:
        cacheable = f"{base}\n\n## Conversation summary so far\n{summary}".strip()
    else:
        cacheable = base

    mem = Memory()
    primer = mem.format_priming_block(query=user_text, k=3)
    auto_mem = _load_auto_memory_index()

    blocks: list[dict] = []
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
        with HISTORY_FILE.open() as f:
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
    with HISTORY_FILE.open("w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


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

    final_text = ""
    try:
        for round_idx in range(MAX_TOOL_ROUNDS + 1):
            round_text = ""
            blocks: list[dict] = []
            stop_reason: str | None = None
            usage: dict = {}
            try:
                for evt, payload in _stream_anthropic(api_key, model, system, convo, tool_schemas):
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
            tool_results: list[dict] = []
            for b in blocks:
                if b.get("type") != "tool_use":
                    continue
                name = b.get("name")
                args = b.get("input") or {}
                handler_pair = TOOLS.get(name)
                if not handler_pair:
                    result = {"error": f"unknown tool: {name}"}
                else:
                    handler, _schema = handler_pair
                    try:
                        result = handler(args, mem)
                    except Exception as e:
                        result = {"error": f"tool {name} failed: {e}"}
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": b.get("id"),
                    "content": json.dumps(result, ensure_ascii=False),
                })
            convo.append({"role": "user", "content": tool_results})
    finally:
        if feeder:
            feeder.close()

    # Persist only the user/assistant text exchange — tool round-trip stays
    # ephemeral so conversation.json remains human-readable. History stores
    # the raw text; voice markup is applied only on the way out so future
    # turns don't see SSML tags in their context.
    history.setdefault("messages", []).append({"role": "user", "content": user_text})
    history["messages"].append({"role": "assistant", "content": final_text})
    _save_history(history)

    reply = final_text or "I appear to be at a loss for words, sir."
    return _apply_voice_markup(reply)


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
