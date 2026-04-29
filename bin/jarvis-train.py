#!/usr/bin/env python3
"""Jarvis training wrapper — QLoRA SFT on the Hermes-format dataset emitted
by jarvis-data-pipeline. Auto-picks the right backend for the host:

    Apple Silicon  → mlx-lm (`pip install mlx-lm`)
    NVIDIA CUDA    → Unsloth (`pip install unsloth`)
    Otherwise      → transformers + peft fallback (slow but portable)

After SFT it runs the held-out eval split through jarvis-eval, refuses to
promote the LoRA if the eval thresholds in config/training.json aren't
met, and (on success) merges the LoRA into a base-weights snapshot the
serve script can load.

CLI:
    jarvis-train.py --tier 1
    jarvis-train.py --tier 2
    jarvis-train.py --tier 1 --eval-only
    jarvis-train.py --tier 1 --no-promote
"""
from __future__ import annotations

import json
import os
import platform
import shlex
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
BIN_DIR = ASSISTANT_DIR / "bin"
CONFIG_PATH = ASSISTANT_DIR / "config" / "training.json"
TRAIN_LOG = ASSISTANT_DIR / "logs" / "training.log"


# ── config + dataset selection ────────────────────────────────────────
def _load_config() -> dict:
    if not CONFIG_PATH.exists():
        sys.stderr.write(f"jarvis-train: missing {CONFIG_PATH}\n")
        sys.exit(2)
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        sys.stderr.write(f"jarvis-train: cannot parse {CONFIG_PATH}: {e}\n")
        sys.exit(2)


def _expand(p: str) -> Path:
    return Path(os.path.expanduser(p))


def _latest_dataset(cfg: dict) -> tuple[Path, Path]:
    ds = cfg.get("dataset") or {}
    train_glob = ds.get("train_glob") or "~/.jarvis/training/dataset-v*.jsonl"
    eval_glob = ds.get("eval_glob") or "~/.jarvis/training/eval-v*.jsonl"
    train_paths = sorted(Path(os.path.expanduser(str(Path(train_glob).parent))).glob(Path(train_glob).name))
    eval_paths = sorted(Path(os.path.expanduser(str(Path(eval_glob).parent))).glob(Path(eval_glob).name))
    if not train_paths or not eval_paths:
        sys.stderr.write(
            f"jarvis-train: no dataset matched {train_glob} / {eval_glob}. "
            "Run jarvis-data-pipeline.py first.\n"
        )
        sys.exit(2)
    train = train_paths[-1] if ds.get("use_latest_only", True) else train_paths[0]
    eval_ = eval_paths[-1] if ds.get("use_latest_only", True) else eval_paths[0]
    # Sanity: minimum size
    minimum = int(ds.get("min_examples", 0))
    if minimum:
        n = sum(1 for _ in train.open("r", encoding="utf-8"))
        if n < minimum:
            sys.stderr.write(
                f"jarvis-train: train set {train} has {n} rows < min_examples={minimum}.\n"
            )
            sys.exit(2)
    return train, eval_


# ── hardware detection ────────────────────────────────────────────────
def _detect_backend(cfg: dict) -> str:
    """Return 'mlx', 'unsloth', or 'transformers' based on host + config."""
    pref = (cfg.get("hardware") or {}).get("prefer", "auto")
    if pref and pref != "auto":
        return pref
    # Apple Silicon detection
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        return (cfg.get("hardware") or {}).get("apple_silicon_backend", "mlx")
    # CUDA detection (cheap probe)
    try:
        out = subprocess.run(["nvidia-smi"], capture_output=True, timeout=5)
        if out.returncode == 0:
            return (cfg.get("hardware") or {}).get("cuda_backend", "unsloth")
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return (cfg.get("hardware") or {}).get("fallback_backend", "transformers")


def _check_backend_installed(backend: str) -> tuple[bool, str]:
    pkg = {"mlx": "mlx_lm", "unsloth": "unsloth", "transformers": "transformers"}[backend]
    try:
        __import__(pkg)
        return True, ""
    except ImportError as e:
        return False, str(e)


# ── log helper ────────────────────────────────────────────────────────
def _log(msg: str) -> None:
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    line = f"[{ts}] {msg}"
    sys.stderr.write(line + "\n")
    try:
        TRAIN_LOG.parent.mkdir(parents=True, exist_ok=True)
        with TRAIN_LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


