#!/usr/bin/env python3
"""Social media monitoring + reporting agent.

Watson wants to stop checking social apps. This module polls a configurable
set of platforms (Twitter/X, LinkedIn, Instagram, RSS), normalizes everything
into a single JSONL cache, and exposes five tools so jarvis-think.py can read,
search, summarize, post, and reply through one consistent surface.

Each platform is fully independent. Missing API keys disable just that
platform — the rest still work. Stdlib only (urllib + json + html.parser +
xml.etree.ElementTree), matching the other Jarvis agents.

Public functions (all return JSON-serializable dicts):

    check_social(platform=None, hours=4)
        Recent activity. `platform` filters to one of {twitter, linkedin,
        instagram, rss}; None pulls everything.

    social_digest(hours=12)
        Haiku-summarized digest grouped by platform with urgency ratings.

    social_reply(platform, item_id, message, confirm=False)
        Reply to a specific item — confirm=True required, style auto-applied
        on the preview round (same as send_email / send_telegram).

    social_post(platform, content, confirm=False)
        New post with per-platform character limit enforcement.
        confirm=True required.

    social_search(query, platform=None, hours=48)
        Substring search across the cache.

Polling — `poll_loop()` is the wake-listener entry point. It walks the
enabled platforms in turn, honouring per-platform minimum intervals so we
never hammer a rate limit. State (last_id / last_seen / next_poll) lives in
~/.jarvis/social/state.json.

Files:
    ~/.jarvis/social/feeds.json            user RSS list
    ~/.jarvis/social/state.json            polling state
    ~/.jarvis/social/cache/{platform}.jsonl normalized records
    ~/.jarvis/logs/social.log              diagnostic log

Env gates:
    JARVIS_SOCIAL=1     master gate, defaults on if any platform is configured
    JARVIS_TWITTER=1    requires TWITTER_BEARER_TOKEN
    JARVIS_LINKEDIN=1   requires LINKEDIN_COOKIE     (experimental — Voyager)
    JARVIS_INSTAGRAM=1  requires INSTAGRAM_ACCESS_TOKEN
    JARVIS_RSS=1        no auth, default on if feeds.json exists

CLI:
    bin/jarvis-social.py --status
    bin/jarvis-social.py --check [--platform X] [--hours N]
    bin/jarvis-social.py --digest [--hours N]
    bin/jarvis-social.py --search "query" [--platform X] [--hours N]
    bin/jarvis-social.py --post PLATFORM "content" [--confirm]
    bin/jarvis-social.py --reply PLATFORM ITEM_ID "msg" [--confirm]
    bin/jarvis-social.py --poll-once [--platform X]
    bin/jarvis-social.py --poll-loop
    bin/jarvis-social.py --rss-add URL [--name X] [--priority high|normal|low]
"""
from __future__ import annotations

import html
import importlib.util
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
SOCIAL_DIR = ASSISTANT_DIR / "social"
FEEDS_FILE = SOCIAL_DIR / "feeds.json"
STATE_FILE = SOCIAL_DIR / "state.json"
CACHE_DIR = SOCIAL_DIR / "cache"
LOG_DIR = ASSISTANT_DIR / "logs"
SOCIAL_LOG = LOG_DIR / "social.log"

PLATFORMS = ("twitter", "linkedin", "instagram", "rss")

# Per-platform minimum poll intervals. The free Twitter v2 tier is brutal —
# 60s between calls is a safe floor. LinkedIn's Voyager API has no published
# limit but cookie-auth scraping should be polite. Instagram Graph allows
# more but we cap to keep batteries happy. RSS is free but most feeds
# update at most every ~10 minutes.
POLL_INTERVALS_S = {
    "twitter": int(os.environ.get("JARVIS_TWITTER_INTERVAL_S", "60")),
    "linkedin": int(os.environ.get("JARVIS_LINKEDIN_INTERVAL_S", "300")),
    "instagram": int(os.environ.get("JARVIS_INSTAGRAM_INTERVAL_S", "120")),
    "rss": int(os.environ.get("JARVIS_RSS_INTERVAL_S", "600")),
}

# Retention — short for social (the platforms are the source of truth), longer
# for RSS (Watson may want to recall an article a few days later).
RETENTION_DAYS = {
    "twitter": int(os.environ.get("JARVIS_SOCIAL_RETENTION_TWITTER_D", "3")),
    "linkedin": int(os.environ.get("JARVIS_SOCIAL_RETENTION_LINKEDIN_D", "3")),
    "instagram": int(os.environ.get("JARVIS_SOCIAL_RETENTION_INSTAGRAM_D", "3")),
    "rss": int(os.environ.get("JARVIS_SOCIAL_RETENTION_RSS_D", "7")),
}

# Per-platform character ceilings used by social_post. These are the public
# API limits at time of writing. We enforce them locally so a too-long post
# fails before burning a network round trip.
CHAR_LIMITS = {
    "twitter": 280,
    "linkedin": 3000,
    "instagram": 2200,
    "rss": 0,  # not postable
}

HTTP_TIMEOUT_S = float(os.environ.get("JARVIS_SOCIAL_HTTP_TIMEOUT_S", "12"))

DIGEST_MODEL = os.environ.get("JARVIS_SOCIAL_DIGEST_MODEL",
                              "claude-haiku-4-5-20251001")
DIGEST_MAX_PER_PLATFORM = int(os.environ.get("JARVIS_SOCIAL_DIGEST_MAX", "40"))


# ── Logging ─────────────────────────────────────────────────────────
def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with SOCIAL_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


