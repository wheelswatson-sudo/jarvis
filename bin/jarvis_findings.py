#!/usr/bin/env python3
"""
jarvis_findings — data layer for the persistent epistemic spine.

A "finding" is a structured belief the assistant has formed: epistemic
type (fact/opinion/belief/hypothesis), status (open → validated → ...),
confidence, sources, and a full revision history. Findings persist
across sessions so prior conclusions are not silently re-derived.

Layout (~/.jarvis/findings/):
    active/F-<id>.md       canonical finding files
    superseded/F-<id>.md   demoted, audit-preserved
    outdated/F-<id>.md     auto-aged out (Phase 4)
    cold/                  pruned (Phase 4)
    events.jsonl           append-only event stream — source of truth
    index.md               human-navigable index, regenerated

ID is `F-<sha1(normalize(claim))[:6]>`. Same claim → same ID, idempotent.

Frontmatter format (line-based, JSON values for lists/dicts):
    ---
    id: F-a1b2c3
    type: opinion
    tags: ["caching","claude-api"]
    sources_json: [{"kind":"web","url":"..."}]
    ---
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOME = Path.home()
ROOT = HOME / ".jarvis" / "findings"
ACTIVE = ROOT / "active"
SUPERSEDED = ROOT / "superseded"
OUTDATED = ROOT / "outdated"
COLD = ROOT / "cold"
PURGED = ROOT / ".purged"
CACHE = ROOT / ".cache"
STATS_CACHE = CACHE / "stats.json"
EVENTS = ROOT / "events.jsonl"
INDEX = ROOT / "index.md"

DB = HOME / ".claude" / "memory-tools" / "memory.db"


def _connect_db() -> sqlite3.Connection:
    """Open the findings DB with WAL + a busy timeout. Findings are written
    by both interactive (jarvis-think) and cron (improve / evolve / reconcile)
    paths; the default rollback journal would surface as silent
    OperationalError("database is locked") on contention."""
    conn = sqlite3.connect(DB, timeout=30)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
    except sqlite3.OperationalError:
        pass
    return conn

VALID_TYPES = {"fact", "opinion", "belief", "hypothesis"}
VALID_STATUSES = {
    "open",
    "investigating",
    "validated",
    "rejected",
    "superseded",
    "implemented",
    "outdated",
}
VALID_CONFIDENCES = {"high", "medium", "low"}

DEFAULT_REVISIT_DAYS = {
    "fact": 365,
    "opinion": 90,
    "belief": 180,
    "hypothesis": 30,
}

SCALAR_KEYS = {
    "id", "type", "status", "confidence", "claim",
    "captured_ts", "captured_session", "captured_trigger",
    "last_revised_ts", "last_review_ts",
    "revisit_after_days", "superseded_by",
    "verified_by", "verified_at",
}
LIST_KEYS_JSON = {"tags", "supersedes", "sources_json", "related_findings"}

# Verification discipline: every confidence=high capture must declare HOW the
# claim was verified. `training-knowledge` is rejected for high — it forces
# the user to either downgrade to medium or actually verify.
VERIFIED_BY_VALUES = {
    "code",                # specific code path inspected — must cite via --source code,...
    "web-fetched",         # URL was actually retrieved — must cite via --source-url
    "user-confirmed",      # user explicitly stated this in conversation
    "tested",              # claim was empirically validated (ran a test, observed output)
    "cross-checked",       # corroborated against another finding or independent source
    "training-knowledge",  # only the model's pretraining — REJECTED for confidence=high
}
VERIFIED_BY_FOR_HIGH = VERIFIED_BY_VALUES - {"training-knowledge"}


# ---------------------------------------------------------------------------
# IDs & timestamps
# ---------------------------------------------------------------------------

def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize_claim(claim: str) -> str:
    # Lowercase, replace separator punctuation with spaces (so "prompt-cache"
    # and "prompt cache" hash identically), strip remaining punctuation, then
    # collapse whitespace.
    s = claim.lower()
    s = re.sub(r"[-_/]", " ", s)              # treat hyphens/underscores/slashes as word breaks
    s = re.sub(r"[^\w\s]", "", s)             # strip remaining punctuation
    return re.sub(r"\s+", " ", s).strip()


def make_id(claim: str) -> str:
    return f"F-{hashlib.sha1(normalize_claim(claim).encode()).hexdigest()[:6]}"


def parse_iso(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def parse_window(s: str) -> timedelta:
    m = re.match(r"^(\d+)([hd])$", s.lower())
    if not m:
        raise ValueError(f"bad time window: {s} (use Nh or Nd)")
    n, u = int(m.group(1)), m.group(2)
    return timedelta(hours=n) if u == "h" else timedelta(days=n)


# ---------------------------------------------------------------------------
# Frontmatter (line-based, JSON values for lists)
# ---------------------------------------------------------------------------

def _quote_scalar(v) -> str:
    s = str(v)
    needs_quote = (
        any(c in s for c in ":#[]{},\n")
        or s != s.strip()
        or s.startswith(("-", "?", "!", "&", "*", "|", ">", "%"))
        or s in ("null", "true", "false")
    )
    if not needs_quote:
        return s
    return json.dumps(s, ensure_ascii=False)


def render_frontmatter(meta: dict) -> str:
    lines = ["---"]
    ordered = [
        "id", "type", "status", "confidence", "verified_by", "verified_at",
        "claim", "tags",
        "captured_ts", "captured_session", "captured_trigger",
        "last_revised_ts", "last_review_ts", "revisit_after_days",
        "supersedes", "superseded_by", "sources_json", "related_findings",
    ]
    for k in ordered:
        if k not in meta:
            continue
        v = meta[k]
        if v is None:
            lines.append(f"{k}: null")
        elif k in LIST_KEYS_JSON:
            lines.append(f"{k}: {json.dumps(v, ensure_ascii=False, separators=(',', ':'))}")
        elif isinstance(v, bool):
            lines.append(f"{k}: {str(v).lower()}")
        elif isinstance(v, (int, float)):
            lines.append(f"{k}: {v}")
        else:
            lines.append(f"{k}: {_quote_scalar(v)}")
    lines.append("---")
    return "\n".join(lines)


def parse_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---", 4)
    if end < 0:
        return {}, text
    fm = text[4:end]
    body_start = end + 4
    if text[body_start:body_start + 1] == "\n":
        body_start += 1
    body = text[body_start:]
    meta: dict = {}
    for line in fm.split("\n"):
        if not line.strip() or line.startswith("#"):
            continue
        m = re.match(r"^([\w_]+)\s*:\s*(.*)$", line)
        if not m:
            continue
        k, v = m.group(1), m.group(2).strip()
        if v == "":
            meta[k] = None
        elif v == "null":
            meta[k] = None
        elif v == "true":
            meta[k] = True
        elif v == "false":
            meta[k] = False
        elif k in LIST_KEYS_JSON or v.startswith("[") or v.startswith("{"):
            try:
                meta[k] = json.loads(v)
            except json.JSONDecodeError:
                meta[k] = v
        elif v.startswith('"') and v.endswith('"') and len(v) >= 2:
            try:
                meta[k] = json.loads(v)
            except json.JSONDecodeError:
                meta[k] = v[1:-1]
        elif re.match(r"^-?\d+$", v):
            meta[k] = int(v)
        elif re.match(r"^-?\d+\.\d+$", v):
            meta[k] = float(v)
        else:
            meta[k] = v
    return meta, body


# ---------------------------------------------------------------------------
# Filesystem helpers
# ---------------------------------------------------------------------------

def ensure_dirs():
    for d in (ACTIVE, SUPERSEDED, OUTDATED, COLD, PURGED, CACHE):
        d.mkdir(parents=True, exist_ok=True)
    EVENTS.parent.mkdir(parents=True, exist_ok=True)


def find_path(fid: str) -> Path | None:
    # PURGED is intentionally excluded — purged findings should not surface
    # via load_finding(). They survive only as audit artifacts.
    for d in (ACTIVE, SUPERSEDED, OUTDATED, COLD):
        p = d / f"{fid}.md"
        if p.exists():
            return p
    return None


def load_finding(fid: str) -> dict | None:
    p = find_path(fid)
    if not p:
        return None
    meta, body = parse_frontmatter(p.read_text())
    meta["_path"] = str(p)
    meta["_body"] = body
    return meta


def render_finding(meta: dict, body: str | None = None, initial_reasoning: str | None = None) -> str:
    fm = render_frontmatter({k: v for k, v in meta.items() if not k.startswith("_")})
    if body is None:
        reasoning = initial_reasoning or "_(captured; awaiting investigation)_"
        body = (
            f"\n\n## Claim\n{meta['claim']}\n\n"
            f"## Reasoning / Evidence\n{reasoning}\n\n"
            f"## Implications\n_(to be added on revisit)_\n\n"
            f"## Revision history\n"
            f"- {meta['captured_ts']} · captured · "
            f"status={meta['status']}, confidence={meta['confidence']} · "
            f"session {meta.get('captured_session') or '?'}\n"
        )
    return fm + body


def write_finding(meta: dict, body: str | None = None, dest: Path | None = None,
                  initial_reasoning: str | None = None) -> Path:
    if dest is None:
        dest = ACTIVE / f"{meta['id']}.md"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(render_finding(meta, body, initial_reasoning))
    return dest


def append_event(event: dict) -> None:
    ensure_dirs()
    with EVENTS.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n")


def append_history(body: str, entries: list[str]) -> str:
    if not entries:
        return body
    marker = "## Revision history"
    if marker not in body:
        body = body.rstrip() + "\n\n" + marker + "\n"
    return body.rstrip() + "\n" + "\n".join(entries) + "\n"


# ---------------------------------------------------------------------------
# Capture / revise / supersede
# ---------------------------------------------------------------------------

def capture(claim: str, type_: str, *, confidence: str = "medium",
            tags: list[str] | None = None, sources: list[dict] | None = None,
            trigger: str | None = None, session: str | None = None,
            initial_reasoning: str | None = None,
            revisit_after_days: int | None = None,
            verified_by: str | None = None,
            force_new: bool = False) -> tuple[str, str]:
    if type_ not in VALID_TYPES:
        raise ValueError(f"type must be one of {sorted(VALID_TYPES)}")
    if confidence not in VALID_CONFIDENCES:
        raise ValueError(f"confidence must be one of {sorted(VALID_CONFIDENCES)}")
    if verified_by is not None and verified_by not in VERIFIED_BY_VALUES:
        raise ValueError(
            f"verified_by must be one of {sorted(VERIFIED_BY_VALUES)} (got: {verified_by!r})"
        )

    # Discipline: confidence=high requires an explicit verification method,
    # and that method must not be 'training-knowledge'. Forces a real source.
    if confidence == "high":
        if not verified_by:
            raise ValueError(
                "capture refused: confidence=high requires --verified-by "
                f"(one of {sorted(VERIFIED_BY_FOR_HIGH)}). "
                "If you only have training-knowledge, downgrade to --confidence medium."
            )
        if verified_by not in VERIFIED_BY_FOR_HIGH:
            raise ValueError(
                f"capture refused: --verified-by {verified_by} is not strong enough "
                f"for confidence=high. Either verify properly or downgrade to medium."
            )
        if verified_by == "web-fetched":
            has_web_source = any(
                (s.get("kind") == "web") and s.get("url")
                for s in (sources or [])
            )
            if not has_web_source:
                raise ValueError(
                    "capture refused: --verified-by web-fetched requires at least one "
                    "--source-url that you actually retrieved at capture time."
                )
        if verified_by == "code":
            has_code_source = any(
                (s.get("kind") == "code") for s in (sources or [])
            )
            if not has_code_source:
                raise ValueError(
                    "capture refused: --verified-by code requires at least one "
                    "--source code,<path>[,<note>] citing the inspected code."
                )

    fid = make_id(claim)
    existing = load_finding(fid)
    ts = now_iso()

    if existing and not force_new:
        append_event({
            "ts": ts, "finding_id": fid, "event": "rediscovery",
            "session": session or "", "trigger": trigger or "",
        })
        return fid, "duplicate"

    if not force_new:
        # Near-match dedup: shortlist candidates via FTS5, then compare
        # token-overlap (Jaccard ≥ 0.6) against active findings. Refuses to
        # write a new file when an existing finding looks like the same claim.
        near = _find_near_duplicate(claim, fid)
        if near is not None:
            append_event({
                "ts": ts, "finding_id": near["id"], "event": "near-duplicate",
                "candidate_claim": claim, "candidate_id": fid,
                "jaccard": float(near["jaccard"]),
                "session": session or "", "trigger": trigger or "",
            })
            return near["id"], "near-duplicate"

    meta = {
        "id": fid,
        "type": type_,
        "status": "open",
        "confidence": confidence,
        "verified_by": verified_by,
        "verified_at": ts if verified_by else None,
        "claim": claim,
        "tags": list(tags or []),
        "captured_ts": ts,
        "captured_session": session or "",
        "captured_trigger": trigger or "",
        "last_revised_ts": ts,
        "last_review_ts": ts,
        "revisit_after_days": revisit_after_days or DEFAULT_REVISIT_DAYS[type_],
        "supersedes": [],
        "superseded_by": None,
        "sources_json": list(sources or []),
        "related_findings": [],
    }
    ensure_dirs()
    write_finding(meta, initial_reasoning=initial_reasoning)
    append_event({
        "ts": ts, "finding_id": fid, "event": "capture",
        "type": type_, "status": "open", "confidence": confidence,
        "session": session or "", "trigger": trigger or "",
    })
    reindex_one(fid)
    write_stats_cache()
    return fid, "new"


def _stem(t: str) -> str:
    # Cheap suffix stripper for the dedup heuristic only — unifies plural /
    # gerund / participle forms. Not Porter-quality; intentional minimum.
    for suf in ("ies", "es", "ed", "ing", "s", "e"):
        if len(t) > len(suf) + 2 and t.endswith(suf):
            return t[: -len(suf)]
    return t


def _claim_tokens(claim: str) -> set[str]:
    return {_stem(t) for t in _tokenize(claim)}


def _find_near_duplicate(claim: str, candidate_id: str,
                         min_jaccard: float = 0.50) -> dict | None:
    """Compare token sets of `claim` against every active finding's claim.
       Returns {id, claim, jaccard} of the closest match if Jaccard ≥ threshold."""
    cand_toks = _claim_tokens(claim)
    if not cand_toks:
        return None
    best: dict | None = None
    if not ACTIVE.exists():
        return None
    for p in ACTIVE.glob("F-*.md"):
        if p.stem == candidate_id:
            continue
        try:
            meta, _ = parse_frontmatter(p.read_text())
        except Exception:
            continue
        existing_claim = meta.get("claim") or ""
        ex_toks = _claim_tokens(existing_claim)
        if not ex_toks:
            continue
        inter = cand_toks & ex_toks
        union = cand_toks | ex_toks
        if not union:
            continue
        j = len(inter) / len(union)
        if j >= min_jaccard and (best is None or j > best["jaccard"]):
            best = {"id": meta.get("id", p.stem), "claim": existing_claim, "jaccard": j}
    return best


def _coerce_source(s) -> dict:
    if isinstance(s, dict):
        return s
    parts = [p.strip() for p in str(s).split(",", 2)]
    if len(parts) >= 2 and parts[0] in {"web", "code", "user-statement", "doc", "derivation", "note"}:
        out = {"kind": parts[0], "url": parts[1], "fetched_ts": now_iso()}
        if len(parts) == 3 and parts[2]:
            out["note"] = parts[2]
        return out
    return {"kind": "note", "url": "", "note": str(s), "fetched_ts": now_iso()}


def revise(fid: str, *, status: str | None = None, confidence: str | None = None,
           add_source=None, reason: str | None = None,
           session: str | None = None, mark_reviewed: bool = False,
           verified_by: str | None = None) -> bool:
    meta = load_finding(fid)
    if not meta:
        raise KeyError(fid)
    body = meta.pop("_body")
    meta.pop("_path", None)
    ts = now_iso()
    history: list[str] = []
    changed = False

    # Verification discipline: revising up to confidence=high requires a fresh
    # verified_by. Same gate as capture; downgrades and lateral moves are free.
    target_confidence = confidence if confidence is not None else meta.get("confidence")
    if confidence == "high" and meta.get("confidence") != "high":
        effective_verified = verified_by or meta.get("verified_by")
        if not effective_verified or effective_verified == "training-knowledge":
            raise ValueError(
                "revise refused: promoting to confidence=high requires --verified-by "
                f"(one of {sorted(VERIFIED_BY_FOR_HIGH)}). "
                "Add a verification method or stay at the current level."
            )

    if verified_by is not None:
        if verified_by not in VERIFIED_BY_VALUES:
            raise ValueError(f"verified_by must be one of {sorted(VERIFIED_BY_VALUES)}")
        if verified_by != meta.get("verified_by"):
            append_event({
                "ts": ts, "finding_id": fid, "event": "revise",
                "field": "verified_by",
                "from": meta.get("verified_by"), "to": verified_by,
                "reason": reason or "", "session": session or "",
            })
            history.append(
                f"- {ts} · revise · verified_by={meta.get('verified_by')} → {verified_by}"
                f" · {reason or ''} · session {session or '?'}"
            )
            meta["verified_by"] = verified_by
            meta["verified_at"] = ts
            changed = True

    if status is not None:
        if status not in VALID_STATUSES:
            raise ValueError(f"status must be one of {sorted(VALID_STATUSES)}")
        if status != meta["status"]:
            append_event({
                "ts": ts, "finding_id": fid, "event": "transition",
                "field": "status", "from": meta["status"], "to": status,
                "reason": reason or "", "session": session or "",
            })
            history.append(
                f"- {ts} · transition · status={meta['status']} → {status}"
                f" · {reason or ''} · session {session or '?'}"
            )
            meta["status"] = status
            changed = True

    if confidence is not None:
        if confidence not in VALID_CONFIDENCES:
            raise ValueError(f"confidence must be one of {sorted(VALID_CONFIDENCES)}")
        if confidence != meta["confidence"]:
            append_event({
                "ts": ts, "finding_id": fid, "event": "revise",
                "field": "confidence", "from": meta["confidence"], "to": confidence,
                "reason": reason or "", "session": session or "",
            })
            history.append(
                f"- {ts} · revise · confidence={meta['confidence']} → {confidence}"
                f" · {reason or ''} · session {session or '?'}"
            )
            meta["confidence"] = confidence
            changed = True

    if add_source:
        sources = list(meta.get("sources_json") or [])
        new_sources = [add_source] if not isinstance(add_source, list) else add_source
        for s in new_sources:
            sources.append(_coerce_source(s))
        meta["sources_json"] = sources
        append_event({
            "ts": ts, "finding_id": fid, "event": "revise",
            "field": "sources", "to": f"+{len(new_sources)}",
            "reason": reason or "", "session": session or "",
        })
        history.append(
            f"- {ts} · revise · added {len(new_sources)} source(s) · {reason or ''}"
        )
        changed = True
        # auto-transition open → investigating on first source
        if meta["status"] == "open":
            meta["status"] = "investigating"
            history.append(
                f"- {ts} · transition · status=open → investigating · auto (first source)"
            )
            append_event({
                "ts": ts, "finding_id": fid, "event": "transition",
                "field": "status", "from": "open", "to": "investigating",
                "reason": "auto: first source added", "session": session or "",
            })

    if mark_reviewed:
        meta["last_review_ts"] = ts
        history.append(f"- {ts} · review · marked reviewed · session {session or '?'}")
        append_event({
            "ts": ts, "finding_id": fid, "event": "review",
            "session": session or "", "reason": reason or "",
        })
        changed = True

    if not changed:
        return False

    meta["last_revised_ts"] = ts

    # auto-validate when high confidence + at least one strong source
    if meta["confidence"] == "high" and meta["status"] in {"open", "investigating"}:
        strong = any(
            s.get("kind") in {"web", "code", "user-statement", "doc"}
            for s in meta.get("sources_json") or []
        )
        if strong:
            history.append(
                f"- {ts} · transition · status={meta['status']} → validated"
                f" · auto (high confidence + strong source) · session {session or '?'}"
            )
            append_event({
                "ts": ts, "finding_id": fid, "event": "transition",
                "field": "status", "from": meta["status"], "to": "validated",
                "reason": "auto: high confidence + strong source",
                "session": session or "",
            })
            meta["status"] = "validated"

    body = append_history(body, history)
    write_finding(meta, body)
    reindex_one(fid)
    write_stats_cache()
    return True


def supersede(new_id: str, old_id: str, *, reason: str | None = None,
              session: str | None = None) -> bool:
    new = load_finding(new_id)
    old = load_finding(old_id)
    if not new:
        raise KeyError(new_id)
    if not old:
        raise KeyError(old_id)
    ts = now_iso()
    new_body = new.pop("_body")
    new.pop("_path", None)
    old_body = old.pop("_body")
    old_path = Path(old.pop("_path"))

    new["supersedes"] = sorted(set((new.get("supersedes") or []) + [old_id]))
    new_body = append_history(new_body, [
        f"- {ts} · supersedes · {old_id} · {reason or ''} · session {session or '?'}"
    ])

    old["superseded_by"] = new_id
    old["status"] = "superseded"
    old["last_revised_ts"] = ts
    old_body = append_history(old_body, [
        f"- {ts} · superseded · by {new_id} · {reason or ''} · session {session or '?'}"
    ])

    # Move the old file into superseded/
    SUPERSEDED.mkdir(parents=True, exist_ok=True)
    new_old_path = SUPERSEDED / f"{old_id}.md"
    new_old_path.write_text(render_finding(old, old_body))
    if old_path.exists() and old_path != new_old_path:
        old_path.unlink()

    write_finding(new, new_body)

    append_event({
        "ts": ts, "finding_id": new_id, "event": "supersede",
        "supersedes": old_id, "reason": reason or "", "session": session or "",
    })
    append_event({
        "ts": ts, "finding_id": old_id, "event": "superseded",
        "by": new_id, "reason": reason or "", "session": session or "",
    })
    reindex_one(new_id)
    reindex_one(old_id)
    write_stats_cache()
    return True


def purge(fid: str, *, reason: str, session: str | None = None) -> bool:
    """Revoke a finding cleanly: move to .purged/, drop from FTS5, append a
    `purge` event. The MD file survives in .purged/ as an audit artifact;
    it will not appear in load_finding(), query(), or render_index().

    Bidirectional cleanup:
      - Refuses if an ACTIVE finding still has `supersedes: [fid]` — that
        would orphan a live supersede chain. Re-supersede or unlink first.
      - For SUPERSEDED/OUTDATED findings with `superseded_by: fid`, clears
        that field with an audit-trail entry: the chain is going away cleanly.
    """
    if not reason or not reason.strip():
        raise ValueError("purge requires --reason (audit trail discipline)")
    p = find_path(fid)
    if not p:
        raise KeyError(fid)

    ts = now_iso()

    # Refuse if any ACTIVE finding still references this one via `supersedes`.
    if ACTIVE.exists():
        for q in ACTIVE.glob("F-*.md"):
            try:
                meta, _ = parse_frontmatter(q.read_text())
            except Exception:
                continue
            if fid in (meta.get("supersedes") or []):
                raise RuntimeError(
                    f"refusing to purge {fid}: still referenced by "
                    f"{meta.get('id', q.stem)}.supersedes — supersede again or unlink first"
                )

    # Clean up back-pointers from SUPERSEDED/OUTDATED findings that point
    # at this one via `superseded_by`. The chain is going away cleanly,
    # but the audit trail is preserved per finding.
    cleared_backrefs: list[str] = []
    for d in (SUPERSEDED, OUTDATED, COLD):
        if not d.exists():
            continue
        for q in d.glob("F-*.md"):
            try:
                meta, body = parse_frontmatter(q.read_text())
            except Exception:
                continue
            if meta.get("superseded_by") == fid:
                meta["superseded_by"] = None
                meta["last_revised_ts"] = ts
                body = append_history(body, [
                    f"- {ts} · backref-cleared · superseded_by={fid} → null "
                    f"(target purged: {reason}) · session {session or '?'}"
                ])
                q.write_text(render_finding(meta, body))
                cleared_backrefs.append(meta.get("id") or q.stem)
                append_event({
                    "ts": ts, "finding_id": meta.get("id") or q.stem,
                    "event": "backref-cleared", "field": "superseded_by",
                    "from": fid, "to": None,
                    "reason": f"purge target: {reason}",
                    "session": session or "",
                })

    PURGED.mkdir(parents=True, exist_ok=True)
    dest = PURGED / f"{fid}.md"
    text = p.read_text()
    annotated = (
        f"<!-- PURGED at {ts}: {reason} -->\n"
        + text
    )
    dest.write_text(annotated)
    p.unlink()

    # Drop from FTS5 so it doesn't surface in queries or hooks.
    if DB.exists():
        conn = _connect_db()
        try:
            c = conn.cursor()
            try:
                c.execute("DELETE FROM findings_fts WHERE finding_id = ?", (fid,))
                conn.commit()
            except sqlite3.OperationalError:
                pass
        finally:
            conn.close()

    append_event({
        "ts": ts, "finding_id": fid, "event": "purge",
        "reason": reason, "session": session or "",
        "backrefs_cleared": cleared_backrefs,
    })
    # Re-index any backref-cleared findings so FTS reflects their new state
    for bid in cleared_backrefs:
        reindex_one(bid)
    write_stats_cache()
    return True


# ---------------------------------------------------------------------------
# FTS5 indexing
# ---------------------------------------------------------------------------

def _ensure_findings_table(c: sqlite3.Cursor) -> None:
    c.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS findings_fts USING fts5(
            finding_id UNINDEXED,
            type UNINDEXED,
            status UNINDEXED,
            confidence UNINDEXED,
            tags,
            claim,
            body,
            tokenize='porter unicode61'
        )
        """
    )


