#!/usr/bin/env python3
"""Apple integration layer — Reminders, Notes, iMessage, Contacts.

macOS-native surfaces the assistant talks to through `osascript` (JXA
for Reminders / Notes, AppleScript for Messages / Contacts) and a
read-only sqlite3 query against ~/Library/Messages/chat.db for iMessage
history. Stdlib only.

Public tools (returned by jarvis-think):

  Reminders (all in a 'Jarvis' list, auto-created on first use):
    apple_add_reminder(text, due=None, notes=None)
    apple_list_reminders(include_completed=False)
    apple_complete_reminder(name_or_id)

  Notes (folder 'Jarvis'):
    apple_save_note(title, body, append=False)
    apple_read_note(title)

  iMessage (read via sqlite, send via Messages.app):
    imessage_check(hours=24)
    imessage_read(handle, limit=20)
    imessage_send(handle, message, confirm=False)
    imessage_search_contacts(query)

  Contacts:
    apple_contacts_search(query)
    apple_contacts_list_all()        # full-dump for jarvis-contacts sync

Hooks for the rest of the assistant:

    briefing_section()
        Markdown 'iMessages' subsection — unread from contacts.
    context_hint(mentioned_names)
        Per-turn hint when a mentioned contact has unread iMessages.
    interaction_signal_for_contact(rec)
        Feeds iMessage interaction counts into network strength scoring.
    recent_urgent(minutes)
        Items the wake-listener can route as a fresh-DM notification.

Files:
    ~/.jarvis/apple/state.json    last_seen ROWID per chat
    ~/.jarvis/logs/apple.log      diagnostic log

Gates:
    JARVIS_APPLE=1     master gate (default 1 on Darwin, 0 elsewhere)
    JARVIS_IMESSAGE=1  iMessage-specific gate (default 1)

iMessage requires Full Disk Access on the running process to read
chat.db. We surface a clear error when permission is denied so Watson
knows to grant it via System Settings.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import platform
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
BIN_DIR = ASSISTANT_DIR / "bin"
LIB_DIR = ASSISTANT_DIR / "lib"
APPLE_DIR = ASSISTANT_DIR / "apple"
STATE_FILE = APPLE_DIR / "state.json"
LOG_DIR = ASSISTANT_DIR / "logs"
APPLE_LOG = LOG_DIR / "apple.log"

CHAT_DB = Path.home() / "Library" / "Messages" / "chat.db"
JARVIS_REMINDER_LIST = os.environ.get("JARVIS_REMINDER_LIST", "Jarvis")
JARVIS_NOTES_FOLDER = os.environ.get("JARVIS_NOTES_FOLDER", "Jarvis")

OSASCRIPT_TIMEOUT_S = float(os.environ.get("JARVIS_APPLE_TIMEOUT_S", "10"))
# Mac OS messages store dates as nanoseconds since 2001-01-01 UTC.
MAC_EPOCH_OFFSET = 978307200


# ── logging + gates ───────────────────────────────────────────────────
def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with APPLE_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def _is_macos() -> bool:
    return platform.system() == "Darwin"


def _apple_gate_default() -> str:
    return "1" if _is_macos() else "0"


def _apple_gate() -> dict | None:
    if os.environ.get("JARVIS_APPLE", _apple_gate_default()) != "1":
        return {"error": "apple integration disabled (not macOS or JARVIS_APPLE=0)"}
    if not _is_macos():
        return {"error": "apple integration requires macOS"}
    return None


def _imessage_gate() -> dict | None:
    base = _apple_gate()
    if base:
        return base
    if os.environ.get("JARVIS_IMESSAGE", "1") != "1":
        return {"error": "imessage disabled (JARVIS_IMESSAGE=0)"}
    if not CHAT_DB.exists():
        return {"error": f"chat.db not found at {CHAT_DB}"}
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


def _contacts():
    if "contacts" not in _cache:
        _cache["contacts"] = _load_module(
            "jarvis_contacts_for_apple", "jarvis-contacts.py", _BIN_SEARCH)
    return _cache["contacts"]


def _emit(action: str, status: str, **ctx) -> None:
    p = _primitive()
    if p is None:
        return
    try:
        cap = ctx.pop("__cap", "apple")
        p.emit(cap=cap, action=action, status=status, context=ctx)
    except Exception:
        pass


# ── state I/O ─────────────────────────────────────────────────────────
def _load_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_state(state: dict) -> None:
    APPLE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False),
                   encoding="utf-8")
    os.replace(tmp, STATE_FILE)


# ── osascript runner ─────────────────────────────────────────────────
def _run_osascript(script: str, *,
                   language: str = "JavaScript",
                   timeout: float | None = None) -> tuple[int, str, str]:
    """Run an osascript snippet. `language='JavaScript'` for JXA, else
    AppleScript. Returns (returncode, stdout, stderr). Output is utf-8
    decoded; trailing newlines are stripped."""
    cmd = ["osascript"]
    if language.lower() in ("javascript", "jxa", "js"):
        cmd += ["-l", "JavaScript"]
    cmd += ["-e", script]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=timeout if timeout is not None else OSASCRIPT_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        _log(f"osascript timeout: {script[:200]}")
        return 124, "", "osascript timed out"
    except FileNotFoundError:
        return 127, "", "osascript not found (macOS only)"
    return proc.returncode, (proc.stdout or "").rstrip("\n"), (proc.stderr or "").strip()


def _run_jxa(script: str, timeout: float | None = None) -> tuple[int, str, str]:
    return _run_osascript(script, language="JavaScript", timeout=timeout)


def _run_applescript(script: str, timeout: float | None = None) -> tuple[int, str, str]:
    return _run_osascript(script, language="AppleScript", timeout=timeout)


def _applescript_quote(s: str) -> str:
    """Quote a string for safe interpolation into an AppleScript literal."""
    return '"' + (s or "").replace("\\", "\\\\").replace('"', '\\"') + '"'


def _jxa_quote(s: str) -> str:
    """Quote a string for safe interpolation into a JXA template literal."""
    return json.dumps(s or "", ensure_ascii=False)


# ── name canonicalization ─────────────────────────────────────────────
_PUNCT_RE = re.compile(r"[^a-z0-9]+")


def _canonical(s: str) -> str:
    if not s:
        return ""
    norm = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    norm = _PUNCT_RE.sub(" ", norm.lower()).strip()
    return " ".join(norm.split())


# ── PUBLIC: apple_add_reminder ────────────────────────────────────────
def apple_add_reminder(text: str, due: str | None = None,
                       notes: str | None = None) -> dict:
    """Create a reminder in the 'Jarvis' list (auto-created). `due` is
    ISO 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SS'. Returns the reminder id."""
    gate = _apple_gate()
    if gate:
        return gate
    if not text or not text.strip():
        return {"error": "text is required"}

    due_iso = _normalize_due_iso(due)
    script = f"""
        var Reminders = Application('Reminders');
        Reminders.includeStandardAdditions = true;
        var listName = {_jxa_quote(JARVIS_REMINDER_LIST)};
        var lst;
        try {{ lst = Reminders.lists.byName(listName); lst.id(); }}
        catch (e) {{
            lst = Reminders.List({{name: listName}});
            Reminders.lists.push(lst);
        }}
        var props = {{name: {_jxa_quote(text.strip())}}};
        var notes = {_jxa_quote(notes or '')};
        if (notes) props.body = notes;
        var due = {_jxa_quote(due_iso or '')};
        if (due) props.dueDate = new Date(due);
        var r = Reminders.Reminder(props);
        lst.reminders.push(r);
        JSON.stringify({{id: r.id(), name: r.name(), due: due}});
    """
    rc, out, err = _run_jxa(script)
    if rc != 0:
        _emit("apple_add_reminder", "failed", error=err[:200])
        return {"error": f"reminder add failed: {err or 'rc=' + str(rc)}"}
    try:
        parsed = json.loads(out)
    except json.JSONDecodeError:
        return {"error": "reminder add: bad osascript output", "raw": out[:200]}
    _emit("apple_add_reminder", "success", id=parsed.get("id"))
    _log(f"reminder add id={parsed.get('id')} text={text[:80]!r}")
    return {"ok": True, "reminder": parsed}


