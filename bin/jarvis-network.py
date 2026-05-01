#!/usr/bin/env python3
"""Network Intelligence — Watson's professional network as a queryable graph.

Where jarvis-contacts.py stores per-person relationship memory (brief,
talking points, last interaction), jarvis-network.py turns that store
into a graph: who can do what, who is strongly connected to whom, who
to call on for which goal, where the relationships are fading.

The two modules share the same backing file (~/.jarvis/contacts/people.json).
Network simply augments each record with computed fields (relationship
strength, trust level, mutual contacts) and adds graph-level operations
on top. Existing tools (lookup_contact, relationship_brief) keep working
and now read the richer record.

Public surface:

    network_search(query, filters=None, limit=10) -> dict
        Semantic search across the network. Matches against skills,
        expertise, topics, brief, notes, relationship label. Filters:
        trust_level, tags, min_strength, channel, recency_days.

    network_map(focus=None, limit=20) -> dict
        Network overview. No focus → top contacts grouped by trust tier.
        With focus → who's relevant + how they connect + suggested order.

    relationship_score(name) -> dict
        Deep one-person analysis: strength, trajectory, channels,
        responsiveness, suggested next action and channel.

    network_suggest(goal) -> dict
        Given a goal ("close the Forge deal", "find a React dev"), Sonnet
        proposes who to leverage and in what order, grounded in the network.

    enrich_network(force=False, cap=None) -> dict
        Batch pass: bumps relationship_strength, infers skills/expertise
        via Haiku, computes mutual contacts and shared groups, populates
        trust_level, refreshes alerts. Run weekly via jarvis-improve.

    network_alerts() -> dict
        Proactive list: fading inner_circle, pending follow-ups, intro
        opportunities, milestones.

Helpers consumed elsewhere:

    relationship_alerts_section() -> str
        Markdown block for jarvis-briefing.py (only when actionable).
    push_alerts_to_notifications() -> dict
        Enqueue actionable alerts onto the smart notification bus.
    context_hint() -> str
        One-line hint for jarvis-context.py when high-priority alerts pend.

CLI:
    bin/jarvis-network.py --search "fundraising"
    bin/jarvis-network.py --map [--focus "investors"]
    bin/jarvis-network.py --score Corbin
    bin/jarvis-network.py --suggest "close the Forge deal"
    bin/jarvis-network.py --enrich-all [--force]
    bin/jarvis-network.py --alerts
    bin/jarvis-network.py --status

Files written:
    ~/.jarvis/contacts/people.json    (extended schema, shared with contacts)
    ~/.jarvis/contacts/network.json   network-level cache (mutual contact graph)
    ~/.jarvis/contacts/alerts.json    last computed alert list
    ~/.jarvis/logs/network.log        diagnostic log

Gate: JARVIS_NETWORK=1 (default 1).
"""
from __future__ import annotations

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
from typing import Any

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
BIN_DIR = ASSISTANT_DIR / "bin"
LIB_DIR = ASSISTANT_DIR / "lib"
CONTACTS_DIR = ASSISTANT_DIR / "contacts"
PEOPLE_FILE = CONTACTS_DIR / "people.json"
NETWORK_FILE = CONTACTS_DIR / "network.json"
ALERTS_FILE = CONTACTS_DIR / "alerts.json"
LOG_DIR = ASSISTANT_DIR / "logs"
NETWORK_LOG = LOG_DIR / "network.log"

ENRICH_INTERVAL_S = int(os.environ.get("JARVIS_NETWORK_REFRESH_S", str(7 * 86400)))
SKILLS_MODEL = os.environ.get("JARVIS_NETWORK_SKILLS_MODEL", "claude-haiku-4-5-20251001")
SUGGEST_MODEL = os.environ.get("JARVIS_NETWORK_SUGGEST_MODEL", "claude-sonnet-4-6")
BATCH_CAP = int(os.environ.get("JARVIS_NETWORK_BATCH_CAP", "12"))

# Half-lives in days. Recency for the strength formula uses a 30-day half-life
# (interactions older than ~3 months barely count). Fading thresholds below.
STRENGTH_HALFLIFE_DAYS = 30.0

FADING_THRESHOLDS_DAYS = {
    "inner_circle": 30,
    "trusted": 60,
    "professional": 90,
    "acquaintance": 180,
}

TRUST_LABEL_MAP = {
    # explicit relationship labels → trust tier (case-insensitive substring)
    "inner_circle": ["spouse", "partner", "co-founder", "cofounder", "best friend"],
    "trusted": [
        "investor", "client", "founder peer", "advisor", "mentor",
        "team", "employee", "lead", "director", "manager",
    ],
    "professional": ["customer", "vendor", "supplier", "consultant", "contractor"],
    "acquaintance": ["acquaintance", "lead", "prospect", "intro"],
}

TIER_WEIGHT = {
    "inner_circle": 1.0,
    "trusted": 0.8,
    "professional": 0.6,
    "acquaintance": 0.4,
    "cold": 0.2,
}

VALID_TIERS = ("inner_circle", "trusted", "professional", "acquaintance", "cold")


# ── Logging ─────────────────────────────────────────────────────────
def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with NETWORK_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


# ── Gate ────────────────────────────────────────────────────────────
def _gate_check() -> dict | None:
    if os.environ.get("JARVIS_NETWORK", "1") != "1":
        return {"error": "network intelligence disabled (JARVIS_NETWORK=0)"}
    return None


# ── Sibling loaders ─────────────────────────────────────────────────
def _bin_search() -> list[Path]:
    return [BIN_DIR, Path(__file__).parent]


def _lib_search() -> list[Path]:
    return [LIB_DIR, Path(__file__).parent.parent / "lib"]


_loaded: dict[str, Any] = {}


def _load(module_id: str, relative: str, search_dirs: list[Path]):
    if module_id in _loaded:
        return _loaded[module_id]
    for d in search_dirs:
        src = d / relative
        if src.exists():
            try:
                spec = importlib.util.spec_from_file_location(module_id, src)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)  # type: ignore[union-attr]
                _loaded[module_id] = mod
                return mod
            except Exception as e:
                _log(f"load {relative} failed: {e}")
                _loaded[module_id] = None
                return None
    _loaded[module_id] = None
    return None


def _contacts_mod():
    return _load("jarvis_contacts_for_network", "jarvis-contacts.py", _bin_search())


def _primitive_mod():
    return _load("primitive_for_network", "primitive.py", _lib_search())


def _ledger_mod():
    return _load("outcome_ledger_for_network", "outcome_ledger.py", _lib_search())


# ── Atomic JSON I/O ─────────────────────────────────────────────────
def _read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path: Path, data) -> bool:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                       encoding="utf-8")
        tmp.replace(path)
        return True
    except Exception as e:
        _log(f"write {path.name} failed: {e}")
        return False


def _emit(action: str, status: str, context: dict | None = None,
          latency_ms: float | None = None) -> None:
    mod = _ledger_mod()
    if mod is None:
        return
    try:
        mod.emit(cap="network", action=action, status=status,
                 context=context, latency_ms=latency_ms)
    except Exception:
        pass


