#!/usr/bin/env python3
"""LinkedIn intelligence — enrich Watson's contacts and monitor changes.

Watson's professional graph lives in `~/.jarvis/contacts/people.json` (the
contact record) and `~/.jarvis/state/network-alerts.json` (network signal
overlay). This module adds a third layer: LinkedIn profile data, scraped
through the Voyager session-cookie API and snapshotted over time so role
moves, headline changes, and skill additions become first-class events.

Two-tier priority by design:

  * In contacts AND a LinkedIn connection  → full monitoring, alerts,
    briefing inclusion, contact-record merge.
  * LinkedIn-only (a connection but never met by another channel)
    → stored and searchable, but NEVER surfaces in alerts, briefings,
    notifications, or the morning context. Only appears when Watson
    explicitly searches.

Public functions (all return JSON-serializable dicts):

    linkedin_enrich(name_or_url, force=False)
        Fetch one profile and merge into the matching contact (full),
        or store as linkedin_only when no contact matches.

    linkedin_sync(limit=None)
        Walk Watson's connection list. Enrich every connection that
        matches a contact; store skeletons for the rest. Capped per run
        and stateful (~/.jarvis/linkedin/sync_state.json) so weekly
        re-runs cover the whole graph in slices.

    linkedin_monitor()
        Re-scrape recently-due profiles (contacts every 7d, linkedin_only
        every 30d) and detect changes against snapshot_history. Emits
        change records to ~/.jarvis/linkedin/changes.jsonl. Contacts get
        full diffing; linkedin_only profiles only diff role + headline.

    linkedin_changes(days=7, contacts_only=True)
        Read the change log, filter by recency and tier, group by type.

    linkedin_search(query)
        Local search across cached profiles — current company, skills,
        title, location. Contact matches outrank linkedin_only.

Files:
    ~/.jarvis/linkedin/profiles/{linkedin_id}.json   one cache file each
    ~/.jarvis/linkedin/sync_state.json               connection sweep cursor
    ~/.jarvis/linkedin/changes.jsonl                 change ledger
    ~/.jarvis/logs/linkedin.log                      diagnostic log

Gate: JARVIS_LINKEDIN=1 (default 1 iff LINKEDIN_COOKIE is set).

Stdlib only — same posture as jarvis-social.py's existing LinkedIn
support. The Voyager API is unofficial; we keep every parser tolerant
and degrade silently on shape changes.
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
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
BIN_DIR = ASSISTANT_DIR / "bin"
LIB_DIR = ASSISTANT_DIR / "lib"
LINKEDIN_DIR = ASSISTANT_DIR / "linkedin"
PROFILES_DIR = LINKEDIN_DIR / "profiles"
SYNC_STATE_FILE = LINKEDIN_DIR / "sync_state.json"
CHANGES_FILE = LINKEDIN_DIR / "changes.jsonl"
LOG_DIR = ASSISTANT_DIR / "logs"
LINKEDIN_LOG = LOG_DIR / "linkedin.log"

# Re-scrape cadence — contacts get fresh data weekly, linkedin_only monthly.
CONTACT_RESCRAPE_S = int(os.environ.get(
    "JARVIS_LINKEDIN_CONTACT_REFRESH_S", str(7 * 86400)))
LINKEDIN_ONLY_RESCRAPE_S = int(os.environ.get(
    "JARVIS_LINKEDIN_ONLY_REFRESH_S", str(30 * 86400)))

# Per-run caps (rate-limit safety). Values measured against Voyager's
# rough tolerance with a personal cookie — far below "alert the security
# system" territory.
SYNC_CAP_PER_RUN = int(os.environ.get("JARVIS_LINKEDIN_SYNC_CAP", "50"))
MONITOR_CAP_PER_RUN = int(os.environ.get("JARVIS_LINKEDIN_MONITOR_CAP", "30"))
REQUEST_DELAY_S = float(os.environ.get("JARVIS_LINKEDIN_DELAY_S", "2.0"))
HOURLY_CALL_CEILING = int(os.environ.get("JARVIS_LINKEDIN_HOURLY_MAX", "50"))

HTTP_TIMEOUT_S = float(os.environ.get("JARVIS_LINKEDIN_HTTP_TIMEOUT_S", "12"))
VOYAGER_ROOT = "https://www.linkedin.com/voyager/api"
PUBLIC_ROOT = "https://www.linkedin.com"


# ── logging + gate ────────────────────────────────────────────────────
def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with LINKEDIN_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def _gate_default() -> str:
    return "1" if os.environ.get("LINKEDIN_COOKIE") else "0"


def _gate_check() -> dict | None:
    if os.environ.get("JARVIS_LINKEDIN", _gate_default()) != "1":
        return {"error": "linkedin disabled (JARVIS_LINKEDIN=0 or no LINKEDIN_COOKIE)"}
    if not os.environ.get("LINKEDIN_COOKIE"):
        return {"error": "LINKEDIN_COOKIE not set — paste your li_at session cookie"}
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


def _contacts():
    if "contacts" not in _cache:
        _cache["contacts"] = _load_module(
            "jarvis_contacts_for_linkedin", "jarvis-contacts.py", _BIN_SEARCH)
    return _cache["contacts"]


def _primitive():
    if "primitive" not in _cache:
        _cache["primitive"] = _load_module("primitive", "primitive.py", _LIB_SEARCH)
    return _cache["primitive"]


def _notifications():
    if "notifications" not in _cache:
        _cache["notifications"] = _load_module(
            "jarvis_notifications_for_linkedin",
            "jarvis-notifications.py", _BIN_SEARCH)
    return _cache["notifications"]


def _emit(action: str, status: str, **ctx) -> None:
    p = _primitive()
    if p is None:
        return
    try:
        p.emit(cap="network", action=action, status=status, context=ctx)
    except Exception:
        pass


# ── name canonicalization (mirrors jarvis-contacts) ───────────────────
_PUNCT_RE = re.compile(r"[^a-z0-9]+")


def _canonical(name: str) -> str:
    if not name:
        return ""
    norm = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    norm = _PUNCT_RE.sub(" ", norm.lower()).strip()
    return " ".join(norm.split())


# ── HTTP ──────────────────────────────────────────────────────────────
def _voyager_headers(cookie: str) -> dict:
    return {
        "Cookie": f"li_at={cookie}",
        "Csrf-Token": "ajax:0",
        "X-Restli-Protocol-Version": "2.0.0",
        "X-Li-Lang": "en_US",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/121.0 Safari/537.36",
    }


def _http_get(url: str, headers: dict | None = None,
              timeout: float | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers=headers or {})
    eff = timeout if timeout is not None else HTTP_TIMEOUT_S
    try:
        with urllib.request.urlopen(req, timeout=eff) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        try:
            body = e.read()
        except Exception:
            body = b""
        return e.code, body
    except (urllib.error.URLError, TimeoutError) as e:
        _log(f"http error: {url} -> {e}")
        return -1, b""
    except Exception as e:
        _log(f"http unexpected: {url} -> {e}")
        return -1, b""


# ── hourly rate-limit ledger ──────────────────────────────────────────
def _hourly_ceiling_check(state: dict) -> bool:
    """True iff we've already hit the hourly call ceiling. Updates the
    rolling hour window in `state` so callers don't have to."""
    hour = state.setdefault("hour_window", {})
    now = time.time()
    start = hour.get("start") or 0
    if now - start > 3600:
        hour["start"] = now
        hour["count"] = 0
    return int(hour.get("count") or 0) >= HOURLY_CALL_CEILING


