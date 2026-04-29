#!/usr/bin/env python3
"""Morning briefing — proactive day summary, voice-ready.

An elite EA doesn't wait to be asked. This module assembles Watson's day
from calendar, email, Telegram group chats, memory, pending notifications,
and weather, optionally calls the orchestrator to prep per-meeting context,
and synthesizes a tight spoken briefing via Sonnet.

Generation can run on a cron / LaunchAgent before Watson's first interaction.
The briefing file at ~/.jarvis/briefings/YYYY-MM-DD.md is the source of truth;
delivery state lives at ~/.jarvis/state/briefing_delivered (one line per
date that has already been delivered, append-only).

Public surface:

    generate_today(force=False) -> dict     build today's briefing if missing
    get_today() -> dict                     read the cached briefing for today
    should_deliver() -> bool                briefing exists today AND not yet delivered
    mark_delivered() -> None                record delivery so the next ask is silent
    deliver_now(force=False) -> dict        speak via jarvis-notify, mark delivered
    pending_briefing_hint() -> str          one-line system-prompt hint when pending

CLI:
    bin/jarvis-briefing.py                  generate today (no-op if exists)
    bin/jarvis-briefing.py --force          regenerate even if exists
    bin/jarvis-briefing.py --show           print today's briefing text
    bin/jarvis-briefing.py --deliver        speak via jarvis-notify and mark delivered
    bin/jarvis-briefing.py --status         summary of state

Gate: JARVIS_BRIEFING=1 (default 1).
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
BIN_DIR = ASSISTANT_DIR / "bin"
BRIEFINGS_DIR = ASSISTANT_DIR / "briefings"
STATE_DIR = ASSISTANT_DIR / "state"
DELIVERED_FILE = STATE_DIR / "briefing_delivered"
LOG_DIR = ASSISTANT_DIR / "logs"
BRIEFING_LOG = LOG_DIR / "briefing.log"

SYNTH_MODEL = os.environ.get("JARVIS_BRIEFING_MODEL", "claude-sonnet-4-6")
WEATHER_TIMEOUT_S = float(os.environ.get("JARVIS_BRIEFING_WEATHER_TIMEOUT_S", "3"))
PER_MEETING_PREP = os.environ.get("JARVIS_BRIEFING_PER_MEETING_PREP", "0") == "1"
MAX_MEETING_PREPS = int(os.environ.get("JARVIS_BRIEFING_MAX_PREPS", "3"))


# ── Sibling module loaders ──────────────────────────────────────────
def _load_sibling(name: str):
    src = BIN_DIR / f"{name}.py"
    if not src.exists():
        src = Path(__file__).parent / f"{name}.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location(name.replace("-", "_"), src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    except Exception as e:
        sys.stderr.write(f"jarvis-briefing: load {name} failed ({e})\n")
        return None


_calendar_mod = None
_email_mod = None
_memory_mod = None
_orch_mod = None
_telegram_mod = None
_social_mod = None
_network_mod = None


def _calendar():
    global _calendar_mod
    if _calendar_mod is None:
        _calendar_mod = _load_sibling("jarvis-calendar")
    return _calendar_mod


def _email():
    global _email_mod
    if _email_mod is None:
        _email_mod = _load_sibling("jarvis-email")
    return _email_mod


def _memory():
    global _memory_mod
    if _memory_mod is None:
        _memory_mod = _load_sibling("jarvis_memory")
    return _memory_mod


def _orchestrator():
    global _orch_mod
    if _orch_mod is None:
        _orch_mod = _load_sibling("jarvis-orchestrate")
    return _orch_mod


def _telegram():
    global _telegram_mod
    if _telegram_mod is None:
        _telegram_mod = _load_sibling("jarvis-telegram")
    return _telegram_mod


def _social():
    global _social_mod
    if _social_mod is None:
        _social_mod = _load_sibling("jarvis-social")
    return _social_mod


def _network():
    global _network_mod
    if _network_mod is None:
        _network_mod = _load_sibling("jarvis-network")
    return _network_mod


# ── Anthropic call (single-shot, blocking) ──────────────────────────
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
            raise RuntimeError(f"network error: {e}") from e
    raise RuntimeError(f"unexpected: {last_err}")


# ── Source pulls ────────────────────────────────────────────────────
def _pull_calendar() -> dict:
    mod = _calendar()
    if mod is None:
        return {"error": "calendar unavailable"}
    try:
        return mod.check_calendar(days=1)
    except Exception as e:
        return {"error": f"calendar: {e}"}


def _pull_email() -> dict:
    """Pull two batches: starred (anything Watson flagged for follow-up)
    and unread newer than 1d. Both capped tight — this is breakfast, not
    inbox triage."""
    mod = _email()
    if mod is None:
        return {"error": "email unavailable"}
    out: dict = {}
    try:
        out["starred"] = mod.check_email(max_results=5, query="is:starred newer_than:7d")
    except Exception as e:
        out["starred"] = {"error": str(e)}
    try:
        out["unread"] = mod.check_email(max_results=8, query="is:unread newer_than:1d")
    except Exception as e:
        out["unread"] = {"error": str(e)}
    return out


def _pull_pending_notifications() -> list[dict]:
    pending = ASSISTANT_DIR / "notifications" / "pending.json"
    if not pending.exists():
        return []
    try:
        with pending.open() as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _pull_memory_recent(limit: int = 5) -> list[dict]:
    mod = _memory()
    if mod is None:
        return []
    try:
        mem = mod.Memory()
        return mem.recent(limit)
    except Exception:
        return []


def _pull_telegram(hours: int = 12) -> dict:
    """Pull the per-group digest. Only includes groups with activity in
    the window — empty groups are dropped before this returns."""
    mod = _telegram()
    if mod is None:
        return {"groups": []}
    try:
        rec = mod.telegram_digest(hours=hours, priority="all")
    except Exception as e:
        return {"error": f"telegram: {e}"}
    if isinstance(rec, dict) and rec.get("error"):
        # Soft-fail — telegram is optional. Briefing must never block on it.
        return {"groups": [], "soft_error": rec["error"]}
    return rec or {"groups": []}


def _pull_social(hours: int = 12) -> dict:
    """Pull the per-platform social digest. Same soft-fail contract as
    telegram — breakfast does not block on social."""
    mod = _social()
    if mod is None:
        return {"platforms": []}
    try:
        rec = mod.social_digest(hours=hours)
    except Exception as e:
        return {"error": f"social: {e}"}
    if isinstance(rec, dict) and rec.get("error"):
        return {"platforms": [], "soft_error": rec["error"]}
    return rec or {"platforms": []}


def _pull_network_alerts() -> list[dict]:
    """Surface actionable relationship alerts for the briefing — fading
    inner_circle, pending follow-ups, intro opportunities. Returns [] when
    the network module is missing or nothing is actionable; soft-fail."""
    mod = _network()
    if mod is None:
        return []
    try:
        rec = mod.network_alerts(refresh=False)
    except Exception:
        return []
    items = (rec or {}).get("alerts") or []
    # Drop low-priority items from the briefing — keep it focused.
    return [a for a in items if a.get("priority") in ("high", "normal")][:5]


def _pull_weather() -> dict:
    """Best-effort weather via wttr.in (no key needed). Skip if it 404s,
    rate-limits, or just takes too long — breakfast doesn't wait."""
    if os.environ.get("JARVIS_BRIEFING_WEATHER", "1") != "1":
        return {}
    location = os.environ.get("JARVIS_WEATHER_LOCATION", "")  # blank = autodetect
    url = f"https://wttr.in/{location}?format=j1"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "jarvis-briefing/1.0"})
        with urllib.request.urlopen(req, timeout=WEATHER_TIMEOUT_S) as r:
            data = json.loads(r.read())
    except Exception:
        return {}
    try:
        cur = (data.get("current_condition") or [{}])[0]
        today = (data.get("weather") or [{}])[0]
        return {
            "now_temp_f": cur.get("temp_F"),
            "now_desc": ((cur.get("weatherDesc") or [{}])[0].get("value") or "").strip(),
            "today_min_f": today.get("mintempF"),
            "today_max_f": today.get("maxtempF"),
            "today_chance_rain": (today.get("hourly") or [{}])[0].get("chanceofrain"),
        }
    except Exception:
        return {}


