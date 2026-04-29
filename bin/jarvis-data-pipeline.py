#!/usr/bin/env python3
"""Jarvis training data pipeline — emits Hermes/ChatML tool-calling JSONL
suitable for fine-tuning Qwen 2.5 (3B/14B) on Jarvis's 80 tool-calling tasks.

Two sources fold into one dataset:
  1. ledger replay — every row in ~/.jarvis/state/outcome-ledger.jsonl is
     back-translated into a (user_query, tool_call, tool_result, final_text)
     tuple. Real traffic is the gold standard; we just have to invent the
     user query that *would* have produced the recorded call.
  2. synthetic — for each tool in jarvis-think.py's TOOLS registry, ask
     Claude to produce N diverse examples spanning normal usage, edge cases,
     ambiguous inputs, and graceful-error paths.

Output:
    ~/.jarvis/training/dataset-v{N}.jsonl    — 90% train split
    ~/.jarvis/training/eval-v{N}.jsonl       —  10% eval split
    ~/.jarvis/training/stats-v{N}.json       — coverage/quality report

CLI:
    JARVIS_TRAINING=1 jarvis-data-pipeline.py --mode synthetic
    JARVIS_TRAINING=1 jarvis-data-pipeline.py --mode ledger
    JARVIS_TRAINING=1 jarvis-data-pipeline.py --mode all [--per-tool 200]

Reads:
    ANTHROPIC_API_KEY     required for synthetic mode
    JARVIS_TRAINING       must be "1" — gate against accidental runs
    ASSISTANT_DIR         base dir, default ~/.jarvis
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
BIN_DIR = ASSISTANT_DIR / "bin"
LIB_DIR = ASSISTANT_DIR / "lib"
STATE_DIR = ASSISTANT_DIR / "state"
TRAINING_DIR = ASSISTANT_DIR / "training"
LEDGER_PATH = STATE_DIR / "outcome-ledger.jsonl"

# Synthesizer model — keep on Haiku; we want breadth, not Opus-grade prose.
SYNTH_MODEL = os.environ.get("JARVIS_SYNTH_MODEL", "claude-haiku-4-5-20251001")
SYNTH_TIMEOUT = int(os.environ.get("JARVIS_SYNTH_TIMEOUT_S", "60"))
SYNTH_MAX_TOKENS = int(os.environ.get("JARVIS_SYNTH_MAX_TOKENS", "3000"))

DEFAULT_PER_TOOL = 200
TRAIN_FRACTION = 0.9


# ── jarvis-think.py introspection ─────────────────────────────────────
def _load_think_module():
    """Import bin/jarvis-think.py without putting bin/ on PYTHONPATH. We
    only touch TOOLS and TOOL_CAPABILITY_MAP; handlers don't run."""
    src = BIN_DIR / "jarvis-think.py"
    if not src.exists():
        src = Path(__file__).resolve().parent / "jarvis-think.py"
    if not src.exists():
        raise SystemExit(f"jarvis-data-pipeline: cannot find jarvis-think.py near {src}")
    spec = importlib.util.spec_from_file_location("jarvis_think", src)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _tool_index(think_mod) -> dict[str, dict]:
    """Return {tool_name: schema_dict} — schema is the dict passed to
    Anthropic's tools field (name, description, input_schema)."""
    out: dict[str, dict] = {}
    for name, pair in think_mod.TOOLS.items():
        try:
            _handler, schema = pair
        except Exception:
            continue
        if isinstance(schema, dict) and schema.get("name"):
            out[name] = schema
    return out


# ── Hermes/ChatML formatter ───────────────────────────────────────────
HERMES_SYSTEM_TEMPLATE = (
    "You are Jarvis, an executive assistant. You have access to a set of "
    "tools — call them when the user's request maps to one. For each function "
    "call return a JSON object with the name and arguments wrapped in "
    "<tool_call></tool_call> XML tags. After receiving <tool_response>, "
    "answer the user concisely.\n\n"
    "<tools>\n{tools_json}\n</tools>"
)


def _hermes_tool_block(schemas: list[dict]) -> list[dict]:
    """Convert Anthropic-style schemas to Hermes/OpenAI function spec."""
    out = []
    for s in schemas:
        out.append({
            "type": "function",
            "function": {
                "name": s.get("name"),
                "description": (s.get("description") or "").strip(),
                "parameters": s.get("input_schema") or {"type": "object", "properties": {}},
            },
        })
    return out


