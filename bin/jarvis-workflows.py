#!/usr/bin/env python3
"""Recurring workflows — turn one-shot orchestrator plans into automations.

Watson can say "every Monday at 8am, pull this week's revenue, check open
commitments, and draft a team status update", and the orchestrator's
plan + execute path will fire on that cadence forever after. Each
workflow is a goal string + a schedule; the existing orchestrator does
the planning and execution.

Workflow record (one per id, stored in ~/.jarvis/workflows/workflows.json):

    {
      "id":              "wf_a1b2c3d4",
      "name":            "Weekly metrics review",
      "schedule":        "0 8 * * 1",        # cron OR natural language
      "goal":            "Pull this week's revenue from Stripe...",
      "enabled":         true,
      "notify_on_complete": true,
      "created_at":      "2026-04-29T01:30:00Z",
      "next_run":        "2026-05-04T08:00:00-06:00",
      "last_run":        "2026-04-21T08:00:03-06:00",
      "last_status":     "success",
      "last_summary":    "...",
      "last_error":      null,
      "run_count":       4
    }

Public functions (all return JSON-serializable dicts):

    create_workflow(name, goal, schedule, notify_on_complete=True)
    list_workflows(status=None)        status: "all"|"enabled"|"disabled"|"failed"
    run_workflow(name_or_id)
    update_workflow(name_or_id, enabled=None, schedule=None, goal=None,
                    notify_on_complete=None)
    delete_workflow(name_or_id, confirm=True)
    run_due()                          fired by jarvis-improve via primitive.run_due
    briefing_section()                 morning briefing markdown block
    context_hint()                     one-liner for jarvis-context

CLI:
    bin/jarvis-workflows.py --list
    bin/jarvis-workflows.py --create  --name X --goal Y --schedule "0 8 * * 1"
    bin/jarvis-workflows.py --run NAME_OR_ID
    bin/jarvis-workflows.py --enable NAME_OR_ID
    bin/jarvis-workflows.py --disable NAME_OR_ID
    bin/jarvis-workflows.py --delete NAME_OR_ID --confirm
    bin/jarvis-workflows.py --tick                  # fire any due workflows
    bin/jarvis-workflows.py --status

Files:
    ~/.jarvis/workflows/workflows.json   one record per workflow
    ~/.jarvis/workflows/runs/<wf_id>/<ts>.json  per-run audit trail
    ~/.jarvis/logs/workflows.log         diagnostic log

Gate: JARVIS_WORKFLOWS=1 (default 1).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
BIN_DIR = ASSISTANT_DIR / "bin"
LIB_DIR = ASSISTANT_DIR / "lib"
WORKFLOWS_DIR = ASSISTANT_DIR / "workflows"
WORKFLOWS_FILE = WORKFLOWS_DIR / "workflows.json"
RUNS_DIR = WORKFLOWS_DIR / "runs"
LOG_DIR = ASSISTANT_DIR / "logs"
WORKFLOWS_LOG = LOG_DIR / "workflows.log"

MAX_GOAL_LEN = 1500
MAX_NAME_LEN = 80
RUN_TIMEOUT_S = float(os.environ.get("JARVIS_WORKFLOW_RUN_TIMEOUT_S", "120"))


# ── logging + gate ────────────────────────────────────────────────────
def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with WORKFLOWS_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def _gate_check() -> dict | None:
    if os.environ.get("JARVIS_WORKFLOWS", "1") != "1":
        return {"error": "workflows disabled (JARVIS_WORKFLOWS=0)"}
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


def _orchestrator():
    return _load_module("jarvis_orchestrate_wf", "jarvis-orchestrate.py", _BIN_SEARCH)


def _ledger():
    return _load_module("outcome_ledger_wf", "outcome_ledger.py", _LIB_SEARCH)


def _notifications():
    return _load_module("jarvis_notifications_wf", "jarvis-notifications.py", _BIN_SEARCH)


def _emit(action: str, status: str, **ctx) -> None:
    led = _ledger()
    if led is None:
        return
    try:
        led.emit(cap="workflows", action=action, status=status, context=ctx)
    except Exception:
        pass


# ── store I/O ─────────────────────────────────────────────────────────
def _read_workflows() -> dict:
    if not WORKFLOWS_FILE.exists():
        return {"workflows": []}
    try:
        data = json.loads(WORKFLOWS_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data.setdefault("workflows", [])
            return data
    except Exception as e:
        _log(f"workflows read failed: {e}")
    return {"workflows": []}


def _write_workflows(data: dict) -> None:
    try:
        WORKFLOWS_DIR.mkdir(parents=True, exist_ok=True)
        tmp = WORKFLOWS_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False),
                       encoding="utf-8")
        tmp.replace(WORKFLOWS_FILE)
    except Exception as e:
        _log(f"workflows write failed: {e}")


def _resolve(name_or_id: str, workflows: list[dict]) -> dict | None:
    s = (name_or_id or "").strip()
    if not s:
        return None
    # Exact id match wins, then exact name, then case-insensitive name.
    for w in workflows:
        if w.get("id") == s:
            return w
    for w in workflows:
        if w.get("name") == s:
            return w
    sl = s.lower()
    for w in workflows:
        if (w.get("name") or "").lower() == sl:
            return w
    # Substring fallback when there's exactly one hit.
    matches = [w for w in workflows if sl in (w.get("name") or "").lower()]
    return matches[0] if len(matches) == 1 else None


# ── schedule parsing ──────────────────────────────────────────────────
_DAY_MAP = {
    "mon": 1, "monday": 1, "tue": 2, "tues": 2, "tuesday": 2,
    "wed": 3, "wednesday": 3, "thu": 4, "thurs": 4, "thursday": 4,
    "fri": 5, "friday": 5, "sat": 6, "saturday": 6,
    "sun": 0, "sunday": 0,
}

_TIME_RE = re.compile(
    r"(?P<h>\d{1,2})(?::(?P<m>\d{2}))?\s*(?P<ampm>am|pm)?",
    re.IGNORECASE,
)


def _parse_time_token(s: str) -> tuple[int, int] | None:
    m = _TIME_RE.search(s or "")
    if not m:
        return None
    h = int(m.group("h"))
    minute = int(m.group("m") or 0)
    ampm = (m.group("ampm") or "").lower()
    if ampm == "pm" and h < 12:
        h += 12
    elif ampm == "am" and h == 12:
        h = 0
    if not (0 <= h <= 23 and 0 <= minute <= 59):
        return None
    return h, minute


def _natural_to_cron(text: str) -> str | None:
    """Best-effort 'every Monday at 8am' → '0 8 * * 1'. Returns None when
    we can't confidently parse — the caller should fall back to assuming
    the input is already a cron expression."""
    s = (text or "").strip().lower()
    if not s:
        return None

    # Time first — most patterns have one
    t = _parse_time_token(s)
    if t:
        h, minute = t
    else:
        h, minute = 9, 0  # sensible default for "every Monday"

    # Day-of-week match
    for token, idx in _DAY_MAP.items():
        if re.search(rf"\b{token}\b", s):
            return f"{minute} {h} * * {idx}"

    # First of the month
    if "first of" in s or "1st of" in s or "first day of" in s:
        return f"{minute} {h} 1 * *"

    # Daily
    if "daily" in s or re.search(r"\bevery day\b", s) or re.search(r"\beach day\b", s):
        return f"{minute} {h} * * *"

    # Hourly (no time-of-day required)
    if re.search(r"\bevery hour\b", s) or "hourly" in s:
        return "0 * * * *"

    # Weekly with no day named — assume Monday
    if re.search(r"\bevery week\b", s) or "weekly" in s:
        return f"{minute} {h} * * 1"

    # Monthly — assume first of the month
    if "monthly" in s or re.search(r"\bevery month\b", s):
        return f"{minute} {h} 1 * *"

    return None


def _looks_like_cron(s: str) -> bool:
    parts = (s or "").strip().split()
    return len(parts) == 5


def _normalize_schedule(schedule: str) -> tuple[str, str | None]:
    """Return (cron_expression, error_or_none). Accepts a 5-field cron
    string or natural-language phrase. We normalize natural language to
    cron so the rest of the system can rely on a single representation."""
    s = (schedule or "").strip()
    if not s:
        return "", "schedule is required"
    if _looks_like_cron(s):
        # Light validation: each field is digits, *, /, -, or , — we don't
        # try to enforce range bounds (cron itself is forgiving in many
        # implementations). Anything else is rejected.
        for p in s.split():
            if not re.match(r"^[\d,\-*/]+$", p):
                return "", f"invalid cron field: {p!r}"
        return s, None
    cron = _natural_to_cron(s)
    if not cron:
        return "", f"could not parse schedule: {schedule!r}"
    return cron, None


def _cron_field_match(field: str, value: int) -> bool:
    """Match one cron field (minute, hour, …) against a numeric value.
    Supports `*`, `*/N`, `a,b`, `a-b`, and bare digits. No special-name
    aliases like @daily — those should never appear here because our
    own normalizer always emits 5-field numeric form."""
    if field == "*":
        return True
    for piece in field.split(","):
        piece = piece.strip()
        if "/" in piece:
            base, step = piece.split("/", 1)
            try:
                step_n = int(step)
            except ValueError:
                continue
            if base in ("*", ""):
                if step_n > 0 and value % step_n == 0:
                    return True
                continue
            if "-" in base:
                lo, hi = base.split("-", 1)
                try:
                    lo_n, hi_n = int(lo), int(hi)
                except ValueError:
                    continue
                if lo_n <= value <= hi_n and (value - lo_n) % step_n == 0:
                    return True
                continue
            try:
                base_n = int(base)
            except ValueError:
                continue
            if value >= base_n and (value - base_n) % step_n == 0:
                return True
            continue
        if "-" in piece:
            lo, hi = piece.split("-", 1)
            try:
                lo_n, hi_n = int(lo), int(hi)
            except ValueError:
                continue
            if lo_n <= value <= hi_n:
                return True
            continue
        try:
            if int(piece) == value:
                return True
        except ValueError:
            continue
    return False


def _matches_cron(cron: str, when: datetime) -> bool:
    parts = cron.strip().split()
    if len(parts) != 5:
        return False
    minute, hour, dom, month, dow = parts
    # Cron's day-of-week: 0 or 7 = Sunday, 1=Monday … 6=Saturday.
    # Python's weekday(): 0=Monday … 6=Sunday. Convert.
    py_dow = when.weekday()
    cron_dow = (py_dow + 1) % 7  # Mon→1, Sun→0
    # Cron treats `7` as Sunday too, so accept either by collapsing.
    if not (_cron_field_match(dow, cron_dow)
            or (cron_dow == 0 and _cron_field_match(dow, 7))):
        return False
    return (
        _cron_field_match(minute, when.minute)
        and _cron_field_match(hour, when.hour)
        and _cron_field_match(dom, when.day)
        and _cron_field_match(month, when.month)
    )


def _next_run_after(cron: str, after: datetime,
                    horizon_hours: int = 24 * 14) -> datetime | None:
    """Walk forward minute-by-minute from `after` to find the next match.
    Capped at `horizon_hours` so an unsatisfiable expression doesn't loop
    forever. We zero seconds before stepping so subsequent ticks land on
    minute boundaries."""
    cur = after.replace(second=0, microsecond=0) + timedelta(minutes=1)
    end = cur + timedelta(hours=horizon_hours)
    while cur <= end:
        if _matches_cron(cron, cur):
            return cur
        cur += timedelta(minutes=1)
    return None


# ── PUBLIC: create_workflow ───────────────────────────────────────────
def create_workflow(name: str, goal: str, schedule: str,
                    notify_on_complete: bool = True) -> dict:
    gate = _gate_check()
    if gate:
        return gate
    name = (name or "").strip()
    goal = (goal or "").strip()
    if not name:
        return {"error": "name is required"}
    if not goal:
        return {"error": "goal is required"}
    if len(name) > MAX_NAME_LEN:
        return {"error": f"name too long (>{MAX_NAME_LEN})"}
    if len(goal) > MAX_GOAL_LEN:
        return {"error": f"goal too long (>{MAX_GOAL_LEN})"}
    cron, err = _normalize_schedule(schedule)
    if err:
        return {"error": err}

    data = _read_workflows()
    if any(w.get("name") == name for w in data["workflows"]):
        return {"error": f"workflow named {name!r} already exists"}

    now = datetime.now(tz=timezone.utc)
    next_run = _next_run_after(cron, now)
    record = {
        "id": "wf_" + uuid.uuid4().hex[:10],
        "name": name,
        "schedule": cron,
        "schedule_input": schedule.strip(),
        "goal": goal,
        "enabled": True,
        "notify_on_complete": bool(notify_on_complete),
        "created_at": now.isoformat(timespec="seconds"),
        "next_run": next_run.astimezone().isoformat(timespec="seconds")
            if next_run else None,
        "last_run": None,
        "last_status": None,
        "last_summary": None,
        "last_error": None,
        "run_count": 0,
    }
    data["workflows"].append(record)
    _write_workflows(data)
    _emit("create", "success", id=record["id"], name=name, schedule=cron)
    _log(f"created workflow {record['id']} {name!r} schedule={cron}")
    return {"ok": True, "workflow": record}


# ── PUBLIC: list_workflows ────────────────────────────────────────────
def list_workflows(status: str | None = None) -> dict:
    gate = _gate_check()
    if gate:
        return gate
    data = _read_workflows()
    items = data.get("workflows") or []
    f = (status or "all").strip().lower()
    if f == "enabled":
        items = [w for w in items if w.get("enabled")]
    elif f == "disabled":
        items = [w for w in items if not w.get("enabled")]
    elif f == "failed":
        items = [w for w in items if w.get("last_status") == "failed"]
    elif f == "succeeded":
        items = [w for w in items if w.get("last_status") == "success"]
    elif f != "all":
        return {"error": f"unknown status filter: {status!r}"}
    return {
        "ok": True,
        "filter": f,
        "count": len(items),
        "workflows": items,
    }


# ── PUBLIC: run_workflow ──────────────────────────────────────────────
def _execute_goal(goal: str) -> dict:
    """Hand the goal to the orchestrator. Falls back to a structured
    error when the orchestrator is unavailable."""
    orch = _orchestrator()
    if orch is None:
        return {"ok": False, "summary": "",
                "errors": ["jarvis-orchestrate not installed"]}
    try:
        return orch.execute_plan(goal)
    except Exception as e:
        return {"ok": False, "summary": "", "errors": [f"orchestrator crashed: {e}"]}


def _record_run(record: dict, run: dict) -> Path | None:
    try:
        wf_dir = RUNS_DIR / record["id"]
        wf_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = wf_dir / f"{ts}.json"
        payload = {
            "ts": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
            "workflow_id": record["id"],
            "workflow_name": record.get("name"),
            "goal": record.get("goal"),
            "ok": run.get("ok", False),
            "summary": run.get("summary", ""),
            "errors": run.get("errors") or [],
            "tasks": run.get("tasks") or [],
            "rationale": run.get("rationale", ""),
            "run_path": run.get("run_path"),
        }
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False),
                        encoding="utf-8")
        return path
    except Exception as e:
        _log(f"record_run failed: {e}")
        return None


def _notify_complete(record: dict, run: dict) -> None:
    if not record.get("notify_on_complete"):
        return
    nm = _notifications()
    if nm is None:
        return
    name = record.get("name") or record.get("id")
    if run.get("ok"):
        summary = (run.get("summary") or "").strip()
        content = (
            f"Workflow '{name}' completed. "
            + (summary[:280] if summary else "Run finished without errors.")
        )
        kw, ts = ["fyi"], 0
    else:
        errs = "; ".join(run.get("errors") or [])
        content = f"Workflow '{name}' failed: {errs[:240] or 'unknown error'}"
        kw, ts = ["heads up"], 1
    try:
        nm.enqueue(source="workflows", content=content,
                   sender=None, urgency_keywords=kw, time_sensitivity=ts)
    except Exception as e:
        _log(f"notify enqueue failed: {e}")


def run_workflow(name_or_id: str) -> dict:
    """Manually run a workflow now. Updates last_run + last_status, but
    does NOT bump next_run — that stays on the cron cadence."""
    gate = _gate_check()
    if gate:
        return gate
    data = _read_workflows()
    record = _resolve(name_or_id, data["workflows"])
    if not record:
        return {"error": f"no workflow matches {name_or_id!r}"}

    started = time.monotonic()
    run = _execute_goal(record["goal"])
    elapsed = int((time.monotonic() - started) * 1000)
    run_path = _record_run(record, run)

    record["last_run"] = datetime.now(tz=timezone.utc).isoformat(timespec="seconds")
    record["last_status"] = "success" if run.get("ok") else "failed"
    record["last_summary"] = (run.get("summary") or "")[:500]
    record["last_error"] = "; ".join(run.get("errors") or [])[:500] or None
    record["run_count"] = int(record.get("run_count") or 0) + 1
    _write_workflows(data)
    _emit("run", record["last_status"], id=record["id"], latency_ms=elapsed)
    _notify_complete(record, run)
    return {
        "ok": True,
        "workflow_id": record["id"],
        "name": record.get("name"),
        "result": {
            "ok": run.get("ok"),
            "summary": run.get("summary"),
            "errors": run.get("errors") or [],
        },
        "run_path": str(run_path) if run_path else None,
    }


# ── PUBLIC: update_workflow ───────────────────────────────────────────
def update_workflow(name_or_id: str, enabled: bool | None = None,
                    schedule: str | None = None, goal: str | None = None,
                    notify_on_complete: bool | None = None) -> dict:
    gate = _gate_check()
    if gate:
        return gate
    data = _read_workflows()
    record = _resolve(name_or_id, data["workflows"])
    if not record:
        return {"error": f"no workflow matches {name_or_id!r}"}
    if enabled is not None:
        record["enabled"] = bool(enabled)
    if schedule is not None:
        cron, err = _normalize_schedule(schedule)
        if err:
            return {"error": err}
        record["schedule"] = cron
        record["schedule_input"] = schedule.strip()
        nxt = _next_run_after(cron, datetime.now(tz=timezone.utc))
        record["next_run"] = nxt.astimezone().isoformat(timespec="seconds") if nxt else None
    if goal is not None:
        g = goal.strip()
        if not g:
            return {"error": "goal cannot be empty"}
        if len(g) > MAX_GOAL_LEN:
            return {"error": f"goal too long (>{MAX_GOAL_LEN})"}
        record["goal"] = g
    if notify_on_complete is not None:
        record["notify_on_complete"] = bool(notify_on_complete)
    record["updated_at"] = datetime.now(tz=timezone.utc).isoformat(timespec="seconds")
    _write_workflows(data)
    _emit("update", "success", id=record["id"])
    return {"ok": True, "workflow": record}


# ── PUBLIC: delete_workflow ───────────────────────────────────────────
def delete_workflow(name_or_id: str, confirm: bool = True) -> dict:
    gate = _gate_check()
    if gate:
        return gate
    data = _read_workflows()
    record = _resolve(name_or_id, data["workflows"])
    if not record:
        return {"error": f"no workflow matches {name_or_id!r}"}
    if not confirm:
        return {
            "ok": False,
            "needs_confirmation": True,
            "would_delete": {
                "id": record["id"],
                "name": record.get("name"),
                "schedule": record.get("schedule"),
            },
            "hint": "Re-call with confirm=true after Watson says yes.",
        }
    data["workflows"] = [w for w in data["workflows"]
                         if w.get("id") != record.get("id")]
    _write_workflows(data)
    _emit("delete", "success", id=record["id"], name=record.get("name"))
    _log(f"deleted workflow {record['id']} {record.get('name')!r}")
    return {"ok": True, "deleted": record["id"]}


# ── PUBLIC: run_due ───────────────────────────────────────────────────
_DUE_GRACE_S = 60  # fire any workflow whose next_run was at most this many s ago


def run_due() -> dict:
    """Fire every enabled workflow whose next_run has passed. Called by
    jarvis-improve on each pass. Updates next_run after each fire so the
    next pass doesn't double-trigger. No-op when nothing is due."""
    gate = _gate_check()
    if gate:
        return gate
    now = datetime.now(tz=timezone.utc)
    data = _read_workflows()
    fired: list[dict] = []
    for record in data.get("workflows") or []:
        if not record.get("enabled"):
            continue
        nxt_iso = record.get("next_run")
        cron = record.get("schedule")
        if not cron:
            continue
        # If next_run is missing or stale, recompute it
        if not nxt_iso:
            nxt = _next_run_after(cron, now)
            record["next_run"] = nxt.astimezone().isoformat(timespec="seconds") if nxt else None
            continue
        try:
            nxt_dt = datetime.fromisoformat(nxt_iso.replace("Z", "+00:00"))
        except Exception:
            continue
        if not nxt_dt.tzinfo:
            nxt_dt = nxt_dt.replace(tzinfo=timezone.utc)
        if nxt_dt > now + timedelta(seconds=_DUE_GRACE_S):
            continue
        # Fire
        started = time.monotonic()
        run = _execute_goal(record["goal"])
        elapsed = int((time.monotonic() - started) * 1000)
        _record_run(record, run)
        record["last_run"] = now.isoformat(timespec="seconds")
        record["last_status"] = "success" if run.get("ok") else "failed"
        record["last_summary"] = (run.get("summary") or "")[:500]
        record["last_error"] = "; ".join(run.get("errors") or [])[:500] or None
        record["run_count"] = int(record.get("run_count") or 0) + 1
        # Compute the next firing AFTER the just-fired time so we don't
        # re-fire the same minute on the next tick.
        next_fire = _next_run_after(cron, nxt_dt)
        record["next_run"] = next_fire.astimezone().isoformat(timespec="seconds") \
            if next_fire else None
        _emit("run_due", record["last_status"], id=record["id"], latency_ms=elapsed)
        _notify_complete(record, run)
        fired.append({
            "id": record["id"], "name": record.get("name"),
            "ok": run.get("ok"), "errors": run.get("errors") or [],
        })
    if fired:
        _write_workflows(data)
    return {"ok": True, "fired": fired, "count": len(fired)}