# ── Schema migration ────────────────────────────────────────────────
def _ensure_network_fields(rec: dict) -> dict:
    """Backfill network-layer fields onto a contact record if missing.
    Idempotent and non-destructive — existing values win."""
    rec.setdefault("skills", [])
    rec.setdefault("expertise_areas", [])
    rec.setdefault("can_intro_to", [])
    rec.setdefault("relationship_strength", 0.0)
    rec.setdefault("trust_level", "acquaintance")
    rec.setdefault("tags", [])
    ih = rec.get("interaction_history") or {}
    ih.setdefault("total_interactions", rec.get("interaction_count") or 0)
    ih.setdefault("last_interaction", rec.get("last_interaction"))
    ih.setdefault("avg_response_time_hours", None)
    ih.setdefault("channels", {})
    ih.setdefault("sentiment_trend", rec.get("sentiment_trend") or "neutral")
    ih.setdefault("topics_discussed", [])
    rec["interaction_history"] = ih
    np = rec.get("network_position") or {}
    np.setdefault("mutual_contacts", [])
    np.setdefault("groups_shared", [])
    np.setdefault("connector_score", 0.0)
    rec["network_position"] = np
    rec.setdefault("net_enriched_at", None)
    return rec


def _load_people() -> dict:
    cm = _contacts_mod()
    if cm is None:
        return _read_json(PEOPLE_FILE, {})
    try:
        return cm._load_people()  # type: ignore[attr-defined]
    except Exception:
        return _read_json(PEOPLE_FILE, {})


def _save_people(people: dict) -> None:
    cm = _contacts_mod()
    if cm is not None:
        try:
            cm._save_people(people)  # type: ignore[attr-defined]
            return
        except Exception:
            pass
    _write_json(PEOPLE_FILE, people)


def _canonical(name: str) -> str:
    cm = _contacts_mod()
    if cm is not None:
        try:
            return cm._canonical(name)  # type: ignore[attr-defined]
        except Exception:
            pass
    return re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).strip()


def _resolve(name: str, people: dict | None = None):
    cm = _contacts_mod()
    if cm is None:
        return None
    try:
        return cm._resolve(name, people)  # type: ignore[attr-defined]
    except Exception:
        return None


# ── Strength + trust computation ────────────────────────────────────
def _parse_iso(ts: str | None) -> float | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def _days_since(ts: str | None) -> float | None:
    t = _parse_iso(ts)
    if t is None:
        return None
    return max(0.0, (time.time() - t) / 86400.0)


def _frequency_score(rec: dict) -> float:
    """Saturating curve over 50 interactions — beyond that, strength is
    carried by recency and depth, not raw volume."""
    n = int(rec.get("interaction_count") or 0)
    return min(1.0, n / 50.0)


def _recency_score(rec: dict) -> float:
    days = _days_since(rec.get("last_interaction"))
    if days is None:
        return 0.1
    return max(0.0, math.exp(-days / STRENGTH_HALFLIFE_DAYS))


def _depth_score(rec: dict) -> float:
    """Weight by trust tier so labels survive periods of light contact —
    your spouse is a strong tie even on a quiet week."""
    tier = (rec.get("trust_level") or "acquaintance").lower()
    return TIER_WEIGHT.get(tier, 0.4)


def _reciprocity_score(rec: dict) -> float:
    """Channel diversity + balance proxy — multi-channel relationships score
    higher than single-channel ones at the same volume. Returns 0.5 when we
    don't have channel breakdown yet (neutral, doesn't penalize)."""
    ih = rec.get("interaction_history") or {}
    ch = ih.get("channels") or {}
    if not ch:
        return 0.5
    total = sum(v for v in ch.values() if isinstance(v, (int, float)))
    if total <= 0:
        return 0.5
    diversity = len([v for v in ch.values() if (v or 0) > 0]) / 3.0  # cap at 3 channels
    diversity = min(1.0, diversity)
    return round(0.5 * diversity + 0.5 * min(1.0, total / 30.0), 3)


def _compute_strength(rec: dict) -> float:
    """strength = 0.4 freq + 0.3 recency + 0.2 depth + 0.1 reciprocity."""
    s = (
        0.4 * _frequency_score(rec)
        + 0.3 * _recency_score(rec)
        + 0.2 * _depth_score(rec)
        + 0.1 * _reciprocity_score(rec)
    )
    return round(max(0.0, min(1.0, s)), 3)


def _infer_trust_level(rec: dict) -> str:
    """Map relationship label → tier; fall back to interaction-count heuristic."""
    label = (rec.get("relationship") or "").lower()
    if label:
        for tier, keywords in TRUST_LABEL_MAP.items():
            if any(kw in label for kw in keywords):
                return tier
    n = int(rec.get("interaction_count") or 0)
    days = _days_since(rec.get("last_interaction"))
    if days is None or days > 365:
        return "cold"
    if n >= 30:
        return "trusted"
    if n >= 10:
        return "professional"
    return "acquaintance"


def _infer_channels(rec: dict) -> dict:
    """Best-effort breakdown by counting how many fields look populated for
    each channel. Real numbers come from enrich_network's history pull."""
    out: dict[str, int] = {}
    ih = rec.get("interaction_history") or {}
    cur = ih.get("channels") or {}
    if cur:
        return {k: int(v) for k, v in cur.items() if isinstance(v, (int, float))}
    last_channel = rec.get("last_channel") or ""
    if last_channel:
        root = last_channel.split(":", 1)[0]
        out[root] = int(rec.get("interaction_count") or 0)
    return out


# ── Network search ──────────────────────────────────────────────────
_TOKENIZE_RE = re.compile(r"[a-z0-9]+")


def _tokens(text: str | None) -> list[str]:
    return _TOKENIZE_RE.findall((text or "").lower())


def _record_corpus(rec: dict) -> str:
    """Concatenate every searchable field into one string for substring scoring."""
    parts: list[str] = []
    for key in ("name", "relationship", "brief", "notes",
                "communication_preference", "sentiment_trend"):
        v = rec.get(key)
        if isinstance(v, str):
            parts.append(v)
        elif isinstance(v, list):
            parts.append(" ".join(str(x) for x in v))
    for key in ("skills", "expertise_areas", "can_intro_to", "tags",
                "topics_discussed", "open_threads", "talking_points"):
        v = rec.get(key) or []
        if isinstance(v, list):
            parts.append(" ".join(str(x) for x in v))
    ih = rec.get("interaction_history") or {}
    for t in ih.get("topics_discussed") or []:
        if isinstance(t, dict):
            parts.append(str(t.get("topic") or ""))
        else:
            parts.append(str(t))
    return " ".join(parts).lower()


