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
    # Detached process — survives the converse process exiting.
    cmd = f'sleep {seconds} && {shlex.quote(str(jbin))} --speak {shlex.quote(msg)}'
    try:
        subprocess.Popen(
            ["bash", "-c", cmd],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
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
    cmd = f'sleep {seconds} && {shlex.quote(str(jbin))} --speak {shlex.quote(spoken)}'
    try:
        subprocess.Popen(
            ["bash", "-c", cmd],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
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


def _build_system_prompt(history: list[dict], user_text: str) -> str:
    """Personality + memory injection. Recomputed every turn so the most
    relevant memories surface based on the current user query."""
    base = ""
    if history and history[0].get("role") == "system":
        base = history[0].get("content") or ""
    mem = Memory()
    mem_block = mem.format_for_prompt(query=user_text, recent=8, relevant=5)
    if mem_block:
        return f"{base}\n\n{mem_block}".strip()
    return base


# ── Anthropic API call ────────────────────────────────────────────────
def _call_anthropic(api_key: str, model: str, system: str,
                    messages: list[dict], tools: list[dict]) -> dict:
    payload = json.dumps({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": system,
        "messages": messages,
        "tools": tools,
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
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


# ── conversation persistence ──────────────────────────────────────────
def _load_history() -> list[dict]:
    if not HISTORY_FILE.exists():
        return []
    try:
        with HISTORY_FILE.open() as f:
            return json.load(f)
    except Exception:
        return []


def _save_history(history: list[dict]) -> None:
    HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    # Keep last 20 turns + system prompt
    if len(history) > 21:
        history = [history[0]] + history[-20:]
    with HISTORY_FILE.open("w") as f:
        json.dump(history, f, indent=2, ensure_ascii=False)


# ── main turn ─────────────────────────────────────────────────────────
def run_turn(user_text: str) -> str:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return "I cannot reach Claude — the ANTHROPIC_API_KEY is not set, sir."

    cfg = _load_config()
    model = cfg.get("claude_model") or DEFAULT_MODEL

    history = _load_history()
    system = _build_system_prompt(history, user_text)

    # Working messages (tool round-trip) — does NOT touch persistent history
    # until the final assistant turn lands.
    convo: list[dict] = []
    for m in history:
        if m.get("role") == "system":
            continue
        convo.append({"role": m["role"], "content": m["content"]})
    convo.append({"role": "user", "content": user_text})

    mem = Memory()
    tool_schemas = [s for _, s in TOOLS.values()]

    final_text = ""
    for round_idx in range(MAX_TOOL_ROUNDS + 1):
        try:
            resp = _call_anthropic(api_key, model, system, convo, tool_schemas)
        except RuntimeError as e:
            return f"I appear to be having a moment, sir — {e}"

        stop_reason = resp.get("stop_reason")
        blocks = resp.get("content") or []

        # Capture any text in this turn (could coexist with tool_use)
        text_parts = [b.get("text", "") for b in blocks if b.get("type") == "text"]
        final_text = "\n".join(t for t in text_parts if t).strip()

        if stop_reason != "tool_use":
            break  # done — assistant's final reply is in final_text

        if round_idx >= MAX_TOOL_ROUNDS:
            # Safety valve — refuse to spin forever
            final_text = (
                "I have been chasing tools too many times for one turn, sir. "
                "Let us try again with a clearer ask."
            )
            break

        # Apply tools, append result blocks for next round
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

    # Persist only the user/assistant text exchange — tool round-trip stays
    # ephemeral so conversation.json remains human-readable.
    if not history:
        # Seed system prompt for future turns. We store the BASE personality
        # (without memory injection); _build_system_prompt re-derives memory
        # injection on each call.
        try:
            personality_path = ASSISTANT_DIR / "config" / "personality.md"
            base_system = personality_path.read_text(encoding="utf-8") if personality_path.exists() else ""
        except Exception:
            base_system = ""
        if base_system:
            history.append({"role": "system", "content": base_system})

    history.append({"role": "user", "content": user_text})
    history.append({"role": "assistant", "content": final_text})
    _save_history(history)

    return final_text or "I appear to be at a loss for words, sir."


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
