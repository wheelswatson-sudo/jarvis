#!/usr/bin/env python3
"""Style Cloning Engine — learns Watson's writing DNA and rewrites drafts.

Public functions (all return JSON-serializable dicts so jarvis-think.py
can wire them straight into the tool layer):

    analyze(source="email"|"telegram"|"both", count=50, force=False)
        Pull Watson's recent sent messages, build a style fingerprint,
        store it at ~/.jarvis/style/profile.json. `force=False` skips
        the call if the on-disk profile is fresh (< 6 days old).

    apply_style(text, channel="email"|"telegram"|None) -> {styled, original}
        Rewrite `text` to match Watson's voice via Haiku, with the
        active style profile injected as system context. Channel hints
        let the rewrite weight email vs Telegram patterns.

    get_profile() -> dict
        Return the current style profile (or {} if none built yet).

    pending_refresh() -> bool
        True if the profile is missing or older than the refresh
        interval. Used by jarvis-improve to decide whether to rebuild.

CLI:
    bin/jarvis-style.py --analyze [--source email|telegram|both] [--count N] [--force]
    bin/jarvis-style.py --apply "draft text"  [--channel email|telegram]
    bin/jarvis-style.py --status
    bin/jarvis-style.py --show

Files written:
    ~/.jarvis/style/profile.json    style fingerprint (single source of truth)
    ~/.jarvis/logs/style.log        diagnostics

Gate: JARVIS_STYLE=1 (default).
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
STYLE_DIR = ASSISTANT_DIR / "style"
PROFILE_FILE = STYLE_DIR / "profile.json"
LOG_DIR = ASSISTANT_DIR / "logs"
STYLE_LOG = LOG_DIR / "style.log"

REFRESH_INTERVAL_S = int(os.environ.get("JARVIS_STYLE_REFRESH_S", str(6 * 86400)))  # 6 days
MIN_SAMPLE_LEN = 12   # ignore one-word sends ("ok", "thanks")
MAX_SAMPLE_LEN = 4000  # truncate huge replies before analysis

ANALYZER_MODEL = os.environ.get("JARVIS_STYLE_ANALYZER", "claude-haiku-4-5-20251001")
APPLIER_MODEL = os.environ.get("JARVIS_STYLE_APPLIER", "claude-haiku-4-5-20251001")


# ── Logging ─────────────────────────────────────────────────────────
def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with STYLE_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


# ── Gate ────────────────────────────────────────────────────────────
def _gate_check() -> dict | None:
    if os.environ.get("JARVIS_STYLE", "1") != "1":
        return {"error": "style cloning disabled (JARVIS_STYLE=0)"}
    return None


# ── Lazy module loaders (email + telegram are siblings in bin/) ─────
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


# ── Sample collection ───────────────────────────────────────────────
def _strip_email_body(raw: str) -> str:
    """Crude email body cleanup for style analysis. Drops quoted replies,
    signatures, forwarded blocks. Keeps it Watson's prose only."""
    if not raw:
        return ""
    # Cut off everything from common reply boundary markers.
    cutoffs = [
        r"\nOn .+ wrote:",
        r"\n-{2,}\s*Original Message\s*-{2,}",
        r"\nFrom: .+\nSent: .+",
        r"\n>\s",  # quoted block start
    ]
    text = raw
    for pat in cutoffs:
        m = re.search(pat, text)
        if m:
            text = text[: m.start()]
    # Drop signature blocks (-- on a line by itself, or trailing "Sent from my…")
    text = re.split(r"\n--\s*\n", text, maxsplit=1)[0]
    text = re.split(r"\nSent from my ", text, maxsplit=1)[0]
    return text.strip()


