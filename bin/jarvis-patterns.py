#!/usr/bin/env python3
"""Behavioral pattern learning — replace static time-of-day rules with
patterns Jarvis observed in Watson's actual behavior.

Per-session event log lives at ~/.jarvis/patterns/events.jsonl. Each
session contributes:
    timestamp, weekday, hour
    first_user_query  (first thing said in the session)
    domain            (from metacog's classifier)
    tools_used        list[str]
    duration_seconds  estimated from msg timestamps
    mode              "wake" | "convo"

Pattern extraction (every ~10 sessions, configurable) produces:
    ~/.jarvis/patterns/patterns.json
        time_clusters     "Watson asks email Mon-Fri 8:30-9:30 (87%)"
        sequence_pairs    "after email → calendar 72%"
        domain_by_hour    histogram for system-prompt priming
        tool_usage        per-tool count + duration buckets

The ContextEngine (jarvis-context.py) reads patterns.json and replaces
the static morning/afternoon hint with the learned line that fits the
current hour + weekday.

Usage:
    bin/jarvis-patterns.py log         record a session event from history
    bin/jarvis-patterns.py extract     re-derive patterns.json
    bin/jarvis-patterns.py --print     show patterns.json
    bin/jarvis-patterns.py --reset     wipe events + patterns

Gate: JARVIS_PATTERN_LEARN (default 1).
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
HISTORY_FILE = ASSISTANT_DIR / "cache" / "conversation.json"
PATTERNS_DIR = ASSISTANT_DIR / "patterns"
EVENTS_FILE = PATTERNS_DIR / "events.jsonl"
PATTERNS_FILE = PATTERNS_DIR / "patterns.json"
LAST_SESSION_FILE = PATTERNS_DIR / "last_session.json"

EXTRACT_EVERY_N = int(os.environ.get("JARVIS_PATTERN_EXTRACT_EVERY", "10"))


# ── Domain classifier (mirrors metacog so the two stay aligned) ─────
DOMAIN_PATTERNS = [
    ("email", re.compile(r"\b(email|reply|inbox|draft.*?email|message.*?(from|to))\b", re.I)),
    ("calendar", re.compile(r"\b(calendar|meeting|schedule|book|appointment|when am i)\b", re.I)),
    ("reminders", re.compile(r"\b(remind me|set a timer|set a reminder|wake me|alarm)\b", re.I)),
    ("info", re.compile(r"\b(what is|who is|where is|how do|when does)\b", re.I)),
    ("recall", re.compile(r"\b(remember when|do you remember|what did i (say|tell)|recall)\b", re.I)),
    ("technical", re.compile(r"\b(code|debug|api|deploy|git|repo|build|test)\b", re.I)),
    ("task", re.compile(r"\b(todo|task|finish|prep|prepare|draft|review)\b", re.I)),
    ("strategy", re.compile(r"\b(should i|how should|trade.?off|approach|strategy|recommend)\b", re.I)),
    ("casual", re.compile(r"\b(how are you|good (morning|night)|hey|thanks)\b", re.I)),
]


def classify_domain(text: str) -> str:
    if not text:
        return "other"
    for label, regex in DOMAIN_PATTERNS:
        if regex.search(text):
            return label
    return "other"


# ── History → session events ────────────────────────────────────────
def _load_history_messages() -> list[dict]:
    if not HISTORY_FILE.exists():
        return []
    try:
        with HISTORY_FILE.open() as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return []
    if isinstance(data, dict):
        return list(data.get("messages") or [])
    return list(data) if isinstance(data, list) else []


def _last_session_marker() -> dict:
    if not LAST_SESSION_FILE.exists():
        return {"last_idx": -1}
    try:
        with LAST_SESSION_FILE.open() as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {"last_idx": -1}


def _save_session_marker(idx: int) -> None:
    try:
        PATTERNS_DIR.mkdir(parents=True, exist_ok=True)
        with LAST_SESSION_FILE.open("w", encoding="utf-8") as f:
            json.dump({"last_idx": idx, "ts": datetime.now().isoformat()}, f)
    except OSError:
        pass


def log_session(messages: list[dict] | None = None,
                mode: str | None = None) -> dict | None:
    """Record one session-shaped event from the suffix of conversation.json
    that's new since last_session.json. Returns the event written, or None
    if there's nothing new."""
    if messages is None:
        messages = _load_history_messages()
    if not messages:
        return None

    marker = _last_session_marker()
    last_idx = int(marker.get("last_idx", -1))
    new_msgs = messages[last_idx + 1:]
    user_msgs = [m for m in new_msgs if m.get("role") == "user"
                 and isinstance(m.get("content"), str)]
    assistant_msgs = [m for m in new_msgs if m.get("role") == "assistant"]
    if not user_msgs:
        return None

    first_q = user_msgs[0].get("content", "").strip()
    if not first_q:
        return None

    domain = classify_domain(first_q)
    now = datetime.now().astimezone()

    # Tool usage detection — assistant content is text only here, but the
    # log captures *what kind* of help happened by re-classifying user
    # queries that sit alongside likely tool calls. Best-effort.
    tool_hints: list[str] = []
    for u in user_msgs:
        d = classify_domain(u.get("content", ""))
        if d in ("email", "calendar", "reminders", "recall"):
            tool_hints.append(d)

    event = {
        "ts": time.time(),
        "iso": now.isoformat(timespec="seconds"),
        "weekday": now.strftime("%A"),
        "hour": now.hour,
        "first_user_query": first_q[:240],
        "domain": domain,
        "tool_hints": list(dict.fromkeys(tool_hints))[:8],
        "user_turns": len(user_msgs),
        "assistant_turns": len(assistant_msgs),
        "mode": mode or os.environ.get("JARVIS_SESSION_MODE", "unknown"),
    }

    try:
        PATTERNS_DIR.mkdir(parents=True, exist_ok=True)
        with EVENTS_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
    except OSError:
        return None

    _save_session_marker(len(messages) - 1)

    # Auto-extract every N events
    try:
        n_events = sum(1 for _ in EVENTS_FILE.open())
        if n_events > 0 and n_events % EXTRACT_EVERY_N == 0:
            extract_patterns()
    except OSError:
        pass

    return event


