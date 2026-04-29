#!/usr/bin/env python3
"""Reconciliation agent — nightly capability health report.

Reads the outcome ledger and produces a per-capability health report:
volume, success rate, average latency, top failure modes, and the trend
(improving | stable | degrading) computed against the previous report.
Writes both a human-readable markdown file and a machine-readable JSON
file so other systems (briefing, context engine) can consume it.

Outputs:
    ~/.jarvis/state/capability-reconciliation.md
    ~/.jarvis/state/capability-reconciliation.json

A capability gets flagged when:
    - success_rate < FLAG_SUCCESS_THRESHOLD (default 0.80), OR
    - the last day's success rate is more than FLAG_DROP_DELTA (default 0.10)
      below the prior week's, AND volume in the last day is non-trivial.

Wiring:
    jarvis-improve         calls this nightly as a tier-2 task
    jarvis-context.py      reads the JSON for a one-line system-prompt hint
    jarvis-briefing.py     reads the JSON to add a "System Health" section

CLI:
    jarvis-reconcile             generate the report now
    jarvis-reconcile --status    print the latest report (markdown)
    jarvis-reconcile --history   show a 30-day trend per capability
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
LIB_DIR = ASSISTANT_DIR / "lib"
STATE_DIR = ASSISTANT_DIR / "state"
HISTORY_DIR = STATE_DIR / "reconciliation-history"
REPORT_MD = STATE_DIR / "capability-reconciliation.md"
REPORT_JSON = STATE_DIR / "capability-reconciliation.json"

WINDOW_DAYS = float(os.environ.get("JARVIS_RECONCILE_WINDOW_DAYS", "7"))
FLAG_SUCCESS_THRESHOLD = float(os.environ.get("JARVIS_RECONCILE_MIN_SUCCESS", "0.80"))
FLAG_DROP_DELTA = float(os.environ.get("JARVIS_RECONCILE_DROP_DELTA", "0.10"))
MIN_VOLUME_FOR_FLAG = int(os.environ.get("JARVIS_RECONCILE_MIN_VOLUME", "3"))


# ── ledger module loader ───────────────────────────────────────────────
def _load_ledger():
    src = LIB_DIR / "outcome_ledger.py"
    if not src.exists():
        src = Path(__file__).parent.parent / "lib" / "outcome_ledger.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("outcome_ledger", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    except Exception:
        return None


_ledger = _load_ledger()


# ── compute ────────────────────────────────────────────────────────────
def _stats_for_window(cap: str, hours: float) -> dict:
    if _ledger is None:
        return {"volume": 0, "success_rate": 0.0, "avg_latency_ms": None,
                "p95_latency_ms": None, "failed": 0, "success": 0}
    return _ledger.stats(cap=cap, hours=hours)


def _failure_modes(cap: str, hours: float, top: int = 3) -> list[dict]:
    """Bucket failed rows by error fragment and return the top N."""
    if _ledger is None:
        return []
    rows = _ledger.query(cap=cap, status="failed", hours=hours)
    counter: Counter[str] = Counter()
    for r in rows:
        ctx = r.get("context") or {}
        err = (ctx.get("error") or "").strip()
        if not err:
            continue
        # Bucket on the leading 80 chars so "draft create failed: 401 …"
        # and "draft create failed: 500 …" cluster.
        counter[err[:80]] += 1
    return [{"error": e, "count": n} for e, n in counter.most_common(top)]


def _trend(prev_rate: float | None, cur_rate: float, prev_volume: int,
           cur_volume: int) -> str:
    """Classify the rate delta. Tiny-volume comparisons are forced to stable
    so a single failure doesn't trigger a degrading report on a quiet day."""
    if prev_rate is None:
        return "new"
    if prev_volume < MIN_VOLUME_FOR_FLAG or cur_volume < MIN_VOLUME_FOR_FLAG:
        return "stable"
    delta = cur_rate - prev_rate
    if delta > 0.05:
        return "improving"
    if delta < -0.05:
        return "degrading"
    return "stable"