def reindex_one(fid: str) -> None:
    p = find_path(fid)
    if not p:
        return
    try:
        meta, body = parse_frontmatter(p.read_text())
    except Exception:
        return
    DB.parent.mkdir(parents=True, exist_ok=True)
    conn = _connect_db()
    try:
        c = conn.cursor()
        _ensure_findings_table(c)
        c.execute("DELETE FROM findings_fts WHERE finding_id = ?", (fid,))
        c.execute(
            "INSERT INTO findings_fts(finding_id, type, status, confidence, tags, claim, body) "
            "VALUES (?,?,?,?,?,?,?)",
            (
                fid,
                meta.get("type", "") or "",
                meta.get("status", "") or "",
                meta.get("confidence", "") or "",
                ",".join(meta.get("tags") or []),
                meta.get("claim", "") or "",
                body or "",
            ),
        )
        conn.commit()
    finally:
        conn.close()


def reindex_all() -> int:
    DB.parent.mkdir(parents=True, exist_ok=True)
    conn = _connect_db()
    n = 0
    try:
        c = conn.cursor()
        _ensure_findings_table(c)
        c.execute("DELETE FROM findings_fts")
        for d in (ACTIVE, SUPERSEDED, OUTDATED, COLD):
            if not d.exists():
                continue
            for p in d.glob("F-*.md"):
                try:
                    meta, body = parse_frontmatter(p.read_text())
                except Exception:
                    continue
                c.execute(
                    "INSERT INTO findings_fts(finding_id, type, status, confidence, tags, claim, body) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (
                        meta.get("id") or p.stem,
                        meta.get("type", "") or "",
                        meta.get("status", "") or "",
                        meta.get("confidence", "") or "",
                        ",".join(meta.get("tags") or []),
                        meta.get("claim", "") or "",
                        body or "",
                    ),
                )
                n += 1
        conn.commit()
    finally:
        conn.close()
    return n