def _hourly_ceiling_bump(state: dict) -> None:
    hour = state.setdefault("hour_window", {})
    hour["count"] = int(hour.get("count") or 0) + 1


# ── URL / vanity helpers ──────────────────────────────────────────────
_VANITY_RE = re.compile(r"linkedin\.com/in/([^/?#]+)", re.I)


def _vanity_from_url(url: str) -> str | None:
    if not url:
        return None
    m = _VANITY_RE.search(url)
    if m:
        return m.group(1).strip("/")
    return None


def _profile_url(linkedin_id: str) -> str:
    return f"{PUBLIC_ROOT}/in/{linkedin_id}"


# ── profile cache I/O ─────────────────────────────────────────────────
def _profile_path(linkedin_id: str) -> Path:
    safe = re.sub(r"[^a-zA-Z0-9._\-]", "_", linkedin_id)
    return PROFILES_DIR / f"{safe}.json"


def _load_profile(linkedin_id: str) -> dict | None:
    path = _profile_path(linkedin_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _save_profile(profile: dict) -> None:
    PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    lid = profile.get("linkedin_id")
    if not lid:
        return
    path = _profile_path(lid)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(profile, indent=2, ensure_ascii=False),
                   encoding="utf-8")
    os.replace(tmp, path)


def _all_profiles() -> Iterable[dict]:
    if not PROFILES_DIR.exists():
        return []
    out: list[dict] = []
    for p in PROFILES_DIR.glob("*.json"):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except Exception:
            continue
    return out


# ── sync-state I/O ────────────────────────────────────────────────────
def _load_sync_state() -> dict:
    if not SYNC_STATE_FILE.exists():
        return {}
    try:
        return json.loads(SYNC_STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_sync_state(state: dict) -> None:
    LINKEDIN_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SYNC_STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False),
                   encoding="utf-8")
    os.replace(tmp, SYNC_STATE_FILE)


# ── change ledger ─────────────────────────────────────────────────────
def _append_change(rec: dict) -> None:
    LINKEDIN_DIR.mkdir(parents=True, exist_ok=True)
    try:
        with CHANGES_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception as e:
        _log(f"change append failed: {e}")


def _read_changes(since_ts: float | None = None) -> list[dict]:
    if not CHANGES_FILE.exists():
        return []
    out: list[dict] = []
    try:
        with CHANGES_FILE.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if since_ts is not None:
                    try:
                        rts = datetime.fromisoformat(rec.get("ts") or "").timestamp()
                    except Exception:
                        rts = 0
                    if rts < since_ts:
                        continue
                out.append(rec)
    except Exception as e:
        _log(f"changes read failed: {e}")
    return out


# ── Voyager API: fetch profile ────────────────────────────────────────
def _fetch_profile(linkedin_id: str, cookie: str) -> dict | None:
    """Pull one profile via the vanity profileView. Tolerant of shape
    changes — every field is a best-effort dig. Returns None on auth /
    transport failure so the caller treats it as a skip."""
    url = f"{VOYAGER_ROOT}/identity/profiles/{urllib.parse.quote(linkedin_id)}/profileView"
    status, body = _http_get(url, headers=_voyager_headers(cookie))
    if status in (401, 403):
        _log(f"linkedin auth failed status={status} (cookie may be expired)")
        return None
    if status != 200 or not body:
        _log(f"profileView failed status={status} id={linkedin_id}")
        return None
    try:
        data = json.loads(body)
    except Exception:
        return None
    return data


def _fetch_skills(linkedin_id: str, cookie: str) -> list[str]:
    """Optional second call — Voyager exposes endorsed skills separately
    from profileView. Cheap and skips silently on any failure."""
    url = (f"{VOYAGER_ROOT}/identity/profiles/"
           f"{urllib.parse.quote(linkedin_id)}/skillCategory")
    status, body = _http_get(url, headers=_voyager_headers(cookie))
    if status != 200 or not body:
        return []
    try:
        data = json.loads(body)
    except Exception:
        return []
    out: list[str] = []
    for el in (data.get("elements") or data.get("included") or []):
        if not isinstance(el, dict):
            continue
        nm = el.get("name") or (el.get("skill") or {}).get("name")
        if isinstance(nm, str) and nm.strip():
            out.append(nm.strip())
    # Dedupe preserve-order
    seen: set[str] = set()
    deduped: list[str] = []
    for s in out:
        k = s.lower()
        if k not in seen:
            seen.add(k)
            deduped.append(s)
    return deduped[:30]


