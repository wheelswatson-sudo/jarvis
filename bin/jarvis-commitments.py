#!/usr/bin/env python3
"""Commitment tracker — Watson's promises and to-dos as a queryable system.

Every "I'll send the term sheet to Corbin tomorrow", every "I owe Karina
a reply by Friday", every "remind me to call the lawyer Monday" lands
here. The module is the canonical store; jarvis-trello and jarvis-apple
are lossy mirrors that sync into Trello cards and Apple Reminders.

Data model — single record per commitment:

    {
      "id":              "c_a1b2c3d4",
      "text":            "send the term sheet to Corbin",
      "owner":           "watson" | "other",
      "source":          "manual" | "claude" | "trello" | "reminders"
                         | "imessage" | "email" | "telegram",
      "due":             "2026-05-02"          (ISO date, optional)
      "priority":        "high" | "normal" | "low",
      "status":          "open" | "done" | "overdue" | "cancelled",
      "related_contact": "Corbin Smith"        (optional)
      "tags":            ["forge", "fundraising"],
      "synced_to":       {"trello_card_id": "...", "reminders_id": "..."},
      "created_at":      "2026-04-28T20:00:00Z",
      "completed_at":    null,
      "updated_at":      "2026-04-28T20:00:00Z",
      "extracted_from":  "...short snippet of source text..." (optional)
    }

Public functions (all return JSON-serializable dicts):

    extract_commitments(text, source="claude", related_contact=None)
        Haiku-extract commitments from a block of text. Inserts each
        unique one as a new record. Returns the list of new IDs. Falls
        through silently when ANTHROPIC_API_KEY is missing.

    add_commitment(text, owner="watson", due=None, priority="normal",
                   related_contact=None, tags=None, source="manual")
        Add one explicit commitment. Accepts natural-language `due`
        ("tomorrow", "Friday", "in 2 weeks") or an ISO date.

    list_commitments(status=None, owner=None, related_contact=None,
                     days_ahead=None, limit=50)
        Filterable listing. days_ahead=0 → due today; days_ahead=7 →
        due within the next week; None → no due filter.

    complete_commitment(name_or_id)
        Fuzzy match by ID, or by substring of text. Marks done +
        completed_at, ready for downstream sync to mirror the change.

    commitment_report()
        Briefing-shaped summary: overdue, due today, due this week,
        recently completed. Voice-ready prose plus structured groups.

CLI mirror — see `jarvis-commitments --help`.

Files:
    ~/.jarvis/commitments/items.json           canonical store
    ~/.jarvis/commitments/extracted.jsonl      audit trail (every Haiku
                                               extraction call's raw output)
    ~/.jarvis/commitments/sync_state.json      shared by trello/apple syncers
    ~/.jarvis/logs/commitments.log             diagnostic log

Gate: JARVIS_COMMITMENTS=1 (default 1).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
BIN_DIR = ASSISTANT_DIR / "bin"
LIB_DIR = ASSISTANT_DIR / "lib"
COMMIT_DIR = ASSISTANT_DIR / "commitments"
ITEMS_FILE = COMMIT_DIR / "items.json"
EXTRACTED_FILE = COMMIT_DIR / "extracted.jsonl"
SYNC_STATE_FILE = COMMIT_DIR / "sync_state.json"
LOG_DIR = ASSISTANT_DIR / "logs"
COMMIT_LOG = LOG_DIR / "commitments.log"

EXTRACT_MODEL = os.environ.get(
    "JARVIS_COMMIT_MODEL", "claude-haiku-4-5-20251001")

VALID_OWNERS = {"watson", "other"}
VALID_PRIORITIES = {"high", "normal", "low"}
VALID_STATUSES = {"open", "done", "overdue", "cancelled"}
VALID_SOURCES = {
    "manual", "claude", "trello", "reminders",
    "imessage", "email", "telegram",
}


# ── logging + gate ────────────────────────────────────────────────────
def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with COMMIT_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def _gate_check() -> dict | None:
    if os.environ.get("JARVIS_COMMITMENTS", "1") != "1":
        return {"error": "commitment tracker disabled (JARVIS_COMMITMENTS=0)"}
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


def _primitive():
    if "primitive" not in _cache:
        _cache["primitive"] = _load_module("primitive", "primitive.py", _LIB_SEARCH)
    return _cache["primitive"]


def _emit(action: str, status: str, **ctx) -> None:
    p = _primitive()
    if p is None:
        return
    try:
        p.emit(cap="commitments", action=action, status=status, context=ctx)
    except Exception:
        pass


# ── store I/O (atomic) ────────────────────────────────────────────────
def _load_items() -> list[dict]:
    if not ITEMS_FILE.exists():
        return []
    try:
        data = json.loads(ITEMS_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        _log(f"items read failed: {e}")
        return []
    if not isinstance(data, list):
        return []
    return data


def _save_items(items: list[dict]) -> None:
    COMMIT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = ITEMS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(items, indent=2, ensure_ascii=False),
                   encoding="utf-8")
    os.replace(tmp, ITEMS_FILE)


def _append_extracted(rec: dict) -> None:
    COMMIT_DIR.mkdir(parents=True, exist_ok=True)
    try:
        with EXTRACTED_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception as e:
        _log(f"extracted append failed: {e}")


def _load_sync_state() -> dict:
    if not SYNC_STATE_FILE.exists():
        return {}
    try:
        return json.loads(SYNC_STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_sync_state(state: dict) -> None:
    COMMIT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SYNC_STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False),
                   encoding="utf-8")
    os.replace(tmp, SYNC_STATE_FILE)


# ── canonical helpers ─────────────────────────────────────────────────
_PUNCT_RE = re.compile(r"[^a-z0-9]+")


def _canonical(s: str) -> str:
    if not s:
        return ""
    norm = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    norm = _PUNCT_RE.sub(" ", norm.lower()).strip()
    return " ".join(norm.split())


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _new_id() -> str:
    return "c_" + uuid.uuid4().hex[:8]


# ── due-date parser ───────────────────────────────────────────────────
_WEEKDAYS = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
    "mon": 0, "tue": 1, "tues": 1, "wed": 2, "thu": 3, "thur": 3, "thurs": 3,
    "fri": 4, "sat": 5, "sun": 6,
}


def _parse_due(text: str | None,
               base: date | None = None) -> str | None:
    """Normalize a free-form date phrase into ISO 'YYYY-MM-DD'. Returns
    None when the input is empty or unparseable. `base` defaults to
    today."""
    if not text or not str(text).strip():
        return None
    raw = str(text).strip()
    base = base or date.today()

    # ISO date already?
    try:
        return datetime.fromisoformat(raw).date().isoformat()
    except ValueError:
        pass
    # ISO datetime?
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        pass

    s = raw.lower().strip()
    if s in ("today", "tonight"):
        return base.isoformat()
    if s == "tomorrow":
        return (base + timedelta(days=1)).isoformat()
    if s in ("yesterday",):
        return (base - timedelta(days=1)).isoformat()
    if s in ("eow", "end of week", "end-of-week"):
        days_to_fri = (4 - base.weekday()) % 7 or 7
        return (base + timedelta(days=days_to_fri)).isoformat()
    if s in ("eom", "end of month"):
        # First of next month minus one day
        if base.month == 12:
            next_first = date(base.year + 1, 1, 1)
        else:
            next_first = date(base.year, base.month + 1, 1)
        return (next_first - timedelta(days=1)).isoformat()

    # "next monday", "this friday", "monday"
    m = re.match(r"(?:next|this)?\s*(monday|tuesday|wednesday|thursday|"
                 r"friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|"
                 r"fri|sat|sun)\b", s)
    if m:
        target = _WEEKDAYS[m.group(1)]
        delta = (target - base.weekday()) % 7
        if delta == 0:
            delta = 7  # "monday" said on a monday means next monday
        if s.startswith("next"):
            # "next monday" → at least a week out
            if delta < 7:
                delta += 7
        return (base + timedelta(days=delta)).isoformat()

    # "in N days|weeks|months"
    m = re.match(r"in\s+(\d+)\s*(day|days|week|weeks|month|months)", s)
    if m:
        n = int(m.group(1))
        unit = m.group(2)
        if "week" in unit:
            return (base + timedelta(weeks=n)).isoformat()
        if "month" in unit:
            # Approximate: 30-day months
            return (base + timedelta(days=30 * n)).isoformat()
        return (base + timedelta(days=n)).isoformat()

    # "N days|weeks from now"
    m = re.match(r"(\d+)\s+(day|days|week|weeks|month|months)\s+from\s+now", s)
    if m:
        n = int(m.group(1))
        unit = m.group(2)
        if "week" in unit:
            return (base + timedelta(weeks=n)).isoformat()
        if "month" in unit:
            return (base + timedelta(days=30 * n)).isoformat()
        return (base + timedelta(days=n)).isoformat()

    # "by Friday" / "by next week"
    m = re.match(r"by\s+(.+)$", s)
    if m:
        return _parse_due(m.group(1), base=base)

    return None


# ── overdue refresh ───────────────────────────────────────────────────
def _refresh_overdue(items: list[dict]) -> bool:
    """Promote any open commitment past its due date into status=overdue.
    Idempotent. Returns True iff anything changed (so caller knows to
    save). Cancelled and done commitments are never demoted."""
    today = date.today().isoformat()
    dirty = False
    for rec in items:
        if rec.get("status") != "open":
            continue
        due = rec.get("due")
        if not due:
            continue
        if due < today:
            rec["status"] = "overdue"
            rec["updated_at"] = _now_iso()
            dirty = True
    return dirty


# ── Anthropic call (slim, blocking — used by extract_commitments) ─────
def _anthropic_call(api_key: str, model: str, system: str,
                    user_text: str, max_tokens: int = 800,
                    timeout: float = 25.0) -> str:
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
            return "\n".join(b.get("text", "")
                             for b in blocks if b.get("type") == "text").strip()
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(1 + attempt * 1.5)
                continue
            raise RuntimeError(f"API error {e.code}: {e}") from e
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last_err = e
            if attempt < 2:
                time.sleep(1 + attempt * 1.5)
                continue
            raise RuntimeError(f"network: {e}") from e
    raise RuntimeError(f"unexpected: {last_err}")


# ── action-language pre-filter ────────────────────────────────────────
_ACTION_TOKENS = re.compile(
    r"\b(i'?ll|i will|i'?ve|i have|let me|i'?m going to|i'?m gonna|"
    r"i need to|i should|i must|i can|i'?ll get|by\s+(?:tomorrow|today|monday|"
    r"tuesday|wednesday|thursday|friday|saturday|sunday|next|this)|"
    r"remind me|owe(?:d)?|follow up|send|call|email|text|reply|reach out|"
    r"deadline|due\s+(?:today|tomorrow|monday|tuesday|wednesday|thursday|"
    r"friday|saturday|sunday)|tonight|first thing|by eod|asap)\b",
    re.I,
)


def has_action_language(text: str) -> bool:
    """True iff `text` looks like it might contain a commitment. Keeps
    Watson from spending Haiku tokens on chit-chat. Generous on
    purpose — false positives waste a few tokens, false negatives drop
    real commitments."""
    if not text or not text.strip():
        return False
    return bool(_ACTION_TOKENS.search(text))


# ── extract_commitments (Haiku) ───────────────────────────────────────
EXTRACT_SYSTEM = """You extract commitments from a block of text Watson \
either said, wrote, or just heard.

