#!/usr/bin/env python3
"""Apple integration layer — Reminders, Notes, iMessages, Contacts.

A single thin wrapper so Jarvis can reach native macOS without having
to remember which app needs JXA, which app needs SQLite, and which one
needs AppleScript. Every public function returns a JSON-friendly dict
with `ok`/`error` so the think.py tool layer can wire them straight in.

Backends (chosen for "works on a stock Mac, no extra installs"):

    Reminders   JXA (JavaScript for Automation) — JSON-safe, faster than
                AppleScript, and returns full ids so we can complete
                items by id later.
    Notes       JXA — same reasoning.
    iMessages   read: sqlite3 against ~/Library/Messages/chat.db
                send: AppleScript against Messages.app (the only
                supported send path)
    Contacts    JXA against the Contacts.app object model.

If a connected MCP later replaces any of these, the Python signatures
stay identical — only the implementation underneath swaps.

Public functions (callable from jarvis-think.py):

    apple_add_reminder(text, due=None, list="Jarvis", priority=None) -> dict
    apple_list_reminders(list="Jarvis", include_completed=False, limit=20) -> dict
    apple_complete_reminder(text_or_id) -> dict
    apple_complete_reminder_by_id(reminder_id) -> dict
    apple_sync_commitments() -> dict      # mirrors items.json → Reminders

    apple_save_note(title, content, folder="Jarvis") -> dict
    apple_read_note(title, folder="Jarvis") -> dict

    imessage_check(contact=None, hours=24, limit=20) -> dict
    imessage_read(contact, limit=50) -> dict
    imessage_send(contact, message, confirm=True) -> dict
    imessage_search_contacts(query) -> dict

    apple_contacts_search(query, limit=10) -> dict

CLI:
    bin/jarvis-apple.py add-reminder "buy milk" --due tomorrow
    bin/jarvis-apple.py list-reminders
    bin/jarvis-apple.py save-note "Forge prep" "Talking points: ..."
    bin/jarvis-apple.py imessage-check --hours 6
    bin/jarvis-apple.py contacts-search "Corbin"
    bin/jarvis-apple.py sync-commitments

Gates:
    JARVIS_APPLE=1       master gate (default on)
    JARVIS_IMESSAGE=1    iMessage subgate
    JARVIS_REMINDERS=1   Reminders subgate
    JARVIS_NOTES=1       Notes subgate
"""
from __future__ import annotations

import importlib.util
import json
import os
import shlex
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
LOG_DIR = ASSISTANT_DIR / "logs"
APPLE_LOG = LOG_DIR / "apple.log"
BIN_DIR = Path(__file__).resolve().parent

CHAT_DB = Path.home() / "Library" / "Messages" / "chat.db"
JARVIS_LIST = os.environ.get("JARVIS_REMINDERS_LIST", "Jarvis")
JARVIS_NOTES_FOLDER = os.environ.get("JARVIS_NOTES_FOLDER", "Jarvis")

OSA_TIMEOUT = float(os.environ.get("JARVIS_OSA_TIMEOUT_S", "20"))


# ── logging / IO ─────────────────────────────────────────────────────
def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with APPLE_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def _gate(name: str) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return True
    return str(raw).strip().lower() not in ("0", "false", "no", "off", "")


def _apple_enabled() -> bool:
    return _gate("JARVIS_APPLE")


def _emit(action: str, status: str, context: dict | None = None,
          latency_ms: int | None = None) -> None:
    try:
        sys.path.insert(0, str(ASSISTANT_DIR / "lib"))
        sys.path.insert(0, str(BIN_DIR.parent / "lib"))
        from outcome_ledger import emit  # type: ignore
        emit("apple", action, status, context=context, latency_ms=latency_ms)
    except Exception:
        pass


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