def _normalize_due_iso(s: str | None) -> str | None:
    """Accept either a date or a datetime; emit a JS-parseable ISO
    string with no trailing timezone (Reminders' Date constructor reads
    local-time strings happily)."""
    if not s or not str(s).strip():
        return None
    raw = str(s).strip()
    # Already a datetime?
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return dt.isoformat()
    except ValueError:
        pass
    # Date-only? Default to 9am local.
    try:
        d = datetime.fromisoformat(raw + "T09:00:00")
        return d.isoformat()
    except ValueError:
        return raw  # let JS try


# ── PUBLIC: apple_list_reminders ──────────────────────────────────────
def apple_list_reminders(include_completed: bool = False,
                         limit: int = 50) -> dict:
    """List reminders in the 'Jarvis' list. Pending only by default."""
    gate = _apple_gate()
    if gate:
        return gate
    script = f"""
        var Reminders = Application('Reminders');
        var listName = {_jxa_quote(JARVIS_REMINDER_LIST)};
        var lst;
        try {{ lst = Reminders.lists.byName(listName); lst.id(); }}
        catch (e) {{ JSON.stringify([]); throw "no list"; }}
        var rems = lst.reminders();
        var includeCompleted = {('true' if include_completed else 'false')};
        var out = [];
        for (var i = 0; i < rems.length; i++) {{
            var r = rems[i];
            if (!includeCompleted && r.completed()) continue;
            var due = null;
            try {{ var d = r.dueDate(); if (d) due = d.toISOString(); }}
            catch (e) {{}}
            out.push({{
                id: r.id(),
                name: r.name(),
                completed: r.completed(),
                body: r.body() || "",
                due: due,
            }});
        }}
        JSON.stringify(out);
    """
    rc, out, err = _run_jxa(script)
    if rc != 0 and "no list" not in err:
        return {"error": f"reminders list failed: {err or 'rc=' + str(rc)}"}
    try:
        rems = json.loads(out) if out else []
    except json.JSONDecodeError:
        rems = []
    return {"ok": True, "list": JARVIS_REMINDER_LIST,
            "count": len(rems), "reminders": rems[:max(1, int(limit))]}