# ── runner shells (one per backend) ───────────────────────────────────
def _run_mlx(tier_cfg: dict, train_path: Path, eval_path: Path) -> int:
    """Shell out to `mlx_lm.lora` — the supported entry point ships as a
    module in mlx-lm. We don't reimplement training; we drive it."""
    base = tier_cfg["base_model"]
    lora_dir = _expand(tier_cfg["lora_dir"])
    lora_dir.mkdir(parents=True, exist_ok=True)
    sft = tier_cfg.get("sft") or {}
    lora = tier_cfg.get("lora") or {}

    cmd = [
        sys.executable, "-m", "mlx_lm.lora",
        "--model", base,
        "--train",
        "--data", str(train_path.parent),  # mlx_lm reads train.jsonl/valid.jsonl
        "--iters", str(sft.get("epochs", 3) * 500),
        "--batch-size", str(sft.get("batch_size", 4)),
        "--learning-rate", str(sft.get("learning_rate", 2e-4)),
        "--lora-layers", str(lora.get("rank", 16)),
        "--save-every", str(sft.get("save_steps", 200)),
        "--adapter-path", str(lora_dir),
    ]
    _log(f"mlx_lm command: {shlex.join(cmd)}")
    # mlx_lm expects train.jsonl + valid.jsonl in the data dir; symlink ours.
    data_dir = train_path.parent
    train_link = data_dir / "train.jsonl"
    valid_link = data_dir / "valid.jsonl"
    try:
        if train_link.resolve() != train_path.resolve():
            try: train_link.unlink()
            except FileNotFoundError: pass
            train_link.symlink_to(train_path.name)
        if valid_link.resolve() != eval_path.resolve():
            try: valid_link.unlink()
            except FileNotFoundError: pass
            valid_link.symlink_to(eval_path.name)
    except OSError as e:
        _log(f"warning: could not stage symlinks ({e}); mlx_lm may fail")
    return subprocess.call(cmd)


def _run_unsloth(tier_cfg: dict, train_path: Path, eval_path: Path) -> int:
    """Drive Unsloth via a one-shot script. Unsloth's API is a Python lib,
    so we generate a small driver and exec it. Keeps this file dep-free
    when Unsloth isn't installed."""
    base = tier_cfg["base_model"]
    lora_dir = _expand(tier_cfg["lora_dir"])
    lora_dir.mkdir(parents=True, exist_ok=True)
    sft = tier_cfg.get("sft") or {}
    lora = tier_cfg.get("lora") or {}

    driver = f"""
import os, sys
from unsloth import FastLanguageModel
from datasets import load_dataset
from trl import SFTTrainer, SFTConfig

model, tok = FastLanguageModel.from_pretrained(
    model_name={base!r},
    max_seq_length={int(sft.get('max_seq_len', 2048))},
    load_in_4bit=True,
)
model = FastLanguageModel.get_peft_model(
    model, r={int(lora.get('rank', 16))},
    lora_alpha={int(lora.get('alpha', 32))},
    lora_dropout={float(lora.get('dropout', 0.05))},
    target_modules={list(lora.get('target_modules') or ['q_proj', 'k_proj', 'v_proj', 'o_proj'])!r},
)
ds = load_dataset('json', data_files={{'train': {str(train_path)!r}, 'eval': {str(eval_path)!r}}})
def fmt(ex):
    msgs = ex.get('messages') or []
    text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=False)
    return {{'text': text}}
ds = ds.map(fmt, remove_columns=[c for c in ds['train'].column_names if c != 'text'])

trainer = SFTTrainer(
    model=model, tokenizer=tok,
    train_dataset=ds['train'], eval_dataset=ds['eval'],
    args=SFTConfig(
        output_dir={str(lora_dir)!r},
        num_train_epochs={int(sft.get('epochs', 3))},
        per_device_train_batch_size={int(sft.get('batch_size', 1))},
        gradient_accumulation_steps={int(sft.get('grad_accum_steps', 16))},
        learning_rate={float(sft.get('learning_rate', 1e-4))},
        warmup_steps={int(sft.get('warmup_steps', 100))},
        logging_steps={int(sft.get('logging_steps', 25))},
        save_steps={int(sft.get('save_steps', 200))},
        eval_steps={int(sft.get('eval_steps', 200))},
        weight_decay={float(sft.get('weight_decay', 0.01))},
        lr_scheduler_type={sft.get('lr_scheduler', 'cosine')!r},
        max_seq_length={int(sft.get('max_seq_len', 2048))},
        dataset_text_field='text',
        report_to=[],
    ),
)
trainer.train()
trainer.save_model({str(lora_dir)!r})
"""
    driver_path = _expand("~/.jarvis/training/_unsloth_driver.py")
    driver_path.parent.mkdir(parents=True, exist_ok=True)
    driver_path.write_text(driver, encoding="utf-8")
    _log(f"unsloth driver: {driver_path}")
    return subprocess.call([sys.executable, str(driver_path)])