# ── osascript (JXA) helper ────────────────────────────────────────────
def _run_jxa(script: str, timeout: float = OSA_TIMEOUT) -> dict:
    """Run a JXA script via osascript -l JavaScript. The script SHOULD
    print a JSON string on stdout. Returns {ok, data} | {error}."""
    try:
        proc = subprocess.run(
            ["osascript", "-l", "JavaScript", "-e", script],
            capture_output=True, text=True, timeout=timeout,
        )
    except FileNotFoundError:
        return {"error": "osascript not found (not on macOS?)"}
    except subprocess.TimeoutExpired:
        return {"error": f"osascript timed out after {timeout}s"}
    if proc.returncode != 0:
        msg = (proc.stderr or "").strip().splitlines()[-1] if proc.stderr else "unknown"
        return {"error": f"osascript: {msg[:300]}"}
    raw = (proc.stdout or "").strip()
    if not raw:
        return {"ok": True, "data": None}
    try:
        return {"ok": True, "data": json.loads(raw)}
    except json.JSONDecodeError:
        return {"ok": True, "data": raw}


def _run_applescript(script: str, timeout: float = OSA_TIMEOUT) -> dict:
    """For the rare paths where AppleScript is the only option (Messages
    send). Returns {ok, output} | {error}."""
    try:
        proc = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=timeout,
        )
    except FileNotFoundError:
        return {"error": "osascript not found"}
    except subprocess.TimeoutExpired:
        return {"error": f"osascript timed out after {timeout}s"}
    if proc.returncode != 0:
        msg = (proc.stderr or "").strip().splitlines()[-1] if proc.stderr else "unknown"
        return {"error": f"osascript: {msg[:300]}"}
    return {"ok": True, "output": (proc.stdout or "").strip()}


def _js_str(s: str | None) -> str:
    """Escape a string for safe embedding inside a JS string literal."""
    if s is None:
        return "null"
    return json.dumps(s)  # JSON strings are valid JS strings.


# ── Reminders (JXA) ──────────────────────────────────────────────────
def _ensure_reminders_list_script(name: str) -> str:
    return f"""
    (() => {{
      const r = Application('Reminders');
      r.includeStandardAdditions = true;
      const target = {_js_str(name)};
      let lst = r.lists.whose({{name: target}});
      if (lst.length === 0) {{
        const created = r.List({{name: target}});
        r.lists.push(created);
        return JSON.stringify({{created: true, id: created.id()}});
      }}
      return JSON.stringify({{created: false, id: lst[0].id()}});
    }})()
    """


def _reminders_due_iso(due: str | None) -> str | None:
    """Turn YYYY-MM-DD into a JS-friendly Date string at 5pm local."""
    if not due:
        return None
    try:
        d = datetime.fromisoformat(due[:10])
    except ValueError:
        return None
    return d.replace(hour=17, minute=0, second=0).isoformat()


def apple_add_reminder(text: str, due: str | None = None,
                       list: str = JARVIS_LIST,
                       priority: str | None = None,
                       notes: str | None = None) -> dict:
    if not (_apple_enabled() and _gate("JARVIS_REMINDERS")):
        return {"error": "JARVIS_REMINDERS=0"}
    text = (text or "").strip()
    if not text:
        return {"error": "text is required"}
    list_name = (list or JARVIS_LIST).strip() or JARVIS_LIST

    # Make sure the target list exists.
    ensure = _run_jxa(_ensure_reminders_list_script(list_name))
    if not ensure.get("ok"):
        return ensure

    due_iso = _reminders_due_iso(due) if due else None
    prio_int = {"high": 1, "medium": 5, "low": 9}.get(
        (priority or "").lower(), 0)
    script = f"""
    (() => {{
      const r = Application('Reminders');
      r.includeStandardAdditions = true;
      const lst = r.lists.byName({_js_str(list_name)});
      const props = {{name: {_js_str(text)}}};
      const reminder = r.Reminder(props);
      lst.reminders.push(reminder);
      const dueStr = {_js_str(due_iso)};
      if (dueStr) {{
        reminder.dueDate = new Date(dueStr);
      }}
      const notesStr = {_js_str(notes)};
      if (notesStr) {{
        reminder.body = notesStr;
      }}
      const prio = {prio_int};
      if (prio > 0) {{
        reminder.priority = prio;
      }}
      return JSON.stringify({{id: reminder.id(), name: reminder.name(),
                              due: dueStr, list: {_js_str(list_name)}}});
    }})()
    """
    started = time.time()
    out = _run_jxa(script)
    latency = int((time.time() - started) * 1000)
    if not out.get("ok"):
        _emit("add_reminder", "failed", context={"error": out.get("error")},
              latency_ms=latency)
        return out
    _emit("add_reminder", "success",
          context={"id": (out.get("data") or {}).get("id")},
          latency_ms=latency)
    return {"ok": True, "reminder": out.get("data")}