def _hermes_system(schemas: list[dict]) -> str:
    block = _hermes_tool_block(schemas)
    return HERMES_SYSTEM_TEMPLATE.format(
        tools_json=json.dumps(block, ensure_ascii=False, indent=2)
    )


def _hermes_assistant_call(tool_name: str, args: dict) -> str:
    payload = {"name": tool_name, "arguments": args or {}}
    return f"<tool_call>\n{json.dumps(payload, ensure_ascii=False)}\n</tool_call>"


def _hermes_tool_response(tool_name: str, result) -> str:
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except (ValueError, TypeError):
            pass
    payload = {"name": tool_name, "content": result}
    return f"<tool_response>\n{json.dumps(payload, ensure_ascii=False, default=str)}\n</tool_response>"


def _build_example(*, schemas: list[dict], tool_name: str, user_text: str,
                   args: dict, tool_result, final_text: str,
                   source: str) -> dict:
    """Assemble one training row in the messages-array format Qwen/Hermes
    fine-tuners eat directly. We also tack on a tiny meta block — the
    fine-tuner ignores it but our quality filter and stats reader look at it."""
    return {
        "messages": [
            {"role": "system", "content": _hermes_system(schemas)},
            {"role": "user", "content": user_text.strip()},
            {"role": "assistant", "content": _hermes_assistant_call(tool_name, args)},
            {"role": "tool", "content": _hermes_tool_response(tool_name, tool_result)},
            {"role": "assistant", "content": final_text.strip()},
        ],
        "_meta": {
            "tool": tool_name,
            "source": source,
        },
    }


# ── Anthropic call (matches jarvis-research.py style) ─────────────────
def _anthropic_call(api_key: str, model: str, system: str, user_text: str,
                    max_tokens: int = SYNTH_MAX_TOKENS,
                    timeout: int = SYNTH_TIMEOUT) -> str:
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
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read())
            return "\n".join(
                b.get("text", "") for b in data.get("content", [])
                if b.get("type") == "text"
            )
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(1.5 + attempt * 2)
                continue
            raise RuntimeError(f"API error {e.code}: {e}") from e
        except urllib.error.URLError as e:
            if attempt < 2:
                time.sleep(1.5 + attempt * 2)
                continue
            raise RuntimeError(f"network error: {e}") from e
    raise RuntimeError("API call exhausted retries")


# ── synthetic generation ──────────────────────────────────────────────
SYNTH_INSTRUCTIONS = """You are generating fine-tuning examples to teach a small open-weights model to call a single specific tool from Jarvis's toolset.

The tool to teach:
  name: {tool_name}
  description: {description}
  parameters: {schema}

Generate {n} diverse examples covering:
  - normal cases (most common phrasings, varied params)
  - edge cases (boundary values, optional fields populated/absent)
  - ambiguous inputs (the user is vague — the tool call should still fire with the best-guess args)
  - error paths (the tool will fail; the assistant should handle gracefully)

Each example is a JSON object with these fields:
  user_text     — what the user says (varied phrasings, sometimes with prior context implied)
  args          — JSON object the model should pass as the tool's arguments (must satisfy the schema)
  tool_result   — what the tool plausibly returns (a small JSON object, mix successes and `{{"error": "..."}}` failures)
  final_text    — the final assistant reply after seeing tool_result, in Jarvis's voice (concise, sometimes addresses user as "sir")

Return ONLY a JSON array of objects, no commentary. Strict JSON — no trailing commas, no comments. Keep each user_text under 240 chars and each final_text under 320 chars.

Vary the surface form aggressively — different sentence lengths, with/without "please", direct commands vs. questions, casual vs. formal. About 15% of examples should have tool_result with an `error` key, and the final_text should explain the failure honestly without re-trying."""


