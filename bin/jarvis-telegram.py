#!/usr/bin/env python3
"""Telegram intelligence agent — group chat monitoring and reporting.

Watson adds @BotFather-issued bot to his group chats; this module reads what's
happening and surfaces what matters. Stdlib-only HTTP (urllib + json), matching
jarvis-research.py's approach.

Public functions (all return JSON-serializable dicts so jarvis-think.py wires
them straight into the tool layer):

    check_telegram(group_name=None, hours=4)
        Recent messages from monitored groups, optionally filtered by name
        (fuzzy match on title). Reads from the local cache — the polling
        thread in wake-listener is the single writer.

    telegram_digest(hours=12, priority="all")
        Per-group AI summary via Haiku. Identifies decisions, action items
        directed at Watson, urgent threads. priority filters to groups with
        that priority tier ("all" = everything).

    send_telegram(group_name, message, reply_to=None, confirm=False)
        Send a message to a group. confirm=True required — same safety net
        as send_email.

    telegram_search(query, group_name=None, hours=48)
        Substring search across the cache with one message of context on
        either side.

Setup is interactive. Watson creates a bot via @BotFather, sets
TELEGRAM_BOT_TOKEN in the env, then runs:

    bin/jarvis-telegram.py --setup

The wizard verifies the token, deletes any stale webhook (mutually exclusive
with getUpdates), prints instructions for adding the bot to groups +
disabling its privacy mode, then collects chat_ids from the update buffer
and lets Watson tag each with a priority.

Files written:
    ~/.jarvis/telegram/config.json          monitored groups + priorities
    ~/.jarvis/telegram/state.json           {last_update_id} for getUpdates pagination
    ~/.jarvis/telegram/cache/{chat_id}.jsonl one line per message, append-only
    ~/.jarvis/logs/telegram.log             timestamped diagnostic log

Gate: JARVIS_TELEGRAM=1 (default 1 if TELEGRAM_BOT_TOKEN is set, else 0).

CLI:
    bin/jarvis-telegram.py --setup
    bin/jarvis-telegram.py --status
    bin/jarvis-telegram.py --check [group_name] [--hours N]
    bin/jarvis-telegram.py --digest [--hours N] [--priority high|normal|low|all]
    bin/jarvis-telegram.py --search "query" [--group X] [--hours N]
    bin/jarvis-telegram.py --send GROUP "message"
    bin/jarvis-telegram.py --poll-once   (one getUpdates round; for cron / debug)
    bin/jarvis-telegram.py --poll-loop   (long-poll forever; used by wake-listener)
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
TELEGRAM_DIR = ASSISTANT_DIR / "telegram"
CONFIG_FILE = TELEGRAM_DIR / "config.json"
STATE_FILE = TELEGRAM_DIR / "state.json"
CACHE_DIR = TELEGRAM_DIR / "cache"
LOG_DIR = ASSISTANT_DIR / "logs"
TELEGRAM_LOG = LOG_DIR / "telegram.log"

API_BASE = "https://api.telegram.org/bot{token}"
LONG_POLL_TIMEOUT_S = int(os.environ.get("JARVIS_TELEGRAM_LONG_POLL_S", "25"))
HTTP_TIMEOUT_S = float(os.environ.get("JARVIS_TELEGRAM_HTTP_TIMEOUT_S", "10"))
CACHE_RETENTION_DAYS = int(os.environ.get("JARVIS_TELEGRAM_RETENTION_DAYS", "7"))

DIGEST_MODEL = os.environ.get("JARVIS_TELEGRAM_DIGEST_MODEL", "claude-haiku-4-5-20251001")
DIGEST_MAX_MESSAGES = int(os.environ.get("JARVIS_TELEGRAM_DIGEST_MAX", "60"))


# ── Logging ─────────────────────────────────────────────────────────
def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with TELEGRAM_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


# ── Gate ────────────────────────────────────────────────────────────
def _gate_default() -> str:
    """JARVIS_TELEGRAM defaults on iff a token is configured. Keeps installs
    that haven't set up the bot from paying any cost."""
    return "1" if os.environ.get("TELEGRAM_BOT_TOKEN") else "0"


def _gate_check() -> dict | None:
    if os.environ.get("JARVIS_TELEGRAM", _gate_default()) != "1":
        return {"error": "telegram disabled (JARVIS_TELEGRAM=0 or no TELEGRAM_BOT_TOKEN)"}
    if not os.environ.get("TELEGRAM_BOT_TOKEN"):
        return {"error": "TELEGRAM_BOT_TOKEN not set"}
    return None