def _maybe_per_meeting_prep(events: list[dict]) -> dict[str, str]:
    """For the first MAX_MEETING_PREPS time-bound events of today, ask the
    orchestrator to prep a one-line context. Disabled by default — costs
    ~3-5 Sonnet calls, nice-to-have. Enable with JARVIS_BRIEFING_PER_MEETING_PREP=1."""
    if not PER_MEETING_PREP:
        return {}
    orch = _orchestrator()
    if orch is None:
        return {}
    out: dict[str, str] = {}
    timed = [e for e in events if e.get("start") and "T" in str(e.get("start"))]
    for ev in timed[:MAX_MEETING_PREPS]:
        title = ev.get("summary") or "(untitled)"
        attendees = ev.get("attendees") or []
        goal = (
            f"Brief Watson on his upcoming meeting '{title}'"
            + (f" with {', '.join(attendees[:5])}" if attendees else "")
            + ". Keep it to 2-3 sentences."
        )
        try:
            res = orch.execute_plan(goal)
            if res.get("ok") and res.get("summary"):
                out[ev.get("id", title)] = res["summary"]
        except Exception:
            continue
    return out


# ── Synthesis ───────────────────────────────────────────────────────
SYNTH_SYSTEM = """You are JARVIS delivering Watson's morning briefing.

Voice-ready prose, British-butler register, lead with what matters most.
Open with a greeting that names the count of things that need his attention
today (e.g. "Good morning, sir. You've got four things today.") and then
walk through them in order of impact. End with a single line on weather if
provided, or a clean "Will that be all, sir?" sign-off.

Rules:
- One paragraph per topic, no bullet lists. This is heard, not read.
- Quantify ("three urgent emails, eleven that can wait") rather than vague
  ("several").
- Drop pleasantries between items — pace matters.
- If a meeting prep blurb is provided for an event, use it; don't generate one.
- Don't include disclaimers, "I will now..." preambles, or chain-of-thought.
- Hard ceiling: 220 words. Get under it cleanly.
"""