def _run_transformers(tier_cfg: dict, train_path: Path, eval_path: Path) -> int:
    """Portable but slow fallback. Writes a driver script using transformers
    + peft and execs it. Only for testing on hosts without mlx or CUDA."""
    base = tier_cfg["base_model"]
    lora_dir = _expand(tier_cfg["lora_dir"])
    lora_dir.mkdir(parents=True, exist_ok=True)
    sft = tier_cfg.get("sft") or {}
    lora = tier_cfg.get("lora") or {}

    driver = f"""
import os
from datasets import load_dataset
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments
from peft import LoraConfig, get_peft_model
from trl import SFTTrainer, SFTConfig

tok = AutoTokenizer.from_pretrained({base!r})
model = AutoModelForCausalLM.from_pretrained({base!r}, torch_dtype='auto')
model = get_peft_model(model, LoraConfig(
    r={int(lora.get('rank', 16))},
    lora_alpha={int(lora.get('alpha', 32))},
    lora_dropout={float(lora.get('dropout', 0.05))},
    target_modules={list(lora.get('target_modules') or ['q_proj', 'v_proj'])!r},
    task_type='CAUSAL_LM',
))
ds = load_dataset('json', data_files={{'train': {str(train_path)!r}, 'eval': {str(eval_path)!r}}})
def fmt(ex):
    msgs = ex.get('messages') or []
    text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=False)
    return {{'text': text}}
ds = ds.map(fmt, remove_columns=[c for c in ds['train'].column_names if c != 'text'])

trainer = SFTTrainer(
    model=model, tokenizer=tok,
    train_dataset=ds['train'], eval_dataset=ds['eval'],
    args=SFTConfig(
        output_dir={str(lora_dir)!r},
        num_train_epochs={int(sft.get('epochs', 3))},
        per_device_train_batch_size={int(sft.get('batch_size', 1))},
        gradient_accumulation_steps={int(sft.get('grad_accum_steps', 16))},
        learning_rate={float(sft.get('learning_rate', 1e-4))},
        logging_steps={int(sft.get('logging_steps', 25))},
        save_steps={int(sft.get('save_steps', 200))},
        eval_steps={int(sft.get('eval_steps', 200))},
        max_seq_length={int(sft.get('max_seq_len', 2048))},
        dataset_text_field='text',
        report_to=[],
    ),
)
trainer.train()
trainer.save_model({str(lora_dir)!r})
"""
    driver_path = _expand("~/.jarvis/training/_transformers_driver.py")
    driver_path.parent.mkdir(parents=True, exist_ok=True)
    driver_path.write_text(driver, encoding="utf-8")
    _log(f"transformers driver: {driver_path}")
    return subprocess.call([sys.executable, str(driver_path)])


# ── merge LoRA into base ──────────────────────────────────────────────
def _merge_lora(backend: str, tier_cfg: dict) -> int:
    base = tier_cfg["base_model"]
    lora_dir = _expand(tier_cfg["lora_dir"])
    merged_dir = _expand(tier_cfg["merged_dir"])
    merged_dir.mkdir(parents=True, exist_ok=True)
    if backend == "mlx":
        cmd = [sys.executable, "-m", "mlx_lm.fuse",
               "--model", base, "--adapter-path", str(lora_dir),
               "--save-path", str(merged_dir)]
        _log(f"merge cmd: {shlex.join(cmd)}")
        return subprocess.call(cmd)
    # transformers + peft path covers Unsloth output too (peft adapters).
    driver = f"""
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel
tok = AutoTokenizer.from_pretrained({base!r})
m = AutoModelForCausalLM.from_pretrained({base!r}, torch_dtype='auto')
m = PeftModel.from_pretrained(m, {str(lora_dir)!r})
m = m.merge_and_unload()
m.save_pretrained({str(merged_dir)!r})
tok.save_pretrained({str(merged_dir)!r})
"""
    driver_path = _expand("~/.jarvis/training/_merge_driver.py")
    driver_path.write_text(driver, encoding="utf-8")
    return subprocess.call([sys.executable, str(driver_path)])


# ── eval gate ─────────────────────────────────────────────────────────
def _run_eval(tier: int, model_id: str | None = None) -> dict:
    """Drive jarvis-eval and return its JSON report."""
    eval_bin = BIN_DIR / "jarvis-eval.py"
    if not eval_bin.exists():
        eval_bin = Path(__file__).parent / "jarvis-eval.py"
    if not eval_bin.exists():
        _log("jarvis-eval not found; skipping evaluation")
        return {"skipped": True}
    cmd = [sys.executable, str(eval_bin),
           "--model", model_id or f"local_{tier}b",
           "--suite", "all", "--json"]
    _log(f"eval cmd: {shlex.join(cmd)}")
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        _log(f"eval failed (rc={r.returncode}): {r.stderr.strip()[:400]}")
        return {"error": r.stderr.strip()[:400], "rc": r.returncode}
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError as e:
        return {"error": f"eval output not JSON: {e}", "stdout": r.stdout[:400]}