A commitment is a concrete action that someone has agreed to do. \
"I'll send the term sheet to Corbin tomorrow" is one. "Karina said \
she'll get back to me Friday" is another. \
General intent ("I should focus more"), opinions, and questions are NOT.

Return ONE valid JSON object — no prose, no fences. Schema:

{
  "commitments": [
    {
      "text": "concrete imperative — 'send Corbin the term sheet'",
      "owner": "watson" | "other",
      "due": "YYYY-MM-DD or natural phrase ('tomorrow', 'Friday', 'next week') or null",
      "priority": "high" | "normal" | "low",
      "related_contact": "name if a specific person is involved, else null",
      "tags": ["short", "lowercase", "tags"]
    }
  ]
}

Rules:
- Empty list is fine — better than fabrication.
- owner=watson when Watson agreed to the action; owner=other when \
someone else owes Watson the action.
- Be concrete. Drop hedges ("maybe I'll"), keep firm verbs ("send", \
"call", "review").
- priority=high when text uses 'urgent', 'asap', 'critical', 'today'; \
priority=low for casual asides; otherwise normal.
- Dedupe — never return two commitments for the same action.
"""


def extract_commitments(text: str, source: str = "claude",
                        related_contact: str | None = None) -> dict:
    """Haiku-extract commitments from `text` and insert any new ones.

    `source` flags the origin in each new record. `related_contact` is
    used as a default when the model didn't surface one.

    Returns {ok, added: [ids], skipped_duplicates: int, raw}."""
    started = time.monotonic()
    gate = _gate_check()
    if gate:
        _emit("extract", "skipped", reason="gate")
        return gate
    text = (text or "").strip()
    if not text:
        return {"ok": True, "added": [], "skipped_duplicates": 0,
                "reason": "empty input"}
    if not has_action_language(text):
        return {"ok": True, "added": [], "skipped_duplicates": 0,
                "reason": "no action language"}
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        _emit("extract", "skipped", reason="no_api_key")
        return {"ok": True, "added": [], "skipped_duplicates": 0,
                "reason": "ANTHROPIC_API_KEY not set"}

    snippet = text[:4000]
    user_text = (
        "Extract commitments from this passage. "
        + (f"Default related_contact: {related_contact}\n\n"
           if related_contact else "")
        + f"Passage:\n{snippet}"
    )
    try:
        raw = _anthropic_call(api_key, EXTRACT_MODEL, EXTRACT_SYSTEM,
                              user_text, max_tokens=900, timeout=25)
    except Exception as e:
        _emit("extract", "failed", reason=f"api: {e}")
        return {"error": f"extract call failed: {e}"}
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return {"error": "model did not return JSON", "raw": raw[:300]}
    try:
        parsed = json.loads(m.group(0))
    except json.JSONDecodeError as e:
        return {"error": f"json parse: {e}", "raw": raw[:300]}

    commitments = parsed.get("commitments") or []
    if not isinstance(commitments, list):
        commitments = []

    _append_extracted({
        "ts": _now_iso(),
        "source": source,
        "snippet": snippet[:500],
        "raw_response": raw[:2000],
        "extracted_count": len(commitments),
    })

    items = _load_items()
    existing_canon = {_canonical(rec.get("text") or "") for rec in items
                      if rec.get("status") in ("open", "overdue")}
    added: list[str] = []
    skipped = 0
    for c in commitments:
        if not isinstance(c, dict):
            continue
        ctext = (c.get("text") or "").strip()
        if not ctext:
            continue
        canon = _canonical(ctext)
        if canon in existing_canon:
            skipped += 1
            continue
        existing_canon.add(canon)
        owner = c.get("owner") or "watson"
        if owner not in VALID_OWNERS:
            owner = "watson"
        priority = c.get("priority") or "normal"
        if priority not in VALID_PRIORITIES:
            priority = "normal"
        due = _parse_due(c.get("due"))
        rec = _new_record(
            text=ctext, owner=owner, source=source,
            due=due, priority=priority,
            related_contact=c.get("related_contact") or related_contact,
            tags=[t for t in (c.get("tags") or []) if isinstance(t, str)],
            extracted_from=snippet[:300],
        )
        items.append(rec)
        added.append(rec["id"])

    if added:
        _save_items(items)

    elapsed = int((time.monotonic() - started) * 1000)
    _emit("extract", "success", source=source, added=len(added),
          skipped=skipped, latency_ms=elapsed)
    _log(f"extract source={source} added={len(added)} skipped={skipped} "
         f"({elapsed}ms)")
    return {
        "ok": True,
        "added": added,
        "skipped_duplicates": skipped,
        "raw_count": len(commitments),
    }


# ── add_commitment (manual entry) ─────────────────────────────────────
def _new_record(*, text: str, owner: str = "watson", source: str = "manual",
                due: str | None = None, priority: str = "normal",
                related_contact: str | None = None,
                tags: list[str] | None = None,
                extracted_from: str | None = None) -> dict:
    rec = {
        "id": _new_id(),
        "text": text.strip(),
        "owner": owner if owner in VALID_OWNERS else "watson",
        "source": source if source in VALID_SOURCES else "manual",
        "due": due,
        "priority": priority if priority in VALID_PRIORITIES else "normal",
        "status": "open",
        "related_contact": (related_contact or "").strip() or None,
        "tags": [t.strip().lower() for t in (tags or []) if t and t.strip()][:8],
        "synced_to": {},
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "completed_at": None,
    }
    if extracted_from:
        rec["extracted_from"] = extracted_from
    return rec


def add_commitment(text: str, owner: str = "watson", due: str | None = None,
                   priority: str = "normal",
                   related_contact: str | None = None,
                   tags: list[str] | None = None,
                   source: str = "manual") -> dict:
    """Add one commitment. `due` accepts ISO date OR natural phrase
    ('tomorrow', 'Friday', 'in 2 weeks'). Returns the new record."""
    gate = _gate_check()
    if gate:
        return gate
    text = (text or "").strip()
    if not text:
        return {"error": "text is required"}

    parsed_due = _parse_due(due)
    if due and not parsed_due:
        # User asked for a specific date and we couldn't read it. Better
        # to flag it than silently drop the constraint.
        return {"error": f"could not parse due date: {due!r}"}

    rec = _new_record(
        text=text, owner=owner, source=source, due=parsed_due,
        priority=priority, related_contact=related_contact, tags=tags,
    )
    items = _load_items()
    items.append(rec)
    _save_items(items)
    _emit("add", "success", id=rec["id"], owner=owner, source=source,
          has_due=bool(parsed_due))
    _log(f"add {rec['id']} text={text[:80]!r} due={parsed_due}")
    return {"ok": True, "commitment": rec}


# ── list_commitments ──────────────────────────────────────────────────
def list_commitments(status: str | list[str] | None = None,
                     owner: str | None = None,
                     related_contact: str | None = None,
                     days_ahead: int | None = None,
                     limit: int = 50) -> dict:
    """Filter the store. Filters compose with AND.

    days_ahead=0   → due today
    days_ahead=7   → due within next 7 days (inclusive of today)
    days_ahead=-1  → no upper bound (only useful with status='overdue')
    None           → no due-date filter
    """
    gate = _gate_check()
    if gate:
        return gate
    items = _load_items()
    if _refresh_overdue(items):
        _save_items(items)

    if isinstance(status, str):
        status_set = {status}
    elif isinstance(status, list):
        status_set = {s for s in status if s in VALID_STATUSES}
    else:
        status_set = None

    today = date.today()
    contact_canon = _canonical(related_contact) if related_contact else None

    out: list[dict] = []
    for rec in items:
        if status_set and rec.get("status") not in status_set:
            continue
        if owner and rec.get("owner") != owner:
            continue
        if contact_canon:
            rc = _canonical(rec.get("related_contact") or "")
            if not rc or contact_canon not in rc:
                continue
        if days_ahead is not None:
            due = rec.get("due")
            if not due:
                continue
            try:
                due_d = date.fromisoformat(due)
            except ValueError:
                continue
            if days_ahead < 0:
                pass  # no upper bound
            else:
                if (due_d - today).days > days_ahead:
                    continue
                if (due_d - today).days < 0 and rec.get("status") != "overdue":
                    # When days_ahead is non-negative, an overdue record
                    # whose status hadn't been promoted yet still counts.
                    pass
        out.append(rec)

    # Sort: overdue first, then by due date ascending, then by created.
    def sort_key(r: dict):
        st = r.get("status")
        st_order = {"overdue": 0, "open": 1, "done": 2, "cancelled": 3}.get(st, 4)
        due = r.get("due") or "9999-12-31"
        return (st_order, due, r.get("created_at") or "")
    out.sort(key=sort_key)
    return {
        "ok": True,
        "count": len(out),
        "filters": {
            "status": list(status_set) if status_set else None,
            "owner": owner,
            "related_contact": related_contact,
            "days_ahead": days_ahead,
        },
        "commitments": out[:max(1, int(limit))],
    }


# ── complete_commitment (fuzzy match) ─────────────────────────────────
def complete_commitment(name_or_id: str) -> dict:
    """Mark a commitment done. Resolves by:
       1. Exact ID match
       2. ID prefix (e.g. 'c_a1b2')
       3. Substring match against text (canonical lowercase)
    Returns {ok, commitment} on success, {error, candidates?} when
    ambiguous or missing."""
    gate = _gate_check()
    if gate:
        return gate
    if not name_or_id or not name_or_id.strip():
        return {"error": "name or id is required"}
    needle = name_or_id.strip()

    items = _load_items()
    if _refresh_overdue(items):
        # Don't save here — the resolution might fail; let the caller
        # decide on persistence.
        pass

    # Pass 1: exact ID
    for rec in items:
        if rec.get("id") == needle:
            return _mark_done(items, rec)
    # Pass 2: ID prefix
    if needle.startswith("c_"):
        hits = [r for r in items if (r.get("id") or "").startswith(needle)]
        if len(hits) == 1:
            return _mark_done(items, hits[0])
        if len(hits) > 1:
            return {"error": "ambiguous id prefix",
                    "candidates": [{"id": r["id"], "text": r["text"]}
                                   for r in hits[:6]]}
    # Pass 3: substring on canonical text — only consider open/overdue
    canon = _canonical(needle)
    if not canon:
        return {"error": f"no match for {name_or_id!r}"}
    hits = []
    for rec in items:
        if rec.get("status") in ("done", "cancelled"):
            continue
        rcanon = _canonical(rec.get("text") or "")
        if canon in rcanon:
            hits.append(rec)
    if len(hits) == 1:
        return _mark_done(items, hits[0])
    if len(hits) > 1:
        return {"error": "ambiguous match — be more specific",
                "candidates": [{"id": r["id"], "text": r["text"],
                                "due": r.get("due")} for r in hits[:6]]}
    return {"error": f"no open commitment matches {name_or_id!r}"}


def _mark_done(items: list[dict], rec: dict) -> dict:
    rec["status"] = "done"
    rec["completed_at"] = _now_iso()
    rec["updated_at"] = rec["completed_at"]
    _save_items(items)
    _emit("complete", "success", id=rec["id"])
    _log(f"complete {rec['id']} text={rec.get('text', '')[:80]!r}")
    return {"ok": True, "commitment": rec}


# ── update_commitment (lighter helper, used by syncers) ───────────────
def update_commitment(commitment_id: str, **changes) -> dict:
    """Partial-update a record by id. Used by trello/apple syncers to
    write back the external IDs. Reserved for fields we trust callers to
    set; status transitions go through complete_commitment."""
    gate = _gate_check()
    if gate:
        return gate
    items = _load_items()
    target = next((r for r in items if r.get("id") == commitment_id), None)
    if target is None:
        return {"error": f"no commitment with id {commitment_id!r}"}
    allowed = {"due", "priority", "related_contact", "tags", "synced_to",
               "text", "status"}
    for k, v in changes.items():
        if k not in allowed:
            continue
        if k == "synced_to" and isinstance(v, dict):
            target.setdefault("synced_to", {}).update(v)
        else:
            target[k] = v
    target["updated_at"] = _now_iso()
    _save_items(items)
    return {"ok": True, "commitment": target}


# ── commitment_report (briefing-shaped) ───────────────────────────────
def commitment_report(week_window: int = 7) -> dict:
    """Summary buckets used by jarvis-briefing + voice 'what's on my
    plate'. Returns counts plus the actual records for each bucket so
    callers can choose to render either."""
    gate = _gate_check()
    if gate:
        return gate
    items = _load_items()
    if _refresh_overdue(items):
        _save_items(items)
    today = date.today()
    overdue: list[dict] = []
    due_today: list[dict] = []
    due_week: list[dict] = []
    recently_done: list[dict] = []

    cutoff_done = (today - timedelta(days=7)).isoformat()
    for rec in items:
        st = rec.get("status")
        if st == "overdue":
            overdue.append(rec)
            continue
        if st == "done":
            done_at = (rec.get("completed_at") or "")[:10]
            if done_at and done_at >= cutoff_done:
                recently_done.append(rec)
            continue
        if st != "open":
            continue
        due = rec.get("due")
        if not due:
            continue
        try:
            due_d = date.fromisoformat(due)
        except ValueError:
            continue
        delta = (due_d - today).days
        if delta == 0:
            due_today.append(rec)
        elif 0 < delta <= week_window:
            due_week.append(rec)

    overdue.sort(key=lambda r: r.get("due") or "")
    due_today.sort(key=lambda r: r.get("priority") or "")
    due_week.sort(key=lambda r: r.get("due") or "")
    recently_done.sort(key=lambda r: r.get("completed_at") or "", reverse=True)

    def short(items_: list[dict]) -> list[dict]:
        return [{
            "id": r["id"],
            "text": r.get("text"),
            "due": r.get("due"),
            "priority": r.get("priority"),
            "owner": r.get("owner"),
            "related_contact": r.get("related_contact"),
        } for r in items_]

    return {
        "ok": True,
        "as_of": today.isoformat(),
        "counts": {
            "overdue": len(overdue),
            "due_today": len(due_today),
            "due_week": len(due_week),
            "recently_done": len(recently_done),
        },
        "overdue": short(overdue),
        "due_today": short(due_today),
        "due_this_week": short(due_week),
        "recently_done": short(recently_done[:8]),
    }


# ── briefing + context + notification hooks ───────────────────────────
def briefing_section() -> str:
    """Markdown 'Commitments' block — overdue first, due today, due this
    week. Empty when there's nothing on the plate."""
    rep = commitment_report()
    if not rep.get("ok"):
        return ""
    counts = rep.get("counts") or {}
    if not (counts.get("overdue") or counts.get("due_today")
            or counts.get("due_week")):
        return ""
    lines = ["## Commitments", ""]
    if counts.get("overdue"):
        lines.append(f"**Overdue ({counts['overdue']}):**")
        for r in rep["overdue"][:6]:
            who = f" (with {r['related_contact']})" if r.get("related_contact") else ""
            lines.append(f"- {r['text']} — was due {r.get('due')}{who}")
        lines.append("")
    if counts.get("due_today"):
        lines.append(f"**Due today ({counts['due_today']}):**")
        for r in rep["due_today"][:6]:
            who = f" (with {r['related_contact']})" if r.get("related_contact") else ""
            lines.append(f"- {r['text']}{who}")
        lines.append("")
    if counts.get("due_week"):
        lines.append(f"**Due this week ({counts['due_week']}):**")
        for r in rep["due_this_week"][:8]:
            who = f" (with {r['related_contact']})" if r.get("related_contact") else ""
            lines.append(f"- {r['text']} — {r.get('due')}{who}")
        lines.append("")
    return "\n".join(lines)