def _build_synth_prompt(payload: dict) -> str:
    """Render the structured payload as a compact briefing input."""
    parts: list[str] = []
    parts.append(f"DATE: {payload['date']}")
    parts.append(f"WEEKDAY: {payload['weekday']}")
    cal = payload.get("calendar") or {}
    events = cal.get("events") or []
    if events:
        evs = []
        for e in events[:8]:
            attendees = ", ".join(e.get("attendees") or [])
            evs.append(
                f"- {e.get('start', '')} — {e.get('summary', '(untitled)')}"
                + (f" [with {attendees}]" if attendees else "")
                + (f" [{e.get('location')}]" if e.get("location") else "")
            )
        parts.append("CALENDAR:\n" + "\n".join(evs))
    elif "error" in cal:
        parts.append(f"CALENDAR: unavailable ({cal['error']})")
    else:
        parts.append("CALENDAR: nothing scheduled.")

    em = payload.get("email") or {}
    starred = (em.get("starred") or {}).get("messages") or []
    unread = (em.get("unread") or {}).get("messages") or []
    if starred:
        parts.append("STARRED EMAIL:\n" + "\n".join(
            f"- {m.get('from', '')}: {m.get('subject', '')}" for m in starred[:5]
        ))
    if unread:
        parts.append(f"UNREAD EMAIL ({len(unread)}):\n" + "\n".join(
            f"- {m.get('from', '')}: {m.get('subject', '')}" for m in unread[:8]
        ))

    tg = payload.get("telegram") or {}
    tg_groups = [g for g in (tg.get("groups") or []) if (g.get("message_count") or 0) > 0]
    if tg_groups:
        lines = []
        for g in tg_groups[:6]:
            urgency = "🔴 " if g.get("urgent") else ""
            actions = g.get("action_items") or []
            action_blob = (" Actions: " + " | ".join(actions[:3])) if actions else ""
            lines.append(
                f"- {urgency}{g.get('name')} ({g.get('message_count')} msgs, "
                f"priority {g.get('priority', 'normal')}): "
                f"{(g.get('summary') or '').strip()}{action_blob}"
            )
        parts.append("GROUP CHATS (Telegram):\n" + "\n".join(lines))

    social = payload.get("social") or {}
    social_blocks = [
        b for b in (social.get("platforms") or [])
        if (b.get("item_count") or 0) > 0
    ]
    if social_blocks:
        lines = []
        for b in social_blocks[:6]:
            urgency = "🔴 " if b.get("urgent") else ""
            actions = b.get("action_items") or []
            action_blob = (" Actions: " + " | ".join(actions[:3])) if actions else ""
            lines.append(
                f"- {urgency}{b.get('name')} ({b.get('item_count')} items): "
                f"{(b.get('summary') or '').strip()}{action_blob}"
            )
        parts.append("SOCIAL MEDIA:\n" + "\n".join(lines))

    pending = payload.get("pending_notifications") or []
    if pending:
        parts.append(f"PENDING NOTIFICATIONS ({len(pending)}):\n" + "\n".join(
            f"- {n.get('message', '')}" for n in pending[:6]
        ))

    net_alerts = payload.get("network_alerts") or []
    if net_alerts:
        lines = []
        for a in net_alerts[:5]:
            tag = (a.get("kind") or "").replace("_", " ")
            prio = a.get("priority") or "normal"
            lines.append(f"- [{prio}] {tag}: {a.get('message', '')}")
        parts.append("RELATIONSHIP ALERTS:\n" + "\n".join(lines))

    mem = payload.get("memory_recent") or []
    if mem:
        parts.append("RECENT MEMORY (Watson said in the last few days):\n" + "\n".join(
            f"- {m.get('text', '')[:120]}" for m in mem[:4]
        ))

    preps = payload.get("meeting_preps") or {}
    if preps:
        lines = []
        for ev_id, blurb in preps.items():
            ev = next((e for e in events if e.get("id") == ev_id or e.get("summary") == ev_id), None)
            label = (ev or {}).get("summary") or ev_id
            lines.append(f"- {label}: {blurb}")
        parts.append("PER-MEETING CONTEXT:\n" + "\n".join(lines))

    weather = payload.get("weather") or {}
    if weather and weather.get("now_temp_f"):
        parts.append(
            f"WEATHER: now {weather['now_temp_f']}°F {weather.get('now_desc', '')}, "
            f"high {weather.get('today_max_f', '?')}°F low {weather.get('today_min_f', '?')}°F"
        )

    return "\n\n".join(parts)