# ── Gates ───────────────────────────────────────────────────────────
def _platform_token(platform: str) -> str | None:
    """Return the env var that auths `platform`, or None if no auth needed."""
    if platform == "twitter":
        return os.environ.get("TWITTER_BEARER_TOKEN") or None
    if platform == "linkedin":
        return os.environ.get("LINKEDIN_COOKIE") or None
    if platform == "instagram":
        return os.environ.get("INSTAGRAM_ACCESS_TOKEN") or None
    if platform == "rss":
        # RSS needs no token; "configured" means feeds.json exists.
        return "rss" if FEEDS_FILE.exists() else None
    return None


def _platform_enabled(platform: str) -> bool:
    """Per-platform gate. Defaults on iff token/feeds exist; user can force
    off by setting JARVIS_<PLATFORM>=0."""
    if platform not in PLATFORMS:
        return False
    if not _platform_token(platform):
        return False
    env_var = f"JARVIS_{platform.upper()}"
    return os.environ.get(env_var, "1") == "1"


def _master_gate_default() -> str:
    """Master gate defaults on iff at least one platform is configured."""
    return "1" if any(_platform_token(p) for p in PLATFORMS) else "0"


def _master_gate_check() -> dict | None:
    if os.environ.get("JARVIS_SOCIAL", _master_gate_default()) != "1":
        return {"error": "social disabled (JARVIS_SOCIAL=0 or no platform tokens)"}
    return None


def _enabled_platforms() -> list[str]:
    return [p for p in PLATFORMS if _platform_enabled(p)]


# ── State ───────────────────────────────────────────────────────────
def _load_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _save_state(state: dict) -> None:
    SOCIAL_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
    os.replace(tmp, STATE_FILE)


# ── Cache (per-platform JSONL) ──────────────────────────────────────
def _cache_path(platform: str) -> Path:
    return CACHE_DIR / f"{platform}.jsonl"


def _append_records(platform: str, records: Iterable[dict]) -> int:
    """Append one or more normalized records to the platform's cache.
    De-dup by record `id` against the in-file ids (cheap because caches
    are kept under retention)."""
    records = list(records)
    if not records:
        return 0
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    seen_ids = _existing_ids(platform)
    fresh = [r for r in records if r.get("id") and r["id"] not in seen_ids]
    if not fresh:
        return 0
    try:
        with _cache_path(platform).open("a", encoding="utf-8") as f:
            for rec in fresh:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return len(fresh)
    except Exception as e:
        _log(f"cache append failed ({platform}): {e}")
        return 0


def _existing_ids(platform: str) -> set:
    path = _cache_path(platform)
    if not path.exists():
        return set()
    out: set = set()
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
                if rec.get("id"):
                    out.add(rec["id"])
    except Exception as e:
        _log(f"cache read failed ({platform}): {e}")
    return out


def _read_cache(platform: str, since_ts: float) -> list[dict]:
    path = _cache_path(platform)
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
                if (rec.get("timestamp") or 0) >= since_ts:
                    out.append(rec)
    except Exception as e:
        _log(f"cache read failed ({platform}): {e}")
    return out


def _prune_cache(platform: str, retention_days: int | None = None) -> int:
    """Drop messages older than retention_days. Rewrites the file in place."""
    if retention_days is None:
        retention_days = RETENTION_DAYS.get(platform, 3)
    path = _cache_path(platform)
    if not path.exists():
        return 0
    cutoff = time.time() - retention_days * 86400
    pruned = 0
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
                    pruned += 1
                    continue
                if (rec.get("timestamp") or 0) >= cutoff:
                    kept.append(line)
                else:
                    pruned += 1
        if pruned:
            with path.open("w", encoding="utf-8") as f:
                f.write("\n".join(kept) + ("\n" if kept else ""))
    except Exception as e:
        _log(f"cache prune failed ({platform}): {e}")
    return pruned


# ── HTTP helper ─────────────────────────────────────────────────────
def _http_get(url: str, headers: dict | None = None,
              timeout: float | None = None) -> tuple[int, bytes, dict]:
    """Plain GET that surfaces (status, body, headers) without raising on
    non-2xx — platforms have wildly different error shapes, so the caller
    gets to interpret. Returns (-1, b"", {}) on transport errors."""
    req = urllib.request.Request(url, headers=headers or {})
    eff = timeout if timeout is not None else HTTP_TIMEOUT_S
    try:
        with urllib.request.urlopen(req, timeout=eff) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        try:
            body = e.read()
        except Exception:
            body = b""
        return e.code, body, dict(getattr(e, "headers", {}) or {})
    except (urllib.error.URLError, TimeoutError) as e:
        _log(f"http error: {url} -> {e}")
        return -1, b"", {}
    except Exception as e:
        _log(f"http unexpected: {url} -> {e}")
        return -1, b"", {}


def _http_post(url: str, body: bytes, headers: dict | None = None,
               timeout: float | None = None,
               method: str = "POST") -> tuple[int, bytes, dict]:
    req = urllib.request.Request(url, data=body, headers=headers or {},
                                 method=method)
    eff = timeout if timeout is not None else HTTP_TIMEOUT_S
    try:
        with urllib.request.urlopen(req, timeout=eff) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        try:
            data = e.read()
        except Exception:
            data = b""
        return e.code, data, dict(getattr(e, "headers", {}) or {})
    except (urllib.error.URLError, TimeoutError) as e:
        _log(f"http POST error: {url} -> {e}")
        return -1, b"", {}
    except Exception as e:
        _log(f"http POST unexpected: {url} -> {e}")
        return -1, b"", {}


# ── Twitter / X (API v2, bearer auth) ───────────────────────────────
TWITTER_API = "https://api.twitter.com/2"