# ── PUBLIC: apple_complete_reminder ───────────────────────────────────
def apple_complete_reminder(name_or_id: str) -> dict:
    """Mark a reminder completed. Match by exact id, then by canonical
    substring of the name."""
    gate = _apple_gate()
    if gate:
        return gate
    if not name_or_id or not name_or_id.strip():
        return {"error": "name or id required"}
    needle = name_or_id.strip()
    script = f"""
        var Reminders = Application('Reminders');
        var listName = {_jxa_quote(JARVIS_REMINDER_LIST)};
        var lst = Reminders.lists.byName(listName);
        var rems = lst.reminders();
        var needle = {_jxa_quote(needle)};
        var needleLower = needle.toLowerCase();
        var hit = null;
        var matches = [];
        for (var i = 0; i < rems.length; i++) {{
            var r = rems[i];
            if (r.completed()) continue;
            if (r.id() === needle) {{ hit = r; break; }}
            var nm = (r.name() || "").toLowerCase();
            if (nm.indexOf(needleLower) !== -1) matches.push(r);
        }}
        if (!hit && matches.length === 1) hit = matches[0];
        if (!hit && matches.length > 1) {{
            var cands = matches.slice(0, 5).map(function(r) {{
                return {{id: r.id(), name: r.name()}};
            }});
            JSON.stringify({{error: "ambiguous", candidates: cands}});
        }} else if (!hit) {{
            JSON.stringify({{error: "no match"}});
        }} else {{
            hit.completed = true;
            JSON.stringify({{id: hit.id(), name: hit.name(),
                              completed: true}});
        }}
    """
    rc, out, err = _run_jxa(script)
    if rc != 0:
        return {"error": f"complete failed: {err or 'rc=' + str(rc)}"}
    try:
        parsed = json.loads(out)
    except json.JSONDecodeError:
        return {"error": "complete: bad osascript output", "raw": out[:200]}
    if parsed.get("error"):
        return parsed
    _emit("apple_complete_reminder", "success", id=parsed.get("id"))
    return {"ok": True, "reminder": parsed}


# ── PUBLIC: apple_save_note ───────────────────────────────────────────
def apple_save_note(title: str, body: str = "", append: bool = False) -> dict:
    """Create or update a note in the 'Jarvis' folder. With append=True,
    appends to the existing note's body instead of overwriting it."""
    gate = _apple_gate()
    if gate:
        return gate
    if not title or not title.strip():
        return {"error": "title is required"}
    script = f"""
        var Notes = Application('Notes');
        Notes.includeStandardAdditions = true;
        var folderName = {_jxa_quote(JARVIS_NOTES_FOLDER)};
        var folder;
        try {{ folder = Notes.folders.byName(folderName); folder.id(); }}
        catch (e) {{
            folder = Notes.Folder({{name: folderName}});
            Notes.folders.push(folder);
        }}
        var title = {_jxa_quote(title.strip())};
        var body  = {_jxa_quote(body or '')};
        var append = {('true' if append else 'false')};
        // Notes' note bodies are HTML — wrap our plain text in <pre>
        // so newlines survive.
        function escapeHtml(s) {{
            return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
        }}
        var existing = null;
        var notes = folder.notes();
        for (var i = 0; i < notes.length; i++) {{
            if ((notes[i].name() || '').trim() === title) {{
                existing = notes[i]; break;
            }}
        }}
        if (existing && append) {{
            var prev = existing.body();
            existing.body = prev + "<br><pre>" + escapeHtml(body) + "</pre>";
            JSON.stringify({{id: existing.id(), title: existing.name(),
                              appended: true}});
        }} else if (existing) {{
            existing.body = "<h1>" + escapeHtml(title) + "</h1><pre>"
                            + escapeHtml(body) + "</pre>";
            JSON.stringify({{id: existing.id(), title: existing.name(),
                              updated: true}});
        }} else {{
            var n = Notes.Note({{
                name: title,
                body: "<h1>" + escapeHtml(title) + "</h1><pre>"
                       + escapeHtml(body) + "</pre>",
            }});
            folder.notes.push(n);
            JSON.stringify({{id: n.id(), title: n.name(), created: true}});
        }}
    """
    rc, out, err = _run_jxa(script)
    if rc != 0:
        _emit("apple_save_note", "failed", error=err[:200])
        return {"error": f"note save failed: {err or 'rc=' + str(rc)}"}
    try:
        parsed = json.loads(out)
    except json.JSONDecodeError:
        return {"error": "note save: bad osascript output", "raw": out[:200]}
    _emit("apple_save_note", "success", id=parsed.get("id"))
    return {"ok": True, "note": parsed}


# ── PUBLIC: apple_read_note ───────────────────────────────────────────
def apple_read_note(title: str) -> dict:
    """Find a note in the 'Jarvis' folder by title (case-insensitive
    substring) and return its body as plain text."""
    gate = _apple_gate()
    if gate:
        return gate
    if not title or not title.strip():
        return {"error": "title is required"}
    script = f"""
        var Notes = Application('Notes');
        var folderName = {_jxa_quote(JARVIS_NOTES_FOLDER)};
        var folder = Notes.folders.byName(folderName);
        var notes = folder.notes();
        var needle = {_jxa_quote(title.strip())}.toLowerCase();
        var hit = null;
        for (var i = 0; i < notes.length; i++) {{
            var nm = (notes[i].name() || '').toLowerCase();
            if (nm.indexOf(needle) !== -1) {{ hit = notes[i]; break; }}
        }}
        if (!hit) JSON.stringify({{error: "no match"}});
        else JSON.stringify({{id: hit.id(), title: hit.name(),
                                body_html: hit.body()}});
    """
    rc, out, err = _run_jxa(script)
    if rc != 0:
        return {"error": f"note read failed: {err or 'rc=' + str(rc)}"}
    try:
        parsed = json.loads(out)
    except json.JSONDecodeError:
        return {"error": "note read: bad osascript output", "raw": out[:200]}
    if parsed.get("error"):
        return parsed
    body_text = _strip_html(parsed.get("body_html") or "")
    return {"ok": True, "note": {
        "id": parsed.get("id"), "title": parsed.get("title"),
        "body": body_text,
    }}