def _fetch_connections(cookie: str, start: int = 0,
                       count: int = 40) -> tuple[list[dict], int]:
    """Pull a page of connections. Returns (records, total_estimate).
    `start`/`count` paginate; total comes from paging metadata when
    Voyager provides it, else 0 (caller treats as unknown)."""
    url = (f"{VOYAGER_ROOT}/relationships/connectionsV2"
           f"?count={count}&start={start}&sortType=RECENTLY_ADDED")
    status, body = _http_get(url, headers=_voyager_headers(cookie))
    if status in (401, 403):
        _log(f"connections auth failed status={status}")
        return [], 0
    if status != 200 or not body:
        _log(f"connections failed status={status} start={start}")
        return [], 0
    try:
        data = json.loads(body)
    except Exception:
        return [], 0
    elements = data.get("elements") or []
    paging = data.get("paging") or {}
    total = int(paging.get("total") or 0)
    out: list[dict] = []
    for el in elements:
        if not isinstance(el, dict):
            continue
        # Each connection wraps a miniProfile-shaped person.
        mp = el.get("miniProfile") or el.get("connectedMember") or el
        public_id = mp.get("publicIdentifier") or mp.get("publicId")
        if not public_id:
            # Skip anonymized / unparseable entries
            continue
        first = mp.get("firstName") or ""
        last = mp.get("lastName") or ""
        name = (f"{first} {last}").strip() or mp.get("name") or public_id
        out.append({
            "linkedin_id": public_id,
            "name": name,
            "headline": mp.get("occupation") or mp.get("headline") or "",
            "connected_at": el.get("createdAt") or el.get("connectedAt") or 0,
        })
    return out, total


# ── parse profileView into our schema ─────────────────────────────────
def _txt(d: Any) -> str:
    """Extract text from a Voyager mixed-text node ({text:..} or string)."""
    if isinstance(d, dict):
        return (d.get("text") or "").strip()
    if isinstance(d, str):
        return d.strip()
    return ""


def _ymd_from_voyager(node: dict | None) -> str:
    """Voyager dates are {year, month?, day?}. Turn them into 'YYYY-MM' /
    'YYYY' as appropriate. Empty when unparseable."""
    if not isinstance(node, dict):
        return ""
    y = node.get("year")
    m = node.get("month")
    if not y:
        return ""
    if m:
        return f"{int(y):04d}-{int(m):02d}"
    return f"{int(y):04d}"


def _parse_profile_view(view: dict, linkedin_id: str) -> dict:
    """Best-effort projection of /profileView → our profile schema."""
    pp = view.get("profile") or view.get("included", [{}])[0] or {}
    if not isinstance(pp, dict):
        pp = {}
    first = pp.get("firstName") or ""
    last = pp.get("lastName") or ""
    name = (f"{first} {last}").strip() or _txt(pp.get("miniProfile", {}).get("publicIdentifier")) or linkedin_id

    headline = pp.get("headline") or _txt(pp.get("occupation")) or ""
    location = (pp.get("locationName") or
                _txt((pp.get("location") or {}).get("basicLocation")) or "")
    industry = pp.get("industryName") or pp.get("industry") or ""

    positions_root = view.get("positionView") or {}
    positions = positions_root.get("elements") or []
    parsed_positions: list[dict] = []
    for p in positions:
        if not isinstance(p, dict):
            continue
        company = (p.get("companyName") or _txt(p.get("company")) or "").strip()
        title = (p.get("title") or "").strip()
        time_period = p.get("timePeriod") or {}
        start = _ymd_from_voyager(time_period.get("startDate"))
        end = _ymd_from_voyager(time_period.get("endDate"))
        parsed_positions.append({
            "title": title,
            "company": company,
            "start_date": start,
            "end_date": end,
            "description": (p.get("description") or "")[:300],
        })
    # First entry without an end date is the current role.
    current = next((p for p in parsed_positions if not p.get("end_date")), None)
    previous = [p for p in parsed_positions if p is not current][:8]

    edu_root = view.get("educationView") or {}
    educations = edu_root.get("elements") or []
    parsed_edu: list[dict] = []
    for e in educations:
        if not isinstance(e, dict):
            continue
        school = (e.get("schoolName") or _txt(e.get("school")) or "").strip()
        degree = (e.get("degreeName") or "").strip()
        field = (e.get("fieldOfStudy") or "").strip()
        if school or degree or field:
            parsed_edu.append({
                "school": school, "degree": degree, "field": field,
            })

    return {
        "linkedin_id": linkedin_id,
        "name": name,
        "headline": headline,
        "current_role": (
            {"title": current.get("title", ""),
             "company": current.get("company", ""),
             "start_date": current.get("start_date", "")}
            if current else None
        ),
        "previous_roles": [
            {"title": p.get("title", ""), "company": p.get("company", ""),
             "start_date": p.get("start_date", ""), "end_date": p.get("end_date", "")}
            for p in previous
        ],
        "location": location,
        "industry": industry,
        "education": parsed_edu[:6],
        "profile_url": _profile_url(linkedin_id),
    }


# ── snapshot + change detection ───────────────────────────────────────
def _snapshot_for(profile: dict) -> dict:
    """Compact daily snapshot — what we diff over time."""
    cur = profile.get("current_role") or {}
    role_str = f"{cur.get('title') or ''} at {cur.get('company') or ''}".strip(" at")
    return {
        "date": datetime.now().astimezone().date().isoformat(),
        "headline": profile.get("headline") or "",
        "role": role_str,
        "company": cur.get("company") or "",
        "title": cur.get("title") or "",
        "location": profile.get("location") or "",
        "skills_count": len(profile.get("skills_endorsed") or []),
    }


