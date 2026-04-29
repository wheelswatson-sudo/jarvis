#!/usr/bin/env python3
"""Network intelligence — Watson's professional graph as a queryable system.

jarvis-contacts answers "what do I know about this person." This module
answers everything one rung up: who can do what, how strong is the bond,
who is the right ally for this goal, who knows whom, and what is going
quiet that should not be.

It augments — it does not replace — `~/.jarvis/contacts/people.json`.
Every contact record gets a set of network-only fields filled in lazily:

    skills                  list[str] — extracted from chat history
    expertise_areas         list[str] — broader domains
    can_intro_to            list[{name, context}] — who they could intro to
    relationship_strength   float in [0,1] — composite signal (see below)
    trust_level             "inner_circle" | "trusted" | "professional"
                            | "acquaintance" | "cold"
    interaction_history     {email, telegram, social} → {count, topics,
                            sentiment, avg_chars}
    network_position        {mutual_contacts, groups_shared, connector_score}
    tags                    list[str] — user-applied or Haiku-derived
    network_notes           list[str] — network-only notes (separate from
                            the existing per-contact notes field so this
                            module doesn't churn the human-curated list)

Strength formula (configurable via env):

    strength = 0.4·frequency + 0.3·recency + 0.2·depth + 0.1·reciprocity

  frequency   log-scaled normalized interaction count
  recency     exp decay over the last_interaction (30-day half-life)
  depth       message-length & topic-diversity blend
  reciprocity balance of Watson-out vs other-in messages, penalty if lopsided

Six public tools (all return JSON-serializable dicts so jarvis-think.py can
register them as Anthropic tools):

    network_search(query, filters=None, limit=8)
    network_map(focus=None)
    relationship_score(name)
    network_suggest(goal)
    enrich_network(force=False)
    network_alerts()

CLI mirrors the public API. See `jarvis-network --help`.

Gate: JARVIS_NETWORK=1 (default).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
BIN_DIR = ASSISTANT_DIR / "bin"
LIB_DIR = ASSISTANT_DIR / "lib"
CONTACTS_DIR = ASSISTANT_DIR / "contacts"
PEOPLE_FILE = CONTACTS_DIR / "people.json"
LOG_DIR = ASSISTANT_DIR / "logs"
NETWORK_LOG = LOG_DIR / "network.log"
STATE_DIR = ASSISTANT_DIR / "state"
ALERTS_FILE = STATE_DIR / "network-alerts.json"

ENRICH_INTERVAL_S = int(os.environ.get("JARVIS_NETWORK_REFRESH_S", str(7 * 86400)))
SKILL_MODEL = os.environ.get("JARVIS_NETWORK_MODEL", "claude-haiku-4-5-20251001")
SUGGEST_MODEL = os.environ.get("JARVIS_NETWORK_SUGGEST_MODEL", "claude-sonnet-4-6")

STRENGTH_W_FREQ = float(os.environ.get("JARVIS_NETWORK_W_FREQ", "0.4"))
STRENGTH_W_RECENCY = float(os.environ.get("JARVIS_NETWORK_W_RECENCY", "0.3"))
STRENGTH_W_DEPTH = float(os.environ.get("JARVIS_NETWORK_W_DEPTH", "0.2"))
STRENGTH_W_RECIPROCITY = float(os.environ.get("JARVIS_NETWORK_W_RECIPROCITY", "0.1"))

TRUST_THRESHOLDS = {
    "inner_circle":  0.85,
    "trusted":       0.65,
    "professional":  0.40,
    "acquaintance":  0.15,
}

# Hard-override relationship labels — anyone tagged this way gets bumped to
# inner_circle regardless of measured signal volume.
INNER_CIRCLE_RELATIONSHIPS = {
    "spouse", "partner", "wife", "husband",
    "co-founder", "cofounder", "co founder",
    "best friend",
}

FADE_DAYS = {
    "inner_circle": 14,
    "trusted":      30,
    "professional": 90,
}


# ── logging + gate ────────────────────────────────────────────────────
def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with NETWORK_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def _gate_check() -> dict | None:
    if os.environ.get("JARVIS_NETWORK", "1") != "1":
        return {"error": "network intelligence disabled (JARVIS_NETWORK=0)"}
    return None


# ── module loaders ────────────────────────────────────────────────────
def _load_module(mod_id: str, filename: str, search_dirs: list[Path]) -> Any:
    for d in search_dirs:
        src = d / filename
        if src.exists():
            try:
                spec = importlib.util.spec_from_file_location(mod_id, src)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)  # type: ignore[union-attr]
                return mod
            except Exception as e:
                _log(f"load {filename} failed: {e}")
                return None
    return None


_BIN_SEARCH = [BIN_DIR, Path(__file__).parent]
_LIB_SEARCH = [LIB_DIR, Path(__file__).parent.parent / "lib"]

_cache: dict[str, Any] = {}


def _contacts():
    if "contacts" not in _cache:
        _cache["contacts"] = _load_module("jarvis_contacts_for_network",
                                          "jarvis-contacts.py", _BIN_SEARCH)
    return _cache["contacts"]


def _telegram():
    if "telegram" not in _cache:
        _cache["telegram"] = _load_module("jarvis_telegram_for_network",
                                          "jarvis-telegram.py", _BIN_SEARCH)
    return _cache["telegram"]


def _primitive():
    if "primitive" not in _cache:
        _cache["primitive"] = _load_module("primitive", "primitive.py", _LIB_SEARCH)
    return _cache["primitive"]


def _emit(action: str, status: str, **ctx) -> None:
    p = _primitive()
    if p is None:
        return
    try:
        p.emit(cap="network", action=action, status=status, context=ctx)
    except Exception:
        pass


# ── people-file I/O (delegates to jarvis-contacts to stay single-source) ─
def _load_people() -> dict:
    mod = _contacts()
    if mod is not None:
        try:
            return mod._load_people()  # type: ignore[attr-defined]
        except Exception:
            pass
    if not PEOPLE_FILE.exists():
        return {}
    try:
        data = json.loads(PEOPLE_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_people(data: dict) -> None:
    mod = _contacts()
    if mod is not None:
        try:
            mod._save_people(data)  # type: ignore[attr-defined]
            return
        except Exception:
            pass
    CONTACTS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = PEOPLE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, PEOPLE_FILE)


# ── network field defaults — additive, does NOT touch existing fields ─
def _ensure_network_fields(rec: dict) -> dict:
    """Fill missing network-only fields with defaults. Idempotent — never
    overwrites existing values. Returns rec for chaining."""
    rec.setdefault("skills", [])
    rec.setdefault("expertise_areas", [])
    rec.setdefault("can_intro_to", [])
    rec.setdefault("relationship_strength", 0.0)
    rec.setdefault("trust_level", "cold")
    rec.setdefault("interaction_history", {
        "email":    {"count": 0, "topics": [], "sentiment": "neutral", "avg_chars": 0},
        "telegram": {"count": 0, "topics": [], "sentiment": "neutral", "avg_chars": 0},
        "social":   {"count": 0, "topics": [], "sentiment": "neutral", "avg_chars": 0},
    })
    # Backfill missing channel sub-records on older entries.
    ih = rec["interaction_history"]
    for ch in ("email", "telegram", "social"):
        ih.setdefault(ch, {"count": 0, "topics": [], "sentiment": "neutral", "avg_chars": 0})
    rec.setdefault("network_position", {
        "mutual_contacts": [], "groups_shared": [], "connector_score": 0.0,
    })
    rec.setdefault("tags", [])
    rec.setdefault("network_notes", [])
    rec.setdefault("network_enriched_at", None)
    return rec


# ── strength components ───────────────────────────────────────────────
def _frequency_score(rec: dict) -> float:
    """log-scaled normalized interaction count. 0 → 0; 5 → ~0.5; 50+ → ~1."""
    n = int(rec.get("interaction_count") or 0)
    if n <= 0:
        return 0.0
    # log10(n+1) / log10(51) so 50 maps to ~1.0
    return min(1.0, math.log10(n + 1) / math.log10(51))


def _recency_score(rec: dict, now: float | None = None) -> float:
    last = rec.get("last_interaction")
    if not last:
        return 0.0
    try:
        ts = datetime.fromisoformat(last).timestamp()
    except Exception:
        return 0.0
    age_days = max(0.0, ((now or time.time()) - ts) / 86400.0)
    # 30-day half-life, clamped to [0, 1]
    return max(0.0, min(1.0, math.exp(-age_days / 30.0)))


def _depth_score(rec: dict) -> float:
    """Blend avg-chars (capped) and topic diversity. A handful of long
    threaded exchanges beats fifty one-liners."""
    ih = rec.get("interaction_history") or {}
    avg_chars: list[float] = []
    topics: set[str] = set()
    for ch in ("email", "telegram", "social"):
        sub = ih.get(ch) or {}
        c = float(sub.get("avg_chars") or 0)
        if c > 0:
            avg_chars.append(c)
        for t in sub.get("topics") or []:
            t = (t or "").strip().lower()
            if t:
                topics.add(t)
    avg = (sum(avg_chars) / len(avg_chars)) if avg_chars else 0.0
    # 600 chars saturates depth — ~typical multi-paragraph email
    chars_score = min(1.0, avg / 600.0)
    diversity = min(1.0, len(topics) / 8.0)
    return 0.6 * chars_score + 0.4 * diversity


def _reciprocity_score(rec: dict) -> float:
    """1.0 when in/out are roughly balanced, dropping toward 0 when
    lopsided. We approximate "out" from interaction_count (we sent them
    something) and "in" from email/telegram raw counts."""
    n_total = int(rec.get("interaction_count") or 0)
    if n_total <= 0:
        return 0.0
    ih = rec.get("interaction_history") or {}
    n_in = sum(int((ih.get(ch) or {}).get("count") or 0)
               for ch in ("email", "telegram", "social"))
    if n_in <= 0:
        # We've talked to them but never seen anything back — treat as low.
        return 0.2
    # Perfectly balanced when n_in ≈ n_total / 2 (roughly half were inbound).
    ratio = min(n_in, n_total) / max(n_in, n_total)
    return ratio


def compute_strength(rec: dict, now: float | None = None) -> float:
    """Composite 0..1 score — see module docstring for the formula."""
    f = _frequency_score(rec)
    r = _recency_score(rec, now=now)
    d = _depth_score(rec)
    p = _reciprocity_score(rec)
    score = (STRENGTH_W_FREQ * f + STRENGTH_W_RECENCY * r
             + STRENGTH_W_DEPTH * d + STRENGTH_W_RECIPROCITY * p)
    return round(max(0.0, min(1.0, score)), 3)


def _trust_for_strength(strength: float, rec: dict) -> str:
    """Map composite strength to trust_level. Honours inner-circle hard
    overrides (spouse / cofounder etc.) regardless of low signal."""
    rel = (rec.get("relationship") or "").lower()
    if any(tok in rel for tok in INNER_CIRCLE_RELATIONSHIPS):
        return "inner_circle"
    for level, threshold in TRUST_THRESHOLDS.items():
        if strength >= threshold:
            return level
    return "cold"


# ── interaction-history rebuild from raw history ──────────────────────
_TOPIC_NOISE = re.compile(
    r"^(re|fw|fwd):|^(hi|hey|hello|thanks|thx|yo|sup)\b", re.I,
)


def _topics_from_subjects(subjects: Iterable[str], cap: int = 8) -> list[str]:
    """Light heuristic — strip Re:/Fw:, dedupe by lowercase, cap. Avoids a
    Haiku call on every contact."""
    seen: set[str] = set()
    out: list[str] = []
    for s in subjects:
        s = (s or "").strip()
        if not s:
            continue
        s = re.sub(r"^(re|fw|fwd):\s*", "", s, flags=re.I).strip()
        norm = s.lower()
        if not norm or norm in seen or _TOPIC_NOISE.match(norm):
            continue
        seen.add(norm)
        out.append(s[:80])
        if len(out) >= cap:
            break
    return out


def _rebuild_interaction_history(rec: dict, history: dict) -> None:
    """Update rec['interaction_history'] in place from the raw history dict
    (whatever shape jarvis-contacts returned). Sentiment is set to neutral
    here — Haiku enrichment overwrites with a real label later."""
    em = history.get("email") or []
    tg = history.get("telegram") or []
    so = history.get("social") or []

    em_chars = sum(len((e.get("snippet") or "")) for e in em)
    tg_chars = sum(len((t.get("text") or "")) for t in tg)
    so_chars = sum(len((s.get("text") or "")) for s in so)

    rec.setdefault("interaction_history", {})
    rec["interaction_history"]["email"] = {
        "count": len(em),
        "topics": _topics_from_subjects(e.get("subject", "") for e in em),
        "sentiment": (rec.get("interaction_history") or {}).get("email", {}).get("sentiment") or "neutral",
        "avg_chars": int(em_chars / len(em)) if em else 0,
    }
    rec["interaction_history"]["telegram"] = {
        "count": len(tg),
        "topics": [],  # no subjects in TG — left to Haiku enrichment
        "sentiment": (rec.get("interaction_history") or {}).get("telegram", {}).get("sentiment") or "neutral",
        "avg_chars": int(tg_chars / len(tg)) if tg else 0,
    }
    rec["interaction_history"]["social"] = {
        "count": len(so),
        "topics": [],
        "sentiment": (rec.get("interaction_history") or {}).get("social", {}).get("sentiment") or "neutral",
        "avg_chars": int(so_chars / len(so)) if so else 0,
    }


# ── network position ──────────────────────────────────────────────────
def _compute_network_position(people: dict) -> dict[str, dict]:
    """Build a {key: position_dict} map. Mutual contacts = people who share
    a Telegram group with this person. Connector score = how many other
    contacts they overlap with, capped 0..1 by the network size."""
    # Map TG group title → set of contact keys present in that group
    by_group: dict[str, set[str]] = {}
    for k, v in people.items():
        handle = (v.get("telegram_handle") or "").lstrip("@").lower()
        if not handle:
            continue
        # We can't enumerate groups without the telegram cache; instead, we
        # treat any contact whose `notes` or interaction history mentions a
        # shared group title (after enrichment) as group-shared. Fallback:
        # use the existing topics_discussed strings that look like group
        # names. Cheap and good enough until we plumb real group rosters.
    positions: dict[str, dict] = {}
    network_size = max(1, len(people) - 1)
    for k, v in people.items():
        # Mutual = anyone whose name appears in this person's open_threads
        # / notes / topics. Heuristic but lossless: when we get explicit
        # mutual signals, we'll add them on top.
        mentioned: set[str] = set()
        text_blob = " ".join([
            *(v.get("notes") or []),
            *(v.get("open_threads") or []),
            *(v.get("topics_discussed") or []),
            *(v.get("network_notes") or []),
        ]).lower()
        for k2, v2 in people.items():
            if k2 == k:
                continue
            n2 = (v2.get("name") or "").strip()
            if not n2 or len(n2) < 3:
                continue
            if n2.lower() in text_blob:
                mentioned.add(k2)
        connector = round(min(1.0, len(mentioned) / network_size), 3)
        positions[k] = {
            "mutual_contacts": sorted(mentioned)[:20],
            "groups_shared": [],  # placeholder until TG rosters wired
            "connector_score": connector,
        }
    return positions


# ── Haiku skill extraction ────────────────────────────────────────────
SKILL_SYSTEM = """Extract Watson's network signal from one contact's history. Output ONE valid JSON object — no prose, no fences:

{
  "skills": ["specific verbs/nouns: 'react', 'fundraising', 'product strategy', 'rust'. Empty if unclear."],
  "expertise_areas": ["broader domains: 'fintech', 'developer tools', 'community building'. <=4 items."],
  "can_intro_to": [{"name": "person they could connect Watson to", "context": "why"}],
  "tags": ["short tags Watson would use to find this person — 'austin', 'angel', 'react-native'. <=6."],
  "sentiment": {
    "email": "warm" | "neutral" | "cool",
    "telegram": "warm" | "neutral" | "cool",
    "social": "warm" | "neutral" | "cool"
  }
}

Rules:
- Be concrete. "fundraising" yes, "business stuff" no.
- can_intro_to: only when they explicitly offered or strongly implied an intro.
- Empty arrays are fine — better than fabrication.
- sentiment per channel: only set non-neutral when there's clear signal in the snippets.
"""


def _anthropic_call(api_key: str, model: str, system: str,
                    user_text: str, max_tokens: int = 800,
                    timeout: float = 30.0) -> str:
    payload = json.dumps({
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user_text}],
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
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read())
            blocks = data.get("content") or []
            return "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(1 + attempt * 1.5)
                continue
            raise RuntimeError(f"API error {e.code}: {e}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            if attempt < 2:
                time.sleep(1 + attempt * 1.5)
                continue
            raise RuntimeError(f"network: {e}") from e
    raise RuntimeError(f"unexpected: {last_err}")


def _extract_skills(rec: dict, history: dict, api_key: str) -> dict | None:
    """One Haiku call. Returns parsed JSON or None on any failure."""
    parts: list[str] = [f"Name: {rec.get('name')}"]
    if rec.get("relationship"):
        parts.append(f"Existing label: {rec['relationship']}")
    if rec.get("notes"):
        parts.append("Existing notes:\n- " + "\n- ".join(rec["notes"][:6]))
    if rec.get("topics_discussed"):
        parts.append("Topics seen: " + ", ".join(rec["topics_discussed"][:8]))
    em = history.get("email") or []
    tg = history.get("telegram") or []
    if em:
        parts.append("\nRecent email subjects + snippets:")
        for e in em[:12]:
            parts.append(f"  - {(e.get('subject') or '')[:80]} :: {(e.get('snippet') or '')[:150]}")
    if tg:
        parts.append("\nRecent Telegram messages:")
        for t in tg[:12]:
            parts.append(f"  - [{t.get('group') or ''}] {(t.get('text') or '')[:160]}")
    user_text = "\n".join(parts)
    try:
        raw = _anthropic_call(api_key, SKILL_MODEL, SKILL_SYSTEM, user_text,
                              max_tokens=700, timeout=25)
    except Exception as e:
        _log(f"skill call failed ({rec.get('name')}): {e}")
        return None
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


# ── enrich one contact (used by enrich_network's per-contact loop) ────
def _enrich_one(rec: dict, force: bool, api_key: str | None) -> dict:
    """Recompute interaction_history, strength, trust_level for one record.
    Optionally calls Haiku for skills/sentiment if api_key is provided and
    the record is stale (or force=True)."""
    _ensure_network_fields(rec)

    # Pull history via the existing harvester functions on jarvis-contacts.
    history: dict = {"email": [], "telegram": [], "social": []}
    mod = _contacts()
    if mod is not None:
        try:
            history["email"] = mod._email_history(rec)  # type: ignore[attr-defined]
        except Exception:
            pass
        try:
            history["telegram"] = mod._telegram_history(rec)  # type: ignore[attr-defined]
        except Exception:
            pass

    _rebuild_interaction_history(rec, history)

    needs_haiku = force
    if not needs_haiku:
        last = rec.get("network_enriched_at")
        if not last:
            needs_haiku = True
        else:
            try:
                age = time.time() - datetime.fromisoformat(last).timestamp()
                needs_haiku = age > ENRICH_INTERVAL_S
            except Exception:
                needs_haiku = True

    if needs_haiku and api_key:
        parsed = _extract_skills(rec, history, api_key)
        if parsed:
            if isinstance(parsed.get("skills"), list):
                rec["skills"] = [s for s in parsed["skills"] if isinstance(s, str)][:20]
            if isinstance(parsed.get("expertise_areas"), list):
                rec["expertise_areas"] = [s for s in parsed["expertise_areas"]
                                          if isinstance(s, str)][:6]
            intros = parsed.get("can_intro_to") or []
            if isinstance(intros, list):
                rec["can_intro_to"] = [
                    {"name": str(it.get("name") or "")[:80],
                     "context": str(it.get("context") or "")[:200]}
                    for it in intros if isinstance(it, dict) and it.get("name")
                ][:10]
            tags = parsed.get("tags") or []
            if isinstance(tags, list):
                # Merge with existing user-set tags, preserve order, dedupe.
                merged: list[str] = list(rec.get("tags") or [])
                for t in tags:
                    if isinstance(t, str) and t and t not in merged:
                        merged.append(t)
                rec["tags"] = merged[:15]
            sent = parsed.get("sentiment") or {}
            if isinstance(sent, dict):
                for ch in ("email", "telegram", "social"):
                    v = sent.get(ch)
                    if v in ("warm", "neutral", "cool"):
                        rec.setdefault("interaction_history", {}).setdefault(ch, {})
                        rec["interaction_history"][ch]["sentiment"] = v
            rec["network_enriched_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")

    rec["relationship_strength"] = compute_strength(rec)
    rec["trust_level"] = _trust_for_strength(rec["relationship_strength"], rec)
    return rec


# ── PUBLIC: enrich_network ────────────────────────────────────────────
def enrich_network(force: bool = False) -> dict:
    """Batch-update every contact's network fields. Caps Haiku calls per
    run via JARVIS_NETWORK_BATCH_CAP (default 10) to stay friendly to the
    rate limit when run inside jarvis-improve."""
    started = time.monotonic()
    gate = _gate_check()
    if gate:
        _emit("enrich_network", "skipped", reason="gate")
        return gate
    people = _load_people()
    if not people:
        _emit("enrich_network", "skipped", reason="no_contacts")
        return {"ok": True, "enriched": 0, "skipped": 0,
                "reason": "no contacts on file"}
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    cap = int(os.environ.get("JARVIS_NETWORK_BATCH_CAP", "10"))

    enriched = 0
    skipped = 0
    haiku_calls = 0
    errors: list[str] = []
    for k, rec in people.items():
        try:
            uses_haiku = bool(api_key) and (force or not rec.get("network_enriched_at"))
            if uses_haiku and haiku_calls >= cap:
                # Refresh cheap fields without Haiku so strength + trust
                # stay current even when we've hit the batch cap.
                _enrich_one(rec, force=False, api_key=None)
                people[k] = rec
                skipped += 1
                continue
            _enrich_one(rec, force=force, api_key=api_key or None)
            people[k] = rec
            enriched += 1
            if uses_haiku:
                haiku_calls += 1
        except Exception as e:
            errors.append(f"{rec.get('name')}: {e}")

    # Network position needs the full updated map.
    positions = _compute_network_position(people)
    for k, pos in positions.items():
        if k in people:
            people[k].setdefault("network_position", {})
            people[k]["network_position"].update(pos)

    _save_people(people)
    elapsed = int((time.monotonic() - started) * 1000)
    _emit("enrich_network", "success" if not errors else "failed",
          enriched=enriched, skipped=skipped, haiku_calls=haiku_calls,
          errors_count=len(errors))
    _log(f"enrich_network: enriched={enriched} skipped={skipped} "
         f"haiku={haiku_calls} errors={len(errors)} ({elapsed}ms)")
    return {
        "ok": True,
        "enriched": enriched,
        "skipped": skipped,
        "haiku_calls": haiku_calls,
        "errors": errors,
    }


# ── PUBLIC: network_search ────────────────────────────────────────────
_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokens(s: str) -> set[str]:
    return {t for t in _TOKEN_RE.findall((s or "").lower()) if len(t) > 2}


def _searchable_text(rec: dict) -> str:
    bits = [
        rec.get("name") or "",
        rec.get("relationship") or "",
        rec.get("brief") or "",
        " ".join(rec.get("skills") or []),
        " ".join(rec.get("expertise_areas") or []),
        " ".join(rec.get("tags") or []),
        " ".join(rec.get("topics_discussed") or []),
        " ".join(it.get("name", "") + " " + it.get("context", "")
                 for it in (rec.get("can_intro_to") or [])
                 if isinstance(it, dict)),
    ]
    return " ".join(b for b in bits if b)


def network_search(query: str, filters: dict | None = None,
                   limit: int = 8) -> dict:
    """Token-overlap rank against skills / expertise / can_intro_to / tags.
    Filters: trust (str | list), tag (str | list), min_strength (float),
    recent_within_days (int)."""
    started = time.monotonic()
    gate = _gate_check()
    if gate:
        _emit("network_search", "skipped", reason="gate")
        return gate
    q_tokens = _tokens(query or "")
    if not q_tokens:
        _emit("network_search", "failed", reason="empty_query")
        return {"error": "query is required"}

    filters = filters or {}
    trust_filter = filters.get("trust")
    if isinstance(trust_filter, str):
        trust_filter = [trust_filter]
    tag_filter = filters.get("tag")
    if isinstance(tag_filter, str):
        tag_filter = [tag_filter]
    min_strength = float(filters.get("min_strength") or 0.0)
    recent_within = filters.get("recent_within_days")

    people = _load_people()
    now = time.time()
    results: list[tuple[float, dict, list[str]]] = []
    for k, rec in people.items():
        _ensure_network_fields(rec)
        if trust_filter and rec.get("trust_level") not in trust_filter:
            continue
        if tag_filter:
            tags_lower = {t.lower() for t in (rec.get("tags") or [])}
            if not any(t.lower() in tags_lower for t in tag_filter):
                continue
        if rec.get("relationship_strength", 0.0) < min_strength:
            continue
        if recent_within:
            li = rec.get("last_interaction")
            if not li:
                continue
            try:
                age_days = (now - datetime.fromisoformat(li).timestamp()) / 86400.0
            except Exception:
                age_days = 9999
            if age_days > float(recent_within):
                continue

        text = _searchable_text(rec)
        text_tokens = _tokens(text)
        overlap = q_tokens & text_tokens
        if not overlap:
            continue
        score = len(overlap)
        # Prefer skill / expertise / tag hits over generic text.
        skill_tokens = _tokens(" ".join(rec.get("skills") or []))
        expertise_tokens = _tokens(" ".join(rec.get("expertise_areas") or []))
        tag_tokens = _tokens(" ".join(rec.get("tags") or []))
        if q_tokens & skill_tokens:
            score += 2
        if q_tokens & expertise_tokens:
            score += 1
        if q_tokens & tag_tokens:
            score += 1
        score += 0.5 * rec.get("relationship_strength", 0.0)
        match_reasons: list[str] = []
        if q_tokens & skill_tokens:
            match_reasons.append("skill")
        if q_tokens & expertise_tokens:
            match_reasons.append("expertise")
        if q_tokens & tag_tokens:
            match_reasons.append("tag")
        if not match_reasons:
            match_reasons.append("text")
        results.append((score, rec, match_reasons))

    results.sort(key=lambda t: (t[0], t[1].get("relationship_strength", 0)),
                 reverse=True)
    out = [
        {
            "name": rec.get("name"),
            "trust_level": rec.get("trust_level"),
            "relationship_strength": rec.get("relationship_strength"),
            "skills": rec.get("skills") or [],
            "expertise_areas": rec.get("expertise_areas") or [],
            "tags": rec.get("tags") or [],
            "last_interaction": rec.get("last_interaction"),
            "match_reasons": reasons,
        }
        for _, rec, reasons in results[:max(1, limit)]
    ]
    elapsed = int((time.monotonic() - started) * 1000)
    _emit("network_search", "success", query=query[:80],
          filters={k: v for k, v in (filters or {}).items() if v is not None},
          hit_count=len(out), latency_ms=elapsed)
    return {"ok": True, "query": query, "filters": filters or {},
            "count": len(out), "results": out}


# ── PUBLIC: network_map ───────────────────────────────────────────────
def network_map(focus: str | None = None) -> dict:
    """Without focus: people grouped by trust_level. With focus: anyone
    matching the topic, plus their connections via mutual_contacts /
    can_intro_to."""
    started = time.monotonic()
    gate = _gate_check()
    if gate:
        _emit("network_map", "skipped", reason="gate")
        return gate
    people = _load_people()
    if not people:
        _emit("network_map", "skipped", reason="no_contacts")
        return {"ok": True, "summary": "(no contacts yet)", "groups": {}}

    if focus:
        # Reuse network_search to find the relevant set.
        hits = network_search(focus, limit=20).get("results") or []
        names = [h["name"] for h in hits]
        # Walk one hop: who do those people connect to?
        connections: dict[str, list[str]] = {}
        for h in hits:
            rec = next((v for v in people.values() if v.get("name") == h["name"]), {})
            mutual_keys = (rec.get("network_position") or {}).get("mutual_contacts") or []
            mutual_names = [people[k].get("name") for k in mutual_keys if k in people]
            intros = [it.get("name") for it in (rec.get("can_intro_to") or [])
                      if isinstance(it, dict) and it.get("name")]
            connections[h["name"]] = sorted(set(filter(None, mutual_names + intros)))[:8]
        elapsed = int((time.monotonic() - started) * 1000)
        _emit("network_map", "success", focus=focus[:80], hit_count=len(hits),
              latency_ms=elapsed)
        return {
            "ok": True, "focus": focus, "people": hits,
            "connections": connections,
        }

    # Trust-level rollup.
    groups: dict[str, list[dict]] = {
        "inner_circle": [], "trusted": [], "professional": [],
        "acquaintance": [], "cold": [],
    }
    for rec in people.values():
        _ensure_network_fields(rec)
        groups.setdefault(rec.get("trust_level") or "cold", []).append({
            "name": rec.get("name"),
            "relationship": rec.get("relationship"),
            "relationship_strength": rec.get("relationship_strength"),
            "last_interaction": rec.get("last_interaction"),
            "tags": rec.get("tags") or [],
        })
    for v in groups.values():
        v.sort(key=lambda r: r.get("relationship_strength") or 0.0, reverse=True)

    summary = (
        f"{len(groups['inner_circle'])} inner circle, "
        f"{len(groups['trusted'])} trusted, "
        f"{len(groups['professional'])} professional, "
        f"{len(groups['acquaintance'])} acquaintance, "
        f"{len(groups['cold'])} cold."
    )
    elapsed = int((time.monotonic() - started) * 1000)
    _emit("network_map", "success", focus=None,
          total=sum(len(v) for v in groups.values()), latency_ms=elapsed)
    return {"ok": True, "summary": summary, "groups": groups}


# ── PUBLIC: relationship_score ────────────────────────────────────────
def _trajectory(rec: dict) -> str:
    """Compare the last 30d signal to the prior 30d. Heuristic — if we
    don't have the data, return 'stable'."""
    last = rec.get("last_interaction")
    if not last:
        return "dormant"
    try:
        age_days = (time.time() - datetime.fromisoformat(last).timestamp()) / 86400.0
    except Exception:
        return "stable"
    if age_days < 7:
        return "active"
    if age_days < 30:
        return "warm"
    if age_days < 90:
        return "cooling"
    return "dormant"