def reconcile() -> dict:
    """Compute the report. Returns the JSON dict (also written to disk)."""
    now = datetime.now(timezone.utc)
    report: dict = {
        "generated_at": now.isoformat(timespec="seconds"),
        "window_days": WINDOW_DAYS,
        "capabilities": {},
        "flagged": [],
    }

    # Read the previous report (if any) for trend comparison.
    previous: dict = {}
    if REPORT_JSON.exists():
        try:
            previous = json.loads(REPORT_JSON.read_text(encoding="utf-8"))
        except Exception:
            previous = {}

    if _ledger is None:
        report["error"] = "outcome_ledger module missing"
        _write_outputs(report)
        return report

    # Find the active capability set from the ledger.
    all_rows = _ledger.query(hours=WINDOW_DAYS * 24)
    caps = sorted({r.get("cap") for r in all_rows if r.get("cap")})

    window_hours = WINDOW_DAYS * 24
    one_day_hours = 24.0

    for cap in caps:
        s = _stats_for_window(cap, window_hours)
        last_day = _stats_for_window(cap, one_day_hours)

        prev_entry = (previous.get("capabilities") or {}).get(cap, {})
        prev_rate = prev_entry.get("success_rate")
        prev_volume = int(prev_entry.get("volume") or 0)

        trend = _trend(prev_rate, s.get("success_rate", 0.0), prev_volume, s.get("volume", 0))

        flagged_reasons: list[str] = []
        decided = s.get("success", 0) + s.get("failed", 0)
        if decided >= MIN_VOLUME_FOR_FLAG and s.get("success_rate", 0.0) < FLAG_SUCCESS_THRESHOLD:
            flagged_reasons.append(
                f"success rate {int(round(s['success_rate'] * 100))}% < "
                f"{int(FLAG_SUCCESS_THRESHOLD * 100)}% over last {WINDOW_DAYS:g}d"
            )
        if (last_day.get("volume", 0) >= MIN_VOLUME_FOR_FLAG
                and prev_rate is not None
                and last_day.get("success_rate", 0.0) <= prev_rate - FLAG_DROP_DELTA):
            flagged_reasons.append(
                f"last-day success {int(round(last_day['success_rate'] * 100))}% dropped "
                f">{int(FLAG_DROP_DELTA * 100)}pts vs prior report"
            )

        cap_entry = {
            "volume": s.get("volume", 0),
            "success": s.get("success", 0),
            "failed": s.get("failed", 0),
            "skipped": s.get("skipped", 0),
            "pending": s.get("pending", 0),
            "success_rate": s.get("success_rate", 0.0),
            "avg_latency_ms": s.get("avg_latency_ms"),
            "p95_latency_ms": s.get("p95_latency_ms"),
            "trend": trend,
            "previous_success_rate": prev_rate,
            "last_day": {
                "volume": last_day.get("volume", 0),
                "success_rate": last_day.get("success_rate", 0.0),
            },
            "failure_modes": _failure_modes(cap, window_hours),
            "flagged": bool(flagged_reasons),
            "flag_reasons": flagged_reasons,
        }
        report["capabilities"][cap] = cap_entry
        if flagged_reasons:
            report["flagged"].append(cap)

    _write_outputs(report)
    return report