def _match_score(query: str, rec: dict) -> tuple[float, list[str]]:
    """Return (score, reasons). Reasons explain why this record matched —
    used to surface the 'why' in the response so Watson knows what we keyed on."""
    if not query:
        return 0.0, []
    q = query.lower().strip()
    q_tokens = [t for t in _tokens(q) if len(t) > 2]
    score = 0.0
    reasons: list[str] = []

    skills = [s.lower() for s in (rec.get("skills") or [])]
    expertise = [s.lower() for s in (rec.get("expertise_areas") or [])]
    intros = [s.lower() for s in (rec.get("can_intro_to") or [])]
    tags = [s.lower() for s in (rec.get("tags") or [])]
    topics = []
    for t in rec.get("topics_discussed") or []:
        topics.append(str(t).lower())
    for t in (rec.get("interaction_history") or {}).get("topics_discussed") or []:
        if isinstance(t, dict):
            topics.append(str(t.get("topic") or "").lower())
        else:
            topics.append(str(t).lower())

    for label, weight, bag in (
        ("skill", 3.0, skills),
        ("expertise", 3.0, expertise),
        ("intro_target", 2.5, intros),
        ("tag", 2.0, tags),
        ("topic", 1.5, topics),
    ):
        for entry in bag:
            if not entry:
                continue
            if q in entry or entry in q:
                score += weight
                reasons.append(f"{label}: {entry}")
                continue
            ent_tokens = set(_tokens(entry))
            shared = ent_tokens & set(q_tokens)
            if shared:
                score += weight * 0.5 * (len(shared) / max(1, len(set(q_tokens))))
                reasons.append(f"{label}~{entry}")

    corpus = _record_corpus(rec)
    if q in corpus:
        score += 1.0
        reasons.append("brief/notes match")
    else:
        hits = sum(1 for t in q_tokens if t in corpus)
        if hits:
            score += 0.5 * (hits / max(1, len(q_tokens)))
            reasons.append(f"{hits}/{len(q_tokens)} term hits")

    # Boost by relationship strength so a weak connection that name-matches
    # doesn't outrank a strong one.
    strength = float(rec.get("relationship_strength") or 0.0)
    score *= 1.0 + 0.6 * strength
    return round(score, 3), reasons[:5]


def _result_card(key: str, rec: dict, score: float | None = None,
                 reasons: list[str] | None = None) -> dict:
    return {
        "key": key,
        "name": rec.get("name"),
        "trust_level": rec.get("trust_level"),
        "relationship": rec.get("relationship"),
        "relationship_strength": rec.get("relationship_strength"),
        "skills": rec.get("skills") or [],
        "expertise_areas": rec.get("expertise_areas") or [],
        "can_intro_to": rec.get("can_intro_to") or [],
        "last_interaction": rec.get("last_interaction"),
        "last_channel": rec.get("last_channel"),
        "communication_preference": rec.get("communication_preference"),
        "brief": rec.get("brief"),
        "tags": rec.get("tags") or [],
        "match_score": score,
        "match_reasons": reasons or [],
    }


def network_search(query: str, filters: dict | None = None,
                   limit: int = 10) -> dict:
    """Semantic search across the network. Returns ranked candidates with
    reasoning. `filters` keys: trust_level (str | list), tags (list),
    min_strength (float), channel (str), recency_days (int)."""
    gate = _gate_check()
    if gate:
        return gate
    started = time.monotonic()
    people = _load_people()
    if not people:
        _emit("network_search", "skipped",
              context={"query": query[:80], "reason": "no contacts"})
        return {"ok": True, "query": query, "results": [],
                "count": 0, "reason": "no contacts on file"}

    filt = filters or {}
    desired_tiers = filt.get("trust_level")
    if isinstance(desired_tiers, str):
        desired_tiers = [desired_tiers]
    desired_tags = [t.lower() for t in (filt.get("tags") or [])]
    min_strength = float(filt.get("min_strength") or 0.0)
    channel = (filt.get("channel") or "").lower() or None
    recency_days = filt.get("recency_days")
    try:
        recency_days = float(recency_days) if recency_days is not None else None
    except (TypeError, ValueError):
        recency_days = None

    scored: list[tuple[float, str, dict, list[str]]] = []
    for key, rec in people.items():
        rec = _ensure_network_fields(rec)
        if desired_tiers and (rec.get("trust_level") not in desired_tiers):
            continue
        if desired_tags:
            tags = [t.lower() for t in (rec.get("tags") or [])]
            if not all(t in tags for t in desired_tags):
                continue
        strength = float(rec.get("relationship_strength") or 0.0)
        if strength < min_strength:
            continue
        if channel:
            ih_channels = (rec.get("interaction_history") or {}).get("channels") or {}
            last_ch = (rec.get("last_channel") or "").split(":", 1)[0]
            if not (channel in ih_channels or last_ch == channel):
                continue
        if recency_days is not None:
            d = _days_since(rec.get("last_interaction"))
            if d is None or d > recency_days:
                continue

        if query.strip():
            score, reasons = _match_score(query, rec)
            if score <= 0.0:
                continue
        else:
            # No query → rank by relationship_strength (filter-only mode).
            score = strength * 5.0
            reasons = [f"strength {strength:.2f}"]
        scored.append((score, key, rec, reasons))

    scored.sort(key=lambda t: (-t[0], -float(t[2].get("relationship_strength") or 0.0)))
    top = scored[:max(1, int(limit))]
    results = [_result_card(k, r, score=s, reasons=rs) for s, k, r, rs in top]
    latency = (time.monotonic() - started) * 1000
    _emit("network_search", "success",
          context={"query": query[:80], "filters": filt, "hits": len(results)},
          latency_ms=int(latency))
    return {
        "ok": True,
        "query": query,
        "filters": filt,
        "count": len(results),
        "results": results,
    }


# ── Network map ─────────────────────────────────────────────────────
def network_map(focus: str | None = None, limit: int = 20) -> dict:
    """Network overview. With no focus, returns top contacts grouped by
    trust tier — `the lay of my network`. With focus, returns who's
    relevant to that focus + how to approach them."""
    gate = _gate_check()
    if gate:
        return gate
    people = _load_people()
    if not people:
        return {"ok": True, "focus": focus, "summary": "no contacts on file",
                "sections": []}

    if focus and focus.strip():
        # Focus mode — search + structure with suggested order
        search_res = network_search(focus, limit=limit)
        results = search_res.get("results") or []
        if not results:
            return {
                "ok": True,
                "focus": focus,
                "summary": f"No one in your network maps to {focus!r} yet.",
                "sections": [],
            }
        # Sort the matches by a blended score (match * strength) for the
        # suggested approach order.
        approach_order = sorted(
            results,
            key=lambda r: (r.get("match_score") or 0)
                          * (1 + float(r.get("relationship_strength") or 0)),
            reverse=True,
        )
        section = {
            "title": f"Relevant to {focus!r}",
            "count": len(results),
            "people": approach_order,
        }
        summary = (
            f"{len(results)} contact{'s' if len(results) != 1 else ''} match {focus!r}. "
            f"Strongest fit: {approach_order[0].get('name')} "
            f"({approach_order[0].get('trust_level')}, "
            f"strength {approach_order[0].get('relationship_strength')})."
        )
        return {"ok": True, "focus": focus, "summary": summary, "sections": [section]}

    # No focus: stratify by trust tier.
    tiers: dict[str, list[dict]] = {t: [] for t in VALID_TIERS}
    for key, rec in people.items():
        rec = _ensure_network_fields(rec)
        tier = rec.get("trust_level") or "acquaintance"
        if tier not in tiers:
            tier = "acquaintance"
        tiers[tier].append(_result_card(key, rec))
    for tier in tiers:
        tiers[tier].sort(
            key=lambda r: -(float(r.get("relationship_strength") or 0)),
        )
    sections = []
    total = 0
    for tier in VALID_TIERS:
        people_in_tier = tiers[tier][:limit]
        if not people_in_tier:
            continue
        sections.append({
            "title": tier.replace("_", " ").title(),
            "tier": tier,
            "count": len(tiers[tier]),
            "people": people_in_tier,
        })
        total += len(tiers[tier])
    summary = (
        f"{total} contact{'s' if total != 1 else ''} on file across "
        f"{len(sections)} tier{'s' if len(sections) != 1 else ''}."
    )
    return {"ok": True, "focus": None, "summary": summary, "sections": sections}


