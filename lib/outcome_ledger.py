#!/usr/bin/env python3
"""Outcome ledger — append-only audit trail of every meaningful Jarvis action.

Every tool call, every send, every check writes one JSONL line so we can
reconstruct what Jarvis did, whether it worked, and what we learned. This
is the substrate the reconciliation agent reads to compute capability
health, and the substrate jarvis-context reads to bias against tools that
have been failing.

Storage:
    ~/.jarvis/state/outcome-ledger.jsonl

Record shape (one JSON object per line):
    {
      "ts":         "2026-04-28T15:30:00+00:00",
      "cap":        "email",
      "action":     "drafted reply",
      "status":     "success" | "failed" | "pending_confirm" | "skipped",
      "latency_ms": 1200,
      "context":    { ... arbitrary JSON ... },
      "feedback":   null | "good" | "bad" | "interrupted" | "re-asked"
    }

Why JSONL? Append-only writes are crash-safe under POSIX atomic-append
semantics for short lines (PIPE_BUF is at least 512 bytes). Parallel
processes (cron, voice loop, daemon) can all append without coordination.
Recovery from a corrupt line is "skip the bad line and keep going."

Library usage:
    from outcome_ledger import emit, query, stats, feedback
    emit("email", "drafted reply", "success", latency_ms=320,
         context={"thread_id": "abc"})
    rows = query(cap="email", hours=24)
    s = stats(cap="email", hours=168)
    feedback("2026-04-28T15:30:00+00:00", "good")
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
STATE_DIR = ASSISTANT_DIR / "state"
LEDGER_PATH = STATE_DIR / "outcome-ledger.jsonl"

VALID_STATUSES = {"success", "failed", "pending_confirm", "skipped"}
VALID_FEEDBACK = {"good", "bad", "interrupted", "re-asked"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def emit(cap: str,
         action: str,
         status: str,
         context: dict | None = None,
         latency_ms: int | float | None = None) -> dict:
    """Append one outcome record. Best-effort — never raises on disk error.

    Returns the record (with the assigned ts) so callers can correlate later
    feedback by timestamp. Unknown statuses are coerced to 'failed' so the
    aggregator never sees garbage."""
    cap = (cap or "unknown").strip() or "unknown"
    action = (action or "").strip() or "(no action)"
    if status not in VALID_STATUSES:
        status = "failed"
    rec: dict = {
        "ts": _now_iso(),
        "cap": cap,
        "action": action,
        "status": status,
    }
    if latency_ms is not None:
        try:
            rec["latency_ms"] = int(latency_ms)
        except (TypeError, ValueError):
            pass
    if context:
        try:
            # Round-trip through json to drop unserializable bits (e.g. bytes)
            rec["context"] = json.loads(json.dumps(context, default=str))
        except Exception:
            rec["context"] = {"_unserializable": str(type(context).__name__)}
    rec["feedback"] = None

    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with LEDGER_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            try:
                f.flush()
                os.fsync(f.fileno())
            except OSError:
                pass
    except Exception:
        # Telemetry must never break the foreground action.
        pass
    return rec


def _iter_records() -> Iterable[dict]:
    if not LEDGER_PATH.exists():
        return
    with LEDGER_PATH.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def _parse_ts(ts: str) -> float:
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def query(cap: str | None = None,
          status: str | None = None,
          hours: float = 24.0,
          limit: int | None = None) -> list[dict]:
    """Return ledger rows filtered by capability / status, within a window.

    `hours` may be 0 or negative to mean "all of time". Newest first."""
    cutoff = time.time() - (hours * 3600.0) if hours and hours > 0 else 0.0
    out: list[dict] = []
    for rec in _iter_records():
        if cap and rec.get("cap") != cap:
            continue
        if status and rec.get("status") != status:
            continue
        if cutoff and _parse_ts(rec.get("ts", "")) < cutoff:
            continue
        out.append(rec)
    out.sort(key=lambda r: r.get("ts", ""), reverse=True)
    if limit:
        out = out[:limit]
    return out


def stats(cap: str | None = None, hours: float = 168.0) -> dict:
    """Aggregate health stats over a window.

    Returns:
        {
          "cap":          str | "<all>",
          "hours":        float,
          "volume":       int,
          "success":      int,
          "failed":       int,
          "skipped":      int,
          "pending":      int,
          "success_rate": float in [0,1],
          "avg_latency_ms": float | None,
          "p95_latency_ms": int | None,
          "by_cap":       {cap: {volume, success_rate, avg_latency_ms}}  # only when cap is None
        }
    """
    rows = query(cap=cap, hours=hours)
    out: dict = {
        "cap": cap or "<all>",
        "hours": hours,
        "volume": len(rows),
        "success": 0,
        "failed": 0,
        "skipped": 0,
        "pending": 0,
        "success_rate": 0.0,
        "avg_latency_ms": None,
        "p95_latency_ms": None,
    }
    latencies: list[int] = []
    by_cap: dict[str, dict] = {}
    for r in rows:
        st = r.get("status")
        if st == "success":
            out["success"] += 1
        elif st == "failed":
            out["failed"] += 1
        elif st == "skipped":
            out["skipped"] += 1
        elif st == "pending_confirm":
            out["pending"] += 1
        ml = r.get("latency_ms")
        if isinstance(ml, (int, float)):
            latencies.append(int(ml))
        if cap is None:
            c = r.get("cap") or "unknown"
            agg = by_cap.setdefault(c, {"volume": 0, "success": 0, "lat": []})
            agg["volume"] += 1
            if st == "success":
                agg["success"] += 1
            if isinstance(ml, (int, float)):
                agg["lat"].append(int(ml))

    decided = out["success"] + out["failed"]
    if decided:
        out["success_rate"] = round(out["success"] / decided, 3)
    if latencies:
        out["avg_latency_ms"] = round(sum(latencies) / len(latencies), 1)
        # Nearest-rank percentile (NIST): p95 index = ceil(n * 0.95) - 1
        srt = sorted(latencies)
        idx = min(len(srt) - 1, max(0, -(-len(srt) * 95 // 100) - 1))
        out["p95_latency_ms"] = srt[idx]

    if cap is None:
        rolled: dict[str, dict] = {}
        for c, agg in by_cap.items():
            decided_c = agg["success"] + sum(
                1 for r in rows if r.get("cap") == c and r.get("status") == "failed"
            )
            rolled[c] = {
                "volume": agg["volume"],
                "success_rate": round(agg["success"] / decided_c, 3) if decided_c else 0.0,
                "avg_latency_ms": (round(sum(agg["lat"]) / len(agg["lat"]), 1)
                                   if agg["lat"] else None),
            }
        out["by_cap"] = rolled
    return out


def feedback(ts: str, signal: str) -> dict:
    """Attach a feedback signal ('good' / 'bad' / 'interrupted' / 're-asked')
    to the ledger row matching `ts`. Returns {"ok": True, "matched": N}.

    Implementation: rewrite the file. The ledger is small enough (one line
    per action) that a full rewrite is cheap, and append-only mutation is
    a non-starter for in-place updates."""
    if signal not in VALID_FEEDBACK:
        return {"ok": False, "error": f"invalid signal: {signal}"}
    if not LEDGER_PATH.exists():
        return {"ok": True, "matched": 0}
    rows = list(_iter_records())
    matched = 0
    for r in rows:
        if r.get("ts") == ts:
            r["feedback"] = signal
            matched += 1
    if matched == 0:
        return {"ok": True, "matched": 0}
    tmp = LEDGER_PATH.with_suffix(".jsonl.tmp")
    try:
        with tmp.open("w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        tmp.replace(LEDGER_PATH)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "matched": matched}


# ── CLI ────────────────────────────────────────────────────────────────
def _cli(argv: list[str]) -> int:
    import argparse

    p = argparse.ArgumentParser(description="Jarvis outcome ledger")
    sub = p.add_subparsers(dest="cmd", required=True)

    pe = sub.add_parser("emit")
    pe.add_argument("--cap", required=True)
    pe.add_argument("--action", required=True)
    pe.add_argument("--status", required=True, choices=sorted(VALID_STATUSES))
    pe.add_argument("--latency-ms", type=int, default=None)
    pe.add_argument("--context", default=None,
                    help="JSON object string; ignored if invalid")

    pq = sub.add_parser("query")
    pq.add_argument("--cap", default=None)
    pq.add_argument("--status", default=None, choices=sorted(VALID_STATUSES))
    pq.add_argument("--hours", type=float, default=24.0)
    pq.add_argument("--limit", type=int, default=None)

    ps = sub.add_parser("stats")
    ps.add_argument("--cap", default=None)
    ps.add_argument("--hours", type=float, default=168.0)

    pf = sub.add_parser("feedback")
    pf.add_argument("--ts", required=True)
    pf.add_argument("--signal", required=True, choices=sorted(VALID_FEEDBACK))

    args = p.parse_args(argv)
    if args.cmd == "emit":
        ctx = None
        if args.context:
            try:
                ctx = json.loads(args.context)
            except json.JSONDecodeError:
                ctx = {"_raw": args.context}
        rec = emit(args.cap, args.action, args.status,
                   context=ctx, latency_ms=args.latency_ms)
        print(json.dumps(rec, ensure_ascii=False))
        return 0
    if args.cmd == "query":
        rows = query(cap=args.cap, status=args.status,
                     hours=args.hours, limit=args.limit)
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "stats":
        s = stats(cap=args.cap, hours=args.hours)
        print(json.dumps(s, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "feedback":
        r = feedback(args.ts, args.signal)
        print(json.dumps(r, ensure_ascii=False))
        return 0 if r.get("ok") else 1
    return 2


if __name__ == "__main__":
    import sys
    sys.exit(_cli(sys.argv[1:]))