def _suggest_next(rec: dict) -> dict:
    """Voice-friendly suggestion based on trust + trajectory."""
    trust = rec.get("trust_level") or "cold"
    traj = _trajectory(rec)
    name = rec.get("name") or "this contact"
    pref = rec.get("communication_preference") or "either"

    if trust in ("inner_circle", "trusted") and traj in ("cooling", "dormant"):
        return {
            "action": f"Reach out to {name} — relationship is cooling.",
            "channel": pref if pref != "either" else "telegram",
            "timing": "today" if trust == "inner_circle" else "this week",
        }
    if traj == "active":
        threads = rec.get("open_threads") or []
        if threads:
            return {
                "action": f"Continue the open thread: {threads[0]}",
                "channel": pref if pref != "either" else (rec.get("last_channel") or "email"),
                "timing": "today",
            }
        return {
            "action": f"Conversation is healthy — no action needed.",
            "channel": None,
            "timing": "—",
        }
    if trust == "cold":
        return {
            "action": f"Re-engage if useful — relationship is faint.",
            "channel": "email",
            "timing": "next opportunity",
        }
    # Professional / acquaintance, warm
    return {
        "action": f"Light touch — share something relevant when natural.",
        "channel": pref if pref != "either" else "email",
        "timing": "this month",
    }