def context_hint(mentioned_names: list[str] | None = None) -> str:
    """One-line system-prompt hint when a mentioned contact has open
    commitments. Empty otherwise."""
    if not mentioned_names:
        return ""
    if _gate_check() is not None:
        return ""
    items = _load_items()
    if _refresh_overdue(items):
        _save_items(items)
    bits: list[str] = []
    for nm in mentioned_names[:3]:
        canon = _canonical(nm)
        if not canon:
            continue
        with_them = [r for r in items
                     if r.get("status") in ("open", "overdue")
                     and canon in _canonical(r.get("related_contact") or "")]
        if not with_them:
            continue
        # Pick the most pressing — overdue, then earliest due.
        with_them.sort(key=lambda r: (
            0 if r.get("status") == "overdue" else 1,
            r.get("due") or "9999",
        ))
        top = with_them[0]
        st = top.get("status")
        due = top.get("due")
        suffix = f" (due {due})" if due else ""
        if st == "overdue":
            suffix = f" (OVERDUE — was due {due})" if due else " (overdue)"
        bits.append(f"open with {nm}: {top['text']}{suffix}")
    if not bits:
        return ""
    return "**Commitments:** " + "; ".join(bits) + "."


def overdue_inner_circle_alerts() -> list[dict]:
    """Surface overdue commitments tied to inner_circle / trusted
    contacts, for jarvis-notifications to score as high priority. Lazy-
    loads jarvis-network for trust labels; falls through cleanly if the
    module isn't installed."""
    items = _load_items()
    if _refresh_overdue(items):
        _save_items(items)
    overdue = [r for r in items if r.get("status") == "overdue"
               and r.get("related_contact")]
    if not overdue:
        return []

    # Resolve each related_contact to a trust level via jarvis-network.
    src = BIN_DIR / "jarvis-network.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-network.py"
    if not src.exists():
        return []
    try:
        spec = importlib.util.spec_from_file_location(
            "jarvis_network_for_commit", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
    except Exception:
        return []
    out: list[dict] = []
    for rec in overdue:
        try:
            res = mod.relationship_score(rec["related_contact"])
        except Exception:
            continue
        trust = (res or {}).get("trust_level")
        if trust in ("inner_circle", "trusted"):
            out.append({
                "commitment_id": rec["id"],
                "text": rec["text"],
                "related_contact": rec["related_contact"],
                "trust_level": trust,
                "due": rec.get("due"),
            })
    return out


# ── CLI ────────────────────────────────────────────────────────────────
def _cli() -> int:
    p = argparse.ArgumentParser(description="Jarvis commitment tracker")
    sub = p.add_subparsers(dest="cmd", required=True)

    pa = sub.add_parser("add", help="add a commitment")
    pa.add_argument("text")
    pa.add_argument("--owner", default="watson",
                    choices=sorted(VALID_OWNERS))
    pa.add_argument("--due", default=None)
    pa.add_argument("--priority", default="normal",
                    choices=sorted(VALID_PRIORITIES))
    pa.add_argument("--contact", default=None)
    pa.add_argument("--tags", default=None,
                    help="comma-separated tags")

    pl = sub.add_parser("list", help="list commitments")
    pl.add_argument("--status", default=None,
                    help="comma-separated subset of "
                         + ",".join(sorted(VALID_STATUSES)))
    pl.add_argument("--owner", default=None,
                    choices=sorted(VALID_OWNERS))
    pl.add_argument("--contact", default=None)
    pl.add_argument("--days-ahead", type=int, default=None)
    pl.add_argument("--limit", type=int, default=50)

    pc = sub.add_parser("complete", help="mark done by id or text")
    pc.add_argument("name_or_id")

    pe = sub.add_parser("extract", help="Haiku-extract from stdin or a file")
    pe.add_argument("--file", default=None,
                    help="path to a text file (else read stdin)")
    pe.add_argument("--source", default="manual")
    pe.add_argument("--contact", default=None)

    sub.add_parser("report", help="briefing-shaped summary")
    sub.add_parser("status", help="store stats")
    sub.add_parser("briefing-section",
                   help="markdown block for jarvis-briefing")
    pch = sub.add_parser("context-hint")
    pch.add_argument("--names", default=None,
                     help="comma-separated names to check")

    args = p.parse_args()

    if args.cmd == "add":
        tags = [t.strip() for t in (args.tags or "").split(",") if t.strip()] or None
        print(json.dumps(add_commitment(
            args.text, owner=args.owner, due=args.due,
            priority=args.priority, related_contact=args.contact,
            tags=tags,
        ), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "list":
        status: list[str] | None = None
        if args.status:
            status = [s.strip() for s in args.status.split(",") if s.strip()]
        print(json.dumps(list_commitments(
            status=status, owner=args.owner,
            related_contact=args.contact,
            days_ahead=args.days_ahead, limit=args.limit,
        ), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "complete":
        print(json.dumps(complete_commitment(args.name_or_id),
                         ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "extract":
        if args.file:
            text = Path(args.file).read_text(encoding="utf-8")
        else:
            text = sys.stdin.read()
        print(json.dumps(extract_commitments(
            text, source=args.source, related_contact=args.contact,
        ), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "report":
        print(json.dumps(commitment_report(), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "status":
        items = _load_items()
        by_status: dict[str, int] = {}
        for r in items:
            by_status[r.get("status") or "?"] = by_status.get(
                r.get("status") or "?", 0) + 1
        print(json.dumps({
            "ok": True,
            "count": len(items),
            "by_status": by_status,
            "items_path": str(ITEMS_FILE),
        }, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "briefing-section":
        s = briefing_section()
        print(s if s else "(no commitments to surface)")
        return 0
    if args.cmd == "context-hint":
        names = [n.strip() for n in (args.names or "").split(",") if n.strip()]
        h = context_hint(mentioned_names=names or None)
        print(h if h else "(no hint)")
        return 0
    return 2


def main() -> int:
    """Entrypoint for jarvis-improve. Just refreshes overdue status —
    the heavy syncing lives in jarvis-trello and jarvis-apple. Always
    exits 0."""
    if _gate_check() is not None:
        return 0
    try:
        items = _load_items()
        if _refresh_overdue(items):
            _save_items(items)
    except Exception as e:
        _log(f"main refresh: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(_cli() if len(sys.argv) > 1 else main())
