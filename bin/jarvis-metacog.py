#!/usr/bin/env python3
"""Meta-cognition — Jarvis tracks its own accuracy by domain.

Reads the conversation log + feedback signals and maintains a per-domain
attempt/correct count. From those, derives a confidence score per domain
and an overall calibration score (how often Jarvis's stated certainty
matched the actual outcome).

Domain classification is keyword-based — fast, deterministic, no API call.
A user query like "what's the time" lands in `time_queries`; "draft an
email to Dalton" lands in `email_drafting`; "how do I think about this
pricing question" lands in `strategic_thinking`.

Outputs:
  ~/.jarvis/metacognition/accuracy.json   rolling per-domain stats
  ~/.jarvis/metacognition/calibration.log line per session for trend view

system_prompt_hint() returns a behavioral block injected by jarvis-think.py
into _build_system_blocks. Below 0.7 confidence in a domain → tells Claude
to express uncertainty there. Above 0.9 → tells it to be direct.

Usage:
  bin/jarvis-metacog.py                    # process new turns + write
  bin/jarvis-metacog.py --print            # show current accuracy.json
  bin/jarvis-metacog.py --reset            # wipe (for debugging)

Gate: JARVIS_METACOG (default 1).
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Iterable

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
HISTORY_FILE = ASSISTANT_DIR / "cache" / "conversation.json"
METACOG_DIR = ASSISTANT_DIR / "metacognition"
ACCURACY_FILE = METACOG_DIR / "accuracy.json"
CHECKPOINT_FILE = METACOG_DIR / "last_processed.json"
CALIBRATION_LOG = METACOG_DIR / "calibration.log"

# Confidence bands. We only inject behavioral guidance into the system
# prompt when the domain has at least MIN_ATTEMPTS — early data is noise.
MIN_ATTEMPTS_FOR_HINT = int(os.environ.get("JARVIS_METACOG_MIN_ATTEMPTS", "5"))
LOW_CONFIDENCE_THRESHOLD = 0.7
HIGH_CONFIDENCE_THRESHOLD = 0.9

# ── Domain classifier (keyword-based) ────────────────────────────────
DOMAIN_PATTERNS = [
    ("time_queries", re.compile(r"\b(what time|the time|what'?s the date|today'?s date|what day|"
                                  r"how long until|how many (minutes|hours|days))\b", re.I)),
    ("email_drafting", re.compile(r"\b(email|reply|inbox|draft.*?email|send.*?email|"
                                    r"check.*?email|message.*?(from|to))\b", re.I)),
    ("scheduling", re.compile(r"\b(calendar|meeting|schedule|book|appointment|move my|"
                                r"cancel.*?meeting|when am i|what'?s on my)\b", re.I)),
    ("reminders_timers", re.compile(r"\b(remind me|set a timer|set a reminder|wake me|"
                                      r"countdown|alarm)\b", re.I)),
    ("memory_recall", re.compile(r"\b(remember when|do you remember|what did i (say|tell)|"
                                   r"who is|recall|did i mention)\b", re.I)),
    ("contact_lookup", re.compile(r"\b(who is|find.*?(person|contact)|phone number|"
                                    r"reach out to|when did i last)\b", re.I)),
    ("technical_questions", re.compile(r"\b(code|debug|api|function|class|repo|git|"
                                          r"deploy|build|test|stack trace|error|exception)\b", re.I)),
    ("strategic_thinking", re.compile(r"\b(should i|how (do|should) i|what'?s the best|"
                                        r"trade.?off|pros?\s+and\s+cons?|approach|strategy|"
                                        r"recommend|what do you think)\b", re.I)),
    ("emotional_support", re.compile(r"\b(stressed|tired|frustrated|anxious|overwhelmed|"
                                       r"i feel|i'?m feeling|can'?t sleep|need a break)\b", re.I)),
    ("casual_chat", re.compile(r"\b(how are you|good (morning|night|evening)|hey|hi|"
                                 r"thanks|thank you)\b", re.I)),
]


def classify_domain(text: str) -> str:
    if not text:
        return "other"
    for label, regex in DOMAIN_PATTERNS:
        if regex.search(text):
            return label
    return "other"


# ── Signal extraction (lightweight; we don't re-run jarvis-feedback) ─
POS_RE = re.compile(
    r"\b(perfect|exactly|yes|yeah|right|nice|love it|great|awesome|"
    r"that\'?s right|you got it)\b",
    re.I,
)
NEG_RE = re.compile(
    r"\b(no\b|wrong|nope|that\'?s not|not what i (meant|want|asked)|"
    r"you misunderstood|incorrect)\b",
    re.I,
)


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


def _load_accuracy() -> dict:
    if not ACCURACY_FILE.exists():
        return {"domains": {}, "calibration_score": 0.0}
    try:
        with ACCURACY_FILE.open() as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError
        data.setdefault("domains", {})
        return data
    except (json.JSONDecodeError, OSError, ValueError):
        return {"domains": {}, "calibration_score": 0.0}


def _save_accuracy(data: dict) -> None:
    try:
        METACOG_DIR.mkdir(parents=True, exist_ok=True)
        with ACCURACY_FILE.open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except OSError:
        pass


def _load_checkpoint() -> int:
    """Return the index of the last user turn we already processed.
    Prevents double-counting across runs."""
    if not CHECKPOINT_FILE.exists():
        return -1
    try:
        with CHECKPOINT_FILE.open(encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return -1
        return int(data.get("last_user_idx", -1))
    except (json.JSONDecodeError, OSError, ValueError):
        return -1


def _save_checkpoint(idx: int) -> None:
    try:
        METACOG_DIR.mkdir(parents=True, exist_ok=True)
        tmp = CHECKPOINT_FILE.with_suffix(CHECKPOINT_FILE.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump({"last_user_idx": idx, "ts": datetime.now().isoformat()}, f)
        os.replace(tmp, CHECKPOINT_FILE)
    except OSError:
        pass


def attribute_outcomes(messages: list[dict], from_idx: int = 0) -> list[tuple[str, bool]]:
    """For each user turn after `from_idx`, classify its domain and infer
    whether the response that followed was a hit or miss based on the next
    user turn's signal text. Returns [(domain, correct), ...] in order.

    Heuristic — a turn is `correct` when:
      - The next user turn contains an explicit positive signal, OR
      - The next user turn doesn't contain an explicit negative AND
        isn't a near-duplicate re-ask of the same query

    Coarse but it lines up well with the user's lived experience.
    """
    out: list[tuple[str, bool]] = []
    for i, m in enumerate(messages):
        if i <= from_idx or m.get("role") != "user":
            continue
        content = m.get("content")
        if not isinstance(content, str) or not content.strip():
            continue
        domain = classify_domain(content)

        # Find the next user turn after this one
        next_user = None
        for j in range(i + 1, len(messages)):
            nm = messages[j]
            if nm.get("role") == "user" and isinstance(nm.get("content"), str):
                next_user = nm["content"]
                break

        # If there's no next turn yet, skip — we can't judge an in-flight
        # response. The next run will process it.
        if next_user is None:
            break

        if NEG_RE.search(next_user):
            correct = False
        elif POS_RE.search(next_user):
            correct = True
        else:
            # Not a re-ask of the same content (>=70% word overlap) → call it correct
            cw = set(re.findall(r"[a-z0-9']+", content.lower()))
            nw = set(re.findall(r"[a-z0-9']+", next_user.lower()))
            overlap = len(cw & nw) / max(len(cw), 1)
            correct = overlap < 0.7
        out.append((domain, correct))
    return out


def update(messages: list[dict] | None = None) -> dict:
    """Process new turns (after the checkpoint) into accuracy.json. Returns
    the updated accuracy dict."""
    if messages is None:
        messages = _load_history_messages()
    if not messages:
        return _load_accuracy()

    last_idx = _load_checkpoint()
    new_outcomes = attribute_outcomes(messages, from_idx=last_idx)
    if not new_outcomes:
        return _load_accuracy()

    acc = _load_accuracy()
    for domain, correct in new_outcomes:
        d = acc["domains"].setdefault(domain, {"attempts": 0, "correct": 0})
        d["attempts"] += 1
        if correct:
            d["correct"] += 1
        d["confidence"] = round(d["correct"] / d["attempts"], 3)

    # Calibration: how aligned are the per-domain confidences with the
    # weighted overall accuracy? 1.0 = perfectly calibrated; 0 = uniformly
    # wrong about our own ability.
    total_attempts = sum(d["attempts"] for d in acc["domains"].values())
    if total_attempts > 0:
        weighted = sum(d["confidence"] * d["attempts"] for d in acc["domains"].values())
        acc["calibration_score"] = round(weighted / total_attempts, 3)

    # Find the new checkpoint = index of last user turn we attributed
    last_user_idx = -1
    for i, m in enumerate(messages):
        if m.get("role") == "user":
            last_user_idx = i
    # We only process turns whose NEXT user turn exists, so the checkpoint
    # is the second-to-last user turn — the last one didn't get a verdict.
    user_indices = [i for i, m in enumerate(messages) if m.get("role") == "user"]
    if len(user_indices) >= 2:
        new_checkpoint = user_indices[-2]
    else:
        new_checkpoint = last_idx
    _save_checkpoint(new_checkpoint)

    _save_accuracy(acc)
    _log_calibration(acc)
    return acc


def _log_calibration(acc: dict) -> None:
    try:
        METACOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().isoformat(timespec="seconds")
        with CALIBRATION_LOG.open("a", encoding="utf-8") as f:
            f.write(f"{ts}\tcalibration={acc.get('calibration_score', 0)}\t"
                    f"domains={len(acc.get('domains', {}))}\n")
    except OSError:
        pass


def system_prompt_hint() -> str:
    """Return a behavioral calibration block for the system prompt, or ''
    when there isn't enough data."""
    if os.environ.get("JARVIS_METACOG", "1") != "1":
        return ""
    acc = _load_accuracy()
    domains = acc.get("domains") or {}
    if not domains:
        return ""

    low: list[str] = []
    high: list[str] = []
    for name, d in domains.items():
        if d.get("attempts", 0) < MIN_ATTEMPTS_FOR_HINT:
            continue
        c = d.get("confidence", 0.0)
        pretty = name.replace("_", " ")
        if c < LOW_CONFIDENCE_THRESHOLD:
            low.append(f"{pretty} ({int(c * 100)}%)")
        elif c >= HIGH_CONFIDENCE_THRESHOLD:
            high.append(f"{pretty} ({int(c * 100)}%)")

    if not low and not high:
        return ""

    parts = ["## Self-Calibration"]
    if high:
        parts.append("Domains where you're reliably right — be direct, no hedging: " + ", ".join(high) + ".")
    if low:
        parts.append("Domains where you've been wrong before — express genuine uncertainty: " + ", ".join(low) + ".")
    cal = acc.get("calibration_score", 0.0)
    if cal:
        parts.append(f"Your stated confidence aligns with reality {int(cal * 100)}% of the time across all domains.")
    return "\n".join(parts).strip()


def domain_confidence(text: str) -> float:
    """Return the historical confidence for the domain of `text`. Used by
    jarvis-think.py to decide whether to fan out parallel streams. Returns
    1.0 (assume good) when no data."""
    if os.environ.get("JARVIS_METACOG", "1") != "1":
        return 1.0
    acc = _load_accuracy()
    domain = classify_domain(text)
    d = (acc.get("domains") or {}).get(domain)
    if not d or d.get("attempts", 0) < MIN_ATTEMPTS_FOR_HINT:
        return 1.0
    return float(d.get("confidence", 1.0))


def _cli() -> int:
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        sys.stdout.write(__doc__ or "")
        return 0
    if args and args[0] == "--print":
        print(json.dumps(_load_accuracy(), indent=2))
        return 0
    if args and args[0] == "--reset":
        for p in (ACCURACY_FILE, CHECKPOINT_FILE):
            try:
                p.unlink()
            except FileNotFoundError:
                pass
        print("metacog reset")
        return 0
    if os.environ.get("JARVIS_METACOG", "1") != "1":
        return 0
    update()
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
