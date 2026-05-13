#!/usr/bin/env python3
"""Meta-cognition — Jarvis tracks its own accuracy by domain.

Reads the conversation log + feedback signals and maintains per-domain
attempt/correct counts. From those, derives a confidence score per domain
and a true Expected Calibration Error (ECE) across the rolling history.

What's tracked
  - Multi-label domain classification — a turn can be email + calendar.
    Both domains get credit/blame instead of only the first regex hit.
  - Trinary outcomes — `correct | wrong | mixed`. "Mixed" is a positive
    reply that still partially redirects ("yes but also...").
  - Recency-weighted attempts via exponential decay over turn-distance.
    Old failures fade so the calibration tracks how Jarvis behaves *now*.
  - Wilson lower-bound for small-N confidence — fairer than raw p̂ when
    a domain has 1–3 data points.
  - Real calibration: stated confidence at *prediction time* vs observed
    outcome, bucketed for an ECE breakdown.

Side-channel logs (rolling, capped):
  predictions.jsonl   per-turn record used to replay ECE
  surprises.jsonl     turns whose outcome strongly disagreed with conf
  unclassified.jsonl  user texts that hit no domain regex (classifier TODO)
  recent_failures.json one short example per low-confidence domain

Outputs:
  ~/.jarvis/metacognition/accuracy.json   rolling per-domain stats
  ~/.jarvis/metacognition/calibration.log line per run for trend view

Public API consumed by jarvis-think.py — these signatures are stable:
  system_prompt_hint() -> str
    Behavioral block injected into Claude's system prompt. Includes a
    concrete failure quote for each low-confidence domain so Claude
    knows the *shape* of the weakness, not just the percentage.
  domain_confidence(text) -> float
    Worst-case Wilson lower-bound across matching domains. jarvis-think
    fans out parallel streams when this drops below 0.7.

Usage:
  bin/jarvis-metacog.py                    # process new turns + write
  bin/jarvis-metacog.py --print            # show current accuracy.json
  bin/jarvis-metacog.py --ece              # ECE breakdown by bucket
  bin/jarvis-metacog.py --surprises [N]    # tail recent surprises
  bin/jarvis-metacog.py --unclassified [N] # tail unclassified texts
  bin/jarvis-metacog.py --reset            # wipe (for debugging)

Gate: JARVIS_METACOG (default 1).
Tunables (env):
  JARVIS_METACOG_MIN_ATTEMPTS       hint threshold (default 5)
  JARVIS_METACOG_HALFLIFE_TURNS     decay half-life in turns (default 300)
  JARVIS_METACOG_SURPRISE_DELTA     |outcome−conf| to log a surprise (0.4)
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
HISTORY_FILE = ASSISTANT_DIR / "cache" / "conversation.json"
METACOG_DIR = ASSISTANT_DIR / "metacognition"
ACCURACY_FILE = METACOG_DIR / "accuracy.json"
CHECKPOINT_FILE = METACOG_DIR / "last_processed.json"
CALIBRATION_LOG = METACOG_DIR / "calibration.log"
PREDICTIONS_FILE = METACOG_DIR / "predictions.jsonl"
SURPRISES_FILE = METACOG_DIR / "surprises.jsonl"
UNCLASSIFIED_FILE = METACOG_DIR / "unclassified.jsonl"
RECENT_FAILURES_FILE = METACOG_DIR / "recent_failures.json"

# Confidence bands. We only inject behavioral guidance into the system
# prompt when the domain has at least MIN_ATTEMPTS — early data is noise.
MIN_ATTEMPTS_FOR_HINT = int(os.environ.get("JARVIS_METACOG_MIN_ATTEMPTS", "5"))
LOW_CONFIDENCE_THRESHOLD = 0.7
HIGH_CONFIDENCE_THRESHOLD = 0.9

# Exponential decay over turn-distance — older data weighs less. Default
# half-life of 300 turns means a turn from ~300 turns ago counts half as
# much as today. Messages don't carry timestamps so we use ordinal position.
HALFLIFE_TURNS = max(1.0, float(os.environ.get("JARVIS_METACOG_HALFLIFE_TURNS", "300")))
DECAY_LN2 = math.log(2)

# A turn whose outcome diverges from its stated confidence by this much
# gets written to surprises.jsonl for review.
SURPRISE_DELTA = float(os.environ.get("JARVIS_METACOG_SURPRISE_DELTA", "0.4"))

# Cap the on-disk replay log so it doesn't grow unbounded.
PREDICTIONS_WINDOW = int(os.environ.get("JARVIS_METACOG_WINDOW", "1000"))
SURPRISES_CAP = 200
UNCLASSIFIED_CAP = 500

# 10 equal-width buckets for the calibration histogram.
ECE_BUCKETS = 10

# ── Domain classifier (keyword-based, multi-label) ───────────────────
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


def classify_domains(text: str) -> list[str]:
    """Return ALL matching domain labels (multi-label), or ['other'] when
    nothing matches. A single turn can legitimately be email + scheduling."""
    if not text:
        return ["other"]
    hits = [label for label, regex in DOMAIN_PATTERNS if regex.search(text)]
    return hits or ["other"]


def classify_domain(text: str) -> str:
    """Backward-compat shim — returns just the first matching label."""
    return classify_domains(text)[0]


# ── Signal extraction (trinary: correct | wrong | mixed) ─────────────
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
# Amendments — user accepted part but is redirecting. "yes but also" /
# "right but" / "good but" / "also can you".
AMEND_RE = re.compile(
    r"\b(yes\s+but|but\s+also|and\s+also|also,?\s+(can|could)\s+you|"
    r"good\s+but|right\s+but|that\'?s\s+(good|right)\s+but|"
    r"actually,?\s+(can|could))\b",
    re.I,
)


def classify_outcome(prev_query: str, next_query: str) -> str:
    """Return 'correct' | 'wrong' | 'mixed'.

    Heuristic — read the *next* user turn:
      - explicit negative                       → wrong
      - high-overlap re-ask of the same query   → wrong (silent redo)
      - positive AND amendment / high overlap   → mixed
      - explicit amendment phrase               → mixed
      - explicit positive                       → correct
      - default                                 → correct
    """
    if NEG_RE.search(next_query):
        return "wrong"

    cw = set(re.findall(r"[a-z0-9']+", prev_query.lower()))
    nw = set(re.findall(r"[a-z0-9']+", next_query.lower()))
    overlap = len(cw & nw) / max(len(cw), 1)

    if POS_RE.search(next_query):
        if overlap >= 0.4 or AMEND_RE.search(next_query):
            return "mixed"
        return "correct"
    if AMEND_RE.search(next_query):
        return "mixed"
    if overlap >= 0.7:
        return "wrong"
    return "correct"


OUTCOME_VALUE = {"correct": 1.0, "wrong": 0.0, "mixed": 0.5}


# ── I/O helpers ──────────────────────────────────────────────────────
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
        return {"domains": {}, "calibration_ece": 0.0, "weighted_accuracy": 0.0}
    try:
        with ACCURACY_FILE.open() as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError
        data.setdefault("domains", {})
        return data
    except (json.JSONDecodeError, OSError, ValueError):
        return {"domains": {}, "calibration_ece": 0.0, "weighted_accuracy": 0.0}


def _save_accuracy(data: dict) -> None:
    try:
        METACOG_DIR.mkdir(parents=True, exist_ok=True)
        tmp = ACCURACY_FILE.with_suffix(ACCURACY_FILE.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, ACCURACY_FILE)
    except OSError:
        pass


def _load_checkpoint() -> int:
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


def _append_jsonl(path: Path, obj: dict, cap: int | None = None) -> None:
    try:
        METACOG_DIR.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
        if cap is None:
            return
        # Trim the file in-place to cap lines (cheap; rare path).
        try:
            with path.open(encoding="utf-8") as f:
                lines = f.readlines()
            if len(lines) > cap:
                with path.open("w", encoding="utf-8") as f:
                    f.writelines(lines[-cap:])
        except OSError:
            pass
    except OSError:
        pass


def _read_jsonl_tail(path: Path, n: int) -> list[dict]:
    if not path.exists():
        return []
    try:
        with path.open(encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return []
    out: list[dict] = []
    for ln in lines[-n:]:
        ln = ln.strip()
        if not ln:
            continue
        try:
            out.append(json.loads(ln))
        except json.JSONDecodeError:
            continue
    return out


# ── Math: decay + Wilson bound + ECE ─────────────────────────────────
def _decay_weight(turns_ago: int) -> float:
    """exp(-Δturns * ln2 / halflife). 0 turns ago → 1.0; halflife → 0.5."""
    if turns_ago <= 0:
        return 1.0
    return math.exp(-turns_ago * DECAY_LN2 / HALFLIFE_TURNS)


def _wilson_lower(successes: float, attempts: float, z: float = 1.96) -> float:
    """Wilson score interval lower bound.

    Why: with 1 attempt and 0 successes, naive p̂ = 0% says "definitely
    broken". Wilson lower says "could be anywhere up to ~94%". This stops
    Jarvis from declaring a domain catastrophic on a single coin flip.
    """
    if attempts <= 0:
        return 0.0
    p = successes / attempts
    denom = 1.0 + z * z / attempts
    centre = p + z * z / (2.0 * attempts)
    margin = z * math.sqrt(p * (1.0 - p) / attempts + z * z / (4.0 * attempts * attempts))
    return max(0.0, min(1.0, (centre - margin) / denom))


def _ece(predictions: list[dict], buckets: int = ECE_BUCKETS) -> tuple[float, list[dict]]:
    """Expected Calibration Error over `predictions`, each
    {stated_conf: float, outcome: float in [0,1]}.

    Buckets stated_conf into [0, 1/B), [1/B, 2/B), ..., [(B-1)/B, 1].
    Per bucket: gap = |mean(stated) − mean(outcome)|. ECE = sum over
    buckets of (count/total) * gap. Returns (ECE, per_bucket_table).
    """
    if not predictions:
        return 0.0, []
    bins: list[list[dict]] = [[] for _ in range(buckets)]
    for p in predictions:
        sc = max(0.0, min(0.99999, float(p.get("stated_conf", 0.0))))
        idx = int(sc * buckets)
        bins[idx].append(p)
    total = len(predictions)
    ece = 0.0
    table: list[dict] = []
    for i, b in enumerate(bins):
        if not b:
            continue
        avg_conf = sum(float(x["stated_conf"]) for x in b) / len(b)
        avg_acc = sum(float(x["outcome"]) for x in b) / len(b)
        gap = abs(avg_conf - avg_acc)
        ece += (len(b) / total) * gap
        table.append({
            "bucket": f"[{i/buckets:.1f}, {(i+1)/buckets:.1f})",
            "n": len(b),
            "avg_stated": round(avg_conf, 3),
            "avg_actual": round(avg_acc, 3),
            "gap": round(gap, 3),
        })
    return round(ece, 4), table


# ── Core: temporal replay over all messages ──────────────────────────
def _record_unclassified(text: str) -> None:
    _append_jsonl(UNCLASSIFIED_FILE, {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "text": text[:240],
    }, cap=UNCLASSIFIED_CAP)


def _replay(messages: list[dict]) -> tuple[dict, list[dict], list[dict], dict]:
    """Walk the conversation in order. For each user turn that has a
    follow-up user turn:
      1) classify its domains (multi-label)
      2) compute stated_conf per matching domain *as of just before this
         turn* (Wilson lower-bound of decay-weighted running stats)
      3) read the next user turn to derive an outcome value
      4) record the prediction(s) for ECE; update running stats; if the
         outcome strongly disagrees with the band, log a surprise.

    Returns (domains_dict, predictions_list, surprises_list, recent_failures).
    """
    # Per-domain running tallies with decay applied at scoring time.
    # We store the list of (turn_index, outcome_value) and apply decay on
    # demand — simple and lets us recompute exactly without floating drift.
    history: dict[str, list[tuple[int, float]]] = defaultdict(list)

    predictions: list[dict] = []
    surprises: list[dict] = []
    # Per low-confidence domain we keep the most recent failure quote so
    # the system prompt can show it.
    recent_failures: dict[str, str] = {}

    last_user_idx = -1
    for i, m in enumerate(messages):
        if m.get("role") != "user":
            continue
        content = m.get("content")
        if not isinstance(content, str) or not content.strip():
            continue

        # Look for the next user turn.
        next_user = None
        for j in range(i + 1, len(messages)):
            nm = messages[j]
            if nm.get("role") == "user" and isinstance(nm.get("content"), str):
                next_user = nm["content"]
                break
        if next_user is None:
            break  # nothing after — can't judge this turn yet

        domains = classify_domains(content)
        if domains == ["other"]:
            # Capture so the classifier can grow.
            _record_unclassified(content)

        label = classify_outcome(content, next_user)
        outcome = OUTCOME_VALUE[label]

        # Per-domain stated_conf *before* this turn lands.
        for d in domains:
            entries = history[d]
            if entries:
                weighted_n = 0.0
                weighted_c = 0.0
                for (t, v) in entries:
                    w = _decay_weight(i - t)
                    weighted_n += w
                    weighted_c += w * v
                stated = _wilson_lower(weighted_c, weighted_n)
            else:
                stated = 1.0  # no prior data — assume good (matches old API)

            predictions.append({
                "turn": i,
                "domain": d,
                "stated_conf": round(stated, 4),
                "outcome": outcome,
                "label": label,
            })

            # Surprise — outcome strongly disagrees with stated band.
            if abs(stated - outcome) >= SURPRISE_DELTA and len(entries) >= 2:
                surprises.append({
                    "ts": datetime.now().isoformat(timespec="seconds"),
                    "turn": i,
                    "domain": d,
                    "stated_conf": round(stated, 3),
                    "outcome": outcome,
                    "label": label,
                    "user_text": content[:200],
                })

            # Update running history for downstream turns.
            history[d].append((i, outcome))

            # Track most recent failure-quote per domain.
            if outcome <= 0.5:
                recent_failures[d] = content[:120].strip()

        last_user_idx = i

    # Build the domains summary used by accuracy.json: decay-weighted
    # attempts + Wilson lower-bound as the canonical "confidence".
    domains_out: dict[str, dict] = {}
    final_idx = len(messages) - 1
    for d, entries in history.items():
        weighted_n = 0.0
        weighted_c = 0.0
        raw_n = len(entries)
        raw_c = sum(1 for (_, v) in entries if v >= 1.0)
        for (t, v) in entries:
            w = _decay_weight(final_idx - t)
            weighted_n += w
            weighted_c += w * v
        domains_out[d] = {
            "attempts": raw_n,
            "correct": raw_c,
            "eff_attempts": round(weighted_n, 3),
            "eff_correct": round(weighted_c, 3),
            "confidence": round(_wilson_lower(weighted_c, weighted_n), 3),
            "point_estimate": round(weighted_c / weighted_n, 3) if weighted_n else 0.0,
        }
    return domains_out, predictions, surprises, recent_failures


# ── Public entry point: update ───────────────────────────────────────
def update(messages: list[dict] | None = None) -> dict:
    """Process the full conversation log (cheap; bounded by checkpoint
    for the JSONL append path) and rewrite accuracy.json.

    Note: with multi-label classification we now do a full temporal
    replay each run rather than diffing from a checkpoint. The cost is
    O(N · domains) where N is total user turns — measured in milliseconds
    on Watson's typical history.
    """
    if messages is None:
        messages = _load_history_messages()
    if not messages:
        return _load_accuracy()

    domains_out, predictions, surprises, recent_failures = _replay(messages)
    if not predictions:
        return _load_accuracy()

    # Trim predictions to a rolling window.
    if len(predictions) > PREDICTIONS_WINDOW:
        predictions = predictions[-PREDICTIONS_WINDOW:]

    ece_value, ece_table = _ece(predictions)

    # Weighted accuracy (the old "calibration_score" semantics) is still
    # useful as a baseline number, so keep it under its real name.
    weighted_acc = 0.0
    total_eff = sum(d["eff_attempts"] for d in domains_out.values())
    if total_eff > 0:
        weighted_acc = sum(d["point_estimate"] * d["eff_attempts"]
                           for d in domains_out.values()) / total_eff

    acc = {
        "domains": domains_out,
        "weighted_accuracy": round(weighted_acc, 3),
        "calibration_ece": ece_value,
        "ece_table": ece_table,
        "predictions_n": len(predictions),
        "updated_at": datetime.now().isoformat(timespec="seconds"),
    }
    _save_accuracy(acc)

    # Persist side-channel logs (incrementally — only new lines).
    _write_predictions_window(predictions)
    for s in surprises[-50:]:
        _append_jsonl(SURPRISES_FILE, s, cap=SURPRISES_CAP)
    _save_recent_failures(recent_failures)

    # Update checkpoint to the last fully-judged user turn.
    user_indices = [i for i, m in enumerate(messages) if m.get("role") == "user"]
    if len(user_indices) >= 2:
        _save_checkpoint(user_indices[-2])

    _log_calibration(acc)
    return acc


def _write_predictions_window(predictions: list[dict]) -> None:
    """Rewrite predictions.jsonl with the rolling window (small file)."""
    try:
        METACOG_DIR.mkdir(parents=True, exist_ok=True)
        tmp = PREDICTIONS_FILE.with_suffix(PREDICTIONS_FILE.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            for p in predictions:
                f.write(json.dumps(p, ensure_ascii=False) + "\n")
        os.replace(tmp, PREDICTIONS_FILE)
    except OSError:
        pass


def _save_recent_failures(rf: dict) -> None:
    try:
        METACOG_DIR.mkdir(parents=True, exist_ok=True)
        with RECENT_FAILURES_FILE.open("w", encoding="utf-8") as f:
            json.dump(rf, f, indent=2, ensure_ascii=False)
    except OSError:
        pass


def _load_recent_failures() -> dict:
    if not RECENT_FAILURES_FILE.exists():
        return {}
    try:
        with RECENT_FAILURES_FILE.open() as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _log_calibration(acc: dict) -> None:
    try:
        METACOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().isoformat(timespec="seconds")
        with CALIBRATION_LOG.open("a", encoding="utf-8") as f:
            f.write(
                f"{ts}\tece={acc.get('calibration_ece', 0)}\t"
                f"weighted_acc={acc.get('weighted_accuracy', 0)}\t"
                f"domains={len(acc.get('domains', {}))}\t"
                f"n_pred={acc.get('predictions_n', 0)}\n"
            )
    except OSError:
        pass


# ── Public entry points consumed by jarvis-think.py ──────────────────
def system_prompt_hint() -> str:
    """Behavioral calibration block for the system prompt.

    Low-confidence domains get a concrete recent failure quote so Claude
    knows the shape of the weakness, not just the percentage.
    """
    if os.environ.get("JARVIS_METACOG", "1") != "1":
        return ""
    acc = _load_accuracy()
    domains = acc.get("domains") or {}
    if not domains:
        return ""
    recent_fail = _load_recent_failures()

    low: list[str] = []
    high: list[str] = []
    for name, d in domains.items():
        if name == "other":
            continue  # unactionable label — Claude can't reason about "other"
        if d.get("attempts", 0) < MIN_ATTEMPTS_FOR_HINT:
            continue
        c = d.get("confidence", 0.0)
        pretty = name.replace("_", " ")
        if c < LOW_CONFIDENCE_THRESHOLD:
            example = recent_fail.get(name, "").strip()
            suffix = f' — last miss: "{example[:80]}"' if example else ""
            low.append(f"{pretty} ({int(c * 100)}%{suffix})")
        elif c >= HIGH_CONFIDENCE_THRESHOLD:
            high.append(f"{pretty} ({int(c * 100)}%)")

    if not low and not high:
        return ""

    parts = ["## Self-Calibration"]
    if high:
        parts.append("Domains where you're reliably right — be direct, no hedging: "
                     + "; ".join(high) + ".")
    if low:
        parts.append("Domains where you've been wrong before — express genuine uncertainty "
                     "and ask clarifying questions before acting: " + "; ".join(low) + ".")
    ece = acc.get("calibration_ece", 0.0)
    if ece:
        # ECE = avg gap between stated confidence and observed accuracy.
        # Lower is better; 0.0 = perfectly calibrated.
        parts.append(f"Across all domains, your stated confidence and actual outcomes "
                     f"differ by ~{int(ece * 100)} points on average (lower = better).")
    return "\n".join(parts).strip()


def domain_confidence(text: str) -> float:
    """Historical confidence for the domain(s) of `text`. With multi-label
    classification we return the WORST (lowest) confidence across matching
    domains — that's the conservative read jarvis-think wants when deciding
    whether to fan out parallel streams. Returns 1.0 when no data."""
    if os.environ.get("JARVIS_METACOG", "1") != "1":
        return 1.0
    acc = _load_accuracy()
    matched = classify_domains(text)
    confs: list[float] = []
    for d in matched:
        entry = (acc.get("domains") or {}).get(d)
        if not entry or entry.get("attempts", 0) < MIN_ATTEMPTS_FOR_HINT:
            continue
        confs.append(float(entry.get("confidence", 1.0)))
    if not confs:
        return 1.0
    return min(confs)


# ── CLI ──────────────────────────────────────────────────────────────
def _cli() -> int:
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        sys.stdout.write(__doc__ or "")
        return 0
    if args and args[0] == "--print":
        print(json.dumps(_load_accuracy(), indent=2))
        return 0
    if args and args[0] == "--ece":
        acc = _load_accuracy()
        print(f"ECE: {acc.get('calibration_ece', 0)}  "
              f"(n={acc.get('predictions_n', 0)} predictions)")
        for row in acc.get("ece_table") or []:
            print(f"  {row['bucket']:14}  n={row['n']:4}  "
                  f"stated={row['avg_stated']:.3f}  actual={row['avg_actual']:.3f}  "
                  f"gap={row['gap']:.3f}")
        return 0
    if args and args[0] == "--surprises":
        n = int(args[1]) if len(args) > 1 else 20
        for row in _read_jsonl_tail(SURPRISES_FILE, n):
            print(f"{row.get('ts', '?')}  {row.get('domain', '?'):22}  "
                  f"stated={row.get('stated_conf', 0):.2f}  "
                  f"outcome={row.get('outcome', 0):.1f}  "
                  f"{row.get('label', '?'):8}  {row.get('user_text', '')[:80]!r}")
        return 0
    if args and args[0] == "--unclassified":
        n = int(args[1]) if len(args) > 1 else 30
        for row in _read_jsonl_tail(UNCLASSIFIED_FILE, n):
            print(f"{row.get('ts', '?')}  {row.get('text', '')[:140]!r}")
        return 0
    if args and args[0] == "--reset":
        for p in (ACCURACY_FILE, CHECKPOINT_FILE, PREDICTIONS_FILE,
                  SURPRISES_FILE, UNCLASSIFIED_FILE, RECENT_FAILURES_FILE):
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