# ── Pattern extraction ──────────────────────────────────────────────
def _iter_events():
    if not EVENTS_FILE.exists():
        return
    try:
        with EVENTS_FILE.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    except OSError:
        return


def _hour_band(h: int) -> str:
    if 5 <= h < 8: return "early_morning"
    if 8 <= h < 12: return "morning"
    if 12 <= h < 14: return "midday"
    if 14 <= h < 17: return "afternoon"
    if 17 <= h < 20: return "evening"
    if 20 <= h < 23: return "night"
    return "late"


def extract_patterns() -> dict:
    events = list(_iter_events())
    n = len(events)
    if n < 3:
        # Not enough data — write empty so consumers know to fall back
        out = {"sessions": n, "ready": False}
        try:
            PATTERNS_DIR.mkdir(parents=True, exist_ok=True)
            with PATTERNS_FILE.open("w", encoding="utf-8") as f:
                json.dump(out, f, indent=2)
        except OSError:
            pass
        return out

    # Domain × (weekday, hour-band) histogram
    domain_by_slot: dict[tuple[str, str], Counter] = defaultdict(Counter)
    for e in events:
        slot = (e.get("weekday", ""), _hour_band(int(e.get("hour", 0))))
        domain_by_slot[slot][e.get("domain", "other")] += 1

    time_clusters: list[dict] = []
    for (wday, band), counter in domain_by_slot.items():
        total = sum(counter.values())
        if total < 3:
            continue
        top_domain, top_count = counter.most_common(1)[0]
        share = top_count / total
        if share >= 0.5 and top_domain != "other":
            time_clusters.append({
                "weekday": wday,
                "hour_band": band,
                "domain": top_domain,
                "share": round(share, 3),
                "n": total,
            })
    time_clusters.sort(key=lambda x: (-x["share"], -x["n"]))

    # Sequence pairs — what domain follows what, within a session?
    # We only have first_user_query per event, so we can't build inside-
    # session sequences from events alone. Build cross-session sequence:
    # domain at session N → domain at session N+1.
    pairs: Counter = Counter()
    for a, b in zip(events, events[1:]):
        pairs[(a.get("domain", "other"), b.get("domain", "other"))] += 1
    total_pairs = sum(pairs.values())
    sequence_pairs: list[dict] = []
    for (a_dom, b_dom), count in pairs.most_common(15):
        if a_dom == "other" or b_dom == "other":
            continue
        share = count / max(1, sum(c for (a, _), c in pairs.items() if a == a_dom))
        if share < 0.25 or count < 2:
            continue
        sequence_pairs.append({
            "after": a_dom,
            "next": b_dom,
            "share": round(share, 3),
            "n": count,
        })
    sequence_pairs.sort(key=lambda x: (-x["share"], -x["n"]))

    # Tool-hint usage histogram
    tool_counter: Counter = Counter()
    for e in events:
        for t in (e.get("tool_hints") or []):
            tool_counter[t] += 1

    out = {
        "sessions": n,
        "ready": True,
        "time_clusters": time_clusters[:10],
        "sequence_pairs": sequence_pairs[:10],
        "tool_hints": dict(tool_counter.most_common(10)),
        "extracted_at": datetime.now().isoformat(timespec="seconds"),
    }
    try:
        PATTERNS_DIR.mkdir(parents=True, exist_ok=True)
        with PATTERNS_FILE.open("w", encoding="utf-8") as f:
            json.dump(out, f, indent=2, ensure_ascii=False)
    except OSError:
        pass
    return out


