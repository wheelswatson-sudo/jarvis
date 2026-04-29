#!/usr/bin/env python3
"""Shared primitive layer — the substrate every Jarvis capability shares.

Each capability used to reach into jarvis_memory, jarvis-contacts,
jarvis-email, etc. directly. That worked for one or two but produced
copy-pasted lazy-loaders, ad-hoc retrieval logic, and inconsistent config
access in every new tool. This module extracts the five primitives every
capability actually needs:

    primitive.retrieve(query, sources=…, limit=…)
        unified search — memory, contacts, email, telegram, social, research
        cache. Returns ranked, source-tagged hits.

    primitive.remember(key, value, ttl_days=…)
    primitive.recall(key_or_query)
    primitive.forget(key)
        key/value memory pointer with optional TTL. Falls through to
        jarvis_memory's free-text store so primitive entries also benefit
        from the wider semantic recall path.

    primitive.schedule_once(when, action, context=…)
    primitive.schedule_recurring(interval_s, action, context=…)
    primitive.cancel(schedule_id)
    primitive.run_due()
        timer/cron at ~/.jarvis/state/schedules.json. `action` is a shell
        command string; run_due() spawns it detached. Called by
        jarvis-improve every pass.

    primitive.emit(cap, action, status, …)
        re-exported from outcome_ledger so callers have a single import.

    primitive.config(key, default=None)
    primitive.feature_enabled(name)
        unified config: JARVIS_{KEY} env var beats settings.json beats default.

Design rules:
  - All sibling modules are lazy-loaded so importing primitive.py is cheap.
  - Every operation is best-effort and never raises on disk/network error;
    caller code stays uncluttered.
  - State files use atomic write (tempfile + replace) so a crash mid-write
    leaves the previous version intact.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
BIN_DIR = ASSISTANT_DIR / "bin"
LIB_DIR = ASSISTANT_DIR / "lib"
STATE_DIR = ASSISTANT_DIR / "state"
CONFIG_FILE = Path(os.environ.get("CONFIG_FILE", str(ASSISTANT_DIR / "config" / "settings.json")))

KV_PATH = STATE_DIR / "primitive-kv.json"
SCHEDULES_PATH = STATE_DIR / "schedules.json"


# ── lazy module loaders ────────────────────────────────────────────────
def _load_module(module_name: str, relative: str, search_dirs: list[Path]) -> Any:
    """Look for `relative` (e.g. 'jarvis-email.py' or 'outcome_ledger.py') in
    each of `search_dirs` and import the first hit under `module_name`. None
    if missing."""
    for d in search_dirs:
        src = d / relative
        if src.exists():
            try:
                spec = importlib.util.spec_from_file_location(module_name, src)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)  # type: ignore[union-attr]
                return mod
            except Exception as e:
                sys.stderr.write(f"primitive: load {relative} failed ({e})\n")
                return None
    return None


_BIN_SEARCH = [BIN_DIR, Path(__file__).parent.parent / "bin"]
_LIB_SEARCH = [LIB_DIR, Path(__file__).parent]

_cache: dict[str, Any] = {}


def _ledger():
    if "ledger" not in _cache:
        _cache["ledger"] = _load_module("outcome_ledger", "outcome_ledger.py", _LIB_SEARCH)
    return _cache["ledger"]


def _memory_mod():
    if "memory" not in _cache:
        _cache["memory"] = _load_module("jarvis_memory", "jarvis_memory.py", _BIN_SEARCH)
    return _cache["memory"]


def _contacts_mod():
    if "contacts" not in _cache:
        _cache["contacts"] = _load_module("jarvis_contacts", "jarvis-contacts.py", _BIN_SEARCH)
    return _cache["contacts"]


def _email_mod():
    if "email" not in _cache:
        _cache["email"] = _load_module("jarvis_email", "jarvis-email.py", _BIN_SEARCH)
    return _cache["email"]


def _telegram_mod():
    if "telegram" not in _cache:
        _cache["telegram"] = _load_module("jarvis_telegram", "jarvis-telegram.py", _BIN_SEARCH)
    return _cache["telegram"]


def _social_mod():
    if "social" not in _cache:
        _cache["social"] = _load_module("jarvis_social", "jarvis-social.py", _BIN_SEARCH)
    return _cache["social"]


def _research_mod():
    if "research" not in _cache:
        _cache["research"] = _load_module("jarvis_research", "jarvis-research.py", _BIN_SEARCH)
    return _cache["research"]


# ── atomic JSON I/O ───────────────────────────────────────────────────
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
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
        return True
    except Exception:
        return False


# ── 1. Retrieval ──────────────────────────────────────────────────────
SOURCE_PRIORITY: dict[str, float] = {
    # Hand-tuned: closer-to-the-user signals get a small lift over the
    # broader feeds so a memory hit beats a noisy social mention on a tie.
    "memory": 1.2,
    "contacts": 1.1,
    "email": 1.0,
    "telegram": 0.9,
    "research": 0.8,
    "social": 0.7,
}


def _normalize_hit(source: str, text: str, ts: str | None = None,
                   relevance: float = 1.0, meta: dict | None = None) -> dict:
    return {
        "source": source,
        "text": (text or "").strip(),
        "ts": ts or "",
        "relevance": float(relevance),
        "meta": meta or {},
    }


def _src_memory(query: str, limit: int) -> list[dict]:
    mod = _memory_mod()
    if mod is None:
        return []
    try:
        mem = mod.Memory()
        hits = mem.recall(query, limit=limit) if query else mem.recent(limit)
    except Exception:
        return []
    out: list[dict] = []
    for r in hits:
        out.append(_normalize_hit(
            "memory", r.get("text", ""), ts=r.get("created_at"),
            relevance=1.0, meta={"id": r.get("id"), "tags": r.get("tags", [])},
        ))
    return out


def _src_contacts(query: str, limit: int) -> list[dict]:
    mod = _contacts_mod()
    if mod is None or not query:
        return []
    try:
        rec = mod.lookup_contact(query)
    except Exception:
        return []
    if not rec.get("found"):
        return []
    contact = rec.get("contact") or {}
    summary_bits = [contact.get("name", "")]
    brief = contact.get("relationship_brief") or contact.get("brief") or ""
    if brief:
        summary_bits.append(str(brief)[:200])
    return [_normalize_hit(
        "contacts", " — ".join(b for b in summary_bits if b),
        ts=contact.get("updated_at"), relevance=1.5,
        meta={"key": rec.get("key")},
    )][:limit]


def _src_email(query: str, limit: int) -> list[dict]:
    mod = _email_mod()
    if mod is None:
        return []
    try:
        # Convert a freeform query into a Gmail filter: a user search like
        # "Corbin pricing" maps to a body/subject/from match by default.
        gmail_q = query if (":" in (query or "")) else (query or "is:unread")
        rec = mod.check_email(max_results=limit, query=gmail_q)
    except Exception:
        return []
    out: list[dict] = []
    for m in (rec.get("messages") or [])[:limit]:
        text = f"{m.get('from','')} — {m.get('subject','')} :: {m.get('snippet','')}"
        out.append(_normalize_hit(
            "email", text, ts=m.get("date"), relevance=1.0,
            meta={"id": m.get("id"), "thread_id": m.get("thread_id")},
        ))
    return out


def _src_telegram(query: str, limit: int) -> list[dict]:
    mod = _telegram_mod()
    if mod is None or not query:
        return []
    try:
        rec = mod.telegram_search(query=query, hours=72)
    except Exception:
        return []
    out: list[dict] = []
    for m in (rec.get("messages") or [])[:limit]:
        text = f"[{m.get('group','')}] {m.get('from','')}: {m.get('text','')}"
        out.append(_normalize_hit(
            "telegram", text, ts=m.get("ts"), relevance=1.0,
            meta={"chat_id": m.get("chat_id"), "message_id": m.get("message_id")},
        ))
    return out


def _src_social(query: str, limit: int) -> list[dict]:
    mod = _social_mod()
    if mod is None or not query:
        return []
    try:
        rec = mod.social_search(query=query, hours=72)
    except Exception:
        return []
    out: list[dict] = []
    for it in (rec.get("items") or rec.get("results") or [])[:limit]:
        text = f"[{it.get('platform','')}] {it.get('author','')}: {it.get('text','')}"
        out.append(_normalize_hit(
            "social", text, ts=it.get("ts") or it.get("created_at"),
            relevance=1.0, meta={"id": it.get("id"), "platform": it.get("platform")},
        ))
    return out


def _src_research(query: str, limit: int) -> list[dict]:
    """Search the research cache only — no live web call. The cache lives at
    ~/.jarvis/cache/research/*.json, one file per cached topic."""
    cache_dir = ASSISTANT_DIR / "cache" / "research"
    if not cache_dir.exists() or not query:
        return []
    q = query.lower()
    out: list[dict] = []
    for path in sorted(cache_dir.glob("*.json"))[-50:]:  # last ~50 cached entries
        try:
            rec = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        topic = (rec.get("topic") or rec.get("query") or "").lower()
        summary = rec.get("summary") or rec.get("result") or ""
        body = f"{topic} {summary}".lower()
        if q in body:
            out.append(_normalize_hit(
                "research", summary[:300], ts=rec.get("ts"),
                relevance=1.0, meta={"path": str(path)},
            ))
    return out[:limit]


_SOURCE_FUNCS: dict[str, Callable[[str, int], list[dict]]] = {
    "memory": _src_memory,
    "contacts": _src_contacts,
    "email": _src_email,
    "telegram": _src_telegram,
    "social": _src_social,
    "research": _src_research,
}


def _recency_factor(ts: str | None) -> float:
    """Map ISO timestamp → exp decay over a 30-day half-life, clamped 0.1..1.0
    so older hits still surface when nothing else is fresh."""
    if not ts:
        return 0.4
    try:
        t = datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.4
    age_days = max(0.0, (time.time() - t) / 86400.0)
    import math
    return max(0.1, math.exp(-age_days / 30.0))


def retrieve(query: str, sources: Iterable[str] | None = None,
             limit: int = 5) -> list[dict]:
    """Fan out across sources, score each hit by
    relevance * recency * source_priority, return top-`limit` deduped."""
    src_names = list(sources) if sources else list(_SOURCE_FUNCS.keys())
    src_names = [s for s in src_names if s in _SOURCE_FUNCS]
    per_src = max(2, limit)

    raw: list[dict] = []
    for s in src_names:
        try:
            raw.extend(_SOURCE_FUNCS[s](query, per_src))
        except Exception:
            continue

    seen: set[str] = set()
    scored: list[tuple[float, dict]] = []
    for h in raw:
        key = f"{h['source']}|{h['text'][:80]}"
        if key in seen:
            continue
        seen.add(key)
        score = (
            float(h.get("relevance") or 0.0)
            * _recency_factor(h.get("ts"))
            * SOURCE_PRIORITY.get(h["source"], 0.5)
        )
        h["score"] = round(score, 3)
        scored.append((score, h))
    scored.sort(key=lambda t: t[0], reverse=True)
    return [h for _, h in scored[:limit]]


# ── 2. Memory pointer (KV with TTL + free-text fallback) ──────────────
def _now() -> float:
    return time.time()


def _kv_load() -> dict:
    return _read_json(KV_PATH, {})


def _kv_save(data: dict) -> None:
    _write_json(KV_PATH, data)


def _kv_purge_expired(data: dict) -> bool:
    """Drop expired entries in place. Returns True iff anything was removed."""
    now = _now()
    dropped = []
    for k, entry in list(data.items()):
        exp = entry.get("expires")
        if exp and exp < now:
            dropped.append(k)
    for k in dropped:
        data.pop(k, None)
    return bool(dropped)


def remember(key: str, value: Any, ttl_days: float | None = None) -> dict:
    """Set `key=value` in the KV store with optional TTL. Also drops a
    free-text breadcrumb in jarvis_memory so semantic recall still finds it.

    Idempotent: re-calling overwrites the same key."""
    if not key:
        return {"ok": False, "error": "key required"}
    data = _kv_load()
    _kv_purge_expired(data)
    expires = (_now() + ttl_days * 86400.0) if ttl_days else None
    data[key] = {
        "value": value,
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "ttl_days": ttl_days,
        "expires": expires,
    }
    _kv_save(data)

    mod = _memory_mod()
    if mod is not None:
        try:
            text = f"{key} = {value}" if isinstance(value, (str, int, float, bool)) else key
            mod.Memory().remember(text, tags=["primitive", key], source="primitive")
        except Exception:
            pass
    return {"ok": True, "key": key, "expires": expires}


def recall(key_or_query: str) -> dict:
    """Exact KV match wins. Otherwise fall back to fuzzy memory search and
    return the top hit. Returns {"hit": bool, "value": …, "source": "kv"|"memory"}."""
    if not key_or_query:
        return {"hit": False}
    data = _kv_load()
    if _kv_purge_expired(data):
        _kv_save(data)
    if key_or_query in data:
        entry = data[key_or_query]
        return {"hit": True, "source": "kv", "key": key_or_query,
                "value": entry.get("value"), "ts": entry.get("ts")}
    mod = _memory_mod()
    if mod is None:
        return {"hit": False}
    try:
        hits = mod.Memory().recall(key_or_query, limit=1)
    except Exception:
        return {"hit": False}
    if not hits:
        return {"hit": False}
    h = hits[0]
    return {"hit": True, "source": "memory", "value": h.get("text"),
            "ts": h.get("created_at"), "memory_id": h.get("id")}


def forget(key: str) -> dict:
    """Drop the KV entry AND any free-text breadcrumbs tagged with this key.
    Returns {"ok": True, "kv_removed": bool, "memory_removed": int}."""
    if not key:
        return {"ok": False, "error": "key required"}
    data = _kv_load()
    kv_removed = key in data
    if kv_removed:
        data.pop(key, None)
        _kv_save(data)

    mem_removed = 0
    mod = _memory_mod()
    if mod is not None:
        try:
            mem = mod.Memory()
            for r in mem.all():
                tags = r.get("tags") or []
                if "primitive" in tags and key in tags:
                    mem.forget(r["id"])
                    mem_removed += 1
        except Exception:
            pass
    return {"ok": True, "kv_removed": kv_removed, "memory_removed": mem_removed}


# ── 3. Scheduling ─────────────────────────────────────────────────────
def _schedules_load() -> dict:
    return _read_json(SCHEDULES_PATH, {"schedules": []})


def _schedules_save(data: dict) -> None:
    _write_json(SCHEDULES_PATH, data)


def _parse_when(when: Any) -> datetime | None:
    """Accepts ISO 8601 string OR datetime OR epoch-seconds float/int."""
    if isinstance(when, datetime):
        return when if when.tzinfo else when.astimezone()
    if isinstance(when, (int, float)):
        return datetime.fromtimestamp(float(when), tz=timezone.utc)
    if isinstance(when, str):
        try:
            dt = datetime.fromisoformat(when.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.astimezone()
        except Exception:
            return None
    return None


def schedule_once(when: Any, action: str,
                  context: dict | None = None) -> dict:
    """Fire `action` once at `when`. `action` is a shell command string."""
    target = _parse_when(when)
    if target is None:
        return {"ok": False, "error": f"could not parse when: {when!r}"}
    if not action or not isinstance(action, str):
        return {"ok": False, "error": "action (shell command) required"}
    sid = uuid.uuid4().hex[:12]
    data = _schedules_load()
    data["schedules"].append({
        "id": sid,
        "type": "once",
        "when": target.astimezone(timezone.utc).isoformat(timespec="seconds"),
        "action": action,
        "context": context or {},
        "fired": False,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })
    _schedules_save(data)
    return {"ok": True, "id": sid, "when": target.isoformat()}


def schedule_recurring(interval_s: int | float, action: str,
                       context: dict | None = None) -> dict:
    """Fire `action` every `interval_s` seconds, starting now + interval."""
    if interval_s is None or float(interval_s) <= 0:
        return {"ok": False, "error": "interval_s must be positive"}
    if not action or not isinstance(action, str):
        return {"ok": False, "error": "action (shell command) required"}
    sid = uuid.uuid4().hex[:12]
    next_fire = datetime.now(timezone.utc) + timedelta(seconds=float(interval_s))
    data = _schedules_load()
    data["schedules"].append({
        "id": sid,
        "type": "recurring",
        "interval_s": float(interval_s),
        "next_fire": next_fire.isoformat(timespec="seconds"),
        "action": action,
        "context": context or {},
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })
    _schedules_save(data)
    return {"ok": True, "id": sid, "next_fire": next_fire.isoformat()}


def cancel(schedule_id: str) -> dict:
    data = _schedules_load()
    before = len(data["schedules"])
    data["schedules"] = [s for s in data["schedules"] if s.get("id") != schedule_id]
    removed = before - len(data["schedules"])
    if removed:
        _schedules_save(data)
    return {"ok": True, "removed": removed}


def list_schedules() -> list[dict]:
    return _schedules_load().get("schedules") or []


def _spawn(action: str) -> int:
    """Run `action` detached. Returns 0 on launch (not on completion)."""
    try:
        subprocess.Popen(
            ["bash", "-c", action],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return 0
    except Exception:
        return 1


def run_due(now: datetime | None = None) -> list[dict]:
    """Fire every schedule whose due-time is <= now. One-shots are removed
    after firing; recurring entries get their next_fire bumped. Returns the
    list of schedule records that were fired (so jarvis-improve can log)."""
    now_dt = now or datetime.now(timezone.utc)
    data = _schedules_load()
    fired: list[dict] = []
    keep: list[dict] = []
    dirty = False
    for s in data.get("schedules") or []:
        try:
            if s.get("type") == "once":
                when = _parse_when(s.get("when"))
                if when and when <= now_dt and not s.get("fired"):
                    _spawn(s["action"])
                    s["fired"] = True
                    s["fired_at"] = now_dt.isoformat(timespec="seconds")
                    fired.append(s)
                    dirty = True
                    # Drop one-shots once fired — keep the file lean.
                    continue
                keep.append(s)
            elif s.get("type") == "recurring":
                next_fire = _parse_when(s.get("next_fire"))
                if next_fire and next_fire <= now_dt:
                    _spawn(s["action"])
                    s["next_fire"] = (now_dt + timedelta(
                        seconds=float(s.get("interval_s") or 60)
                    )).isoformat(timespec="seconds")
                    s["last_fired_at"] = now_dt.isoformat(timespec="seconds")
                    fired.append(dict(s))
                    dirty = True
                keep.append(s)
            else:
                keep.append(s)
        except Exception:
            keep.append(s)

    if dirty:
        data["schedules"] = keep
        _schedules_save(data)
    return fired


# ── 4. Outcome emit (re-export from outcome_ledger) ───────────────────
def emit(cap: str, action: str, status: str,
         context: dict | None = None,
         latency_ms: int | float | None = None) -> dict:
    mod = _ledger()
    if mod is None:
        return {"ok": False, "error": "outcome_ledger missing"}
    try:
        return mod.emit(cap=cap, action=action, status=status,
                        context=context, latency_ms=latency_ms)
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── 5. Config ─────────────────────────────────────────────────────────
def _settings() -> dict:
    if not CONFIG_FILE.exists():
        return {}
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def config(key: str, default: Any = None) -> Any:
    """JARVIS_{KEY upper, dots→underscores} env var beats settings.json beats
    the supplied default. Env values stay strings — caller casts."""
    if not key:
        return default
    env_key = "JARVIS_" + key.replace(".", "_").replace("-", "_").upper()
    if env_key in os.environ:
        return os.environ[env_key]
    cfg = _settings()
    cur: Any = cfg
    for part in key.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return default
    return cur


def feature_enabled(name: str, default: bool = True) -> bool:
    """Check the JARVIS_{NAME} gate. Treats '0', 'false', 'no', '' as off."""
    if not name:
        return default
    env_key = "JARVIS_" + name.replace(".", "_").replace("-", "_").upper()
    raw = os.environ.get(env_key)
    if raw is None:
        return default
    return str(raw).strip().lower() not in ("0", "false", "no", "off", "")


# ── CLI ────────────────────────────────────────────────────────────────
def _cli(argv: list[str]) -> int:
    import argparse

    p = argparse.ArgumentParser(description="Jarvis primitive layer (CLI for testing)")
    sub = p.add_subparsers(dest="cmd", required=True)

    pr = sub.add_parser("retrieve")
    pr.add_argument("query")
    pr.add_argument("--sources", default=None, help="comma-separated source list")
    pr.add_argument("--limit", type=int, default=5)

    pm = sub.add_parser("remember")
    pm.add_argument("key")
    pm.add_argument("value")
    pm.add_argument("--ttl-days", type=float, default=None)

    pc = sub.add_parser("recall")
    pc.add_argument("key_or_query")

    pf = sub.add_parser("forget")
    pf.add_argument("key")

    ps = sub.add_parser("schedule-once")
    ps.add_argument("when")
    ps.add_argument("action")

    psr = sub.add_parser("schedule-recurring")
    psr.add_argument("interval_s", type=float)
    psr.add_argument("action")

    sub.add_parser("schedules")
    sub.add_parser("run-due")

    pcn = sub.add_parser("cancel")
    pcn.add_argument("schedule_id")

    pcfg = sub.add_parser("config")
    pcfg.add_argument("key")
    pcfg.add_argument("--default", default=None)

    pfe = sub.add_parser("feature-enabled")
    pfe.add_argument("name")

    args = p.parse_args(argv)
    if args.cmd == "retrieve":
        srcs = args.sources.split(",") if args.sources else None
        out = retrieve(args.query, sources=srcs, limit=args.limit)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "remember":
        print(json.dumps(remember(args.key, args.value, ttl_days=args.ttl_days),
                         ensure_ascii=False))
        return 0
    if args.cmd == "recall":
        print(json.dumps(recall(args.key_or_query), ensure_ascii=False))
        return 0
    if args.cmd == "forget":
        print(json.dumps(forget(args.key), ensure_ascii=False))
        return 0
    if args.cmd == "schedule-once":
        print(json.dumps(schedule_once(args.when, args.action), ensure_ascii=False))
        return 0
    if args.cmd == "schedule-recurring":
        print(json.dumps(schedule_recurring(args.interval_s, args.action),
                         ensure_ascii=False))
        return 0
    if args.cmd == "schedules":
        print(json.dumps(list_schedules(), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "run-due":
        fired = run_due()
        print(json.dumps({"fired": len(fired), "items": fired},
                         ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "cancel":
        print(json.dumps(cancel(args.schedule_id), ensure_ascii=False))
        return 0
    if args.cmd == "config":
        print(json.dumps({"key": args.key,
                          "value": config(args.key, args.default)},
                         ensure_ascii=False))
        return 0
    if args.cmd == "feature-enabled":
        print(json.dumps({"name": args.name, "enabled": feature_enabled(args.name)},
                         ensure_ascii=False))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