def _synthesize(payload: dict, api_key: str) -> str:
    user_text = _build_synth_prompt(payload)
    try:
        return _anthropic_call(
            api_key, SYNTH_MODEL, SYNTH_SYSTEM, user_text,
            max_tokens=600, timeout=30,
        )
    except Exception as e:
        # Fallback: structured prose without Sonnet.
        sys.stderr.write(f"jarvis-briefing: synth failed ({e}); using fallback\n")
        return _fallback_synth(payload)


def _fallback_synth(payload: dict) -> str:
    """No-API fallback. Plain prose, still voice-listenable, used when
    Sonnet errors so the cron job still produces something useful."""
    cal = payload.get("calendar") or {}
    events = cal.get("events") or []
    em = payload.get("email") or {}
    unread_count = len((em.get("unread") or {}).get("messages") or [])
    starred_count = len((em.get("starred") or {}).get("messages") or [])
    pending_count = len(payload.get("pending_notifications") or [])

    lines = [f"Good morning, sir. It is {payload['weekday']}."]
    if events:
        first = events[0]
        lines.append(
            f"You have {len(events)} thing{'s' if len(events) != 1 else ''} on the calendar; "
            f"the first is {first.get('summary', 'an event')} at {first.get('start', '')}."
        )
    else:
        lines.append("Your calendar is clear.")
    if unread_count or starred_count:
        lines.append(
            f"In the inbox: {unread_count} unread from the last day"
            + (f" and {starred_count} starred" if starred_count else "")
            + "."
        )
    if pending_count:
        lines.append(f"There are {pending_count} pending notifications queued.")
    net_alerts = payload.get("network_alerts") or []
    if net_alerts:
        high = [a for a in net_alerts if a.get("priority") == "high"]
        if high:
            names = ", ".join(a.get("name") or "" for a in high[:2])
            lines.append(
                f"On the relationship side: {len(high)} high-priority "
                f"alert{'s' if len(high) != 1 else ''} ({names})."
            )
        else:
            lines.append(
                f"On the relationship side: {len(net_alerts)} item"
                f"{'s' if len(net_alerts) != 1 else ''} to handle."
            )
    tg_groups = [g for g in ((payload.get("telegram") or {}).get("groups") or [])
                 if (g.get("message_count") or 0) > 0]
    if tg_groups:
        urgent_n = sum(1 for g in tg_groups if g.get("urgent"))
        urgent_phrase = f", {urgent_n} flagged urgent" if urgent_n else ""
        lines.append(
            f"In Telegram: {len(tg_groups)} group{'s' if len(tg_groups) != 1 else ''} "
            f"with activity{urgent_phrase}."
        )
    social_blocks = [b for b in ((payload.get("social") or {}).get("platforms") or [])
                     if (b.get("item_count") or 0) > 0]
    if social_blocks:
        urgent_n = sum(1 for b in social_blocks if b.get("urgent"))
        urgent_phrase = f", {urgent_n} flagged urgent" if urgent_n else ""
        names = ", ".join(b.get("name", "") for b in social_blocks)
        lines.append(f"On social ({names}): activity{urgent_phrase}.")
    weather = payload.get("weather") or {}
    if weather.get("now_temp_f"):
        lines.append(
            f"Outside it is {weather['now_temp_f']}°F, "
            f"high of {weather.get('today_max_f', '?')}."
        )
    lines.append("Will that be all, sir?")
    return " ".join(lines)