# ── Relationship score (single-person deep dive) ────────────────────
def _trajectory(rec: dict, history: dict | None) -> str:
    """growing | stable | fading — heuristic on recency vs older activity."""
    days = _days_since(rec.get("last_interaction"))
    tier = rec.get("trust_level") or "acquaintance"
    threshold = FADING_THRESHOLDS_DAYS.get(tier, 90)
    if days is None:
        return "stable"
    if days > threshold:
        return "fading"
    history = history or {}
    em = history.get("email") or []
    tg = history.get("telegram") or []
    msgs = sorted(
        [m for m in em + tg if m.get("ts")],
        key=lambda m: m.get("ts") or 0,
        reverse=True,
    )
    if len(msgs) < 4:
        return "stable"
    half = len(msgs) // 2
    recent_avg = sum(m["ts"] for m in msgs[:half]) / max(1, half)
    older_avg = sum(m["ts"] for m in msgs[half:]) / max(1, len(msgs) - half)
    # Compare gaps between consecutive messages — shorter recent gap → growing.
    if recent_avg - older_avg > 30 * 86400:
        return "growing"
    return "stable"


def _suggested_action(rec: dict, trajectory: str) -> dict:
    """Propose the next concrete move and channel."""
    tier = rec.get("trust_level") or "acquaintance"
    pref = rec.get("communication_preference") or rec.get("last_channel") or "email"
    open_threads = rec.get("open_threads") or []
    if open_threads:
        return {
            "action": f"Close out: {open_threads[0]}",
            "channel": pref,
            "urgency": "high" if trajectory == "fading" else "normal",
        }
    if trajectory == "fading":
        return {
            "action": "Reach out — relationship is fading",
            "channel": pref,
            "urgency": "high" if tier in ("inner_circle", "trusted") else "normal",
        }
    talking = rec.get("talking_points") or []
    if talking:
        return {
            "action": f"Open with: {talking[0]}",
            "channel": pref,
            "urgency": "normal",
        }
    return {
        "action": "Maintain — no specific thread waiting",
        "channel": pref,
        "urgency": "low",
    }


def relationship_score(name: str) -> dict:
    """Deep one-person snapshot. Pulls from contacts, computes strength
    + trajectory, and proposes the next action."""
    gate = _gate_check()
    if gate:
        return gate
    if not name:
        return {"error": "name is required"}
    cm = _contacts_mod()
    if cm is None:
        return {"error": "jarvis-contacts module not available"}
    started = time.monotonic()
    people = _load_people()
    hit = _resolve(name, people)
    if not hit:
        _emit("relationship_score", "skipped",
              context={"name": name[:80], "reason": "not found"})
        return {"ok": False, "found": False, "query": name}
    key, rec = hit
    rec = _ensure_network_fields(rec)

    history = {"email": [], "telegram": [], "memory": []}
    try:
        history["email"] = cm._email_history(rec) or []  # type: ignore[attr-defined]
    except Exception:
        pass
    try:
        history["telegram"] = cm._telegram_history(rec) or []  # type: ignore[attr-defined]
    except Exception:
        pass
    try:
        history["memory"] = cm._memory_recall(rec.get("name") or name) or []  # type: ignore[attr-defined]
    except Exception:
        pass

    # Refresh the rolling counters from the harvested history before scoring,
    # so the snapshot reflects the live state.
    em_count = len(history["email"])
    tg_count = len(history["telegram"])
    if em_count or tg_count:
        rec["interaction_count"] = max(rec.get("interaction_count") or 0,
                                       em_count + tg_count)
        ih = rec.get("interaction_history") or {}
        ih.setdefault("channels", {})
        if em_count:
            ih["channels"]["email"] = em_count
        if tg_count:
            ih["channels"]["telegram"] = tg_count
        rec["interaction_history"] = ih

    rec["trust_level"] = rec.get("trust_level") or _infer_trust_level(rec)
    rec["relationship_strength"] = _compute_strength(rec)
    trajectory = _trajectory(rec, history)
    action = _suggested_action(rec, trajectory)

    # Persist the freshly-scored record so subsequent reads see it.
    people[key] = rec
    _save_people(people)

    latency = (time.monotonic() - started) * 1000
    _emit("relationship_score", "success",
          context={"name": rec.get("name"), "trajectory": trajectory,
                   "strength": rec.get("relationship_strength")},
          latency_ms=int(latency))

    components = {
        "frequency": round(_frequency_score(rec), 3),
        "recency": round(_recency_score(rec), 3),
        "depth": round(_depth_score(rec), 3),
        "reciprocity": round(_reciprocity_score(rec), 3),
    }
    days_since = _days_since(rec.get("last_interaction"))
    return {
        "ok": True,
        "found": True,
        "name": rec.get("name"),
        "trust_level": rec.get("trust_level"),
        "relationship": rec.get("relationship"),
        "relationship_strength": rec.get("relationship_strength"),
        "components": components,
        "trajectory": trajectory,
        "days_since_last_interaction": round(days_since, 1) if days_since is not None else None,
        "last_interaction": rec.get("last_interaction"),
        "last_channel": rec.get("last_channel"),
        "communication_preference": rec.get("communication_preference"),
        "open_threads": rec.get("open_threads") or [],
        "talking_points": rec.get("talking_points") or [],
        "topics_discussed": rec.get("topics_discussed") or [],
        "skills": rec.get("skills") or [],
        "expertise_areas": rec.get("expertise_areas") or [],
        "tags": rec.get("tags") or [],
        "interaction_count": rec.get("interaction_count") or 0,
        "history_pulled": {
            "email": em_count, "telegram": tg_count,
            "memory": len(history["memory"]),
        },
        "next_action": action,
        "brief": rec.get("brief"),
    }


# ── network_suggest (Sonnet strategy) ───────────────────────────────
SUGGEST_SYSTEM = """You are JARVIS's network strategist. Watson tells you a goal; you propose an actionable plan that leverages people in his network.

Output ONE valid JSON object — no prose, no fences:

{
  "strategy": "2-3 sentences on the overall play, voice-ready (will be spoken).",
  "approach_order": [
    {
      "name": "exact name from the network slice",
      "reason": "why this person, one sentence",
      "channel": "email | telegram | social | call | in_person",
      "first_move": "concrete opening — what Watson should say or send"
    }
  ],
  "fallback": "what to do if the primary path stalls (one sentence)",
  "watch_outs": ["risks / things to avoid, each one short — empty list if none"]
}

Rules:
- Pick people ONLY from the supplied network slice. Never invent names.
- Order matters — strongest-fit first, but consider relationship strength,
  trust, and what each person can actually do.
- Keep approach_order short (2-4 entries). Watson's time is finite.
- Be concrete: "Ask Corbin to introduce you to Lauren" beats "leverage Corbin's network".
- If the network slice doesn't contain anyone strong for the goal, say so:
  approach_order=[], strategy explains the gap and suggests adding contacts.
"""


