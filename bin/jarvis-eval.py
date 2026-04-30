#!/usr/bin/env python3
"""Jarvis eval suite — score a candidate model against held-out data.

Suites:
    tool_selection      — given user_text, did the model emit the right tool?
    parameter_extraction — did it fill the required args correctly?
    schema_validity     — did the call validate against the tool's schema?
    plan_quality        — for orchestrator plans, structural similarity to ref
    latency             — time-to-first-token + total round-trip
    regression          — diff against the previous model's report

CLI:
    jarvis-eval.py --model qwen2.5-3b-jarvis --suite all
    jarvis-eval.py --model qwen2.5-3b-jarvis --suite tool_selection,latency
    jarvis-eval.py --model api --eval-file ~/.jarvis/training/eval-v3.jsonl --json
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
TRAINING_DIR = ASSISTANT_DIR / "training"
REPORTS_DIR = ASSISTANT_DIR / "training" / "reports"
TRAINING_CONFIG = ASSISTANT_DIR / "config" / "training.json"

DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:8741/v1/chat/completions"
DEFAULT_API_MODEL = "claude-haiku-4-5-20251001"
DEFAULT_TIMEOUT = int(os.environ.get("JARVIS_EVAL_TIMEOUT_S", "60"))
SAMPLE_CAP = int(os.environ.get("JARVIS_EVAL_SAMPLE_CAP", "300"))

ALL_SUITES = ("tool_selection", "parameter_extraction", "schema_validity",
              "plan_quality", "latency", "regression")

HERMES_TOOL_CALL_RE = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>",
                                 re.DOTALL)


# ── eval data loader ──────────────────────────────────────────────────
def _latest_eval_file() -> Path | None:
    if not TRAINING_DIR.exists():
        return None
    paths = sorted(TRAINING_DIR.glob("eval-v*.jsonl"))
    return paths[-1] if paths else None


def _load_eval_rows(path: Path) -> list[dict]:
    rows = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def _expected_from_row(row: dict) -> dict | None:
    """Recover (user_text, expected_tool, expected_args, system) from one
    Hermes-format training row. Returns None if the row is malformed."""
    msgs = row.get("messages") or []
    sys_msg = next((m["content"] for m in msgs if m.get("role") == "system"), "")
    user_msg = next((m["content"] for m in msgs if m.get("role") == "user"), "")
    asst_msg = next((m["content"] for m in msgs
                     if m.get("role") == "assistant"
                     and "<tool_call>" in (m.get("content") or "")), "")
    if not user_msg or not asst_msg:
        return None
    m = HERMES_TOOL_CALL_RE.search(asst_msg)
    if not m:
        return None
    try:
        call = json.loads(m.group(1))
    except json.JSONDecodeError:
        return None
    return {
        "system": sys_msg,
        "user_text": user_msg,
        "expected_tool": call.get("name"),
        "expected_args": call.get("arguments") or {},
    }


# ── inference adapters ────────────────────────────────────────────────
def _local_call(endpoint: str, model_id: str, system: str, user_text: str,
                timeout: int = DEFAULT_TIMEOUT) -> tuple[str, dict, int]:
    """Hit the local OpenAI-compat endpoint. Returns (text, raw_response, latency_ms)."""
    payload = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_text},
        ],
        "stream": False,
    }
    req = urllib.request.Request(
        endpoint, data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        resp = json.loads(r.read())
    latency_ms = int((time.monotonic() - t0) * 1000)
    msg = (resp.get("choices") or [{}])[0].get("message") or {}
    text = msg.get("content") or ""
    # If the server already parsed Hermes tool_calls, surface them.
    # Local Hermes/Qwen models routinely emit malformed JSON in `arguments`
    # — fall back to an empty dict so the eval keeps measuring the model
    # instead of crashing the suite.
    for tc in msg.get("tool_calls") or []:
        f = tc.get("function") or {}
        try:
            args = json.loads(f.get("arguments") or "{}")
        except json.JSONDecodeError:
            args = {}
        text += f"\n<tool_call>{json.dumps({'name': f.get('name'), 'arguments': args}, ensure_ascii=False)}</tool_call>"
    return text, resp, latency_ms


def _api_call(api_key: str, model: str, system: str, user_text: str,
              timeout: int = DEFAULT_TIMEOUT) -> tuple[str, dict, int]:
    payload = json.dumps({
        "model": model,
        "max_tokens": 1024,
        "system": system,
        "messages": [{"role": "user", "content": user_text}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01",
                 "content-type": "application/json"},
    )
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        resp = json.loads(r.read())
    latency_ms = int((time.monotonic() - t0) * 1000)
    text = "\n".join(b.get("text", "") for b in resp.get("content", [])
                     if b.get("type") == "text")
    return text, resp, latency_ms


# ── parsing model output ──────────────────────────────────────────────
def _extract_call(text: str) -> tuple[str | None, dict]:
    """Parse the model's reply for a tool call. Hermes <tool_call>{}</tool_call>
    first; OpenAI tool_calls JSON second. Returns (tool_name, args)."""
    if not text:
        return None, {}
    m = HERMES_TOOL_CALL_RE.search(text)
    if m:
        try:
            obj = json.loads(m.group(1))
        except json.JSONDecodeError:
            return None, {}
        return obj.get("name"), obj.get("arguments") or {}
    # Fallback: maybe the model just emitted a bare JSON
    try:
        obj = json.loads(text.strip())
        if isinstance(obj, dict) and "name" in obj:
            return obj.get("name"), obj.get("arguments") or {}
    except json.JSONDecodeError:
        pass
    return None, {}


# ── individual suites ─────────────────────────────────────────────────
def suite_tool_selection(rows: list[dict], call_fn, sample_cap: int) -> dict:
    correct = 0
    total = 0
    misses: list[dict] = []
    for ex in rows[:sample_cap]:
        info = _expected_from_row(ex)
        if not info:
            continue
        total += 1
        try:
            text, _resp, _lat = call_fn(info["system"], info["user_text"])
        except Exception as e:
            misses.append({"user_text": info["user_text"][:80],
                           "expected": info["expected_tool"],
                           "error": str(e)[:120]})
            continue
        got_tool, _ = _extract_call(text)
        if got_tool == info["expected_tool"]:
            correct += 1
        else:
            if len(misses) < 30:
                misses.append({
                    "user_text": info["user_text"][:80],
                    "expected": info["expected_tool"],
                    "got": got_tool,
                })
    return {
        "metric": "tool_selection_accuracy",
        "n": total,
        "correct": correct,
        "tool_selection_accuracy": (correct / total) if total else 0.0,
        "misses": misses,
    }


def suite_parameter_extraction(rows: list[dict], call_fn, sample_cap: int) -> dict:
    correct = 0
    total = 0
    for ex in rows[:sample_cap]:
        info = _expected_from_row(ex)
        if not info:
            continue
        total += 1
        try:
            text, _resp, _lat = call_fn(info["system"], info["user_text"])
        except Exception:
            continue
        got_tool, got_args = _extract_call(text)
        if got_tool != info["expected_tool"]:
            continue
        # Score: every required-arg key in expected must appear and match
        # (string equality after lowercase trim for strings; exact for others).
        expected = info["expected_args"] or {}
        required = list(expected.keys())
        if not required:
            correct += 1
            continue
        ok = True
        for k in required:
            ev = expected.get(k)
            gv = got_args.get(k) if isinstance(got_args, dict) else None
            if isinstance(ev, str) and isinstance(gv, str):
                if ev.strip().lower() != gv.strip().lower():
                    ok = False; break
            elif ev != gv:
                ok = False; break
        if ok:
            correct += 1
    return {
        "metric": "parameter_extraction_accuracy",
        "n": total,
        "correct": correct,
        "parameter_extraction_accuracy": (correct / total) if total else 0.0,
    }


def suite_schema_validity(rows: list[dict], call_fn, sample_cap: int) -> dict:
    """Did the call extract a JSON object at all? Did it have a name + dict args?
    Catches malformed/truncated output, the most common failure mode for tiny
    models on long prompts."""
    valid = 0
    total = 0
    for ex in rows[:sample_cap]:
        info = _expected_from_row(ex)
        if not info:
            continue
        total += 1
        try:
            text, _resp, _lat = call_fn(info["system"], info["user_text"])
        except Exception:
            continue
        got_tool, got_args = _extract_call(text)
        if got_tool and isinstance(got_args, dict):
            valid += 1
    return {
        "metric": "schema_validity_rate",
        "n": total,
        "valid": valid,
        "schema_validity_rate": (valid / total) if total else 0.0,
    }


def suite_plan_quality(rows: list[dict], call_fn, sample_cap: int) -> dict:
    """Lightweight structural check for orchestrator-style plans.
    Filters rows whose expected tool is `execute_plan`; for each, scores
    overlap between the expected steps and what the model produces."""
    filtered = []
    for ex in rows:
        info = _expected_from_row(ex)
        if info and info["expected_tool"] == "execute_plan":
            filtered.append(info)
        if len(filtered) >= sample_cap:
            break
    if not filtered:
        return {"metric": "plan_quality", "n": 0, "plan_quality": None,
                "note": "no execute_plan rows in eval set"}
    scores: list[float] = []
    for info in filtered:
        try:
            text, _resp, _lat = call_fn(info["system"], info["user_text"])
        except Exception:
            scores.append(0.0); continue
        _got_tool, got_args = _extract_call(text)
        ref_steps = (info["expected_args"] or {}).get("steps") or []
        got_steps = (got_args or {}).get("steps") if isinstance(got_args, dict) else []
        if not isinstance(got_steps, list):
            got_steps = []
        ref_tools = [s.get("tool") for s in ref_steps if isinstance(s, dict)]
        got_tools = [s.get("tool") for s in got_steps if isinstance(s, dict)]
        if not ref_tools:
            scores.append(0.5)
            continue
        # Jaccard-style overlap on the multiset of step tools.
        ref_set = set(ref_tools)
        got_set = set(got_tools)
        if not got_set:
            scores.append(0.0); continue
        scores.append(len(ref_set & got_set) / max(len(ref_set | got_set), 1))
    return {
        "metric": "plan_quality",
        "n": len(filtered),
        "plan_quality": sum(scores) / len(scores) if scores else 0.0,
    }


def suite_latency(rows: list[dict], call_fn, sample_cap: int, tier: int) -> dict:
    latencies: list[int] = []
    n = min(sample_cap, len(rows), 60)  # latency benchmarks don't need the full set
    for ex in rows[:n]:
        info = _expected_from_row(ex)
        if not info:
            continue
        try:
            _text, _resp, lat = call_fn(info["system"], info["user_text"])
            latencies.append(lat)
        except Exception:
            continue
    if not latencies:
        return {"metric": "latency", "n": 0}
    s = sorted(latencies)
    def _p(q: float) -> int:
        return s[max(0, int(round(q * (len(s) - 1))))]
    out = {
        "metric": "latency",
        "n": len(latencies),
        "p50_ms": _p(0.5),
        "p95_ms": _p(0.95),
        "min_ms": s[0],
        "max_ms": s[-1],
    }
    out[f"p95_latency_ms_tier{tier}"] = _p(0.95)
    return out


def suite_regression(report: dict, prev_report: dict | None,
                     tolerance: float = 0.02) -> dict:
    """Compare top-line metrics against the prior model's report. Negative
    deltas above `tolerance` are regressions."""
    if not prev_report:
        return {"metric": "regression", "previous": None, "regressions": []}
    keys = ("tool_selection_accuracy", "parameter_extraction_accuracy",
            "schema_validity_rate", "plan_quality")
    regs: list[dict] = []
    diffs: dict[str, float] = {}
    for k in keys:
        cur = report.get(k); prev = prev_report.get(k)
        if cur is None or prev is None:
            continue
        try:
            d = float(cur) - float(prev)
        except (TypeError, ValueError):
            continue
        diffs[k] = round(d, 4)
        if d < -tolerance:
            regs.append({"metric": k, "previous": prev, "current": cur, "delta": d})
    return {
        "metric": "regression",
        "previous_report": prev_report.get("_meta", {}).get("path"),
        "deltas": diffs,
        "regressions": regs,
    }


# ── orchestration ─────────────────────────────────────────────────────
def _previous_report() -> dict | None:
    if not REPORTS_DIR.exists():
        return None
    paths = sorted(REPORTS_DIR.glob("eval-*.json"))
    if len(paths) < 1:
        return None
    try:
        rep = json.loads(paths[-1].read_text(encoding="utf-8"))
        rep.setdefault("_meta", {})["path"] = str(paths[-1])
        return rep
    except (OSError, json.JSONDecodeError):
        return None


def _save_report(report: dict, model_id: str) -> Path:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = REPORTS_DIR / f"eval-{model_id}-{ts}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2),
                    encoding="utf-8")
    return path


def _build_call_fn(model_id: str, endpoint: str, api_key: str | None):
    """Return a (system, user_text) -> (text, resp, latency_ms) callable."""
    if model_id in ("api", "claude") or model_id.startswith("claude-"):
        actual = model_id if model_id.startswith("claude-") else DEFAULT_API_MODEL
        if not api_key:
            raise SystemExit("jarvis-eval: --model api requires ANTHROPIC_API_KEY")
        def fn(system: str, user_text: str):
            return _api_call(api_key, actual, system, user_text)
        return fn
    def fn(system: str, user_text: str):
        return _local_call(endpoint, model_id, system, user_text)
    return fn


def _resolve_tier(model_id: str) -> int:
    if "3b" in model_id.lower() or model_id.endswith("_3b"):
        return 1
    if "14b" in model_id.lower() or model_id.endswith("_2") or "tier2" in model_id:
        return 2
    return 1


def _parse_args(argv: list[str]) -> dict:
    args = {"model": None, "suite": "all", "eval_file": None,
            "json_only": False, "endpoint": DEFAULT_LOCAL_ENDPOINT,
            "sample_cap": SAMPLE_CAP}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--model" and i + 1 < len(argv):
            args["model"] = argv[i + 1]; i += 2; continue
        if a == "--suite" and i + 1 < len(argv):
            args["suite"] = argv[i + 1]; i += 2; continue
        if a == "--eval-file" and i + 1 < len(argv):
            args["eval_file"] = Path(os.path.expanduser(argv[i + 1])); i += 2; continue
        if a == "--endpoint" and i + 1 < len(argv):
            args["endpoint"] = argv[i + 1]; i += 2; continue
        if a == "--sample" and i + 1 < len(argv):
            args["sample_cap"] = int(argv[i + 1]); i += 2; continue
        if a == "--json":
            args["json_only"] = True; i += 1; continue
        if a in ("-h", "--help"):
            sys.stdout.write(__doc__ or ""); sys.exit(0)
        sys.stderr.write(f"unknown arg: {a}\n"); sys.exit(2)
    if not args["model"]:
        sys.stderr.write("--model required (e.g. qwen2.5-3b-jarvis or api)\n")
        sys.exit(2)
    return args


def main(argv: list[str]) -> int:
    opts = _parse_args(argv[1:])
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")

    eval_path = opts["eval_file"] or _latest_eval_file()
    if not eval_path or not eval_path.exists():
        sys.stderr.write(
            "jarvis-eval: no eval file found. Run jarvis-data-pipeline first "
            "or pass --eval-file.\n"
        )
        return 2
    rows = _load_eval_rows(eval_path)
    if not rows:
        sys.stderr.write(f"jarvis-eval: empty eval file {eval_path}\n")
        return 2

    call_fn = _build_call_fn(opts["model"], opts["endpoint"], api_key)
    tier = _resolve_tier(opts["model"])

    suites = ALL_SUITES if opts["suite"] == "all" else [
        s.strip() for s in opts["suite"].split(",") if s.strip()
    ]

    report: dict[str, Any] = {
        "_meta": {
            "model": opts["model"],
            "tier": tier,
            "eval_file": str(eval_path),
            "sample_cap": opts["sample_cap"],
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    }

    if "tool_selection" in suites:
        report.update(suite_tool_selection(rows, call_fn, opts["sample_cap"]))
    if "parameter_extraction" in suites:
        sub = suite_parameter_extraction(rows, call_fn, opts["sample_cap"])
        report.update({k: v for k, v in sub.items() if k != "metric"})
        report["parameter_extraction_accuracy"] = sub.get("parameter_extraction_accuracy")
    if "schema_validity" in suites:
        sub = suite_schema_validity(rows, call_fn, opts["sample_cap"])
        report["schema_validity_rate"] = sub.get("schema_validity_rate")
        report["schema_validity_n"] = sub.get("n")
    if "plan_quality" in suites:
        sub = suite_plan_quality(rows, call_fn, opts["sample_cap"])
        report["plan_quality"] = sub.get("plan_quality")
        report["plan_quality_n"] = sub.get("n")
    if "latency" in suites:
        sub = suite_latency(rows, call_fn, opts["sample_cap"], tier=tier)
        report["latency_p50_ms"] = sub.get("p50_ms")
        report["latency_p95_ms"] = sub.get("p95_ms")
        report[f"p95_latency_ms_tier{tier}"] = sub.get(f"p95_latency_ms_tier{tier}")
    if "regression" in suites:
        sub = suite_regression(report, _previous_report())
        report["regression"] = sub

    saved = _save_report(report, opts["model"].replace("/", "_"))
    report["_meta"]["report_path"] = str(saved)

    if opts["json_only"]:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        sys.stderr.write(f"jarvis-eval: report → {saved}\n")
        # Stdout = JSON either way; the trainer parses it.
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except KeyboardInterrupt:
        sys.exit(130)