_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _strip_html(html: str) -> str:
    text = _TAG_RE.sub("\n", html or "")
    text = text.replace("&nbsp;", " ").replace("&amp;", "&") \
               .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
    return _WS_RE.sub(" ", text).strip()


# ── chat.db helpers ───────────────────────────────────────────────────
def _open_chatdb() -> sqlite3.Connection | None:
    """Open chat.db read-only. Returns None when permission is denied —
    caller surfaces a friendly error so Watson knows to grant Full Disk
    Access."""
    if not CHAT_DB.exists():
        return None
    try:
        # The URI form is the only way to get a true read-only handle
        # without risking writes if Apple's schema migrates under us.
        conn = sqlite3.connect(f"file:{CHAT_DB}?mode=ro&immutable=1",
                                uri=True, timeout=2.0)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.OperationalError as e:
        _log(f"chat.db open failed: {e}")
        return None


def _mac_ts_to_unix(mac_ns: int | float | None) -> float:
    if not mac_ns:
        return 0.0
    # Pre-High Sierra files store seconds; modern files store nanoseconds.
    n = float(mac_ns)
    if n > 1e15:
        n = n / 1e9
    return n + MAC_EPOCH_OFFSET


def _format_handle(h: str | None) -> str:
    if not h:
        return ""
    return h.strip()


def _resolve_handle(query: str, conn: sqlite3.Connection) -> list[dict]:
    """Resolve a free-form query (name fragment, phone digits, email)
    against the handle table. Returns matching {id, service} records."""
    q = (query or "").strip()
    if not q:
        return []
    # Pure-digit query → strip non-digits in handle.id and compare.
    digits = re.sub(r"\D", "", q)
    rows: list[dict] = []
    if digits and len(digits) >= 7:
        cur = conn.execute(
            "SELECT DISTINCT id, service FROM handle "
            "WHERE id LIKE ? OR REPLACE(REPLACE(REPLACE(id,'+',''),'-',''),' ','') LIKE ? "
            "LIMIT 12",
            (f"%{q}%", f"%{digits}%"),
        )
        rows = [dict(r) for r in cur.fetchall()]
    if not rows:
        cur = conn.execute(
            "SELECT DISTINCT id, service FROM handle WHERE id LIKE ? LIMIT 12",
            (f"%{q}%",),
        )
        rows = [dict(r) for r in cur.fetchall()]
    return rows


# ── PUBLIC: imessage_check ────────────────────────────────────────────
def imessage_check(hours: int = 24) -> dict:
    """Recent inbound messages (newest first). Drops `is_from_me=1`
    rows so Watson sees the queue, not his own outbox echoes."""
    gate = _imessage_gate()
    if gate:
        return gate
    conn = _open_chatdb()
    if conn is None:
        return {"error": "could not open chat.db — grant Full Disk Access "
                         "to your terminal in System Settings → Privacy"}
    cutoff_unix = time.time() - max(0, int(hours)) * 3600
    cutoff_mac_ns = int((cutoff_unix - MAC_EPOCH_OFFSET) * 1e9)
    rows = []
    try:
        cur = conn.execute(
            """
            SELECT m.ROWID as rowid, m.text, m.is_from_me, m.date,
                   m.is_read, h.id as handle, c.display_name,
                   c.chat_identifier
              FROM message m
              LEFT JOIN handle h ON m.handle_id = h.ROWID
              LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
              LEFT JOIN chat c ON c.ROWID = cmj.chat_id
              WHERE m.date >= ? AND m.is_from_me = 0
              ORDER BY m.date DESC
              LIMIT 200
            """,
            (cutoff_mac_ns,),
        )
        rows = [dict(r) for r in cur.fetchall()]
    except sqlite3.Error as e:
        return {"error": f"chat.db query: {e}"}
    finally:
        conn.close()

    out: list[dict] = []
    seen: set[str] = set()
    for r in rows:
        text = (r.get("text") or "").strip()
        if not text:
            continue
        rowid = r.get("rowid")
        if rowid in seen:
            continue
        seen.add(rowid)
        ts = _mac_ts_to_unix(r.get("date"))
        out.append({
            "rowid": rowid,
            "handle": _format_handle(r.get("handle")),
            "chat_identifier": r.get("chat_identifier"),
            "display_name": (r.get("display_name") or "").strip(),
            "text": text[:600],
            "is_read": bool(r.get("is_read")),
            "ts": ts,
            "iso": datetime.fromtimestamp(ts, tz=timezone.utc).astimezone().isoformat(timespec="seconds") if ts else None,
        })

    unread_count = sum(1 for m in out if not m["is_read"])
    by_handle: dict[str, list[dict]] = {}
    for m in out:
        by_handle.setdefault(m["handle"] or m.get("chat_identifier") or "?",
                             []).append(m)
    threads = [
        {
            "handle": k,
            "messages": v[:5],
            "newest_iso": v[0]["iso"] if v else None,
            "unread_count": sum(1 for x in v if not x["is_read"]),
        }
        for k, v in by_handle.items()
    ]
    threads.sort(key=lambda t: t["newest_iso"] or "", reverse=True)
    return {
        "ok": True, "hours": hours,
        "message_count": len(out),
        "unread_count": unread_count,
        "threads": threads[:50],
    }