def _api_url(method: str) -> str:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    return API_BASE.format(token=token) + "/" + method


# ── Bot API call ────────────────────────────────────────────────────
def _api_call(method: str, params: dict | None = None,
              timeout: float | None = None) -> dict:
    """POST to the Telegram Bot API. Returns parsed `result` on ok=true,
    else {"error": "..."} with the API's description so the model has
    something concrete to read back."""
    url = _api_url(method)
    body = json.dumps(params or {}).encode("utf-8")
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json"},
    )
    eff_timeout = timeout if timeout is not None else HTTP_TIMEOUT_S
    try:
        with urllib.request.urlopen(req, timeout=eff_timeout) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            err_body = json.loads(e.read())
            desc = err_body.get("description") or str(e)
        except Exception:
            desc = str(e)
        return {"error": f"telegram api {e.code}: {desc}"}
    except (urllib.error.URLError, TimeoutError) as e:
        return {"error": f"network: {e}"}
    except Exception as e:
        return {"error": f"unexpected: {e}"}
    if not data.get("ok"):
        return {"error": f"telegram: {data.get('description', 'unknown error')}"}
    return data.get("result")


# ── Config + state persistence ──────────────────────────────────────
def _load_config() -> dict:
    if not CONFIG_FILE.exists():
        return {"monitored_groups": []}
    try:
        with CONFIG_FILE.open() as f:
            data = json.load(f)
    except Exception:
        return {"monitored_groups": []}
    if not isinstance(data, dict):
        return {"monitored_groups": []}
    data.setdefault("monitored_groups", [])
    return data


