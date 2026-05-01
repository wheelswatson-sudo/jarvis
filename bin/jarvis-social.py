#!/usr/bin/env python3
"""Social media monitoring — Twitter, LinkedIn, Instagram, RSS.

Watson tells Jarvis which handles / pages / feeds to watch; this module pulls
recent activity, summarizes it, and surfaces replies/comments aimed at him.
Stdlib-only HTTP (urllib + xml.etree), matching jarvis-telegram.py's shape.

Each platform is independent — missing credentials simply disable that one.
The four authentications are:

    Twitter    TWITTER_BEARER_TOKEN     API v2, read-only with bearer
    LinkedIn   LINKEDIN_COOKIE          Voyager API — EXPERIMENTAL, may break
    Instagram  INSTAGRAM_ACCESS_TOKEN   Graph API (Business / Creator account)
    RSS        (none)                   any feed URL the user adds

Public functions (all return JSON-serializable dicts so jarvis-think wires
them straight into the tool layer):

    check_social(platform=None, hours=4)
        Recent items from the local cache, optionally filtered to one
        platform ("twitter" / "linkedin" / "instagram" / "rss").

    social_digest(hours=12, platform=None)
        Per-platform AI summary via Haiku. Identifies replies/mentions
        directed at Watson, trending topics, urgent threads.

    social_reply(platform, item_id, message, confirm=False)
        Reply to a specific tweet/post/comment. confirm=True required —
        same safety net as send_telegram.

    social_post(platform, message, confirm=False)
        Publish a new top-level post. confirm=True required.

    social_search(query, platform=None, hours=48)
        Substring search across the cache.

CLI:
    bin/jarvis-social.py --setup
    bin/jarvis-social.py --status
    bin/jarvis-social.py --check [platform] [--hours N]
    bin/jarvis-social.py --digest [--platform X] [--hours N]
    bin/jarvis-social.py --search "query" [--platform X] [--hours N]
    bin/jarvis-social.py --reply PLATFORM ITEM_ID "message" [--confirm]
    bin/jarvis-social.py --post PLATFORM "message" [--confirm]
    bin/jarvis-social.py --poll-once
    bin/jarvis-social.py --poll-loop

Files written:
    ~/.jarvis/social/config.json                monitored handles + feeds
    ~/.jarvis/social/state.json                 rate limits + last-seen cursors
    ~/.jarvis/social/cache/{platform}.jsonl     append-only message log
    ~/.jarvis/logs/social.log                   diagnostic log

Gate:
    JARVIS_SOCIAL=1                  master gate (default 1)
    JARVIS_SOCIAL_TWITTER            per-platform; auto-on iff token set
    JARVIS_SOCIAL_LINKEDIN           per-platform; auto-on iff cookie set
    JARVIS_SOCIAL_INSTAGRAM          per-platform; auto-on iff token set
    JARVIS_SOCIAL_RSS=1              per-platform (default 1, no creds needed)
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
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
SOCIAL_DIR = ASSISTANT_DIR / "social"
CONFIG_FILE = SOCIAL_DIR / "config.json"
STATE_FILE = SOCIAL_DIR / "state.json"
CACHE_DIR = SOCIAL_DIR / "cache"
LOG_DIR = ASSISTANT_DIR / "logs"
SOCIAL_LOG = LOG_DIR / "social.log"

PLATFORMS = ("twitter", "linkedin", "instagram", "rss")

HTTP_TIMEOUT_S = float(os.environ.get("JARVIS_SOCIAL_HTTP_TIMEOUT_S", "10"))
CACHE_RETENTION_DAYS = int(os.environ.get("JARVIS_SOCIAL_RETENTION_DAYS", "7"))
DIGEST_MODEL = os.environ.get("JARVIS_SOCIAL_DIGEST_MODEL", "claude-haiku-4-5-20251001")
DIGEST_MAX_ITEMS = int(os.environ.get("JARVIS_SOCIAL_DIGEST_MAX", "40"))

# Per-platform poll cadence (seconds). Conservative defaults — chosen so a
# 24h run stays well under each platform's free-tier rate limit budget.
POLL_INTERVALS = {
    "twitter": int(os.environ.get("JARVIS_SOCIAL_TWITTER_INTERVAL_S", "180")),
    "linkedin": int(os.environ.get("JARVIS_SOCIAL_LINKEDIN_INTERVAL_S", "300")),
    "instagram": int(os.environ.get("JARVIS_SOCIAL_INSTAGRAM_INTERVAL_S", "600")),
    "rss": int(os.environ.get("JARVIS_SOCIAL_RSS_INTERVAL_S", "300")),
}


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
def _master_gate() -> bool:
    return os.environ.get("JARVIS_SOCIAL", "1") == "1"


def _platform_default_gate(platform: str) -> str:
    """auto-on iff the platform's credential is configured. RSS has no
    credential — defaults on outright."""
    if platform == "twitter":
        return "1" if os.environ.get("TWITTER_BEARER_TOKEN") else "0"
    if platform == "linkedin":
        return "1" if os.environ.get("LINKEDIN_COOKIE") else "0"
    if platform == "instagram":
        return "1" if os.environ.get("INSTAGRAM_ACCESS_TOKEN") else "0"
    if platform == "rss":
        return "1"
    return "0"


def _platform_enabled(platform: str) -> bool:
    if not _master_gate():
        return False
    env_var = f"JARVIS_SOCIAL_{platform.upper()}"
    return os.environ.get(env_var, _platform_default_gate(platform)) == "1"


def _gate_check_master() -> dict | None:
    if not _master_gate():
        return {"error": "social disabled (JARVIS_SOCIAL=0)"}
    return None


def _gate_check_platform(platform: str) -> dict | None:
    gate = _gate_check_master()
    if gate:
        return gate
    if platform not in PLATFORMS:
        return {"error": f"unknown platform {platform!r}"}
    if not _platform_enabled(platform):
        return {"error": f"{platform} disabled or not configured"}
    return None


def enabled_platforms() -> list[str]:
    return [p for p in PLATFORMS if _platform_enabled(p)]


# ── Config + state persistence ──────────────────────────────────────
DEFAULT_CONFIG: dict[str, Any] = {
    "twitter": {"watch_handles": [], "watch_self_mentions": True, "self_handle": ""},
    "linkedin": {"watch_self_feed": True},
    "instagram": {"watch_user_id": "", "watch_hashtags": []},
    "rss": {"feeds": []},
}


def _load_config() -> dict:
    if not CONFIG_FILE.exists():
        return json.loads(json.dumps(DEFAULT_CONFIG))
    try:
        with CONFIG_FILE.open() as f:
            data = json.load(f)
    except Exception:
        return json.loads(json.dumps(DEFAULT_CONFIG))
    if not isinstance(data, dict):
        return json.loads(json.dumps(DEFAULT_CONFIG))
    for k, v in DEFAULT_CONFIG.items():
        data.setdefault(k, v)
    return data


def _save_config(cfg: dict) -> None:
    SOCIAL_DIR.mkdir(parents=True, exist_ok=True)
    with CONFIG_FILE.open("w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)


def _load_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        with STATE_FILE.open() as f:
            data = json.load(f)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _save_state(state: dict) -> None:
    SOCIAL_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".json.tmp")
    with tmp.open("w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
    os.replace(tmp, STATE_FILE)


def _platform_state(state: dict, platform: str) -> dict:
    s = state.setdefault(platform, {})
    s.setdefault("last_poll_ts", 0)
    s.setdefault("rate_limit_reset", 0)  # epoch seconds; 0 = unknown
    s.setdefault("rate_limit_remaining", None)
    s.setdefault("seen_ids", [])  # cap below
    return s


def _record_seen(state: dict, platform: str, item_id: str) -> None:
    """Track recently-seen item ids per platform so we don't re-cache the same
    tweet/post on every poll. Capped to avoid unbounded growth."""
    s = _platform_state(state, platform)
    seen = s["seen_ids"]
    if item_id in seen:
        return
    seen.append(item_id)
    if len(seen) > 500:
        del seen[: len(seen) - 500]


def _is_seen(state: dict, platform: str, item_id: str) -> bool:
    return item_id in _platform_state(state, platform).get("seen_ids", [])


# ── Cache I/O (per-platform JSONL) ──────────────────────────────────
def _cache_path(platform: str) -> Path:
    return CACHE_DIR / f"{platform}.jsonl"


def _append_item(record: dict) -> None:
    """Append one social item to its platform cache. Best-effort — losing one
    item is preferable to crashing the polling thread."""
    platform = record.get("platform")
    if not platform:
        return
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with _cache_path(platform).open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as e:
        _log(f"cache append failed ({platform}): {e}")


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
                if rec.get("timestamp", 0) >= since_ts:
                    out.append(rec)
    except Exception as e:
        _log(f"cache read failed ({platform}): {e}")
    return out


def _prune_cache(retention_days: int = CACHE_RETENTION_DAYS) -> int:
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
                        pruned += 1
                        continue
                    if rec.get("timestamp", 0) >= cutoff:
                        kept.append(line)
                    else:
                        pruned += 1
            if pruned:
                with path.open("w", encoding="utf-8") as f:
                    f.write("\n".join(kept) + ("\n" if kept else ""))
        except Exception as e:
            _log(f"cache prune failed ({path.name}): {e}")
    if pruned:
        _log(f"pruned {pruned} cache items older than {retention_days}d")
    return pruned


# ── Generic HTTP ────────────────────────────────────────────────────
def _http_request(url: str, method: str = "GET", headers: dict | None = None,
                  body: bytes | None = None, timeout: float | None = None
                  ) -> tuple[int, dict, bytes]:
    """Single request. Returns (status, response_headers, body). On network
    failure raises — callers convert to {"error": ...}."""
    req = urllib.request.Request(url, data=body, method=method,
                                  headers=headers or {})
    eff_timeout = timeout if timeout is not None else HTTP_TIMEOUT_S
    try:
        with urllib.request.urlopen(req, timeout=eff_timeout) as r:
            data = r.read()
            return r.status, dict(r.headers.items()), data
    except urllib.error.HTTPError as e:
        try:
            data = e.read()
        except Exception:
            data = b""
        return e.code, dict(e.headers.items() if e.headers else []), data


# ── Twitter (API v2) ────────────────────────────────────────────────
TWITTER_API = "https://api.twitter.com/2"


def _twitter_headers() -> dict:
    return {
        "Authorization": f"Bearer {os.environ.get('TWITTER_BEARER_TOKEN', '')}",
        "User-Agent": "jarvis-social/1.0",
    }


def _twitter_apply_rate_limit(state: dict, headers: dict) -> None:
    rem = headers.get("x-rate-limit-remaining")
    reset = headers.get("x-rate-limit-reset")
    s = _platform_state(state, "twitter")
    if rem is not None:
        try:
            s["rate_limit_remaining"] = int(rem)
        except ValueError:
            pass
    if reset is not None:
        try:
            s["rate_limit_reset"] = int(reset)
        except ValueError:
            pass


def _twitter_user_id(handle: str) -> str | None:
    """Resolve @handle to user_id via /2/users/by/username. One call per handle
    per session; result is memoized in state for 24h."""
    state = _load_state()
    cache = state.setdefault("twitter_user_id_cache", {})
    h = handle.lstrip("@").lower()
    rec = cache.get(h)
    if rec and (time.time() - (rec.get("ts") or 0)) < 86400:
        return rec.get("id")
    url = f"{TWITTER_API}/users/by/username/{urllib.parse.quote(h)}"
    try:
        status, headers, body = _http_request(url, headers=_twitter_headers())
    except Exception as e:
        _log(f"twitter user lookup failed ({h}): {e}")
        return None
    _twitter_apply_rate_limit(state, headers)
    if status != 200:
        _log(f"twitter user lookup {status} for {h}: {body[:200]!r}")
        _save_state(state)
        return None
    try:
        data = json.loads(body)
        uid = (data.get("data") or {}).get("id")
    except Exception:
        uid = None
    if uid:
        cache[h] = {"id": uid, "ts": time.time()}
        _save_state(state)
    return uid


def _twitter_poll(state: dict) -> int:
    """Pull recent tweets from each watched handle and (optionally) the user's
    own mentions. Returns count of new items stored."""
    cfg = _load_config().get("twitter", {})
    handles = cfg.get("watch_handles") or []
    self_handle = (cfg.get("self_handle") or "").strip().lstrip("@")
    watch_self = bool(cfg.get("watch_self_mentions")) and self_handle
    new_items = 0

    for handle in handles:
        uid = _twitter_user_id(handle)
        if not uid:
            continue
        url = (f"{TWITTER_API}/users/{uid}/tweets"
               "?max_results=10&tweet.fields=created_at,public_metrics,referenced_tweets")
        try:
            status, headers, body = _http_request(url, headers=_twitter_headers())
        except Exception as e:
            _log(f"twitter tweets fetch failed ({handle}): {e}")
            continue
        _twitter_apply_rate_limit(state, headers)
        if status == 429:
            _log(f"twitter rate-limited on {handle}")
            break
        if status != 200:
            _log(f"twitter tweets fetch {status} for {handle}: {body[:200]!r}")
            continue
        try:
            data = json.loads(body)
        except Exception:
            continue
        for tw in data.get("data") or []:
            tid = tw.get("id")
            if not tid or _is_seen(state, "twitter", f"tweet:{tid}"):
                continue
            ts = _parse_iso8601(tw.get("created_at"))
            metrics = tw.get("public_metrics") or {}
            _append_item({
                "platform": "twitter",
                "kind": "tweet",
                "item_id": tid,
                "author": handle.lstrip("@"),
                "text": tw.get("text") or "",
                "timestamp": ts,
                "url": f"https://twitter.com/{handle.lstrip('@')}/status/{tid}",
                "extra": {
                    "likes": metrics.get("like_count"),
                    "replies": metrics.get("reply_count"),
                    "retweets": metrics.get("retweet_count"),
                },
            })
            _record_seen(state, "twitter", f"tweet:{tid}")
            new_items += 1

    if watch_self:
        uid = _twitter_user_id(self_handle)
        if uid:
            url = (f"{TWITTER_API}/users/{uid}/mentions"
                   "?max_results=10&tweet.fields=created_at,author_id"
                   "&expansions=author_id&user.fields=username,name")
            try:
                status, headers, body = _http_request(url, headers=_twitter_headers())
            except Exception as e:
                _log(f"twitter mentions fetch failed: {e}")
                status = 0
                body = b""
            _twitter_apply_rate_limit(state, headers if status else {})
            if status == 200:
                try:
                    data = json.loads(body)
                except Exception:
                    data = {}
                authors = {u.get("id"): u for u in
                            (data.get("includes") or {}).get("users") or []}
                for tw in data.get("data") or []:
                    tid = tw.get("id")
                    if not tid or _is_seen(state, "twitter", f"mention:{tid}"):
                        continue
                    author = authors.get(tw.get("author_id")) or {}
                    ts = _parse_iso8601(tw.get("created_at"))
                    _append_item({
                        "platform": "twitter",
                        "kind": "mention",
                        "item_id": tid,
                        "author": author.get("username") or "(unknown)",
                        "author_name": author.get("name") or "",
                        "text": tw.get("text") or "",
                        "timestamp": ts,
                        "url": f"https://twitter.com/{author.get('username') or 'i'}/status/{tid}",
                        "directed_at_self": True,
                    })
                    _record_seen(state, "twitter", f"mention:{tid}")
                    new_items += 1
    return new_items


def _parse_iso8601(s: str | None) -> int:
    if not s:
        return int(time.time())
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except Exception:
        return int(time.time())


def _twitter_search_api(query: str, max_results: int = 25) -> dict:
    """Live recent search — used when local cache search misses. Bearer-only
    is fine for /search/recent. Most plans cap at ~450 reqs/15min."""
    if not os.environ.get("TWITTER_BEARER_TOKEN"):
        return {"error": "TWITTER_BEARER_TOKEN not set"}
    url = (f"{TWITTER_API}/tweets/search/recent"
           f"?query={urllib.parse.quote(query)}"
           f"&max_results={max(10, min(100, max_results))}"
           "&tweet.fields=created_at,author_id&expansions=author_id"
           "&user.fields=username")
    try:
        status, _, body = _http_request(url, headers=_twitter_headers())
    except Exception as e:
        return {"error": f"network: {e}"}
    if status != 200:
        return {"error": f"twitter search {status}: {body[:200]!r}"}
    try:
        data = json.loads(body)
    except Exception as e:
        return {"error": f"parse: {e}"}
    authors = {u.get("id"): u.get("username") for u in
                (data.get("includes") or {}).get("users") or []}
    return {"ok": True, "results": [
        {
            "item_id": t.get("id"),
            "author": authors.get(t.get("author_id")) or "?",
            "text": t.get("text") or "",
            "timestamp": _parse_iso8601(t.get("created_at")),
            "url": f"https://twitter.com/i/status/{t.get('id')}",
        }
        for t in (data.get("data") or [])
    ]}


def _twitter_post(text: str, reply_to: str | None = None) -> dict:
    """POST /2/tweets requires user-context OAuth (TWITTER_OAUTH_*); bearer
    alone can't write. We surface a clear error rather than silently failing."""
    if not os.environ.get("TWITTER_OAUTH_USER_TOKEN"):
        return {"error": (
            "twitter post requires user-context OAuth, not just bearer. "
            "Set TWITTER_OAUTH_USER_TOKEN (PKCE access token) to enable. "
            "Skipping."
        )}
    body: dict = {"text": text}
    if reply_to:
        body["reply"] = {"in_reply_to_tweet_id": str(reply_to)}
    headers = {
        "Authorization": f"Bearer {os.environ['TWITTER_OAUTH_USER_TOKEN']}",
        "Content-Type": "application/json",
        "User-Agent": "jarvis-social/1.0",
    }
    try:
        status, _, resp = _http_request(
            f"{TWITTER_API}/tweets", method="POST",
            headers=headers, body=json.dumps(body).encode(),
        )
    except Exception as e:
        return {"error": f"network: {e}"}
    if status not in (200, 201):
        return {"error": f"twitter post {status}: {resp[:200]!r}"}
    try:
        data = json.loads(resp)
    except Exception:
        data = {}
    return {"ok": True, "id": (data.get("data") or {}).get("id"),
            "url": f"https://twitter.com/i/status/{(data.get('data') or {}).get('id')}"}