def relationship_score(name: str) -> dict:
    started = time.monotonic()
    gate = _gate_check()
    if gate:
        _emit("relationship_score", "skipped", reason="gate")
        return gate
    if not name:
        _emit("relationship_score", "failed", reason="no_name")
        return {"error": "name is required"}

    mod = _contacts()
    if mod is None:
        _emit("relationship_score", "failed", reason="contacts_missing")
        return {"error": "jarvis-contacts not installed"}
    hit = mod._resolve(name)  # type: ignore[attr-defined]
    if not hit:
        _emit("relationship_score", "failed", reason="not_found", name=name[:80])
        return {"ok": False, "found": False, "name": name}
    key, rec = hit
    _ensure_network_fields(rec)

    # Refresh derived fields (no Haiku — just the cheap recompute).
    history = {
        "email": [], "telegram": [],
    }
    try:
        history["email"] = mod._email_history(rec)  # type: ignore[attr-defined]
    except Exception:
        pass
    try:
        history["telegram"] = mod._telegram_history(rec)  # type: ignore[attr-defined]
    except Exception:
        pass
    _rebuild_interaction_history(rec, history)
    rec["relationship_strength"] = compute_strength(rec)
    rec["trust_level"] = _trust_for_strength(rec["relationship_strength"], rec)
    # Persist the recompute so next caller has fresh values.
    people = _load_people()
    people[key] = rec
    _save_people(people)

    components = {
        "frequency":   round(_frequency_score(rec), 3),
        "recency":     round(_recency_score(rec), 3),
        "depth":       round(_depth_score(rec), 3),
        "reciprocity": round(_reciprocity_score(rec), 3),
    }
    responsiveness = "unknown"
    ih = rec.get("interaction_history") or {}
    in_count = sum(int((ih.get(c) or {}).get("count") or 0)
                   for c in ("email", "telegram", "social"))
    out_count = max(0, int(rec.get("interaction_count") or 0) - in_count)
    if in_count and out_count:
        ratio = in_count / max(1, out_count)
        if ratio >= 0.8:
            responsiveness = "high"
        elif ratio >= 0.4:
            responsiveness = "moderate"
        else:
            responsiveness = "low"
    elapsed = int((time.monotonic() - started) * 1000)
    _emit("relationship_score", "success", name=rec.get("name"),
          strength=rec["relationship_strength"], trust=rec["trust_level"],
          latency_ms=elapsed)
    return {
        "ok": True,
        "found": True,
        "name": rec.get("name"),
        "trust_level": rec.get("trust_level"),
        "relationship_strength": rec.get("relationship_strength"),
        "components": components,
        "trajectory": _trajectory(rec),
        "responsiveness": responsiveness,
        "skills": rec.get("skills") or [],
        "expertise_areas": rec.get("expertise_areas") or [],
        "tags": rec.get("tags") or [],
        "open_threads": rec.get("open_threads") or [],
        "last_interaction": rec.get("last_interaction"),
        "last_channel": rec.get("last_channel"),
        "communication_preference": rec.get("communication_preference"),
        "next_action": _suggest_next(rec),
    }