# ── PUBLIC: imessage_read ─────────────────────────────────────────────
def imessage_read(handle: str, limit: int = 20) -> dict:
    """Read recent message history with one handle (phone or email).
    Returns oldest→newest so the result reads like a transcript."""
    gate = _imessage_gate()
    if gate:
        return gate
    if not handle or not handle.strip():
        return {"error": "handle is required"}
    conn = _open_chatdb()
    if conn is None:
        return {"error": "could not open chat.db (Full Disk Access needed)"}
    try:
        candidates = _resolve_handle(handle, conn)
        if not candidates:
            return {"ok": True, "handle": handle, "messages": [],
                    "hint": "no chat history with that handle"}
        ids = [c["id"] for c in candidates]
        placeholders = ",".join("?" * len(ids))
        cur = conn.execute(
            f"""
            SELECT m.ROWID as rowid, m.text, m.is_from_me, m.date, m.is_read,
                   h.id as handle, c.display_name
              FROM message m
              LEFT JOIN handle h ON m.handle_id = h.ROWID
              LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
              LEFT JOIN chat c ON c.ROWID = cmj.chat_id
             WHERE h.id IN ({placeholders})
             ORDER BY m.date DESC
             LIMIT ?
            """,
            (*ids, max(1, int(limit))),
        )
        rows = [dict(r) for r in cur.fetchall()]
    except sqlite3.Error as e:
        return {"error": f"chat.db query: {e}"}
    finally:
        conn.close()

    msgs: list[dict] = []
    for r in rows:
        text = (r.get("text") or "").strip()
        if not text:
            continue
        ts = _mac_ts_to_unix(r.get("date"))
        msgs.append({
            "rowid": r.get("rowid"),
            "from_me": bool(r.get("is_from_me")),
            "handle": _format_handle(r.get("handle")),
            "text": text[:1000],
            "ts": ts,
            "iso": datetime.fromtimestamp(ts, tz=timezone.utc).astimezone().isoformat(timespec="seconds") if ts else None,
        })
    msgs.sort(key=lambda m: m.get("ts") or 0)
    return {"ok": True, "handle": handle, "count": len(msgs),
            "messages": msgs}


# ── PUBLIC: imessage_send ─────────────────────────────────────────────
def imessage_send(handle: str, message: str, confirm: bool = False) -> dict:
    """Send an iMessage to `handle` (phone OR email). Two-stage flow:
    confirm=False returns a preview Watson must approve; confirm=True
    actually sends via AppleScript on Messages.app."""
    gate = _imessage_gate()
    if gate:
        return gate
    if not handle or not handle.strip():
        return {"error": "handle is required"}
    if not message or not message.strip():
        return {"error": "message is required"}

    if not confirm:
        return {
            "sent": False,
            "needs_confirmation": True,
            "platform": "imessage",
            "to": handle,
            "preview": message,
            "char_count": len(message),
            "hint": ("Read the preview to Watson. After he says yes, "
                     "re-call with confirm=true."),
        }

    # AppleScript path — Messages.app + iMessage service.
    script = f"""
        tell application "Messages"
            set targetService to 1st service whose service type = iMessage
            set targetBuddy to participant {_applescript_quote(handle.strip())} of targetService
            send {_applescript_quote(message)} to targetBuddy
        end tell
    """
    rc, out, err = _run_applescript(script, timeout=15)
    if rc != 0:
        # Fall back: some setups expect "buddy" instead of "participant".
        script2 = f"""
            tell application "Messages"
                set targetService to 1st service whose service type = iMessage
                set targetBuddy to buddy {_applescript_quote(handle.strip())} of targetService
                send {_applescript_quote(message)} to targetBuddy
            end tell
        """
        rc2, _, err2 = _run_applescript(script2, timeout=15)
        if rc2 != 0:
            _emit("imessage_send", "failed", error=(err or err2)[:200],
                  __cap="messaging")
            return {"error": f"send failed: {err or err2 or 'rc=' + str(rc)}"}
    _emit("imessage_send", "success", to=handle, __cap="messaging")
    _log(f"imessage send to={handle} len={len(message)}")
    # Best-effort: bump the contact record so the relationship pulse
    # learns about this exchange.
    try:
        _maybe_note_contact("imessage", handle,
                            summary=f"Sent iMessage: {message[:120]}")
    except Exception:
        pass
    return {"ok": True, "sent": True, "to": handle}


def _maybe_note_contact(channel: str, handle: str, summary: str = "") -> None:
    mod = _contacts()
    if mod is None:
        return
    try:
        mod.note_interaction(channel=channel, handle=handle, summary=summary)
    except Exception as e:
        _log(f"contacts note skipped: {e}")