# ---------------------------------------------------------------------------
# Query / tail / due / doctor / index
# ---------------------------------------------------------------------------

_STOPWORDS = {
    # Articles, conjunctions, prepositions
    "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for",
    "with", "from", "by", "at", "as", "into", "onto", "via", "per", "vs",
    # Auxiliaries
    "is", "are", "was", "were", "be", "been", "being", "am",
    "do", "does", "did", "doing", "done",
    "have", "has", "had", "having",
    "can", "could", "should", "would", "may", "might", "must", "will",
    # Question words
    "what", "when", "where", "why", "how", "which", "who", "whom", "whose",
    # Pronouns
    "i", "you", "we", "they", "he", "she", "it", "me", "us", "them", "him", "her",
    "my", "your", "our", "their", "his", "its",
    "this", "that", "these", "those",
    # Adverbs / fillers commonly noise
    "yes", "no", "ok", "okay", "also", "just", "really", "very", "still", "now",
    "then", "than", "so", "too", "more", "most", "less", "least",
    # Generic verbs that don't add signal
    "add", "make", "build", "fix", "update", "check", "show", "get", "set",
    "use", "used", "using", "want", "need", "needs", "needed",
}


def _tokenize(text: str) -> list[str]:
    # Split hyphenated/underscored compound tokens BEFORE matching, so
    # "executive-assistant" tokenizes the same as "executive assistant".
    text = re.sub(r"[-_/]", " ", text.lower())
    words = re.findall(r"[A-Za-z][A-Za-z0-9]{1,}", text)
    return [w for w in words if w not in _STOPWORDS and len(w) > 2]