def _synth_batch(api_key: str, schema: dict, batch_size: int) -> list[dict]:
    name = schema["name"]
    desc = schema.get("description", "")
    params = schema.get("input_schema", {})
    prompt = SYNTH_INSTRUCTIONS.format(
        tool_name=name,
        description=desc,
        schema=json.dumps(params, ensure_ascii=False),
        n=batch_size,
    )
    raw = _anthropic_call(
        api_key,
        SYNTH_MODEL,
        system="You are a precise dataset generator. Output strict JSON only.",
        user_text=prompt,
    )
    # Defensive: strip markdown fences if Claude wrapped the array.
    txt = raw.strip()
    if txt.startswith("```"):
        txt = re.sub(r"^```[a-zA-Z]*\n", "", txt)
        txt = re.sub(r"\n```\s*$", "", txt)
    try:
        arr = json.loads(txt)
    except json.JSONDecodeError as e:
        # Try to recover the array if Claude added prose around it.
        m = re.search(r"\[\s*\{.*\}\s*\]", txt, re.DOTALL)
        if not m:
            raise RuntimeError(f"synth: could not parse JSON ({e})") from e
        arr = json.loads(m.group(0))
    if not isinstance(arr, list):
        raise RuntimeError("synth: top-level JSON must be array")
    return [x for x in arr if isinstance(x, dict)]


def synth_for_tool(api_key: str, schema: dict, target: int) -> Iterable[dict]:
    """Generate `target` examples for one tool by issuing batched calls."""
    tool_name = schema["name"]
    batch_size = 25  # Claude reliably hits this in one response
    produced = 0
    while produced < target:
        want = min(batch_size, target - produced)
        try:
            rows = _synth_batch(api_key, schema, want)
        except Exception as e:
            sys.stderr.write(f"[synth:{tool_name}] batch failed: {e}\n")
            return
        for row in rows:
            user_text = row.get("user_text") or ""
            args = row.get("args") or {}
            tool_result = row.get("tool_result", {})
            final_text = row.get("final_text") or ""
            if not user_text or not final_text:
                continue
            yield {
                "tool_name": tool_name,
                "user_text": user_text,
                "args": args if isinstance(args, dict) else {},
                "tool_result": tool_result,
                "final_text": final_text,
                "source": "synthetic",
            }
            produced += 1
            if produced >= target:
                return


# ── ledger replay ─────────────────────────────────────────────────────
LEDGER_BACKTRANSLATE_PROMPT = """A user said something to Jarvis that triggered the tool call below. The user's exact words were not recorded — only the resulting call. Reconstruct one plausible user_text (single short sentence) that would have produced this call, plus a plausible final_text Jarvis would have said after seeing the tool result.

tool_name: {tool}
tool_args: {args}
tool_result_status: {status}
tool_result_context: {context}

Return JSON only: {{"user_text": "...", "final_text": "..."}}"""


def _iter_ledger() -> Iterable[dict]:
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


def ledger_replay(api_key: str, tools: dict[str, dict],
                  limit: int | None = None) -> Iterable[dict]:
    """Walk the outcome ledger and back-translate each tool invocation into
    a training row. We back-translate via Claude — without the original
    user_text, supervised learning has no input. A small synthesizer call
    per row is the price of admission. Skips rows we can't tie back to a
    known tool (capability rollups like 'email' aren't tool names)."""
    seen = 0
    for rec in _iter_ledger():
        action = (rec.get("action") or "").strip()
        if action not in tools:
            continue
        ctx = rec.get("context") or {}
        # Extract args from context — _ledger_context_for() only kept a
        # subset (to/thread_id/event_id/...). Good enough as a seed.
        args_seed = {k: v for k, v in ctx.items()
                     if k not in ("tool",) and not k.startswith("r_")}
        prompt = LEDGER_BACKTRANSLATE_PROMPT.format(
            tool=action,
            args=json.dumps(args_seed, ensure_ascii=False),
            status=rec.get("status", "success"),
            context=json.dumps({k: v for k, v in ctx.items()
                                if k != "tool"}, ensure_ascii=False),
        )
        try:
            raw = _anthropic_call(
                api_key, SYNTH_MODEL,
                system="You output strict JSON only.",
                user_text=prompt,
                max_tokens=400,
            )
        except Exception as e:
            sys.stderr.write(f"[ledger] backtranslate failed: {e}\n")
            continue
        try:
            txt = raw.strip()
            if txt.startswith("```"):
                txt = re.sub(r"^```[a-zA-Z]*\n", "", txt)
                txt = re.sub(r"\n```\s*$", "", txt)
            obj = json.loads(txt)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        user_text = obj.get("user_text") or ""
        final_text = obj.get("final_text") or ""
        if not user_text or not final_text:
            continue
        yield {
            "tool_name": action,
            "user_text": user_text,
            "args": args_seed,
            "tool_result": {"status": rec.get("status"), **{
                k.removeprefix("r_"): v for k, v in ctx.items()
                if k.startswith("r_")
            }},
            "final_text": final_text,
            "source": "ledger",
        }
        seen += 1
        if limit and seen >= limit:
            return