def _gather_email_samples(count: int) -> list[dict]:
    """Pull the last `count` messages from the user's Sent box and decode
    plain-text bodies. Returns [] if Gmail is unauthorised or libs missing."""
    email_mod = _load_sibling("jarvis-email.py")
    if email_mod is None:
        return []
    svc, _g = email_mod._gmail_service()  # type: ignore[attr-defined]
    if svc is None:
        return []
    try:
        resp = svc.users().messages().list(
            userId="me", q="in:sent -in:chats",
            maxResults=max(5, min(count, 200)),
        ).execute()
    except Exception as e:
        _log(f"sent list failed: {e}")
        return []
    samples: list[dict] = []
    for m in resp.get("messages", []) or []:
        try:
            full = svc.users().messages().get(
                userId="me", id=m["id"], format="full",
            ).execute()
        except Exception as e:
            _log(f"get message {m.get('id')} failed: {e}")
            continue
        body = _extract_plain_body(full)
        body = _strip_email_body(body)
        if len(body) < MIN_SAMPLE_LEN:
            continue
        samples.append({
            "channel": "email",
            "ts": int(int(full.get("internalDate", 0)) / 1000),
            "to": email_mod._decode_header(  # type: ignore[attr-defined]
                (full.get("payload") or {}).get("headers") or [], "To"),
            "subject": email_mod._decode_header(  # type: ignore[attr-defined]
                (full.get("payload") or {}).get("headers") or [], "Subject"),
            "body": body[:MAX_SAMPLE_LEN],
        })
    return samples


def _extract_plain_body(message: dict) -> str:
    """Walk a Gmail payload tree and return the first plaintext part as a
    decoded string. Falls back to the snippet if nothing decodes."""
    import base64

    def walk(part: dict) -> str | None:
        mime = (part.get("mimeType") or "").lower()
        body = part.get("body") or {}
        data = body.get("data") or ""
        if mime == "text/plain" and data:
            try:
                return base64.urlsafe_b64decode(data + "===").decode("utf-8", errors="replace")
            except Exception:
                return None
        for sub in part.get("parts") or []:
            out = walk(sub)
            if out:
                return out
        return None

    payload = message.get("payload") or {}
    txt = walk(payload)
    if txt:
        return txt
    return message.get("snippet") or ""


def _gather_telegram_samples(count: int) -> list[dict]:
    """Read the telegram cache, filter by Watson's identity, return recent
    sends. Identity is matched against JARVIS_USER_TELEGRAM_USERNAME (no @)
    or JARVIS_USER_TELEGRAM_ID. Without either, returns []."""
    user_handle = (os.environ.get("JARVIS_USER_TELEGRAM_USERNAME") or "").lstrip("@").lower()
    user_id_raw = os.environ.get("JARVIS_USER_TELEGRAM_ID") or ""
    user_id = int(user_id_raw) if user_id_raw.isdigit() else None
    if not user_handle and user_id is None:
        return []

    tg_mod = _load_sibling("jarvis-telegram.py")
    if tg_mod is None:
        return []
    cfg = tg_mod._load_config()  # type: ignore[attr-defined]
    groups = cfg.get("monitored_groups") or []
    if not groups:
        return []

    samples: list[dict] = []
    for g in groups:
        # Pull the entire cache (since=0); we'll filter + cap below.
        recs = tg_mod._read_cache(g["id"], 0)  # type: ignore[attr-defined]
        for r in recs:
            text = (r.get("text") or "").strip()
            if len(text) < MIN_SAMPLE_LEN:
                continue
            from_user = (r.get("from_username") or "").lstrip("@").lower()
            from_id = r.get("from_id")
            if not (
                (user_handle and from_user == user_handle)
                or (user_id is not None and from_id == user_id)
            ):
                continue
            samples.append({
                "channel": "telegram",
                "ts": int(r.get("date") or 0),
                "group": g.get("title") or "",
                "body": text[:MAX_SAMPLE_LEN],
            })
    samples.sort(key=lambda s: s.get("ts") or 0, reverse=True)
    return samples[:count]