# ── LinkedIn (Voyager — experimental) ───────────────────────────────
LINKEDIN_VOYAGER = "https://www.linkedin.com/voyager/api"


def _linkedin_headers() -> dict | None:
    cookie = os.environ.get("LINKEDIN_COOKIE", "").strip()
    if not cookie:
        return None
    csrf = _extract_jsessionid(cookie)
    if not csrf:
        return None
    return {
        "Cookie": cookie,
        "Csrf-Token": csrf,
        "Accept": "application/vnd.linkedin.normalized+json+2.1",
        "X-Restli-Protocol-Version": "2.0.0",
        "User-Agent": "Mozilla/5.0 jarvis-social/1.0",
    }


def _extract_jsessionid(cookie: str) -> str | None:
    """LinkedIn Voyager wants the JSESSIONID value as the CSRF token, with
    quotes stripped. Returns None if not present."""
    m = re.search(r"JSESSIONID=\"?([^;\"]+)\"?", cookie)
    return m.group(1) if m else None


def _linkedin_poll(state: dict) -> int:
    """Pull the user's own feed updates. Voyager's feed endpoint isn't
    documented; this is best-effort and may break with any LinkedIn change.
    Stays read-only by design — TOS-grey and breakable."""
    headers = _linkedin_headers()
    if headers is None:
        _log("linkedin: missing cookie or JSESSIONID")
        return 0
    url = (f"{LINKEDIN_VOYAGER}/feed/updates"
           "?count=10&q=chronFeed")
    try:
        status, _, body = _http_request(url, headers=headers)
    except Exception as e:
        _log(f"linkedin fetch failed: {e}")
        return 0
    if status == 401 or status == 403:
        _log(f"linkedin auth failed ({status}) — refresh LINKEDIN_COOKIE")
        return 0
    if status != 200:
        _log(f"linkedin fetch {status}: {body[:200]!r}")
        return 0
    try:
        data = json.loads(body)
    except Exception as e:
        _log(f"linkedin parse failed: {e}")
        return 0
    new_items = 0
    elements = data.get("elements") or data.get("included") or []
    for el in elements:
        urn = el.get("urn") or el.get("entityUrn") or ""
        if not urn or _is_seen(state, "linkedin", urn):
            continue
        text = (((el.get("commentary") or {}).get("text") or {}).get("text")
                or el.get("text") or "")
        actor = ((el.get("actor") or {}).get("name") or {}).get("text") or ""
        ts = el.get("createdAt") or el.get("publishedAt") or int(time.time() * 1000)
        try:
            ts = int(int(ts) // 1000) if int(ts) > 1e11 else int(ts)
        except Exception:
            ts = int(time.time())
        if not text and not actor:
            continue
        _append_item({
            "platform": "linkedin",
            "kind": "feed_post",
            "item_id": urn,
            "author": actor or "(unknown)",
            "text": text[:1200],
            "timestamp": ts,
            "url": f"https://www.linkedin.com/feed/update/{urn}",
        })
        _record_seen(state, "linkedin", urn)
        new_items += 1
    return new_items


def _linkedin_post(text: str, reply_to: str | None = None) -> dict:
    """LinkedIn writes via Voyager are explicitly TOS-violating. We refuse
    here and surface a clear message. If Watson wants automated posting,
    that's the official Marketing API path with an OAuth app."""
    return {"error": (
        "linkedin posting via Voyager cookie is not supported (TOS risk). "
        "Use the LinkedIn Marketing API with an OAuth app for automated posts."
    )}


# ── Instagram (Graph API) ───────────────────────────────────────────
IG_GRAPH = "https://graph.instagram.com"


def _instagram_poll(state: dict) -> int:
    token = os.environ.get("INSTAGRAM_ACCESS_TOKEN", "")
    if not token:
        return 0
    cfg = _load_config().get("instagram", {})
    user_id = (cfg.get("watch_user_id") or "me").strip() or "me"
    fields = "id,caption,media_type,permalink,timestamp,like_count,comments_count"
    url = (f"{IG_GRAPH}/{urllib.parse.quote(user_id)}/media"
           f"?fields={fields}&access_token={urllib.parse.quote(token)}&limit=15")
    try:
        status, _, body = _http_request(url)
    except Exception as e:
        _log(f"instagram fetch failed: {e}")
        return 0
    if status != 200:
        _log(f"instagram fetch {status}: {body[:200]!r}")
        return 0
    try:
        data = json.loads(body)
    except Exception:
        return 0
    new_items = 0
    for m in data.get("data") or []:
        mid = m.get("id")
        if not mid or _is_seen(state, "instagram", mid):
            continue
        ts = _parse_iso8601(m.get("timestamp"))
        _append_item({
            "platform": "instagram",
            "kind": m.get("media_type", "post").lower(),
            "item_id": mid,
            "author": "self",
            "text": m.get("caption") or "",
            "timestamp": ts,
            "url": m.get("permalink") or "",
            "extra": {
                "likes": m.get("like_count"),
                "comments": m.get("comments_count"),
            },
        })
        _record_seen(state, "instagram", mid)
        new_items += 1
    return new_items


def _instagram_post(text: str, reply_to: str | None = None) -> dict:
    """Instagram Graph API requires a two-step container/publish flow plus
    an image_url for feed posts. Plain text-only posts aren't supported on
    the platform. We surface that constraint instead of silently failing."""
    return {"error": (
        "instagram doesn't support text-only feed posts — every post needs "
        "media. For DMs / comment replies use the Messaging API with the "
        "appropriate webhook setup. Skipping."
    )}


# ── RSS (no auth) ───────────────────────────────────────────────────
def _rss_poll(state: dict) -> int:
    feeds = (_load_config().get("rss") or {}).get("feeds") or []
    new_items = 0
    for entry in feeds:
        if isinstance(entry, str):
            feed_url, label = entry, ""
        else:
            feed_url = entry.get("url") or ""
            label = entry.get("label") or ""
        if not feed_url:
            continue
        try:
            req = urllib.request.Request(feed_url, headers={
                "User-Agent": "jarvis-social/1.0",
                "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml",
            })
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as r:
                body = r.read()
        except Exception as e:
            _log(f"rss fetch failed ({feed_url}): {e}")
            continue
        try:
            new_items += _rss_parse_and_store(state, body, feed_url, label)
        except Exception as e:
            _log(f"rss parse failed ({feed_url}): {e}")
            continue
    return new_items


def _rss_parse_and_store(state: dict, body: bytes, feed_url: str,
                          label: str) -> int:
    """Parse RSS or Atom, append new entries to cache. Returns count stored."""
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return 0
    new_items = 0
    tag = root.tag.lower()
    is_atom = tag.endswith("feed")
    items: list[ET.Element] = []
    if is_atom:
        items = list(root.findall("{http://www.w3.org/2005/Atom}entry"))
    else:
        items = list(root.findall(".//item"))
    for it in items:
        if is_atom:
            link_el = it.find("{http://www.w3.org/2005/Atom}link")
            link = link_el.get("href") if link_el is not None else ""
            iid = (it.findtext("{http://www.w3.org/2005/Atom}id") or link or "").strip()
            title = (it.findtext("{http://www.w3.org/2005/Atom}title") or "").strip()
            summary = (it.findtext("{http://www.w3.org/2005/Atom}summary")
                       or it.findtext("{http://www.w3.org/2005/Atom}content")
                       or "").strip()
            pub = (it.findtext("{http://www.w3.org/2005/Atom}published")
                   or it.findtext("{http://www.w3.org/2005/Atom}updated") or "")
        else:
            link = (it.findtext("link") or "").strip()
            iid = (it.findtext("guid") or link or it.findtext("title") or "").strip()
            title = (it.findtext("title") or "").strip()
            summary = (it.findtext("description") or "").strip()
            pub = (it.findtext("pubDate") or "")
        if not iid:
            continue
        seen_key = f"{feed_url}::{iid}"
        if _is_seen(state, "rss", seen_key):
            continue
        ts = _parse_rss_date(pub) or int(time.time())
        text = title + (("\n\n" + _strip_html(summary)) if summary else "")
        _append_item({
            "platform": "rss",
            "kind": "item",
            "item_id": iid,
            "author": label or _domain_from_url(feed_url),
            "text": text[:1500],
            "timestamp": ts,
            "url": link,
            "extra": {"feed": feed_url, "label": label},
        })
        _record_seen(state, "rss", seen_key)
        new_items += 1
    return new_items


def _domain_from_url(url: str) -> str:
    try:
        return urllib.parse.urlparse(url).netloc or url
    except Exception:
        return url


_HTML_TAG_RE = re.compile(r"<[^>]+>")
_HTML_ENTITY_RE = re.compile(r"&([#a-zA-Z0-9]+);")


def _strip_html(s: str) -> str:
    out = _HTML_TAG_RE.sub("", s or "")
    return _HTML_ENTITY_RE.sub(lambda m: {
        "amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'",
        "#39": "'", "nbsp": " ",
    }.get(m.group(1), m.group(0)), out).strip()


def _parse_rss_date(s: str) -> int | None:
    """Best-effort: RFC 822 (RSS) or ISO 8601 (Atom). Returns epoch seconds
    or None — caller falls back to now()."""
    s = (s or "").strip()
    if not s:
        return None
    try:
        return _parse_iso8601(s) if "T" in s or "-" in s.split(" ", 1)[0] else None
    except Exception:
        pass
    try:
        from email.utils import parsedate_to_datetime
        dt = parsedate_to_datetime(s)
        if dt is None:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except Exception:
        return None


# ── Polling orchestration ───────────────────────────────────────────
def poll_once() -> dict:
    """Single round across enabled platforms. Each platform respects its
    own min-interval — a tight loop won't hammer rate limits."""
    gate = _gate_check_master()
    if gate:
        return gate
    state = _load_state()
    now = time.time()
    out: dict[str, int] = {}
    errors: list[str] = []
    for p in PLATFORMS:
        if not _platform_enabled(p):
            continue
        s = _platform_state(state, p)
        # Honor a known rate-limit reset window before re-trying.
        if s.get("rate_limit_reset") and now < s["rate_limit_reset"]:
            continue
        if (now - (s.get("last_poll_ts") or 0)) < POLL_INTERVALS.get(p, 300):
            continue
        try:
            if p == "twitter":
                n = _twitter_poll(state)
            elif p == "linkedin":
                n = _linkedin_poll(state)
            elif p == "instagram":
                n = _instagram_poll(state)
            elif p == "rss":
                n = _rss_poll(state)
            else:
                n = 0
        except Exception as e:
            errors.append(f"{p}: {e}")
            _log(f"{p} poll crashed: {e}")
            continue
        s["last_poll_ts"] = int(now)
        out[p] = n
    _save_state(state)
    return {"ok": True, "fetched": out, "errors": errors}


def poll_loop() -> None:
    """Long-running poll loop for wake-listener's background thread.
    Sleeps min(POLL_INTERVALS) between rounds and lets each platform's own
    last_poll_ts decide whether to actually fire. Exits on KeyboardInterrupt."""
    if not _master_gate():
        _log("poll_loop refused to start: JARVIS_SOCIAL=0")
        return
    if not enabled_platforms():
        _log("poll_loop refused to start: no platforms enabled")
        return
    _prune_cache()
    backoff = 1.0
    base_sleep = max(30, min(POLL_INTERVALS.values()))
    while True:
        try:
            res = poll_once()
        except KeyboardInterrupt:
            _log("poll_loop stopped by user")
            return
        except Exception as e:
            _log(f"poll_loop iteration crashed: {e}")
            time.sleep(min(backoff, 120))
            backoff = min(backoff * 2, 120)
            continue
        if isinstance(res, dict) and res.get("error"):
            _log(f"poll_loop error: {res['error']}")
            time.sleep(min(backoff, 120))
            backoff = min(backoff * 2, 120)
            continue
        backoff = 1.0
        time.sleep(base_sleep)


# ── Public: check_social ────────────────────────────────────────────
def check_social(platform: str | None = None, hours: int = 4) -> dict:
    gate = _gate_check_master()
    if gate:
        return gate
    if platform and platform not in PLATFORMS:
        return {"error": f"unknown platform {platform!r}"}
    targets = [platform] if platform else enabled_platforms()
    if not targets:
        return {"error": "no platforms enabled — run `jarvis-social.py --setup`"}
    since = time.time() - max(0, hours) * 3600
    items: list[dict] = []
    for p in targets:
        for rec in _read_cache(p, since):
            items.append({
                "platform": rec.get("platform"),
                "kind": rec.get("kind"),
                "item_id": rec.get("item_id"),
                "author": rec.get("author"),
                "text": rec.get("text") or "",
                "timestamp": rec.get("timestamp"),
                "datetime": _format_ts(rec.get("timestamp")),
                "url": rec.get("url") or "",
                "directed_at_self": rec.get("directed_at_self", False),
                "extra": rec.get("extra") or {},
            })
    items.sort(key=lambda r: r.get("timestamp") or 0)
    return {"ok": True, "items": items, "count": len(items),
            "platforms": targets, "hours": hours}


def _format_ts(ts: int | float | None) -> str:
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    except Exception:
        return ""


# ── Public: social_search ───────────────────────────────────────────
def social_search(query: str, platform: str | None = None,
                   hours: int = 48) -> dict:
    gate = _gate_check_master()
    if gate:
        return gate
    query = (query or "").strip()
    if not query:
        return {"error": "query is required"}
    res = check_social(platform=platform, hours=hours)
    if res.get("error"):
        return res
    items = res["items"]
    q_lower = query.lower()
    hits = [m for m in items if q_lower in (m.get("text") or "").lower()
            or q_lower in (m.get("author") or "").lower()]
    return {"ok": True, "query": query, "hits": hits, "count": len(hits),
            "platforms": res["platforms"]}


# ── Public: social_digest ───────────────────────────────────────────
DIGEST_SYSTEM = """You are summarizing social media activity for Watson.

Output ONE valid JSON object — no prose, no fences. Schema:

{
  "summary": "2-3 sentences in past tense, EA register. What was posted, what got engagement, what needs his attention.",
  "action_items": ["Items directed at Watson he should personally handle. Empty list if none."],
  "urgent": true | false,
  "key_topics": ["short", "noun", "phrases"]
}

Rules:
- urgent=true ONLY when there's a direct mention/reply to Watson, a customer complaint, or something time-sensitive. Default false.
- action_items each as one imperative phrase ("Reply to @karina on the demo tweet").
- For RSS items, summary should pull the most-relevant headlines, not all of them.
- If there's nothing of substance, summary should say so plainly and action_items=[]/urgent=false.
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
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last_err = e
            if attempt < 2:
                time.sleep(1 + attempt * 1.5)
                continue
            raise RuntimeError(f"network: {e}") from e
    raise RuntimeError(f"unexpected: {last_err}")


def _summarize_platform(platform: str, items: list[dict], api_key: str) -> dict:
    if not items:
        return {"summary": "No activity.", "action_items": [],
                "urgent": False, "key_topics": []}
    trimmed = items[-DIGEST_MAX_ITEMS:]
    lines = []
    for it in trimmed:
        ts = _format_ts(it.get("timestamp"))
        author = it.get("author") or "(unknown)"
        text = (it.get("text") or "").strip().replace("\n", " ")
        kind = it.get("kind") or ""
        flag = " [→you]" if it.get("directed_at_self") else ""
        lines.append(f"[{ts}] ({kind}) {author}{flag}: {text}")
    transcript = "\n".join(lines)
    prompt = f"Platform: {platform}\nItems ({len(trimmed)}):\n\n{transcript}"
    try:
        raw = _anthropic_call(api_key, DIGEST_MODEL, DIGEST_SYSTEM, prompt,
                               max_tokens=600, timeout=20)
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


def social_digest(hours: int = 12, platform: str | None = None) -> dict:
    gate = _gate_check_master()
    if gate:
        return gate
    targets = [platform] if platform else enabled_platforms()
    if not targets:
        return {"error": "no platforms enabled"}
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {"error": "ANTHROPIC_API_KEY not set"}
    since = time.time() - max(0, hours) * 3600
    out: list[dict] = []
    for p in targets:
        cached = _read_cache(p, since)
        if not cached:
            continue
        prepped = [{
            "kind": r.get("kind"),
            "author": r.get("author"),
            "text": r.get("text") or "",
            "directed_at_self": r.get("directed_at_self", False),
            "timestamp": r.get("timestamp"),
        } for r in cached]
        summary = _summarize_platform(p, prepped, api_key)
        out.append({
            "platform": p,
            "item_count": len(cached),
            "summary": summary.get("summary") or "",
            "action_items": summary.get("action_items") or [],
            "urgent": bool(summary.get("urgent")),
            "key_topics": summary.get("key_topics") or [],
        })
    out.sort(key=lambda g: (not g.get("urgent"), -g.get("item_count", 0)))
    return {"ok": True, "platforms": out, "hours": hours}


# ── Public: social_post / social_reply ──────────────────────────────
def _maybe_apply_style(text: str, channel: str = "social") -> str:
    """Best-effort pass through jarvis-style.apply_style. Returns the styled
    text on success, original on any failure. Caller decides whether to
    re-style after Watson approves the preview (don't — same convention as
    send_telegram)."""
    if os.environ.get("JARVIS_STYLE_AUTOAPPLY", "1") != "1":
        return text
    style_src = ASSISTANT_DIR / "bin" / "jarvis-style.py"
    if not style_src.exists():
        style_src = Path(__file__).parent / "jarvis-style.py"
    if not style_src.exists():
        return text
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("jarvis_style_social", style_src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
    except Exception as e:
        _log(f"style load failed: {e}")
        return text
    try:
        # jarvis-style only declares email/telegram channels — passing an
        # unknown channel falls through to the "Mixed" register, which is
        # fine for tweets/LI posts/IG captions.
        res = mod.apply_style(text, channel=None)
    except Exception as e:
        _log(f"apply_style failed: {e}")
        return text
    if not isinstance(res, dict) or res.get("error"):
        return text
    return (res.get("styled") or text).strip() or text


def social_post(platform: str, message: str, confirm: bool = False) -> dict:
    gate = _gate_check_platform(platform)
    if gate:
        return gate
    if platform == "rss":
        return {"error": "rss is read-only"}
    if not message:
        return {"error": "message required"}
    if not confirm:
        styled = _maybe_apply_style(message)
        return {
            "sent": False,
            "needs_confirmation": True,
            "platform": platform,
            "preview": styled[:280] if platform == "twitter" else styled[:1000],
            "hint": (
                "Read the preview to Watson. After he says yes, re-call "
                "with confirm=true. The exact preview text will be posted."
            ),
        }
    if platform == "twitter":
        return _twitter_post(message)
    if platform == "linkedin":
        return _linkedin_post(message)
    if platform == "instagram":
        return _instagram_post(message)
    if platform == "rss":
        return {"error": "rss is read-only"}
    return {"error": f"unknown platform {platform!r}"}


def social_reply(platform: str, item_id: str, message: str,
                  confirm: bool = False) -> dict:
    gate = _gate_check_platform(platform)
    if gate:
        return gate
    if platform == "rss":
        return {"error": "rss is read-only"}
    if not item_id or not message:
        return {"error": "item_id and message required"}
    if not confirm:
        styled = _maybe_apply_style(message)
        return {
            "sent": False,
            "needs_confirmation": True,
            "platform": platform,
            "item_id": item_id,
            "preview": styled[:280] if platform == "twitter" else styled[:1000],
            "hint": "Read the preview to Watson. After he says yes, re-call with confirm=true.",
        }
    if platform == "twitter":
        return _twitter_post(message, reply_to=item_id)
    if platform == "linkedin":
        return _linkedin_post(message, reply_to=item_id)
    if platform == "instagram":
        return _instagram_post(message, reply_to=item_id)
    if platform == "rss":
        return {"error": "rss is read-only"}
    return {"error": f"unknown platform {platform!r}"}


# ── Urgency / hint helpers (for context + wake-listener) ────────────
_URGENT_RE = re.compile(
    r"\b(urgent|asap|emergency|now|outage|down|breaking|"
    r"please respond|@watson|hey watson|need (you|your)|"
    r"customer complaint|complaint|refund)\b",
    re.I,
)


def recent_urgent(minutes: int = 10) -> list[dict]:
    """Cache items from the last `minutes` that look urgent. Direct mentions
    auto-qualify. Cheap — pure local scan, no API call."""
    if not _master_gate():
        return []
    since = time.time() - max(0, minutes) * 60
    out: list[dict] = []
    for p in enabled_platforms():
        for rec in _read_cache(p, since):
            text = rec.get("text") or ""
            if not (rec.get("directed_at_self") or _URGENT_RE.search(text)):
                continue
            out.append({
                "platform": p,
                "kind": rec.get("kind"),
                "author": rec.get("author"),
                "text": text,
                "timestamp": rec.get("timestamp"),
                "item_id": rec.get("item_id"),
                "url": rec.get("url"),
                "directed_at_self": rec.get("directed_at_self", False),
            })
    out.sort(key=lambda r: r.get("timestamp") or 0)
    return out


def urgent_pending() -> int:
    """Count of platforms with urgent items in the last hour. Used by
    jarvis-context.context_hint for the system-prompt hint."""
    if not _master_gate():
        return 0
    since = time.time() - 3600
    flagged = 0
    for p in enabled_platforms():
        for rec in _read_cache(p, since):
            text = rec.get("text") or ""
            if rec.get("directed_at_self") or _URGENT_RE.search(text):
                flagged += 1
                break
    return flagged


def context_hint() -> str:
    """One-line system-prompt hint when there's urgent social traffic. Empty
    in the common case (keeps the cache warm). Same contract as
    jarvis-telegram.context_hint."""
    n = urgent_pending()
    if not n:
        return ""
    return (
        f"**Social:** {n} platform{'s' if n != 1 else ''} has activity "
        "in the last hour that looks urgent (direct mention, reply at you, "
        "or urgency keywords). If Watson asks 'anything urgent online' or "
        "similar, lead with `social_digest(hours=2)`."
    )


# ── Status / setup ──────────────────────────────────────────────────
def status() -> dict:
    cfg = _load_config()
    state = _load_state()
    out_platforms = []
    for p in PLATFORMS:
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
                            if rec.get("timestamp", 0) > last_ts:
                                last_ts = rec["timestamp"]
                        except json.JSONDecodeError:
                            continue
            except Exception:
                pass
        s = state.get(p, {})
        out_platforms.append({
            "platform": p,
            "enabled": _platform_enabled(p),
            "configured": _platform_default_gate(p) == "1",
            "cached_items": n,
            "last_item": _format_ts(last_ts) if last_ts else "",
            "last_poll": _format_ts(s.get("last_poll_ts")) if s.get("last_poll_ts") else "",
            "rate_limit_remaining": s.get("rate_limit_remaining"),
        })
    return {
        "ok": True,
        "master_gate": _master_gate(),
        "platforms": out_platforms,
        "config_path": str(CONFIG_FILE),
    }


SETUP_TEXT = """\
=== Jarvis social setup ===

Each platform is independent. Skip any you don't use.

  Twitter    needs TWITTER_BEARER_TOKEN  (read-only with bearer; set
                                          TWITTER_OAUTH_USER_TOKEN to enable
                                          posting/replying)
  LinkedIn   needs LINKEDIN_COOKIE      (full Cookie header from a logged-in
                                          browser session — EXPERIMENTAL,
                                          breaks if LinkedIn rotates schemas)
  Instagram  needs INSTAGRAM_ACCESS_TOKEN (Graph API token from a Business or
                                          Creator account linked to a FB Page)
  RSS        no auth                    (just add feed URLs)

Edit the watch lists in:
  {cfg}

Defaults wire up Twitter mentions on your handle and the user's own LinkedIn
feed. RSS starts empty — add feeds as you go.

After editing config, run --status to verify, then --poll-once to seed cache.
"""


def setup() -> int:
    SOCIAL_DIR.mkdir(parents=True, exist_ok=True)
    if not CONFIG_FILE.exists():
        _save_config(DEFAULT_CONFIG)
    print(SETUP_TEXT.format(cfg=CONFIG_FILE))
    return 0


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
        print(json.dumps(poll_once(), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--poll-loop":
        try:
            poll_loop()
        except KeyboardInterrupt:
            return 0
        return 0
    if cmd == "--check":
        platform = None
        if rest and not rest[0].startswith("--"):
            platform = rest[0]
        hours = int(_flag("--hours", "4") or "4")
        print(json.dumps(check_social(platform=platform, hours=hours),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--digest":
        platform = _flag("--platform")
        hours = int(_flag("--hours", "12") or "12")
        print(json.dumps(social_digest(hours=hours, platform=platform),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--search":
        if not rest or rest[0].startswith("--"):
            print("usage: --search QUERY [--platform X] [--hours N]", file=sys.stderr)
            return 2
        query = rest[0]
        platform = _flag("--platform")
        hours = int(_flag("--hours", "48") or "48")
        print(json.dumps(social_search(query=query, platform=platform, hours=hours),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--reply":
        if len(rest) < 3:
            print("usage: --reply PLATFORM ITEM_ID 'message' [--confirm]",
                  file=sys.stderr)
            return 2
        platform, item_id, message = rest[0], rest[1], rest[2]
        confirm = "--confirm" in rest
        print(json.dumps(social_reply(platform=platform, item_id=item_id,
                                       message=message, confirm=confirm),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--post":
        if len(rest) < 2:
            print("usage: --post PLATFORM 'message' [--confirm]", file=sys.stderr)
            return 2
        platform, message = rest[0], rest[1]
        confirm = "--confirm" in rest
        print(json.dumps(social_post(platform=platform, message=message,
                                      confirm=confirm),
                         indent=2, ensure_ascii=False))
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