# ── PUBLIC: network_suggest ───────────────────────────────────────────
SUGGEST_SYSTEM = """You are JARVIS planning who Watson should leverage to advance a goal.

Input: a goal + a candidate set of contacts (each with skills, expertise, trust level, strength, and any open threads / tags).

Output ONE JSON object — no prose, no fences:

{
  "rationale": "one sentence — what this plan accomplishes and why these people",
  "suggested_people": [
    {"name": "...", "role": "primary | supporting | intro_path",
     "why": "concrete reason grounded in their skills / relationship",
     "approach": "channel + framing — 'telegram, ask about Tuesday demo' / 'email warm intro request'",
     "timing": "now | this week | when blocked"
    }
  ],
  "intro_paths": [
    {"target": "person Watson does NOT yet know", "via": "contact who can intro",
     "context": "why this intro makes sense"}
  ],
  "sequence": ["short imperative steps Watson should take in order"]
}

Rules:
- Lead with the strongest, most-trusted contact whose skills actually match.
- If the candidate set is thin, say so explicitly in rationale and suggest broadening.
- intro_paths: only when a contact's `can_intro_to` field has a relevant target.
- Keep sequence to 3-5 steps. No filler.
"""


def network_suggest(goal: str) -> dict:
    started = time.monotonic()
    gate = _gate_check()
    if gate:
        _emit("network_suggest", "skipped", reason="gate")
        return gate
    if not goal or not goal.strip():
        _emit("network_suggest", "failed", reason="no_goal")
        return {"error": "goal is required"}
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        _emit("network_suggest", "failed", reason="no_api_key")
        return {"error": "ANTHROPIC_API_KEY not set"}

    candidates = network_search(goal, limit=12).get("results") or []
    if not candidates:
        # Fall back to the strongest dozen contacts if the search came up dry.
        people = _load_people()
        ranked = sorted(
            ({"name": v.get("name"),
              "trust_level": v.get("trust_level"),
              "relationship_strength": v.get("relationship_strength"),
              "skills": v.get("skills") or [],
              "expertise_areas": v.get("expertise_areas") or [],
              "tags": v.get("tags") or []}
             for v in people.values()
             if (v.get("relationship_strength") or 0) > 0),
            key=lambda r: r["relationship_strength"], reverse=True,
        )
        candidates = ranked[:12]

    # Add can_intro_to for each candidate from the source record.
    people = _load_people()
    for c in candidates:
        rec = next((v for v in people.values() if v.get("name") == c["name"]), {})
        c["can_intro_to"] = rec.get("can_intro_to") or []
        c["open_threads"] = rec.get("open_threads") or []

    user_text = (
        f"GOAL: {goal.strip()}\n\n"
        "CANDIDATE CONTACTS:\n"
        + json.dumps(candidates, ensure_ascii=False, indent=2)
    )
    try:
        raw = _anthropic_call(api_key, SUGGEST_MODEL, SUGGEST_SYSTEM,
                              user_text, max_tokens=1200, timeout=30)
    except Exception as e:
        _emit("network_suggest", "failed", reason=f"api: {e}")
        return {"error": f"network_suggest call failed: {e}"}
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        _emit("network_suggest", "failed", reason="no_json")
        return {"error": "model did not return JSON", "raw": raw[:500]}
    try:
        parsed = json.loads(m.group(0))
    except json.JSONDecodeError as e:
        _emit("network_suggest", "failed", reason=f"json: {e}")
        return {"error": f"could not parse model output: {e}", "raw": raw[:500]}

    elapsed = int((time.monotonic() - started) * 1000)
    parsed["ok"] = True
    parsed["goal"] = goal
    parsed["candidate_count"] = len(candidates)
    _emit("network_suggest", "success", goal=goal[:80],
          candidate_count=len(candidates), latency_ms=elapsed)
    return parsed