# ── Heuristic statistics ────────────────────────────────────────────
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z(])")
_WORD_RE = re.compile(r"\b[\w']+\b")
_GREETING_LINE_RE = re.compile(
    r"^\s*(hey|hi|hello|good morning|morning|good evening|evening|"
    r"yo|sup|thanks|thank you|appreciate|cheers)\b[^\n]*",
    re.I,
)
_CLOSING_LINE_RE = re.compile(
    r"^\s*(thanks|thank you|cheers|best|regards|talk soon|appreciate it|"
    r"sincerely|warmly|all the best|—|--|let me know|sounds good|will do|"
    r"got it|on it|catch up soon)\b[^\n]*",
    re.I,
)


def _heuristic_stats(samples: list[dict]) -> dict:
    """Pure-Python descriptive stats. Cheap, deterministic."""
    if not samples:
        return {
            "samples": 0,
            "avg_sentence_length_words": 0.0,
            "avg_message_length_words": 0.0,
            "median_message_length_words": 0.0,
            "exclamation_rate": 0.0,
            "question_rate": 0.0,
            "ellipsis_rate": 0.0,
            "em_dash_rate": 0.0,
            "all_caps_word_rate": 0.0,
            "first_person_rate": 0.0,
        }
    sentence_word_counts: list[int] = []
    message_word_counts: list[int] = []
    excl = quest = ellipsis = em_dash = caps_words = first_person = total_words = 0
    for s in samples:
        body = (s.get("body") or "").strip()
        if not body:
            continue
        words = _WORD_RE.findall(body)
        message_word_counts.append(len(words))
        total_words += len(words)
        excl += body.count("!")
        quest += body.count("?")
        ellipsis += body.count("...") + body.count("…")
        em_dash += body.count("—") + body.count(" -- ")
        for w in words:
            if w.isupper() and len(w) > 1:
                caps_words += 1
            wl = w.lower()
            if wl in {"i", "i'm", "i'll", "i've", "i'd", "me", "my", "mine"}:
                first_person += 1
        for sent in _SENTENCE_SPLIT_RE.split(body):
            sw = _WORD_RE.findall(sent)
            if sw:
                sentence_word_counts.append(len(sw))

    def safe_div(a: int, b: int) -> float:
        return round(a / b, 4) if b else 0.0

    return {
        "samples": len(samples),
        "avg_sentence_length_words": round(
            statistics.mean(sentence_word_counts), 2) if sentence_word_counts else 0.0,
        "avg_message_length_words": round(
            statistics.mean(message_word_counts), 2) if message_word_counts else 0.0,
        "median_message_length_words": round(
            statistics.median(message_word_counts), 2) if message_word_counts else 0.0,
        "exclamation_rate": safe_div(excl, len(samples)),
        "question_rate": safe_div(quest, len(samples)),
        "ellipsis_rate": safe_div(ellipsis, len(samples)),
        "em_dash_rate": safe_div(em_dash, len(samples)),
        "all_caps_word_rate": safe_div(caps_words, total_words),
        "first_person_rate": safe_div(first_person, total_words),
    }


def _extract_greeting_closing(samples: list[dict]) -> tuple[list[str], list[str]]:
    greetings: dict[str, int] = {}
    closings: dict[str, int] = {}
    for s in samples:
        body = (s.get("body") or "").strip()
        if not body:
            continue
        lines = [l.strip() for l in body.splitlines() if l.strip()]
        if not lines:
            continue
        m = _GREETING_LINE_RE.match(lines[0])
        if m:
            phrase = lines[0][: 80].rstrip(",.!?")
            greetings[phrase] = greetings.get(phrase, 0) + 1
        for tail in lines[-2:]:
            m = _CLOSING_LINE_RE.match(tail)
            if m:
                phrase = tail[: 80].rstrip(",.!?")
                closings[phrase] = closings.get(phrase, 0) + 1
                break

    def top(d: dict, k: int = 6) -> list[str]:
        return [p for p, _ in sorted(d.items(), key=lambda kv: -kv[1])[:k]]

    return top(greetings), top(closings)


