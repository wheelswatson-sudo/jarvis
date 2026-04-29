#!/usr/bin/env python3
"""Automated meeting prep — Watson never walks into a meeting unprepared.

A scheduler runs every few minutes, scans the next two hours of the
calendar, and for any meeting whose lead-time hits the configured window
(default 15 min) and that hasn't been prepped yet:

  1. Pull the calendar event (attendees, agenda, location)
  2. For each attendee:
       - relationship_brief
       - open commitments tied to them
       - recent emails / iMessages
       - LinkedIn changes
       - Stripe customer record (if they're paying)
  3. Hand the structured prep payload to the orchestrator's execute_plan
     so Sonnet synthesizes a tight voice-ready briefing
  4. Save the prose to Apple Notes under "Jarvis/Meeting Prep" with a
     dated title
  5. Push a high-priority notification: "Your 2pm with Corbin is in
     15 minutes. Prep notes saved."
  6. Record the meeting id in ~/.jarvis/state/meeting_prep.json so the
     same meeting doesn't re-prep next pass

Public functions (all return JSON-serializable dicts):

    meeting_prep(event_id_or_time=None)
        Manually prep a specific event or the next upcoming meeting.
        event_id_or_time can be an event id, "next", or "today".

    meeting_prep_settings(lead_time_minutes=None, auto=None)
        Read or update the settings file. Both args optional — passing
        nothing returns current state.

    poll_loop()
        Long-running poller for wake-listener to spawn as a daemon
        thread. Wakes every 5 minutes, scans the calendar window, fires
        prep for any due-but-unprepped meeting, sleeps. Idempotent
        across restarts (state file survives).

    pending_prep_hint()
        One-liner for jarvis-context when a prepped briefing is sitting
        in Apple Notes for an upcoming meeting.

CLI:
    bin/jarvis-meeting-prep.py                   prep next upcoming
    bin/jarvis-meeting-prep.py --event-id ID     prep a specific event
    bin/jarvis-meeting-prep.py --scan            one-shot scan + prep
    bin/jarvis-meeting-prep.py --status          show prep state
    bin/jarvis-meeting-prep.py --settings        show / update settings

Files:
    ~/.jarvis/state/meeting_prep.json   already-prepped event ids + ts
    ~/.jarvis/state/meeting_prep_settings.json  lead_time, auto flag
    ~/.jarvis/logs/meeting-prep.log     diagnostic log

Gate: JARVIS_MEETING_PREP=1 (default 1).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
BIN_DIR = ASSISTANT_DIR / "bin"
LIB_DIR = ASSISTANT_DIR / "lib"
STATE_DIR = ASSISTANT_DIR / "state"
PREP_STATE = STATE_DIR / "meeting_prep.json"
SETTINGS_FILE = STATE_DIR / "meeting_prep_settings.json"
LOG_DIR = ASSISTANT_DIR / "logs"
PREP_LOG = LOG_DIR / "meeting-prep.log"

NOTES_FOLDER = os.environ.get("JARVIS_MEETING_PREP_FOLDER", "Jarvis/Meeting Prep")
DEFAULT_LEAD_TIME_MIN = int(os.environ.get("JARVIS_MEETING_PREP_LEAD_MIN", "15"))
POLL_INTERVAL_S = int(os.environ.get("JARVIS_MEETING_PREP_POLL_S", "300"))
SCAN_WINDOW_HOURS = float(os.environ.get("JARVIS_MEETING_PREP_WINDOW_H", "2"))
PREP_STATE_RETENTION_DAYS = 7


# ── logging + gate ────────────────────────────────────────────────────
def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with PREP_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def _gate_check() -> dict | None:
    if os.environ.get("JARVIS_MEETING_PREP", "1") != "1":
        return {"error": "meeting prep disabled (JARVIS_MEETING_PREP=0)"}
    return None


# ── module loaders ────────────────────────────────────────────────────
_cache: dict[str, Any] = {}


def _load_module(name: str, relative: str, search_dirs: list[Path]):
    if name in _cache:
        return _cache[name]
    for d in search_dirs:
        src = d / relative
        if src.exists():
            try:
                spec = importlib.util.spec_from_file_location(name, src)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)  # type: ignore[union-attr]
                _cache[name] = mod
                return mod
            except Exception as e:
                _log(f"load {relative} failed: {e}")
    _cache[name] = None
    return None


_BIN_SEARCH = [BIN_DIR, Path(__file__).parent]
_LIB_SEARCH = [LIB_DIR, Path(__file__).parent.parent / "lib"]


def _calendar():
    return _load_module("jarvis_calendar_mp", "jarvis-calendar.py", _BIN_SEARCH)


def _contacts():
    return _load_module("jarvis_contacts_mp", "jarvis-contacts.py", _BIN_SEARCH)


def _commitments():
    return _load_module("jarvis_commitments_mp", "jarvis-commitments.py", _BIN_SEARCH)


def _email():
    return _load_module("jarvis_email_mp", "jarvis-email.py", _BIN_SEARCH)


def _apple():
    return _load_module("jarvis_apple_mp", "jarvis-apple.py", _BIN_SEARCH)


def _linkedin():
    return _load_module("jarvis_linkedin_mp", "jarvis-linkedin.py", _BIN_SEARCH)


def _stripe():
    return _load_module("jarvis_stripe_mp", "jarvis-stripe.py", _BIN_SEARCH)


def _orchestrator():
    return _load_module("jarvis_orchestrate_mp", "jarvis-orchestrate.py", _BIN_SEARCH)


def _notifications():
    return _load_module("jarvis_notifications_mp", "jarvis-notifications.py", _BIN_SEARCH)


def _ledger():
    return _load_module("outcome_ledger_mp", "outcome_ledger.py", _LIB_SEARCH)


# ── settings ──────────────────────────────────────────────────────────
def _read_settings() -> dict:
    if not SETTINGS_FILE.exists():
        return {}
    try:
        return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_settings(s: dict) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = SETTINGS_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(s, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(SETTINGS_FILE)
    except Exception as e:
        _log(f"settings write failed: {e}")


def _effective_settings() -> dict:
    s = _read_settings()
    return {
        "lead_time_minutes": int(s.get("lead_time_minutes")
                                 or DEFAULT_LEAD_TIME_MIN),
        "auto": bool(s.get("auto") if "auto" in s else True),
    }


def meeting_prep_settings(lead_time_minutes: int | None = None,
                          auto: bool | None = None) -> dict:
    cur = _read_settings()
    if lead_time_minutes is not None:
        cur["lead_time_minutes"] = max(1, int(lead_time_minutes))
    if auto is not None:
        cur["auto"] = bool(auto)
    if lead_time_minutes is not None or auto is not None:
        _write_settings(cur)
    eff = _effective_settings()
    return {"ok": True, **eff}


# ── prep state ────────────────────────────────────────────────────────
def _read_state() -> dict:
    if not PREP_STATE.exists():
        return {"prepped": {}}
    try:
        data = json.loads(PREP_STATE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data.setdefault("prepped", {})
            return data
    except Exception:
        pass
    return {"prepped": {}}


def _write_state(state: dict) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = PREP_STATE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False),
                       encoding="utf-8")
        tmp.replace(PREP_STATE)
    except Exception as e:
        _log(f"state write failed: {e}")


def _prune_state(state: dict) -> dict:
    cutoff = (datetime.now(tz=timezone.utc)
              - timedelta(days=PREP_STATE_RETENTION_DAYS))
    cutoff_iso = cutoff.isoformat(timespec="seconds")
    pruned = {k: v for k, v in (state.get("prepped") or {}).items()
              if (v.get("event_start") or "") >= cutoff_iso
              or (v.get("prepped_at") or "") >= cutoff_iso}
    state["prepped"] = pruned
    return state


def _is_prepped(event_id: str) -> bool:
    state = _read_state()
    return bool(event_id and event_id in (state.get("prepped") or {}))


def _mark_prepped(event_id: str, event: dict, note_id: str | None) -> None:
    state = _prune_state(_read_state())
    state.setdefault("prepped", {})[event_id] = {
        "event_id": event_id,
        "event_start": event.get("start") or "",
        "summary": event.get("summary") or "",
        "note_id": note_id,
        "prepped_at": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
    }
    _write_state(state)


# ── attendee resolution ───────────────────────────────────────────────
def _attendee_label(email_or_name: str) -> str:
    """Strip the local-part out of an email so 'corbin@acme.co' becomes
    'Corbin' for the relationship lookup."""
    s = (email_or_name or "").strip()
    if not s:
        return ""
    if "@" not in s:
        return s
    local = s.split("@", 1)[0]
    # foo.bar -> Foo Bar
    parts = re.split(r"[._-]+", local)
    if not parts:
        return s
    return " ".join(p.capitalize() for p in parts if p)


def _resolve_attendees(event: dict) -> list[str]:
    """Drop Watson himself and dedupe. Returns the original handle/email
    so downstream calls can hit either by name (relationship_brief
    accepts both)."""
    me_hints = {os.environ.get("JARVIS_USER_EMAIL", "").lower(),
                os.environ.get("USER", "").lower(), "watson"}
    out: list[str] = []
    seen: set[str] = set()
    for a in event.get("attendees") or []:
        if not a:
            continue
        a_str = str(a).strip()
        if not a_str or a_str.lower() in me_hints:
            continue
        # Dedupe on email; keep the first form we see.
        key = a_str.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(a_str)
    return out


# ── per-attendee context fan-out ─────────────────────────────────────
def _attendee_context(attendee: str) -> dict:
    """Pull every angle on one attendee. Each subcall is best-effort —
    a single source missing must not nuke the whole prep."""
    label = _attendee_label(attendee)
    rec: dict[str, Any] = {"attendee": attendee, "label": label}

    cm = _contacts()
    if cm is not None:
        try:
            rec["relationship"] = cm.relationship_brief(label)
        except Exception as e:
            rec["relationship"] = {"error": str(e)}

    com = _commitments()
    if com is not None:
        try:
            rec["open_commitments"] = com.list_commitments(
                related_contact=label, status="open", limit=10,
            )
        except Exception:
            pass

    em = _email()
    if em is not None:
        try:
            # Search recent threads with the attendee. Same Gmail filter
            # the email module accepts in its `query` arg.
            handle = attendee if "@" in attendee else label
            rec["recent_email"] = em.check_email(
                max_results=3,
                query=f"from:{handle} OR to:{handle} newer_than:14d",
            )
        except Exception:
            pass

    ap = _apple()
    if ap is not None:
        try:
            rec["recent_imessage"] = ap.imessage_check(hours=72)
        except Exception:
            pass

    li = _linkedin()
    if li is not None:
        try:
            rec["linkedin_changes"] = li.linkedin_changes(days=30, contacts_only=True)
        except Exception:
            pass

    sm = _stripe()
    if sm is not None:
        try:
            cust = sm.customer_for_contact(attendee)
            if cust.get("found"):
                rec["stripe"] = cust
        except Exception:
            pass

    return rec


def _build_prep_payload(event: dict, attendees: list[str]) -> dict:
    return {
        "event": {
            "id": event.get("id"),
            "summary": event.get("summary"),
            "start": event.get("start"),
            "end": event.get("end"),
            "location": event.get("location"),
            "attendees": attendees,
        },
        "attendees": [_attendee_context(a) for a in attendees[:6]],
    }


# ── synthesis via orchestrator ───────────────────────────────────────
def _synthesize_prep(payload: dict) -> str:
    """Hand the structured payload to execute_plan with a synthesize
    instruction. Returns the prose body. Falls back to a templated
    summary when the orchestrator is offline so meeting prep still
    produces something."""
    orch = _orchestrator()
    if orch is None or os.environ.get("ANTHROPIC_API_KEY", "") == "":
        return _fallback_prep(payload)
    ev = payload.get("event") or {}
    attendees = ", ".join(payload.get("event", {}).get("attendees", [])[:6]) or "(no attendees listed)"
    summary = ev.get("summary") or "(untitled meeting)"
    # We pass the structured payload as part of the goal so the planner
    # has everything in-scope. The orchestrator's synthesize tool will
    # fold the inputs into prose without any further tool calls when the
    # goal is wholly self-contained.
    payload_json = json.dumps(payload, ensure_ascii=False, default=str, indent=2)
    if len(payload_json) > 8000:
        payload_json = payload_json[:8000] + "\n...(truncated)"
    goal = (
        f"Prepare Watson for his upcoming meeting '{summary}' with "
        f"{attendees} starting at {ev.get('start')}. The full structured "
        f"context (attendee relationships, open commitments, recent "
        f"emails, iMessage activity, LinkedIn changes, and Stripe "
        f"customer status if applicable) is provided below. Synthesize a "
        f"tight prep brief — lead with who is in the room and where the "
        f"relationship stands, then open threads / commitments, then 2-3 "
        f"talking points. Voice-ready prose, no bullets unless they "
        f"genuinely help. Cap 220 words.\n\nContext:\n{payload_json}"
    )
    try:
        res = orch.execute_plan(goal)
    except Exception as e:
        _log(f"orchestrator synth failed: {e}")
        return _fallback_prep(payload)
    if isinstance(res, dict) and res.get("ok") and res.get("summary"):
        return res["summary"]
    return _fallback_prep(payload)


def _fallback_prep(payload: dict) -> str:
    ev = payload.get("event") or {}
    lines = [f"Meeting: {ev.get('summary', '(untitled)')}"]
    if ev.get("start"):
        lines.append(f"Start: {ev['start']}")
    if ev.get("location"):
        lines.append(f"Location: {ev['location']}")
    for ac in payload.get("attendees") or []:
        rel = (ac.get("relationship") or {})
        brief = rel.get("brief") or rel.get("summary") or ""
        bits = [f"\n— {ac.get('label') or ac.get('attendee')}"]
        if brief:
            bits.append(f"  {brief[:240]}")
        oc = (ac.get("open_commitments") or {}).get("commitments") or []
        if oc:
            bits.append(f"  Open commitments: {len(oc)} ({oc[0].get('text', '')[:60]}...)")
        if ac.get("stripe", {}).get("found"):
            s = ac["stripe"]
            bits.append(f"  Stripe: {s.get('plan')} (${s.get('mrr_dollars', 0)}/mo, "
                        f"LTV ${s.get('ltv_dollars', 0):.0f})")
        lines.extend(bits)
    return "\n".join(lines)


# ── note saving ───────────────────────────────────────────────────────
def _format_note_title(event: dict) -> str:
    """`2026-04-29 2pm — Meeting with Corbin` style."""
    start = event.get("start") or ""
    summary = (event.get("summary") or "Meeting").strip()
    # Try to render a friendly time stamp.
    when_label = ""
    try:
        if "T" in start:
            dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
            when_label = dt.astimezone().strftime("%Y-%m-%d %-I:%M%p").lower()
        elif start:
            when_label = start
    except Exception:
        when_label = start
    title = f"{when_label} — {summary}".strip(" —")
    # Apple Notes title is just a string; keep it short and filesystem-safe.
    return title[:120] or "Meeting prep"


def _save_prep_note(event: dict, prose: str, payload: dict) -> str | None:
    ap = _apple()
    if ap is None:
        return None
    try:
        gate = ap._apple_gate()  # type: ignore[attr-defined]
    except Exception:
        gate = {"error": "apple gate not callable"}
    if gate:
        return None
    title = _format_note_title(event)
    body = (
        f"# {event.get('summary', 'Meeting prep')}\n\n"
        f"Start: {event.get('start', '')}\n"
        f"Location: {event.get('location') or '—'}\n"
        f"Attendees: {', '.join(event.get('attendees') or []) or '—'}\n\n"
        f"## Prep\n\n{prose.strip()}\n\n"
        f"## Source data\n\n"
        f"```json\n{json.dumps(payload, indent=2, ensure_ascii=False, default=str)}\n```\n"
    )
    # Override the folder for this call so the prep folder is used.
    prev_folder = os.environ.get("JARVIS_NOTES_FOLDER")
    try:
        os.environ["JARVIS_NOTES_FOLDER"] = NOTES_FOLDER
        # The module reads JARVIS_NOTES_FOLDER at import time, so reload
        # by re-importing fresh — cache by a unique name so we don't
        # break the global module cache.
        src = BIN_DIR / "jarvis-apple.py"
        if not src.exists():
            src = Path(__file__).parent / "jarvis-apple.py"
        spec = importlib.util.spec_from_file_location("jarvis_apple_mp_folder", src)
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)  # type: ignore[union-attr]
        rec = fresh.apple_save_note(title, body=body)
    except Exception as e:
        _log(f"save_note failed: {e}")
        rec = {"error": str(e)}
    finally:
        if prev_folder is None:
            os.environ.pop("JARVIS_NOTES_FOLDER", None)
        else:
            os.environ["JARVIS_NOTES_FOLDER"] = prev_folder
    if isinstance(rec, dict) and rec.get("ok"):
        return (rec.get("note") or {}).get("id")
    return None


# ── notifications ─────────────────────────────────────────────────────
def _notify_ready(event: dict, lead_minutes: int) -> None:
    nm = _notifications()
    if nm is None:
        return
    summary = event.get("summary") or "your next meeting"
    when_label = ""
    try:
        if "T" in (event.get("start") or ""):
            dt = datetime.fromisoformat(event["start"].replace("Z", "+00:00"))
            when_label = dt.astimezone().strftime("%-I:%M %p").lower()
    except Exception:
        when_label = event.get("start") or ""
    content = (
        f"Your {when_label} '{summary}' is in {lead_minutes} minutes. "
        f"Prep notes saved to Apple Notes."
    )
    try:
        nm.enqueue(
            source="calendar", content=content,
            sender=None, urgency_keywords=["heads up"],
            time_sensitivity=3, route="auto",
        )
    except Exception as e:
        _log(f"enqueue notify failed: {e}")


# ── ledger emit ───────────────────────────────────────────────────────
def _emit(action: str, status: str, **ctx) -> None:
    led = _ledger()
    if led is None:
        return
    try:
        led.emit(cap="meeting_prep", action=action, status=status, context=ctx)
    except Exception:
        pass


# ── core: prep one event ──────────────────────────────────────────────
def _prep_event(event: dict, lead_minutes: int) -> dict:
    started = time.monotonic()
    event_id = event.get("id") or ""
    attendees = _resolve_attendees(event)
    if not attendees:
        _log(f"skip {event_id}: no attendees")
        _emit("prep_event", "skipped", event_id=event_id, reason="no_attendees")
        return {"ok": False, "skipped": True, "reason": "no attendees"}
    payload = _build_prep_payload(event, attendees)
    prose = _synthesize_prep(payload)
    note_id = _save_prep_note(event, prose, payload)
    _notify_ready(event, lead_minutes)
    _mark_prepped(event_id, event, note_id)
    elapsed = int((time.monotonic() - started) * 1000)
    _emit("prep_event", "success", event_id=event_id,
          attendee_count=len(attendees), latency_ms=elapsed)
    _log(f"prepped {event_id} ({event.get('summary')!r}) "
         f"attendees={len(attendees)} note={note_id} ({elapsed}ms)")
    return {
        "ok": True,
        "event_id": event_id,
        "summary": event.get("summary"),
        "start": event.get("start"),
        "attendees": attendees,
        "note_id": note_id,
        "prose": prose,
    }


# ── PUBLIC: meeting_prep (manual trigger) ─────────────────────────────
def meeting_prep(event_id_or_time: str | None = None) -> dict:
    """Manually prep a specific event or the next upcoming meeting.
    Forces re-prep even if the meeting was already prepped — manual
    invocation always wins over the dedup state."""
    gate = _gate_check()
    if gate:
        return gate
    cal = _calendar()
    if cal is None:
        return {"error": "jarvis-calendar not installed"}

    event: dict | None = None
    if event_id_or_time and event_id_or_time not in ("", "next", "today"):
        # Try to find by id in today + next 2 days
        rec = cal.check_calendar(days=2)
        for e in rec.get("events") or []:
            if e.get("id") == event_id_or_time:
                event = e
                break
        if event is None:
            return {"error": f"no event matches id {event_id_or_time!r}"}
    else:
        rec = cal.check_calendar(days=1)
        events = [e for e in (rec.get("events") or [])
                  if e.get("start") and "T" in str(e.get("start"))]
        # Filter to events in the future
        now_iso = datetime.now(tz=timezone.utc).isoformat()
        events = sorted(
            [e for e in events if (e.get("start") or "") >= now_iso[:19]],
            key=lambda x: x.get("start") or "",
        )
        if not events:
            return {"ok": False, "skipped": True, "reason": "no upcoming events today"}
        event = events[0]
    eff = _effective_settings()
    return _prep_event(event, eff["lead_time_minutes"])


# ── PUBLIC: scan & poll ───────────────────────────────────────────────
def _due_events(events: list[dict], lead_minutes: int) -> list[dict]:
    """Filter events whose start time falls in the [now, now+lead] window
    and have an id (skip all-day / cancelled / unconfirmed)."""
    now = datetime.now(tz=timezone.utc)
    horizon = now + timedelta(minutes=max(1, int(lead_minutes)))
    out: list[dict] = []
    for e in events:
        if (e.get("status") or "").lower() == "cancelled":
            continue
        start = e.get("start")
        if not start or "T" not in str(start):
            continue
        try:
            dt = datetime.fromisoformat(str(start).replace("Z", "+00:00"))
        except Exception:
            continue
        if not dt.tzinfo:
            dt = dt.replace(tzinfo=timezone.utc)
        if now <= dt <= horizon:
            out.append(e)
    return out


def scan_and_prep() -> dict:
    """One-shot scan of the upcoming window. Preps anything due that
    isn't on the prepped list. Returns a summary."""
    gate = _gate_check()
    if gate:
        return gate
    cal = _calendar()
    if cal is None:
        return {"error": "jarvis-calendar not installed"}
    eff = _effective_settings()
    if not eff.get("auto"):
        return {"ok": True, "skipped": True, "reason": "auto disabled"}
    rec = cal.check_calendar(days=1)
    events = rec.get("events") or []
    due = _due_events(events, eff["lead_time_minutes"])
    prepped: list[dict] = []
    skipped: list[str] = []
    for e in due:
        eid = e.get("id") or ""
        if not eid:
            continue
        if _is_prepped(eid):
            skipped.append(eid)
            continue
        try:
            res = _prep_event(e, eff["lead_time_minutes"])
            if res.get("ok"):
                prepped.append({
                    "event_id": eid,
                    "summary": e.get("summary"),
                    "start": e.get("start"),
                })
        except Exception as ex:
            _log(f"prep crash for {eid}: {ex}")
    return {
        "ok": True,
        "scanned_window_minutes": eff["lead_time_minutes"],
        "events_in_window": len(due),
        "prepped": prepped,
        "skipped_already_prepped": skipped,
    }


