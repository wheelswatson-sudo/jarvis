#!/usr/bin/env python3
"""Contact Intelligence — Watson's relationship memory.

Maintains ~/.jarvis/contacts/people.json with a richer profile than
search_contacts can build alone: per-person interaction count, last
exchange, channels used, sentiment trend, open threads, communication
preference, and a synthesized brief.

Public functions (all return JSON-serializable dicts so jarvis-think.py
can wire them straight into the tool layer):

    lookup_contact(name) -> {ok, contact} | {error}
        Resolve a name (fuzzy) to the people.json record. Cheap.

    relationship_brief(name) -> {ok, brief, contact} | {error}
        Quick voice-ready summary: who they are, last interaction, open
        threads, suggested talking points. Pulls fresh interaction
        history before synthesizing if the cached brief is stale.

    enrich_contact(name, force=False) -> {ok, contact}
        Pull interaction history from email + telegram + memory and
        rebuild the contact's profile via Haiku synthesis.

    apollo_enrich(name, force=False) -> {ok, contact, person_id}
        On-demand Apollo.io People Match enrichment for a single
        contact. Patches title, seniority, LinkedIn URL, phone, org.
        Costs 1 Apollo credit. Stdlib urllib only.

    sync_from_apple_contacts(enrich=True, limit=None) -> {ok, ...}
        Pull every person from Apple Contacts and reconcile against
        people.json. Apple Contacts is the source of truth: contacts
        not on file are created (and Apollo-enriched on creation when
        APOLLO_API_KEY is set); existing records are patched with any
        missing email/phone/org. Never deletes.

    update_contacts() -> {ok, enriched, skipped}
        Batch enrich every known contact whose profile is stale.
        Used by the weekly jarvis-improve pass.

    note_interaction(channel, handle, summary, ts=None) -> {ok}
        Best-effort hook called after every email/telegram action to
        update the relevant contact's last_interaction + bump count.

CLI:
    bin/jarvis-contacts.py --lookup NAME
    bin/jarvis-contacts.py --brief NAME
    bin/jarvis-contacts.py --enrich NAME [--force]
    bin/jarvis-contacts.py --apollo NAME [--force]
    bin/jarvis-contacts.py --sync [--no-enrich] [--limit N]
    bin/jarvis-contacts.py --update-all
    bin/jarvis-contacts.py --add NAME [--email X] [--telegram @Y] [--rel "..."]
    bin/jarvis-contacts.py --status
    bin/jarvis-contacts.py --note CHANNEL HANDLE "summary"

Files written:
    ~/.jarvis/contacts/people.json   single-source-of-truth contact map
    ~/.jarvis/logs/contacts.log      diagnostic log

Gate: JARVIS_CONTACTS=1 (default).
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
CONTACTS_DIR = ASSISTANT_DIR / "contacts"
PEOPLE_FILE = CONTACTS_DIR / "people.json"
LOG_DIR = ASSISTANT_DIR / "logs"
CONTACTS_LOG = LOG_DIR / "contacts.log"

ENRICH_INTERVAL_S = int(os.environ.get("JARVIS_CONTACTS_REFRESH_S", str(7 * 86400)))  # 7 days
MAX_HISTORY_PER_CHANNEL = 30  # cap email/telegram messages we feed to Haiku

SYNTH_MODEL = os.environ.get("JARVIS_CONTACTS_MODEL", "claude-haiku-4-5-20251001")

# Apollo throttling — Apollo's documented per-minute limits vary by plan
# (typical free/starter: 60/min, basic: 120/min). Keep conservative by
# default so a 600-contact sync doesn't trip rate limits or burn through
# credits faster than expected. Override via JARVIS_APOLLO_RPM.
APOLLO_RPM = max(1, int(os.environ.get("JARVIS_APOLLO_RPM", "30")))
_APOLLO_MIN_INTERVAL_S = 60.0 / APOLLO_RPM
_apollo_last_call_at = 0.0  # monotonic timestamp of last Apollo request


def _env_fallback_load() -> None:
    """Best-effort: when invoked directly (e.g. bin/jarvis-contacts.py
    --sync), the env may not have been sourced via the `jarvis` wrapper.
    Read APOLLO_API_KEY (and friends) from ~/.jarvis/config/.env so the
    direct CLI path matches the wrapper path. Idempotent — never
    overrides values already in os.environ."""
    env_file = ASSISTANT_DIR / "config" / ".env"
    if not env_file.exists():
        return
    needed = ("APOLLO_API_KEY", "ANTHROPIC_API_KEY")
    if all(os.environ.get(k) for k in needed):
        return
    try:
        for raw in env_file.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export "):].lstrip()
            if "=" not in line:
                continue
            k, _, v = line.partition("=")
            k = k.strip()
            v = v.strip()
            if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                v = v[1:-1]
            if k and k not in os.environ:
                os.environ[k] = v
    except Exception as e:
        _log(f"env fallback load failed: {e}")


# ── Logging ─────────────────────────────────────────────────────────
def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with CONTACTS_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


# ── Gate ────────────────────────────────────────────────────────────
def _gate_check() -> dict | None:
    if os.environ.get("JARVIS_CONTACTS", "1") != "1":
        return {"error": "contact intelligence disabled (JARVIS_CONTACTS=0)"}
    return None


# ── Sibling module loaders ──────────────────────────────────────────
def _bin_dir() -> Path:
    deployed = ASSISTANT_DIR / "bin"
    if deployed.exists():
        return deployed
    return Path(__file__).parent


def _load_sibling(name: str):
    src = _bin_dir() / name
    if not src.exists():
        return None
    mod_id = name.replace("-", "_").replace(".py", "")
    try:
        spec = importlib.util.spec_from_file_location(mod_id, src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    except Exception as e:
        _log(f"sibling load failed ({name}): {e}")
        return None


# ── People-file I/O ─────────────────────────────────────────────────
def _empty_record(name: str) -> dict:
    return {
        "name": name,
        "canonical_key": _canonical(name),
        "email": None,
        "phone": None,                   # primary phone (E.164 if available)
        "phones": [],                    # all phones from Apple Contacts
        "emails": [],                    # all emails from Apple Contacts
        "organization": None,            # company / org from Apple Contacts
        "title": None,                   # job title (from Apollo)
        "seniority": None,               # seniority label (from Apollo)
        "linkedin_url": None,            # canonical LinkedIn URL (from Apollo)
        "telegram_handle": None,
        "telegram_id": None,
        # Social handles — keyed by platform so future tools (digest,
        # outreach analysis) can join across channels without scraping
        # text. Format: {"twitter": "@handle", "linkedin": "url-or-id",
        # "instagram": "@handle"}.
        "social_handles": {},
        "relationship": None,           # short label: "founder/friend", "client", "investor"
        "communication_preference": None,  # "email" | "telegram" | "social" | "either"
        "first_seen": None,
        "last_interaction": None,        # ISO datetime
        "last_channel": None,            # "email" | "telegram" | "social" | "manual"
        "interaction_count": 0,
        "topics_discussed": [],
        "open_threads": [],
        "notes": [],
        "sentiment_trend": None,         # "warm" | "neutral" | "cool"
        "brief": None,                   # synthesized voice-ready summary
        "brief_updated_at": None,
        "enriched_at": None,
        "apple_synced_at": None,         # last time we pulled from Contacts.app
        "apollo_enriched_at": None,      # last time we hit Apollo /people/match
        "source": None,                  # "apple_contacts" | "manual" | "imessage" | etc
    }


def _load_people() -> dict:
    if not PEOPLE_FILE.exists():
        return {}
    try:
        data = json.loads(PEOPLE_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        _log(f"people read failed: {e}")
        return {}
    return data if isinstance(data, dict) else {}


def _save_people(data: dict) -> None:
    CONTACTS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = PEOPLE_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, PEOPLE_FILE)


# ── Name canonicalization ───────────────────────────────────────────
_PUNCT_RE = re.compile(r"[^a-z0-9]+")
# Strip everything that's not a letter (any script), digit, or whitespace.
# Used as a fallback when ASCII folding wipes a name out (CJK, etc.) so we
# don't all collapse to canonical_key "" and overwrite each other.
_NON_WORD_RE = re.compile(r"[^\w\s]", flags=re.UNICODE)


def _canonical(name: str) -> str:
    """ASCII-fold lowercased canonical key. Falls back to a unicode-aware
    lowercase form when ASCII folding returns nothing (e.g. fully-CJK
    names) so distinct contacts never collide on people[''].
    """
    if not name:
        return ""
    norm = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    norm = _PUNCT_RE.sub(" ", norm.lower()).strip()
    norm = " ".join(norm.split())
    if norm:
        return norm
    # ASCII-fold produced nothing — fall back to a unicode-preserving key.
    # Casefold + strip non-word; if that's still empty (e.g. emoji-only
    # name), salt with a stable hash of the original so each record
    # gets its own bucket.
    fallback = _NON_WORD_RE.sub(" ", name).casefold().strip()
    fallback = " ".join(fallback.split())
    if fallback:
        return fallback
    import hashlib
    return "u_" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:12]


def _resolve(name: str, people: dict | None = None) -> tuple[str, dict] | None:
    """Fuzzy resolve a name to a people record. Exact canonical match wins;
    then substring on canonical_key; then substring on email or telegram
    handle. Returns (key, record) or None."""
    if not name:
        return None
    people = people if people is not None else _load_people()
    if not people:
        return None
    q = _canonical(name)
    if q in people:
        return q, people[q]
    # Substring on canonical key
    contains = [(k, v) for k, v in people.items() if q and q in k]
    if len(contains) == 1:
        return contains[0]
    if contains:
        # Multiple — return the shortest key (most specific match).
        contains.sort(key=lambda kv: len(kv[0]))
        return contains[0]
    # Match against email local part / telegram handle / social handles
    raw_q = (name or "").lower().lstrip("@")
    for k, v in people.items():
        em = (v.get("email") or "").lower()
        tg = (v.get("telegram_handle") or "").lower().lstrip("@")
        if raw_q and (raw_q == em or raw_q == tg or
                      (em and raw_q in em) or (tg and raw_q in tg)):
            return k, v
        # Social handles live as {"twitter": "@h", ...}
        for h in (v.get("social_handles") or {}).values():
            if not h:
                continue
            hn = h.lower().lstrip("@")
            if raw_q and (raw_q == hn or (hn and raw_q in hn)):
                return k, v
    return None


# ── Anthropic call ──────────────────────────────────────────────────
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


# ── Apollo.io enrichment ────────────────────────────────────────────
APOLLO_MATCH_URL = "https://api.apollo.io/api/v1/people/match"


def _apollo_call(payload: dict, api_key: str, timeout: float = 12.0) -> dict:
    """POST to Apollo's /people/match. Returns the raw JSON or {error}.
    Stdlib urllib only — no apollo-io package needed.

    Throttles to APOLLO_RPM requests/minute and retries on 429/5xx with
    exponential backoff. A ``Retry-After`` header is honored when Apollo
    sends one."""
    global _apollo_last_call_at
    body = json.dumps(payload).encode()
    last_err: str = ""
    for attempt in range(4):
        # Throttle: never fire faster than _APOLLO_MIN_INTERVAL_S apart.
        now = time.monotonic()
        wait = _apollo_last_call_at + _APOLLO_MIN_INTERVAL_S - now
        if wait > 0:
            time.sleep(wait)
        _apollo_last_call_at = time.monotonic()
        req = urllib.request.Request(
            APOLLO_MATCH_URL,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Cache-Control": "no-cache",
                "X-Api-Key": api_key,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                err_body = e.read().decode("utf-8", "replace")
            except Exception:
                err_body = ""
            last_err = f"apollo HTTP {e.code}: {err_body[:200]}"
            if e.code == 429 or 500 <= e.code < 600:
                if attempt >= 3:
                    return {"error": last_err}
                # Honor Retry-After when supplied; otherwise back off.
                retry_after = 0.0
                try:
                    ra = e.headers.get("Retry-After") if e.headers else None
                    if ra:
                        retry_after = float(ra)
                except Exception:
                    retry_after = 0.0
                backoff = max(retry_after, 2.0 * (2 ** attempt))  # 2,4,8s
                _log(f"apollo {e.code}, sleeping {backoff:.1f}s (attempt {attempt + 1})")
                time.sleep(backoff)
                continue
            return {"error": last_err}
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = f"apollo network: {e}"
            if attempt >= 3:
                return {"error": last_err}
            time.sleep(1.5 * (2 ** attempt))
            continue
        except Exception as e:
            return {"error": f"apollo: {e}"}
    return {"error": last_err or "apollo: exhausted retries"}


_BIZ_TOKENS = {
    "llc", "inc", "corp", "corporation", "co", "company", "ltd", "limited",
    "gmbh", "ag", "plc", "pllc", "lp", "llp", "lc", "kk",
    "insurance", "bank", "credit", "union", "services", "service",
    "solutions", "systems", "group", "holdings", "partners", "associates",
    "agency", "studio", "studios", "foundation", "fund", "capital", "ventures",
    "clinic", "hospital", "dental", "medical", "pharmacy", "office",
    "school", "university", "college", "academy", "store", "shop", "market",
    "restaurant", "cafe", "salon", "spa", "fitness", "gym", "garage", "auto",
    "plumbing", "electric", "hvac", "construction", "realty", "realtors",
    "law", "legal", "attorney", "attorneys", "consulting", "consultants",
    "church", "ministries", "ministry",
}


def _looks_like_business(name: str, email: str | None = None) -> bool:
    """Heuristic — does this contact look like a business / org rather
    than a person? Saves an Apollo credit (and avoids garbage matches)
    on contacts like 'State Farm Insurance' or 'Verizon Customer Care'.

    Returns True only when we're fairly confident; default to False so
    real people with single-token names still get enriched."""
    if not name:
        return False
    n = name.strip()
    if not n:
        return False
    tokens = [t for t in re.split(r"\s+", n.lower()) if t]
    if not tokens:
        return False
    cleaned = [re.sub(r"[^a-z0-9]", "", t) for t in tokens]
    cleaned = [c for c in cleaned if c]
    if any(t in _BIZ_TOKENS for t in cleaned):
        return True
    # Trailing comma + suffix: "Smith Plumbing, LLC"
    if "," in n and re.search(r",\s*(LLC|Inc\.?|Corp\.?|Ltd\.?|LP|LLP|PLLC)\s*$", n,
                              flags=re.IGNORECASE):
        return True
    # No email AND multi-token uppercase blocks like "BLUE CROSS BLUE SHIELD"
    if not email and len(tokens) >= 2 and n.upper() == n and all(len(t) >= 3 for t in tokens):
        return True
    return False


def _apollo_enrich_record(rec: dict) -> dict:
    """Hit Apollo /people/match using whatever identifiers we have,
    patch missing fields onto the record. Mutates `rec` in place.

    Cost: 1 Apollo credit per call. Skipped if no APOLLO_API_KEY,
    record already enriched within ENRICH_INTERVAL_S, contact looks
    like a business (would burn credit on a bad match), or we have
    insufficient identifiers for Apollo to match against."""
    api_key = os.environ.get("APOLLO_API_KEY", "").strip()
    if not api_key:
        return {"ok": False, "skipped": True, "reason": "no APOLLO_API_KEY"}

    if rec.get("apollo_enriched_at"):
        try:
            age = time.time() - datetime.fromisoformat(rec["apollo_enriched_at"]).timestamp()
            if age < ENRICH_INTERVAL_S:
                return {"ok": True, "skipped": True, "reason": "fresh"}
        except Exception:
            pass

    name = (rec.get("name") or "").strip()
    email = (rec.get("email") or "").strip()

    # Skip business / org contacts — Apollo's people-match endpoint is
    # for individuals; running a business through it wastes a credit
    # and tends to return mismatches on whoever happens to share that
    # email domain. Override is force=True via apollo_enrich(name, force).
    if _looks_like_business(name, email):
        return {"ok": False, "skipped": True, "reason": "looks like a business"}

    payload: dict = {"reveal_personal_emails": False}
    if email:
        payload["email"] = email
    if name:
        parts = name.split()
        if len(parts) >= 1:
            payload["first_name"] = parts[0]
        if len(parts) >= 2:
            payload["last_name"] = " ".join(parts[1:])
    if rec.get("organization"):
        payload["organization_name"] = rec["organization"]
    # Apollo's match accuracy collapses with only first_name + nothing
    # else — avoid those calls entirely.
    has_email = bool(payload.get("email"))
    has_full_name = bool(payload.get("first_name") and payload.get("last_name"))
    has_org = bool(payload.get("organization_name"))
    if not (has_email or (has_full_name and has_org) or (has_full_name and len(name.split()) >= 2)):
        return {"ok": False, "skipped": True, "reason": "insufficient identifiers"}

    res = _apollo_call(payload, api_key)
    if res.get("error"):
        _log(f"apollo enrich {rec.get('name')!r}: {res['error']}")
        return {"ok": False, "error": res["error"]}

    person = res.get("person") if isinstance(res, dict) else None
    if not person:
        return {"ok": False, "skipped": True, "reason": "no match"}

    if not rec.get("title") and person.get("title"):
        rec["title"] = person["title"]
    if not rec.get("seniority") and person.get("seniority"):
        rec["seniority"] = person["seniority"]
    if not rec.get("linkedin_url") and person.get("linkedin_url"):
        rec["linkedin_url"] = person["linkedin_url"]
        rec.setdefault("social_handles", {})["linkedin"] = person["linkedin_url"]
    org = person.get("organization") or {}
    if not rec.get("organization") and org.get("name"):
        rec["organization"] = org["name"]
    if not rec.get("phone") and person.get("phone_numbers"):
        first = person["phone_numbers"][0] if person["phone_numbers"] else None
        if isinstance(first, dict) and first.get("sanitized_number"):
            rec["phone"] = first["sanitized_number"]
    rec["apollo_enriched_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    return {"ok": True, "person_id": person.get("id")}


def apollo_enrich(name: str, force: bool = False) -> dict:
    """On-demand Apollo enrichment for a single contact. Looks up by
    email if we have one, otherwise by name+organization."""
    gate = _gate_check()
    if gate:
        return gate
    if not name:
        return {"error": "name is required"}
    _env_fallback_load()
    if not os.environ.get("APOLLO_API_KEY"):
        return {"error": "APOLLO_API_KEY not set"}
    people = _load_people()
    hit = _resolve(name, people)
    if not hit:
        return {"error": f"no contact matches {name!r} — sync from Apple Contacts first"}
    key, rec = hit
    if force:
        rec["apollo_enriched_at"] = None
    res = _apollo_enrich_record(rec)
    people[key] = rec
    _save_people(people)
    if res.get("ok"):
        return {"ok": True, "contact": rec, "person_id": res.get("person_id")}
    return {"ok": False, "contact": rec, **{k: v for k, v in res.items() if k != "ok"}}


# ── History harvesters ──────────────────────────────────────────────
def _email_history(record: dict, limit: int = MAX_HISTORY_PER_CHANNEL) -> list[dict]:
    """Pull recent Gmail messages with this contact (in either direction).
    Returns [] if Gmail isn't auth'd or no email is on file."""
    email_addr = (record.get("email") or "").strip()
    if not email_addr:
        return []
    email_mod = _load_sibling("jarvis-email.py")
    if email_mod is None:
        return []
    svc, _g = email_mod._gmail_service()  # type: ignore[attr-defined]
    if svc is None:
        return []
    query = f"(from:{email_addr} OR to:{email_addr})"
    try:
        resp = svc.users().messages().list(
            userId="me", q=query, maxResults=max(5, min(limit, 100)),
        ).execute()
    except Exception as e:
        _log(f"email history list failed ({email_addr}): {e}")
        return []
    out: list[dict] = []
    for m in resp.get("messages", []) or []:
        try:
            full = svc.users().messages().get(
                userId="me", id=m["id"], format="metadata",
                metadataHeaders=["From", "To", "Subject", "Date"],
            ).execute()
        except Exception as e:
            _log(f"email get {m.get('id')} failed: {e}")
            continue
        headers = (full.get("payload") or {}).get("headers") or []
        out.append({
            "ts": int(int(full.get("internalDate", 0)) / 1000),
            "from": email_mod._decode_header(headers, "From"),  # type: ignore[attr-defined]
            "to": email_mod._decode_header(headers, "To"),  # type: ignore[attr-defined]
            "subject": email_mod._decode_header(headers, "Subject"),  # type: ignore[attr-defined]
            "snippet": full.get("snippet", "")[:240],
        })
    out.sort(key=lambda r: r.get("ts") or 0, reverse=True)
    return out


def _telegram_history(record: dict, limit: int = MAX_HISTORY_PER_CHANNEL) -> list[dict]:
    """Pull recent telegram messages from this contact across monitored
    groups. Returns [] if telegram isn't set up or no handle is on file."""
    handle = (record.get("telegram_handle") or "").lstrip("@").lower()
    tg_id = record.get("telegram_id")
    if not handle and not tg_id:
        return []
    tg_mod = _load_sibling("jarvis-telegram.py")
    if tg_mod is None:
        return []
    cfg = tg_mod._load_config()  # type: ignore[attr-defined]
    groups = cfg.get("monitored_groups") or []
    out: list[dict] = []
    for g in groups:
        recs = tg_mod._read_cache(g["id"], 0)  # type: ignore[attr-defined]
        for r in recs:
            from_user = (r.get("from_username") or "").lstrip("@").lower()
            from_id = r.get("from_id")
            if not (
                (handle and from_user == handle)
                or (tg_id is not None and from_id == tg_id)
            ):
                continue
            text = (r.get("text") or "").strip()
            if not text:
                continue
            out.append({
                "ts": int(r.get("date") or 0),
                "group": g.get("title") or "",
                "text": text[:240],
            })
    out.sort(key=lambda r: r.get("ts") or 0, reverse=True)
    return out[:limit]