# ── PUBLIC: imessage_search_contacts ──────────────────────────────────
def imessage_search_contacts(query: str, limit: int = 12) -> dict:
    """Search chat.db for handles whose id (phone/email) or chat
    display_name matches `query`. Useful for resolving 'send Karina an
    iMessage' to a real handle."""
    gate = _imessage_gate()
    if gate:
        return gate
    if not query or not query.strip():
        return {"error": "query is required"}
    conn = _open_chatdb()
    if conn is None:
        return {"error": "could not open chat.db (Full Disk Access needed)"}
    try:
        # Direct handle hits
        handles = _resolve_handle(query, conn)
        # Plus chat display-name hits, since Apple stores group/contact
        # names independently of the underlying handle.
        cur = conn.execute(
            """
            SELECT DISTINCT c.chat_identifier, c.display_name, h.id as handle
              FROM chat c
              LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
              LEFT JOIN handle h ON h.ROWID = chj.handle_id
             WHERE c.display_name LIKE ?
             LIMIT ?
            """,
            (f"%{query}%", max(1, int(limit))),
        )
        chat_hits = [dict(r) for r in cur.fetchall()]
    except sqlite3.Error as e:
        return {"error": f"chat.db query: {e}"}
    finally:
        conn.close()

    out: list[dict] = []
    seen: set[str] = set()
    for h in handles[: max(1, int(limit))]:
        key = (h.get("id") or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append({"handle": key, "service": h.get("service"),
                    "display_name": None})
    for ch in chat_hits:
        key = (ch.get("handle") or ch.get("chat_identifier") or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append({"handle": key,
                    "service": "iMessage",
                    "display_name": (ch.get("display_name") or "").strip() or None})
    return {"ok": True, "query": query, "count": len(out), "matches": out[:limit]}


# ── PUBLIC: apple_contacts_search ─────────────────────────────────────
def apple_contacts_search(query: str, limit: int = 8) -> dict:
    """Search Apple Contacts for a name fragment. Returns name + phones
    + emails so the caller (jarvis-network enrich) can backfill the
    contact record."""
    gate = _apple_gate()
    if gate:
        return gate
    if not query or not query.strip():
        return {"error": "query is required"}
    # AppleScript — Contacts.app's JXA bridge is flaky on people; AppleScript
    # is the dependable path.
    needle = query.strip()
    script = f"""
        set out to {{}}
        tell application "Contacts"
            set hits to every person whose name contains {_applescript_quote(needle)}
            repeat with p in hits
                set theName to name of p
                set thePhones to {{}}
                repeat with ph in (phones of p)
                    set end of thePhones to (value of ph as string)
                end repeat
                set theEmails to {{}}
                repeat with em in (emails of p)
                    set end of theEmails to (value of em as string)
                end repeat
                set theOrg to ""
                try
                    set theOrg to organization of p
                end try
                copy {{theName, thePhones, theEmails, theOrg}} to end of out
            end repeat
        end tell
        set AppleScript's text item delimiters to "|"
        set lines to {{}}
        repeat with rec in out
            set theName to item 1 of rec
            set phs to item 2 of rec
            set ems to item 3 of rec
            set org to item 4 of rec
            set AppleScript's text item delimiters to ","
            set phsJoined to phs as string
            set emsJoined to ems as string
            set AppleScript's text item delimiters to "|"
            set end of lines to theName & "|" & phsJoined & "|" & emsJoined & "|" & org
        end repeat
        set output to lines as string
        set AppleScript's text item delimiters to ""
        return output
    """
    rc, out, err = _run_applescript(script, timeout=10)
    if rc != 0:
        return {"error": f"contacts search failed: {err or 'rc=' + str(rc)}"}
    if not out.strip():
        return {"ok": True, "query": query, "count": 0, "matches": []}
    matches: list[dict] = []
    for line in out.split("\n"):
        line = line.rstrip("\r")
        if not line.strip():
            continue
        parts = line.split("|", 3)
        if len(parts) < 4:
            continue
        name, phones, emails, org = parts
        matches.append({
            "name": name.strip(),
            "phones": [p.strip() for p in phones.split(",") if p.strip()],
            "emails": [e.strip() for e in emails.split(",") if e.strip()],
            "organization": org.strip() or None,
        })
    return {"ok": True, "query": query, "count": len(matches),
            "matches": matches[:max(1, int(limit))]}


# ── PUBLIC: apple_contacts_list_all ───────────────────────────────────
def apple_contacts_list_all() -> dict:
    """Dump every person in Contacts.app: name, phones, emails, org.
    Used by jarvis-contacts sync to make Apple Contacts the source of
    truth for who exists in Watson's relationship memory.

    Implemented in JXA so output is JSON — survives names/orgs that
    contain pipes, commas, or newlines, and gracefully handles records
    with `missing value` on name / phone / email / organization."""
    gate = _apple_gate()
    if gate:
        return gate
    script = r"""
        const Contacts = Application('Contacts');
        // Bulk-fetch each property as a single Apple Event — orders of
        // magnitude faster than per-person attribute access on stores
        // with hundreds of contacts. Each `Contacts.people.X()` call
        // returns an array aligned by index across the four properties.
        let names = [], orgs = [], phs = [], ems = [];
        try { names = Contacts.people.name(); } catch (e) {}
        try { orgs = Contacts.people.organization(); } catch (e) {}
        try { phs = Contacts.people.phones.value(); } catch (e) {}
        try { ems = Contacts.people.emails.value(); } catch (e) {}
        const out = [];
        const norm = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : '';
        const flat = (a) => Array.isArray(a)
            ? a.map(norm).filter(Boolean)
            : (typeof a === 'string' ? [norm(a)].filter(Boolean) : []);
        for (let i = 0; i < names.length; i++) {
            const name = norm(names[i]);
            if (!name) continue;
            const org = norm(orgs && orgs[i]);
            const phones = flat(phs && phs[i]);
            const emails = flat(ems && ems[i]);
            out.push({ name, phones, emails, organization: org || null });
        }
        JSON.stringify(out);
    """
    # Apple Contacts can have thousands of records; allow a generous
    # timeout (default 2 min) overridable via JARVIS_CONTACTS_LIST_TIMEOUT.
    # Bulk fetch typically completes in <10s for ~600 contacts.
    timeout_s = float(os.environ.get("JARVIS_CONTACTS_LIST_TIMEOUT", "120"))
    rc, out, err = _run_jxa(script, timeout=timeout_s)
    if rc != 0:
        return {"error": f"contacts list failed: {err or 'rc=' + str(rc)}"}
    if not out.strip():
        return {"ok": True, "count": 0, "contacts": []}
    try:
        contacts = json.loads(out)
    except json.JSONDecodeError as e:
        return {"error": f"contacts list parse failed: {e}"}
    if not isinstance(contacts, list):
        return {"error": "contacts list returned non-list payload"}
    # Final sanity pass: drop any malformed entries silently.
    cleaned: list[dict] = []
    for c in contacts:
        if not isinstance(c, dict):
            continue
        nm = (c.get("name") or "").strip()
        if not nm:
            continue
        cleaned.append({
            "name": nm,
            "phones": [p.strip() for p in (c.get("phones") or []) if isinstance(p, str) and p.strip()],
            "emails": [e.strip() for e in (c.get("emails") or []) if isinstance(e, str) and e.strip()],
            "organization": (c.get("organization") or None) if isinstance(c.get("organization"), str) and c.get("organization").strip() else None,
        })
    return {"ok": True, "count": len(cleaned), "contacts": cleaned}


# ── briefing + context + notification + network hooks ─────────────────
def briefing_section() -> str:
    """Markdown 'iMessages' subsection — unread inbound messages only,
    grouped by handle. Empty when nothing is sitting unread."""
    if _imessage_gate() is not None:
        return ""
    res = imessage_check(hours=24)
    if not res.get("ok"):
        return ""
    threads = res.get("threads") or []
    unread_threads = [t for t in threads if t.get("unread_count")]
    if not unread_threads:
        return ""
    # Boost contacts-tier threads to the top — looks up via jarvis-contacts.
    cmod = _contacts()
    annotated: list[tuple[int, dict, str]] = []
    for t in unread_threads:
        handle = t.get("handle") or "?"
        contact_name = ""
        rank = 1  # default rank (non-contact)
        if cmod is not None:
            try:
                hit = cmod._resolve(handle)  # type: ignore[attr-defined]
            except Exception:
                hit = None
            if hit:
                _, rec = hit
                contact_name = rec.get("name") or ""
                rank = 0
        annotated.append((rank, t, contact_name))
    annotated.sort(key=lambda r: (r[0], -(r[1].get("unread_count") or 0)))

    lines = ["## iMessages", ""]
    for rank, t, contact_name in annotated[:8]:
        handle = t.get("handle") or "?"
        label = contact_name or handle
        msgs = t.get("messages") or []
        preview = (msgs[0].get("text") if msgs else "") or ""
        lines.append(f"- **{label}** ({t.get('unread_count')} unread): "
                     f"{preview[:120]}")
    lines.append("")
    return "\n".join(lines)


def context_hint(mentioned_names: list[str] | None = None) -> str:
    """One-line system-prompt hint when a mentioned name has unread
    iMessages on file. Empty otherwise."""
    if not mentioned_names or _imessage_gate() is not None:
        return ""
    res = imessage_check(hours=72)
    if not res.get("ok"):
        return ""
    cmod = _contacts()
    if cmod is None:
        return ""
    for nm in mentioned_names[:3]:
        try:
            hit = cmod._resolve(nm)  # type: ignore[attr-defined]
        except Exception:
            hit = None
        if not hit:
            continue
        _, rec = hit
        target = (rec.get("phone") or "").strip()
        # Look up which handle in the threads belongs to this contact.
        canon = _canonical(rec.get("name") or "")
        for t in res.get("threads") or []:
            if not t.get("unread_count"):
                continue
            handle = t.get("handle") or ""
            display = (t.get("messages") or [{}])[0].get("display_name") or ""
            if (target and target in handle) or (canon and canon in _canonical(display)):
                return (f"**iMessage:** {rec.get('name')} has "
                        f"{t['unread_count']} unread message"
                        f"{'s' if t['unread_count'] != 1 else ''}.")
    return ""


def interaction_signal_for_contact(rec: dict, hours: int = 72) -> dict:
    """Count recent iMessage activity for one contact record. Returns
    {count, last_ts} so jarvis-network can fold it into relationship
    strength alongside email + telegram."""
    if _imessage_gate() is not None:
        return {"count": 0, "last_ts": None}
    handle = (rec.get("phone") or rec.get("imessage_handle") or "").strip()
    if not handle:
        return {"count": 0, "last_ts": None}
    conn = _open_chatdb()
    if conn is None:
        return {"count": 0, "last_ts": None}
    cutoff_unix = time.time() - max(1, int(hours)) * 3600
    cutoff_mac_ns = int((cutoff_unix - MAC_EPOCH_OFFSET) * 1e9)
    try:
        cur = conn.execute(
            """
            SELECT COUNT(*) as n, MAX(m.date) as last_date
              FROM message m
              LEFT JOIN handle h ON m.handle_id = h.ROWID
             WHERE h.id LIKE ? AND m.date >= ?
            """,
            (f"%{handle}%", cutoff_mac_ns),
        )
        row = cur.fetchone()
    except sqlite3.Error:
        return {"count": 0, "last_ts": None}
    finally:
        conn.close()
    if not row:
        return {"count": 0, "last_ts": None}
    last_ts = _mac_ts_to_unix(row["last_date"]) if row["last_date"] else None
    last_iso = (datetime.fromtimestamp(last_ts, tz=timezone.utc).astimezone().isoformat(timespec="seconds")
                if last_ts else None)
    return {"count": int(row["n"] or 0), "last_ts": last_iso}


def recent_urgent(minutes: int = 10) -> list[dict]:
    """Return inbound iMessages from the last `minutes` so the wake-
    listener can route them as fresh-DM notifications."""
    if _imessage_gate() is not None:
        return []
    res = imessage_check(hours=max(1, minutes // 60 + 1))
    if not res.get("ok"):
        return []
    cutoff = time.time() - max(1, int(minutes)) * 60
    out: list[dict] = []
    for t in res.get("threads") or []:
        for m in t.get("messages") or []:
            if (m.get("ts") or 0) >= cutoff and not m.get("is_read"):
                out.append({"handle": m.get("handle"),
                            "text": m.get("text"),
                            "ts": m.get("ts"),
                            "iso": m.get("iso")})
    out.sort(key=lambda r: r.get("ts") or 0)
    return out


# ── CLI ────────────────────────────────────────────────────────────────
def _cli() -> int:
    p = argparse.ArgumentParser(description="Jarvis Apple integration")
    sub = p.add_subparsers(dest="cmd", required=True)

    # Reminders
    pra = sub.add_parser("add-reminder")
    pra.add_argument("text")
    pra.add_argument("--due", default=None)
    pra.add_argument("--notes", default=None)
    prl = sub.add_parser("list-reminders")
    prl.add_argument("--include-completed", action="store_true")
    prl.add_argument("--limit", type=int, default=50)
    prc = sub.add_parser("complete-reminder")
    prc.add_argument("name_or_id")

    # Notes
    pns = sub.add_parser("save-note")
    pns.add_argument("title")
    pns.add_argument("body", nargs="?", default="")
    pns.add_argument("--append", action="store_true")
    pnr = sub.add_parser("read-note")
    pnr.add_argument("title")

    # iMessage
    pim = sub.add_parser("imessage-check")
    pim.add_argument("--hours", type=int, default=24)
    pir = sub.add_parser("imessage-read")
    pir.add_argument("handle")
    pir.add_argument("--limit", type=int, default=20)
    pis = sub.add_parser("imessage-send")
    pis.add_argument("handle")
    pis.add_argument("message")
    pis.add_argument("--confirm", action="store_true")
    pisc = sub.add_parser("imessage-search")
    pisc.add_argument("query")

    # Contacts
    pcs = sub.add_parser("contacts-search")
    pcs.add_argument("query")
    sub.add_parser("contacts-list-all")

    # Hooks (smoke testing)
    sub.add_parser("briefing-section")
    pch = sub.add_parser("context-hint")
    pch.add_argument("--names", default=None)
    sub.add_parser("status")

    args = p.parse_args()

    def _dump(obj):
        print(json.dumps(obj, ensure_ascii=False, indent=2))

    if args.cmd == "add-reminder":
        _dump(apple_add_reminder(args.text, due=args.due, notes=args.notes))
        return 0
    if args.cmd == "list-reminders":
        _dump(apple_list_reminders(include_completed=args.include_completed,
                                    limit=args.limit))
        return 0
    if args.cmd == "complete-reminder":
        _dump(apple_complete_reminder(args.name_or_id))
        return 0
    if args.cmd == "save-note":
        _dump(apple_save_note(args.title, args.body, append=args.append))
        return 0
    if args.cmd == "read-note":
        _dump(apple_read_note(args.title))
        return 0
    if args.cmd == "imessage-check":
        _dump(imessage_check(hours=args.hours))
        return 0
    if args.cmd == "imessage-read":
        _dump(imessage_read(args.handle, limit=args.limit))
        return 0
    if args.cmd == "imessage-send":
        _dump(imessage_send(args.handle, args.message, confirm=args.confirm))
        return 0
    if args.cmd == "imessage-search":
        _dump(imessage_search_contacts(args.query))
        return 0
    if args.cmd == "contacts-search":
        _dump(apple_contacts_search(args.query))
        return 0
    if args.cmd == "contacts-list-all":
        _dump(apple_contacts_list_all())
        return 0
    if args.cmd == "briefing-section":
        s = briefing_section()
        print(s if s else "(no unread iMessages)")
        return 0
    if args.cmd == "context-hint":
        names = [n.strip() for n in (args.names or "").split(",") if n.strip()]
        h = context_hint(mentioned_names=names or None)
        print(h if h else "(no hint)")
        return 0
    if args.cmd == "status":
        print(json.dumps({
            "ok": True,
            "platform": platform.system(),
            "apple_enabled": _apple_gate() is None,
            "imessage_enabled": _imessage_gate() is None,
            "chat_db_exists": CHAT_DB.exists(),
            "reminder_list": JARVIS_REMINDER_LIST,
            "notes_folder": JARVIS_NOTES_FOLDER,
        }, indent=2, ensure_ascii=False))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