def _detect_changes(prev: dict | None, snap: dict, profile: dict,
                    in_contacts: bool) -> list[dict]:
    """Compare the most recent snapshot to the new one. linkedin_only
    profiles only diff role + headline (the cheap fields); contacts get
    the full sweep."""
    if not prev:
        return []
    changes: list[dict] = []
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    name = profile.get("name") or profile.get("linkedin_id") or "?"
    if (prev.get("role") or "") != (snap.get("role") or "") and snap.get("role"):
        changes.append({
            "ts": now_iso, "name": name,
            "linkedin_id": profile.get("linkedin_id"),
            "type": "role_change",
            "old": prev.get("role") or "",
            "new": snap.get("role") or "",
            "in_contacts": in_contacts,
        })
    if (prev.get("headline") or "") != (snap.get("headline") or "") and snap.get("headline"):
        changes.append({
            "ts": now_iso, "name": name,
            "linkedin_id": profile.get("linkedin_id"),
            "type": "headline_change",
            "old": prev.get("headline") or "",
            "new": snap.get("headline") or "",
            "in_contacts": in_contacts,
        })
    if not in_contacts:
        # Cheap-tier: only role/headline diffs for non-contacts.
        return changes
    if (prev.get("location") or "") != (snap.get("location") or "") and snap.get("location"):
        changes.append({
            "ts": now_iso, "name": name,
            "linkedin_id": profile.get("linkedin_id"),
            "type": "location_move",
            "old": prev.get("location") or "",
            "new": snap.get("location") or "",
            "in_contacts": True,
        })
    new_count = int(snap.get("skills_count") or 0)
    old_count = int(prev.get("skills_count") or 0)
    if new_count > old_count:
        changes.append({
            "ts": now_iso, "name": name,
            "linkedin_id": profile.get("linkedin_id"),
            "type": "skill_addition",
            "old": old_count,
            "new": new_count,
            "in_contacts": True,
        })
    return changes


# ── contact matching + merge ──────────────────────────────────────────
def _match_contact(name: str, linkedin_id: str | None,
                   people: dict) -> tuple[str, dict] | None:
    """Match a LinkedIn person to a contact record. Tries:
       1. social_handles.linkedin == linkedin_id (exact, stable)
       2. canonical name match
       3. fuzzy resolver from jarvis-contacts
    Returns (key, record) or None."""
    if linkedin_id:
        lid_lower = linkedin_id.lower()
        for k, v in people.items():
            handles = v.get("social_handles") or {}
            stored = (handles.get("linkedin") or "")
            stored_id = _vanity_from_url(stored) or stored
            if stored_id.lower() == lid_lower:
                return k, v
    if name:
        canon = _canonical(name)
        if canon and canon in people:
            return canon, people[canon]
    mod = _contacts()
    if mod is not None and name:
        try:
            hit = mod._resolve(name, people)  # type: ignore[attr-defined]
        except Exception:
            hit = None
        if hit:
            return hit
    return None


def _merge_into_contact(rec: dict, profile: dict) -> dict:
    """Apply LinkedIn-derived fields onto a contact record. Idempotent —
    won't overwrite manually-set values when they already differ. Returns
    the same rec for chaining."""
    rec.setdefault("social_handles", {})
    if profile.get("linkedin_id") and not rec["social_handles"].get("linkedin"):
        rec["social_handles"]["linkedin"] = profile["linkedin_id"]

    cur_skills = list(rec.get("skills") or [])
    cur_lower = {s.lower() for s in cur_skills if isinstance(s, str)}
    for s in profile.get("skills_endorsed") or []:
        if isinstance(s, str) and s and s.lower() not in cur_lower:
            cur_skills.append(s)
            cur_lower.add(s.lower())
    rec["skills"] = cur_skills[:30]

    cur_exp = list(rec.get("expertise_areas") or [])
    industry = profile.get("industry")
    if industry and industry not in cur_exp:
        cur_exp.append(industry)
    rec["expertise_areas"] = cur_exp[:8]

    cur = profile.get("current_role") or {}
    if cur.get("title") and cur.get("company") and not rec.get("relationship"):
        # Don't trample a hand-curated label, but seed the empty case.
        rec["relationship"] = f"{cur['title']} at {cur['company']}"

    rec["linkedin_url"] = profile.get("profile_url") or rec.get("linkedin_url")
    rec["linkedin_last_synced_at"] = datetime.now(timezone.utc).isoformat(
        timespec="seconds")
    return rec


# ── core: scrape + persist one profile ────────────────────────────────
def _scrape_one(linkedin_id: str, cookie: str, *,
                in_contacts: bool, force: bool,
                state: dict) -> tuple[dict | None, list[dict]]:
    """Fetch, parse, snapshot, diff, persist. Returns (profile, changes).
    `state` is the mutable hour-window ledger from _load_sync_state().

    Honours the per-tier rescrape interval — a freshly cached profile
    short-circuits without burning an API call when force=False."""
    cached = _load_profile(linkedin_id)
    if cached and not force:
        last = cached.get("last_scraped")
        if last:
            try:
                age = time.time() - datetime.fromisoformat(last).timestamp()
            except Exception:
                age = 0
            interval = CONTACT_RESCRAPE_S if (in_contacts or cached.get("in_contacts")) \
                else LINKEDIN_ONLY_RESCRAPE_S
            if 0 < age < interval:
                return cached, []

    if _hourly_ceiling_check(state):
        _log(f"hourly ceiling reached, skipping scrape for {linkedin_id}")
        return cached, []

    view = _fetch_profile(linkedin_id, cookie)
    _hourly_ceiling_bump(state)
    if view is None:
        return cached, []
    parsed = _parse_profile_view(view, linkedin_id)

    # Skills as a separate call — gated so we don't double the rate.
    time.sleep(REQUEST_DELAY_S)
    if _hourly_ceiling_check(state):
        skills: list[str] = (cached or {}).get("skills_endorsed") or []
    else:
        skills = _fetch_skills(linkedin_id, cookie)
        _hourly_ceiling_bump(state)
    parsed["skills_endorsed"] = skills

    parsed["in_contacts"] = bool(in_contacts)
    parsed["linkedin_only"] = not in_contacts
    parsed["last_scraped"] = datetime.now(timezone.utc).isoformat(timespec="seconds")

    history = list((cached or {}).get("snapshot_history") or [])
    snap = _snapshot_for(parsed)
    prev_snap = history[-1] if history else None
    changes = _detect_changes(prev_snap, snap, parsed, in_contacts)
    # Only append a new snapshot when something materially changed (or no
    # history yet) so the file doesn't bloat on weekly no-op re-scrapes.
    if not history or changes or (history and history[-1].get("date") != snap["date"]
                                  and prev_snap != snap):
        history.append(snap)
        history = history[-60:]  # keep ~last 60 snapshots
    parsed["snapshot_history"] = history

    _save_profile(parsed)
    for ch in changes:
        _append_change(ch)
    return parsed, changes