def _build_fts_q(text: str) -> str | None:
    toks = _tokenize(text)[:12]
    if not toks:
        return None
    return " OR ".join(f'"{t}"*' for t in toks)


def _weight(score: float, conf: str, status: str) -> float:
    """bm25 score: lower is better. Apply confidence + status weighting."""
    w = score
    if conf == "high":
        w *= 0.77
    elif conf == "low":
        w *= 1.43
    if status in {"superseded", "outdated", "rejected"}:
        w *= 100.0  # heavy demote
    return w


def query(text: str | None = None, *, top: int = 5,
          type_: str | None = None, status: str | None = None,
          confidence: str | None = None, tag: str | None = None,
          include_demoted: bool = False) -> list[dict]:
    if not DB.exists():
        return []
    conn = _connect_db()
    rows: list = []
    try:
        c = conn.cursor()
        try:
            c.execute("SELECT 1 FROM findings_fts LIMIT 1")
        except sqlite3.OperationalError:
            return []
        if text:
            q = _build_fts_q(text)
            if not q:
                return []
            sql = (
                "SELECT finding_id, type, status, confidence, tags, claim, "
                "snippet(findings_fts, 5, '<<', '>>', ' … ', 24) AS snip, "
                "bm25(findings_fts) AS score "
                "FROM findings_fts WHERE findings_fts MATCH ? "
                "ORDER BY score LIMIT ?"
            )
            try:
                rows = c.execute(sql, (q, max(top * 4, 20))).fetchall()
            except sqlite3.OperationalError:
                rows = []
        else:
            sql = (
                "SELECT finding_id, type, status, confidence, tags, claim, claim, 0.0 "
                "FROM findings_fts ORDER BY rowid DESC LIMIT ?"
            )
            rows = c.execute(sql, (max(top * 4, 20),)).fetchall()
    finally:
        conn.close()

    out: list[dict] = []
    for fid, t, s, conf, tags_raw, claim, snip, score in rows:
        if type_ and t != type_:
            continue
        if status and s != status:
            continue
        if confidence and conf != conf:
            continue
        if tag and tag not in (tags_raw or "").split(","):
            continue
        if not include_demoted and s in {"superseded", "outdated", "rejected"}:
            if not status:  # if user explicitly asked, allow
                continue
        out.append({
            "id": fid, "type": t, "status": s, "confidence": conf,
            "tags": tags_raw, "claim": claim, "snippet": snip,
            "score": _weight(score, conf, s),
        })
    out.sort(key=lambda x: x["score"])
    return out[:top]