# ── PUBLIC: network_alerts ────────────────────────────────────────────
def network_alerts() -> dict:
    """Surface fading relationships, stale follow-ups, and pending intro
    opportunities. Persists the last result to ALERTS_FILE so notifications
    + briefing have a stable cache."""
    started = time.monotonic()
    gate = _gate_check()
    if gate:
        _emit("network_alerts", "skipped", reason="gate")
        return gate
    people = _load_people()
    if not people:
        _emit("network_alerts", "skipped", reason="no_contacts")
        return {"ok": True, "alerts": [], "fading": [], "follow_ups": [],
                "intro_opportunities": []}

    now = time.time()
    fading: list[dict] = []
    follow_ups: list[dict] = []
    intros: list[dict] = []

    for rec in people.values():
        _ensure_network_fields(rec)
        trust = rec.get("trust_level") or "cold"
        last = rec.get("last_interaction")
        try:
            age_days = (now - datetime.fromisoformat(last).timestamp()) / 86400.0 if last else 9999
        except Exception:
            age_days = 9999

        # Fading inner_circle / trusted / professional contacts
        threshold = FADE_DAYS.get(trust)
        if threshold and age_days >= threshold:
            fading.append({
                "name": rec.get("name"),
                "trust_level": trust,
                "days_since": int(age_days) if age_days < 9000 else None,
                "communication_preference": rec.get("communication_preference"),
                "relationship_strength": rec.get("relationship_strength"),
            })

        # Follow-ups: open_threads with stale last_interaction
        threads = rec.get("open_threads") or []
        if threads and age_days >= 7:
            follow_ups.append({
                "name": rec.get("name"),
                "trust_level": trust,
                "days_since": int(age_days) if age_days < 9000 else None,
                "thread": threads[0],
            })

        # Intro opportunities: any can_intro_to entry — surface so Watson
        # remembers the offer is on the table.
        for it in rec.get("can_intro_to") or []:
            if not isinstance(it, dict) or not it.get("name"):
                continue
            intros.append({
                "via": rec.get("name"),
                "target": it.get("name"),
                "context": it.get("context") or "",
            })

    # Sort + clip
    fading.sort(key=lambda r: ({"inner_circle": 0, "trusted": 1, "professional": 2}.get(
        r["trust_level"], 3), -(r.get("relationship_strength") or 0)))
    fading = fading[:12]
    follow_ups.sort(key=lambda r: r.get("days_since") or 0, reverse=True)
    follow_ups = follow_ups[:10]
    intros = intros[:10]

    alerts: list[dict] = []
    for f in fading:
        urgency = "high" if f["trust_level"] == "inner_circle" else "medium"
        alerts.append({
            "type": "fading",
            "urgency": urgency,
            "name": f["name"],
            "summary": f"{f['name']} ({f['trust_level']}) — last interaction "
                       f"{f.get('days_since', '?')}d ago",
        })
    for fu in follow_ups:
        alerts.append({
            "type": "follow_up",
            "urgency": "medium",
            "name": fu["name"],
            "summary": f"{fu['name']} — open thread '{fu['thread']}' "
                       f"({fu.get('days_since', '?')}d cold)",
        })
    for it in intros:
        alerts.append({
            "type": "intro_opportunity",
            "urgency": "low",
            "name": it["target"],
            "summary": f"{it['via']} can intro you to {it['target']}"
                       + (f" — {it['context']}" if it["context"] else ""),
        })

    payload = {
        "ok": True,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "alerts": alerts,
        "fading": fading,
        "follow_ups": follow_ups,
        "intro_opportunities": intros,
    }
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        ALERTS_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                               encoding="utf-8")
    except Exception:
        pass

    elapsed = int((time.monotonic() - started) * 1000)
    _emit("network_alerts", "success",
          alert_count=len(alerts), fading=len(fading),
          follow_ups=len(follow_ups), intros=len(intros), latency_ms=elapsed)
    return payload