def _anthropic_call(api_key: str, model: str, system: str, user_text: str,
                    max_tokens: int = 1200, timeout: float = 25.0) -> str:
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
            return "\n".join(b.get("text", "") for b in blocks
                             if b.get("type") == "text").strip()
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


def _extract_first_json(text: str) -> dict | None:
    if not text:
        return None
    fence = re.search(r"```(?:json)?\s*\n(.+?)\n```", text, re.DOTALL)
    if fence:
        try:
            return json.loads(fence.group(1))
        except json.JSONDecodeError:
            pass
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def _build_suggest_prompt(goal: str, slice_results: list[dict]) -> str:
    lines = [f"GOAL: {goal.strip()}", ""]
    if not slice_results:
        lines.append("NETWORK SLICE: (empty — no relevant contacts found)")
        return "\n".join(lines)
    lines.append("NETWORK SLICE (most relevant first):")
    for r in slice_results:
        bits = [f"- {r.get('name')}"]
        bits.append(f"trust={r.get('trust_level')}")
        s = r.get("relationship_strength")
        if s is not None:
            bits.append(f"strength={s}")
        if r.get("relationship"):
            bits.append(f"label={r['relationship']}")
        if r.get("skills"):
            bits.append("skills=" + ", ".join(r["skills"][:5]))
        if r.get("expertise_areas"):
            bits.append("expertise=" + ", ".join(r["expertise_areas"][:5]))
        if r.get("can_intro_to"):
            bits.append("intros=" + ", ".join(r["can_intro_to"][:5]))
        if r.get("last_interaction"):
            bits.append(f"last={r['last_interaction'][:10]}")
        if r.get("communication_preference"):
            bits.append(f"prefers={r['communication_preference']}")
        if r.get("brief"):
            bits.append("brief=" + (r["brief"][:200] or "").replace("\n", " "))
        lines.append("  ".join(bits))
    return "\n".join(lines)


def network_suggest(goal: str) -> dict:
    """Sonnet-driven strategy: who to leverage and how, grounded in the
    actual network. Falls back to a search-only response if no API key."""
    gate = _gate_check()
    if gate:
        return gate
    goal = (goal or "").strip()
    if not goal:
        return {"error": "goal is required"}

    started = time.monotonic()
    search = network_search(goal, limit=8)
    slice_results = search.get("results") or []
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        # Heuristic fallback so the tool stays useful offline.
        if not slice_results:
            return {
                "ok": True,
                "goal": goal,
                "strategy": "No one in your network maps directly to this goal yet.",
                "approach_order": [],
                "fallback": "Add candidates with --add or jarvis-recall, then re-ask.",
                "watch_outs": [],
                "slice": [],
            }
        approach = []
        for r in slice_results[:4]:
            approach.append({
                "name": r.get("name"),
                "reason": "; ".join(r.get("match_reasons") or []) or "strong fit",
                "channel": r.get("communication_preference") or "email",
                "first_move": (r.get("talking_points") or [None])[0]
                              or "Open with current context.",
            })
        return {
            "ok": True,
            "goal": goal,
            "strategy": (
                f"Lead with {approach[0]['name']} — the closest fit by skills "
                "and current strength."
            ),
            "approach_order": approach,
            "fallback": "Cycle to the next-highest match if no response in 48h.",
            "watch_outs": [],
            "slice": slice_results,
            "model_used": "fallback (no API key)",
        }

    prompt = _build_suggest_prompt(goal, slice_results)
    try:
        raw = _anthropic_call(api_key, SUGGEST_MODEL, SUGGEST_SYSTEM, prompt,
                              max_tokens=1200, timeout=25.0)
    except Exception as e:
        _emit("network_suggest", "failed",
              context={"goal": goal[:80], "reason": str(e)[:200]})
        return {"error": f"suggest call failed: {e}"}

    parsed = _extract_first_json(raw) or {}
    parsed.setdefault("strategy", "")
    parsed.setdefault("approach_order", [])
    parsed.setdefault("fallback", "")
    parsed.setdefault("watch_outs", [])
    latency = (time.monotonic() - started) * 1000
    _emit("network_suggest", "success",
          context={"goal": goal[:80],
                   "approach_count": len(parsed.get("approach_order") or [])},
          latency_ms=int(latency))
    return {
        "ok": True,
        "goal": goal,
        "strategy": parsed.get("strategy"),
        "approach_order": parsed.get("approach_order") or [],
        "fallback": parsed.get("fallback"),
        "watch_outs": parsed.get("watch_outs") or [],
        "slice": slice_results,
        "model_used": SUGGEST_MODEL,
    }


# ── Skill / expertise extraction (Haiku) ────────────────────────────
SKILLS_SYSTEM = """You are extracting professional signals about someone Watson knows. Output ONE valid JSON object — no prose, no fences:

{
  "skills": ["concrete capabilities — 'react frontend', 'B2B sales', 'fundraising'. Skip generic adjectives. Empty list if not evident."],
  "expertise_areas": ["domains they appear to know deeply — 'B2B SaaS', 'HVAC', 'investor relations'. Empty if unclear."],
  "can_intro_to": ["people / orgs they mentioned knowing or being able to connect Watson to. Empty if none mentioned."],
  "tags": ["short labels Watson can filter on — 'pitch_target', 'advisor', 'customer', 'recruit'. Empty if unclear."]
}

Rules:
- Ground every entry in the evidence — never invent.
- Be specific: "raised seed at PostHog" → can_intro_to: ["PostHog team"], skills: ["fundraising"].
- Each list ≤ 6 entries, each entry ≤ 5 words.
- If evidence is thin (1-2 messages), most lists will be empty — that's fine."""


def _build_skills_prompt(rec: dict, history: dict) -> str:
    parts = [f"Name: {rec.get('name')}"]
    if rec.get("relationship"):
        parts.append(f"Label: {rec['relationship']}")
    if rec.get("brief"):
        parts.append(f"Brief: {rec['brief']}")
    em = history.get("email") or []
    tg = history.get("telegram") or []
    mem = history.get("memory") or []
    if em:
        parts.append("\nEmail subjects + snippets (recent first):")
        for e in em[:12]:
            ts = (datetime.fromtimestamp(e["ts"]).strftime("%Y-%m-%d")
                  if e.get("ts") else "?")
            parts.append(
                f"  [{ts}] {e.get('subject') or ''}: {e.get('snippet') or ''}"
            )
    if tg:
        parts.append("\nTelegram messages (recent first):")
        for t in tg[:12]:
            ts = (datetime.fromtimestamp(t["ts"]).strftime("%Y-%m-%d")
                  if t.get("ts") else "?")
            parts.append(f"  [{ts}] {t.get('text') or ''}")
    if mem:
        parts.append("\nWatson's memory entries about them:")
        for m in mem[:6]:
            parts.append(f"  [{m.get('created_at','')[:10]}] {m.get('text','')}")
    if rec.get("notes"):
        parts.append("\nExisting notes:\n- " + "\n- ".join(rec["notes"][:6]))
    return "\n".join(parts)