def tail(n: int = 20, since: str | None = None, event: str | None = None) -> list[dict]:
    if not EVENTS.exists():
        return []
    cutoff = (datetime.now(timezone.utc) - parse_window(since)) if since else None
    out = []
    with EVENTS.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event and e.get("event") != event:
                continue
            if cutoff:
                try:
                    ts = parse_iso(e["ts"])
                except Exception:
                    continue
                if ts < cutoff:
                    continue
            out.append(e)
    return out[-n:]


def list_due(top: int | None = None) -> list[dict]:
    out = []
    if not ACTIVE.exists():
        return out
    now = datetime.now(timezone.utc)
    for p in ACTIVE.glob("F-*.md"):
        try:
            meta, _ = parse_frontmatter(p.read_text())
        except Exception:
            continue
        last = meta.get("last_review_ts")
        if not last:
            continue
        try:
            last_dt = parse_iso(last)
        except Exception:
            continue
        days = (now - last_dt).days
        revisit = int(meta.get("revisit_after_days") or 90)
        if days >= revisit:
            meta["_age_days"] = days
            out.append(meta)
    out.sort(key=lambda m: m["_age_days"], reverse=True)
    if top is not None:
        out = out[:top]
    return out


def doctor() -> dict:
    issues: list[str] = []
    by_id: dict[str, tuple[str, Path]] = {}

    def scan(d: Path, kind: str) -> None:
        if not d.exists():
            return
        for p in d.glob("F-*.md"):
            try:
                meta, _ = parse_frontmatter(p.read_text())
            except Exception as e:
                issues.append(f"{p}: parse error ({e!r})")
                continue
            fid = meta.get("id")
            if not fid:
                issues.append(f"{p}: missing id field")
                continue
            if fid != p.stem:
                issues.append(f"{p}: id {fid} does not match filename {p.stem}")
            if fid in by_id:
                prev_kind, prev_path = by_id[fid]
                issues.append(f"{fid}: present in both {prev_kind} ({prev_path}) and {kind} ({p})")
            else:
                by_id[fid] = (kind, p)

    scan(ACTIVE, "active")
    scan(SUPERSEDED, "superseded")
    scan(OUTDATED, "outdated")
    scan(COLD, "cold")

    for fid, (_, p) in by_id.items():
        meta, _ = parse_frontmatter(p.read_text())
        for sup in (meta.get("supersedes") or []):
            if not find_path(sup):
                issues.append(f"{fid}: supersedes {sup} which does not exist")
        sb = meta.get("superseded_by")
        if sb and not find_path(sb):
            issues.append(f"{fid}: superseded_by {sb} which does not exist")

    return {
        "ok": not issues,
        "n_findings": len(by_id),
        "issues": issues,
    }


