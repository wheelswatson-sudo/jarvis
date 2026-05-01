#!/usr/bin/env python3
"""Commitment tracker — Jarvis owns Watson's "I'll do X" promises.

Watson tells Jarvis (or someone over email/iMessage) "I'll send the
proposal Friday" and the commitment is logged, surfaced when due, and
synced to Trello + Apple Reminders so it shows up wherever Watson looks.
This module is the canonical store. Trello and Apple Reminders are
mirrors that sync back; if they disagree with items.json, items.json
wins.

Storage:
    ~/.jarvis/commitments/items.json       canonical commitments
    ~/.jarvis/commitments/extracted.jsonl  audit log of every Haiku
                                           extraction (kept/rejected)
    ~/.jarvis/commitments/sync_state.json  per-system last-sync ts
    ~/.jarvis/logs/commitments.log         diagnostic log

Item shape (one entry in items.json["items"]):
    {
      "id":             "cmt_<12-hex>",
      "text":           "Send Corbin the proposal",
      "owner":          "watson" | contact-name,
      "source":         {"type": "conversation"|"email"|"imessage"|"manual",
                         "ts": "...", "context": "discussing Forge pricing"},
      "due":            "2026-05-01" | null,
      "priority":       "high" | "medium" | "low",
      "status":         "open" | "done" | "overdue" | "cancelled",
      "related_contact": "Corbin" | null,
      "tags":           [...],
      "synced_to":      {"trello": "<card_id>", "apple_reminders": "<id>"},
      "created":        ISO,
      "completed":      ISO | null,
      "notes":          ""
    }

Public functions (callable from jarvis-think.py tool handlers):

    extract_commitments(text, source_type="conversation",
                        context=None, dry_run=False) -> dict
        Haiku-extracts candidate commitments from a chunk of text. Logs
        every candidate to extracted.jsonl. Saves immediately when
        dry_run=False (default for cron / non-interactive callers); the
        think-loop hook saves only on implicit confirmation.

    add_commitment(text, due=None, priority="medium",
                   contact=None, tags=None, owner="watson",
                   source_type="manual") -> dict
        Manual add. Parses freeform date strings via _parse_due.

    list_commitments(status="open", owner=None, contact=None,
                     days_ahead=7, limit=50) -> dict
        Sorted by due date, overdue first. status="all" returns every
        bucket.

    complete_commitment(id_or_text) -> dict
        Fuzzy match on text if id not given. Triggers sync to Trello
        and Apple Reminders so the cards/reminders close too.

    commitment_report(days=7) -> dict
        Snapshot for the morning briefing — overdue, due today, due
        this week, recently completed, items others owe Watson.

    briefing_section() -> str
        Markdown block for jarvis-briefing.

    context_hint() -> str
        One-liner for jarvis-context's system-prompt block.

CLI:
    bin/jarvis-commitments.py extract "I'll send Corbin the proposal"
    bin/jarvis-commitments.py add "Email mom" --due tomorrow
    bin/jarvis-commitments.py list [--status open|done|all]
    bin/jarvis-commitments.py complete cmt_abc123
    bin/jarvis-commitments.py report
    bin/jarvis-commitments.py sync             # trello + apple reminders
    bin/jarvis-commitments.py briefing-section

Gate: JARVIS_COMMITMENTS=1 (default).
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
COMMIT_DIR = ASSISTANT_DIR / "commitments"
ITEMS_FILE = COMMIT_DIR / "items.json"
EXTRACTED_LOG = COMMIT_DIR / "extracted.jsonl"
SYNC_STATE_FILE = COMMIT_DIR / "sync_state.json"
LOG_DIR = ASSISTANT_DIR / "logs"
COMMIT_LOG = LOG_DIR / "commitments.log"
BIN_DIR = Path(__file__).resolve().parent

EXTRACTION_MODEL = os.environ.get("JARVIS_COMMITMENTS_MODEL",
                                  "claude-haiku-4-5-20251001")
EXTRACT_MAX_TEXT = int(os.environ.get("JARVIS_COMMITMENTS_MAX_TEXT", "8000"))
PRIORITY_VALUES = {"high", "medium", "low"}
STATUS_VALUES = {"open", "done", "overdue", "cancelled"}


# ── logging / IO ─────────────────────────────────────────────────────
def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with COMMIT_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _gate_enabled() -> bool:
    return os.environ.get("JARVIS_COMMITMENTS", "1") not in ("0", "false", "no", "off")


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path: Path, data: Any) -> bool:
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


def _load_items() -> dict:
    data = _read_json(ITEMS_FILE, {"items": []})
    if not isinstance(data, dict) or "items" not in data:
        data = {"items": []}
    return data


def _save_items(data: dict) -> None:
    _write_json(ITEMS_FILE, data)


def _append_extracted(rec: dict) -> None:
    try:
        EXTRACTED_LOG.parent.mkdir(parents=True, exist_ok=True)
        with EXTRACTED_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass


# ── lazy siblings ─────────────────────────────────────────────────────
_cache: dict[str, Any] = {}


def _load_sibling(name: str) -> Any:
    """Load bin/<name> as a python module. Cached."""
    if name in _cache:
        return _cache[name]
    src = BIN_DIR / name
    if not src.exists():
        src = ASSISTANT_DIR / "bin" / name
    if not src.exists():
        _cache[name] = None
        return None
    try:
        mod_name = name.replace("-", "_").replace(".py", "")
        spec = importlib.util.spec_from_file_location(mod_name, src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _cache[name] = mod
        return mod
    except Exception as e:
        _log(f"load {name} failed: {e}")
        _cache[name] = None
        return None


def _emit(action: str, status: str, context: dict | None = None,
          latency_ms: int | None = None) -> None:
    """Push to the outcome ledger if available — best effort."""
    try:
        sys.path.insert(0, str(ASSISTANT_DIR / "lib"))
        sys.path.insert(0, str(BIN_DIR.parent / "lib"))
        from outcome_ledger import emit  # type: ignore
        emit("commitments", action, status, context=context, latency_ms=latency_ms)
    except Exception:
        pass


# ── date parsing ──────────────────────────────────────────────────────
_REL_DAYS = {
    "today": 0, "tonight": 0,
    "tomorrow": 1, "tmrw": 1,
    "next week": 7,
    "next monday": None, "next tuesday": None, "next wednesday": None,
    "next thursday": None, "next friday": None, "next saturday": None,
    "next sunday": None,
    "monday": None, "tuesday": None, "wednesday": None, "thursday": None,
    "friday": None, "saturday": None, "sunday": None,
}
_WEEKDAY_INDEX = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
}
_REL_RE = re.compile(r"\bin\s+(\d+)\s*(day|days|week|weeks|month|months)\b", re.I)
_EOW_RE = re.compile(r"\b(end of (this )?week|by friday|eow)\b", re.I)
_EOD_RE = re.compile(r"\b(end of (the )?day|eod|by tonight)\b", re.I)


def _parse_due(text: str | None) -> str | None:
    """Best-effort natural language → YYYY-MM-DD. Returns None on failure
    so the caller can leave `due` null rather than guess."""
    if not text:
        return None
    raw = str(text).strip().lower()
    if not raw:
        return None
    today = datetime.now().astimezone().date()

    # ISO YYYY-MM-DD wins outright.
    try:
        return date.fromisoformat(raw[:10]).isoformat()
    except ValueError:
        pass

    if raw in _REL_DAYS and _REL_DAYS[raw] is not None:
        return (today + timedelta(days=_REL_DAYS[raw])).isoformat()

    if _EOD_RE.search(raw):
        return today.isoformat()
    if _EOW_RE.search(raw):
        days = (4 - today.weekday()) % 7  # next Friday (or today if Friday)
        return (today + timedelta(days=days or 7 if today.weekday() > 4 else days)).isoformat()

    m = _REL_RE.search(raw)
    if m:
        n = int(m.group(1))
        unit = m.group(2).lower()
        if unit.startswith("day"):
            return (today + timedelta(days=n)).isoformat()
        if unit.startswith("week"):
            return (today + timedelta(days=n * 7)).isoformat()
        if unit.startswith("month"):
            return (today + timedelta(days=n * 30)).isoformat()

    # bare weekday name → next occurrence (Monday → next Monday if today
    # is Monday, else this week's Monday).
    for key, idx in _WEEKDAY_INDEX.items():
        if raw == key or raw == f"next {key}" or raw == f"this {key}":
            delta = (idx - today.weekday()) % 7
            if raw.startswith("next ") and delta == 0:
                delta = 7
            if delta == 0 and not raw.startswith("this "):
                delta = 7
            return (today + timedelta(days=delta)).isoformat()

    return None


def _is_overdue(due: str | None, status: str) -> bool:
    if status not in ("open",):
        return False
    if not due:
        return False
    try:
        return date.fromisoformat(due) < datetime.now().astimezone().date()
    except ValueError:
        return False


# ── extraction (Haiku) ────────────────────────────────────────────────
EXTRACT_SYSTEM = """You extract commitments from text. A commitment is a
specific promise to do something — "I'll send the proposal", "let me
know by Friday", "can you forward me the deck". You ignore vague
intentions ("we should chat sometime"), questions, and statements about
the past.

