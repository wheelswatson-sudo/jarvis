#!/usr/bin/env python3
"""Speculative Claude generation based on partial transcripts.

While the user is still speaking (Deepgram emits PARTIAL transcripts), fire a
cheap Haiku call against the in-progress text. If the FINAL transcript ends
up matching the partial we speculated on (>= 60% word overlap by default),
the response is already in-hand — we skip the real Claude call and pipe the
cached text straight to TTS. Saves ~2-4s per turn for questions/commands
that the user can unambiguously start speaking.

Speculation runs in a daemon thread launched from feed_partial(). It can be
cancelled by consume_for_final() at any point; in-flight HTTP is closed
gracefully so we don't burn API credits forever.

Tool calls during speculation are restricted to a read-only allowlist
(get_time, get_date, recall, search_contacts). Side-effect tools
(set_timer, set_reminder, run_command, remember) are deliberately excluded
— speculative actions would fire BEFORE the user has finished speaking,
violating user intent if FINAL diverges.

This module is imported by wake-listener.py via importlib, mirroring the
pattern jarvis-think.py uses for jarvis_memory. Standalone smoke test:
    JARVIS_TEST_PARTIAL='what is the time' python3 bin/jarvis-speculate.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
BIN_DIR = ASSISTANT_DIR / "bin"

# ── Configuration ─────────────────────────────────────────────────────
# Haiku is ~3-4× faster than Sonnet, ~10× cheaper. Speculation needs to be
# both — most of the value comes from cutting first-audio latency, and most
# misses are wasted spend.
SPECULATION_MODEL = os.environ.get("JARVIS_SPECULATION_MODEL", "claude-haiku-4-5-20251001")

# Don't fire until the user has actually committed to a thought. 1.5s of
# speech with at least 3 words is the minimum signal we trust.
SPECULATION_DELAY_S = float(os.environ.get("JARVIS_SPECULATION_DELAY_S", "1.5"))
MIN_WORDS_TO_SPECULATE = int(os.environ.get("JARVIS_SPECULATION_MIN_WORDS", "3"))

# Word-overlap threshold for accepting the speculation when FINAL arrives.
# 0.6 is the spec default — generous enough to absorb minor phrasing drift
# without accepting a wildly different question.
OVERLAP_ACCEPT = float(os.environ.get("JARVIS_SPECULATION_OVERLAP", "0.6"))

# Cap response tokens — speculation should bias toward a tight first sentence,
# not a paragraph. The real call (if speculation misses) gets full budget.
SPECULATION_MAX_TOKENS = int(os.environ.get("JARVIS_SPECULATION_MAX_TOKENS", "256"))

# Speculation system prefix — tells the model the input is partial.
_SPECULATION_PREFIX = (
    "You are receiving a PARTIAL transcript of the user's speech — they "
    "are still speaking. Begin your response based on the most likely "
    "complete utterance. Keep your first sentence short, direct, and useful "
    "even if the user adds another clause. Do NOT acknowledge that the "
    "input is partial. Do NOT ask clarifying questions. Speak as JARVIS."
)

# Intent classifier — match at start of utterance, lowercase already applied.
_QUESTION_OPENERS_RE = re.compile(
    r'^\s*(what|whats|what\'s|who|whos|who\'s|when|where|how|why|'
    r'can|could|will|would|do|does|did|is|are|was|were|am|should|may|might)\b'
)
_COMMAND_OPENERS_RE = re.compile(
    r'^\s*(remind|set|search|tell|play|show|find|look|check|read|list|'
    r'open|start|stop|cancel|schedule|book|email|message|text|call)\b'
)
# Phrases that need real-time data we won't risk speculating wrong on.
# Time/date are still allowed because we have read-only tools for them, but
# anything dependent on tool outputs not in the allowlist gets blocked.
_NEEDS_WRITE_TOOL_RE = re.compile(
    r'\b(set\s+a?\s*timer|set\s+a?\s*reminder|remind\s+me|remember|'
    r'save|delete|cancel|update|run|execute)\b'
)


def _word_overlap(a: str, b: str) -> float:
    """Fraction of `a`'s words that appear in `b`. Asymmetric on purpose:
    we want to know how much of the speculated-on text survived into FINAL,
    not how much new content `b` added."""
    aw = re.findall(r"[a-z0-9']+", (a or "").lower())
    bw = set(re.findall(r"[a-z0-9']+", (b or "").lower()))
    if not aw:
        return 0.0
    hits = sum(1 for w in aw if w in bw)
    return hits / len(aw)


def _is_speculation_eligible(text: str) -> bool:
    """True if it's safe + valuable to speculate on this partial.

    Eligibility criteria:
      - At least MIN_WORDS_TO_SPECULATE words committed
      - Starts with a recognized intent opener (question or command verb)
      - Doesn't reference write-only tools (set_timer, remember, etc.) —
        those need the user's full sentence + real Claude call
    """
    t = (text or "").strip().lower()
    if len(t.split()) < MIN_WORDS_TO_SPECULATE:
        return False
    if _NEEDS_WRITE_TOOL_RE.search(t):
        return False
    return bool(_QUESTION_OPENERS_RE.match(t) or _COMMAND_OPENERS_RE.match(t))


# ── Memory module (lazy import, mirrors jarvis-think.py pattern) ──────
_memory_mod = None


def _load_memory():
    global _memory_mod
    if _memory_mod is not None:
        return _memory_mod
    src = BIN_DIR / "jarvis_memory.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis_memory.py"
    spec = importlib.util.spec_from_file_location("jarvis_memory", src)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    _memory_mod = mod
    return mod


# ── Read-only tool implementations ────────────────────────────────────
# Mirrors jarvis-think.py's helpers but stripped to the safe subset and
# without the side-effecting ones. Mutations go through the real call.
def _tool_get_time(_args: dict) -> dict:
    now = datetime.now().astimezone()
    return {
        "iso": now.isoformat(timespec="seconds"),
        "human": now.strftime("%-I:%M %p %Z"),
        "weekday": now.strftime("%A"),
    }


def _tool_get_date(_args: dict) -> dict:
    now = datetime.now().astimezone()
    return {
        "iso": now.date().isoformat(),
        "human": now.strftime("%A, %B %-d, %Y"),
    }


def _tool_recall(args: dict) -> dict:
    mem_mod = _load_memory()
    mem = mem_mod.Memory()
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


def _tool_search_contacts(args: dict) -> dict:
    query = (args.get("query") or "").strip()
    if not query:
        return {"error": "query is required"}
    recall_bin = BIN_DIR / "jarvis-recall"
    if not recall_bin.exists():
        return {"error": "jarvis-recall not installed", "query": query}
    try:
        result = subprocess.run(
            [str(recall_bin), "who", query],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return {"error": (result.stderr or "lookup failed").strip()[:300]}
        return json.loads(result.stdout or "{}")
    except subprocess.TimeoutExpired:
        return {"error": "contact lookup timed out"}
    except json.JSONDecodeError:
        return {"error": "could not parse jarvis-recall output"}


# Allowlist of tools the speculator may actually invoke. Anything outside
# this dict gets refused with a {"error": "tool not allowed in speculation"}
# tool_result. The schemas mirror jarvis-think.py's so the model isn't
# confused if a tool name overlaps.
SPECULATIVE_TOOL_HANDLERS: dict[str, Callable[[dict], dict]] = {
    "get_time": _tool_get_time,
    "get_date": _tool_get_date,
    "recall": _tool_recall,
    "search_contacts": _tool_search_contacts,
}

SPECULATIVE_TOOL_SCHEMAS = [
    {
        "name": "get_time",
        "description": "Get the current local time (with timezone).",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_date",
        "description": "Get today's date and weekday.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "recall",
        "description": (
            "Search the user's memory store by keyword + recency. "
            "Returns up to `limit` matches."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer"},
            },
        },
    },
    {
        "name": "search_contacts",
        "description": (
            "Look up a person in the user's contacts + iMessage history. "
            "Returns identity, last interaction, and notes if available."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
]


# ── HTTP streaming (minimal, dedicated to speculation) ────────────────
# Doesn't use jarvis-think.py's _stream_anthropic because we want a smaller
# footprint and tighter cancellation semantics. Caller passes a `should_stop`
# callable; we close the response on the next chunk after it returns True.
def _stream_messages(api_key: str, model: str, system: str,
                     messages: list[dict], tools: list[dict],
                     should_stop: Callable[[], bool],
                     on_text_delta: Callable[[str], None] | None = None):
    """Yields nothing; instead invokes `on_text_delta(chunk)` and finally
    returns a tuple (blocks, stop_reason)."""
    body = {
        "model": model,
        "max_tokens": SPECULATION_MAX_TOKENS,
        "system": system,
        "messages": messages,
        "tools": tools,
        "stream": True,
    }
    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "accept": "text/event-stream",
        },
    )
    blocks: list[dict] = []
    current: dict | None = None
    stop_reason: str | None = None

    try:
        resp = urllib.request.urlopen(req, timeout=30)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
        return [], f"connect_error:{e}"

    try:
        while True:
            if should_stop():
                break
            raw = resp.readline()
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
                    if chunk and on_text_delta:
                        on_text_delta(chunk)
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
                    current = None
            elif et == "message_delta":
                d = data.get("delta") or {}
                if "stop_reason" in d:
                    stop_reason = d["stop_reason"]
            elif et == "message_stop":
                break
    finally:
        try:
            resp.close()
        except Exception:
            pass

    return blocks, stop_reason


# ── Speculator class ──────────────────────────────────────────────────
MAX_TOOL_ROUNDS_SPECULATION = 1  # one pass of tool calls; never more


class Speculator:
    """Manages a single speculative Claude call across one user utterance.

    Lifecycle:
      - feed_partial(text)           — called on every Deepgram PARTIAL.
                                        Fires the speculation thread once
                                        SPECULATION_DELAY_S has elapsed AND
                                        the partial is eligible.
      - consume_for_final(final)     — called when FINAL arrives. Blocks
                                        briefly waiting for in-flight stream
                                        to settle, then returns
                                        (use_speculation: bool, text: str).
                                        On True, caller pipes text to TTS;
                                        on False, caller fires real respond().
    """

    def __init__(self, api_key: str, system_text: str,
                 history_messages: list[dict] | None = None) -> None:
        self.api_key = api_key
        self.system_text = (system_text or "").strip()
        self.history = list(history_messages or [])

        self._first_partial_at: float | None = None
        self._latest_partial: str = ""
        self._fired = False
        self._cancelled = False
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._result_text = ""
        self._done = False

    # ── partial intake ────────────────────────────────────────────────
    def feed_partial(self, text: str) -> None:
        text = (text or "").strip()
        if not text:
            return
        with self._lock:
            self._latest_partial = text
            if self._first_partial_at is None:
                self._first_partial_at = time.monotonic()
            should_fire = (
                not self._fired
                and (time.monotonic() - self._first_partial_at) >= SPECULATION_DELAY_S
                and _is_speculation_eligible(text)
            )
            if should_fire:
                self._fired = True
                self._thread = threading.Thread(
                    target=self._run, args=(text,), daemon=True,
                )
                self._thread.start()

    # ── speculation thread body ───────────────────────────────────────
    def _run(self, partial_text: str) -> None:
        try:
            convo: list[dict] = list(self.history)
            convo.append({"role": "user", "content": partial_text})

            # Prepend the speculation prefix to whatever system text the caller
            # passed (typically the personality + memory blocks). The prefix
            # lives FIRST so it shapes how the model treats the partial input.
            sys_text = self.system_text
            sys_full = (
                f"{_SPECULATION_PREFIX}\n\n{sys_text}".strip()
                if sys_text else _SPECULATION_PREFIX
            )

            for round_idx in range(MAX_TOOL_ROUNDS_SPECULATION + 1):
                if self._cancelled:
                    return
                blocks, stop_reason = _stream_messages(
                    self.api_key, SPECULATION_MODEL, sys_full,
                    convo, SPECULATIVE_TOOL_SCHEMAS,
                    should_stop=lambda: self._cancelled,
                )
                if self._cancelled:
                    return

                text_parts = [b.get("text", "") for b in blocks if b.get("type") == "text"]
                running = "\n".join(t for t in text_parts if t).strip()
                if running:
                    with self._lock:
                        self._result_text = running

                if stop_reason != "tool_use":
                    return
                if round_idx >= MAX_TOOL_ROUNDS_SPECULATION:
                    return

                # Tool round — restricted to allowlist.
                convo.append({"role": "assistant", "content": blocks})
                results = []
                for b in blocks:
                    if b.get("type") != "tool_use":
                        continue
                    name = b.get("name")
                    handler = SPECULATIVE_TOOL_HANDLERS.get(name)
                    if not handler:
                        result = {"error": f"tool {name!r} not allowed in speculation"}
                    else:
                        try:
                            result = handler(b.get("input") or {})
                        except Exception as e:
                            result = {"error": f"tool {name} failed: {e}"}
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": b.get("id"),
                        "content": json.dumps(result, ensure_ascii=False),
                    })
                convo.append({"role": "user", "content": results})
        except Exception as e:
            sys.stderr.write(f"speculator: {e}\n")
        finally:
            with self._lock:
                self._done = True

    # ── consumption ──────────────────────────────────────────────────
    def consume_for_final(self, final_text: str,
                          settle_timeout_s: float = 0.4) -> tuple[bool, str]:
        """Decide: use the speculative response or fall back to a real call?

        Returns (True, text) when the partial we speculated on overlaps the
        FINAL by >= OVERLAP_ACCEPT and the speculative call produced text.
        Otherwise (False, "") — caller fires a real respond().

        Always sets self._cancelled so the speculation thread exits on its
        next loop iteration; we wait briefly for an in-flight stream to
        flush so we don't lose the last sentence.
        """
        with self._lock:
            partial = self._latest_partial
            fired = self._fired
            self._cancelled = True

        if not fired:
            return False, ""

        # Give the streaming call up to settle_timeout_s to finish or release
        # — typically <100ms when the partial is short.
        if self._thread:
            self._thread.join(timeout=settle_timeout_s)

        with self._lock:
            text = self._result_text.strip()

        if not text:
            return False, ""

        overlap = _word_overlap(partial, final_text)
        return (overlap >= OVERLAP_ACCEPT), text

    @property
    def fired(self) -> bool:
        with self._lock:
            return self._fired

    def cancel(self) -> None:
        with self._lock:
            self._cancelled = True


# ── Smoke test ────────────────────────────────────────────────────────
def _smoke_test() -> int:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        sys.stderr.write("ANTHROPIC_API_KEY not set — smoke test cannot run\n")
        return 2
    partial = os.environ.get("JARVIS_TEST_PARTIAL", "what is the time")
    final = os.environ.get("JARVIS_TEST_FINAL", "what is the time and weather")

    sp = Speculator(api_key, system_text="You are JARVIS.")
    sp.feed_partial(partial)
    # Force-fire ignoring the delay so the smoke test runs in < 5s.
    sp._first_partial_at = time.monotonic() - SPECULATION_DELAY_S - 0.1  # type: ignore[attr-defined]
    sp.feed_partial(partial)

    time.sleep(2.0)
    use, text = sp.consume_for_final(final)
    print(f"speculator: use={use} text={text[:120]!r}")
    return 0 if use else 1


if __name__ == "__main__":
    sys.exit(_smoke_test())