def apple_list_reminders(list: str = JARVIS_LIST,
                         include_completed: bool = False,
                         limit: int = 20) -> dict:
    if not (_apple_enabled() and _gate("JARVIS_REMINDERS")):
        return {"error": "JARVIS_REMINDERS=0"}
    list_name = (list or JARVIS_LIST).strip() or JARVIS_LIST
    script = f"""
    (() => {{
      const r = Application('Reminders');
      const target = {_js_str(list_name)};
      const lst = r.lists.whose({{name: target}});
      if (lst.length === 0) return JSON.stringify({{ok: true, items: []}});
      const wanted = lst[0].reminders();
      const out = [];
      const includeDone = {str(bool(include_completed)).lower()};
      for (let i = 0; i < wanted.length && out.length < {int(limit)}; i++) {{
        const it = wanted[i];
        if (!includeDone && it.completed()) continue;
        let due = null;
        try {{ const d = it.dueDate(); if (d) due = d.toISOString(); }} catch (_) {{}}
        out.push({{
          id: it.id(),
          name: it.name(),
          completed: it.completed(),
          due: due,
          body: it.body() || null,
          priority: it.priority(),
        }});
      }}
      return JSON.stringify({{ok: true, items: out, list: target}});
    }})()
    """
    started = time.time()
    out = _run_jxa(script)
    if not out.get("ok"):
        _emit("list_reminders", "failed",
              context={"error": out.get("error")},
              latency_ms=int((time.time() - started) * 1000))
        return out
    data = out.get("data") or {}
    _emit("list_reminders", "success",
          context={"count": len(data.get("items") or [])},
          latency_ms=int((time.time() - started) * 1000))
    return {"ok": True, "items": data.get("items") or [], "list": list_name}


def apple_complete_reminder_by_id(reminder_id: str) -> dict:
    if not (_apple_enabled() and _gate("JARVIS_REMINDERS")):
        return {"error": "JARVIS_REMINDERS=0"}
    if not reminder_id:
        return {"error": "reminder_id required"}
    script = f"""
    (() => {{
      const r = Application('Reminders');
      const target = {_js_str(reminder_id)};
      const all = r.reminders();
      for (let i = 0; i < all.length; i++) {{
        if (all[i].id() === target) {{
          all[i].completed = true;
          return JSON.stringify({{ok: true, id: target}});
        }}
      }}
      return JSON.stringify({{ok: false, error: 'not found'}});
    }})()
    """
    out = _run_jxa(script)
    if not out.get("ok"):
        return out
    data = out.get("data") or {}
    if not data.get("ok"):
        return {"error": data.get("error") or "not found"}
    _emit("complete_reminder", "success", context={"id": reminder_id})
    return {"ok": True, "id": reminder_id}


def apple_complete_reminder(text_or_id: str,
                            list: str = JARVIS_LIST) -> dict:
    """Match by id first, then by name (case-insensitive substring) in
    the given list. Completes the first hit and stops."""
    if not (_apple_enabled() and _gate("JARVIS_REMINDERS")):
        return {"error": "JARVIS_REMINDERS=0"}
    if (text_or_id or "").startswith(("x-coredata:", "x-apple-")):
        return apple_complete_reminder_by_id(text_or_id)
    list_name = (list or JARVIS_LIST).strip() or JARVIS_LIST
    script = f"""
    (() => {{
      const r = Application('Reminders');
      const target = {_js_str((text_or_id or "").lower())};
      const lst = r.lists.whose({{name: {_js_str(list_name)}}});
      if (lst.length === 0) return JSON.stringify({{ok: false, error: 'list not found'}});
      const items = lst[0].reminders();
      for (let i = 0; i < items.length; i++) {{
        const it = items[i];
        if (it.completed()) continue;
        const n = (it.name() || '').toLowerCase();
        if (n === target || n.indexOf(target) !== -1 || target.indexOf(n) !== -1) {{
          it.completed = true;
          return JSON.stringify({{ok: true, id: it.id(), name: it.name()}});
        }}
      }}
      return JSON.stringify({{ok: false, error: 'no match'}});
    }})()
    """
    out = _run_jxa(script)
    if not out.get("ok"):
        return out
    data = out.get("data") or {}
    if not data.get("ok"):
        return {"error": data.get("error") or "no match"}
    _emit("complete_reminder", "success", context={"id": data.get("id")})
    return {"ok": True, "id": data.get("id"), "name": data.get("name")}