# ── Persistence + delivery ──────────────────────────────────────────
def _today_str() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d")


def _briefing_path(date: str | None = None) -> Path:
    return BRIEFINGS_DIR / f"{date or _today_str()}.md"


def _system_health_section() -> str:
    """Pull the 'System Health' markdown section from jarvis-reconcile when
    any capability has been flagged. Empty when everything is healthy so
    the briefing stays clean on quiet days."""
    src = BIN_DIR / "jarvis-reconcile.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-reconcile.py"
    if not src.exists():
        return ""
    try:
        spec = importlib.util.spec_from_file_location("jarvis_reconcile_brief", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod.briefing_section() or ""
    except Exception:
        return ""


def _network_alerts_section() -> str:
    """Markdown block from jarvis-network — empty when nothing actionable."""
    mod = _network()
    if mod is None:
        return ""
    try:
        return mod.relationship_alerts_section() or ""
    except Exception:
        return ""


def _format_markdown(payload: dict, briefing_text: str) -> str:
    """The .md file is the canonical record. Header has metadata, body is
    the spoken text, footer has the structured payload for debugging."""
    head = (
        f"# Morning Briefing — {payload['date']} ({payload['weekday']})\n\n"
        f"_Generated: {payload['generated_at']}_\n\n"
    )
    spoken = "## Spoken briefing\n\n" + briefing_text.strip() + "\n\n"
    health = _system_health_section()
    if health:
        spoken += health + "\n"
    net_section = _network_alerts_section()
    if net_section:
        spoken += net_section + "\n"
    raw = (
        "## Source data\n\n"
        "```json\n"
        + json.dumps({k: v for k, v in payload.items() if k != "_briefing_text"},
                     indent=2, default=str, ensure_ascii=False)
        + "\n```\n"
    )
    return head + spoken + raw


def _read_briefing_text(path: Path) -> str:
    """Pull just the spoken-briefing section out of the .md file."""
    if not path.exists():
        return ""
    try:
        body = path.read_text(encoding="utf-8")
    except Exception:
        return ""
    marker = "## Spoken briefing"
    end = "## Source data"
    if marker not in body:
        return body.strip()
    after = body.split(marker, 1)[1]
    if end in after:
        after = after.split(end, 1)[0]
    return after.strip()


def _gate_check() -> dict | None:
    if os.environ.get("JARVIS_BRIEFING", "1") != "1":
        return {"error": "briefing disabled (JARVIS_BRIEFING=0)"}
    return None


def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with BRIEFING_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def generate_today(force: bool = False) -> dict:
    """Build today's briefing. Idempotent: skips work if today's file
    already exists (unless force=True). Returns {ok, path, text} or
    {error}."""
    gate = _gate_check()
    if gate:
        return gate
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {"error": "ANTHROPIC_API_KEY not set"}

    BRIEFINGS_DIR.mkdir(parents=True, exist_ok=True)
    path = _briefing_path()
    if path.exists() and not force:
        return {"ok": True, "path": str(path), "text": _read_briefing_text(path), "skipped": True}

    now = datetime.now().astimezone()
    payload: dict = {
        "date": now.strftime("%Y-%m-%d"),
        "weekday": now.strftime("%A"),
        "generated_at": now.isoformat(timespec="seconds"),
    }
    _log(f"generating briefing for {payload['date']}")
    payload["calendar"] = _pull_calendar()
    payload["email"] = _pull_email()
    payload["telegram"] = _pull_telegram()
    payload["social"] = _pull_social()
    payload["pending_notifications"] = _pull_pending_notifications()
    payload["memory_recent"] = _pull_memory_recent()
    payload["network_alerts"] = _pull_network_alerts()
    payload["weather"] = _pull_weather()

    events = (payload["calendar"] or {}).get("events") or []
    if events and PER_MEETING_PREP:
        payload["meeting_preps"] = _maybe_per_meeting_prep(events)

    briefing_text = _synthesize(payload, api_key)
    payload["_briefing_text"] = briefing_text

    try:
        path.write_text(_format_markdown(payload, briefing_text), encoding="utf-8")
    except Exception as e:
        return {"error": f"write failed: {e}"}

    _log(f"wrote {path}")
    return {"ok": True, "path": str(path), "text": briefing_text}


def get_today() -> dict:
    """Read today's briefing. Returns {ok, text, path} or {error}."""
    gate = _gate_check()
    if gate:
        return gate
    path = _briefing_path()
    if not path.exists():
        return {"error": "no briefing for today (run generate_today first)"}
    return {"ok": True, "text": _read_briefing_text(path), "path": str(path)}


def _delivered_dates() -> set[str]:
    if not DELIVERED_FILE.exists():
        return set()
    try:
        return set(line.strip() for line in DELIVERED_FILE.read_text(encoding="utf-8").splitlines() if line.strip())
    except Exception:
        return set()


def is_delivered(date: str | None = None) -> bool:
    return (date or _today_str()) in _delivered_dates()


def should_deliver() -> bool:
    """True iff today's briefing exists AND hasn't been delivered yet AND
    the gate is on. Cheap — no Anthropic calls."""
    if os.environ.get("JARVIS_BRIEFING", "1") != "1":
        return False
    if is_delivered():
        return False
    return _briefing_path().exists()


def mark_delivered(date: str | None = None) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        d = date or _today_str()
        existing = _delivered_dates()
        if d in existing:
            return
        with DELIVERED_FILE.open("a", encoding="utf-8") as f:
            f.write(d + "\n")
    except Exception as e:
        _log(f"mark_delivered failed: {e}")


def deliver_now(force: bool = False) -> dict:
    """Speak today's briefing via jarvis-notify, then mark delivered.
    If today's file is missing, we generate it first. With force=False,
    a duplicate delivery on the same day is a no-op."""
    gate = _gate_check()
    if gate:
        return gate
    if not force and is_delivered():
        return {"ok": True, "skipped": True, "reason": "already delivered today"}

    rec = generate_today(force=False)
    if rec.get("error"):
        return rec
    text = rec.get("text") or ""
    if not text.strip():
        return {"error": "empty briefing"}

    notify_bin = BIN_DIR / "jarvis-notify"
    jbin = BIN_DIR / "jarvis"
    try:
        if notify_bin.exists():
            subprocess.Popen(
                [str(notify_bin), "--force", text],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        elif jbin.exists():
            subprocess.Popen(
                [str(jbin), "--speak", text],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        else:
            return {"error": "no jarvis CLI found to deliver"}
    except Exception as e:
        return {"error": f"deliver spawn failed: {e}"}

    mark_delivered()
    _log("delivered today's briefing")
    return {"ok": True, "delivered": True, "text": text}


def pending_briefing_hint() -> str:
    """One-line hint for jarvis-context.py to inject into the system prompt.
    Empty when nothing is pending — keeps the cache warm in the common case."""
    if not should_deliver():
        return ""
    rec = get_today()
    if rec.get("error"):
        return ""
    return (
        "**Briefing pending:** today's morning briefing is prepared but not yet "
        "delivered. If Watson opens with a greeting or asks how the day looks, "
        "lead with the briefing. After delivering, mark it complete by calling "
        "the get_briefing tool with `mark_delivered=true`."
    )


# ── CLI ─────────────────────────────────────────────────────────────
def _cli_status() -> int:
    today = _today_str()
    path = _briefing_path(today)
    exists = path.exists()
    delivered = is_delivered(today)
    print(f"date:       {today}")
    print(f"briefing:   {'present' if exists else 'missing'} ({path})")
    print(f"delivered:  {'yes' if delivered else 'no'}")
    print(f"should_deliver: {should_deliver()}")
    if exists:
        text = _read_briefing_text(path)
        print(f"\n--- text ({len(text)} chars) ---")
        print(text[:600] + ("..." if len(text) > 600 else ""))
    return 0


def _cli() -> int:
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        sys.stdout.write(__doc__ or "")
        return 0
    if args and args[0] == "--status":
        return _cli_status()
    if args and args[0] == "--show":
        rec = get_today()
        if rec.get("error"):
            print(rec["error"], file=sys.stderr)
            return 1
        print(rec["text"])
        return 0
    if args and args[0] == "--deliver":
        force = "--force" in args
        rec = deliver_now(force=force)
        print(json.dumps(rec, indent=2))
        return 0 if rec.get("ok") else 1
    force = bool(args and args[0] == "--force")
    rec = generate_today(force=force)
    print(json.dumps({k: v for k, v in rec.items() if k != "text"}, indent=2))
    return 0 if rec.get("ok") else 1


if __name__ == "__main__":
    sys.exit(_cli())