# ── briefing + context surface ────────────────────────────────────────
def briefing_section() -> str:
    """Markdown block for the morning briefing.
    Lists what fired overnight + what's due today + any failures."""
    if _gate_check():
        return ""
    data = _read_workflows()
    workflows = data.get("workflows") or []
    if not workflows:
        return ""
    now = datetime.now(tz=timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_end = today_start + timedelta(days=1)

    ran_overnight: list[dict] = []
    failed_recent: list[dict] = []
    due_today: list[dict] = []
    for w in workflows:
        last_iso = w.get("last_run")
        if last_iso:
            try:
                last_dt = datetime.fromisoformat(last_iso.replace("Z", "+00:00"))
                if not last_dt.tzinfo:
                    last_dt = last_dt.replace(tzinfo=timezone.utc)
                if last_dt >= today_start - timedelta(hours=12):
                    if w.get("last_status") == "failed":
                        failed_recent.append(w)
                    else:
                        ran_overnight.append(w)
            except Exception:
                pass
        nxt_iso = w.get("next_run")
        if nxt_iso and w.get("enabled"):
            try:
                nxt_dt = datetime.fromisoformat(nxt_iso.replace("Z", "+00:00"))
                if not nxt_dt.tzinfo:
                    nxt_dt = nxt_dt.replace(tzinfo=timezone.utc)
                if today_start <= nxt_dt < today_end:
                    due_today.append(w)
            except Exception:
                pass

    if not (ran_overnight or failed_recent or due_today):
        return ""
    lines = ["## Scheduled Workflows"]
    if ran_overnight:
        lines.append(f"- **Ran overnight ({len(ran_overnight)}):** "
                     + ", ".join(w.get("name") for w in ran_overnight[:6]))
    if failed_recent:
        lines.append(f"- **Failed recently ({len(failed_recent)}):** "
                     + ", ".join(w.get("name") for w in failed_recent[:6]))
    if due_today:
        upcoming = []
        for w in sorted(due_today, key=lambda x: x.get("next_run") or ""):
            try:
                dt = datetime.fromisoformat(
                    str(w["next_run"]).replace("Z", "+00:00")
                )
                upcoming.append(f"{w.get('name')} @ {dt.astimezone().strftime('%-I:%M%p').lower()}")
            except Exception:
                upcoming.append(w.get("name") or "?")
        lines.append(f"- **Due today ({len(due_today)}):** " + ", ".join(upcoming[:6]))
    return "\n".join(lines) + "\n"


def context_hint() -> str:
    """One-line hint for jarvis-context — empty when everything's
    healthy. Surfaces only when a workflow has failed recently."""
    if _gate_check():
        return ""
    data = _read_workflows()
    failed = [w for w in (data.get("workflows") or [])
              if w.get("last_status") == "failed"]
    if not failed:
        return ""
    names = ", ".join(w.get("name") or "(unnamed)" for w in failed[:3])
    return (
        f"**Workflow failures:** {len(failed)} scheduled workflow"
        f"{'s' if len(failed) != 1 else ''} failed on its last run "
        f"({names}). Surface this if Watson asks 'what's broken' / "
        f"'anything failing'."
    )


# ── status (CLI helper) ──────────────────────────────────────────────
def status() -> dict:
    gate = _gate_check()
    if gate:
        return gate
    data = _read_workflows()
    workflows = data.get("workflows") or []
    enabled = [w for w in workflows if w.get("enabled")]
    failed = [w for w in workflows if w.get("last_status") == "failed"]
    return {
        "ok": True,
        "total": len(workflows),
        "enabled": len(enabled),
        "disabled": len(workflows) - len(enabled),
        "failed_last_run": len(failed),
        "workflows": [
            {
                "id": w.get("id"),
                "name": w.get("name"),
                "schedule": w.get("schedule"),
                "enabled": w.get("enabled"),
                "next_run": w.get("next_run"),
                "last_run": w.get("last_run"),
                "last_status": w.get("last_status"),
                "run_count": w.get("run_count"),
            } for w in workflows
        ],
    }


# ── CLI ───────────────────────────────────────────────────────────────
def _cli() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--tick", action="store_true",
                        help="Fire any workflows whose next_run has passed.")
    parser.add_argument("--create", action="store_true")
    parser.add_argument("--name", help="Workflow name (for --create / --update / --run / --delete).")
    parser.add_argument("--goal", help="Goal text (for --create / --update).")
    parser.add_argument("--schedule",
                        help="Cron string OR natural language phrase.")
    parser.add_argument("--no-notify", action="store_true")
    parser.add_argument("--run", help="Manually run a workflow by name or id.")
    parser.add_argument("--enable", help="Enable a workflow by name or id.")
    parser.add_argument("--disable", help="Disable a workflow by name or id.")
    parser.add_argument("--update-goal", help="New goal for --update.")
    parser.add_argument("--update-schedule",
                        help="New schedule for --update.")
    parser.add_argument("--delete", help="Delete a workflow by name or id.")
    parser.add_argument("--confirm", action="store_true",
                        help="Required for --delete.")
    parser.add_argument("--filter", default=None,
                        help="Filter for --list: all|enabled|disabled|failed.")
    args = parser.parse_args()

    if args.status:
        out = status()
    elif args.list:
        out = list_workflows(status=args.filter)
    elif args.tick:
        out = run_due()
    elif args.create:
        out = create_workflow(
            name=args.name or "",
            goal=args.goal or "",
            schedule=args.schedule or "",
            notify_on_complete=not args.no_notify,
        )
    elif args.run:
        out = run_workflow(args.run)
    elif args.enable:
        out = update_workflow(args.enable, enabled=True)
    elif args.disable:
        out = update_workflow(args.disable, enabled=False)
    elif args.update_goal or args.update_schedule:
        if not args.name:
            return _err("--name required for update")
        out = update_workflow(args.name, goal=args.update_goal,
                              schedule=args.update_schedule)
    elif args.delete:
        out = delete_workflow(args.delete, confirm=args.confirm)
    else:
        parser.print_help()
        return 0
    print(json.dumps(out, indent=2, ensure_ascii=False, default=str))
    return 0 if (isinstance(out, dict) and not out.get("error")) else 1


def _err(msg: str) -> int:
    sys.stderr.write(msg + "\n")
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