def _infer_skills(rec: dict, history: dict, api_key: str) -> dict:
    """Return {skills, expertise_areas, can_intro_to, tags}. Empty on failure."""
    if not api_key:
        return {}
    prompt = _build_skills_prompt(rec, history)
    if not prompt.strip():
        return {}
    try:
        raw = _anthropic_call(api_key, SKILLS_MODEL, SKILLS_SYSTEM, prompt,
                              max_tokens=400, timeout=20.0)
    except Exception as e:
        _log(f"skills inference failed for {rec.get('name')}: {e}")
        return {}
    parsed = _extract_first_json(raw) or {}
    return {
        "skills": parsed.get("skills") or [],
        "expertise_areas": parsed.get("expertise_areas") or [],
        "can_intro_to": parsed.get("can_intro_to") or [],
        "tags": parsed.get("tags") or [],
    }


# ── Mutual contacts / shared groups ─────────────────────────────────
def _compute_mutuals(people: dict) -> dict:
    """Build the mutual-contacts graph. Two people are mutual if either
    appears in the other's notes / brief / can_intro_to / open_threads, OR
    they share a known group via Telegram. Coarse but useful as a hint."""
    name_index: dict[str, str] = {}
    for key, rec in people.items():
        nm = (rec.get("name") or "").strip()
        if nm:
            name_index[_canonical(nm)] = key
    mentions: dict[str, set[str]] = {key: set() for key in people}
    for key, rec in people.items():
        text_blob = " ".join(filter(None, [
            rec.get("brief") or "",
            " ".join(rec.get("notes") or []),
            " ".join(rec.get("can_intro_to") or []),
            " ".join(rec.get("open_threads") or []),
        ])).lower()
        for canon, other_key in name_index.items():
            if other_key == key:
                continue
            if not canon or len(canon) < 3:
                continue
            if re.search(r"\b" + re.escape(canon) + r"\b", text_blob):
                mentions[key].add(other_key)
                mentions[other_key].add(key)
    return {k: sorted(v) for k, v in mentions.items()}