def _meets_thresholds(report: dict, thresholds: dict) -> tuple[bool, list[str]]:
    failures: list[str] = []
    for key, want in thresholds.items():
        got = report.get(key)
        if got is None:
            failures.append(f"{key}: missing in eval report")
            continue
        try:
            got_f = float(got)
            want_f = float(want)
        except (TypeError, ValueError):
            failures.append(f"{key}: non-numeric ({got} vs {want})")
            continue
        # Latency-style metrics: lower is better. Everything else: higher is better.
        if key.startswith("p95_latency_"):
            if got_f > want_f:
                failures.append(f"{key}: {got_f} > {want_f}")
        else:
            if got_f < want_f:
                failures.append(f"{key}: {got_f} < {want_f}")
    return (not failures), failures


# ── CLI ───────────────────────────────────────────────────────────────
def _parse_args(argv: list[str]) -> dict:
    args = {"tier": None, "eval_only": False, "no_promote": False,
            "backend": None, "force": False}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--tier" and i + 1 < len(argv):
            args["tier"] = int(argv[i + 1]); i += 2; continue
        if a == "--eval-only":
            args["eval_only"] = True; i += 1; continue
        if a == "--no-promote":
            args["no_promote"] = True; i += 1; continue
        if a == "--backend" and i + 1 < len(argv):
            args["backend"] = argv[i + 1]; i += 2; continue
        if a == "--force":
            args["force"] = True; i += 1; continue
        if a in ("-h", "--help"):
            sys.stdout.write(__doc__ or ""); sys.exit(0)
        sys.stderr.write(f"unknown arg: {a}\n"); sys.exit(2)
    if args["tier"] not in (1, 2):
        sys.stderr.write("--tier 1|2 required\n"); sys.exit(2)
    return args


def main(argv: list[str]) -> int:
    opts = _parse_args(argv[1:])
    cfg = _load_config()
    tier_key = f"tier{opts['tier']}"
    tier_cfg = (cfg.get("tiers") or {}).get(tier_key)
    if not tier_cfg:
        sys.stderr.write(f"jarvis-train: tier {tier_key} missing in {CONFIG_PATH}\n")
        return 2

    train_path, eval_path = _latest_dataset(cfg)
    _log(f"tier={tier_key} train={train_path.name} eval={eval_path.name}")

    backend = opts["backend"] or _detect_backend(cfg)
    _log(f"backend={backend}")

    if not opts["eval_only"]:
        ok, err = _check_backend_installed(backend)
        if not ok and not opts["force"]:
            sys.stderr.write(
                f"jarvis-train: backend '{backend}' not installed ({err}). "
                f"`pip install {backend}` or pass --backend transformers --force.\n"
            )
            return 2
        runner = {"mlx": _run_mlx, "unsloth": _run_unsloth,
                  "transformers": _run_transformers}[backend]
        t0 = time.monotonic()
        rc = runner(tier_cfg, train_path, eval_path)
        elapsed = int(time.monotonic() - t0)
        _log(f"training rc={rc} elapsed_s={elapsed}")
        if rc != 0:
            return rc

    # Eval gate
    eval_thresholds = ((cfg.get("evaluation") or {}).get("thresholds") or {})
    # Tier-1 latency threshold is named with the tier suffix; pick out
    # only the keys that apply to this tier.
    relevant = {}
    for k, v in eval_thresholds.items():
        if k.endswith("_tier1") and opts["tier"] != 1: continue
        if k.endswith("_tier2") and opts["tier"] != 2: continue
        relevant[k] = v
    report = _run_eval(opts["tier"], tier_cfg.get("served_model_id"))
    _log(f"eval report: {json.dumps(report, ensure_ascii=False)[:500]}")

    if "error" in report and not opts["force"]:
        return 3

    passed, failures = _meets_thresholds(report, relevant)
    if not passed:
        _log(f"thresholds NOT met: {failures}")
        if not opts["force"]:
            sys.stderr.write(
                f"jarvis-train: refusing to merge LoRA — {len(failures)} thresholds "
                f"failed:\n  " + "\n  ".join(failures) + "\n"
            )
            return 3

    if opts["eval_only"] or opts["no_promote"]:
        print(json.dumps({"tier": opts["tier"], "passed": passed,
                          "report": report, "promoted": False},
                         ensure_ascii=False, indent=2))
        return 0 if passed else 3

    rc = _merge_lora(backend, tier_cfg)
    if rc != 0:
        return rc
    print(json.dumps({
        "tier": opts["tier"], "passed": passed, "report": report,
        "promoted": True, "merged_dir": str(_expand(tier_cfg["merged_dir"])),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except KeyboardInterrupt:
        sys.exit(130)