Return ONLY JSON, no prose, no fences:

{"commitments": [
  {
    "text": "<commitment as a short imperative phrase>",
    "owner": "watson" | "<other-person-name>",
    "due": "<YYYY-MM-DD or null>",
    "priority": "high" | "medium" | "low",
    "related_contact": "<name or null>",
    "tags": ["<tag>", ...]
  }
]}

Rules:
- "I'll", "I will", "let me" → owner = "watson"
- "Can you", "could you" (asked of Watson) → owner = "watson"
- "<other> will", "<other> said they'd" → owner = "<that person>"
- Resolve relative dates against {today_iso} (today's date).
- priority: high if a deadline word appears (urgent, asap, today, by Friday);
  low if soft ("eventually", "at some point"); else medium.
- related_contact: the person the commitment touches. Often the same
  as `owner` for non-Watson commitments; for Watson commitments it's
  who he's promising it TO.
- tags: 0-3 short kebab-case keywords drawn from the topic (e.g.
  ["proposal", "forge"]) — leave [] if nothing obvious.
- If the text contains no real commitments, return {"commitments": []}."""


def _haiku_extract(api_key: str, text: str, today_iso: str,
                   timeout: float = 15.0) -> list[dict]:
    """Call Haiku, return parsed commitment dicts. Empty list on any
    parse failure so the hook can no-op safely."""
    if not api_key:
        return []
    sys_prompt = EXTRACT_SYSTEM.replace("{today_iso}", today_iso)
    payload = json.dumps({
        "model": EXTRACTION_MODEL,
        "max_tokens": 600,
        "system": sys_prompt,
        "messages": [{"role": "user", "content": text[:EXTRACT_MAX_TEXT]}],
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
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read())
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        _log(f"haiku error: {e}")
        return []
    blocks = data.get("content") or []
    raw_text = "\n".join(b.get("text", "") for b in blocks
                         if b.get("type") == "text").strip()
    if not raw_text:
        return []
    # Tolerate code fences just in case.
    if raw_text.startswith("```"):
        raw_text = re.sub(r"^```[a-zA-Z]*\n", "", raw_text)
        raw_text = re.sub(r"\n```\s*$", "", raw_text)
    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        # Try to find a bare JSON object inside the text.
        m = re.search(r"\{.*\}", raw_text, re.DOTALL)
        if not m:
            return []
        try:
            parsed = json.loads(m.group(0))
        except json.JSONDecodeError:
            return []
    candidates = parsed.get("commitments")
    return candidates if isinstance(candidates, list) else []


def extract_commitments(text: str, source_type: str = "conversation",
                        context: str | None = None,
                        dry_run: bool = False) -> dict:
    """Extract commitments from `text` via Haiku.

    `dry_run=True` returns candidates without persisting — used by the
    think.py hook so the orchestrator can choose to confirm before
    saving. `dry_run=False` saves anything Haiku surfaced (cron / batch
    paths)."""
    if not _gate_enabled():
        return {"error": "JARVIS_COMMITMENTS=0"}
    text = (text or "").strip()
    if not text or len(text) < 10:
        return {"ok": True, "candidates": [], "saved": []}

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {"error": "ANTHROPIC_API_KEY not set"}

    started = time.time()
    today_iso = datetime.now().astimezone().date().isoformat()
    candidates = _haiku_extract(api_key, text, today_iso)
    latency_ms = int((time.time() - started) * 1000)

    audit = {
        "ts": _now_iso(),
        "source_type": source_type,
        "context": (context or "")[:500],
        "input_hash": uuid.uuid5(uuid.NAMESPACE_OID, text).hex,
        "candidate_count": len(candidates),
        "candidates": candidates,
        "saved": False,
        "dry_run": dry_run,
        "latency_ms": latency_ms,
    }

    saved: list[dict] = []
    if not dry_run and candidates:
        items = _load_items()
        for c in candidates:
            rec = _build_record(
                text=c.get("text") or "",
                owner=(c.get("owner") or "watson"),
                due=_parse_due(c.get("due")) or c.get("due"),
                priority=(c.get("priority") or "medium"),
                contact=c.get("related_contact"),
                tags=c.get("tags") or [],
                source={"type": source_type, "ts": _now_iso(),
                        "context": context or ""},
            )
            if not rec["text"]:
                continue
            # Drop near-duplicates (same text, open status).
            if any(_text_similar(rec["text"], x["text"])
                   and x["status"] == "open" for x in items["items"]):
                continue
            items["items"].append(rec)
            saved.append(rec)
        if saved:
            _save_items(items)
            audit["saved"] = True
        _emit("extract", "success",
              context={"source_type": source_type, "saved": len(saved),
                       "candidates": len(candidates)},
              latency_ms=latency_ms)
    elif dry_run:
        _emit("extract", "skipped",
              context={"source_type": source_type, "candidates": len(candidates),
                       "dry_run": True},
              latency_ms=latency_ms)
    else:
        _emit("extract", "success",
              context={"source_type": source_type, "candidates": 0},
              latency_ms=latency_ms)

    _append_extracted(audit)
    return {"ok": True, "candidates": candidates, "saved": saved,
            "latency_ms": latency_ms}


# ── helpers ───────────────────────────────────────────────────────────
def _build_record(text: str, owner: str = "watson", due: str | None = None,
                  priority: str = "medium", contact: str | None = None,
                  tags: list[str] | None = None,
                  source: dict | None = None) -> dict:
    return {
        "id": "cmt_" + uuid.uuid4().hex[:12],
        "text": (text or "").strip(),
        "owner": (owner or "watson").strip() or "watson",
        "source": source or {"type": "manual", "ts": _now_iso(), "context": ""},
        "due": due if (due and re.match(r"^\d{4}-\d{2}-\d{2}$", str(due))) else None,
        "priority": priority if priority in PRIORITY_VALUES else "medium",
        "status": "open",
        "related_contact": (contact or "").strip() or None,
        "tags": [str(t).strip() for t in (tags or []) if t][:8],
        "synced_to": {},
        "created": _now_iso(),
        "completed": None,
        "notes": "",
    }


_NORMALIZE_RE = re.compile(r"[^a-z0-9 ]+")


def _normalize(text: str) -> str:
    return _NORMALIZE_RE.sub(" ", (text or "").lower()).strip()


def _text_similar(a: str, b: str) -> bool:
    """Cheap near-duplicate check — same normalized text or one is a
    >80%-character prefix of the other."""
    na, nb = _normalize(a), _normalize(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    short, long = (na, nb) if len(na) <= len(nb) else (nb, na)
    return long.startswith(short) and len(short) >= int(len(long) * 0.8)


# ── add / list / complete ─────────────────────────────────────────────
def add_commitment(text: str, due: str | None = None,
                   priority: str = "medium", contact: str | None = None,
                   tags: list[str] | None = None,
                   owner: str = "watson",
                   source_type: str = "manual",
                   notes: str | None = None) -> dict:
    if not _gate_enabled():
        return {"error": "JARVIS_COMMITMENTS=0"}
    text = (text or "").strip()
    if not text:
        return {"error": "text is required"}

    parsed_due = _parse_due(due) if due else None
    if due and not parsed_due:
        # Watson said "Friday" but we couldn't pin a date. Keep the raw
        # value in notes so it isn't lost — Watson can fix it later.
        notes = ((notes or "") + f" (raw due: {due})").strip()

    # Auto-link contact via network intelligence when only a partial name
    # was given. Keep best-effort: if jarvis-network is missing, just use
    # the raw string.
    contact_resolved = contact
    if contact:
        net = _load_sibling("jarvis-network.py")
        if net is not None:
            try:
                rec = net.lookup_or_canonical(contact) if hasattr(net, "lookup_or_canonical") else None
                if rec and rec.get("name"):
                    contact_resolved = rec["name"]
            except Exception:
                pass

    items = _load_items()
    record = _build_record(
        text=text, owner=owner, due=parsed_due, priority=priority,
        contact=contact_resolved, tags=tags or [],
        source={"type": source_type, "ts": _now_iso(), "context": ""},
    )
    if notes:
        record["notes"] = notes.strip()
    items["items"].append(record)
    _save_items(items)
    _emit("add", "success", context={"id": record["id"], "due": parsed_due,
                                     "priority": priority})
    _log(f"added {record['id']} '{text}' due={parsed_due}")
    return {"ok": True, "commitment": record}


def list_commitments(status: str = "open", owner: str | None = None,
                     contact: str | None = None,
                     days_ahead: int | None = 7,
                     limit: int = 50) -> dict:
    if not _gate_enabled():
        return {"error": "JARVIS_COMMITMENTS=0"}
    items = _load_items()["items"]
    today = datetime.now().astimezone().date()
    horizon = (today + timedelta(days=days_ahead)).isoformat() if days_ahead else None

    filtered: list[dict] = []
    for it in items:
        s = it.get("status", "open")
        if status != "all" and s != status and not (
                status == "open" and _is_overdue(it.get("due"), s)):
            continue
        if owner and it.get("owner", "").lower() != owner.lower():
            continue
        if contact:
            rc = (it.get("related_contact") or "").lower()
            if contact.lower() not in rc:
                continue
        if horizon and status == "open" and it.get("due") and it["due"] > horizon:
            continue
        filtered.append(it)

    def sort_key(rec: dict) -> tuple:
        # Overdue first, then due-date asc (no due → far future), then
        # priority (high → low), then created-asc.
        overdue = _is_overdue(rec.get("due"), rec.get("status", "open"))
        due = rec.get("due") or "9999-12-31"
        prio = {"high": 0, "medium": 1, "low": 2}.get(rec.get("priority", "medium"), 1)
        return (0 if overdue else 1, due, prio, rec.get("created", ""))

    filtered.sort(key=sort_key)
    return {"ok": True, "count": len(filtered), "items": filtered[:limit]}


def _find_one(id_or_text: str, items: list[dict]) -> dict | None:
    if not id_or_text:
        return None
    if id_or_text.startswith("cmt_"):
        for it in items:
            if it.get("id") == id_or_text:
                return it
    # Fuzzy match on text — pick the highest-similarity open item.
    target = _normalize(id_or_text)
    if not target:
        return None
    best: dict | None = None
    best_score = 0.0
    for it in items:
        nt = _normalize(it.get("text", ""))
        if not nt:
            continue
        score = 0.0
        if nt == target:
            score = 1.0
        elif target in nt or nt in target:
            score = max(len(target), len(nt)) / max(len(target), len(nt), 1)
            score = min(0.9, len(set(target.split()) & set(nt.split())) /
                        max(1, len(set(target.split()) | set(nt.split()))))
        else:
            tw, nw = set(target.split()), set(nt.split())
            if tw and nw:
                score = len(tw & nw) / len(tw | nw)
        # Open items beat closed items at the same score.
        if it.get("status") == "open":
            score += 0.05
        if score > best_score:
            best_score = score
            best = it
    return best if best_score >= 0.4 else None


def complete_commitment(id_or_text: str, sync: bool = True) -> dict:
    if not _gate_enabled():
        return {"error": "JARVIS_COMMITMENTS=0"}
    items_data = _load_items()
    item = _find_one(id_or_text, items_data["items"])
    if not item:
        return {"error": f"no commitment matched {id_or_text!r}"}
    if item.get("status") == "done":
        return {"ok": True, "commitment": item, "already_done": True}

    item["status"] = "done"
    item["completed"] = _now_iso()
    _save_items(items_data)
    _log(f"completed {item['id']} '{item['text']}'")
    _emit("complete", "success", context={"id": item["id"]})

    sync_results: dict = {}
    if sync:
        # Best-effort propagation. Failures don't block the local update.
        trello = _load_sibling("jarvis-trello.py")
        if trello is not None and item.get("synced_to", {}).get("trello"):
            try:
                sync_results["trello"] = trello.complete_card(
                    item["synced_to"]["trello"])
            except Exception as e:
                sync_results["trello"] = {"error": str(e)}
        apple = _load_sibling("jarvis-apple.py")
        if apple is not None and item.get("synced_to", {}).get("apple_reminders"):
            try:
                sync_results["apple"] = apple.apple_complete_reminder_by_id(
                    item["synced_to"]["apple_reminders"])
            except Exception as e:
                sync_results["apple"] = {"error": str(e)}
        # Fallback: complete by text if no remote id was stored.
        if "apple" not in sync_results and apple is not None:
            try:
                sync_results["apple"] = apple.apple_complete_reminder(item["text"])
            except Exception:
                pass

    return {"ok": True, "commitment": item, "synced": sync_results}


def update_commitment(id_or_text: str, **fields) -> dict:
    if not _gate_enabled():
        return {"error": "JARVIS_COMMITMENTS=0"}
    items_data = _load_items()
    item = _find_one(id_or_text, items_data["items"])
    if not item:
        return {"error": f"no commitment matched {id_or_text!r}"}
    allowed = {"text", "due", "priority", "status", "related_contact",
               "tags", "notes", "owner"}
    for k, v in fields.items():
        if k not in allowed or v is None:
            continue
        if k == "due":
            v = _parse_due(v) or v
        if k == "priority" and v not in PRIORITY_VALUES:
            continue
        if k == "status" and v not in STATUS_VALUES:
            continue
        item[k] = v
    _save_items(items_data)
    return {"ok": True, "commitment": item}


# ── reports + briefing ────────────────────────────────────────────────
def commitment_report(days: int = 7) -> dict:
    if not _gate_enabled():
        return {"error": "JARVIS_COMMITMENTS=0"}
    items = _load_items()["items"]
    today = datetime.now().astimezone().date()
    horizon = today + timedelta(days=days)
    week_ago = today - timedelta(days=7)

    overdue, due_today, due_week, others_owe, recently_done = [], [], [], [], []
    for it in items:
        status = it.get("status", "open")
        due = it.get("due")
        owner = (it.get("owner") or "watson").lower()
        if status == "open":
            if owner != "watson":
                others_owe.append(it)
            elif due:
                try:
                    d = date.fromisoformat(due)
                except ValueError:
                    continue
                if d < today:
                    overdue.append(it)
                elif d == today:
                    due_today.append(it)
                elif d <= horizon:
                    due_week.append(it)
        elif status == "done" and it.get("completed"):
            try:
                cd = date.fromisoformat(it["completed"][:10])
            except ValueError:
                continue
            if cd >= week_ago:
                recently_done.append(it)

    return {
        "ok": True,
        "as_of": today.isoformat(),
        "overdue": sorted(overdue, key=lambda x: x.get("due") or ""),
        "due_today": due_today,
        "due_this_week": sorted(due_week, key=lambda x: x.get("due") or ""),
        "others_owe_watson": others_owe,
        "recently_completed": recently_done,
        "counts": {
            "overdue": len(overdue),
            "due_today": len(due_today),
            "due_this_week": len(due_week),
            "others_owe_watson": len(others_owe),
            "recently_completed": len(recently_done),
        },
    }


def briefing_section() -> str:
    """Markdown block for jarvis-briefing. Empty when nothing pressing."""
    rep = commitment_report(days=7)
    if not rep.get("ok"):
        return ""
    counts = rep.get("counts") or {}
    if not (counts.get("overdue") or counts.get("due_today") or
            counts.get("due_this_week")):
        return ""
    lines = ["## Commitments"]
    if rep["overdue"]:
        lines.append(f"\n**Overdue** ({len(rep['overdue'])})")
        for it in rep["overdue"][:5]:
            lines.append(f"- {it['text']} (due {it.get('due', '?')})"
                         + (f" — {it['related_contact']}" if it.get('related_contact') else ""))
    if rep["due_today"]:
        lines.append(f"\n**Due today** ({len(rep['due_today'])})")
        for it in rep["due_today"][:5]:
            lines.append(f"- {it['text']}"
                         + (f" — {it['related_contact']}" if it.get('related_contact') else ""))
    if rep["due_this_week"]:
        lines.append(f"\n**Due this week** ({len(rep['due_this_week'])})")
        for it in rep["due_this_week"][:5]:
            lines.append(f"- {it['text']} ({it.get('due', '?')})")
    if rep["others_owe_watson"]:
        lines.append(f"\n**Others owe you** ({len(rep['others_owe_watson'])})")
        for it in rep["others_owe_watson"][:3]:
            who = it.get("owner") or "?"
            lines.append(f"- {who}: {it['text']}")
    return "\n".join(lines) + "\n"


def context_hint() -> str:
    """One-liner for the system prompt. Empty when nothing pressing."""
    if not _gate_enabled():
        return ""
    rep = commitment_report(days=7)
    if not rep.get("ok"):
        return ""
    c = rep.get("counts") or {}
    bits = []
    if c.get("overdue"):
        bits.append(f"{c['overdue']} overdue")
    if c.get("due_today"):
        bits.append(f"{c['due_today']} due today")
    if c.get("due_this_week"):
        bits.append(f"{c['due_this_week']} this week")
    if not bits:
        return ""
    return ("**Commitments:** " + ", ".join(bits)
            + ". If Watson asks 'what's on my plate', call list_commitments first.")


def context_hint_for_contact(name: str) -> str:
    """Inline hint when Watson mentions a specific contact and there are
    open commitments touching them."""
    if not _gate_enabled() or not name:
        return ""
    rep = list_commitments(status="open", contact=name, days_ahead=None, limit=5)
    items = rep.get("items") or []
    if not items:
        return ""
    bits = []
    for it in items[:3]:
        owner = it.get("owner", "watson")
        prefix = "you owe" if owner == "watson" else f"{owner} owes you"
        due = f" (due {it['due']})" if it.get("due") else ""
        bits.append(f"{prefix}: {it['text']}{due}")
    return f"**Open with {name}:** " + " · ".join(bits)


# ── sync ──────────────────────────────────────────────────────────────
def sync(systems: list[str] | None = None) -> dict:
    """Push canonical items to Trello + Apple Reminders, then pull
    completion signals back. Best-effort; never raises."""
    if not _gate_enabled():
        return {"error": "JARVIS_COMMITMENTS=0"}
    systems = systems or ["trello", "apple"]
    out: dict = {"ok": True, "results": {}}
    if "trello" in systems:
        trello = _load_sibling("jarvis-trello.py")
        if trello is not None and hasattr(trello, "trello_sync"):
            try:
                out["results"]["trello"] = trello.trello_sync()
            except Exception as e:
                out["results"]["trello"] = {"error": str(e)}
        else:
            out["results"]["trello"] = {"skipped": "module missing"}
    if "apple" in systems:
        apple = _load_sibling("jarvis-apple.py")
        if apple is not None and hasattr(apple, "apple_sync_commitments"):
            try:
                out["results"]["apple"] = apple.apple_sync_commitments()
            except Exception as e:
                out["results"]["apple"] = {"error": str(e)}
        else:
            out["results"]["apple"] = {"skipped": "module missing"}
    state = _read_json(SYNC_STATE_FILE, {})
    state["last_sync"] = _now_iso()
    state["last_results"] = out["results"]
    _write_json(SYNC_STATE_FILE, state)
    return out


# ── status / overdue mark ─────────────────────────────────────────────
def mark_overdue() -> int:
    """Promote open items past their due date to overdue status.
    Returns the count promoted. Cheap; called from jarvis-improve."""
    if not _gate_enabled():
        return 0
    items_data = _load_items()
    n = 0
    for it in items_data["items"]:
        if it.get("status") == "open" and _is_overdue(it.get("due"), "open"):
            # We don't actually flip status — "overdue" is computed live
            # so list_commitments(status="open") still surfaces it. But
            # we tag the item so reports stay consistent. Real flip kept
            # for items past due by 14 days (truly stale).
            try:
                d = date.fromisoformat(it["due"])
                if (datetime.now().astimezone().date() - d).days >= 14:
                    it["status"] = "overdue"
                    n += 1
            except ValueError:
                continue
    if n:
        _save_items(items_data)
    return n


# ── CLI ───────────────────────────────────────────────────────────────
def _cli(argv: list[str]) -> int:
    import argparse

    p = argparse.ArgumentParser(description="Jarvis commitment tracker")
    sub = p.add_subparsers(dest="cmd", required=True)

    pe = sub.add_parser("extract")
    pe.add_argument("text")
    pe.add_argument("--source", default="conversation")
    pe.add_argument("--context", default=None)
    pe.add_argument("--dry-run", action="store_true")

    pa = sub.add_parser("add")
    pa.add_argument("text")
    pa.add_argument("--due", default=None)
    pa.add_argument("--priority", default="medium",
                    choices=sorted(PRIORITY_VALUES))
    pa.add_argument("--contact", default=None)
    pa.add_argument("--tags", default=None,
                    help="comma-separated")
    pa.add_argument("--owner", default="watson")
    pa.add_argument("--notes", default=None)

    pl = sub.add_parser("list")
    pl.add_argument("--status", default="open",
                    choices=("open", "done", "overdue", "cancelled", "all"))
    pl.add_argument("--owner", default=None)
    pl.add_argument("--contact", default=None)
    pl.add_argument("--days-ahead", type=int, default=7)
    pl.add_argument("--limit", type=int, default=50)

    pc = sub.add_parser("complete")
    pc.add_argument("id_or_text")
    pc.add_argument("--no-sync", action="store_true")

    pu = sub.add_parser("update")
    pu.add_argument("id_or_text")
    pu.add_argument("--text", default=None)
    pu.add_argument("--due", default=None)
    pu.add_argument("--priority", default=None)
    pu.add_argument("--status", default=None)
    pu.add_argument("--contact", default=None)
    pu.add_argument("--notes", default=None)

    sub.add_parser("report")
    sub.add_parser("briefing-section")
    sub.add_parser("context-hint")

    ps = sub.add_parser("sync")
    ps.add_argument("--systems", default="trello,apple")

    pcmark = sub.add_parser("mark-overdue")

    args = p.parse_args(argv)
    if args.cmd == "extract":
        out = extract_commitments(args.text, source_type=args.source,
                                  context=args.context, dry_run=args.dry_run)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0 if out.get("ok") else 1
    if args.cmd == "add":
        tags = [t.strip() for t in args.tags.split(",")] if args.tags else None
        out = add_commitment(args.text, due=args.due, priority=args.priority,
                             contact=args.contact, tags=tags,
                             owner=args.owner, notes=args.notes)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0 if out.get("ok") else 1
    if args.cmd == "list":
        out = list_commitments(status=args.status, owner=args.owner,
                               contact=args.contact,
                               days_ahead=args.days_ahead, limit=args.limit)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0 if out.get("ok") else 1
    if args.cmd == "complete":
        out = complete_commitment(args.id_or_text, sync=not args.no_sync)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0 if out.get("ok") else 1
    if args.cmd == "update":
        fields = {k: v for k, v in vars(args).items()
                  if k not in ("cmd", "id_or_text") and v is not None}
        if "contact" in fields:
            fields["related_contact"] = fields.pop("contact")
        out = update_commitment(args.id_or_text, **fields)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0 if out.get("ok") else 1
    if args.cmd == "report":
        print(json.dumps(commitment_report(), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "briefing-section":
        print(briefing_section())
        return 0
    if args.cmd == "context-hint":
        print(context_hint())
        return 0
    if args.cmd == "sync":
        systems = [s.strip() for s in args.systems.split(",") if s.strip()]
        print(json.dumps(sync(systems=systems), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "mark-overdue":
        n = mark_overdue()
        print(json.dumps({"ok": True, "promoted": n}, ensure_ascii=False))
        return 0
    return 2


if __name__ == "__main__":
    try:
        sys.exit(_cli(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