def _memory_recall(name: str, limit: int = 10) -> list[dict]:
    """Lazy-load Memory and pull anything the user has remembered about
    this person. Returns [] on any failure."""
    src = _bin_dir() / "jarvis_memory.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis_memory.py"
    if not src.exists():
        return []
    try:
        spec = importlib.util.spec_from_file_location("jarvis_memory_for_contacts", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        mem = mod.Memory()
        hits = mem.recall(name, limit=limit)
        return [{
            "id": h.get("id"),
            "created_at": (h.get("created_at") or "")[:10],
            "text": h.get("text") or "",
        } for h in hits]
    except Exception as e:
        _log(f"memory recall failed ({name}): {e}")
        return []


# ── Synthesis ───────────────────────────────────────────────────────
SYNTH_SYSTEM = """You are building a relationship profile for Watson. Output ONE valid JSON object — no prose, no fences. Schema:

{
  "brief": "2-3 sentences: who this person is in Watson's life, the current state of the relationship, what's on his plate with them. Past tense for facts, present tense for status. Voice-ready (Watson will hear it spoken).",
  "talking_points": ["3-5 short imperative phrases Watson could open with — 'Ask about the Tuesday demo', 'Follow up on the term sheet'. Empty list if nothing to surface."],
  "open_threads": ["Threads that have not been resolved — items waiting on Watson, items waiting on them, decisions pending. Each item one short phrase."],
  "topics_discussed": ["Up to 8 short noun phrases summarizing what they actually talk about — projects, products, mutual friends, recurring subjects. Pull from the evidence, no invention."],
  "communication_preference": "email" | "telegram" | "either",
  "sentiment_trend": "warm" | "neutral" | "cool",
  "relationship_label": "Short label — 'founder peer', 'investor', 'client', 'friend', 'mentor', etc. Empty string if unclear."
}

Rules:
- Be concrete and grounded — quote details from the evidence (names, dates, products).
- If evidence is thin (1-2 messages), keep brief short and mark sentiment_trend "neutral".
- If something looks stale (last interaction > 30 days ago), note it explicitly in the brief.
- communication_preference: pick the channel where most recent meaningful traffic flowed. "either" if balanced.
- Avoid generic platitudes ("they seem nice"). Every line should help Watson navigate the next interaction."""


def _synthesize_profile(record: dict, history: dict, api_key: str) -> dict:
    parts: list[str] = []
    parts.append(f"Name: {record.get('name')}")
    if record.get("email"):
        parts.append(f"Email: {record['email']}")
    if record.get("telegram_handle"):
        parts.append(f"Telegram: @{record['telegram_handle'].lstrip('@')}")
    if record.get("relationship"):
        parts.append(f"Existing label: {record['relationship']}")
    if record.get("notes"):
        parts.append("Existing notes:\n- " + "\n- ".join(record["notes"][:6]))

    em = history.get("email") or []
    tg = history.get("telegram") or []
    mem = history.get("memory") or []
    if em:
        parts.append("\nRecent email exchanges (most recent first):")
        for e in em[:15]:
            ts = datetime.fromtimestamp(e.get("ts") or 0).strftime("%Y-%m-%d") if e.get("ts") else "?"
            direction = "→" if (record.get("email") or "").lower() in (e.get("to") or "").lower() else "←"
            parts.append(f"  [{ts}] {direction} {e.get('subject') or ''}: {e.get('snippet') or ''}")
    if tg:
        parts.append("\nRecent Telegram messages from them (most recent first):")
        for t in tg[:15]:
            ts = datetime.fromtimestamp(t.get("ts") or 0).strftime("%Y-%m-%d") if t.get("ts") else "?"
            parts.append(f"  [{ts}] in {t.get('group')}: {t.get('text') or ''}")
    if mem:
        parts.append("\nThings Watson has remembered about them:")
        for m in mem[:8]:
            parts.append(f"  [{m.get('created_at')}] {m.get('text')}")

    prompt = "\n".join(parts)
    try:
        raw = _anthropic_call(api_key, SYNTH_MODEL, SYNTH_SYSTEM, prompt,
                              max_tokens=900, timeout=30.0)
    except Exception as e:
        _log(f"synth call failed ({record.get('name')}): {e}")
        return {}
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return {}
    try:
        parsed = json.loads(m.group(0))
    except json.JSONDecodeError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    parsed.setdefault("brief", "")
    parsed.setdefault("talking_points", [])
    parsed.setdefault("open_threads", [])
    parsed.setdefault("topics_discussed", [])
    parsed.setdefault("communication_preference", None)
    parsed.setdefault("sentiment_trend", "neutral")
    parsed.setdefault("relationship_label", "")
    return parsed


# ── Public: lookup_contact ──────────────────────────────────────────
def lookup_contact(name: str) -> dict:
    gate = _gate_check()
    if gate:
        return gate
    if not name:
        return {"error": "name is required"}
    hit = _resolve(name)
    if not hit:
        return {"ok": False, "found": False, "query": name}
    key, rec = hit
    return {"ok": True, "found": True, "key": key, "contact": rec}


# ── Public: enrich_contact ──────────────────────────────────────────
def enrich_contact(name: str, force: bool = False) -> dict:
    gate = _gate_check()
    if gate:
        return gate
    if not name:
        return {"error": "name is required"}
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {"error": "ANTHROPIC_API_KEY not set"}

    people = _load_people()
    hit = _resolve(name, people)
    if not hit:
        return {"error": f"no contact matches {name!r} — add via --add first"}
    key, rec = hit

    if not force and rec.get("enriched_at"):
        try:
            age = time.time() - datetime.fromisoformat(rec["enriched_at"]).timestamp()
            if age < ENRICH_INTERVAL_S:
                return {
                    "ok": True,
                    "skipped": True,
                    "reason": "fresh — pass force=true to rebuild",
                    "contact": rec,
                }
        except Exception:
            pass

    history = {
        "email": _email_history(rec),
        "telegram": _telegram_history(rec),
        "memory": _memory_recall(rec.get("name") or name),
    }
    synthesis = _synthesize_profile(rec, history, api_key)
    if not synthesis:
        return {"error": "synthesis failed (see logs)"}

    rec["brief"] = synthesis.get("brief") or rec.get("brief")
    rec["brief_updated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    rec["enriched_at"] = rec["brief_updated_at"]
    rec["topics_discussed"] = synthesis.get("topics_discussed") or rec.get("topics_discussed") or []
    rec["open_threads"] = synthesis.get("open_threads") or []
    if synthesis.get("communication_preference"):
        rec["communication_preference"] = synthesis["communication_preference"]
    if synthesis.get("sentiment_trend"):
        rec["sentiment_trend"] = synthesis["sentiment_trend"]
    if synthesis.get("relationship_label") and not rec.get("relationship"):
        rec["relationship"] = synthesis["relationship_label"]
    rec["talking_points"] = synthesis.get("talking_points") or []

    # Bump last_interaction from any history we just pulled — not the same
    # as note_interaction, which is on the live send path. This is the
    # "what does the world look like right now" reconciliation.
    last_ts = 0
    last_channel = rec.get("last_channel")
    if history["email"]:
        ts0 = history["email"][0].get("ts") or 0
        if ts0 > last_ts:
            last_ts = ts0
            last_channel = "email"
    if history["telegram"]:
        ts0 = history["telegram"][0].get("ts") or 0
        if ts0 > last_ts:
            last_ts = ts0
            last_channel = "telegram"
    if last_ts:
        rec["last_interaction"] = datetime.fromtimestamp(last_ts).astimezone().isoformat(
            timespec="seconds")
        rec["last_channel"] = last_channel
    rec["interaction_count"] = max(
        rec.get("interaction_count") or 0,
        len(history["email"]) + len(history["telegram"]),
    )

    people[key] = rec
    _save_people(people)
    _log(f"enriched {rec.get('name')} (email={len(history['email'])}, "
         f"telegram={len(history['telegram'])}, memory={len(history['memory'])})")
    return {"ok": True, "contact": rec}


# ── Public: relationship_brief ──────────────────────────────────────
def relationship_brief(name: str) -> dict:
    gate = _gate_check()
    if gate:
        return gate
    if not name:
        return {"error": "name is required"}
    people = _load_people()
    hit = _resolve(name, people)
    if not hit:
        # Auto-create a stub from search_contacts so a follow-up enrich
        # works without manual --add. Cheap; doesn't burn an API call.
        stub = _stub_from_search(name)
        if stub:
            people[stub["canonical_key"]] = stub
            _save_people(people)
            hit = (stub["canonical_key"], stub)
    if not hit:
        return {"ok": False, "found": False, "hint": (
            "no contact found — add one via "
            "`jarvis-contacts.py --add NAME --email X --telegram @Y` "
            "then enrich.")}
    key, rec = hit

    # Stale or missing brief → enrich first, only if API + history available.
    needs_enrich = False
    if not rec.get("brief"):
        needs_enrich = True
    elif rec.get("brief_updated_at"):
        try:
            age = time.time() - datetime.fromisoformat(rec["brief_updated_at"]).timestamp()
            if age > ENRICH_INTERVAL_S:
                needs_enrich = True
        except Exception:
            needs_enrich = True
    if needs_enrich and os.environ.get("ANTHROPIC_API_KEY"):
        en = enrich_contact(rec["name"], force=False)
        if en.get("ok") and en.get("contact"):
            rec = en["contact"]
            people = _load_people()  # refresh from disk
            key, rec = key, people.get(key) or rec

    return {
        "ok": True,
        "found": True,
        "name": rec.get("name"),
        "brief": rec.get("brief") or "(no brief yet — enrich to build one)",
        "talking_points": rec.get("talking_points") or [],
        "open_threads": rec.get("open_threads") or [],
        "last_interaction": rec.get("last_interaction"),
        "last_channel": rec.get("last_channel"),
        "communication_preference": rec.get("communication_preference"),
        "sentiment_trend": rec.get("sentiment_trend"),
        "relationship": rec.get("relationship"),
        "contact": rec,
    }


def _stub_from_search(name: str) -> dict | None:
    """Best-effort: ask jarvis-recall for what it knows, build a stub."""
    bin_path = _bin_dir() / "jarvis-recall"
    if not bin_path.exists():
        return None
    import subprocess
    try:
        res = subprocess.run(
            [str(bin_path), "who", name],
            capture_output=True, text=True, timeout=8,
        )
        if res.returncode != 0:
            return None
        data = json.loads(res.stdout or "{}")
    except Exception:
        return None
    if not isinstance(data, dict) or not data.get("name"):
        return None
    rec = _empty_record(data["name"])
    rec["email"] = data.get("email")
    rec["notes"] = [data["context"]] if data.get("context") else []
    rec["first_seen"] = datetime.now().astimezone().isoformat(timespec="seconds")
    return rec


# ── Public: update_contacts ─────────────────────────────────────────
def update_contacts() -> dict:
    """Batch-enrich every contact whose profile is stale. Used by
    jarvis-improve weekly. Caps at one Anthropic call per stale contact."""
    gate = _gate_check()
    if gate:
        return gate
    people = _load_people()
    if not people:
        return {"ok": True, "enriched": 0, "skipped": 0, "reason": "no contacts on file"}
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {"error": "ANTHROPIC_API_KEY not set"}
    enriched = 0
    skipped = 0
    errors: list[str] = []
    cap = int(os.environ.get("JARVIS_CONTACTS_BATCH_CAP", "10"))
    for key, rec in people.items():
        if enriched >= cap:
            skipped += 1
            continue
        en = rec.get("enriched_at")
        is_stale = True
        if en:
            try:
                is_stale = (time.time() - datetime.fromisoformat(en).timestamp()) > ENRICH_INTERVAL_S
            except Exception:
                is_stale = True
        if not is_stale:
            skipped += 1
            continue
        res = enrich_contact(rec["name"], force=True)
        if res.get("ok"):
            enriched += 1
        else:
            errors.append(f"{rec.get('name')}: {res.get('error')}")
    return {"ok": True, "enriched": enriched, "skipped": skipped, "errors": errors}


# ── Public: sync_from_apple_contacts ────────────────────────────────
def _normalize_phone(raw: str) -> str:
    """Strip everything but digits + leading +. Used for dedupe; the
    raw value is preserved on the record."""
    if not raw:
        return ""
    raw = raw.strip()
    if raw.startswith("+"):
        return "+" + re.sub(r"\D", "", raw[1:])
    return re.sub(r"\D", "", raw)


def _phone_match(a: str, b: str) -> bool:
    """Loose phone equality — last 10 digits match, since US contacts
    sometimes have +1 and sometimes don't."""
    na = _normalize_phone(a).lstrip("+")
    nb = _normalize_phone(b).lstrip("+")
    if not na or not nb:
        return False
    return na[-10:] == nb[-10:] if len(na) >= 7 and len(nb) >= 7 else na == nb


def _resolve_apple_match(apple_rec: dict, people: dict) -> str | None:
    """Find an existing record that already represents this Apple contact.
    Match priority: any email overlap → any phone overlap (last-10) →
    exact canonical name. Returns the canonical_key, or None."""
    apple_emails = {(e or "").lower() for e in (apple_rec.get("emails") or []) if e}
    apple_phones = apple_rec.get("phones") or []
    canon = _canonical(apple_rec.get("name") or "")
    for k, rec in people.items():
        rec_emails = {(rec.get("email") or "").lower()}
        rec_emails.update((e or "").lower() for e in (rec.get("emails") or []))
        if apple_emails & {e for e in rec_emails if e}:
            return k
        rec_phones = list(rec.get("phones") or [])
        if rec.get("phone"):
            rec_phones.append(rec["phone"])
        for ap in apple_phones:
            for rp in rec_phones:
                if _phone_match(ap, rp):
                    return k
        if canon and k == canon:
            return k
    return None


def _claim_canonical_key(rec: dict, people: dict) -> str:
    """Pick a non-colliding canonical_key. If the natural key is already
    taken by a *different* record, suffix until unique. Returns the key
    chosen and writes it back onto rec['canonical_key']."""
    base = rec.get("canonical_key") or _canonical(rec.get("name") or "")
    if not base:
        # _canonical already falls back to a hash, so this shouldn't happen.
        import hashlib
        base = "u_" + hashlib.sha1((rec.get("name") or "").encode("utf-8")).hexdigest()[:12]
    if base not in people:
        rec["canonical_key"] = base
        return base
    # Differentiate with a stable suffix derived from email/phone/source.
    salt_src = (
        (rec.get("email") or "")
        + "|" + "|".join(rec.get("emails") or [])
        + "|" + "|".join(rec.get("phones") or [])
        + "|" + (rec.get("organization") or "")
    )
    if salt_src.strip("|"):
        import hashlib
        suffix = hashlib.sha1(salt_src.encode("utf-8")).hexdigest()[:6]
        candidate = f"{base}#{suffix}"
        if candidate not in people:
            rec["canonical_key"] = candidate
            return candidate
    # Last-ditch: numeric suffix.
    n = 2
    while f"{base}#{n}" in people:
        n += 1
    candidate = f"{base}#{n}"
    rec["canonical_key"] = candidate
    return candidate


def sync_from_apple_contacts(enrich: bool = True, limit: int | None = None) -> dict:
    """Pull every contact from Apple Contacts.app and reconcile against
    ~/.jarvis/contacts/people.json. Apple Contacts is the source of
    truth for who exists; we never delete from Jarvis on sync, but we
    do add new records and patch in missing fields (email/phone/org).

    Args:
        enrich: if True and APOLLO_API_KEY is set, run Apollo enrichment
            on each newly-created record AND on existing records that
            haven't yet been Apollo-enriched (resumable behavior — a
            previous crash mid-sync won't strand records without
            Apollo data).
        limit: cap on total contacts processed; useful for testing.

    Returns: {ok, scanned, created, updated, enriched, errors}.
    """
    gate = _gate_check()
    if gate:
        return gate
    _env_fallback_load()
    apple_mod = _load_sibling("jarvis-apple.py")
    if apple_mod is None:
        return {"error": "jarvis-apple module not available — sync requires macOS"}
    if not hasattr(apple_mod, "apple_contacts_list_all"):
        return {"error": "jarvis-apple is too old; missing apple_contacts_list_all"}
    res = apple_mod.apple_contacts_list_all()
    if not res.get("ok"):
        return {"error": res.get("error") or "apple_contacts_list_all failed"}

    apple_contacts = res.get("contacts") or []
    if limit is not None:
        apple_contacts = apple_contacts[:int(limit)]

    people = _load_people()
    created = 0
    updated = 0
    enriched = 0
    errors: list[str] = []
    now_iso = datetime.now().astimezone().isoformat(timespec="seconds")
    have_apollo = bool(enrich and os.environ.get("APOLLO_API_KEY"))
    # Save every CHECKPOINT_EVERY contacts processed so a crash doesn't
    # lose the entire batch — important when Apollo enrichment is
    # running and each call takes seconds.
    checkpoint_every = max(1, int(os.environ.get("JARVIS_CONTACTS_CHECKPOINT_EVERY", "25")))
    processed_since_save = 0

    def _checkpoint() -> None:
        try:
            _save_people(people)
        except Exception as exc:
            errors.append(f"checkpoint save failed: {exc}")

    for ac in apple_contacts:
        try:
            name = (ac.get("name") or "").strip()
            if not name:
                continue
            existing_key = _resolve_apple_match(ac, people)
            if existing_key is not None:
                rec = people[existing_key]
                touched = False
                if not rec.get("email") and ac.get("emails"):
                    rec["email"] = ac["emails"][0]
                    touched = True
                if not rec.get("phone") and ac.get("phones"):
                    rec["phone"] = ac["phones"][0]
                    touched = True
                if ac.get("emails"):
                    merged = list(dict.fromkeys(
                        [e for e in (rec.get("emails") or []) if e]
                        + [e for e in ac["emails"] if e]
                    ))
                    if merged != (rec.get("emails") or []):
                        rec["emails"] = merged
                        touched = True
                if ac.get("phones"):
                    merged_p = list(dict.fromkeys(
                        [p for p in (rec.get("phones") or []) if p]
                        + [p for p in ac["phones"] if p]
                    ))
                    if merged_p != (rec.get("phones") or []):
                        rec["phones"] = merged_p
                        touched = True
                if not rec.get("organization") and ac.get("organization"):
                    rec["organization"] = ac["organization"]
                    touched = True
                rec["apple_synced_at"] = now_iso
                if touched:
                    updated += 1
                people[existing_key] = rec
                # Resumability: if this record never got Apollo-enriched
                # (likely from a previous crash or from --no-enrich), try
                # now. Apollo's own freshness gate keeps this from
                # billing twice.
                if have_apollo and not rec.get("apollo_enriched_at"):
                    ap_res = _apollo_enrich_record(rec)
                    if ap_res.get("ok") and not ap_res.get("skipped"):
                        enriched += 1
                    elif ap_res.get("error"):
                        errors.append(f"apollo {name}: {ap_res['error']}")
                processed_since_save += 1
                if processed_since_save >= checkpoint_every:
                    _checkpoint()
                    processed_since_save = 0
                continue
            rec = _empty_record(name)
            rec["emails"] = list(ac.get("emails") or [])
            rec["phones"] = list(ac.get("phones") or [])
            rec["email"] = rec["emails"][0] if rec["emails"] else None
            rec["phone"] = rec["phones"][0] if rec["phones"] else None
            rec["organization"] = ac.get("organization")
            rec["first_seen"] = now_iso
            rec["apple_synced_at"] = now_iso
            rec["source"] = "apple_contacts"
            chosen = _claim_canonical_key(rec, people)
            people[chosen] = rec
            created += 1
            if have_apollo:
                ap_res = _apollo_enrich_record(rec)
                if ap_res.get("ok") and not ap_res.get("skipped"):
                    enriched += 1
                elif ap_res.get("error"):
                    errors.append(f"apollo {name}: {ap_res['error']}")
            processed_since_save += 1
            if processed_since_save >= checkpoint_every:
                _checkpoint()
                processed_since_save = 0
        except Exception as e:
            errors.append(f"{ac.get('name', '?')}: {e}")

    _save_people(people)
    _log(f"apple sync: scanned={len(apple_contacts)} created={created} "
         f"updated={updated} enriched={enriched}")
    return {
        "ok": True,
        "scanned": len(apple_contacts),
        "created": created,
        "updated": updated,
        "enriched": enriched,
        "errors": errors[:20],
    }


# ── Public: note_interaction ────────────────────────────────────────
def note_interaction(channel: str, handle: str, summary: str = "",
                     ts: int | None = None) -> dict:
    """Record that Watson just interacted with someone on `channel`.
    `handle` can be an email address, telegram @handle, or a social
    handle (Twitter @user, LinkedIn name, Instagram @user). We resolve
    it to an existing contact, or create a stub. Cheap — no API call.

    `channel` accepts "email", "telegram", "social" (any platform),
    "social:twitter", "social:linkedin", "social:instagram", or "manual".
    Sub-platform variants record onto the right `social_handles` key so
    future cross-platform lookups join cleanly."""
    gate = _gate_check()
    if gate:
        return gate
    valid_root = ("email", "telegram", "social", "manual")
    root = channel.split(":", 1)[0] if channel else ""
    sub = channel.split(":", 1)[1] if (channel and ":" in channel) else None
    if root not in valid_root:
        return {"error": f"invalid channel: {channel!r}"}
    handle = (handle or "").strip()
    if not handle:
        return {"error": "handle is required"}
    people = _load_people()

    # Resolve by exact email / telegram / social first (stable identifiers).
    raw = handle.lower().lstrip("@")
    hit_key: str | None = None
    for k, v in people.items():
        if root == "email" and (v.get("email") or "").lower() == raw:
            hit_key = k
            break
        if root == "telegram" and (v.get("telegram_handle") or "").lower().lstrip("@") == raw:
            hit_key = k
            break
        if root == "social":
            handles = v.get("social_handles") or {}
            if sub and (handles.get(sub) or "").lower().lstrip("@") == raw:
                hit_key = k
                break
            # No sub-platform — match across any platform handle.
            if not sub:
                for hv in handles.values():
                    if (hv or "").lower().lstrip("@") == raw:
                        hit_key = k
                        break
                if hit_key:
                    break
    if hit_key is None:
        # Fall back to the fuzzy resolver — accepts a display name passed in.
        fz = _resolve(handle, people)
        if fz:
            hit_key, _ = fz
    if hit_key is None:
        # Create a new stub so future interactions land in one record.
        display = handle
        rec = _empty_record(display)
        rec["first_seen"] = datetime.now().astimezone().isoformat(timespec="seconds")
        if root == "email":
            rec["email"] = handle
        elif root == "telegram":
            rec["telegram_handle"] = "@" + handle.lstrip("@")
        elif root == "social":
            platform = sub or "unknown"
            rec.setdefault("social_handles", {})[platform] = (
                "@" + handle.lstrip("@") if platform != "linkedin" else handle
            )
        hit_key = _claim_canonical_key(rec, people)
        people[hit_key] = rec
    elif root == "social" and sub:
        # Existing record — backfill the social handle if it isn't on file.
        rec = people[hit_key]
        rec.setdefault("social_handles", {})
        if not rec["social_handles"].get(sub):
            rec["social_handles"][sub] = (
                "@" + handle.lstrip("@") if sub != "linkedin" else handle
            )

    rec = people[hit_key]
    iso = (datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")
           if ts else datetime.now().astimezone().isoformat(timespec="seconds"))
    rec["last_interaction"] = iso
    rec["last_channel"] = channel
    rec["interaction_count"] = (rec.get("interaction_count") or 0) + 1
    if summary:
        notes = rec.get("notes") or []
        notes.insert(0, f"[{iso[:10]}] {summary[:240]}")
        rec["notes"] = notes[:30]
    people[hit_key] = rec
    _save_people(people)
    return {"ok": True, "key": hit_key, "name": rec.get("name")}


# ── Public: add_contact ─────────────────────────────────────────────
def add_contact(name: str, email: str | None = None,
                telegram_handle: str | None = None,
                relationship: str | None = None,
                notes: str | None = None) -> dict:
    gate = _gate_check()
    if gate:
        return gate
    if not name:
        return {"error": "name is required"}
    people = _load_people()
    key = _canonical(name)
    rec = people.get(key) or _empty_record(name)
    rec["name"] = name
    rec["canonical_key"] = key
    if email:
        rec["email"] = email
    if telegram_handle:
        rec["telegram_handle"] = "@" + telegram_handle.lstrip("@")
    if relationship:
        rec["relationship"] = relationship
    if notes:
        rec.setdefault("notes", []).insert(0,
            f"[{datetime.now().astimezone().date().isoformat()}] {notes[:240]}")
        rec["notes"] = rec["notes"][:30]
    is_new = not people.get(key)
    if not rec.get("first_seen"):
        rec["first_seen"] = datetime.now().astimezone().isoformat(timespec="seconds")
    if is_new and not rec.get("source"):
        rec["source"] = "manual"
    apollo_status = None
    if is_new and os.environ.get("APOLLO_API_KEY") and (rec.get("email") or rec.get("name")):
        ap = _apollo_enrich_record(rec)
        apollo_status = "enriched" if ap.get("ok") and not ap.get("skipped") else (
            "skipped" if ap.get("skipped") else "error")
    people[key] = rec
    _save_people(people)
    out = {"ok": True, "key": key, "contact": rec}
    if apollo_status:
        out["apollo"] = apollo_status
    return out


# ── Status ──────────────────────────────────────────────────────────
def status() -> dict:
    people = _load_people()
    if not people:
        return {"ok": True, "count": 0, "hint": "no contacts on file yet"}
    fresh = stale = 0
    for rec in people.values():
        en = rec.get("enriched_at")
        is_stale = True
        if en:
            try:
                is_stale = (time.time() - datetime.fromisoformat(en).timestamp()) > ENRICH_INTERVAL_S
            except Exception:
                is_stale = True
        if is_stale:
            stale += 1
        else:
            fresh += 1
    return {
        "ok": True,
        "count": len(people),
        "fresh": fresh,
        "stale": stale,
        "path": str(PEOPLE_FILE),
    }


# ── jarvis-improve hook ─────────────────────────────────────────────
def main() -> int:
    """Entrypoint for jarvis-improve. Updates stale contacts."""
    if os.environ.get("JARVIS_CONTACTS", "1") != "1":
        return 0
    res = update_contacts()
    if res.get("ok"):
        print(f"jarvis-contacts: enriched={res.get('enriched', 0)} "
              f"skipped={res.get('skipped', 0)}")
        return 0
    print(f"jarvis-contacts: skipped — {res.get('error', 'unknown')}", file=sys.stderr)
    return 0  # never fail the chain


# ── CLI ─────────────────────────────────────────────────────────────
def _cli() -> int:
    args = sys.argv[1:]
    if not args:
        return main()
    if args[0] in ("-h", "--help"):
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

    if cmd == "--lookup":
        if not rest:
            print("usage: --lookup NAME", file=sys.stderr)
            return 2
        print(json.dumps(lookup_contact(rest[0]), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--brief":
        if not rest:
            print("usage: --brief NAME", file=sys.stderr)
            return 2
        print(json.dumps(relationship_brief(rest[0]), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--enrich":
        if not rest or rest[0].startswith("--"):
            print("usage: --enrich NAME [--force]", file=sys.stderr)
            return 2
        force = "--force" in rest
        print(json.dumps(enrich_contact(rest[0], force=force),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--apollo":
        if not rest or rest[0].startswith("--"):
            print("usage: --apollo NAME [--force]", file=sys.stderr)
            return 2
        force = "--force" in rest
        print(json.dumps(apollo_enrich(rest[0], force=force),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--sync":
        enrich = "--no-enrich" not in rest
        limit_str = _flag("--limit")
        limit = int(limit_str) if limit_str else None
        print(json.dumps(sync_from_apple_contacts(enrich=enrich, limit=limit),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--update-all":
        print(json.dumps(update_contacts(), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--add":
        if not rest or rest[0].startswith("--"):
            print("usage: --add NAME [--email X] [--telegram @Y] [--rel '...'] [--note '...']",
                  file=sys.stderr)
            return 2
        print(json.dumps(add_contact(
            rest[0],
            email=_flag("--email"),
            telegram_handle=_flag("--telegram"),
            relationship=_flag("--rel"),
            notes=_flag("--note"),
        ), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--status":
        print(json.dumps(status(), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--note":
        if len(rest) < 3:
            print("usage: --note CHANNEL HANDLE 'summary'", file=sys.stderr)
            return 2
        print(json.dumps(note_interaction(rest[0], rest[1], rest[2]),
                         indent=2, ensure_ascii=False))
        return 0
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
