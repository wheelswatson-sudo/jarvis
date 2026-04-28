#!/usr/bin/env python3
"""Calendar agent for Jarvis — read, create, update, delete via Google
Calendar API. Mirrors bin/jarvis-email.py's structure and reuses its
OAuth token (~/.jarvis/credentials/google.json) since both agents share
the same Google account.

Functions exposed:

    check_calendar(date=None, days=1, calendar_id="primary") → list of events
    create_event(summary, start, end, attendees=[], location=None,
                 description=None, calendar_id="primary")    → {event_id, ...}
    update_event(event_id, ... fields ...)                   → updated event
    delete_event(event_id, confirm=False)                    → {deleted: True}

Auth — share the email agent's token. If unauthorized:
    bin/jarvis-email.py --auth     # one OAuth flow grants both scopes

Time inputs accept:
  - ISO 8601 ("2026-04-29T14:00:00")
  - "HH:MM" today (or tomorrow if past)
  - "tomorrow at HH:MM"
  - "in N minutes/hours"
  - Bare "YYYY-MM-DD" (treated as all-day on that date)

Dependencies (same install as the email agent):
    pip install google-api-python-client google-auth-httplib2 \\
                google-auth-oauthlib --break-system-packages

Missing libraries / no auth → every function returns {"error": "..."}.

Gate: JARVIS_CALENDAR=1 (default 1).
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
CRED_DIR = ASSISTANT_DIR / "credentials"
TOKEN_FILE = CRED_DIR / "google.json"

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
]


GOOGLE_LIBS_INSTALL_HINT = (
    "google-api-python-client not installed. "
    "Run: pip install google-api-python-client google-auth-httplib2 "
    "google-auth-oauthlib --break-system-packages"
)


def _try_import_google():
    try:
        from google.oauth2.credentials import Credentials  # type: ignore
        from google.auth.transport.requests import Request  # type: ignore
        from googleapiclient.discovery import build  # type: ignore
        return {"Credentials": Credentials, "Request": Request, "build": build}
    except ImportError as e:
        sys.stderr.write(f"jarvis-calendar: {GOOGLE_LIBS_INSTALL_HINT} ({e})\n")
        return None


GOOGLE_LIBS_AVAILABLE: bool = _try_import_google() is not None


def _service_error() -> dict:
    """Return libs-missing vs auth-missing diagnostic — distinct messages
    so Claude can relay the actual fix instead of suggesting --auth when
    the real issue is uninstalled packages."""
    if not GOOGLE_LIBS_AVAILABLE:
        return {"error": GOOGLE_LIBS_INSTALL_HINT}
    return {"error": "calendar service unavailable — run `jarvis-email --auth`"}


def _load_credentials():
    g = _try_import_google()
    if g is None or not TOKEN_FILE.exists():
        return None
    try:
        creds = g["Credentials"].from_authorized_user_file(str(TOKEN_FILE), SCOPES)
    except Exception as e:
        sys.stderr.write(f"jarvis-calendar: token load failed ({e})\n")
        return None
    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(g["Request"]())
            TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
        except Exception as e:
            sys.stderr.write(f"jarvis-calendar: refresh failed ({e})\n")
            return None
    return creds if creds and creds.valid else None


def _calendar_service():
    g = _try_import_google()
    if g is None:
        return None
    creds = _load_credentials()
    if creds is None:
        return None
    try:
        return g["build"]("calendar", "v3", credentials=creds, cache_discovery=False)
    except Exception as e:
        sys.stderr.write(f"jarvis-calendar: service build failed ({e})\n")
        return None


def _gate_check() -> dict | None:
    if os.environ.get("JARVIS_CALENDAR", "1") != "1":
        return {"error": "calendar is disabled (JARVIS_CALENDAR=0)"}
    return None


def _local_tz():
    return datetime.now().astimezone().tzinfo


_REL_RE = re.compile(r"^\s*in\s+(\d+)\s*(min(ute)?s?|hours?|hrs?)\s*$", re.I)
_HHMM_RE = re.compile(r"^\s*(\d{1,2}):(\d{2})\s*(am|pm)?\s*$", re.I)
_TOMORROW_RE = re.compile(r"^\s*tomorrow(?:\s+at\s+(.+))?\s*$", re.I)
_DATE_ONLY_RE = re.compile(r"^\s*(\d{4})-(\d{2})-(\d{2})\s*$")


def _parse_when(s: str, default_duration_min: int = 30) -> tuple[datetime, datetime, bool]:
    """Resolve a flexible time expression to (start, end, all_day).

    Raises ValueError when nothing matches so the tool surface can return
    a structured error rather than a half-parsed datetime."""
    s = (s or "").strip()
    if not s:
        raise ValueError("empty time expression")
    tz = _local_tz()
    now = datetime.now(tz=tz)

    # All-day: bare YYYY-MM-DD
    m = _DATE_ONLY_RE.match(s)
    if m:
        d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        start = datetime.combine(d, time(0, 0), tzinfo=tz)
        end = start + timedelta(days=1)
        return start, end, True

    # ISO 8601
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=tz)
        return dt, dt + timedelta(minutes=default_duration_min), False
    except ValueError:
        pass

    # "in N minutes / hours"
    m = _REL_RE.match(s)
    if m:
        n = int(m.group(1))
        unit = m.group(2).lower()
        delta = timedelta(hours=n) if unit.startswith("hour") or unit.startswith("hr") \
                                  else timedelta(minutes=n)
        start = now + delta
        return start, start + timedelta(minutes=default_duration_min), False

    # "tomorrow [at HH:MM]"
    m = _TOMORROW_RE.match(s)
    if m:
        rest = m.group(1)
        d = (now + timedelta(days=1)).date()
        if rest:
            mm = _HHMM_RE.match(rest)
            if not mm:
                raise ValueError(f"could not parse 'tomorrow at ...': {rest!r}")
            hour, minute, ampm = int(mm.group(1)), int(mm.group(2)), mm.group(3)
            if ampm:
                ap = ampm.lower()
                if ap == "pm" and hour < 12:
                    hour += 12
                elif ap == "am" and hour == 12:
                    hour = 0
            start = datetime.combine(d, time(hour, minute), tzinfo=tz)
            return start, start + timedelta(minutes=default_duration_min), False
        # No time → all-day tomorrow
        start = datetime.combine(d, time(0, 0), tzinfo=tz)
        return start, start + timedelta(days=1), True

    # "HH:MM" today (or tomorrow if past)
    m = _HHMM_RE.match(s)
    if m:
        hour, minute, ampm = int(m.group(1)), int(m.group(2)), m.group(3)
        if ampm:
            ap = ampm.lower()
            if ap == "pm" and hour < 12:
                hour += 12
            elif ap == "am" and hour == 12:
                hour = 0
        target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if target <= now:
            target += timedelta(days=1)
        return target, target + timedelta(minutes=default_duration_min), False

    raise ValueError(f"could not parse time expression: {s!r}")


def _summarize_event(ev: dict) -> dict:
    start = ev.get("start") or {}
    end = ev.get("end") or {}
    return {
        "id": ev.get("id"),
        "summary": ev.get("summary"),
        "start": start.get("dateTime") or start.get("date"),
        "end": end.get("dateTime") or end.get("date"),
        "location": ev.get("location"),
        "attendees": [a.get("email") for a in (ev.get("attendees") or []) if a.get("email")],
        "html_link": ev.get("htmlLink"),
        "status": ev.get("status"),
    }


def check_calendar(date: str | None = None, days: int = 1,
                   calendar_id: str = "primary") -> dict:
    """List events between `date` (default: today) and `date + days`."""
    gate = _gate_check()
    if gate:
        return gate
    svc = _calendar_service()
    if svc is None:
        return _service_error()

    tz = _local_tz()
    if date:
        try:
            start_dt, _, _ = _parse_when(date, default_duration_min=0)
            start_dt = start_dt.replace(hour=0, minute=0, second=0, microsecond=0)
        except ValueError as e:
            return {"error": str(e)}
    else:
        start_dt = datetime.now(tz=tz).replace(hour=0, minute=0, second=0, microsecond=0)
    end_dt = start_dt + timedelta(days=max(1, int(days)))

    try:
        resp = svc.events().list(
            calendarId=calendar_id,
            timeMin=start_dt.isoformat(),
            timeMax=end_dt.isoformat(),
            singleEvents=True,
            orderBy="startTime",
            maxResults=50,
        ).execute()
    except Exception as e:
        return {"error": f"list failed: {e}"}
    events = [_summarize_event(e) for e in resp.get("items", []) or []]
    return {
        "calendar_id": calendar_id,
        "from": start_dt.isoformat(),
        "to": end_dt.isoformat(),
        "count": len(events),
        "events": events,
    }


def create_event(summary: str, start: str, end: str | None = None,
                 attendees: list | None = None,
                 location: str | None = None,
                 description: str | None = None,
                 calendar_id: str = "primary") -> dict:
    gate = _gate_check()
    if gate:
        return gate
    if not (summary and start):
        return {"error": "summary and start required"}
    svc = _calendar_service()
    if svc is None:
        return _service_error()

    try:
        start_dt, end_default, all_day = _parse_when(start, default_duration_min=30)
    except ValueError as e:
        return {"error": str(e)}
    if end:
        try:
            end_dt, _, _ = _parse_when(end, default_duration_min=30)
        except ValueError as e:
            return {"error": f"end: {e}"}
    else:
        end_dt = end_default

    body: dict = {"summary": summary}
    if location:
        body["location"] = location
    if description:
        body["description"] = description
    if attendees:
        body["attendees"] = [{"email": a} for a in attendees if a]
    if all_day:
        body["start"] = {"date": start_dt.date().isoformat()}
        body["end"] = {"date": end_dt.date().isoformat()}
    else:
        body["start"] = {"dateTime": start_dt.isoformat()}
        body["end"] = {"dateTime": end_dt.isoformat()}

    try:
        ev = svc.events().insert(calendarId=calendar_id, body=body).execute()
    except Exception as e:
        return {"error": f"create failed: {e}"}
    return {"created": True, **_summarize_event(ev)}


def update_event(event_id: str, summary: str | None = None,
                 start: str | None = None, end: str | None = None,
                 attendees: list | None = None,
                 location: str | None = None,
                 description: str | None = None,
                 calendar_id: str = "primary") -> dict:
    """Patch the named fields. Anything left None is preserved."""
    gate = _gate_check()
    if gate:
        return gate
    if not event_id:
        return {"error": "event_id required"}
    svc = _calendar_service()
    if svc is None:
        return _service_error()

    patch: dict = {}
    if summary is not None:
        patch["summary"] = summary
    if location is not None:
        patch["location"] = location
    if description is not None:
        patch["description"] = description
    if attendees is not None:
        patch["attendees"] = [{"email": a} for a in attendees if a]
    if start:
        try:
            sdt, default_end, all_day = _parse_when(start, default_duration_min=30)
        except ValueError as e:
            return {"error": f"start: {e}"}
        if all_day:
            patch["start"] = {"date": sdt.date().isoformat()}
        else:
            patch["start"] = {"dateTime": sdt.isoformat()}
        if not end:
            patch["end"] = (
                {"date": default_end.date().isoformat()} if all_day else
                {"dateTime": default_end.isoformat()}
            )
    if end:
        try:
            edt, _, all_day_e = _parse_when(end, default_duration_min=30)
        except ValueError as e:
            return {"error": f"end: {e}"}
        patch["end"] = (
            {"date": edt.date().isoformat()} if all_day_e else
            {"dateTime": edt.isoformat()}
        )

    if not patch:
        return {"error": "no fields to update"}

    try:
        ev = svc.events().patch(
            calendarId=calendar_id, eventId=event_id, body=patch,
        ).execute()
    except Exception as e:
        return {"error": f"update failed: {e}"}
    return {"updated": True, **_summarize_event(ev)}


def delete_event(event_id: str, confirm: bool = False,
                 calendar_id: str = "primary") -> dict:
    """Cancel / delete an event. confirm=true required to fire."""
    gate = _gate_check()
    if gate:
        return gate
    if not event_id:
        return {"error": "event_id required"}
    if not confirm:
        return {
            "deleted": False,
            "needs_confirmation": True,
            "hint": "Re-call with confirm=true after Watson says yes.",
        }
    svc = _calendar_service()
    if svc is None:
        return _service_error()
    try:
        svc.events().delete(calendarId=calendar_id, eventId=event_id).execute()
    except Exception as e:
        return {"error": f"delete failed: {e}"}
    return {"deleted": True, "event_id": event_id}


def _cli() -> int:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        sys.stdout.write(__doc__ or "")
        return 0
    if args[0] == "--check":
        days = int(args[1]) if len(args) > 1 else 1
        print(json.dumps(check_calendar(days=days), indent=2, default=str))
        return 0
    sys.stderr.write(f"unknown command: {args[0]}\n")
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