def context_hint(now: datetime | None = None) -> str:
    """Return a one-line learned-pattern hint for the current weekday/hour
    combo, or '' when no strong pattern matches. Read by jarvis-context.py
    to replace the hardcoded morning/afternoon strings."""
    if os.environ.get("JARVIS_PATTERN_LEARN", "1") != "1":
        return ""
    if not PATTERNS_FILE.exists():
        return ""
    try:
        with PATTERNS_FILE.open() as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return ""
    if not data.get("ready"):
        return ""

    now = now or datetime.now().astimezone()
    wday = now.strftime("%A")
    band = _hour_band(now.hour)
    for tc in data.get("time_clusters") or []:
        if tc.get("weekday") == wday and tc.get("hour_band") == band:
            pct = int(tc.get("share", 0) * 100)
            return (
                f"Pattern: on {wday} {band.replace('_', ' ')}, you usually "
                f"work on {tc.get('domain')} ({pct}% of {tc.get('n')} sessions). "
                f"Lean into {tc.get('domain')}-related tools if relevant."
            )
    return ""


def _cli() -> int:
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        sys.stdout.write(__doc__ or "")
        return 0
    if args and args[0] == "--print":
        if PATTERNS_FILE.exists():
            print(PATTERNS_FILE.read_text())
        else:
            print("(no patterns extracted yet)")
        return 0
    if args and args[0] == "--reset":
        for p in (EVENTS_FILE, PATTERNS_FILE, LAST_SESSION_FILE):
            try:
                p.unlink()
            except FileNotFoundError:
                pass
        print("patterns reset")
        return 0
    if os.environ.get("JARVIS_PATTERN_LEARN", "1") != "1":
        return 0
    if args and args[0] == "extract":
        out = extract_patterns()
        print(json.dumps(out, indent=2, default=str))
        return 0
    # Default: log + maybe extract
    log_session()
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