def _save_config(cfg: dict) -> None:
    TELEGRAM_DIR.mkdir(parents=True, exist_ok=True)
    with CONFIG_FILE.open("w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)


def _load_state() -> dict:
    if not STATE_FILE.exists():
        return {"last_update_id": 0}
    try:
        with STATE_FILE.open() as f:
            data = json.load(f)
    except Exception:
        return {"last_update_id": 0}
    if not isinstance(data, dict):
        return {"last_update_id": 0}
    data.setdefault("last_update_id", 0)
    return data


def _save_state(state: dict) -> None:
    TELEGRAM_DIR.mkdir(parents=True, exist_ok=True)
    with STATE_FILE.open("w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)


# ── Group lookup (fuzzy) ────────────────────────────────────────────
_WHITESPACE_RE = re.compile(r"\s+")


def _normalize_title(s: str) -> str:
    return _WHITESPACE_RE.sub(" ", (s or "").strip()).lower()


def _find_group(query: str, cfg: dict | None = None) -> dict | None:
    """Fuzzy-match a group by title. Exact (case-insensitive) wins over
    substring; substring wins over startswith. Returns the monitored_groups
    entry or None."""
    if not query:
        return None
    cfg = cfg or _load_config()
    groups = cfg.get("monitored_groups") or []
    if not groups:
        return None
    q = _normalize_title(query)

    exact = [g for g in groups if _normalize_title(g.get("title", "")) == q]
    if exact:
        return exact[0]
    contains = [g for g in groups if q in _normalize_title(g.get("title", ""))]
    if len(contains) == 1:
        return contains[0]
    if contains:
        # Multiple hits — return the shortest title (most specific match).
        return min(contains, key=lambda g: len(g.get("title") or ""))
    starts = [g for g in groups if _normalize_title(g.get("title", "")).startswith(q)]
    if starts:
        return starts[0]
    return None


# ── Cache I/O (per-chat JSONL) ──────────────────────────────────────
def _cache_path(chat_id: int) -> Path:
    return CACHE_DIR / f"{chat_id}.jsonl"


def _append_message(record: dict) -> None:
    """Append one message record to its chat's cache. Best-effort; failures
    are logged but never raised — losing a message is preferable to crashing
    the polling thread."""
    chat_id = record.get("chat_id")
    if chat_id is None:
        return
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with _cache_path(chat_id).open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as e:
        _log(f"cache append failed (chat {chat_id}): {e}")


def _read_cache(chat_id: int, since_ts: float) -> list[dict]:
    """Pull messages from one chat's cache newer than since_ts (unix). Bad
    lines are skipped — the cache is append-only so a partial write never
    blocks the rest."""
    path = _cache_path(chat_id)
    if not path.exists():
        return []
    out: list[dict] = []
    try:
        with path.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("date", 0) >= since_ts:
                    out.append(rec)
    except Exception as e:
        _log(f"cache read failed (chat {chat_id}): {e}")
    return out


def _prune_cache(retention_days: int = CACHE_RETENTION_DAYS) -> int:
    """Drop messages older than retention_days from every per-chat cache.
    Rewrites the file in place — cheap because we cap chat traffic at
    a few MB. Returns the count of pruned messages."""
    if not CACHE_DIR.exists():
        return 0
    cutoff = time.time() - (retention_days * 86400)
    pruned = 0
    for path in CACHE_DIR.glob("*.jsonl"):
        try:
            kept: list[str] = []
            with path.open(encoding="utf-8") as f:
                for line in f:
                    line = line.rstrip("\n")
                    if not line.strip():
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        # Drop unparseable lines — they were lost anyway.
                        pruned += 1
                        continue
                    if rec.get("date", 0) >= cutoff:
                        kept.append(line)
                    else:
                        pruned += 1
            if pruned:
                with path.open("w", encoding="utf-8") as f:
                    f.write("\n".join(kept) + ("\n" if kept else ""))
        except Exception as e:
            _log(f"cache prune failed ({path.name}): {e}")
    if pruned:
        _log(f"pruned {pruned} cache messages older than {retention_days}d")
    return pruned


# ── Update parsing ──────────────────────────────────────────────────
def _extract_message(update: dict) -> dict | None:
    """Pull the message field out of an update — Telegram delivers messages
    under several keys depending on the event (message, edited_message,
    channel_post). Returns None for events we don't care about (callback
    queries, inline queries, member updates, etc.)."""
    for key in ("message", "edited_message", "channel_post", "edited_channel_post"):
        msg = update.get(key)
        if msg:
            return msg
    return None


def _format_record(message: dict) -> dict | None:
    """Convert a Telegram Message object into the cache record shape.
    Returns None for messages we don't want to store (no chat, service
    messages with no text/media)."""
    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    if chat_id is None:
        return None
    chat_type = chat.get("type") or ""
    # We only care about groups + supergroups + channels — DMs aren't
    # the use case ("group chat monitoring").
    if chat_type not in ("group", "supergroup", "channel"):
        return None
    sender = message.get("from") or {}
    sender_name_parts = [sender.get("first_name") or "", sender.get("last_name") or ""]
    sender_name = " ".join(p for p in sender_name_parts if p).strip()
    if not sender_name:
        sender_name = sender.get("username") or chat.get("title") or "(unknown)"

    text = message.get("text") or message.get("caption") or ""
    has_media = any(k in message for k in (
        "photo", "video", "document", "audio", "voice", "video_note",
        "sticker", "animation",
    ))
    reply_to = None
    rt = message.get("reply_to_message")
    if isinstance(rt, dict):
        reply_to = rt.get("message_id")

    if not text and not has_media:
        # Service message (member added, pinned, etc.) — skip.
        return None

    return {
        "message_id": message.get("message_id"),
        "chat_id": chat_id,
        "chat_title": chat.get("title") or "",
        "chat_type": chat_type,
        "from_id": sender.get("id"),
        "from_name": sender_name,
        "from_username": sender.get("username") or "",
        "text": text,
        "date": message.get("date") or 0,
        "has_media": has_media,
        "reply_to": reply_to,
    }


def _record_for_monitored_group(record: dict, cfg: dict) -> bool:
    """Only cache messages from groups the user has opted to monitor."""
    monitored_ids = {g.get("id") for g in cfg.get("monitored_groups") or []}
    return record.get("chat_id") in monitored_ids


# ── Polling ─────────────────────────────────────────────────────────
def poll_once(timeout: int = 0) -> dict:
    """Single getUpdates round. Used by --poll-once for cron / debug, and
    by --setup to discover chat ids. timeout=0 means non-blocking; >0 is
    long-poll seconds.

    Returns {ok, fetched, stored, last_update_id, errors} or {error}."""
    gate = _gate_check()
    if gate:
        return gate
    state = _load_state()
    cfg = _load_config()
    offset = state.get("last_update_id", 0) + 1 if state.get("last_update_id") else 0
    params: dict = {"timeout": timeout}
    if offset:
        params["offset"] = offset
    # Telegram's getUpdates requires a longer HTTP timeout than the
    # long-poll timeout itself — give it 5 extra seconds of headroom.
    res = _api_call("getUpdates", params, timeout=timeout + 5 if timeout else HTTP_TIMEOUT_S)
    if isinstance(res, dict) and res.get("error"):
        _log(f"getUpdates error: {res['error']}")
        return res
    updates = res or []
    fetched = len(updates)
    stored = 0
    errors: list[str] = []
    max_id = state.get("last_update_id", 0)
    for u in updates:
        uid = u.get("update_id", 0)
        if uid > max_id:
            max_id = uid
        msg = _extract_message(u)
        if not msg:
            continue
        rec = _format_record(msg)
        if not rec:
            continue
        if not _record_for_monitored_group(rec, cfg):
            # Cache the chat id under "discovered" so --setup can find it
            # even after the polling thread has acknowledged the update.
            _record_discovered(rec)
            continue
        _append_message(rec)
        stored += 1
    if max_id != state.get("last_update_id", 0):
        state["last_update_id"] = max_id
        _save_state(state)
    return {
        "ok": True,
        "fetched": fetched,
        "stored": stored,
        "last_update_id": max_id,
        "errors": errors,
    }


def poll_loop() -> None:
    """Long-poll forever. Designed to be the wake-listener's background
    thread target. Exits only on KeyboardInterrupt or unrecoverable error
    (e.g. invalid token — surfaces once to the log and stops)."""
    gate = _gate_check()
    if gate:
        _log(f"poll_loop refused to start: {gate['error']}")
        return
    _prune_cache()  # one-time cleanup at startup
    backoff = 1.0
    consecutive_errors = 0
    while True:
        try:
            res = poll_once(timeout=LONG_POLL_TIMEOUT_S)
        except KeyboardInterrupt:
            _log("poll_loop stopped by user")
            return
        except Exception as e:
            _log(f"poll_loop iteration crashed: {e}")
            time.sleep(min(backoff, 60))
            backoff = min(backoff * 2, 60)
            continue
        if isinstance(res, dict) and res.get("error"):
            err = res["error"]
            consecutive_errors += 1
            # 401 / invalid token never recovers — bail out instead of
            # hammering the API in a tight loop.
            if "401" in err or "Unauthorized" in err:
                _log(f"poll_loop fatal: {err} — stopping")
                return
            _log(f"poll_loop transient error: {err} (#{consecutive_errors})")
            time.sleep(min(backoff, 60))
            backoff = min(backoff * 2, 60)
            continue
        # Successful round — reset backoff. Long-poll already ate the
        # full timeout window if there were no updates, so no extra
        # sleep needed.
        consecutive_errors = 0
        backoff = 1.0


# ── Discovered chats (for --setup) ──────────────────────────────────
DISCOVERED_FILE = TELEGRAM_DIR / "discovered.json"


def _record_discovered(rec: dict) -> None:
    """Track chats we've seen but aren't yet monitoring, so --setup can
    list them as candidates without making the user re-post messages."""
    try:
        TELEGRAM_DIR.mkdir(parents=True, exist_ok=True)
        seen: dict = {}
        if DISCOVERED_FILE.exists():
            try:
                seen = json.loads(DISCOVERED_FILE.read_text(encoding="utf-8"))
            except Exception:
                seen = {}
        chat_id = rec.get("chat_id")
        if chat_id is None:
            return
        seen[str(chat_id)] = {
            "id": chat_id,
            "title": rec.get("chat_title") or "",
            "type": rec.get("chat_type") or "",
            "last_seen": rec.get("date") or int(time.time()),
        }
        DISCOVERED_FILE.write_text(json.dumps(seen, indent=2, ensure_ascii=False),
                                    encoding="utf-8")
    except Exception as e:
        _log(f"discovered write failed: {e}")


def _load_discovered() -> list[dict]:
    if not DISCOVERED_FILE.exists():
        return []
    try:
        seen = json.loads(DISCOVERED_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []
    return list(seen.values()) if isinstance(seen, dict) else []


# ── Public: check_telegram ──────────────────────────────────────────
def check_telegram(group_name: str | None = None, hours: int = 4) -> dict:
    """Return recent messages from monitored groups. Reads from cache —
    the polling thread is the single getUpdates consumer."""
    gate = _gate_check()
    if gate:
        return gate
    cfg = _load_config()
    groups = cfg.get("monitored_groups") or []
    if not groups:
        return {"error": "no monitored groups — run `jarvis-telegram.py --setup`"}
    if group_name:
        target = _find_group(group_name, cfg)
        if not target:
            return {"error": f"no monitored group matches {group_name!r}"}
        groups = [target]
    since = time.time() - max(0, hours) * 3600
    out: list[dict] = []
    for g in groups:
        for rec in _read_cache(g["id"], since):
            out.append({
                "group": g.get("title") or rec.get("chat_title"),
                "group_id": g["id"],
                "priority": g.get("priority", "normal"),
                "sender": rec.get("from_name"),
                "username": rec.get("from_username") or "",
                "text": rec.get("text") or "",
                "timestamp": rec.get("date"),
                "datetime": _format_ts(rec.get("date")),
                "has_media": rec.get("has_media", False),
                "reply_to": rec.get("reply_to"),
                "message_id": rec.get("message_id"),
            })
    out.sort(key=lambda r: r.get("timestamp") or 0)
    return {"ok": True, "messages": out, "count": len(out), "hours": hours}


def _format_ts(ts: int | float | None) -> str:
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    except Exception:
        return ""


# ── Public: telegram_search ─────────────────────────────────────────
def telegram_search(query: str, group_name: str | None = None,
                    hours: int = 48) -> dict:
    """Substring search across the cache. Returns matching messages with
    one message of context on either side."""
    gate = _gate_check()
    if gate:
        return gate
    query = (query or "").strip()
    if not query:
        return {"error": "query is required"}
    res = check_telegram(group_name=group_name, hours=hours)
    if res.get("error"):
        return res
    msgs = res["messages"]
    q_lower = query.lower()
    hits: list[dict] = []
    for i, m in enumerate(msgs):
        if q_lower not in (m.get("text") or "").lower():
            continue
        before = msgs[i - 1] if i > 0 and msgs[i - 1].get("group_id") == m.get("group_id") else None
        after = msgs[i + 1] if (i + 1 < len(msgs) and msgs[i + 1].get("group_id") == m.get("group_id")) else None
        hits.append({"match": m, "before": before, "after": after})
    return {"ok": True, "query": query, "hits": hits, "count": len(hits)}


# ── Public: telegram_digest ─────────────────────────────────────────
DIGEST_SYSTEM = """You are summarizing one Telegram group chat for Watson.

Output ONE valid JSON object — no prose, no fences. Schema:

{
  "summary": "2-3 sentences in past tense, EA register. What happened, what was decided, what's open.",
  "action_items": ["Items directed at Watson or @everyone he should personally handle. Empty list if none."],
  "urgent": true | false,
  "key_topics": ["short", "noun", "phrases"]
}

Rules:
- urgent=true ONLY when there's a direct question to Watson, a deadline today/tomorrow, or a fire to put out. Default false.
- action_items list each as one imperative phrase ("Reply to Karina re Tuesday demo"). Drop items already resolved in-thread.
- If the chat is just chitchat / memes / noise, summary should say so plainly and action_items=[]/urgent=false.
- Quantify when useful (e.g. "five messages debating venue").
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


def _summarize_group(group_title: str, messages: list[dict], api_key: str) -> dict:
    """Call Haiku for one group's summary block. Returns the parsed JSON
    or a fallback with the raw text if parsing fails."""
    if not messages:
        return {"summary": "No activity.", "action_items": [], "urgent": False, "key_topics": []}
    # Trim to DIGEST_MAX_MESSAGES so a runaway group doesn't blow context.
    trimmed = messages[-DIGEST_MAX_MESSAGES:]
    transcript_lines = []
    for m in trimmed:
        ts = _format_ts(m.get("timestamp"))
        sender = m.get("sender") or "(unknown)"
        text = m.get("text") or ("[media]" if m.get("has_media") else "")
        prefix = f"[{ts}] {sender}: "
        transcript_lines.append(prefix + text)
    transcript = "\n".join(transcript_lines)
    prompt = f"Group: {group_title}\nMessages ({len(trimmed)}):\n\n{transcript}"
    try:
        raw = _anthropic_call(api_key, DIGEST_MODEL, DIGEST_SYSTEM, prompt,
                               max_tokens=600, timeout=20)
    except Exception as e:
        return {
            "summary": f"Summary failed: {e}",
            "action_items": [],
            "urgent": False,
            "key_topics": [],
        }
    # Pull the first JSON object out of the response — defends against
    # the model ignoring "no fences" and wrapping it in ```json ... ```.
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return {"summary": raw[:300], "action_items": [], "urgent": False, "key_topics": []}
    try:
        parsed = json.loads(m.group(0))
    except json.JSONDecodeError:
        return {"summary": raw[:300], "action_items": [], "urgent": False, "key_topics": []}
    parsed.setdefault("summary", "")
    parsed.setdefault("action_items", [])
    parsed.setdefault("urgent", False)
    parsed.setdefault("key_topics", [])
    return parsed


def telegram_digest(hours: int = 12, priority: str = "all") -> dict:
    """AI-summarized digest, one block per active group. Returns
    {ok, groups: [{name, message_count, summary, action_items, urgent,
    key_topics, priority}]}."""
    gate = _gate_check()
    if gate:
        return gate
    cfg = _load_config()
    groups = cfg.get("monitored_groups") or []
    if not groups:
        return {"error": "no monitored groups — run `jarvis-telegram.py --setup`"}
    if priority not in ("all", "high", "normal", "low"):
        priority = "all"
    if priority != "all":
        groups = [g for g in groups if (g.get("priority") or "normal") == priority]
        if not groups:
            return {"ok": True, "groups": [], "hours": hours, "priority": priority}
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {"error": "ANTHROPIC_API_KEY not set"}

    since = time.time() - max(0, hours) * 3600
    out_groups: list[dict] = []
    for g in groups:
        cached = _read_cache(g["id"], since)
        if not cached:
            continue
        # Map cache records to the same shape as check_telegram for the
        # transcript builder.
        prepped = [{
            "sender": r.get("from_name"),
            "text": r.get("text") or "",
            "has_media": r.get("has_media", False),
            "timestamp": r.get("date"),
        } for r in cached]
        summary = _summarize_group(g.get("title") or "", prepped, api_key)
        out_groups.append({
            "name": g.get("title") or "",
            "id": g["id"],
            "priority": g.get("priority", "normal"),
            "message_count": len(cached),
            "summary": summary.get("summary") or "",
            "action_items": summary.get("action_items") or [],
            "urgent": bool(summary.get("urgent")),
            "key_topics": summary.get("key_topics") or [],
        })
    # Sort: urgent first, then high-priority, then by message count.
    priority_rank = {"high": 0, "normal": 1, "low": 2}
    out_groups.sort(key=lambda g: (
        not g.get("urgent"),
        priority_rank.get(g.get("priority", "normal"), 1),
        -g.get("message_count", 0),
    ))
    return {"ok": True, "groups": out_groups, "hours": hours, "priority": priority}


# ── Public: send_telegram ───────────────────────────────────────────
def send_telegram(group_name: str, message: str,
                  reply_to: int | None = None,
                  confirm: bool = False) -> dict:
    """Send a message to a monitored group. Same confirm guard as
    send_email — the model must explicitly pass confirm=True after
    Watson's spoken yes."""
    gate = _gate_check()
    if gate:
        return gate
    if not group_name or not message:
        return {"error": "group_name and message required"}
    target = _find_group(group_name)
    if not target:
        return {"error": f"no monitored group matches {group_name!r}"}
    if not confirm:
        return {
            "sent": False,
            "needs_confirmation": True,
            "group": target.get("title") or "",
            "preview": message[:200],
            "hint": (
                "Read the preview to Watson. After he says yes, re-call "
                "with confirm=true."
            ),
        }
    params: dict = {
        "chat_id": target["id"],
        "text": message,
    }
    if reply_to:
        params["reply_to_message_id"] = int(reply_to)
        params["allow_sending_without_reply"] = True
    res = _api_call("sendMessage", params)
    if isinstance(res, dict) and res.get("error"):
        return res
    sent = res or {}
    _log(f"sent to {target.get('title')!r} ({target['id']}): {message[:80]}")
    return {
        "sent": True,
        "group": target.get("title") or "",
        "message_id": sent.get("message_id"),
        "chat_id": sent.get("chat", {}).get("id"),
    }


# ── Setup wizard ────────────────────────────────────────────────────
SETUP_INSTRUCTIONS = """
=== Jarvis Telegram setup ===

1. Confirm your bot token. Talk to @BotFather on Telegram, run /mybots,
   pick the bot you want Jarvis to use, and copy its API token.
   Set it in your shell:

       export TELEGRAM_BOT_TOKEN=...

   (or add it to ~/.jarvis/config/.env so cron picks it up)

2. Add the bot to each group you want monitored.

3. Disable privacy mode so the bot can see all messages, not just
   @mentions. In @BotFather: /mybots → pick bot → Bot Settings →
   Group Privacy → Turn off.

4. Have someone send a message in each group (or post a "/test"
   yourself). Telegram will only surface the chat_id once the bot has
   actually received an update from it.

Press ENTER when ready, or Ctrl+C to abort.
"""


def _read_line(prompt: str) -> str:
    sys.stdout.write(prompt)
    sys.stdout.flush()
    try:
        return sys.stdin.readline().rstrip("\n")
    except KeyboardInterrupt:
        raise


def setup() -> int:
    """Interactive setup. Returns exit code (0 = ok, non-zero = abort)."""
    if not os.environ.get("TELEGRAM_BOT_TOKEN"):
        print("TELEGRAM_BOT_TOKEN is not set. Export it first, then re-run --setup.",
              file=sys.stderr)
        return 2
    me = _api_call("getMe")
    if isinstance(me, dict) and me.get("error"):
        print(f"Token check failed: {me['error']}", file=sys.stderr)
        return 2
    bot_username = (me or {}).get("username") or "?"
    print(f"Token OK. Bot is @{bot_username}.")

    # deleteWebhook is mutually exclusive with getUpdates — silently
    # clearing any stale registration here saves a lot of "why isn't
    # polling working" debugging.
    res = _api_call("deleteWebhook", {"drop_pending_updates": False})
    if isinstance(res, dict) and res.get("error"):
        print(f"Warning: deleteWebhook failed ({res['error']}). Continuing.",
              file=sys.stderr)

    print(SETUP_INSTRUCTIONS)
    try:
        _read_line("> ")
    except KeyboardInterrupt:
        print("\nAborted.")
        return 1

    print("Polling once for any pending updates...")
    poll_res = poll_once(timeout=0)
    if isinstance(poll_res, dict) and poll_res.get("error"):
        print(f"Poll failed: {poll_res['error']}", file=sys.stderr)
        return 2

    candidates = _load_discovered()
    cfg = _load_config()
    already_ids = {g.get("id") for g in cfg.get("monitored_groups") or []}
    new_candidates = [c for c in candidates if c.get("id") not in already_ids]

    if not new_candidates and not cfg.get("monitored_groups"):
        print("No new chats discovered. Make sure the bot is in a group, "
              "privacy mode is off, and someone has posted a message.")
        return 1

    if cfg.get("monitored_groups"):
        print("\nAlready monitored:")
        for g in cfg["monitored_groups"]:
            print(f"  - {g.get('title') or '(no title)'} (id {g['id']}, "
                  f"priority {g.get('priority', 'normal')})")
    if not new_candidates:
        print("\nNo new chats to add.")
        return 0

    print("\nDiscovered chats:")
    for i, c in enumerate(new_candidates, start=1):
        print(f"  [{i}] {c.get('title') or '(untitled)'} ({c.get('type')}, id {c['id']})")

    print("\nFor each chat enter a priority (high|normal|low) or 'skip'.")
    added = 0
    for c in new_candidates:
        title = c.get("title") or f"(id {c['id']})"
        ans = _read_line(f"  {title}: ").strip().lower()
        if ans in ("skip", "s", "no", "n", ""):
            continue
        if ans in ("h", "high"):
            prio = "high"
        elif ans in ("l", "low"):
            prio = "low"
        else:
            prio = "normal"
        cfg.setdefault("monitored_groups", []).append({
            "id": c["id"],
            "title": c.get("title") or "",
            "type": c.get("type") or "",
            "priority": prio,
        })
        added += 1
    _save_config(cfg)

    # Clear discovered file once written through — avoids stale entries
    # cluttering the next setup run.
    try:
        if DISCOVERED_FILE.exists():
            DISCOVERED_FILE.unlink()
    except Exception:
        pass

    print(f"\nAdded {added} group(s). Config at {CONFIG_FILE}.")
    return 0


# ── Status helper ───────────────────────────────────────────────────
def status() -> dict:
    """Diagnostic snapshot for `--status` and the briefing module."""
    cfg = _load_config()
    state = _load_state()
    groups = cfg.get("monitored_groups") or []
    counts = []
    for g in groups:
        path = _cache_path(g["id"])
        n = 0
        last_ts = 0
        if path.exists():
            try:
                with path.open() as f:
                    for line in f:
                        if not line.strip():
                            continue
                        n += 1
                        try:
                            rec = json.loads(line)
                            if rec.get("date", 0) > last_ts:
                                last_ts = rec["date"]
                        except json.JSONDecodeError:
                            continue
            except Exception:
                pass
        counts.append({
            "id": g["id"],
            "title": g.get("title") or "",
            "priority": g.get("priority", "normal"),
            "cached_messages": n,
            "last_message": _format_ts(last_ts) if last_ts else "",
        })
    return {
        "ok": True,
        "monitored_groups": counts,
        "last_update_id": state.get("last_update_id"),
        "token_set": bool(os.environ.get("TELEGRAM_BOT_TOKEN")),
        "gate": os.environ.get("JARVIS_TELEGRAM", _gate_default()) == "1",
    }


def urgent_pending() -> int:
    """Best-effort count of monitored groups that look urgent right now,
    used by jarvis-context.py for a system-prompt hint. Cheap heuristic
    only — no Anthropic call. We check the last 60 minutes of cache for
    messages whose text matches a small set of urgency tokens."""
    cfg = _load_config()
    groups = cfg.get("monitored_groups") or []
    if not groups:
        return 0
    since = time.time() - 3600
    tokens_re = re.compile(
        r"\b(urgent|asap|now|emergency|today|deadline|"
        r"please respond|@watson|hey watson|need (you|your))\b",
        re.I,
    )
    flagged = 0
    for g in groups:
        for rec in _read_cache(g["id"], since):
            text = rec.get("text") or ""
            if tokens_re.search(text):
                flagged += 1
                break  # one flag per group is enough
    return flagged


def context_hint() -> str:
    """One-line system-prompt hint when there's urgent group-chat traffic
    pending. Empty in the common case (keeps the cache warm)."""
    n = urgent_pending()
    if not n:
        return ""
    return (
        f"**Telegram:** {n} monitored group{'s' if n != 1 else ''} has "
        "messages in the last hour that look urgent (deadlines, direct "
        "asks, emergencies). If Watson asks 'what's happening' or similar, "
        "lead with `telegram_digest(hours=2)`."
    )


# ── CLI ─────────────────────────────────────────────────────────────
def _cli() -> int:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
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

    if cmd == "--setup":
        return setup()
    if cmd == "--status":
        print(json.dumps(status(), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--poll-once":
        timeout = int(_flag("--timeout", "0") or "0")
        print(json.dumps(poll_once(timeout=timeout), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--poll-loop":
        try:
            poll_loop()
        except KeyboardInterrupt:
            return 0
        return 0
    if cmd == "--check":
        group = None
        if rest and not rest[0].startswith("--"):
            group = rest[0]
        hours = int(_flag("--hours", "4") or "4")
        print(json.dumps(check_telegram(group_name=group, hours=hours),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--digest":
        hours = int(_flag("--hours", "12") or "12")
        priority = _flag("--priority", "all") or "all"
        print(json.dumps(telegram_digest(hours=hours, priority=priority),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--search":
        if not rest or rest[0].startswith("--"):
            print("usage: --search QUERY [--group X] [--hours N]", file=sys.stderr)
            return 2
        query = rest[0]
        group = _flag("--group")
        hours = int(_flag("--hours", "48") or "48")
        print(json.dumps(telegram_search(query=query, group_name=group, hours=hours),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--send":
        if len(rest) < 2:
            print("usage: --send GROUP MESSAGE [--reply-to N] [--confirm]", file=sys.stderr)
            return 2
        group = rest[0]
        message = rest[1]
        reply_to = _flag("--reply-to")
        confirm = "--confirm" in rest
        print(json.dumps(
            send_telegram(group_name=group, message=message,
                          reply_to=int(reply_to) if reply_to else None,
                          confirm=confirm),
            indent=2, ensure_ascii=False,
        ))
        return 0
    if cmd == "--prune":
        days = int(_flag("--days", str(CACHE_RETENTION_DAYS)) or str(CACHE_RETENTION_DAYS))
        n = _prune_cache(retention_days=days)
        print(json.dumps({"pruned": n, "retention_days": days}, indent=2))
        return 0
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