def _load_commitments_module():
    src = BIN_DIR / "jarvis-commitments.py"
    if not src.exists():
        src = ASSISTANT_DIR / "bin" / "jarvis-commitments.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_commitments_a", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    except Exception:
        return None


def apple_sync_commitments() -> dict:
    """For each open commitment without an apple_reminders id, create
    one in the Jarvis list and store the id. Pulls completion status
    back: any reminder marked complete promotes the matching commitment
    to done."""
    if not (_apple_enabled() and _gate("JARVIS_REMINDERS")):
        return {"skipped": "JARVIS_REMINDERS=0"}
    cmt_mod = _load_commitments_module()
    if cmt_mod is None:
        return {"error": "jarvis-commitments not installed"}
    summary = {"created": 0, "completed": 0, "errors": []}

    items_data = cmt_mod._load_items()
    items = items_data["items"]
    dirty = False

    # 1. Push new commitments → reminders.
    for c in items:
        if c.get("status") != "open":
            continue
        if (c.get("synced_to") or {}).get("apple_reminders"):
            continue
        notes = []
        if c.get("related_contact"):
            notes.append(f"contact: {c['related_contact']}")
        if c.get("source", {}).get("context"):
            notes.append(f"context: {c['source']['context'][:200]}")
        notes.append(f"jarvis-id: {c['id']}")
        out = apple_add_reminder(
            c["text"], due=c.get("due"),
            priority=c.get("priority"),
            notes="\n".join(notes),
        )
        if not out.get("ok"):
            summary["errors"].append({"phase": "create", "id": c["id"],
                                      "error": out.get("error")})
            continue
        rem_id = (out.get("reminder") or {}).get("id")
        if rem_id:
            c.setdefault("synced_to", {})["apple_reminders"] = rem_id
            summary["created"] += 1
            dirty = True

    # 2. Pull completion state.
    listing = apple_list_reminders(list=JARVIS_LIST,
                                   include_completed=True, limit=200)
    completed_ids = set()
    if listing.get("ok"):
        for r in listing.get("items") or []:
            if r.get("completed"):
                completed_ids.add(r.get("id"))
    for c in items:
        rem_id = (c.get("synced_to") or {}).get("apple_reminders")
        if rem_id and rem_id in completed_ids and c.get("status") != "done":
            c["status"] = "done"
            c["completed"] = _now_iso()
            summary["completed"] += 1
            dirty = True

    if dirty:
        cmt_mod._save_items(items_data)
    _emit("sync_commitments", "success", context=summary)
    return {"ok": True, "summary": summary}


# ── Notes (JXA) ──────────────────────────────────────────────────────
def _ensure_notes_folder_script(name: str) -> str:
    return f"""
    (() => {{
      const n = Application('Notes');
      const target = {_js_str(name)};
      const found = n.folders.whose({{name: target}});
      if (found.length === 0) {{
        const f = n.Folder({{name: target}});
        n.folders.push(f);
        return JSON.stringify({{created: true}});
      }}
      return JSON.stringify({{created: false}});
    }})()
    """


