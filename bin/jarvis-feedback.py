#!/usr/bin/env python3
"""Self-improving feedback loop — analyze conversations, auto-tune behavior.

Reads the rolling conversation history at ~/.jarvis/cache/conversation.json
(this is the actual on-disk location; the convention is one file rolling
through all turns, with a summary memo for older content). Detects signals:

  - re-asks         user asked the same thing twice → repair/clarity miss
  - interruptions   "[interrupted]" markers in assistant turns → too long
  - disengagement   short user turn after long Jarvis turn → too verbose
  - explicit -      "no", "wrong", "that's not what I meant" → miss
  - explicit +      "perfect", "exactly", "yes" → hit

Outputs:
  ~/.jarvis/feedback/session_<unix_ts>.json   — raw signals from this run
  ~/.jarvis/feedback/profile.json             — rolling aggregate

Usage:
  bin/jarvis-feedback.py                  # analyze + write
  bin/jarvis-feedback.py --print          # print profile.json to stdout
  bin/jarvis-feedback.py --reset          # wipe profile.json (debugging)

Designed to be invoked detached from wake-listener.py when conversation
mode exits, so the user pays no latency for analysis.

Gate: JARVIS_SELF_IMPROVE (default 1). Disabled = exit 0 silently.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Iterable

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
HISTORY_FILE = ASSISTANT_DIR / "cache" / "conversation.json"
FEEDBACK_DIR = ASSISTANT_DIR / "feedback"
PROFILE_FILE = FEEDBACK_DIR / "profile.json"

# Window: only analyze the most recent N turns. Older turns have already
# been aggregated into the profile and re-analyzing them would double-count.
ANALYSIS_WINDOW = int(os.environ.get("JARVIS_FEEDBACK_WINDOW", "30"))

# Profile only emits behavioral tuning into the system prompt once we have
# this many sessions of data — early signals are too noisy to act on.
MIN_SESSIONS_FOR_HINT = int(os.environ.get("JARVIS_FEEDBACK_MIN_SESSIONS", "5"))

POS_RE = re.compile(
    r"\b(perfect|exactly|yes|yeah|right|nice|love it|great|awesome|"
    r"that\'?s right|you got it)\b",
    re.I,
)
NEG_RE = re.compile(
    r"\b(no\b|wrong|nope|that\'?s not|not what i (meant|want|asked)|"
    r"you misunderstood|never mind|forget it|incorrect)\b",
    re.I,
)
INTERRUPT_RE = re.compile(r"\[interrupted\]")
DISENGAGE_USER_WORDS = 3            # "k.", "ok.", "sure" → disengaged
DISENGAGE_PRIOR_ASSISTANT_WORDS = 60  # only counts after a long-ish reply
REASK_OVERLAP = 0.7                 # cosine-ish word overlap to call it a repeat


def _word_set(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9']+", (text or "").lower()))


def _word_overlap(a: str, b: str) -> float:
    aw, bw = _word_set(a), _word_set(b)
    if not aw or not bw:
        return 0.0
    return len(aw & bw) / max(len(aw), len(bw))


def _word_count(text: str) -> int:
    return len(re.findall(r"\S+", text or ""))


def _load_history() -> list[dict]:
    if not HISTORY_FILE.exists():
        return []
    try:
        with HISTORY_FILE.open() as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return []
    if isinstance(data, list):
        msgs = data
    elif isinstance(data, dict):
        msgs = data.get("messages") or []
    else:
        return []
    return [m for m in msgs if isinstance(m, dict) and m.get("role") in ("user", "assistant")]


def analyze(messages: list[dict]) -> dict:
    """Return raw signals from this window."""
    window = messages[-ANALYSIS_WINDOW:] if len(messages) > ANALYSIS_WINDOW else list(messages)

    reasks = 0
    interruptions = 0
    disengagements = 0
    pos_hits = 0
    neg_hits = 0

    # For preferred-length: average assistant word count immediately before
    # an explicit positive signal.
    lengths_before_pos: list[int] = []
    # For verbosity: ratio of (assistant words) → (next user words). Big
    # ratios after long replies = disengagement signal.
    verbosity_signals: list[float] = []

    prior_user: list[str] = []
    last_assistant_words = 0

    for i, m in enumerate(window):
        role = m.get("role")
        content = (m.get("content") or "")
        if not isinstance(content, str):
            # Tool round-trips serialize as lists; skip.
            continue

        if role == "user":
            uw = _word_count(content)

            # Re-ask check vs prior user turns
            for past in prior_user[-3:]:
                if _word_overlap(content, past) >= REASK_OVERLAP and uw >= 2:
                    reasks += 1
                    break

            # Disengagement check — short reply right after a long assistant
            if uw <= DISENGAGE_USER_WORDS and last_assistant_words >= DISENGAGE_PRIOR_ASSISTANT_WORDS:
                disengagements += 1

            # Explicit signals
            if POS_RE.search(content):
                pos_hits += 1
                if last_assistant_words > 0:
                    lengths_before_pos.append(last_assistant_words)
            if NEG_RE.search(content):
                neg_hits += 1

            # Verbosity ratio (only if both sides have content)
            if last_assistant_words > 0 and uw > 0:
                verbosity_signals.append(last_assistant_words / max(uw, 1))

            prior_user.append(content)
            last_assistant_words = 0  # consumed

        elif role == "assistant":
            last_assistant_words = _word_count(content)
            if INTERRUPT_RE.search(content):
                interruptions += 1

    # Aggregate scores for this session
    avg_pref = (sum(lengths_before_pos) / len(lengths_before_pos)) if lengths_before_pos else 0
    # verbosity_score: -1 (too verbose) to +1 (too concise)
    # Rough heuristic: every interruption / disengagement / negative pulls
    # toward "too verbose"; every positive on a short reply pulls toward
    # "could afford to be longer." Bounded at ±1.
    raw = -interruptions - disengagements - 0.5 * neg_hits + 0.3 * pos_hits
    # Normalize by total turns so noisy long sessions don't dominate
    bound = max(2, len(window))
    verbosity_score = max(-1.0, min(1.0, raw / bound))

    repair_attempts = max(1, reasks)
    # Treat a positive signal within 2 turns of a re-ask as a repair success
    repair_successes = 0
    for i, m in enumerate(window):
        if m.get("role") != "user":
            continue
        if not any(_word_overlap(m.get("content", ""), p) >= REASK_OVERLAP for p in prior_user[:i]):
            continue
        # Look ahead 2 turns for positive feedback
        for j in range(i + 1, min(i + 3, len(window))):
            if window[j].get("role") == "user" and POS_RE.search(window[j].get("content", "")):
                repair_successes += 1
                break
    repair_rate = repair_successes / repair_attempts if reasks else 1.0

    return {
        "ts": time.time(),
        "window_size": len(window),
        "reasks": reasks,
        "interruptions": interruptions,
        "disengagements": disengagements,
        "positive_signals": pos_hits,
        "negative_signals": neg_hits,
        "preferred_response_length": round(avg_pref, 1),
        "verbosity_score": round(verbosity_score, 3),
        "repair_success_rate": round(repair_rate, 3),
    }


def write_session(signals: dict) -> Path | None:
    try:
        FEEDBACK_DIR.mkdir(parents=True, exist_ok=True)
        path = FEEDBACK_DIR / f"session_{int(signals['ts'])}.json"
        with path.open("w", encoding="utf-8") as f:
            json.dump(signals, f, indent=2, ensure_ascii=False)
        return path
    except OSError:
        return None


def _load_profile() -> dict:
    if not PROFILE_FILE.exists():
        return {"sessions": 0, "verbosity_ema": 0.0,
                "preferred_length_ema": 0.0, "repair_rate_ema": 0.0}
    try:
        with PROFILE_FILE.open() as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"sessions": 0, "verbosity_ema": 0.0,
                    "preferred_length_ema": 0.0, "repair_rate_ema": 0.0}
        return data
    except (json.JSONDecodeError, OSError):
        return {"sessions": 0, "verbosity_ema": 0.0,
                "preferred_length_ema": 0.0, "repair_rate_ema": 0.0}


def update_profile(signals: dict) -> dict:
    """Exponential moving average — recent sessions weighted more than old."""
    profile = _load_profile()
    alpha = 0.3  # smoothing factor — half-life ~2 sessions
    profile["sessions"] = int(profile.get("sessions", 0)) + 1

    def ema(prev_key: str, new_value: float) -> float:
        prev = float(profile.get(prev_key, 0.0))
        return alpha * new_value + (1 - alpha) * prev

    profile["verbosity_ema"] = round(ema("verbosity_ema", signals["verbosity_score"]), 3)
    if signals["preferred_response_length"] > 0:
        profile["preferred_length_ema"] = round(
            ema("preferred_length_ema", signals["preferred_response_length"]), 1
        )
    profile["repair_rate_ema"] = round(ema("repair_rate_ema", signals["repair_success_rate"]), 3)
    profile["last_session_ts"] = signals["ts"]

    try:
        FEEDBACK_DIR.mkdir(parents=True, exist_ok=True)
        with PROFILE_FILE.open("w", encoding="utf-8") as f:
            json.dump(profile, f, indent=2, ensure_ascii=False)
    except OSError:
        pass
    return profile


def system_prompt_hint() -> str:
    """Return a one-paragraph behavioral tuning block, or '' when there
    isn't enough data yet. Read by jarvis-think.py and injected into the
    system prompt when JARVIS_SELF_IMPROVE=1."""
    if os.environ.get("JARVIS_SELF_IMPROVE", "1") != "1":
        return ""
    profile = _load_profile()
    if int(profile.get("sessions", 0)) < MIN_SESSIONS_FOR_HINT:
        return ""

    parts: list[str] = ["## Behavioral Calibration\n"]
    pref_len = float(profile.get("preferred_length_ema", 0.0))
    verbosity = float(profile.get("verbosity_ema", 0.0))

    if pref_len > 0:
        target = max(20, min(120, int(pref_len)))
        parts.append(f"Watson's positive-feedback turns averaged ~{target} words. Aim for that length when possible — direct answers, no padding.")

    if verbosity < -0.2:
        parts.append("Recent feedback skews toward 'too verbose' — be tighter than usual; trust Watson to ask follow-ups.")
    elif verbosity > 0.2:
        parts.append("Recent feedback skews toward 'too terse' — Watson tolerates a sentence more of context where it earns its keep.")

    if float(profile.get("repair_rate_ema", 1.0)) < 0.6:
        parts.append("Repair rate is low — when Watson re-asks, restate your answer plainly and ask what part wasn't right rather than re-explaining the same way.")

    if len(parts) == 1:  # only the heading was added
        return ""
    return "\n".join(parts).strip()


def _cli() -> int:
    args = sys.argv[1:]
    if args and args[0] == "--help":
        sys.stdout.write(__doc__ or "")
        return 0
    if args and args[0] == "--print":
        print(json.dumps(_load_profile(), indent=2))
        return 0
    if args and args[0] == "--reset":
        try:
            PROFILE_FILE.unlink()
            print("profile reset")
        except FileNotFoundError:
            print("(no profile to reset)")
        return 0

    if os.environ.get("JARVIS_SELF_IMPROVE", "1") != "1":
        return 0

    messages = _load_history()
    if not messages:
        return 0
    signals = analyze(messages)
    write_session(signals)
    profile = update_profile(signals)
    if "--verbose" in args or os.environ.get("JARVIS_FEEDBACK_DEBUG") == "1":
        print(json.dumps({"signals": signals, "profile": profile}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
