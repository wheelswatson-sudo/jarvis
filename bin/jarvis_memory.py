#!/usr/bin/env python3
"""Cross-session semantic memory for the JARVIS voice assistant.

Storage layout (under $ASSISTANT_DIR/memory/, default ~/.jarvis/memory/):
  memories.jsonl   append-only log; one memory per line
  index.json       cached small metadata (last_id, count) — best-effort

Each memory record:
  {"id": "<uuid4 hex>", "created_at": "<iso8601>", "text": "...", "tags": [...]}

Why JSONL? Append-only writes are crash-safe (fsync of one line),
parallel safe-ish (POSIX append is atomic for short lines), and trivially
recoverable — a bad line is skipped, not a corruption of the whole store.

CLI usage (also called via `jarvis-memory`):
  jarvis_memory.py remember "Watson prefers haiku for voice"
  jarvis_memory.py recall "voice model"
  jarvis_memory.py recent --limit 10
  jarvis_memory.py forget <id-prefix>
  jarvis_memory.py inject --query "..."   # prints the memory block for system prompt

Library usage (from jarvis-think.py):
  from jarvis_memory import Memory
  mem = Memory()
  mem.remember("the fact", tags=["pref"])
  hits = mem.recall("query string", limit=5)
  block = mem.format_for_prompt(query="...", recent=10, relevant=5)
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

DEFAULT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis"))) / "memory"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _tokenize(text: str) -> set[str]:
    # Lowercase, strip punctuation, drop very short tokens — keeps recall
    # robust to phrasing differences ("the model" vs "what model").
    return {t for t in re.findall(r"[a-z0-9]+", text.lower()) if len(t) > 2}


_STOP = {
    "the", "and", "for", "are", "with", "that", "this", "you", "your",
    "have", "has", "was", "were", "but", "not", "from", "what", "when",
    "where", "which", "who", "why", "how", "into", "onto", "than",
    "then", "their", "them", "they", "there", "these", "those", "very",
    "just", "all", "any", "some", "out", "off", "yes", "sir",
}


class Memory:
    def __init__(self, dir_path: Path | str | None = None):
        self.dir = Path(dir_path) if dir_path else DEFAULT_DIR
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / "memories.jsonl"

    # ── writes ────────────────────────────────────────────────────────
    def remember(self, text: str, tags: Iterable[str] | None = None,
                 source: str | None = None) -> dict:
        text = (text or "").strip()
        if not text:
            raise ValueError("empty memory text")
        rec = {
            "id": uuid.uuid4().hex[:12],
            "created_at": _now_iso(),
            "text": text,
            "tags": list(tags) if tags else [],
        }
        if source:
            rec["source"] = source
        # Append + fsync. Atomic for lines under PIPE_BUF on POSIX.
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            try:
                f.flush()
                os.fsync(f.fileno())
            except OSError:
                pass
        return rec

    def forget(self, id_prefix: str) -> int:
        """Remove memories whose id starts with id_prefix. Returns count removed."""
        if not id_prefix:
            return 0
        records = list(self.iter_records())
        kept = [r for r in records if not r.get("id", "").startswith(id_prefix)]
        removed = len(records) - len(kept)
        if removed:
            tmp = self.path.with_suffix(".jsonl.tmp")
            with tmp.open("w", encoding="utf-8") as f:
                for r in kept:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
            tmp.replace(self.path)
        return removed

    # ── reads ─────────────────────────────────────────────────────────
    def iter_records(self) -> Iterable[dict]:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    # corrupt line; skip silently — store remains usable
                    continue

    def all(self) -> list[dict]:
        return list(self.iter_records())

    def recent(self, limit: int = 10) -> list[dict]:
        records = self.all()
        records.sort(key=lambda r: r.get("created_at", ""), reverse=True)
        return records[:limit]

    def recall(self, query: str | None = None, limit: int = 10) -> list[dict]:
        """Score memories by keyword overlap + recency, return top `limit`."""
        records = self.all()
        if not records:
            return []

        if not query or not query.strip():
            return self.recent(limit)

        q_tokens = _tokenize(query) - _STOP
        if not q_tokens:
            return self.recent(limit)

        now = time.time()
        scored: list[tuple[float, dict]] = []
        for r in records:
            text = (r.get("text") or "") + " " + " ".join(r.get("tags") or [])
            r_tokens = _tokenize(text)
            overlap = len(q_tokens & r_tokens)
            if overlap == 0:
                continue
            # recency boost (~30-day half-life)
            try:
                ts = datetime.fromisoformat(r["created_at"]).timestamp()
                age_days = max((now - ts) / 86400.0, 0.0)
            except Exception:
                age_days = 365.0
            recency = math.exp(-age_days / 30.0)
            score = overlap + 0.4 * recency
            scored.append((score, r))

        scored.sort(key=lambda t: (t[0], t[1].get("created_at", "")), reverse=True)
        return [r for _, r in scored[:limit]]

    # ── priming: focused top-k retrieval with topic-aware weighting ──
    _TIME_SENSITIVE_RE = re.compile(
        r"\b(yesterday|today|tonight|tomorrow|just now|recent(ly)?|earlier|"
        r"this (morning|afternoon|evening|week)|last (week|night|month))\b",
        re.I,
    )
    _IDENTITY_RE = re.compile(
        r"\b(favou?rite|prefer(ence|s|red)?|usually|always|"
        r"my (name|wife|husband|partner|kid|kids|dog|cat|family|hobby|address|birthday))\b",
        re.I,
    )
    _IDENTITY_OPENERS = (
        "what's my", "what is my", "whats my",
        "who's my", "who is my", "whos my",
        "where's my", "where is my",
    )

    def _classify_query(self, query: str) -> str:
        """Returns 'time_sensitive', 'identity', or 'default'. Identity wins
        ties because identity questions are usually unambiguous."""
        q = (query or "").lower().strip()
        if any(q.startswith(p) for p in self._IDENTITY_OPENERS):
            return "identity"
        if self._IDENTITY_RE.search(q):
            return "identity"
        if self._TIME_SENSITIVE_RE.search(q):
            return "time_sensitive"
        return "default"

    def prime(self, query: str, k: int = 3,
              threshold: float = 1.0) -> list[dict]:
        """Top-k memories most relevant to `query`, with topic-aware weighting.

        Returns at most `k` records whose score >= `threshold`. Returns [] when
        no memory clears the bar — callers should inject nothing rather than
        pad the prompt with weakly-related context.

        Time-sensitive queries ("what did I say yesterday") get a steep recency
        bias. Identity queries ("what's my favorite X") flatten the recency
        curve so older facts can win on overlap alone.
        """
        records = self.all()
        if not records or not query or not query.strip():
            return []
        q_tokens = _tokenize(query) - _STOP
        if not q_tokens:
            return []

        mode = self._classify_query(query)
        if mode == "time_sensitive":
            half_life_days = 7.0
            recency_weight = 1.5
        elif mode == "identity":
            half_life_days = 365.0
            recency_weight = 0.1
        else:
            half_life_days = 30.0
            recency_weight = 0.4

        now = time.time()
        scored: list[tuple[float, dict]] = []
        for r in records:
            text = (r.get("text") or "") + " " + " ".join(r.get("tags") or [])
            r_tokens = _tokenize(text)
            overlap = len(q_tokens & r_tokens)
            if overlap == 0:
                continue
            try:
                ts = datetime.fromisoformat(r["created_at"]).timestamp()
                age_days = max((now - ts) / 86400.0, 0.0)
            except Exception:
                age_days = 365.0
            recency = math.exp(-age_days / half_life_days)
            score = overlap + recency_weight * recency
            scored.append((score, r))

        scored.sort(key=lambda t: (t[0], t[1].get("created_at", "")), reverse=True)
        return [r for s, r in scored[:k] if s >= threshold]

    def format_priming_block(self, query: str, k: int = 3,
                             threshold: float = 1.0) -> str:
        """Build a tight 'most relevant memories' block for the system prompt.
        Returns "" when nothing clears the threshold — prompt stays clean."""
        hits = self.prime(query, k=k, threshold=threshold)
        if not hits:
            return ""
        lines = ["Most relevant memories for the user's current question:"]
        hits.sort(key=lambda r: r.get("created_at", ""), reverse=True)
        for r in hits:
            stamp = (r.get("created_at") or "")[:10]
            tags = r.get("tags") or []
            tag_suffix = f"  [{', '.join(tags)}]" if tags else ""
            lines.append(f"  - ({stamp}) {r['text']}{tag_suffix}")
        return "\n".join(lines)

    # ── prompt injection ──────────────────────────────────────────────
    def format_for_prompt(self, query: str | None = None,
                          recent: int = 8, relevant: int = 5) -> str:
        """Build a compact memory block to prepend to the system prompt."""
        recent_set = self.recent(recent)
        relevant_set = self.recall(query, relevant) if query else []

        seen_ids: set[str] = set()
        merged: list[dict] = []
        for r in relevant_set + recent_set:
            rid = r.get("id")
            if rid and rid not in seen_ids:
                seen_ids.add(rid)
                merged.append(r)

        if not merged:
            return ""

        lines = ["What you remember about the user (most recent first):"]
        merged.sort(key=lambda r: r.get("created_at", ""), reverse=True)
        for r in merged[: recent + relevant]:
            stamp = (r.get("created_at") or "")[:10]
            tags = r.get("tags") or []
            tag_suffix = f"  [{', '.join(tags)}]" if tags else ""
            lines.append(f"  - ({stamp}) {r['text']}{tag_suffix}")
        return "\n".join(lines)


# ── CLI ─────────────────────────────────────────────────────────────────
def _cmd_remember(args, mem: Memory):
    rec = mem.remember(args.text, tags=args.tag, source=args.source)
    print(json.dumps(rec, ensure_ascii=False))


def _cmd_recall(args, mem: Memory):
    hits = mem.recall(args.query, limit=args.limit)
    print(json.dumps(hits, ensure_ascii=False, indent=2))


def _cmd_recent(args, mem: Memory):
    print(json.dumps(mem.recent(args.limit), ensure_ascii=False, indent=2))


def _cmd_forget(args, mem: Memory):
    n = mem.forget(args.id_prefix)
    print(json.dumps({"removed": n}))


def _cmd_inject(args, mem: Memory):
    block = mem.format_for_prompt(query=args.query, recent=args.recent, relevant=args.relevant)
    if block:
        print(block)


def main(argv=None):
    p = argparse.ArgumentParser(description="JARVIS cross-session memory store")
    p.add_argument("--dir", help="memory dir (default: $ASSISTANT_DIR/memory)")
    sub = p.add_subparsers(dest="cmd", required=True)

    pr = sub.add_parser("remember", help="save a memory")
    pr.add_argument("text")
    pr.add_argument("--tag", action="append", default=[])
    pr.add_argument("--source")
    pr.set_defaults(func=_cmd_remember)

    pq = sub.add_parser("recall", help="search memories by keyword + recency")
    pq.add_argument("query")
    pq.add_argument("--limit", type=int, default=10)
    pq.set_defaults(func=_cmd_recall)

    pn = sub.add_parser("recent", help="list most recent memories")
    pn.add_argument("--limit", type=int, default=20)
    pn.set_defaults(func=_cmd_recent)

    pf = sub.add_parser("forget", help="remove a memory by id prefix")
    pf.add_argument("id_prefix")
    pf.set_defaults(func=_cmd_forget)

    pi = sub.add_parser("inject", help="format a memory block for the system prompt")
    pi.add_argument("--query", default=None)
    pi.add_argument("--recent", type=int, default=8)
    pi.add_argument("--relevant", type=int, default=5)
    pi.set_defaults(func=_cmd_inject)

    args = p.parse_args(argv)
    mem = Memory(args.dir)
    args.func(args, mem)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