def poll_loop() -> None:
    """Long-running poller. Sleeps `POLL_INTERVAL_S` between scans.
    Spawned as a daemon thread by wake-listener — daemon=True so it
    dies with the listener process."""
    _log("meeting-prep poller starting")
    while True:
        try:
            scan_and_prep()
        except Exception as e:
            _log(f"poll cycle failed: {e}")
        try:
            time.sleep(POLL_INTERVAL_S)
        except Exception:
            return


# ── PUBLIC: pending_prep_hint ─────────────────────────────────────────
def pending_prep_hint() -> str:
    """One-line hint for jarvis-context. Empty most of the time —
    surfaces only when a prep note exists for an event that's within
    30 minutes of now."""
    if _gate_check():
        return ""
    state = _read_state()
    prepped = state.get("prepped") or {}
    if not prepped:
        return ""
    now = datetime.now(tz=timezone.utc)
    soon = now + timedelta(minutes=30)
    for entry in prepped.values():
        start = entry.get("event_start") or ""
        if "T" not in start:
            continue
        try:
            dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
        except Exception:
            continue
        if not dt.tzinfo:
            dt = dt.replace(tzinfo=timezone.utc)
        if now <= dt <= soon:
            mins = max(0, int((dt - now).total_seconds() // 60))
            summary = entry.get("summary") or "your next meeting"
            return (
                f"**Meeting prep ready:** prep notes for '{summary}' "
                f"({mins} min away) are saved to Apple Notes "
                f"under '{NOTES_FOLDER}'. If Watson asks anything about "
                f"this meeting, lead with the prep note instead of "
                f"re-deriving."
            )
    return ""


# ── status ────────────────────────────────────────────────────────────
def status() -> dict:
    state = _read_state()
    prepped = state.get("prepped") or {}
    eff = _effective_settings()
    return {
        "ok": True,
        "settings": eff,
        "prepped_count": len(prepped),
        "recent_prepped": sorted(
            (
                {"event_id": k, "summary": v.get("summary"),
                 "start": v.get("event_start"),
                 "prepped_at": v.get("prepped_at")}
                for k, v in prepped.items()
            ),
            key=lambda r: r.get("prepped_at") or "",
            reverse=True,
        )[:10],
    }


# ── CLI ───────────────────────────────────────────────────────────────
def _cli() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event-id", help="Prep a specific event by id.")
    parser.add_argument("--scan", action="store_true",
                        help="One-shot scan + prep everything due.")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--settings", action="store_true",
                        help="Show or update settings.")
    parser.add_argument("--lead-time", type=int)
    parser.add_argument("--auto", choices=["true", "false", "1", "0", "on", "off"])
    args = parser.parse_args()

    if args.status:
        print(json.dumps(status(), indent=2, ensure_ascii=False, default=str))
        return 0
    if args.settings or args.lead_time is not None or args.auto is not None:
        auto = None
        if args.auto is not None:
            auto = str(args.auto).lower() in ("true", "1", "on")
        out = meeting_prep_settings(lead_time_minutes=args.lead_time, auto=auto)
        print(json.dumps(out, indent=2))
        return 0
    if args.scan:
        out = scan_and_prep()
    elif args.event_id:
        out = meeting_prep(args.event_id)
    else:
        out = meeting_prep(None)
    print(json.dumps(out, indent=2, ensure_ascii=False, default=str))
    return 0 if (isinstance(out, dict) and not out.get("error")) else 1


if __name__ == "__main__":
    sys.exit(_cli())