# ── quality filter + dedup ────────────────────────────────────────────
def _example_hash(ex: dict) -> str:
    """Hash on tool + normalised user_text + arg key set so the same
    user-question phrased identically isn't double-counted, but two
    distinct phrasings of the same call survive."""
    user = re.sub(r"\s+", " ", (ex.get("user_text") or "").lower()).strip()
    keys = ",".join(sorted((ex.get("args") or {}).keys()))
    payload = f"{ex.get('tool_name')}|{user}|{keys}"
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def _validate_args(args, schema_obj: dict) -> bool:
    """Lightweight schema check — required-fields present, no obviously
    bogus types. Full JSON Schema validation is overkill at this stage."""
    if not isinstance(args, dict):
        return False
    required = (schema_obj.get("input_schema") or {}).get("required") or []
    for k in required:
        if k not in args:
            return False
    return True


def filter_and_dedup(rows: Iterable[dict],
                     schemas: dict[str, dict]) -> tuple[list[dict], dict]:
    seen: set[str] = set()
    kept: list[dict] = []
    rejected = Counter()
    for ex in rows:
        tname = ex.get("tool_name")
        schema = schemas.get(tname or "")
        if not schema:
            rejected["unknown_tool"] += 1
            continue
        ut = (ex.get("user_text") or "").strip()
        ft = (ex.get("final_text") or "").strip()
        if len(ut) < 3 or len(ut) > 600:
            rejected["bad_user_text_len"] += 1
            continue
        if len(ft) < 1 or len(ft) > 800:
            rejected["bad_final_text_len"] += 1
            continue
        if not _validate_args(ex.get("args"), schema):
            rejected["schema_violation"] += 1
            continue
        h = _example_hash(ex)
        if h in seen:
            rejected["duplicate"] += 1
            continue
        seen.add(h)
        kept.append(ex)
    return kept, dict(rejected)


# ── split + write ─────────────────────────────────────────────────────
def _next_version() -> int:
    TRAINING_DIR.mkdir(parents=True, exist_ok=True)
    vs = []
    for p in TRAINING_DIR.glob("dataset-v*.jsonl"):
        m = re.match(r"dataset-v(\d+)\.jsonl$", p.name)
        if m:
            vs.append(int(m.group(1)))
    return (max(vs) + 1) if vs else 1


def split_and_write(rows: list[dict], schemas: dict[str, dict],
                    rejected: dict, *, version: int | None = None,
                    seed: int = 1729) -> dict:
    if not rows:
        raise SystemExit("jarvis-data-pipeline: no rows to write — check inputs")
    version = version or _next_version()
    rng = random.Random(seed)
    rng.shuffle(rows)
    cut = int(len(rows) * TRAIN_FRACTION)
    train = rows[:cut]
    eval_ = rows[cut:]

    schema_list = [schemas[name] for name in sorted(schemas)]
    train_path = TRAINING_DIR / f"dataset-v{version}.jsonl"
    eval_path = TRAINING_DIR / f"eval-v{version}.jsonl"
    stats_path = TRAINING_DIR / f"stats-v{version}.json"

    def _write(path: Path, items: list[dict]) -> None:
        with path.open("w", encoding="utf-8") as f:
            for ex in items:
                tool_name = ex["tool_name"]
                tool_schemas = [schemas[tool_name]]  # one tool per row keeps prompts tight
                row = _build_example(
                    schemas=tool_schemas,
                    tool_name=tool_name,
                    user_text=ex["user_text"],
                    args=ex.get("args") or {},
                    tool_result=ex.get("tool_result", {}),
                    final_text=ex["final_text"],
                    source=ex.get("source", "unknown"),
                )
                f.write(json.dumps(row, ensure_ascii=False) + "\n")

    _write(train_path, train)
    _write(eval_path, eval_)

    stats = _build_stats(rows, train, eval_, schemas, rejected, version)
    stats_path.write_text(json.dumps(stats, ensure_ascii=False, indent=2),
                          encoding="utf-8")

    sys.stderr.write(
        f"jarvis-data-pipeline: wrote {len(train)} train + "
        f"{len(eval_)} eval rows to {TRAINING_DIR} (v{version})\n"
    )
    return {
        "version": version,
        "train_path": str(train_path),
        "eval_path": str(eval_path),
        "stats_path": str(stats_path),
        "train_n": len(train),
        "eval_n": len(eval_),
    }