def _twitter_user_id(token: str) -> str | None:
    """Resolve the bearer token's user via /users/me. Cached in state."""
    state = _load_state()
    cached = (state.get("twitter") or {}).get("user_id")
    if cached:
        return cached
    status, body, _ = _http_get(
        f"{TWITTER_API}/users/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    if status != 200:
        _log(f"twitter /users/me failed status={status}")
        return None
    try:
        data = json.loads(body)
    except Exception:
        return None
    uid = (data.get("data") or {}).get("id")
    if uid:
        state.setdefault("twitter", {})["user_id"] = uid
        state["twitter"]["username"] = (data.get("data") or {}).get("username")
        _save_state(state)
    return uid


def _twitter_fetch(token: str) -> list[dict]:
    """Pull recent @-mentions of the authenticated user, plus a small
    sweep of tweets where `to:<username>` (DMs require elevated access we
    can't assume). Returns normalized records."""
    uid = _twitter_user_id(token)
    if not uid:
        return []
    state = _load_state()
    tw_state = state.setdefault("twitter", {})
    since_id = tw_state.get("last_mention_id")
    params = {
        "max_results": "20",
        "tweet.fields": "created_at,author_id,conversation_id,in_reply_to_user_id",
        "expansions": "author_id",
        "user.fields": "username,name",
    }
    if since_id:
        params["since_id"] = since_id
    url = (f"{TWITTER_API}/users/{uid}/mentions?"
           + urllib.parse.urlencode(params))
    status, body, headers = _http_get(
        url, headers={"Authorization": f"Bearer {token}"},
    )
    if status == 429:
        # Push next poll out by the rate-limit reset (or +60s as a fallback).
        reset = headers.get("x-rate-limit-reset")
        delay = 60
        if reset and reset.isdigit():
            delay = max(60, int(reset) - int(time.time()))
        tw_state["next_poll"] = int(time.time()) + delay
        _save_state(state)
        _log(f"twitter rate-limited; next poll in {delay}s")
        return []
    if status != 200:
        _log(f"twitter mentions failed status={status}")
        return []
    try:
        data = json.loads(body)
    except Exception:
        return []
    tweets = data.get("data") or []
    users = {u.get("id"): u for u in (data.get("includes") or {}).get("users", [])}

    out: list[dict] = []
    max_id = since_id
    for t in tweets:
        tid = t.get("id")
        if not tid:
            continue
        if max_id is None or int(tid) > int(max_id):
            max_id = tid
        author = users.get(t.get("author_id")) or {}
        ts = _parse_iso(t.get("created_at"))
        out.append({
            "platform": "twitter",
            "id": f"twitter:{tid}",
            "kind": "mention",
            "from_handle": "@" + (author.get("username") or "?"),
            "from_name": author.get("name") or author.get("username") or "?",
            "text": t.get("text") or "",
            "url": (f"https://twitter.com/{author.get('username') or 'i'}"
                    f"/status/{tid}"),
            "timestamp": ts,
            "datetime": _format_ts(ts),
            "raw_id": tid,
            "reply_to": t.get("in_reply_to_user_id") and \
                f"twitter:user:{t['in_reply_to_user_id']}",
            "is_dm": False,
        })
    if max_id and max_id != since_id:
        tw_state["last_mention_id"] = max_id
        _save_state(state)
    return out


def _twitter_post(token: str, content: str,
                  reply_to_tweet_id: str | None = None) -> dict:
    body = {"text": content}
    if reply_to_tweet_id:
        body["reply"] = {"in_reply_to_tweet_id": reply_to_tweet_id}
    status, raw, _ = _http_post(
        f"{TWITTER_API}/tweets",
        body=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    if status not in (200, 201):
        try:
            err = json.loads(raw).get("detail") or json.loads(raw).get("title") or raw.decode("utf-8", "replace")
        except Exception:
            err = f"status {status}"
        return {"error": f"twitter post: {err}"}
    try:
        data = json.loads(raw).get("data") or {}
    except Exception:
        data = {}
    return {"sent": True, "id": data.get("id"), "platform": "twitter"}


# ── LinkedIn (Voyager — experimental, cookie-auth) ──────────────────
# LinkedIn doesn't expose mentions / messaging on its public REST API to
# end users; the only practical pathway from a personal account is the
# internal Voyager API, called with a logged-in `li_at` session cookie.
# This is fragile by design — LinkedIn rotates endpoints — so we mark
# every result `experimental: true` and degrade silently on failure.
LINKEDIN_VOYAGER_ROOT = "https://www.linkedin.com/voyager/api"


def _linkedin_headers(cookie: str) -> dict:
    return {
        "Cookie": f"li_at={cookie}",
        "Csrf-Token": "ajax:1234",  # Voyager requires the literal "ajax:..." form
        "X-Restli-Protocol-Version": "2.0.0",
        "X-Li-Lang": "en_US",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
    }


def _linkedin_fetch(cookie: str) -> list[dict]:
    """Pull recent notification activity. Voyager's /messaging surfaces are
    the closest approximation to "what arrived for me on LinkedIn"."""
    url = (f"{LINKEDIN_VOYAGER_ROOT}/voyagerNotificationsDashNotificationCards"
           "?q=filterVanityName&count=20&filterVanityName=ALL")
    status, body, _ = _http_get(url, headers=_linkedin_headers(cookie))
    if status == 401 or status == 403:
        _log(f"linkedin auth failed (status={status}) — cookie may be expired")
        return []
    if status != 200 or not body:
        _log(f"linkedin notifications failed status={status}")
        return []
    try:
        data = json.loads(body)
    except Exception:
        return []
    elements = data.get("elements") or data.get("included") or []
    out: list[dict] = []
    for el in elements:
        if not isinstance(el, dict):
            continue
        nid = el.get("entityUrn") or el.get("trackingId") or el.get("publishedAt")
        if not nid:
            continue
        # Voyager is messy. Reach for the most-likely-populated text fields,
        # falling back to the headline/subheadline. Keep it best-effort.
        text = (
            (el.get("headline") or {}).get("text")
            or (el.get("subheadline") or {}).get("text")
            or el.get("cardAction", {}).get("actionTarget")
            or ""
        )
        if not text:
            # Skip empty cards — LinkedIn returns lots of structural records.
            continue
        ts_ms = el.get("publishedAt") or 0
        ts = int(ts_ms / 1000) if ts_ms > 1e10 else int(ts_ms or time.time())
        actor = (el.get("actor") or {}).get("name", {}).get("text") or ""
        out.append({
            "platform": "linkedin",
            "id": f"linkedin:{nid}",
            "kind": "notification",
            "from_handle": actor,
            "from_name": actor,
            "text": text[:1000],
            "url": el.get("cardAction", {}).get("actionTarget") or "",
            "timestamp": ts,
            "datetime": _format_ts(ts),
            "raw_id": nid,
            "is_dm": False,
            "experimental": True,
        })
    return out


def _linkedin_post(_cookie: str, _content: str) -> dict:
    # Posting via Voyager triggers anti-automation flags fast, and a wrong
    # call here can silently lock the account. Punting until the user
    # explicitly asks to enable it.
    return {"error": "linkedin posting not implemented (Voyager requires "
                     "anti-automation handling — open an issue if you "
                     "actually want this)"}


# ── Instagram (Graph API / Basic Display) ───────────────────────────
INSTAGRAM_API = "https://graph.instagram.com"


def _instagram_fetch(token: str) -> list[dict]:
    """Pull recent media on the authenticated account. Basic Display token
    only sees the user's own posts — comments / DMs need the Graph API
    business token, which we surface if the token works against /me/media."""
    state = _load_state()
    last_seen = (state.get("instagram") or {}).get("last_seen_id")
    fields = "id,caption,media_type,media_url,permalink,timestamp,username"
    url = (f"{INSTAGRAM_API}/me/media?fields={fields}"
           f"&limit=20&access_token={urllib.parse.quote(token)}")
    status, body, _ = _http_get(url)
    if status == 401:
        _log("instagram token rejected (401) — may have expired")
        return []
    if status != 200:
        _log(f"instagram media failed status={status}")
        return []
    try:
        data = json.loads(body)
    except Exception:
        return []
    items = data.get("data") or []
    out: list[dict] = []
    new_last = last_seen
    for it in items:
        mid = it.get("id")
        if not mid:
            continue
        if new_last is None:
            new_last = mid
        ts = _parse_iso(it.get("timestamp"))
        out.append({
            "platform": "instagram",
            "id": f"instagram:{mid}",
            "kind": "post",
            "from_handle": "@" + (it.get("username") or "you"),
            "from_name": it.get("username") or "(self)",
            "text": (it.get("caption") or "")[:1000],
            "url": it.get("permalink") or "",
            "timestamp": ts,
            "datetime": _format_ts(ts),
            "raw_id": mid,
            "media_type": it.get("media_type"),
            "is_dm": False,
        })
    if new_last and new_last != last_seen:
        state.setdefault("instagram", {})["last_seen_id"] = new_last
        _save_state(state)
    return out


def _instagram_post(_token: str, _content: str) -> dict:
    # Posting to Instagram via Graph requires a published-at media URL plus
    # the Container/Publish two-step. Out of scope for v1 — explicit error.
    return {"error": "instagram posting not implemented (Graph requires "
                     "media container + publish flow; pure-text posts are "
                     "not supported by IG itself)"}


# ── RSS feeds ───────────────────────────────────────────────────────
def _load_feeds() -> list[dict]:
    if not FEEDS_FILE.exists():
        return []
    try:
        data = json.loads(FEEDS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    for entry in data:
        if isinstance(entry, dict) and entry.get("url"):
            out.append({
                "url": entry["url"],
                "name": entry.get("name") or entry["url"],
                "priority": entry.get("priority") or "normal",
            })
    return out


def _save_feeds(feeds: list[dict]) -> None:
    SOCIAL_DIR.mkdir(parents=True, exist_ok=True)
    tmp = FEEDS_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(feeds, f, indent=2, ensure_ascii=False)
    os.replace(tmp, FEEDS_FILE)


class _StripHTML(HTMLParser):
    """Drops tags and collapses whitespace — RSS descriptions are usually
    HTML-encoded, but we cache plain text so the digest reads cleanly."""
    def __init__(self) -> None:
        super().__init__()
        self._buf: list[str] = []

    def handle_data(self, data: str) -> None:
        self._buf.append(data)

    def text(self) -> str:
        joined = "".join(self._buf)
        joined = html.unescape(joined)
        return re.sub(r"\s+", " ", joined).strip()


def _strip_html(s: str) -> str:
    if not s:
        return ""
    p = _StripHTML()
    try:
        p.feed(s)
        p.close()
    except Exception:
        return re.sub(r"<[^>]+>", "", s).strip()
    return p.text()


def _parse_rfc822_date(s: str) -> int:
    """Parse the variety of date strings RSS feeds emit. Falls back to 0."""
    if not s:
        return 0
    fmts = [
        "%a, %d %b %Y %H:%M:%S %z",
        "%a, %d %b %Y %H:%M:%S %Z",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S.%f%z",
        "%Y-%m-%d %H:%M:%S",
    ]
    for fmt in fmts:
        try:
            dt = datetime.strptime(s.strip(), fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp())
        except ValueError:
            continue
    return 0


def _rss_fetch_one(feed: dict) -> list[dict]:
    """Fetch one RSS or Atom feed. Tolerant of both formats — peeks at the
    root tag and dispatches accordingly."""
    status, body, _ = _http_get(
        feed["url"],
        headers={"User-Agent": "jarvis-social/1.0 (+rss-aggregator)"},
    )
    if status != 200 or not body:
        _log(f"rss fetch failed ({feed['url']}) status={status}")
        return []
    try:
        # Parse with a tolerant approach — feed.parser would be nicer but
        # we're stdlib only.
        root = ET.fromstring(body)
    except ET.ParseError as e:
        _log(f"rss parse failed ({feed['url']}): {e}")
        return []
    out: list[dict] = []
    tag = root.tag.lower()
    if tag.endswith("rss") or tag == "rss":
        # RSS 2.0 — items live under channel/item.
        for item in root.findall(".//item"):
            out.append(_rss_record_from_rss(item, feed))
    elif tag.endswith("feed"):
        # Atom — items are <entry> elements with the Atom namespace.
        ns = {"a": "http://www.w3.org/2005/Atom"}
        for entry in root.findall("a:entry", ns):
            out.append(_rss_record_from_atom(entry, feed, ns))
    return [r for r in out if r]


def _xml_text(node, path: str, ns: dict | None = None) -> str:
    if node is None:
        return ""
    el = node.find(path, ns) if ns else node.find(path)
    if el is None:
        return ""
    return (el.text or "").strip()


def _rss_record_from_rss(item, feed: dict) -> dict | None:
    title = _xml_text(item, "title")
    link = _xml_text(item, "link")
    desc = _xml_text(item, "description")
    pub = _xml_text(item, "pubDate")
    guid = _xml_text(item, "guid") or link or title
    if not guid:
        return None
    ts = _parse_rfc822_date(pub) or int(time.time())
    return {
        "platform": "rss",
        "id": f"rss:{feed.get('name') or feed['url']}:{guid}",
        "kind": "article",
        "from_handle": feed.get("name") or feed["url"],
        "from_name": feed.get("name") or feed["url"],
        "text": (title + ((" — " + _strip_html(desc)[:600]) if desc else "")).strip(),
        "url": link,
        "timestamp": ts,
        "datetime": _format_ts(ts),
        "raw_id": guid,
        "feed_priority": feed.get("priority", "normal"),
        "is_dm": False,
    }


def _rss_record_from_atom(entry, feed: dict, ns: dict) -> dict | None:
    title = _xml_text(entry, "a:title", ns)
    summary = _xml_text(entry, "a:summary", ns) or _xml_text(entry, "a:content", ns)
    pub = _xml_text(entry, "a:published", ns) or _xml_text(entry, "a:updated", ns)
    eid = _xml_text(entry, "a:id", ns)
    link_el = entry.find("a:link", ns)
    link = (link_el.attrib.get("href") if link_el is not None else "") or eid
    if not eid and not link:
        return None
    ts = _parse_rfc822_date(pub) or int(time.time())
    guid = eid or link
    return {
        "platform": "rss",
        "id": f"rss:{feed.get('name') or feed['url']}:{guid}",
        "kind": "article",
        "from_handle": feed.get("name") or feed["url"],
        "from_name": feed.get("name") or feed["url"],
        "text": (title + ((" — " + _strip_html(summary)[:600]) if summary else "")).strip(),
        "url": link,
        "timestamp": ts,
        "datetime": _format_ts(ts),
        "raw_id": guid,
        "feed_priority": feed.get("priority", "normal"),
        "is_dm": False,
    }


def _rss_fetch(_token: str) -> list[dict]:
    feeds = _load_feeds()
    if not feeds:
        return []
    out: list[dict] = []
    for feed in feeds:
        try:
            out.extend(_rss_fetch_one(feed))
        except Exception as e:
            _log(f"rss fetch crashed ({feed.get('url')}): {e}")
    return out


# ── Helpers ─────────────────────────────────────────────────────────
def _parse_iso(s: str | None) -> int:
    if not s:
        return int(time.time())
    try:
        # Twitter / Instagram both emit RFC3339; .replace handles "Z"
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except Exception:
        return _parse_rfc822_date(s) or int(time.time())


def _format_ts(ts: int | float | None) -> str:
    if not ts:
        return ""
    try:
        return (datetime.fromtimestamp(int(ts), tz=timezone.utc)
                .astimezone()
                .strftime("%Y-%m-%d %H:%M"))
    except Exception:
        return ""


# ── Polling ─────────────────────────────────────────────────────────
_FETCHERS = {
    "twitter": _twitter_fetch,
    "linkedin": _linkedin_fetch,
    "instagram": _instagram_fetch,
    "rss": _rss_fetch,
}


def poll_once(platform: str | None = None) -> dict:
    """Fetch any new items for `platform` (or every enabled platform).
    Honours per-platform `next_poll` timestamps so back-to-back calls don't
    bypass the rate-limit floor.

    Returns {ok, polled: {platform: stored_count}, errors}."""
    gate = _master_gate_check()
    if gate:
        return gate
    state = _load_state()
    targets = [platform] if platform else _enabled_platforms()
    polled: dict[str, int] = {}
    errors: list[str] = []
    now = time.time()
    for p in targets:
        if not _platform_enabled(p):
            continue
        ps = state.setdefault(p, {})
        if ps.get("next_poll") and now < ps["next_poll"]:
            polled[p] = 0
            continue
        token = _platform_token(p) or ""
        fetcher = _FETCHERS[p]
        try:
            records = fetcher(token)
        except Exception as e:
            errors.append(f"{p}: {e}")
            _log(f"poll {p} crashed: {e}")
            records = []
        stored = _append_records(p, records)
        polled[p] = stored
        ps["last_poll"] = int(now)
        ps["next_poll"] = int(now) + POLL_INTERVALS_S.get(p, 300)
        # If the platform pushed next_poll out itself (rate-limit branch),
        # don't shrink it back down — keep the larger of the two.
        ps["next_poll"] = max(ps["next_poll"], int(state.get(p, {}).get("next_poll") or 0))
    _save_state(state)
    return {"ok": True, "polled": polled, "errors": errors}


def poll_loop() -> None:
    """Run forever. Designed to be the wake-listener's daemon-thread target.
    Sleeps until the soonest enabled platform is due, then calls poll_once."""
    gate = _master_gate_check()
    if gate:
        _log(f"poll_loop refused to start: {gate['error']}")
        return
    # Single startup prune pass for every platform.
    for p in PLATFORMS:
        try:
            n = _prune_cache(p)
            if n:
                _log(f"startup prune {p}: {n}")
        except Exception:
            pass
    backoff = 5.0
    while True:
        try:
            poll_once()
        except KeyboardInterrupt:
            _log("poll_loop stopped by user")
            return
        except Exception as e:
            _log(f"poll_loop iteration crashed: {e}")
            time.sleep(min(backoff, 120))
            backoff = min(backoff * 2, 120)
            continue
        backoff = 5.0
        # Sleep until the closest next_poll across enabled platforms.
        state = _load_state()
        now = time.time()
        nexts = [
            (state.get(p) or {}).get("next_poll") or 0
            for p in _enabled_platforms()
        ]
        if not nexts:
            time.sleep(60)
            continue
        wait = max(5, min(n - now for n in nexts) if any(n > now for n in nexts) else 30)
        # Cap at 5 min so a clock skew can't deadlock us.
        time.sleep(min(wait, 300))


# ── Public: check_social ────────────────────────────────────────────
def check_social(platform: str | None = None, hours: int = 4) -> dict:
    """Return recent activity from cache."""
    gate = _master_gate_check()
    if gate:
        return gate
    if platform and platform not in PLATFORMS:
        return {"error": f"unknown platform {platform!r}"}
    targets = [platform] if platform else _enabled_platforms()
    if not targets:
        return {"error": "no social platforms configured"}
    since = time.time() - max(0, hours) * 3600
    items: list[dict] = []
    for p in targets:
        items.extend(_read_cache(p, since))
    items.sort(key=lambda r: r.get("timestamp") or 0, reverse=True)
    return {
        "ok": True,
        "items": items,
        "count": len(items),
        "hours": hours,
        "platforms": targets,
    }


# ── Public: social_search ───────────────────────────────────────────
def social_search(query: str, platform: str | None = None,
                  hours: int = 48) -> dict:
    gate = _master_gate_check()
    if gate:
        return gate
    query = (query or "").strip()
    if not query:
        return {"error": "query is required"}
    res = check_social(platform=platform, hours=hours)
    if res.get("error"):
        return res
    q = query.lower()
    hits = [
        i for i in res["items"]
        if q in (i.get("text") or "").lower()
        or q in (i.get("from_handle") or "").lower()
        or q in (i.get("from_name") or "").lower()
    ]
    return {"ok": True, "query": query, "hits": hits, "count": len(hits)}


# ── Public: social_digest ───────────────────────────────────────────
DIGEST_SYSTEM = """You are summarizing one social platform's activity for Watson.

Output ONE valid JSON object — no prose, no fences. Schema:

{
  "summary": "1-2 sentences in past tense, EA register. What appeared, who's notable, what's open.",
  "action_items": ["Things directed at Watson that he should personally handle. Empty list if none."],
  "urgent": true | false,
  "key_topics": ["short", "noun", "phrases"]
}

Rules:
- urgent=true ONLY when there's a direct DM to Watson, an @mention from a known contact, or a deadline today/tomorrow. Default false.
- action_items list each as one imperative phrase ("Reply to @karina re Tuesday demo"). Drop items already resolved.
- If the activity is just noise / promo / ambient browsing, say so plainly and action_items=[]/urgent=false.
- Quantify when useful (e.g. "three @mentions, two from strangers").
"""


def _anthropic_call(api_key: str, model: str, system: str,
                    user_text: str, max_tokens: int = 600,
                    timeout: float = 25.0) -> str:
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
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last_err = e
            if attempt < 2:
                time.sleep(1 + attempt * 1.5)
                continue
            raise RuntimeError(f"network: {e}") from e
    raise RuntimeError(f"unexpected: {last_err}")


def _summarize_platform(platform: str, items: list[dict],
                        api_key: str) -> dict:
    if not items:
        return {"summary": "No activity.", "action_items": [],
                "urgent": False, "key_topics": []}
    trimmed = items[-DIGEST_MAX_PER_PLATFORM:]
    lines = []
    for it in trimmed:
        ts = _format_ts(it.get("timestamp"))
        sender = it.get("from_handle") or it.get("from_name") or "?"
        text = (it.get("text") or "").replace("\n", " ")[:400]
        lines.append(f"[{ts}] {sender}: {text}")
    transcript = "\n".join(lines)
    prompt = f"Platform: {platform}\nItems ({len(trimmed)}):\n\n{transcript}"
    try:
        raw = _anthropic_call(api_key, DIGEST_MODEL, DIGEST_SYSTEM, prompt,
                               max_tokens=500, timeout=20)
    except Exception as e:
        return {"summary": f"Summary failed: {e}", "action_items": [],
                "urgent": False, "key_topics": []}
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return {"summary": raw[:300], "action_items": [],
                "urgent": False, "key_topics": []}
    try:
        parsed = json.loads(m.group(0))
    except json.JSONDecodeError:
        return {"summary": raw[:300], "action_items": [],
                "urgent": False, "key_topics": []}
    parsed.setdefault("summary", "")
    parsed.setdefault("action_items", [])
    parsed.setdefault("urgent", False)
    parsed.setdefault("key_topics", [])
    return parsed


def social_digest(hours: int = 12) -> dict:
    """Per-platform AI summary. Returns {ok, platforms: [{name, item_count,
    summary, action_items, urgent, key_topics}]}."""
    gate = _master_gate_check()
    if gate:
        return gate
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {"error": "ANTHROPIC_API_KEY not set"}
    targets = _enabled_platforms()
    if not targets:
        return {"ok": True, "platforms": [], "hours": hours,
                "hint": "no social platforms configured"}
    since = time.time() - max(0, hours) * 3600
    out: list[dict] = []
    for p in targets:
        items = _read_cache(p, since)
        if not items:
            continue
        summ = _summarize_platform(p, items, api_key)
        out.append({
            "name": p,
            "item_count": len(items),
            "summary": summ.get("summary") or "",
            "action_items": summ.get("action_items") or [],
            "urgent": bool(summ.get("urgent")),
            "key_topics": summ.get("key_topics") or [],
        })
    out.sort(key=lambda b: (not b.get("urgent"), -b.get("item_count", 0)))
    return {"ok": True, "platforms": out, "hours": hours}


# ── Public: social_post ─────────────────────────────────────────────
_POSTERS = {
    "twitter": _twitter_post,
    "linkedin": _linkedin_post,
    "instagram": _instagram_post,
}


def _check_post_args(platform: str, content: str) -> dict | None:
    if platform not in PLATFORMS:
        return {"error": f"unknown platform {platform!r}"}
    if platform == "rss":
        return {"error": "rss is read-only"}
    if not _platform_enabled(platform):
        return {"error": f"{platform} not configured / disabled"}
    if not content or not content.strip():
        return {"error": "content is required"}
    limit = CHAR_LIMITS.get(platform, 0)
    if limit and len(content) > limit:
        return {"error": f"content {len(content)} chars exceeds {platform} "
                         f"limit of {limit}"}
    return None


def social_post(platform: str, content: str, confirm: bool = False) -> dict:
    """Publish a new post. confirm=True required (preview-then-confirm
    flow, same as send_email / send_telegram)."""
    gate = _master_gate_check()
    if gate:
        return gate
    err = _check_post_args(platform, content)
    if err:
        return err
    if not confirm:
        return {
            "sent": False,
            "needs_confirmation": True,
            "platform": platform,
            "preview": content[:CHAR_LIMITS.get(platform, 280)],
            "char_count": len(content),
            "char_limit": CHAR_LIMITS.get(platform, 280),
            "hint": ("Read the preview to Watson. After he says yes, "
                     "re-call with confirm=true."),
        }
    token = _platform_token(platform) or ""
    poster = _POSTERS.get(platform)
    if not poster:
        return {"error": f"{platform} posting not supported"}
    res = poster(token, content)
    if isinstance(res, dict) and res.get("sent"):
        _log(f"posted to {platform}: {content[:80]}")
    return res


# ── Public: social_reply ────────────────────────────────────────────
def _find_cached(platform: str, item_id: str) -> dict | None:
    """Look up a cached record by id. Linear scan — caches stay small thanks
    to retention pruning, so no index needed."""
    path = _cache_path(platform)
    if not path.exists():
        return None
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
                if rec.get("id") == item_id or rec.get("raw_id") == item_id:
                    return rec
    except Exception as e:
        _log(f"find cached failed ({platform}): {e}")
    return None


def social_reply(platform: str, item_id: str, message: str,
                 confirm: bool = False) -> dict:
    """Reply to a cached item. confirm=True required."""
    gate = _master_gate_check()
    if gate:
        return gate
    err = _check_post_args(platform, message)
    if err:
        return err
    item = _find_cached(platform, item_id)
    if item is None:
        return {"error": f"no cached {platform} item with id {item_id!r}"}
    target = item.get("from_handle") or item.get("from_name") or "?"
    if not confirm:
        # Style only the preview round so Watson can edit. Lazy-load.
        styled = message
        try:
            styled = _maybe_apply_style(message, channel="social")
        except Exception:
            styled = message
        return {
            "sent": False,
            "needs_confirmation": True,
            "platform": platform,
            "in_reply_to": target,
            "original_text": (item.get("text") or "")[:240],
            "preview": styled[:CHAR_LIMITS.get(platform, 280)],
            "char_count": len(styled),
            "char_limit": CHAR_LIMITS.get(platform, 280),
            "hint": ("Read the preview and the original to Watson, then "
                     "ask 'Should I send it, sir?' Re-call with confirm=true."),
        }
    token = _platform_token(platform) or ""
    raw_id = item.get("raw_id") or item_id.split(":", 1)[-1]
    if platform == "twitter":
        res = _twitter_post(token, message, reply_to_tweet_id=raw_id)
    else:
        # LinkedIn / Instagram replies need their own quirks; punt for now.
        return {"error": f"{platform} reply not yet supported"}
    if isinstance(res, dict) and res.get("sent"):
        _log(f"replied on {platform} to {target}: {message[:80]}")
        # Best-effort: bump the contact record so the relationship pulse
        # learns about this exchange. Pass the sub-platform so the right
        # social_handle field gets backfilled.
        try:
            _maybe_note_contact(channel=f"social:{platform}",
                                handle=item.get("from_handle") or target,
                                summary=f"Replied on {platform}: {message[:120]}")
        except Exception:
            pass
    return res


# ── Style hook (lazy) ───────────────────────────────────────────────
def _maybe_apply_style(text: str, channel: str = "social") -> str:
    src = ASSISTANT_DIR / "bin" / "jarvis-style.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-style.py"
    if not src.exists():
        return text
    try:
        spec = importlib.util.spec_from_file_location("jarvis_style_social", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        res = mod.apply_style(text, channel=channel)
    except Exception as e:
        _log(f"style apply skipped: {e}")
        return text
    if isinstance(res, dict):
        return res.get("styled") or res.get("text") or text
    return text


# ── Contact note hook (lazy) ────────────────────────────────────────
def _maybe_note_contact(channel: str, handle: str, summary: str = "") -> None:
    src = ASSISTANT_DIR / "bin" / "jarvis-contacts.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-contacts.py"
    if not src.exists():
        return
    try:
        spec = importlib.util.spec_from_file_location("jarvis_contacts_social", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        mod.note_interaction(channel=channel, handle=handle, summary=summary)
    except Exception as e:
        _log(f"contacts note skipped: {e}")


# ── Hooks for jarvis-context / jarvis-notifications / wake-listener ─
_URGENT_RE = re.compile(
    r"\b(urgent|asap|deadline|please respond|need (you|your)|"
    r"hey watson|@watson|fire|critical)\b",
    re.I,
)


def recent_urgent(minutes: int = 10) -> list[dict]:
    """Items in the last `minutes` that look urgent — DMs, @mentions, or
    text that trips the urgency regex. Used by the wake-listener to drop
    a notification when a conversation ends."""
    if _master_gate_check():
        return []
    since = time.time() - max(0, minutes) * 60
    out: list[dict] = []
    for p in _enabled_platforms():
        for rec in _read_cache(p, since):
            text = rec.get("text") or ""
            kind = rec.get("kind") or ""
            is_urgent = (
                rec.get("is_dm")
                or kind in ("mention", "dm")
                or _URGENT_RE.search(text)
            )
            if is_urgent:
                out.append(rec)
    out.sort(key=lambda r: r.get("timestamp") or 0)
    return out


def unresponded_count() -> int:
    """Best-effort count of @mentions / DMs in the last 24h that look
    unresponded. Heuristic: any cached item whose kind is mention/dm AND
    whose timestamp is the most recent for that thread."""
    if _master_gate_check():
        return 0
    since = time.time() - 24 * 3600
    n = 0
    for p in _enabled_platforms():
        for rec in _read_cache(p, since):
            kind = rec.get("kind") or ""
            if kind in ("mention", "dm") or rec.get("is_dm"):
                n += 1
    return n


def context_hint() -> str:
    """One-liner for jarvis-context.py to inject when there's social
    traffic Watson hasn't seen. Empty in the common case so the cache
    breakpoint stays warm."""
    if os.environ.get("JARVIS_SOCIAL", _master_gate_default()) != "1":
        return ""
    n = unresponded_count()
    if not n:
        return ""
    return (
        f"**Social:** {n} mention{'s' if n != 1 else ''}/DM(s) on social "
        "platforms in the last 24h. If Watson asks 'catch me up on "
        "social' or similar, lead with `social_digest(hours=12)`."
    )


# ── Status / setup helpers ──────────────────────────────────────────
def status() -> dict:
    state = _load_state()
    breakdown = []
    for p in PLATFORMS:
        token = _platform_token(p)
        path = _cache_path(p)
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
                            if (rec.get("timestamp") or 0) > last_ts:
                                last_ts = rec["timestamp"]
                        except json.JSONDecodeError:
                            continue
            except Exception:
                pass
        breakdown.append({
            "platform": p,
            "configured": bool(token),
            "enabled": _platform_enabled(p),
            "cached_items": n,
            "last_item": _format_ts(last_ts) if last_ts else "",
            "next_poll": _format_ts((state.get(p) or {}).get("next_poll") or 0),
            "interval_s": POLL_INTERVALS_S.get(p, 300),
        })
    return {
        "ok": True,
        "master_enabled": os.environ.get("JARVIS_SOCIAL", _master_gate_default()) == "1",
        "platforms": breakdown,
        "feeds_count": len(_load_feeds()),
        "feeds_path": str(FEEDS_FILE),
    }


def add_rss_feed(url: str, name: str | None = None,
                 priority: str = "normal") -> dict:
    feeds = _load_feeds()
    if any(f["url"] == url for f in feeds):
        return {"error": f"feed already added: {url}"}
    feeds.append({
        "url": url,
        "name": name or url,
        "priority": priority if priority in ("high", "normal", "low") else "normal",
    })
    _save_feeds(feeds)
    return {"ok": True, "feed": feeds[-1], "count": len(feeds)}


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

    if cmd == "--status":
        print(json.dumps(status(), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--check":
        platform = _flag("--platform")
        hours = int(_flag("--hours", "4") or "4")
        print(json.dumps(check_social(platform=platform, hours=hours),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--digest":
        hours = int(_flag("--hours", "12") or "12")
        print(json.dumps(social_digest(hours=hours), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--search":
        if not rest or rest[0].startswith("--"):
            print("usage: --search QUERY [--platform X] [--hours N]",
                  file=sys.stderr)
            return 2
        query = rest[0]
        platform = _flag("--platform")
        hours = int(_flag("--hours", "48") or "48")
        print(json.dumps(social_search(query=query, platform=platform,
                                       hours=hours),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--post":
        if len(rest) < 2:
            print("usage: --post PLATFORM 'content' [--confirm]",
                  file=sys.stderr)
            return 2
        platform = rest[0]
        content = rest[1]
        confirm = "--confirm" in rest
        print(json.dumps(social_post(platform=platform, content=content,
                                     confirm=confirm),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--reply":
        if len(rest) < 3:
            print("usage: --reply PLATFORM ITEM_ID 'message' [--confirm]",
                  file=sys.stderr)
            return 2
        platform = rest[0]
        item_id = rest[1]
        message = rest[2]
        confirm = "--confirm" in rest
        print(json.dumps(social_reply(platform=platform, item_id=item_id,
                                      message=message, confirm=confirm),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--poll-once":
        platform = _flag("--platform")
        print(json.dumps(poll_once(platform=platform), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--poll-loop":
        try:
            poll_loop()
        except KeyboardInterrupt:
            return 0
        return 0
    if cmd == "--rss-add":
        if not rest or rest[0].startswith("--"):
            print("usage: --rss-add URL [--name X] [--priority high|normal|low]",
                  file=sys.stderr)
            return 2
        url = rest[0]
        name = _flag("--name")
        priority = _flag("--priority", "normal") or "normal"
        print(json.dumps(add_rss_feed(url, name=name, priority=priority),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--prune":
        platform = _flag("--platform")
        targets = [platform] if platform else list(PLATFORMS)
        out = {p: _prune_cache(p) for p in targets}
        print(json.dumps({"pruned": out}, indent=2))
        return 0
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