def render_index() -> Path:
    sections: list[str] = []
    for label, dirpath in [
        ("Active", ACTIVE),
        ("Superseded", SUPERSEDED),
        ("Outdated", OUTDATED),
        ("Cold", COLD),
    ]:
        rows = []
        if dirpath.exists():
            files = sorted(dirpath.glob("F-*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
            for p in files:
                try:
                    meta, _ = parse_frontmatter(p.read_text())
                except Exception:
                    continue
                fid = meta.get("id", p.stem)
                ttype = meta.get("type", "?")
                status = meta.get("status", "?")
                conf = meta.get("confidence", "?")
                claim = meta.get("claim", "(no claim)")
                rel = p.relative_to(ROOT)
                rows.append(f"- [{fid}]({rel}) `{ttype}/{status}/{conf}` — {claim}")
        if rows:
            sections.append(f"## {label} ({len(rows)})\n" + "\n".join(rows))
    INDEX.parent.mkdir(parents=True, exist_ok=True)
    text = (
        "# Jarvis Findings — Persistent Epistemic Spine\n\n"
        "_Auto-regenerated by `jarvis-finding`. Do not hand-edit; use the CLI._\n"
        "_Each finding has a stable sha1-derived ID; same claim → same ID, idempotent._\n\n"
    )
    text += ("\n\n".join(sections) + "\n") if sections else "_(No findings yet.)_\n"
    INDEX.write_text(text)
    return INDEX


# ---------------------------------------------------------------------------
# Migration
# ---------------------------------------------------------------------------

def migrate_lessons(lessons_path: Path | str | None = None,
                    session: str = "migration:lessons") -> dict:
    """Backfill lessons.md Active section into findings.

    Lesson format (from jarvis-reflect):
        ### L-xxxxxx · YYYY-MM-DD · Title
        **Pattern:** ...
        **Evidence:** ...
        **Recommendation:** ...
        **Status:** active
    """
    p = Path(lessons_path or HOME / ".claude" / "memory" / "lessons.md")
    if not p.exists():
        return {"ok": False, "reason": f"{p} not found", "n": 0, "skipped": 0}
    text = p.read_text()
    active_marker = "<!-- JARVIS_LESSONS_ACTIVE -->"
    deprecated_marker = "<!-- JARVIS_LESSONS_DEPRECATED -->"
    if active_marker not in text:
        return {"ok": False, "reason": "no active marker", "n": 0, "skipped": 0}
    start = text.index(active_marker) + len(active_marker)
    end = text.index(deprecated_marker) if deprecated_marker in text else len(text)
    block = text[start:end]
    lessons = re.split(r"^### (L-[0-9a-f]+) [·] (\d{4}-\d{2}-\d{2}) [·] (.+?)\n", block, flags=re.MULTILINE)
    # split returns: [pre, id, date, title, body, id, date, title, body, ...]
    n_new = 0
    n_dup = 0
    n_skip = 0
    for i in range(1, len(lessons), 4):
        lid = lessons[i]
        date = lessons[i + 1]
        title = lessons[i + 2].strip()
        body = lessons[i + 3]
        pattern = _grab(body, "Pattern")
        evidence = _grab(body, "Evidence")
        recommendation = _grab(body, "Recommendation")
        if not pattern:
            n_skip += 1
            continue
        claim = pattern.strip()
        reasoning = (
            f"_Migrated from lesson {lid} ({date})._\n\n"
            f"**Title:** {title}\n\n"
            f"**Evidence:** {evidence or '(none captured at migration)'}\n\n"
            f"**Recommendation:** {recommendation or '(none captured at migration)'}\n"
        )
        sources = [{"kind": "derivation", "url": str(p), "note": f"lesson {lid}", "fetched_ts": now_iso()}]
        fid, status = capture(
            claim,
            type_="opinion",
            confidence="medium",
            tags=["migrated:lesson", lid],
            sources=sources,
            trigger=f"migration from {lid}",
            session=session,
            initial_reasoning=reasoning,
        )
        if status == "new":
            n_new += 1
        else:
            n_dup += 1
    return {"ok": True, "n_new": n_new, "n_duplicate": n_dup, "n_skipped": n_skip}


def _grab(body: str, label: str) -> str | None:
    m = re.search(rf"\*\*{label}:\*\*\s*(.+?)(?:\n\*\*|\Z)", body, flags=re.DOTALL)
    if not m:
        return None
    return m.group(1).strip()


def _grab_section(body: str, heading: str) -> str | None:
    """Grab content under a `## Heading` line up to the next `## ` or EOF."""
    m = re.search(
        rf"^##\s+{re.escape(heading)}\s*\n(.+?)(?:^##\s|\Z)",
        body, flags=re.MULTILINE | re.DOTALL,
    )
    if not m:
        return None
    return m.group(1).strip()


def migrate_decisions(decisions_dir: Path | str | None = None,
                      session: str = "migration:decisions") -> dict:
    """Backfill ~/.claude/decisions/*.md as findings.

    Each decision becomes a `type=belief` finding (Watson committed to a
    position). Status mapping:
        open / upheld (✓) → validated
        overturned (✗)    → rejected
        anything else     → open

    Confidence is `high` (the user authored it) with `verified_by=user-confirmed`.
    Tagged `migrated:decision` plus the reversibility level.
    """
    d = Path(decisions_dir or HOME / ".claude" / "decisions")
    if not d.exists():
        return {"ok": False, "reason": f"{d} not found", "n_new": 0, "n_duplicate": 0, "n_skipped": 0}

    files = sorted(p for p in d.glob("*.md") if p.name != "INDEX.md")
    n_new = 0
    n_dup = 0
    n_near = 0
    n_skip = 0
    skipped: list[str] = []
    for p in files:
        try:
            text = p.read_text()
        except Exception:
            n_skip += 1
            skipped.append(f"{p.name}: read error")
            continue
        meta_in, body = parse_frontmatter(text)
        title = meta_in.get("title")
        date = meta_in.get("date")
        rev = meta_in.get("reversibility") or "unspecified"
        status_in = (meta_in.get("status") or "open").lower()
        choice = _grab_section(body, "Choice")
        why = _grab_section(body, "Why")
        context = _grab_section(body, "Context")
        if not title or not choice:
            n_skip += 1
            skipped.append(f"{p.name}: missing title or Choice section")
            continue

        # Canonical claim: "Decision: <title> — <choice> (because <why>)"
        # Compact enough for one-liner display, full enough to be self-describing.
        claim_parts = [f"Decision: {title.strip()}"]
        choice_brief = re.sub(r"\s+", " ", choice).strip()
        if len(choice_brief) > 160:
            choice_brief = choice_brief[:157] + "…"
        claim_parts.append(f"— chose: {choice_brief}")
        if why:
            why_brief = re.sub(r"\s+", " ", why).strip()
            if len(why_brief) > 100:
                why_brief = why_brief[:97] + "…"
            claim_parts.append(f"(because: {why_brief})")
        claim = " ".join(claim_parts)

        target_status = {
            "open": "validated",
            "upheld": "validated",
            "overturned": "rejected",
        }.get(status_in, "validated" if status_in == "open" else "open")

        reasoning = (
            f"_Migrated from decision file `{p.relative_to(HOME)}` (dated {date})._\n\n"
            + (f"**Context:** {context}\n\n" if context else "")
            + f"**Choice:** {choice}\n\n"
            + (f"**Why:** {why}\n\n" if why else "")
            + f"**Reversibility:** {rev}\n"
        )

        sources = [{
            "kind": "user-statement",
            "url": str(p),
            "fetched_ts": now_iso(),
            "note": f"decision authored {date}, status={status_in}, reversibility={rev}",
        }]

        try:
            fid, status = capture(
                claim,
                type_="belief",
                confidence="high",
                tags=["migrated:decision", f"reversibility:{rev}"],
                sources=sources,
                trigger=f"migration from decisions/{p.name}",
                session=session,
                initial_reasoning=reasoning,
                verified_by="user-confirmed",
            )
        except (ValueError, RuntimeError) as e:
            n_skip += 1
            skipped.append(f"{p.name}: {e}")
            continue

        if status == "new":
            n_new += 1
            # Apply target_status if not already (auto-validate may have set
            # status to validated; that's fine).
            if target_status != "open":
                try:
                    revise(fid, status=target_status, reason=f"migration: source status={status_in}",
                           session=session, mark_reviewed=False)
                except Exception:
                    pass
        elif status == "duplicate":
            n_dup += 1
        elif status == "near-duplicate":
            n_near += 1

    return {
        "ok": True, "n_new": n_new, "n_duplicate": n_dup,
        "n_near_duplicate": n_near, "n_skipped": n_skip,
        "skipped_detail": skipped,
    }


def migrate_auto_memory(memory_dir: Path | str | None = None,
                        session: str = "migration:auto-memory") -> dict:
    """Backfill the project's auto-memory directory as findings.

    Layout in source: each `*.md` has frontmatter with `name`, `description`,
    `type` ∈ {user, feedback, project, reference}, plus body content.

    Mapping:
        user      → belief    (about the user)        confidence=high (user-confirmed)
        feedback  → belief    (corrections from user) confidence=high (user-confirmed)
        project   → fact      (project state)         confidence=high (user-confirmed)
        reference → fact      (external pointer)      confidence=medium (training-knowledge)

    The `description` field is the canonical claim. The body becomes initial
    reasoning. MEMORY.md (the index file) is skipped.
    """
    d = Path(memory_dir or HOME / ".claude" / "projects" / "-Users-watsonwheeler-jarvis" / "memory")
    if not d.exists():
        return {"ok": False, "reason": f"{d} not found", "n_new": 0, "n_duplicate": 0, "n_skipped": 0}

    type_map = {
        "user":      ("belief", "high",   "user-confirmed"),
        "feedback":  ("belief", "high",   "user-confirmed"),
        "project":   ("fact",   "high",   "user-confirmed"),
        "reference": ("fact",   "medium", "training-knowledge"),
    }

    n_new = 0
    n_dup = 0
    n_near = 0
    n_skip = 0
    skipped: list[str] = []
    for p in sorted(d.glob("*.md")):
        if p.name in ("MEMORY.md", "AGENTS.md"):
            continue
        try:
            text = p.read_text()
        except Exception:
            n_skip += 1
            skipped.append(f"{p.name}: read error")
            continue
        meta_in, body = parse_frontmatter(text)
        src_type = (meta_in.get("type") or "").lower()
        description = meta_in.get("description")
        name = meta_in.get("name") or p.stem
        if src_type not in type_map:
            n_skip += 1
            skipped.append(f"{p.name}: unknown source type {src_type!r}")
            continue
        if not description:
            n_skip += 1
            skipped.append(f"{p.name}: missing description")
            continue

        target_type, target_conf, target_verified = type_map[src_type]
        # Canonical claim: "<name> — <description>"
        claim = f"{name} — {description}".strip()

        reasoning = (
            f"_Migrated from auto-memory file `{p.name}` (source type: {src_type})._\n\n"
            f"{body.strip()}\n"
        )

        sources = [{
            "kind": "user-statement" if target_verified == "user-confirmed" else "derivation",
            "url": str(p),
            "fetched_ts": now_iso(),
            "note": f"auto-memory entry, source type={src_type}",
        }]

        try:
            fid, status = capture(
                claim,
                type_=target_type,
                confidence=target_conf,
                tags=[f"migrated:auto-memory", f"source-type:{src_type}"],
                sources=sources,
                trigger=f"migration from auto-memory/{p.name}",
                session=session,
                initial_reasoning=reasoning,
                verified_by=target_verified,
            )
        except (ValueError, RuntimeError) as e:
            n_skip += 1
            skipped.append(f"{p.name}: {e}")
            continue

        if status == "new":
            n_new += 1
        elif status == "duplicate":
            n_dup += 1
        elif status == "near-duplicate":
            n_near += 1

    return {
        "ok": True, "n_new": n_new, "n_duplicate": n_dup,
        "n_near_duplicate": n_near, "n_skipped": n_skip,
        "skipped_detail": skipped,
    }


# ---------------------------------------------------------------------------
# CLI helpers
# ---------------------------------------------------------------------------

def short_brief_line(meta: dict) -> str:
    """One-line render for SessionStart 'Findings due for revisit'."""
    fid = meta.get("id", "?")
    status = meta.get("status", "?")
    age = meta.get("_age_days", "?")
    claim = (meta.get("claim") or "").strip()
    if len(claim) > 80:
        claim = claim[:77] + "…"
    return f"- [{fid}] ({status}, {age}d) {claim}"


def hook_finding_block(query_text: str, top: int = 3, min_jaccard: float = 0.0) -> str:
    """Render top-N findings for additionalContext / systemMessage injection.

    `min_jaccard` is a precision filter: each FTS5 hit must also overlap with
    the query text by at least that fraction of token-set Jaccard against the
    *claim* (not the body). The hook (UserPromptSubmit) leaves it at 0 since
    BM25 is already ranking; the precheck (PreToolUse) sets ~0.10 so it only
    fires on genuine topical overlap.
    """
    results = query(query_text, top=top * 3 if min_jaccard > 0 else top)
    if not results:
        return ""

    if min_jaccard > 0:
        q_toks = _claim_tokens(query_text)
        if not q_toks:
            return ""
        filtered = []
        for r in results:
            c_toks = _claim_tokens(r.get("claim") or "")
            if not c_toks:
                continue
            inter = q_toks & c_toks
            union = q_toks | c_toks
            if not union:
                continue
            j = len(inter) / len(union)
            if j >= min_jaccard:
                r["_jaccard"] = j
                filtered.append(r)
        results = filtered[:top]
        if not results:
            return ""
    else:
        results = results[:top]

    lines = ["# Relevant prior findings (pre-checked — do NOT re-derive these)", ""]
    for r in results:
        fid = r["id"]
        t = r["type"]
        s = r["status"]
        conf = r["confidence"]
        claim = (r["claim"] or "").strip()
        if len(claim) > 140:
            claim = claim[:137] + "…"
        lines.append(f"- {fid} [{t} · {s} · {conf}] {claim}")
        snip = re.sub(r"\s+", " ", r.get("snippet") or "").strip()
        if snip and snip != claim:
            lines.append(f"  > {snip}")
    lines.append("")
    lines.append(
        "_If your answer overlaps these, cite the F-id rather than re-research. "
        "If you find contradicting evidence, run `jarvis-finding revise` or `supersede`._"
    )
    return "\n".join(lines)


def stats() -> dict:
    out = {"active": 0, "superseded": 0, "outdated": 0, "cold": 0, "due": 0}
    for label, d in [("active", ACTIVE), ("superseded", SUPERSEDED),
                     ("outdated", OUTDATED), ("cold", COLD)]:
        if d.exists():
            out[label] = sum(1 for _ in d.glob("F-*.md"))
    out["due"] = len(list_due())
    return out


def write_stats_cache() -> None:
    """Write the current stats() result to a tiny on-disk cache so callers
    that just need the counts (jarvis-think.py per-turn pulse line) can
    skip the subprocess fork-exec. Best-effort: any error is swallowed."""
    try:
        ensure_dirs()
        s = stats()
        s["cached_at"] = now_iso()
        STATS_CACHE.write_text(json.dumps(s, separators=(",", ":")))
    except Exception:
        pass


def read_stats_cache(max_age_seconds: int = 3600) -> dict | None:
    """Read the cached stats. Returns None if missing, malformed, or stale."""
    try:
        if not STATS_CACHE.exists():
            return None
        age = (datetime.now(timezone.utc) - datetime.fromtimestamp(
            STATS_CACHE.stat().st_mtime, tz=timezone.utc)).total_seconds()
        if age > max_age_seconds:
            return None
        return json.loads(STATS_CACHE.read_text())
    except Exception:
        return None


def age_findings(grace_days: int = 60, dry_run: bool = False,
                 session: str = "cron:findings-age") -> dict:
    """Walk active findings; mark `outdated` and move to outdated/ when
    `last_review_ts` is older than (revisit_after_days + grace_days).

    Conservative by design: the +grace gives time for a real revisit before
    the system silently demotes. Run nightly via cron.

    Returns {n_aged, n_skipped, aged: [...], errors: [...]}.
    """
    out: dict = {"n_aged": 0, "n_skipped": 0, "aged": [], "errors": []}
    if not ACTIVE.exists():
        return out
    now = datetime.now(timezone.utc)
    for p in ACTIVE.glob("F-*.md"):
        try:
            meta, body = parse_frontmatter(p.read_text())
        except Exception as e:
            out["errors"].append(f"{p.name}: parse error ({e!r})")
            continue
        last = meta.get("last_review_ts")
        if not last:
            out["n_skipped"] += 1
            continue
        try:
            last_dt = parse_iso(last)
        except Exception:
            out["n_skipped"] += 1
            continue
        revisit = int(meta.get("revisit_after_days") or 90)
        days_since_review = (now - last_dt).days
        if days_since_review < (revisit + grace_days):
            out["n_skipped"] += 1
            continue

        # Old enough — mark outdated.
        fid = meta.get("id") or p.stem
        ts = now_iso()
        if dry_run:
            out["aged"].append({
                "id": fid, "claim": meta.get("claim", ""),
                "days_since_review": days_since_review,
                "revisit_after_days": revisit,
                "would_move_to": str(OUTDATED / f"{fid}.md"),
            })
            out["n_aged"] += 1
            continue

        old_status = meta.get("status")
        meta["status"] = "outdated"
        meta["last_revised_ts"] = ts
        body = append_history(body, [
            f"- {ts} · transition · status={old_status} → outdated · "
            f"auto-aged (last reviewed {days_since_review}d ago, revisit_after={revisit}d, grace={grace_days}d) · "
            f"session {session}"
        ])

        OUTDATED.mkdir(parents=True, exist_ok=True)
        new_path = OUTDATED / f"{fid}.md"
        new_path.write_text(render_finding(meta, body))
        try:
            p.unlink()
        except Exception:
            pass

        append_event({
            "ts": ts, "finding_id": fid, "event": "transition",
            "field": "status", "from": old_status, "to": "outdated",
            "reason": f"auto-aged: last_review {days_since_review}d ago > revisit({revisit}) + grace({grace_days})",
            "session": session,
        })
        reindex_one(fid)
        out["aged"].append({
            "id": fid, "claim": meta.get("claim", ""),
            "days_since_review": days_since_review,
            "revisit_after_days": revisit,
        })
        out["n_aged"] += 1

    if not dry_run and out["n_aged"] > 0:
        write_stats_cache()
        render_index()
    return out


def status_report() -> dict:
    """Health check: verify spine is installed, indexed, and hooks are wired.
    Returns a dict with per-check pass/fail and a list of human-readable lines."""
    import shutil
    out: dict = {"checks": [], "ok": True}

    def check(label: str, ok: bool, detail: str = "", warn: bool = False):
        marker = "✓" if ok else ("⚠" if warn else "✗")
        out["checks"].append({"label": label, "ok": ok, "warn": warn, "detail": detail, "marker": marker})
        if not ok and not warn:
            out["ok"] = False

    # 1. CLI installed and on PATH
    cli = shutil.which("jarvis-finding")
    check("CLI on PATH", cli is not None, detail=cli or "not found")

    # 2. Store dirs exist
    check("Store dir exists", ROOT.exists(), detail=str(ROOT))
    check("active/ exists", ACTIVE.exists())
    check("events.jsonl exists", EVENTS.exists(),
          detail=f"{EVENTS.stat().st_size} bytes" if EVENTS.exists() else "missing", warn=True)

    # 3. FTS5 table populated
    fts_count = -1
    if DB.exists():
        try:
            conn = _connect_db()
            try:
                fts_count = conn.execute(
                    "SELECT COUNT(*) FROM findings_fts").fetchone()[0]
            except sqlite3.OperationalError:
                fts_count = -1
            finally:
                conn.close()
        except Exception:
            pass
    check("FTS5 findings_fts populated", fts_count >= 0, detail=f"{fts_count} rows" if fts_count >= 0 else "table missing")

    # 4. Stats cache fresh
    cache = read_stats_cache(max_age_seconds=24 * 3600)
    check("stats cache fresh (<24h)", cache is not None,
          detail=cache.get("cached_at", "?") if cache else "stale or missing", warn=True)

    # 5. Hook files
    hooks_dir = HOME / ".claude" / "hooks"
    for hook_name in ("session-brief.sh",):
        p = hooks_dir / hook_name
        check(f"hook: {hook_name}", p.exists(), detail=str(p), warn=True)
    precheck = hooks_dir / "findings-precheck.sh"
    check("hook: findings-precheck.sh", precheck.exists() and (precheck.stat().st_mode & 0o111),
          detail=str(precheck))
    mt_hook = HOME / ".claude" / "memory-tools" / "hook.sh"
    if mt_hook.exists():
        contains_findings = "jarvis-finding" in mt_hook.read_text()
        check("UserPromptSubmit hook calls jarvis-finding", contains_findings,
              detail=str(mt_hook))

    # 6. settings.json has the wiring
    settings_path = HOME / ".claude" / "settings.json"
    has_perm = False
    has_pretool_hook = False
    if settings_path.exists():
        try:
            cfg = json.loads(settings_path.read_text())
            allow = cfg.get("permissions", {}).get("allow", []) or []
            has_perm = any("jarvis-finding" in a for a in allow)
            pre = cfg.get("hooks", {}).get("PreToolUse", []) or []
            has_pretool_hook = any(
                "findings-precheck" in (h.get("command", "") or "")
                for entry in pre for h in entry.get("hooks", []) or []
            )
        except Exception:
            pass
    check("settings.json: jarvis-finding permission", has_perm, detail=str(settings_path))
    check("settings.json: PreToolUse hook wired", has_pretool_hook, detail="WebSearch|WebFetch matcher")

    # 7. Findings store doctor
    doc = doctor()
    check("doctor: invariants ok", doc["ok"],
          detail=f"{doc['n_findings']} findings"
                 + (f", {len(doc['issues'])} issues" if doc["issues"] else ""))

    # 8. Counts
    s = stats()
    out["stats"] = s

    # 9. Recent activity
    out["recent_events"] = tail(5)

    return out