def _enrich_one(key: str, rec: dict, mutuals: dict, api_key: str,
                force: bool = False) -> bool:
    """Update one record in place. Returns True if any field changed."""
    changed = False
    rec = _ensure_network_fields(rec)

    cm = _contacts_mod()
    history = {"email": [], "telegram": [], "memory": []}
    if cm is not None:
        try:
            history["email"] = cm._email_history(rec) or []  # type: ignore[attr-defined]
        except Exception:
            pass
        try:
            history["telegram"] = cm._telegram_history(rec) or []  # type: ignore[attr-defined]
        except Exception:
            pass
        try:
            history["memory"] = cm._memory_recall(rec.get("name") or "") or []  # type: ignore[attr-defined]
        except Exception:
            pass

    em_count = len(history["email"])
    tg_count = len(history["telegram"])
    if em_count or tg_count:
        rec["interaction_count"] = max(rec.get("interaction_count") or 0,
                                       em_count + tg_count)
        ih = rec["interaction_history"]
        ih_channels = ih.get("channels") or {}
        if em_count:
            ih_channels["email"] = em_count
        if tg_count:
            ih_channels["telegram"] = tg_count
        ih["channels"] = ih_channels
        ih["total_interactions"] = rec["interaction_count"]
        # Keep the harvested newest timestamp as last_interaction.
        latest = 0
        latest_ch = rec.get("last_channel")
        if history["email"]:
            ts = history["email"][0].get("ts") or 0
            if ts > latest:
                latest = ts
                latest_ch = "email"
        if history["telegram"]:
            ts = history["telegram"][0].get("ts") or 0
            if ts > latest:
                latest = ts
                latest_ch = "telegram"
        if latest:
            iso = (datetime.fromtimestamp(latest).astimezone()
                   .isoformat(timespec="seconds"))
            if rec.get("last_interaction") != iso:
                rec["last_interaction"] = iso
                changed = True
            rec["last_channel"] = latest_ch
            ih["last_interaction"] = iso
        changed = True

    # Skills inference — Haiku call. Only run when forced or never run.
    needs_skills = force or not rec.get("net_enriched_at")
    if needs_skills and api_key:
        inferred = _infer_skills(rec, history, api_key)
        if inferred:
            for k in ("skills", "expertise_areas", "can_intro_to", "tags"):
                merged = list(dict.fromkeys((rec.get(k) or [])
                                            + (inferred.get(k) or [])))
                if merged != (rec.get(k) or []):
                    rec[k] = merged
                    changed = True

    # Mutuals
    mlist = mutuals.get(key) or []
    if mlist != (rec["network_position"].get("mutual_contacts") or []):
        rec["network_position"]["mutual_contacts"] = mlist
        # Connector score: more mutuals + more intro_targets → higher.
        intro_count = len(rec.get("can_intro_to") or [])
        rec["network_position"]["connector_score"] = round(
            min(1.0, len(mlist) / 10.0 + intro_count / 10.0), 3,
        )
        changed = True

    # Trust level + strength always recomputed (cheap, deterministic).
    new_tier = _infer_trust_level(rec)
    if new_tier != rec.get("trust_level"):
        rec["trust_level"] = new_tier
        changed = True
    new_strength = _compute_strength(rec)
    if new_strength != rec.get("relationship_strength"):
        rec["relationship_strength"] = new_strength
        changed = True

    rec["net_enriched_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    return changed


def enrich_network(force: bool = False, cap: int | None = None) -> dict:
    """Sweep across the network. Refreshes strength + trust on every record;
    runs the Haiku skills extraction for those that haven't been net-enriched
    or when force=True. Caps Haiku calls at JARVIS_NETWORK_BATCH_CAP per pass
    so a single weekly run doesn't blow the budget on a large network."""
    gate = _gate_check()
    if gate:
        return gate
    started = time.monotonic()
    people = _load_people()
    if not people:
        return {"ok": True, "enriched": 0, "skipped": 0,
                "reason": "no contacts on file"}
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    cap = cap if cap is not None else BATCH_CAP

    # One mutual-graph pass for the whole network (cheap, all in-memory).
    mutuals = _compute_mutuals(people)

    enriched = 0
    skipped = 0
    skill_calls = 0
    errors: list[str] = []
    for key, rec in people.items():
        try:
            needs_skills = force or not rec.get("net_enriched_at")
            if needs_skills and skill_calls >= cap and api_key:
                # Refresh strength/trust + mutuals without the Haiku call;
                # we'll pick up skills next run.
                changed = _enrich_one(key, rec, mutuals, api_key="", force=False)
            else:
                if needs_skills and api_key:
                    skill_calls += 1
                changed = _enrich_one(key, rec, mutuals, api_key, force=force)
            if changed:
                enriched += 1
            else:
                skipped += 1
        except Exception as e:
            errors.append(f"{rec.get('name')}: {e}")

    _save_people(people)

    # Persist the network-level cache for fast lookups elsewhere.
    summary_cache = {
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "people_count": len(people),
        "by_tier": {t: 0 for t in VALID_TIERS},
        "fading": [],
        "mutual_graph": mutuals,
    }
    for rec in people.values():
        tier = rec.get("trust_level") or "acquaintance"
        if tier not in summary_cache["by_tier"]:
            tier = "acquaintance"
        summary_cache["by_tier"][tier] += 1
    _write_json(NETWORK_FILE, summary_cache)

    # Refresh alerts as part of every enrich pass — keeps the briefing
    # section in sync with the data.
    try:
        network_alerts(refresh=True)
    except Exception:
        pass

    latency = (time.monotonic() - started) * 1000
    _emit("enrich_network", "success" if not errors else "failed",
          context={"enriched": enriched, "skipped": skipped,
                   "skill_calls": skill_calls, "errors": errors[:5]},
          latency_ms=int(latency))
    return {
        "ok": True,
        "enriched": enriched,
        "skipped": skipped,
        "skill_calls": skill_calls,
        "errors": errors,
    }


# ── Alerts ──────────────────────────────────────────────────────────
def _alert_record(kind: str, name: str, message: str,
                  priority: str = "normal", **extra) -> dict:
    base = {
        "kind": kind,
        "name": name,
        "message": message,
        "priority": priority,
        "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    base.update(extra)
    return base


_INTRO_RE = re.compile(
    r"\b(can intro|introduce you|knows? someone at|connect you with|"
    r"put you in touch|hook you up with)\b", re.I,
)


def _generate_alerts(people: dict) -> list[dict]:
    alerts: list[dict] = []
    for key, rec in people.items():
        rec = _ensure_network_fields(rec)
        tier = rec.get("trust_level") or "acquaintance"
        days = _days_since(rec.get("last_interaction"))
        threshold = FADING_THRESHOLDS_DAYS.get(tier)

        # Fading — only meaningful for the closer tiers.
        if (threshold is not None and days is not None
                and days > threshold and tier in ("inner_circle", "trusted")):
            priority = "high" if tier == "inner_circle" else "normal"
            alerts.append(_alert_record(
                "fading", rec.get("name"),
                f"You haven't talked to {rec.get('name')} in "
                f"{int(days)} days — {tier.replace('_', ' ')}.",
                priority=priority,
                key=key, days=int(days), tier=tier,
            ))

        # Open threads → follow-ups
        for thread in (rec.get("open_threads") or [])[:3]:
            if not thread:
                continue
            alerts.append(_alert_record(
                "follow_up", rec.get("name"),
                f"Open thread with {rec.get('name')}: {thread}",
                priority="normal",
                key=key, thread=thread,
            ))

        # Intro opportunities — surface if their notes/brief mention a possible intro
        haystack = " ".join(filter(None, [
            rec.get("brief") or "",
            " ".join(rec.get("notes") or []),
        ]))
        if haystack and _INTRO_RE.search(haystack):
            for intro_target in (rec.get("can_intro_to") or [])[:2]:
                alerts.append(_alert_record(
                    "intro_opportunity", rec.get("name"),
                    f"{rec.get('name')} mentioned a path to {intro_target}.",
                    priority="low",
                    key=key, target=intro_target,
                ))

    # Sort: high → normal → low, then newest first.
    rank = {"high": 0, "normal": 1, "low": 2}
    alerts.sort(key=lambda a: (rank.get(a["priority"], 3), a["ts"]),
                reverse=False)
    return alerts


def network_alerts(refresh: bool = False) -> dict:
    """Return the current alert list. By default reads the cached file
    (cheap); refresh=True recomputes from people.json."""
    gate = _gate_check()
    if gate:
        return gate
    if not refresh:
        cached = _read_json(ALERTS_FILE, None)
        if isinstance(cached, dict) and "alerts" in cached:
            return {"ok": True, "alerts": cached["alerts"],
                    "count": len(cached["alerts"]),
                    "computed_at": cached.get("computed_at")}
    people = _load_people()
    alerts = _generate_alerts(people) if people else []
    rec = {
        "computed_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "alerts": alerts,
    }
    _write_json(ALERTS_FILE, rec)
    return {"ok": True, "alerts": alerts, "count": len(alerts),
            "computed_at": rec["computed_at"]}


# ── Briefing helper ─────────────────────────────────────────────────
def relationship_alerts_section() -> str:
    """Markdown block for jarvis-briefing. Returns "" when nothing is
    actionable so the briefing stays clean on quiet days."""
    if os.environ.get("JARVIS_NETWORK", "1") != "1":
        return ""
    res = network_alerts(refresh=False)
    items = res.get("alerts") or []
    if not items:
        return ""
    actionable = [a for a in items
                  if a.get("priority") in ("high", "normal")][:5]
    if not actionable:
        return ""
    lines = ["## Relationship Alerts\n"]
    for a in actionable:
        kind = a.get("kind") or ""
        prio = a.get("priority") or "normal"
        marker = "🔴" if prio == "high" else ("🟡" if prio == "normal" else "·")
        lines.append(f"- {marker} **{kind.replace('_', ' ').title()}** — "
                     f"{a.get('message')}")
    return "\n".join(lines) + "\n"


# ── Notifications hook ──────────────────────────────────────────────
def push_alerts_to_notifications() -> dict:
    """Forward fresh alerts onto the smart notification bus. Idempotent —
    we only push alerts that are new since the last push (tracked by ts)."""
    gate = _gate_check()
    if gate:
        return gate
    state_path = ASSISTANT_DIR / "state" / "network_alerts_pushed.json"
    state = _read_json(state_path, {"last_pushed": None}) or {}
    last_pushed = state.get("last_pushed")
    res = network_alerts(refresh=True)
    items = res.get("alerts") or []
    new_items: list[dict] = []
    for a in items:
        if last_pushed and a.get("ts") and a["ts"] <= last_pushed:
            continue
        new_items.append(a)

    notif_src = BIN_DIR / "jarvis-notifications.py"
    if not notif_src.exists():
        notif_src = Path(__file__).parent / "jarvis-notifications.py"
    if not notif_src.exists() or not new_items:
        if new_items:
            state["last_pushed"] = max(a["ts"] for a in new_items)
            _write_json(state_path, state)
        return {"ok": True, "pushed": 0,
                "reason": "no notifications module" if not notif_src.exists()
                          else "no new alerts"}

    try:
        spec = importlib.util.spec_from_file_location(
            "jarvis_notifications_for_network", notif_src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
    except Exception as e:
        _log(f"notification module load failed: {e}")
        return {"error": f"notifications load failed: {e}"}

    pushed = 0
    for a in new_items:
        priority = a.get("priority") or "normal"
        time_sensitivity = 3 if priority == "high" else (1 if priority == "normal" else 0)
        try:
            mod.enqueue(
                source="network",
                content=a.get("message") or "",
                sender=a.get("name"),
                urgency_keywords=[a.get("kind") or "network"],
                time_sensitivity=time_sensitivity,
            )
            pushed += 1
        except Exception as e:
            _log(f"enqueue failed for alert: {e}")

    if new_items:
        state["last_pushed"] = max(a["ts"] for a in new_items)
        _write_json(state_path, state)
    return {"ok": True, "pushed": pushed, "total": len(new_items)}


# ── Context hint ────────────────────────────────────────────────────
def context_hint() -> str:
    """One-liner for jarvis-context.py — only fires when actionable, high-
    priority alerts are pending. Empty otherwise so the cache stays warm."""
    if os.environ.get("JARVIS_NETWORK", "1") != "1":
        return ""
    res = network_alerts(refresh=False)
    items = res.get("alerts") or []
    if not items:
        return ""
    high = [a for a in items if a.get("priority") == "high"]
    fading = [a for a in items if a.get("kind") == "fading"]
    follow = [a for a in items if a.get("kind") == "follow_up"]
    bits = []
    if high:
        names = ", ".join(a.get("name") or "" for a in high[:3])
        bits.append(f"{len(high)} high-priority ({names})")
    if fading and not high:
        bits.append(f"{len(fading)} fading")
    if follow:
        bits.append(f"{len(follow)} follow-up{'s' if len(follow) != 1 else ''} pending")
    if not bits:
        return ""
    return (
        "**Network:** " + "; ".join(bits) + ". If Watson asks about a person "
        "by name, lead with `relationship_score`; for goals or strategy, "
        "use `network_suggest`."
    )


# ── Mention-aware context hint (for jarvis-context name injection) ──
def name_context_hint(user_text: str) -> str:
    """When Watson's current message names a contact, surface a one-line
    relationship reminder so the model has it without burning a tool call.
    Returns "" when nothing matches — keeps it cheap."""
    if not user_text or os.environ.get("JARVIS_NETWORK", "1") != "1":
        return ""
    people = _load_people()
    if not people:
        return ""
    text_lower = user_text.lower()
    matched: list[dict] = []
    for key, rec in people.items():
        name = (rec.get("name") or "").strip()
        if not name:
            continue
        # Only match on whole-word name occurrences to avoid false hits like
        # "lauren" matching "laurence".
        first = name.split()[0]
        if not first or len(first) < 3:
            continue
        if re.search(r"\b" + re.escape(first.lower()) + r"\b", text_lower):
            matched.append(_ensure_network_fields(rec))
        if len(matched) >= 3:
            break
    if not matched:
        return ""
    lines = []
    for rec in matched:
        days = _days_since(rec.get("last_interaction"))
        days_phrase = (f", {int(days)}d since last contact"
                       if days is not None else "")
        tier = rec.get("trust_level") or "acquaintance"
        rel = rec.get("relationship") or tier.replace("_", " ")
        lines.append(
            f"- **{rec.get('name')}** ({rel}, strength "
            f"{rec.get('relationship_strength')}{days_phrase})"
        )
    return "**Named contacts in this turn:**\n" + "\n".join(lines)


# ── Status ──────────────────────────────────────────────────────────
def status() -> dict:
    people = _load_people()
    cache = _read_json(NETWORK_FILE, {})
    alerts = (network_alerts(refresh=False).get("alerts") or [])
    by_tier: dict[str, int] = {}
    fresh = stale = 0
    for rec in people.values():
        tier = rec.get("trust_level") or "acquaintance"
        by_tier[tier] = by_tier.get(tier, 0) + 1
        en = rec.get("net_enriched_at")
        if en:
            age = _days_since(en)
            if age is not None and age < (ENRICH_INTERVAL_S / 86400):
                fresh += 1
            else:
                stale += 1
        else:
            stale += 1
    return {
        "ok": True,
        "people_count": len(people),
        "by_tier": by_tier,
        "alerts": len(alerts),
        "fresh": fresh,
        "stale": stale,
        "cache_path": str(NETWORK_FILE),
        "alerts_path": str(ALERTS_FILE),
        "people_path": str(PEOPLE_FILE),
        "last_enriched": cache.get("updated_at"),
    }


# ── jarvis-improve hook ─────────────────────────────────────────────
def main() -> int:
    """Entrypoint for jarvis-improve weekly pass. Refreshes the network
    layer + pushes new alerts onto the notification bus. Soft-fails — never
    breaks the daemon chain."""
    if os.environ.get("JARVIS_NETWORK", "1") != "1":
        return 0
    try:
        res = enrich_network(force=False)
        print(f"jarvis-network: enriched={res.get('enriched', 0)} "
              f"skipped={res.get('skipped', 0)} "
              f"skill_calls={res.get('skill_calls', 0)}")
    except Exception as e:
        print(f"jarvis-network: enrich skipped — {e}", file=sys.stderr)
    try:
        push = push_alerts_to_notifications()
        print(f"jarvis-network: alerts pushed={push.get('pushed', 0)}")
    except Exception as e:
        print(f"jarvis-network: alert push skipped — {e}", file=sys.stderr)
    return 0


# ── CLI ─────────────────────────────────────────────────────────────
def _cli() -> int:
    args = sys.argv[1:]
    if not args:
        return main()
    if args[0] in ("-h", "--help"):
        sys.stdout.write(__doc__ or "")
        return 0
    cmd = args[0]
    rest = args[1:]

    def _flag(name: str, default: str | None = None) -> str | None:
        if name in rest:
            i = rest.index(name)
            if i + 1 < len(rest):
                return rest[i + 1]
        return default

    if cmd == "--search":
        if not rest:
            print("usage: --search QUERY [--tier T] [--min-strength N] [--limit N]",
                  file=sys.stderr)
            return 2
        query = rest[0]
        filters: dict[str, Any] = {}
        tier = _flag("--tier")
        if tier:
            filters["trust_level"] = tier
        ms = _flag("--min-strength")
        if ms:
            try:
                filters["min_strength"] = float(ms)
            except ValueError:
                pass
        ch = _flag("--channel")
        if ch:
            filters["channel"] = ch
        rd = _flag("--recency-days")
        if rd:
            try:
                filters["recency_days"] = float(rd)
            except ValueError:
                pass
        limit = int(_flag("--limit", "10") or "10")
        print(json.dumps(network_search(query, filters=filters, limit=limit),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--map":
        focus = _flag("--focus")
        limit = int(_flag("--limit", "20") or "20")
        print(json.dumps(network_map(focus=focus, limit=limit),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--score":
        if not rest:
            print("usage: --score NAME", file=sys.stderr)
            return 2
        print(json.dumps(relationship_score(rest[0]), indent=2,
                         ensure_ascii=False))
        return 0
    if cmd == "--suggest":
        if not rest:
            print("usage: --suggest 'goal'", file=sys.stderr)
            return 2
        goal = " ".join(rest)
        print(json.dumps(network_suggest(goal), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--enrich-all":
        force = "--force" in rest
        cap_str = _flag("--cap")
        cap = int(cap_str) if cap_str and cap_str.isdigit() else None
        print(json.dumps(enrich_network(force=force, cap=cap), indent=2,
                         ensure_ascii=False))
        return 0
    if cmd == "--alerts":
        refresh = "--refresh" in rest
        print(json.dumps(network_alerts(refresh=refresh), indent=2,
                         ensure_ascii=False))
        return 0
    if cmd == "--push-alerts":
        print(json.dumps(push_alerts_to_notifications(), indent=2,
                         ensure_ascii=False))
        return 0
    if cmd == "--status":
        print(json.dumps(status(), indent=2, ensure_ascii=False))
        return 0
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