# ── PUBLIC: linkedin_enrich ───────────────────────────────────────────
def linkedin_enrich(name_or_url: str, force: bool = False) -> dict:
    """Fetch one profile and merge into the matching contact (full),
    or store as linkedin_only when no contact matches."""
    started = time.monotonic()
    gate = _gate_check()
    if gate:
        _emit("linkedin_enrich", "skipped", reason="gate")
        return gate
    if not name_or_url or not name_or_url.strip():
        _emit("linkedin_enrich", "failed", reason="no_input")
        return {"error": "name_or_url is required"}
    cookie = os.environ["LINKEDIN_COOKIE"]

    linkedin_id = _vanity_from_url(name_or_url) or name_or_url.strip().lstrip("@")

    # If a name was passed, try matching to an existing contact whose
    # social_handles.linkedin gives us the real vanity. That's cheaper +
    # more accurate than name-as-vanity guessing.
    cmod = _contacts()
    people = cmod._load_people() if cmod else {}  # type: ignore[attr-defined]
    matched = None
    if not _vanity_from_url(name_or_url):
        # Heuristic: input looks like a name, not a URL.
        matched = _match_contact(name_or_url, None, people)
        if matched:
            stored = ((matched[1].get("social_handles") or {}).get("linkedin") or "")
            stored_id = _vanity_from_url(stored) or stored
            if stored_id:
                linkedin_id = stored_id
    in_contacts = matched is not None

    state = _load_sync_state()
    profile, changes = _scrape_one(
        linkedin_id, cookie,
        in_contacts=in_contacts, force=force, state=state,
    )
    _save_sync_state(state)

    # Re-resolve once we know the canonical name from LinkedIn — improves
    # the match when the original input was a vanity slug.
    if profile and not in_contacts:
        re_match = _match_contact(profile.get("name") or "", linkedin_id, people)
        if re_match:
            in_contacts = True
            matched = re_match
            profile["in_contacts"] = True
            profile["linkedin_only"] = False
            _save_profile(profile)

    merged = False
    if profile and in_contacts and matched:
        key, rec = matched
        _merge_into_contact(rec, profile)
        people[key] = rec
        if cmod is not None:
            cmod._save_people(people)  # type: ignore[attr-defined]
        merged = True

    elapsed = int((time.monotonic() - started) * 1000)
    if profile is None:
        _emit("linkedin_enrich", "failed", reason="fetch", id=linkedin_id)
        return {"error": f"could not fetch profile for {linkedin_id!r} "
                         "(check LINKEDIN_COOKIE)"}
    _emit("linkedin_enrich", "success",
          id=linkedin_id, in_contacts=in_contacts, merged=merged,
          changes=len(changes), latency_ms=elapsed)
    return {
        "ok": True,
        "linkedin_id": linkedin_id,
        "name": profile.get("name"),
        "in_contacts": in_contacts,
        "merged_into_contact": merged,
        "current_role": profile.get("current_role"),
        "headline": profile.get("headline"),
        "skills_count": len(profile.get("skills_endorsed") or []),
        "changes_detected": changes,
    }


