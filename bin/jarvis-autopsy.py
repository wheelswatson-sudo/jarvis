#!/usr/bin/env python3
"""Failure autopsy — root-cause every miss and turn it into a learned fix.

For each failure signal in the conversation log (re-ask, interruption,
explicit negative, repair attempt), pull the local context (what user
said, what Jarvis said, what came next), classify the failure mode, and
generate a specific corrective fix.

Failure modes:
    stt_error        user corrected a word → STT misheard. Save the
                     misheard/correct word pair to the phonetic map.
    too_verbose      "[interrupted]" or short next-user reply → response
                     was longer than the context tolerated.
    wrong_answer     explicit negative ("no/wrong/incorrect") → factual
                     or reasoning error.
    missed_intent    user re-asked differently (>=50% but <90% overlap)
                     → first interpretation was wrong.
    too_slow        long latency between user end and Jarvis start
                     (rare to detect from text alone; flagged when feedback
                     marks an interruption AND assistant text is short).
    tone_mismatch    next user turn is curt + no positive signal →
                     possible emotional miss.

Outputs:
    ~/.jarvis/autopsies/autopsy_<unix_ts>.json   one per run, raw signals
    ~/.jarvis/autopsies/fixes.json               aggregated learned fixes
    ~/.jarvis/autopsies/phonetic.json            STT word-pair memory

system_prompt_hint() returns a "## Lessons Learned" block listing the
top-5 most frequent fix recommendations. Injected by jarvis-think.py.

Usage:
    bin/jarvis-autopsy.py                    process new turns + write
    bin/jarvis-autopsy.py --print            show fixes.json
    bin/jarvis-autopsy.py --reset            wipe all autopsy state

Gate: JARVIS_AUTOPSY (default 1).
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from collections import Counter
from datetime import datetime
from pathlib import Path

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
HISTORY_FILE = ASSISTANT_DIR / "cache" / "conversation.json"
AUTOPSY_DIR = ASSISTANT_DIR / "autopsies"
FIXES_FILE = AUTOPSY_DIR / "fixes.json"
PHONETIC_FILE = AUTOPSY_DIR / "phonetic.json"
CHECKPOINT_FILE = AUTOPSY_DIR / "last_processed.json"

POS_RE = re.compile(
    r"\b(perfect|exactly|yes|yeah|right|nice|love it|great|awesome)\b", re.I,
)
NEG_RE = re.compile(
    r"\b(no\b|wrong|nope|that\'?s not|not what i (meant|want|asked)|"
    r"you misunderstood|incorrect)\b", re.I,
)
INTERRUPT_RE = re.compile(r"\[interrupted\]")
# "you said X but I meant Y" / "no, I said Y" — explicit STT correction
STT_CORRECT_RE = re.compile(
    r"\b(?:you (?:said|heard) ['\"]?(?P<heard>[^'\".,!?]+?)['\"]?,? "
    r"(?:i|but i) (?:said|meant) ['\"]?(?P<meant>[^'\".,!?]+?)['\"]?\b|"
    r"(?:not|no\b) ['\"]?(?P<heard2>[^'\".,!?]+?)['\"]?,? ['\"]?(?P<meant2>[^'\".,!?]+?)['\"]?$)",
    re.I,
)
TONE_CURT_RE = re.compile(
    r"^\s*(fine|whatever|sure|ok\.?|okay\.?|forget it|never mind|moving on)\s*[.!]*\s*$", re.I,
)


def _word_set(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9']+", (text or "").lower()))


def _word_overlap(a: str, b: str) -> float:
    aw, bw = _word_set(a), _word_set(b)
    if not aw or not bw:
        return 0.0
    return len(aw & bw) / max(len(aw), len(bw))


def _word_count(t: str) -> int:
    return len(re.findall(r"\S+", t or ""))


def _load_history() -> list[dict]:
    if not HISTORY_FILE.exists():
        return []
    try:
        with HISTORY_FILE.open() as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return []
    if isinstance(data, dict):
        msgs = data.get("messages") or []
    elif isinstance(data, list):
        msgs = data
    else:
        return []
    return [m for m in msgs if isinstance(m, dict)
            and m.get("role") in ("user", "assistant")
            and isinstance(m.get("content"), str)]


def _load_checkpoint() -> int:
    if not CHECKPOINT_FILE.exists():
        return -1
    try:
        with CHECKPOINT_FILE.open() as f:
            return int(json.load(f).get("last_idx", -1))
    except (json.JSONDecodeError, OSError, ValueError):
        return -1


def _save_checkpoint(idx: int) -> None:
    try:
        AUTOPSY_DIR.mkdir(parents=True, exist_ok=True)
        with CHECKPOINT_FILE.open("w", encoding="utf-8") as f:
            json.dump({"last_idx": idx, "ts": datetime.now().isoformat()}, f)
    except OSError:
        pass


def _load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        with path.open() as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return default


def _write_json(path: Path, data) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except OSError:
        pass


def classify_failures(messages: list[dict], from_idx: int = 0) -> list[dict]:
    """Walk messages from `from_idx` and return failure records."""
    failures: list[dict] = []
    for i, m in enumerate(messages):
        if i <= from_idx:
            continue
        if m.get("role") != "assistant":
            continue
        assistant_text = m.get("content") or ""
        # Find the user turn before this and after this
        prior_user = None
        next_user = None
        for j in range(i - 1, -1, -1):
            if messages[j].get("role") == "user":
                prior_user = messages[j].get("content")
                break
        for j in range(i + 1, len(messages)):
            if messages[j].get("role") == "user":
                next_user = messages[j].get("content")
                break

        # ── Classification ──
        # Each branch is independent; an assistant turn can produce
        # multiple failure records (e.g. interrupted AND wrong).
        ts = time.time()

        if INTERRUPT_RE.search(assistant_text):
            words_before_cut = _word_count(assistant_text.split("[interrupted]")[0])
            failures.append({
                "ts": ts,
                "type": "too_verbose",
                "user": (prior_user or "")[:200],
                "assistant_preview": assistant_text[:200],
                "words_before_cut": words_before_cut,
                "fix": (
                    "Cap responses at "
                    f"~{max(20, min(80, words_before_cut))} words for "
                    "queries shaped like this; the user cuts you off otherwise."
                ),
            })

        if next_user is not None:
            # Explicit negative
            if NEG_RE.search(next_user) and not POS_RE.search(next_user):
                stt_match = STT_CORRECT_RE.search(next_user)
                if stt_match:
                    heard = (stt_match.group("heard") or stt_match.group("heard2") or "").strip()
                    meant = (stt_match.group("meant") or stt_match.group("meant2") or "").strip()
                    if heard and meant and heard.lower() != meant.lower():
                        failures.append({
                            "ts": ts,
                            "type": "stt_error",
                            "heard": heard,
                            "meant": meant,
                            "user": next_user[:200],
                            "fix": f"STT mishears {meant!r} as {heard!r} — store this pair.",
                        })
                else:
                    failures.append({
                        "ts": ts,
                        "type": "wrong_answer",
                        "user": (prior_user or "")[:200],
                        "user_correction": next_user[:200],
                        "assistant_preview": assistant_text[:200],
                        "fix": (
                            "Treat the correction in `user_correction` as a "
                            "high-priority fact; remember it via the memory tool."
                        ),
                    })

            # Missed intent — re-ask with partial overlap (50-90%)
            elif prior_user is not None and prior_user.strip():
                ov = _word_overlap(prior_user, next_user)
                if 0.5 <= ov < 0.9 and _word_count(next_user) >= 3:
                    failures.append({
                        "ts": ts,
                        "type": "missed_intent",
                        "user_first": prior_user[:200],
                        "user_rephrase": next_user[:200],
                        "fix": (
                            "First interpretation missed; the rephrasing pair "
                            "shows what part was unclear. Ask one clarifying "
                            "question for queries shaped like this."
                        ),
                    })

            # Tone mismatch — curt next reply, no positive, after a long answer
            if (TONE_CURT_RE.match(next_user)
                    and not POS_RE.search(next_user)
                    and _word_count(assistant_text) > 40):
                failures.append({
                    "ts": ts,
                    "type": "tone_mismatch",
                    "user": (prior_user or "")[:200],
                    "user_curt_reply": next_user.strip()[:120],
                    "fix": (
                        "Tone read failed — the user signaled disengagement "
                        "with a one-word reply. For queries like this, lead "
                        "with the bottom line and stop."
                    ),
                })
    return failures


def update_phonetic_memory(failures: list[dict]) -> dict:
    """Aggregate stt_error pairs into a persistent map. Used by future
    repair logic / system prompt hints."""
    pairs = _load_json(PHONETIC_FILE, {})
    if not isinstance(pairs, dict):
        pairs = {}
    for f in failures:
        if f.get("type") != "stt_error":
            continue
        heard = (f.get("heard") or "").lower().strip()
        meant = (f.get("meant") or "").lower().strip()
        if not heard or not meant:
            continue
        key = heard
        entry = pairs.get(key) or {"correct": meant, "count": 0, "last_seen": None}
        entry["correct"] = meant
        entry["count"] = int(entry.get("count", 0)) + 1
        entry["last_seen"] = datetime.now().isoformat(timespec="seconds")
        pairs[key] = entry
    _write_json(PHONETIC_FILE, pairs)
    return pairs


def update_fixes(failures: list[dict]) -> dict:
    """Aggregate fixes.json — counts per failure type + most recent fixes."""
    fixes = _load_json(FIXES_FILE, {"by_type": {}, "recent": []})
    if not isinstance(fixes, dict):
        fixes = {"by_type": {}, "recent": []}
    for f in failures:
        ftype = f.get("type", "unknown")
        bt = fixes.setdefault("by_type", {})
        bt[ftype] = int(bt.get(ftype, 0)) + 1
        # Keep last 50 raw records for the system prompt to draw from
        recent = fixes.setdefault("recent", [])
        recent.append({k: f[k] for k in ("ts", "type", "fix") if k in f})
        if len(recent) > 50:
            del recent[: len(recent) - 50]
    _write_json(FIXES_FILE, fixes)
    return fixes


def write_session(failures: list[dict]) -> Path | None:
    if not failures:
        return None
    try:
        AUTOPSY_DIR.mkdir(parents=True, exist_ok=True)
        path = AUTOPSY_DIR / f"autopsy_{int(time.time())}.json"
        with path.open("w", encoding="utf-8") as f:
            json.dump({"ts": time.time(), "failures": failures}, f,
                      indent=2, ensure_ascii=False)
        return path
    except OSError:
        return None


def update(messages: list[dict] | None = None) -> dict:
    if messages is None:
        messages = _load_history()
    if not messages:
        return _load_json(FIXES_FILE, {"by_type": {}, "recent": []})

    last_idx = _load_checkpoint()
    failures = classify_failures(messages, from_idx=last_idx)

    write_session(failures)
    update_phonetic_memory(failures)
    fixes = update_fixes(failures)

    # Checkpoint = last assistant turn we examined
    last_asst = -1
    for i, m in enumerate(messages):
        if m.get("role") == "assistant":
            last_asst = i
    _save_checkpoint(last_asst)
    return fixes


def system_prompt_hint(top_n: int = 5) -> str:
    if os.environ.get("JARVIS_AUTOPSY", "1") != "1":
        return ""
    fixes = _load_json(FIXES_FILE, {"by_type": {}, "recent": []})
    if not isinstance(fixes, dict):
        return ""

    by_type: dict = fixes.get("by_type") or {}
    if not by_type:
        return ""

    # Top failure types by frequency (a recurrent failure mode is the
    # most useful to surface).
    sorted_types = sorted(by_type.items(), key=lambda kv: kv[1], reverse=True)

    parts = ["## Lessons Learned"]
    type_descriptions = {
        "too_verbose": "Watson interrupts long replies — bias toward brevity.",
        "wrong_answer": "Past factual misses on this kind of query — verify before asserting.",
        "missed_intent": "First interpretations have missed before — confirm intent if ambiguous.",
        "tone_mismatch": "Long replies sometimes read as overbearing — lead with the bottom line.",
        "stt_error": "STT has misheard recurring words — see phonetic.json mappings.",
        "too_slow": "Pipeline latency was an issue — keep retrieval calls minimal.",
    }
    shown = 0
    for ftype, count in sorted_types:
        if shown >= top_n:
            break
        if count < 2:  # singletons aren't patterns yet
            continue
        desc = type_descriptions.get(ftype, f"Recurrent {ftype} failures.")
        parts.append(f"- {desc} ({count} occurrences)")
        shown += 1
    if shown == 0:
        return ""

    # Phonetic memory summary if non-empty
    phonetic = _load_json(PHONETIC_FILE, {})
    if isinstance(phonetic, dict) and phonetic:
        common = sorted(phonetic.items(), key=lambda kv: kv[1].get("count", 0), reverse=True)[:3]
        pairs = ", ".join(f"{h!r}→{e.get('correct')!r}" for h, e in common)
        parts.append(f"- STT corrections to keep in mind: {pairs}.")

    return "\n".join(parts).strip()


def _cli() -> int:
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        sys.stdout.write(__doc__ or "")
        return 0
    if args and args[0] == "--print":
        print(json.dumps(_load_json(FIXES_FILE, {}), indent=2))
        return 0
    if args and args[0] == "--reset":
        for p in (FIXES_FILE, PHONETIC_FILE, CHECKPOINT_FILE):
            try:
                p.unlink()
            except FileNotFoundError:
                pass
        print("autopsy reset")
        return 0
    if os.environ.get("JARVIS_AUTOPSY", "1") != "1":
        return 0
    update()
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