def apple_save_note(title: str, content: str,
                    folder: str = JARVIS_NOTES_FOLDER) -> dict:
    if not (_apple_enabled() and _gate("JARVIS_NOTES")):
        return {"error": "JARVIS_NOTES=0"}
    title = (title or "").strip()
    content = content or ""
    if not title:
        return {"error": "title required"}
    folder_name = (folder or JARVIS_NOTES_FOLDER).strip() or JARVIS_NOTES_FOLDER

    ensure = _run_jxa(_ensure_notes_folder_script(folder_name))
    if not ensure.get("ok"):
        return ensure

    # Notes uses HTML-ish bodies. We pass the title as <h1> and let the
    # rest of the content land as plain text — Notes happily renders
    # newlines in plain text.
    safe_body = content.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    safe_body = safe_body.replace("\n", "<br>")
    body_html = f"<h1>{title}</h1><div>{safe_body}</div>"
    script = f"""
    (() => {{
      const n = Application('Notes');
      const fld = n.folders.byName({_js_str(folder_name)});
      const note = n.Note({{name: {_js_str(title)}, body: {_js_str(body_html)}}});
      fld.notes.push(note);
      return JSON.stringify({{ok: true, id: note.id(), name: note.name()}});
    }})()
    """
    started = time.time()
    out = _run_jxa(script)
    latency = int((time.time() - started) * 1000)
    if not out.get("ok"):
        _emit("save_note", "failed", context={"error": out.get("error")},
              latency_ms=latency)
        return out
    data = out.get("data") or {}
    _emit("save_note", "success",
          context={"id": data.get("id"), "folder": folder_name},
          latency_ms=latency)
    return {"ok": True, "note": data, "folder": folder_name}


def apple_read_note(title: str, folder: str = JARVIS_NOTES_FOLDER) -> dict:
    if not (_apple_enabled() and _gate("JARVIS_NOTES")):
        return {"error": "JARVIS_NOTES=0"}
    title = (title or "").strip()
    if not title:
        return {"error": "title required"}
    folder_name = (folder or JARVIS_NOTES_FOLDER).strip() or JARVIS_NOTES_FOLDER
    script = f"""
    (() => {{
      const n = Application('Notes');
      const target = {_js_str(title.lower())};
      const fld = n.folders.whose({{name: {_js_str(folder_name)}}});
      let pool = [];
      if (fld.length > 0) pool = fld[0].notes();
      else pool = n.notes();
      for (let i = 0; i < pool.length; i++) {{
        const nm = (pool[i].name() || '').toLowerCase();
        if (nm === target || nm.indexOf(target) !== -1) {{
          return JSON.stringify({{ok: true, id: pool[i].id(),
                                  name: pool[i].name(),
                                  body: pool[i].plaintext()}});
        }}
      }}
      return JSON.stringify({{ok: false, error: 'note not found'}});
    }})()
    """
    out = _run_jxa(script)
    if not out.get("ok"):
        return out
    data = out.get("data") or {}
    if not data.get("ok"):
        return {"error": data.get("error") or "not found"}
    return {"ok": True, "note": data}


# ── iMessages (SQLite read + AppleScript send) ───────────────────────
def _imessage_apple_epoch_to_iso(apple_ts: int | None) -> str | None:
    """Apple's chat.db stores message dates as nanoseconds since
    2001-01-01 UTC. Convert to ISO 8601 local."""
    if apple_ts is None:
        return None
    try:
        # Newer macOS uses nanoseconds; older used seconds. Heuristic:
        # values bigger than ~10^11 are nanoseconds.
        secs = apple_ts / 1_000_000_000 if apple_ts > 10**11 else apple_ts
        epoch_2001 = 978307200  # 2001-01-01T00:00:00Z in unix seconds
        return datetime.fromtimestamp(epoch_2001 + secs).astimezone().isoformat(timespec="seconds")
    except Exception:
        return None


def _normalize_handle(handle: str) -> str:
    """Strip + - ( ) and spaces from a phone number for matching;
    leave emails alone."""
    h = (handle or "").strip()
    if "@" in h:
        return h.lower()
    return "".join(c for c in h if c.isdigit())