def _write_outputs(report: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    try:
        REPORT_JSON.write_text(json.dumps(report, ensure_ascii=False, indent=2),
                               encoding="utf-8")
    except Exception:
        pass
    try:
        REPORT_MD.write_text(_format_markdown(report), encoding="utf-8")
    except Exception:
        pass
    # Roll a dated copy into the history dir so jarvis-reconcile --history
    # has 30 days of evidence.
    try:
        date_tag = report.get("generated_at", "")[:10] or "unknown"
        (HISTORY_DIR / f"{date_tag}.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8",
        )
    except Exception:
        pass


def _format_markdown(report: dict) -> str:
    when = report.get("generated_at", "")
    lines: list[str] = [
        f"# Capability Reconciliation — {when[:10]}",
        "",
        f"_Generated: {when}_",
        f"_Window: {report.get('window_days', WINDOW_DAYS):g} days_",
        "",
    ]
    if report.get("error"):
        lines.append(f"**Error:** {report['error']}")
        return "\n".join(lines) + "\n"

    flagged = report.get("flagged") or []
    if flagged:
        lines.append("## ⚠ Flagged capabilities")
        lines.append("")
        for cap in flagged:
            entry = report["capabilities"][cap]
            reasons = "; ".join(entry.get("flag_reasons") or [])
            lines.append(f"- **{cap}** — {reasons}")
        lines.append("")
    else:
        lines.append("All capabilities healthy. No flags this run.")
        lines.append("")

    lines.append("## Per-capability detail")
    lines.append("")
    lines.append("| capability | volume | success | trend | avg ms | p95 ms |")
    lines.append("| --- | ---: | ---: | --- | ---: | ---: |")
    for cap in sorted(report["capabilities"]):
        e = report["capabilities"][cap]
        avg = e.get("avg_latency_ms")
        p95 = e.get("p95_latency_ms")
        lines.append(
            f"| {cap} | {e['volume']} | {int(round(e['success_rate'] * 100))}% "
            f"| {e['trend']} "
            f"| {avg if avg is not None else '—'} "
            f"| {p95 if p95 is not None else '—'} |"
        )
    lines.append("")

    # Failure mode tables for any cap with failures
    fail_caps = [c for c in sorted(report["capabilities"])
                 if (report["capabilities"][c].get("failure_modes") or [])]
    if fail_caps:
        lines.append("## Top failure modes")
        lines.append("")
        for cap in fail_caps:
            lines.append(f"### {cap}")
            for fm in report["capabilities"][cap]["failure_modes"]:
                lines.append(f"- ×{fm['count']} — `{fm['error']}`")
            lines.append("")
    return "\n".join(lines) + "\n"


# ── system-prompt + briefing hooks ────────────────────────────────────
def context_hint() -> str:
    """One-liner injected by jarvis-context.py when capabilities are flagged.
    Empty string when nothing is flagged so the cache stays warm."""
    if not REPORT_JSON.exists():
        return ""
    try:
        data = json.loads(REPORT_JSON.read_text(encoding="utf-8"))
    except Exception:
        return ""
    flagged = data.get("flagged") or []
    if not flagged:
        return ""
    bits: list[str] = []
    for cap in flagged:
        e = data["capabilities"].get(cap) or {}
        reason = (e.get("flag_reasons") or ["degraded"])[0]
        bits.append(f"{cap} ({reason})")
    return ("**Capability health:** " + "; ".join(bits)
            + ". Be cautious with these tools and prefer alternatives where possible.")


def briefing_section() -> str:
    """Markdown 'System Health' section for jarvis-briefing. Empty when
    nothing is flagged so quiet days don't pad the briefing."""
    if not REPORT_JSON.exists():
        return ""
    try:
        data = json.loads(REPORT_JSON.read_text(encoding="utf-8"))
    except Exception:
        return ""
    flagged = data.get("flagged") or []
    if not flagged:
        return ""
    lines = ["## System Health", ""]
    for cap in flagged:
        e = data["capabilities"].get(cap) or {}
        rate = int(round(float(e.get("success_rate") or 0.0) * 100))
        vol = e.get("volume", 0)
        lines.append(f"- **{cap}** — {rate}% success rate ({vol} runs); "
                     f"{(e.get('flag_reasons') or [''])[0]}")
    return "\n".join(lines) + "\n"


# ── CLI ────────────────────────────────────────────────────────────────
def _cli_status() -> int:
    if not REPORT_MD.exists():
        print("(no report yet — run jarvis-reconcile to generate one)",
              file=sys.stderr)
        return 1
    sys.stdout.write(REPORT_MD.read_text(encoding="utf-8"))
    return 0


def _cli_history(days: int = 30) -> int:
    if not HISTORY_DIR.exists():
        print("(no history yet)", file=sys.stderr)
        return 1
    files = sorted(HISTORY_DIR.glob("*.json"))[-days:]
    if not files:
        print("(no history yet)", file=sys.stderr)
        return 1
    print(f"# Capability trend — last {len(files)} reports\n")
    print("| date | flagged | per-cap success rates |")
    print("| --- | --- | --- |")
    for p in files:
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        flagged = ",".join(d.get("flagged") or []) or "—"
        rates = []
        for cap in sorted(d.get("capabilities") or {}):
            e = d["capabilities"][cap]
            rates.append(f"{cap}:{int(round((e.get('success_rate') or 0) * 100))}%")
        print(f"| {d.get('generated_at', p.stem)[:10]} | {flagged} | "
              f"{' · '.join(rates)} |")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Capability reconciliation")
    p.add_argument("--status", action="store_true",
                   help="print the latest report instead of regenerating")
    p.add_argument("--history", action="store_true",
                   help="print a 30-day trend table")
    p.add_argument("--hint", action="store_true",
                   help="print the one-line context_hint (debug)")
    p.add_argument("--briefing-section", action="store_true",
                   help="print the briefing System Health section (debug)")
    args = p.parse_args()
    if args.status:
        return _cli_status()
    if args.history:
        return _cli_history()
    if args.hint:
        print(context_hint() or "(no hint — nothing flagged)")
        return 0
    if args.briefing_section:
        print(briefing_section() or "(no section — nothing flagged)")
        return 0

    rep = reconcile()
    flagged = rep.get("flagged") or []
    summary = (
        f"reconcile: {len(rep.get('capabilities') or {})} capabilities, "
        f"{len(flagged)} flagged"
    )
    if flagged:
        summary += " (" + ", ".join(flagged) + ")"
    print(summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