# ── Anthropic call (matches the pattern in jarvis-research.py) ──────
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


# ── Synthesis (Haiku) ───────────────────────────────────────────────
SYNTHESIZE_SYSTEM = """You are a writing-style analyst. You will be given a batch of Watson's recent sent messages (email and/or Telegram).

Output ONE valid JSON object — no prose, no fences. Schema:

{
  "tone_summary": "2-3 sentence description of his voice across both channels — register, warmth, directness, signature ticks.",
  "common_phrases": ["Up to 8 short recurring phrases or constructions Watson actually uses (e.g. 'sounds good', 'let me check', 'on it'). Verbatim, no paraphrase."],
  "idioms_or_quirks": ["Specific verbal tells — favourite hedges, sentence starters, sign-offs, punctuation habits. Each item is a one-line description."],
  "register_email": "1-2 sentences describing his email register specifically (more formal? structured? signature?).",
  "register_telegram": "1-2 sentences describing his Telegram register specifically (more clipped? lowercase? emoji?).",
  "do_list": ["3-5 imperative bullets a rewriter should DO to sound like Watson."],
  "dont_list": ["3-5 imperative bullets a rewriter should NEVER do (formal phrases he avoids, register breaks, etc.)."]
}

Be concrete and specific — quote his actual phrases when possible. Avoid generic writing-coach platitudes ('be clear', 'be concise'). Pull what's *distinctive* about Watson's voice."""


def _synthesize_with_haiku(samples: list[dict], api_key: str) -> dict:
    """Send the trimmed sample bundle to Haiku and parse the JSON response.
    Falls back to an empty profile on any error."""
    if not samples:
        return {}

    blocks: list[str] = []
    for s in samples[:60]:
        ch = s.get("channel", "?")
        head = f"[{ch}] {s.get('subject') or s.get('group') or ''}".strip()
        body = (s.get("body") or "").strip()
        if len(body) > 800:
            body = body[:800] + "…"
        blocks.append(f"--- {head}\n{body}")
    prompt = "Watson's recent sent messages:\n\n" + "\n\n".join(blocks)
    try:
        raw = _anthropic_call(api_key, ANALYZER_MODEL, SYNTHESIZE_SYSTEM, prompt,
                              max_tokens=1200, timeout=45.0)
    except Exception as e:
        _log(f"haiku synthesize failed: {e}")
        return {}
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        _log(f"haiku synthesize: no JSON found in response (head: {raw[:200]!r})")
        return {}
    try:
        parsed = json.loads(m.group(0))
    except json.JSONDecodeError as e:
        _log(f"haiku synthesize: JSON decode failed ({e})")
        return {}
    if not isinstance(parsed, dict):
        return {}
    parsed.setdefault("tone_summary", "")
    parsed.setdefault("common_phrases", [])
    parsed.setdefault("idioms_or_quirks", [])
    parsed.setdefault("register_email", "")
    parsed.setdefault("register_telegram", "")
    parsed.setdefault("do_list", [])
    parsed.setdefault("dont_list", [])
    return parsed


# ── Profile I/O ─────────────────────────────────────────────────────
def _save_profile(profile: dict) -> None:
    STYLE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = PROFILE_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(profile, f, indent=2, ensure_ascii=False)
    os.replace(tmp, PROFILE_FILE)