# ── PUBLIC: linkedin_sync ─────────────────────────────────────────────
def linkedin_sync(limit: int | None = None) -> dict:
    """Walk Watson's connection list. For each connection that matches a
    contact: full enrich + merge. For non-matches: store a thin profile
    skeleton tagged linkedin_only=True."""
    started = time.monotonic()
    gate = _gate_check()
    if gate:
        _emit("linkedin_sync", "skipped", reason="gate")
        return gate
    cookie = os.environ["LINKEDIN_COOKIE"]

    cmod = _contacts()
    people = cmod._load_people() if cmod else {}  # type: ignore[attr-defined]

    state = _load_sync_state()
    cursor = int(state.get("connection_cursor") or 0)
    cap = min(int(limit) if limit else SYNC_CAP_PER_RUN, SYNC_CAP_PER_RUN)

    processed = 0
    matched_count = 0
    skipped = 0
    errors: list[str] = []
    page_size = min(40, max(10, cap))

    page_start = cursor
    total_estimate = 0
    while processed < cap:
        if _hourly_ceiling_check(state):
            errors.append("hourly ceiling reached, will resume next run")
            break
        conns, total = _fetch_connections(cookie, start=page_start, count=page_size)
        _hourly_ceiling_bump(state)
        if not conns:
            break
        if total:
            total_estimate = total
        for conn in conns:
            if processed >= cap:
                break
            lid = conn.get("linkedin_id")
            if not lid:
                continue
            try:
                hit = _match_contact(conn.get("name") or "", lid, people)
                in_contacts = hit is not None

                # Linkedin_only fast path: if we already have a recent
                # cached skeleton, skip to keep the run cheap.
                cached = _load_profile(lid)
                interval = CONTACT_RESCRAPE_S if in_contacts else LINKEDIN_ONLY_RESCRAPE_S
                if cached and cached.get("last_scraped"):
                    try:
                        age = time.time() - datetime.fromisoformat(
                            cached["last_scraped"]).timestamp()
                    except Exception:
                        age = 0
                    if 0 < age < interval:
                        skipped += 1
                        continue

                if not in_contacts:
                    # Cheap path — store a connection-list skeleton instead
                    # of a full profile fetch. We'll deepen it on demand
                    # via linkedin_enrich.
                    skeleton = cached or {
                        "linkedin_id": lid,
                        "name": conn.get("name"),
                        "headline": conn.get("headline") or "",
                        "current_role": None,
                        "previous_roles": [],
                        "location": "",
                        "industry": "",
                        "skills_endorsed": [],
                        "education": [],
                        "profile_url": _profile_url(lid),
                        "in_contacts": False,
                        "linkedin_only": True,
                        "snapshot_history": [],
                    }
                    skeleton["last_scraped"] = datetime.now(timezone.utc).isoformat(
                        timespec="seconds")
                    skeleton["name"] = conn.get("name") or skeleton.get("name")
                    skeleton["headline"] = conn.get("headline") or skeleton.get("headline")
                    snap = _snapshot_for(skeleton)
                    history = skeleton.get("snapshot_history") or []
                    prev = history[-1] if history else None
                    changes = _detect_changes(prev, snap, skeleton, in_contacts=False)
                    if not history or changes:
                        history.append(snap)
                    skeleton["snapshot_history"] = history[-60:]
                    _save_profile(skeleton)
                    for ch in changes:
                        _append_change(ch)
                    processed += 1
                    continue

                # Contact match → full scrape + merge
                profile, changes = _scrape_one(
                    lid, cookie, in_contacts=True, force=False, state=state,
                )
                if profile and hit:
                    key, rec = hit
                    _merge_into_contact(rec, profile)
                    people[key] = rec
                    matched_count += 1
                processed += 1
                time.sleep(REQUEST_DELAY_S)
            except Exception as e:
                errors.append(f"{lid}: {e}")
                _log(f"sync {lid} crashed: {e}")
        page_start += len(conns)
        if total_estimate and page_start >= total_estimate:
            page_start = 0
            break
        if len(conns) < page_size:
            break

    state["connection_cursor"] = page_start
    state["last_sync"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    _save_sync_state(state)

    if matched_count and cmod is not None:
        cmod._save_people(people)  # type: ignore[attr-defined]

    elapsed = int((time.monotonic() - started) * 1000)
    _emit("linkedin_sync", "success" if not errors else "failed",
          processed=processed, matched=matched_count, skipped=skipped,
          errors_count=len(errors), latency_ms=elapsed)
    _log(f"linkedin_sync: processed={processed} matched={matched_count} "
         f"skipped={skipped} errors={len(errors)} ({elapsed}ms)")
    return {
        "ok": True,
        "processed": processed,
        "matched_to_contacts": matched_count,
        "skipped_fresh": skipped,
        "errors": errors,
        "next_cursor": page_start,
        "total_estimate": total_estimate,
    }


# ── notification routing ──────────────────────────────────────────────
def _route_changes_to_notifications(changes: list[dict]) -> None:
    """Push contact-tier role changes into the smart-notification bus.
    linkedin_only changes never reach this code — the caller filters by
    in_contacts before invoking. Source weight + sender importance from
    the bus produce the natural priority (inner_circle ≈ score 6,
    professional ≈ 4, acquaintance ≈ 3)."""
    notif = _notifications()
    if notif is None:
        return
    for ch in changes:
        if not ch.get("in_contacts"):
            continue
        if ch.get("type") != "role_change":
            continue
        name = ch.get("name") or "?"
        new = ch.get("new") or ""
        old = ch.get("old") or ""
        content = f"{name} changed role: {old} → {new}".strip()
        try:
            notif.enqueue(
                source="linkedin",
                content=content,
                sender=name,
            )
        except Exception as e:
            _log(f"notify enqueue failed for {name}: {e}")


# ── PUBLIC: linkedin_monitor ──────────────────────────────────────────
def linkedin_monitor() -> dict:
    """Re-scrape due profiles and detect changes. Contact tier rescrapes
    every 7d; linkedin_only every 30d. Caps the run at MONITOR_CAP_PER_RUN
    so a large connection set spreads across the week."""
    started = time.monotonic()
    gate = _gate_check()
    if gate:
        _emit("linkedin_monitor", "skipped", reason="gate")
        return gate
    cookie = os.environ["LINKEDIN_COOKIE"]
    cmod = _contacts()
    people = cmod._load_people() if cmod else {}  # type: ignore[attr-defined]

    profiles = list(_all_profiles())
    if not profiles:
        _emit("linkedin_monitor", "skipped", reason="no_profiles")
        return {"ok": True, "checked": 0, "changes": 0,
                "hint": "no profiles cached yet — run linkedin_sync first"}

    now = time.time()
    due: list[tuple[float, dict]] = []
    for prof in profiles:
        last = prof.get("last_scraped")
        try:
            age = now - datetime.fromisoformat(last).timestamp() if last else 9e9
        except Exception:
            age = 9e9
        is_contact = bool(prof.get("in_contacts"))
        interval = CONTACT_RESCRAPE_S if is_contact else LINKEDIN_ONLY_RESCRAPE_S
        if age >= interval:
            # Sort key: contacts first (lower is earlier), then by age.
            tier_bias = 0 if is_contact else 1
            due.append((tier_bias * 1e9 - age, prof))
    due.sort(key=lambda t: t[0])  # contacts ahead, oldest first within tier

    state = _load_sync_state()
    checked = 0
    total_changes: list[dict] = []
    contact_changes = 0
    errors: list[str] = []
    for _, prof in due:
        if checked >= MONITOR_CAP_PER_RUN:
            break
        if _hourly_ceiling_check(state):
            errors.append("hourly ceiling reached, will resume next run")
            break
        lid = prof.get("linkedin_id")
        if not lid:
            continue
        is_contact = bool(prof.get("in_contacts"))
        try:
            new_prof, changes = _scrape_one(
                lid, cookie, in_contacts=is_contact, force=True, state=state,
            )
            if new_prof and is_contact:
                hit = _match_contact(new_prof.get("name") or "", lid, people)
                if hit:
                    key, rec = hit
                    _merge_into_contact(rec, new_prof)
                    people[key] = rec
            if changes:
                total_changes.extend(changes)
                if is_contact:
                    contact_changes += sum(1 for c in changes if c.get("in_contacts"))
                    _route_changes_to_notifications(changes)
            checked += 1
            time.sleep(REQUEST_DELAY_S)
        except Exception as e:
            errors.append(f"{lid}: {e}")
            _log(f"monitor {lid} crashed: {e}")

    _save_sync_state(state)
    if cmod is not None and contact_changes:
        cmod._save_people(people)  # type: ignore[attr-defined]

    elapsed = int((time.monotonic() - started) * 1000)
    _emit("linkedin_monitor", "success" if not errors else "failed",
          checked=checked, changes=len(total_changes),
          contact_changes=contact_changes, errors_count=len(errors),
          latency_ms=elapsed)
    _log(f"linkedin_monitor: checked={checked} changes={len(total_changes)} "
         f"contact_changes={contact_changes} ({elapsed}ms)")
    return {
        "ok": True,
        "checked": checked,
        "due_pending": max(0, len(due) - checked),
        "changes": len(total_changes),
        "contact_changes": contact_changes,
        "errors": errors,
        "sample_changes": total_changes[:10],
    }


# ── PUBLIC: linkedin_changes ──────────────────────────────────────────
def linkedin_changes(days: int = 7, contacts_only: bool = True) -> dict:
    """Read the change log filtered by recency and tier. Returns grouped
    summaries plus the raw records (capped)."""
    gate = _gate_check()
    if gate:
        return gate
    days = max(1, int(days))
    since = time.time() - days * 86400
    raw = _read_changes(since_ts=since)
    if contacts_only:
        raw = [r for r in raw if r.get("in_contacts")]

    groups: dict[str, list[dict]] = {
        "role_changes": [], "headline_changes": [],
        "skill_additions": [], "location_moves": [],
    }
    type_to_group = {
        "role_change": "role_changes",
        "headline_change": "headline_changes",
        "skill_addition": "skill_additions",
        "location_move": "location_moves",
    }
    for r in raw:
        g = type_to_group.get(r.get("type"))
        if g:
            groups[g].append(r)

    # Contact-first ordering inside each group; ties broken by mutual
    # connections when we have them (stored on profile).
    for g, items in groups.items():
        items.sort(key=lambda r: (
            0 if r.get("in_contacts") else 1,
            -(r.get("ts") or ""),
        ), reverse=False)

    counts = {g: len(v) for g, v in groups.items()}
    return {
        "ok": True,
        "days": days,
        "contacts_only": contacts_only,
        "counts": counts,
        "total": sum(counts.values()),
        "groups": {g: v[:25] for g, v in groups.items()},
    }


# ── PUBLIC: linkedin_search ───────────────────────────────────────────
_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _toks(s: str) -> set[str]:
    return {t for t in _TOKEN_RE.findall((s or "").lower()) if len(t) > 2}


def linkedin_search(query: str) -> dict:
    """Local search across cached profiles. Hits skills, current company,
    title, location, and headline. Contact matches outrank linkedin_only.

    "who works at Google" → matches current_role.company == 'google'
    "who knows Python"    → matches skills_endorsed contains 'python'
    """
    gate = _gate_check()
    if gate:
        return gate
    q = (query or "").strip()
    if not q:
        return {"error": "query is required"}
    qt = _toks(q)
    if not qt:
        return {"error": "query too short"}

    profiles = list(_all_profiles())
    if not profiles:
        return {"ok": True, "query": q, "count": 0, "results": [],
                "hint": "no profiles cached — run linkedin_sync"}

    results: list[tuple[float, dict, list[str]]] = []
    for prof in profiles:
        cur = prof.get("current_role") or {}
        company = cur.get("company") or ""
        title = cur.get("title") or ""
        skills = prof.get("skills_endorsed") or []
        text_blob = " ".join([
            prof.get("name") or "",
            prof.get("headline") or "",
            company,
            title,
            prof.get("location") or "",
            prof.get("industry") or "",
            " ".join(skills),
        ])
        text_tokens = _toks(text_blob)
        overlap = qt & text_tokens
        if not overlap:
            continue
        score = float(len(overlap))
        reasons: list[str] = []
        if qt & _toks(company):
            score += 3
            reasons.append("company")
        if qt & _toks(title):
            score += 2
            reasons.append("title")
        if qt & _toks(" ".join(skills)):
            score += 2
            reasons.append("skill")
        if qt & _toks(prof.get("headline") or ""):
            score += 1
            reasons.append("headline")
        if not reasons:
            reasons.append("text")
        # Contact tier boost
        if prof.get("in_contacts"):
            score += 5
        results.append((score, prof, reasons))

    results.sort(key=lambda t: (t[0], 1 if t[1].get("in_contacts") else 0),
                 reverse=True)

    out: list[dict] = []
    for _, prof, reasons in results[:25]:
        cur = prof.get("current_role") or {}
        out.append({
            "name": prof.get("name"),
            "linkedin_id": prof.get("linkedin_id"),
            "in_contacts": bool(prof.get("in_contacts")),
            "headline": prof.get("headline"),
            "current_role": (
                {"title": cur.get("title"), "company": cur.get("company")}
                if cur else None
            ),
            "location": prof.get("location"),
            "skills_top": (prof.get("skills_endorsed") or [])[:8],
            "profile_url": prof.get("profile_url"),
            "match_reasons": reasons,
        })
    return {"ok": True, "query": q, "count": len(out), "results": out}


# ── briefing + context + notification hooks ───────────────────────────
def briefing_section(days: int = 1) -> str:
    """Markdown 'LinkedIn Changes' subsection — contacts only. Returns ''
    when nothing is fresh so quiet days don't pad the briefing."""
    res = linkedin_changes(days=days, contacts_only=True)
    if not res.get("ok"):
        return ""
    total = int(res.get("total") or 0)
    if total == 0:
        return ""
    groups = res.get("groups") or {}
    lines = ["### LinkedIn Changes", ""]
    role = groups.get("role_changes") or []
    if role:
        lines.append("**Role moves:**")
        for r in role[:5]:
            lines.append(f"- {r.get('name')} — {r.get('old')} → {r.get('new')}")
        lines.append("")
    head = groups.get("headline_changes") or []
    if head:
        lines.append("**Headline updates:**")
        for r in head[:3]:
            lines.append(f"- {r.get('name')}: {r.get('new')}")
        lines.append("")
    loc = groups.get("location_moves") or []
    if loc:
        lines.append("**Location moves:**")
        for r in loc[:3]:
            lines.append(f"- {r.get('name')} — {r.get('old')} → {r.get('new')}")
        lines.append("")
    return "\n".join(lines)


def context_hint(mentioned_names: list[str] | None = None) -> str:
    """One-line system-prompt hint. If a mentioned person has a recent
    role/headline change on file, surface it. Empty otherwise. Only
    contact-tier signals — linkedin_only never enters here."""
    if not mentioned_names:
        return ""
    if _gate_check() is not None:
        return ""
    # Last 14 days is generous enough that "Karina just moved to Stripe"
    # surfaces for the next conversation cycle.
    res = linkedin_changes(days=14, contacts_only=True)
    if not res.get("ok") or not res.get("total"):
        return ""
    flat: list[dict] = []
    for items in (res.get("groups") or {}).values():
        flat.extend(items)
    bits: list[str] = []
    for nm in mentioned_names[:3]:
        canon = _canonical(nm)
        for ch in flat:
            if not canon:
                continue
            if _canonical(ch.get("name") or "") == canon:
                if ch.get("type") == "role_change":
                    bits.append(f"{ch.get('name')} recently changed role to "
                                f"{ch.get('new')}")
                elif ch.get("type") == "headline_change":
                    bits.append(f"{ch.get('name')} updated their headline: "
                                f"{ch.get('new')}")
                elif ch.get("type") == "location_move":
                    bits.append(f"{ch.get('name')} moved to {ch.get('new')}")
                break
    if not bits:
        return ""
    return "**LinkedIn:** " + "; ".join(bits) + "."


def recent_role_change(sender: str | None) -> dict | None:
    """Lookup hook for jarvis-notifications — returns the last 14-day
    role change for `sender` if they're a contact-tier match. None
    otherwise. Used to bump the priority of a notification from someone
    who just changed jobs."""
    if not sender or _gate_check() is not None:
        return None
    res = linkedin_changes(days=14, contacts_only=True)
    groups = res.get("groups") or {}
    canon = _canonical(sender)
    if not canon:
        return None
    for r in (groups.get("role_changes") or []):
        if _canonical(r.get("name") or "") == canon:
            return r
    return None


# ── main entrypoint (jarvis-improve) ──────────────────────────────────
def main() -> int:
    """Tier-2 entrypoint. Runs linkedin_monitor every pass and
    linkedin_sync every ~30 days. Cheap when nothing is due — the
    rescrape interval and connection cursor cap each invocation. Always
    exits 0 so the chain doesn't break."""
    if _gate_check() is not None:
        return 0
    try:
        linkedin_monitor()
    except Exception as e:
        _log(f"main monitor: {e}")

    # Monthly connection sweep — keeps the linkedin_only set fresh and
    # picks up new contacts who have a handle. Cadence read from sync
    # state so a forced run from CLI doesn't change the rhythm.
    try:
        state = _load_sync_state()
        last = state.get("last_sync")
        run_sync = True
        if last:
            try:
                age = time.time() - datetime.fromisoformat(last).timestamp()
                run_sync = age >= int(os.environ.get(
                    "JARVIS_LINKEDIN_SYNC_INTERVAL_S", str(30 * 86400)))
            except Exception:
                run_sync = True
        if run_sync:
            linkedin_sync()
    except Exception as e:
        _log(f"main sync: {e}")
    return 0


# ── CLI ────────────────────────────────────────────────────────────────
def _cli() -> int:
    p = argparse.ArgumentParser(description="Jarvis LinkedIn intelligence")
    sub = p.add_subparsers(dest="cmd", required=True)

    pe = sub.add_parser("enrich", help="enrich one profile by name or URL")
    pe.add_argument("name_or_url")
    pe.add_argument("--force", action="store_true")

    ps = sub.add_parser("sync", help="sync connections list")
    ps.add_argument("--limit", type=int, default=None)

    sub.add_parser("monitor", help="re-scrape due profiles and log changes")

    pc = sub.add_parser("changes", help="recent changes")
    pc.add_argument("--days", type=int, default=7)
    pc.add_argument("--all", action="store_true",
                    help="include linkedin_only changes (default contacts only)")

    psr = sub.add_parser("search", help="search cached profiles")
    psr.add_argument("query", nargs="+")

    sub.add_parser("status", help="cache + sync state")
    pcb = sub.add_parser("briefing-section",
                         help="markdown block for jarvis-briefing")
    pcb.add_argument("--days", type=int, default=1)
    pch = sub.add_parser("context-hint")
    pch.add_argument("--names", default=None,
                     help="comma-separated names to check")

    args = p.parse_args()

    if args.cmd == "enrich":
        print(json.dumps(linkedin_enrich(args.name_or_url, force=args.force),
                         ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "sync":
        print(json.dumps(linkedin_sync(limit=args.limit),
                         ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "monitor":
        print(json.dumps(linkedin_monitor(),
                         ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "changes":
        print(json.dumps(linkedin_changes(days=args.days,
                                          contacts_only=not args.all),
                         ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "search":
        q = " ".join(args.query)
        print(json.dumps(linkedin_search(q), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "status":
        n_profiles = len(list(_all_profiles()))
        contact_n = sum(1 for p in _all_profiles() if p.get("in_contacts"))
        state = _load_sync_state()
        print(json.dumps({
            "ok": True,
            "configured": bool(os.environ.get("LINKEDIN_COOKIE")),
            "enabled": _gate_check() is None,
            "profiles_total": n_profiles,
            "profiles_contacts": contact_n,
            "profiles_linkedin_only": n_profiles - contact_n,
            "connection_cursor": state.get("connection_cursor"),
            "last_sync": state.get("last_sync"),
            "hour_window": state.get("hour_window"),
            "profiles_dir": str(PROFILES_DIR),
            "changes_file": str(CHANGES_FILE),
        }, indent=2, ensure_ascii=False))
        return 0
    if args.cmd == "briefing-section":
        s = briefing_section(days=args.days)
        print(s if s else "(no LinkedIn changes)")
        return 0
    if args.cmd == "context-hint":
        names = [n.strip() for n in (args.names or "").split(",") if n.strip()]
        h = context_hint(mentioned_names=names or None)
        print(h if h else "(no hint)")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(_cli() if len(sys.argv) > 1 else main())