# ── briefing + notifications + context hooks ──────────────────────────
def briefing_section() -> str:
    """Markdown 'Relationship Alerts' block for jarvis-briefing. Empty when
    nothing is fading so quiet weeks don't pad the briefing."""
    if not ALERTS_FILE.exists():
        return ""
    try:
        data = json.loads(ALERTS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return ""
    fading = data.get("fading") or []
    follow_ups = data.get("follow_ups") or []
    intros = data.get("intro_opportunities") or []
    if not (fading or follow_ups or intros):
        return ""
    lines = ["## Relationship Alerts", ""]
    if fading:
        lines.append("**Fading:**")
        for f in fading[:5]:
            lines.append(
                f"- {f['name']} ({f['trust_level']}) — {f.get('days_since', '?')}d ago"
            )
        lines.append("")
    if follow_ups:
        lines.append("**Open follow-ups:**")
        for fu in follow_ups[:5]:
            lines.append(f"- {fu['name']} — {fu['thread']} ({fu.get('days_since', '?')}d)")
        lines.append("")
    if intros:
        lines.append("**Intro opportunities:**")
        for it in intros[:5]:
            ctx = f" — {it['context']}" if it.get("context") else ""
            lines.append(f"- {it['via']} → {it['target']}{ctx}")
        lines.append("")
    return "\n".join(lines)


def context_hint(mentioned_names: list[str] | None = None) -> str:
    """One-line system-prompt hint. If `mentioned_names` is supplied, lead
    with quick stats on those people. Otherwise surface the topmost fading
    inner-circle contact when one exists."""
    if not _gate_check() is None:
        return ""
    bits: list[str] = []
    if mentioned_names:
        people = _load_people()
        mod = _contacts()
        for nm in mentioned_names[:3]:
            hit = None
            if mod is not None:
                try:
                    hit = mod._resolve(nm, people)  # type: ignore[attr-defined]
                except Exception:
                    hit = None
            if not hit:
                continue
            _, rec = hit
            _ensure_network_fields(rec)
            bits.append(
                f"{rec.get('name')} ({rec.get('trust_level')}, "
                f"strength={rec.get('relationship_strength')})"
            )
    if bits:
        return ("**Network:** " + "; ".join(bits)
                + ". Use `relationship_score` for the deep brief.")
    if ALERTS_FILE.exists():
        try:
            data = json.loads(ALERTS_FILE.read_text(encoding="utf-8"))
        except Exception:
            return ""
        fading = data.get("fading") or []
        inner = [f for f in fading if f.get("trust_level") == "inner_circle"]
        if inner:
            top = inner[0]
            return (f"**Network:** {top['name']} (inner circle) has gone "
                    f"{top.get('days_since', '?')}d quiet. Consider a check-in.")
    return ""


def fading_inner_circle_priority_boost(sender: str | None) -> int:
    """Hook for jarvis-notifications. Returns +N to add to a notification's
    score when its sender is a fading inner_circle contact. Encourages the
    bus to interrupt-route a 'hey what's up' that would otherwise queue."""
    if not sender or not ALERTS_FILE.exists():
        return 0
    try:
        data = json.loads(ALERTS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return 0
    fading = data.get("fading") or []
    s = (sender or "").strip().lower().lstrip("@")
    if not s:
        return 0
    mod = _contacts()
    if mod is None:
        return 0
    try:
        hit = mod._resolve(sender)  # type: ignore[attr-defined]
    except Exception:
        return 0
    if not hit:
        return 0
    _, rec = hit
    rec_name = (rec.get("name") or "").lower()
    for f in fading:
        if f.get("trust_level") != "inner_circle":
            continue
        if (f.get("name") or "").lower() == rec_name:
            return 2  # bump enough to cross interrupt threshold for warm contacts
    return 0


# ── CLI ────────────────────────────────────────────────────────────────
def _cli() -> int:
    p = argparse.ArgumentParser(description="Jarvis network intelligence")
    sub = p.add_subparsers(dest="cmd", required=True)

    ps = sub.add_parser("search")
    ps.add_argument("query")
    ps.add_argument("--trust", default=None,
                    help="comma-separated trust levels: inner_circle,trusted,...")
    ps.add_argument("--tag", default=None, help="comma-separated tags")
    ps.add_argument("--min-strength", type=float, default=0.0)
    ps.add_argument("--recent-within-days", type=int, default=None)
    ps.add_argument("--limit", type=int, default=8)

    pm = sub.add_parser("map")
    pm.add_argument("--focus", default=None)

    pr = sub.add_parser("score")
    pr.add_argument("name")

    psug = sub.add_parser("suggest")
    psug.add_argument("goal", nargs="+")

    pe = sub.add_parser("enrich")
    pe.add_argument("--force", action="store_true")

    sub.add_parser("alerts")
    sub.add_parser("briefing-section")
    pch = sub.add_parser("context-hint")
    pch.add_argument("--names", default=None,
                     help="comma-separated mentioned names")

    args = p.parse_args()

    if args.cmd == "search":
        filters: dict = {}
        if args.trust:
            filters["trust"] = [t.strip() for t in args.trust.split(",") if t.strip()]
        if args.tag:
            filters["tag"] = [t.strip() for t in args.tag.split(",") if t.strip()]
        if args.min_strength:
            filters["min_strength"] = args.min_strength
        if args.recent_within_days is not None:
            filters["recent_within_days"] = args.recent_within_days
        print(json.dumps(network_search(args.query, filters=filters,
                                        limit=args.limit),
                         ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "map":
        print(json.dumps(network_map(focus=args.focus),
                         ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "score":
        print(json.dumps(relationship_score(args.name),
                         ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "suggest":
        print(json.dumps(network_suggest(" ".join(args.goal)),
                         ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "enrich":
        print(json.dumps(enrich_network(force=args.force),
                         ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "alerts":
        print(json.dumps(network_alerts(), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "briefing-section":
        s = briefing_section()
        print(s if s else "(no fading / follow-ups / intros)")
        return 0
    if args.cmd == "context-hint":
        names = [n.strip() for n in (args.names or "").split(",") if n.strip()]
        h = context_hint(mentioned_names=names or None)
        print(h if h else "(no hint)")
        return 0
    return 2


def main() -> int:
    """jarvis-improve entrypoint — runs enrich_network + alerts. Always
    exits 0 so the chain doesn't break on a transient failure."""
    if os.environ.get("JARVIS_NETWORK", "1") != "1":
        return 0
    try:
        enrich_network(force=False)
        network_alerts()
    except Exception as e:
        _log(f"main: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(_cli() if len(sys.argv) > 1 else main())