def get_profile() -> dict:
    if not PROFILE_FILE.exists():
        return {}
    try:
        return json.loads(PROFILE_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        _log(f"profile read failed: {e}")
        return {}


def pending_refresh() -> bool:
    if not PROFILE_FILE.exists():
        return True
    try:
        age = time.time() - PROFILE_FILE.stat().st_mtime
    except Exception:
        return True
    return age > REFRESH_INTERVAL_S


# ── Public: analyze ─────────────────────────────────────────────────
def analyze(source: str = "both", count: int = 50, force: bool = False) -> dict:
    """Pull recent sent messages, build a fingerprint, save it. Returns
    {ok, profile_path, samples, age, sources, ...} or {error}."""
    gate = _gate_check()
    if gate:
        return gate
    if source not in ("email", "telegram", "both"):
        return {"error": f"invalid source: {source!r}"}
    if not force and not pending_refresh():
        prof = get_profile()
        return {
            "ok": True,
            "skipped": True,
            "reason": "profile is fresh — pass force=true to rebuild",
            "profile": prof,
        }
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {"error": "ANTHROPIC_API_KEY not set"}

    samples: list[dict] = []
    counts = {"email": 0, "telegram": 0}
    if source in ("email", "both"):
        es = _gather_email_samples(count)
        samples.extend(es)
        counts["email"] = len(es)
    if source in ("telegram", "both"):
        ts_ = _gather_telegram_samples(count)
        samples.extend(ts_)
        counts["telegram"] = len(ts_)

    if not samples:
        return {
            "error": "no samples gathered — auth, gate, or identity env not configured",
            "sources_tried": source,
            "counts": counts,
        }

    stats = _heuristic_stats(samples)
    greetings, closings = _extract_greeting_closing(samples)
    synthesis = _synthesize_with_haiku(samples, api_key)

    # Pick 3 short exemplars for downstream priming.
    exemplars = []
    for s in samples:
        body = (s.get("body") or "").strip()
        if 40 <= len(body) <= 280:
            exemplars.append({
                "channel": s.get("channel"),
                "body": body,
            })
        if len(exemplars) >= 3:
            break

    profile = {
        "version": "1.0",
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "sources": source,
        "counts": counts,
        "stats": stats,
        "common_greetings": greetings,
        "common_closings": closings,
        "synthesis": synthesis,
        "exemplars": exemplars,
    }
    _save_profile(profile)
    _log(
        f"analyze ok — samples={len(samples)} "
        f"(email={counts['email']}, telegram={counts['telegram']})"
    )
    return {
        "ok": True,
        "profile_path": str(PROFILE_FILE),
        "samples": len(samples),
        "counts": counts,
    }


# ── Public: apply_style ─────────────────────────────────────────────
APPLY_SYSTEM_TEMPLATE = """You are rewriting a draft to match Watson's personal voice. You have his style profile below — follow it closely.

## Style profile

{profile_block}

## Channel
{channel_note}

## Rules
- Preserve the message's meaning, recipient, and any factual content (names, dates, numbers, URLs) exactly.
- Match Watson's register, sentence length, greeting/closing habits, and signature phrases.
- DO NOT explain what you changed. DO NOT add disclaimers. DO NOT use markdown.
- Output ONLY the rewritten message text — nothing else.
"""


def _format_profile_for_prompt(profile: dict) -> str:
    if not profile:
        return "(profile not yet built — match a generally clear, friendly, direct register.)"
    syn = profile.get("synthesis") or {}
    stats = profile.get("stats") or {}
    parts: list[str] = []
    if syn.get("tone_summary"):
        parts.append(f"**Tone:** {syn['tone_summary']}")
    if profile.get("common_greetings"):
        parts.append(f"**Greetings he uses:** {', '.join(profile['common_greetings'][:5])}")
    if profile.get("common_closings"):
        parts.append(f"**Closings he uses:** {', '.join(profile['common_closings'][:5])}")
    if syn.get("common_phrases"):
        parts.append("**Recurring phrases:** " + "; ".join(syn["common_phrases"][:8]))
    if syn.get("idioms_or_quirks"):
        parts.append("**Quirks:**\n- " + "\n- ".join(syn["idioms_or_quirks"][:6]))
    if syn.get("do_list"):
        parts.append("**Do:**\n- " + "\n- ".join(syn["do_list"]))
    if syn.get("dont_list"):
        parts.append("**Don't:**\n- " + "\n- ".join(syn["dont_list"]))
    if stats:
        parts.append(
            f"**Cadence:** ~{stats.get('avg_sentence_length_words', 0):.0f} words/sentence; "
            f"messages typically {stats.get('median_message_length_words', 0):.0f} words; "
            f"first-person rate {stats.get('first_person_rate', 0):.2f}."
        )
    return "\n\n".join(parts)


def apply_style(text: str, channel: str | None = None) -> dict:
    """Rewrite `text` in Watson's voice. Returns {styled, original} or
    {error}. If the profile is missing or the API key is unset, the
    original text is returned unchanged with a `passthrough` flag set."""
    gate = _gate_check()
    if gate:
        return gate
    text = (text or "").strip()
    if not text:
        return {"error": "text is required"}

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    profile = get_profile()
    if not api_key or not profile:
        return {
            "styled": text,
            "original": text,
            "passthrough": True,
            "reason": "no API key" if not api_key else "no style profile yet",
        }
    syn = profile.get("synthesis") or {}
    if channel == "email":
        channel_note = "Email — " + (syn.get("register_email") or "use his email register.")
    elif channel == "telegram":
        channel_note = "Telegram — " + (syn.get("register_telegram") or "use his Telegram register.")
    else:
        channel_note = "Mixed — match his general voice."
    system = APPLY_SYSTEM_TEMPLATE.format(
        profile_block=_format_profile_for_prompt(profile),
        channel_note=channel_note,
    )
    try:
        rewritten = _anthropic_call(
            api_key, APPLIER_MODEL, system, text,
            max_tokens=1024, timeout=20.0,
        )
    except Exception as e:
        _log(f"apply_style failed: {e}")
        return {
            "styled": text,
            "original": text,
            "passthrough": True,
            "reason": f"haiku error: {e}",
        }
    rewritten = rewritten.strip()
    if not rewritten:
        return {
            "styled": text,
            "original": text,
            "passthrough": True,
            "reason": "empty rewrite",
        }
    return {
        "styled": rewritten,
        "original": text,
        "passthrough": False,
    }


# ── Status / smoke test ─────────────────────────────────────────────
def status() -> dict:
    prof = get_profile()
    if not prof:
        return {
            "ok": True,
            "built": False,
            "hint": "run `jarvis-style.py --analyze`",
        }
    age_s = int(time.time() - PROFILE_FILE.stat().st_mtime)
    return {
        "ok": True,
        "built": True,
        "updated_at": prof.get("updated_at"),
        "age_s": age_s,
        "sources": prof.get("sources"),
        "counts": prof.get("counts"),
        "samples": (prof.get("stats") or {}).get("samples"),
        "stale": age_s > REFRESH_INTERVAL_S,
        "tone": (prof.get("synthesis") or {}).get("tone_summary"),
    }


# ── jarvis-improve hook ─────────────────────────────────────────────
def main() -> int:
    """Entrypoint for jarvis-improve. Refreshes the profile when stale."""
    if os.environ.get("JARVIS_STYLE", "1") != "1":
        return 0
    if not pending_refresh():
        return 0
    res = analyze(source="both", count=50, force=False)
    if res.get("ok"):
        print(f"jarvis-style: refreshed profile ({res.get('samples', 0)} samples)")
        return 0
    print(f"jarvis-style: refresh skipped — {res.get('error', 'unknown')}", file=sys.stderr)
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

    if cmd == "--analyze":
        source = _flag("--source", "both") or "both"
        count = int(_flag("--count", "50") or "50")
        force = "--force" in rest
        print(json.dumps(analyze(source=source, count=count, force=force),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--apply":
        if len(rest) < 1 or rest[0].startswith("--"):
            print("usage: --apply 'text' [--channel email|telegram]", file=sys.stderr)
            return 2
        text = rest[0]
        channel = _flag("--channel")
        print(json.dumps(apply_style(text, channel=channel),
                         indent=2, ensure_ascii=False))
        return 0
    if cmd == "--status":
        print(json.dumps(status(), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--show":
        print(json.dumps(get_profile(), indent=2, ensure_ascii=False))
        return 0
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