def _open_chat_db():
    if not CHAT_DB.exists():
        return None
    try:
        # Read-only URI so we never accidentally write.
        conn = sqlite3.connect(f"file:{CHAT_DB}?mode=ro", uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error as e:
        _log(f"chat.db open failed: {e}")
        return None


def imessage_check(contact: str | None = None,
                   hours: float = 24.0,
                   limit: int = 20,
                   unread_only: bool = False) -> dict:
    """Recent inbound messages in the last `hours`, optionally filtered
    by contact (match against handle id, email, or phone number).
    Returns newest first."""
    if not (_apple_enabled() and _gate("JARVIS_IMESSAGE")):
        return {"error": "JARVIS_IMESSAGE=0"}
    if not CHAT_DB.exists():
        return {"error": f"chat.db not found at {CHAT_DB}"}
    conn = _open_chat_db()
    if conn is None:
        return {"error": "could not open chat.db (Full Disk Access?)"}

    # Apple stores dates as ns since 2001-01-01. Build the cutoff in the
    # same unit so the index can be used.
    cutoff_unix = (datetime.now() - timedelta(hours=hours)).timestamp()
    cutoff_apple_ns = int((cutoff_unix - 978307200) * 1_000_000_000)

    where = ["m.is_from_me = 0", "m.date >= ?"]
    params: list[Any] = [cutoff_apple_ns]
    if unread_only:
        where.append("m.is_read = 0")
    if contact:
        norm = _normalize_handle(contact)
        if "@" in norm:
            where.append("LOWER(h.id) = ?")
            params.append(norm)
        elif norm:
            # Match on the trailing N digits to handle +1 / no-+1 formats.
            where.append("REPLACE(REPLACE(REPLACE(REPLACE(h.id,'+',''),'-',''),' ',''),'(','') LIKE ?")
            params.append(f"%{norm[-7:]}")
        else:
            where.append("h.id LIKE ?")
            params.append(f"%{contact}%")

    sql = f"""
        SELECT m.rowid, m.text, m.date, m.is_from_me, m.is_read,
               h.id AS handle, h.service AS service
          FROM message m
          LEFT JOIN handle h ON m.handle_id = h.rowid
         WHERE {' AND '.join(where)}
      ORDER BY m.date DESC
         LIMIT ?
    """
    params.append(int(limit))
    try:
        rows = conn.execute(sql, params).fetchall()
    except sqlite3.Error as e:
        conn.close()
        return {"error": f"chat.db query: {e}"}
    finally:
        try:
            conn.close()
        except Exception:
            pass

    out = []
    for r in rows:
        out.append({
            "id": r["rowid"],
            "handle": r["handle"],
            "service": r["service"],
            "text": r["text"],
            "ts": _imessage_apple_epoch_to_iso(r["date"]),
            "is_read": bool(r["is_read"]),
            "from_me": bool(r["is_from_me"]),
        })
    _emit("imessage_check", "success", context={"count": len(out),
                                                "contact": contact})
    return {"ok": True, "messages": out, "count": len(out)}


def imessage_read(contact: str, limit: int = 50) -> dict:
    """Two-sided thread with one contact, newest last (so it reads top
    to bottom in chronological order). Best for catching up on a
    specific conversation."""
    if not (_apple_enabled() and _gate("JARVIS_IMESSAGE")):
        return {"error": "JARVIS_IMESSAGE=0"}
    if not contact:
        return {"error": "contact required"}
    conn = _open_chat_db()
    if conn is None:
        return {"error": "could not open chat.db (Full Disk Access?)"}
    norm = _normalize_handle(contact)
    if "@" in norm:
        where = "LOWER(h.id) = ?"
        params: list[Any] = [norm]
    elif norm:
        where = "REPLACE(REPLACE(REPLACE(REPLACE(h.id,'+',''),'-',''),' ',''),'(','') LIKE ?"
        params = [f"%{norm[-7:]}"]
    else:
        where = "h.id LIKE ?"
        params = [f"%{contact}%"]
    sql = f"""
        SELECT m.rowid, m.text, m.date, m.is_from_me,
               h.id AS handle, h.service AS service
          FROM message m
          LEFT JOIN handle h ON m.handle_id = h.rowid
         WHERE {where}
      ORDER BY m.date DESC
         LIMIT ?
    """
    params.append(int(limit))
    try:
        rows = conn.execute(sql, params).fetchall()
    except sqlite3.Error as e:
        conn.close()
        return {"error": f"chat.db query: {e}"}
    finally:
        try:
            conn.close()
        except Exception:
            pass
    msgs = [{
        "handle": r["handle"], "service": r["service"], "text": r["text"],
        "ts": _imessage_apple_epoch_to_iso(r["date"]),
        "from_me": bool(r["is_from_me"]),
    } for r in rows]
    msgs.reverse()
    return {"ok": True, "contact": contact, "messages": msgs}


def imessage_send(contact: str, message: str, confirm: bool = True,
                  service: str = "iMessage") -> dict:
    """Send via Messages.app. The `confirm` gate is a safety net for
    Watson — when False the python wrapper refuses to send unless the
    caller explicitly bypassed the preview-then-send flow upstream."""
    if not (_apple_enabled() and _gate("JARVIS_IMESSAGE")):
        return {"error": "JARVIS_IMESSAGE=0"}
    if not confirm:
        return {"error": "send not confirmed (preview-then-confirm flow required)"}
    contact = (contact or "").strip()
    message = (message or "").strip()
    if not contact or not message:
        return {"error": "contact and message both required"}

    target = contact
    # AppleScript wants either a buddy id (phone/email) or a chat. We
    # pass the raw handle and let Messages resolve it.
    script = f'''
    on run
      tell application "Messages"
        set targetService to first service whose service type = {service}
        set targetBuddy to buddy "{target}" of targetService
        send "{_apple_quote(message)}" to targetBuddy
      end tell
    end run
    '''
    started = time.time()
    out = _run_applescript(script)
    latency = int((time.time() - started) * 1000)
    if not out.get("ok"):
        _emit("imessage_send", "failed",
              context={"contact": target, "error": out.get("error")},
              latency_ms=latency)
        return out
    _emit("imessage_send", "success",
          context={"contact": target, "len": len(message)},
          latency_ms=latency)
    return {"ok": True, "sent_to": target, "service": service}


def _apple_quote(s: str) -> str:
    """Escape a string for safe inclusion inside an AppleScript double-
    quoted literal (escape backslashes and double quotes)."""
    return (s or "").replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def imessage_search_contacts(query: str) -> dict:
    """Find handles (phone/email) in chat.db that match the query.
    Useful when Watson asks 'message Corbin' and we need to resolve to
    a specific phone number — falls through to apple_contacts_search if
    the address book has a richer record."""
    if not (_apple_enabled() and _gate("JARVIS_IMESSAGE")):
        return {"error": "JARVIS_IMESSAGE=0"}
    query = (query or "").strip()
    if not query:
        return {"error": "query required"}
    conn = _open_chat_db()
    if conn is None:
        return {"error": "could not open chat.db (Full Disk Access?)"}
    try:
        rows = conn.execute("""
            SELECT h.id AS handle, h.service AS service, COUNT(m.rowid) AS msgs
              FROM handle h
              LEFT JOIN message m ON m.handle_id = h.rowid
             WHERE h.id LIKE ?
          GROUP BY h.id, h.service
          ORDER BY msgs DESC
             LIMIT 20
        """, (f"%{query}%",)).fetchall()
    except sqlite3.Error as e:
        conn.close()
        return {"error": f"chat.db query: {e}"}
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return {"ok": True, "handles": [dict(r) for r in rows]}


# ── Apple Contacts (JXA) ─────────────────────────────────────────────
def apple_contacts_search(query: str, limit: int = 10) -> dict:
    """Hit Contacts.app directly. Used by jarvis-network to enrich the
    canonical people.json with native phone/email rows."""
    if not _apple_enabled():
        return {"error": "JARVIS_APPLE=0"}
    query = (query or "").strip()
    if not query:
        return {"error": "query required"}
    script = f"""
    (() => {{
      const c = Application('Contacts');
      const q = {_js_str(query.lower())};
      const all = c.people();
      const out = [];
      for (let i = 0; i < all.length && out.length < {int(limit)}; i++) {{
        const p = all[i];
        const name = (p.name() || '').toLowerCase();
        const org  = (p.organization() || '').toLowerCase();
        if (name.indexOf(q) === -1 && org.indexOf(q) === -1) continue;
        const emails = (p.emails() || []).map(e => ({{label: e.label(), value: e.value()}}));
        const phones = (p.phones() || []).map(t => ({{label: t.label(), value: t.value()}}));
        out.push({{
          id: p.id(),
          name: p.name(),
          first: p.firstName(),
          last: p.lastName(),
          organization: p.organization(),
          emails: emails,
          phones: phones,
          note: p.note() || null,
        }});
      }}
      return JSON.stringify({{ok: true, items: out}});
    }})()
    """
    started = time.time()
    out = _run_jxa(script)
    latency = int((time.time() - started) * 1000)
    if not out.get("ok"):
        _emit("contacts_search", "failed",
              context={"error": out.get("error")},
              latency_ms=latency)
        return out
    data = out.get("data") or {}
    _emit("contacts_search", "success",
          context={"count": len(data.get("items") or [])},
          latency_ms=latency)
    return {"ok": True, "items": data.get("items") or []}


# ── CLI ──────────────────────────────────────────────────────────────
def _cli(argv: list[str]) -> int:
    import argparse

    p = argparse.ArgumentParser(description="Jarvis Apple integration layer")
    sub = p.add_subparsers(dest="cmd", required=True)

    par = sub.add_parser("add-reminder")
    par.add_argument("text")
    par.add_argument("--due", default=None)
    par.add_argument("--list", default=JARVIS_LIST)
    par.add_argument("--priority", default=None,
                     choices=("high", "medium", "low"))
    par.add_argument("--notes", default=None)

    plr = sub.add_parser("list-reminders")
    plr.add_argument("--list", default=JARVIS_LIST)
    plr.add_argument("--include-completed", action="store_true")
    plr.add_argument("--limit", type=int, default=20)

    pcr = sub.add_parser("complete-reminder")
    pcr.add_argument("text_or_id")
    pcr.add_argument("--list", default=JARVIS_LIST)

    sub.add_parser("sync-commitments")

    psn = sub.add_parser("save-note")
    psn.add_argument("title")
    psn.add_argument("content")
    psn.add_argument("--folder", default=JARVIS_NOTES_FOLDER)

    prn = sub.add_parser("read-note")
    prn.add_argument("title")
    prn.add_argument("--folder", default=JARVIS_NOTES_FOLDER)

    pic = sub.add_parser("imessage-check")
    pic.add_argument("--contact", default=None)
    pic.add_argument("--hours", type=float, default=24)
    pic.add_argument("--limit", type=int, default=20)
    pic.add_argument("--unread-only", action="store_true")

    pir = sub.add_parser("imessage-read")
    pir.add_argument("contact")
    pir.add_argument("--limit", type=int, default=50)

    pis = sub.add_parser("imessage-send")
    pis.add_argument("contact")
    pis.add_argument("message")
    pis.add_argument("--service", default="iMessage")
    pis.add_argument("--no-confirm", action="store_true",
                     help="Skip the python-side confirm gate (for testing).")

    pisc = sub.add_parser("imessage-search-contacts")
    pisc.add_argument("query")

    pcs = sub.add_parser("contacts-search")
    pcs.add_argument("query")
    pcs.add_argument("--limit", type=int, default=10)

    args = p.parse_args(argv)
    if args.cmd == "add-reminder":
        out = apple_add_reminder(args.text, due=args.due, list=args.list,
                                 priority=args.priority, notes=args.notes)
    elif args.cmd == "list-reminders":
        out = apple_list_reminders(list=args.list,
                                   include_completed=args.include_completed,
                                   limit=args.limit)
    elif args.cmd == "complete-reminder":
        out = apple_complete_reminder(args.text_or_id, list=args.list)
    elif args.cmd == "sync-commitments":
        out = apple_sync_commitments()
    elif args.cmd == "save-note":
        out = apple_save_note(args.title, args.content, folder=args.folder)
    elif args.cmd == "read-note":
        out = apple_read_note(args.title, folder=args.folder)
    elif args.cmd == "imessage-check":
        out = imessage_check(contact=args.contact, hours=args.hours,
                             limit=args.limit, unread_only=args.unread_only)
    elif args.cmd == "imessage-read":
        out = imessage_read(args.contact, limit=args.limit)
    elif args.cmd == "imessage-send":
        out = imessage_send(args.contact, args.message,
                            confirm=not args.no_confirm,
                            service=args.service)
    elif args.cmd == "imessage-search-contacts":
        out = imessage_search_contacts(args.query)
    elif args.cmd == "contacts-search":
        out = apple_contacts_search(args.query, limit=args.limit)
    else:
        return 2
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if (isinstance(out, dict) and out.get("ok")) else 1


if __name__ == "__main__":
    try:
        sys.exit(_cli(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