def _build_stats(all_rows: list[dict], train: list[dict], eval_: list[dict],
                 schemas: dict[str, dict], rejected: dict, version: int) -> dict:
    per_tool = Counter(r["tool_name"] for r in all_rows)
    per_source = Counter(r.get("source", "unknown") for r in all_rows)
    missing = sorted(set(schemas) - set(per_tool))
    return {
        "version": version,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total_kept": len(all_rows),
        "train_n": len(train),
        "eval_n": len(eval_),
        "per_tool": dict(per_tool.most_common()),
        "per_source": dict(per_source),
        "tools_with_zero_examples": missing,
        "rejected": rejected,
        "tool_count": len(schemas),
    }


# ── CLI ───────────────────────────────────────────────────────────────
def _gate_or_die() -> None:
    if os.environ.get("JARVIS_TRAINING") != "1":
        sys.stderr.write(
            "jarvis-data-pipeline: refusing to run without JARVIS_TRAINING=1 "
            "(prevents accidental dataset rewrites and Claude API spend).\n"
        )
        sys.exit(2)


def _parse_args(argv: list[str]) -> dict:
    args = {"mode": "all", "per_tool": DEFAULT_PER_TOOL, "limit_ledger": None,
            "tools": None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--mode" and i + 1 < len(argv):
            args["mode"] = argv[i + 1]; i += 2; continue
        if a == "--per-tool" and i + 1 < len(argv):
            args["per_tool"] = int(argv[i + 1]); i += 2; continue
        if a == "--limit-ledger" and i + 1 < len(argv):
            args["limit_ledger"] = int(argv[i + 1]); i += 2; continue
        if a == "--tools" and i + 1 < len(argv):
            args["tools"] = [t.strip() for t in argv[i + 1].split(",") if t.strip()]
            i += 2; continue
        if a in ("-h", "--help"):
            sys.stdout.write(__doc__ or ""); sys.exit(0)
        sys.stderr.write(f"unknown arg: {a}\n"); sys.exit(2)
    if args["mode"] not in {"synthetic", "ledger", "all"}:
        sys.stderr.write(f"--mode must be synthetic|ledger|all (got {args['mode']})\n")
        sys.exit(2)
    return args


def main(argv: list[str]) -> int:
    opts = _parse_args(argv[1:])
    _gate_or_die()

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        sys.stderr.write("jarvis-data-pipeline: ANTHROPIC_API_KEY required.\n")
        return 2

    think = _load_think_module()
    schemas = _tool_index(think)
    if opts["tools"]:
        schemas = {k: v for k, v in schemas.items() if k in opts["tools"]}
        if not schemas:
            sys.stderr.write("jarvis-data-pipeline: --tools matched nothing.\n")
            return 2

    sys.stderr.write(f"jarvis-data-pipeline: {len(schemas)} tools in scope, "
                     f"mode={opts['mode']}\n")

    raw_rows: list[dict] = []

    if opts["mode"] in ("synthetic", "all"):
        for name in sorted(schemas):
            sys.stderr.write(f"[synth] {name}: targeting {opts['per_tool']}\n")
            for ex in synth_for_tool(api_key, schemas[name], opts["per_tool"]):
                raw_rows.append(ex)

    if opts["mode"] in ("ledger", "all"):
        sys.stderr.write("[ledger] back-translating outcome ledger…\n")
        for ex in ledger_replay(api_key, schemas, limit=opts["limit_ledger"]):
            raw_rows.append(ex)

    sys.stderr.write(f"jarvis-data-pipeline: collected {len(raw_rows)} raw rows; "
                     f"filtering…\n")
    kept, rejected = filter_and_dedup(raw_rows, schemas)
    sys.stderr.write(f"jarvis-data-pipeline: kept {len(kept)} rows "
                     f"({len(raw_rows) - len(kept)} dropped)\n")

    out = split_and_write(kept, schemas, rejected)
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except KeyboardInterrupt:
        sys.exit(130)
