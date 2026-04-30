#!/usr/bin/env python3
"""Jarvis local inference server — OpenAI-compatible endpoint backed by
either Ollama (default) or mlx-lm. Loads both Tier 1 (3B) and Tier 2
(14B) Jarvis-tuned models and routes requests by `model` field.

Endpoints:
    POST /v1/chat/completions       — OpenAI-style chat (with tool support)
    GET  /healthz                   — backend connectivity + per-model probe
    GET  /v1/models                 — list served model ids
    POST /admin/reload              — re-read config + clear caches (used
                                       after retraining promotes a new LoRA)
    GET  /metrics                   — request rate, latency p50/p95, tier
                                       distribution

Hermes/ChatML tool calling: client passes OpenAI-format `tools`; we render
them into a Hermes <tools>…</tools> system block, ask the model, and parse
<tool_call> blocks back into OpenAI-style `tool_calls`.

CLI:
    jarvis-serve.py --port 8741 [--runtime ollama|mlx]
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
TRAINING_CONFIG = ASSISTANT_DIR / "config" / "training.json"
ROUTING_CONFIG = ASSISTANT_DIR / "config" / "model-routing.json"

DEFAULT_PORT = int(os.environ.get("JARVIS_SERVE_PORT", "8741"))
DEFAULT_RUNTIME = os.environ.get("JARVIS_SERVE_RUNTIME", "ollama")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
REQUEST_TIMEOUT = int(os.environ.get("JARVIS_SERVE_TIMEOUT_S", "120"))

HERMES_TOOL_CALL_RE = re.compile(
    r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.DOTALL
)


# ── config + state ────────────────────────────────────────────────────
class ServerState:
    def __init__(self, runtime: str):
        self.runtime = runtime
        self.lock = threading.Lock()
        self.metrics_window: deque[tuple[float, str, int]] = deque(maxlen=4096)
        self.start_time = time.monotonic()
        self.config = self._load_config()

    def _load_config(self) -> dict:
        if not TRAINING_CONFIG.exists():
            return {"tiers": {}, "serving": {}}
        try:
            return json.loads(TRAINING_CONFIG.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"tiers": {}, "serving": {}}

    def reload(self) -> None:
        with self.lock:
            self.config = self._load_config()

    def served_ids(self) -> dict[str, dict]:
        """Return {served_id: tier_block} for both tiers from config."""
        out = {}
        for tier_name, block in (self.config.get("tiers") or {}).items():
            sid = block.get("served_model_id")
            if sid:
                out[sid] = {"tier": tier_name, **block}
        return out

    def record_request(self, tier: str, latency_ms: int) -> None:
        self.metrics_window.append((time.time(), tier, latency_ms))


# ── Hermes/ChatML rendering ───────────────────────────────────────────
HERMES_SYSTEM_TOOLBLOCK = (
    "\n\nYou have access to functions. When you need to call one, emit a "
    "single block:\n<tool_call>\n{{\"name\": ..., \"arguments\": {{...}}}}\n"
    "</tool_call>\nOnly emit the tool_call block — no prose around it. After "
    "the tool result returns wrapped in <tool_response>, answer the user.\n\n"
    "<tools>\n{tools_json}\n</tools>"
)


def _render_messages_for_hermes(messages: list[dict],
                                tools: list[dict] | None) -> list[dict]:
    """Take OpenAI-format messages + tool list and return messages the
    underlying chat-completion API can consume directly. We append the
    Hermes tools system block to whatever system message already exists,
    and re-format `tool` role messages as <tool_response> wrapped strings."""
    out: list[dict] = []
    sys_idx: int | None = None
    for i, m in enumerate(messages):
        if m.get("role") == "system":
            sys_idx = i
            break
    sys_text = messages[sys_idx]["content"] if sys_idx is not None else ""
    if tools:
        sys_text = (sys_text or "") + HERMES_SYSTEM_TOOLBLOCK.format(
            tools_json=json.dumps(tools, ensure_ascii=False, indent=2)
        )

    out.append({"role": "system", "content": sys_text or "You are a helpful assistant."})
    for i, m in enumerate(messages):
        if i == sys_idx:
            continue
        role = m.get("role")
        content = m.get("content", "")
        if role == "tool":
            tool_name = m.get("name") or "unknown"
            wrapped = f"<tool_response>\n{json.dumps({'name': tool_name, 'content': content}, ensure_ascii=False)}\n</tool_response>"
            out.append({"role": "tool", "content": wrapped})
        elif role == "assistant" and m.get("tool_calls"):
            calls_str = "\n".join(
                f"<tool_call>\n{json.dumps({'name': c.get('function', {}).get('name'), 'arguments': json.loads(c.get('function', {}).get('arguments') or '{}')}, ensure_ascii=False)}\n</tool_call>"
                for c in m["tool_calls"]
            )
            out.append({"role": "assistant", "content": calls_str + ("\n" + content if content else "")})
        else:
            out.append({"role": role, "content": content or ""})
    return out


def _parse_hermes_response(text: str) -> tuple[str, list[dict]]:
    """Return (visible_text, tool_calls_in_openai_format).
    Strips any <tool_call>...</tool_call> blocks from the text so the
    caller doesn't double-display them."""
    calls = []
    for m in HERMES_TOOL_CALL_RE.finditer(text or ""):
        try:
            obj = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        name = obj.get("name")
        args = obj.get("arguments") or {}
        if not name:
            continue
        calls.append({
            "id": f"call_{len(calls)}_{int(time.time() * 1000) % 100000}",
            "type": "function",
            "function": {
                "name": name,
                "arguments": json.dumps(args, ensure_ascii=False),
            },
        })
    visible = HERMES_TOOL_CALL_RE.sub("", text or "").strip()
    return visible, calls


# ── runtime adapters ──────────────────────────────────────────────────
def _ollama_chat(model: str, messages: list[dict], options: dict | None) -> dict:
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "options": options or {},
    }
    req = urllib.request.Request(
        f"{OLLAMA_URL.rstrip('/')}/api/chat",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")[:500]
        except Exception:
            pass
        raise RuntimeError(f"ollama chat HTTP {e.code}: {body or e.reason}") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise RuntimeError(f"ollama chat unreachable: {e}") from e
    except json.JSONDecodeError as e:
        raise RuntimeError(f"ollama chat returned non-JSON: {e}") from e


def _ollama_health() -> dict:
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL.rstrip('/')}/api/tags",
                                    timeout=5) as r:
            data = json.loads(r.read())
        models = [m.get("name") for m in data.get("models", []) if m.get("name")]
        return {"runtime": "ollama", "ok": True, "models": models}
    except Exception as e:
        return {"runtime": "ollama", "ok": False, "error": str(e)}


# Lazy-loaded mlx adapter — only imported if --runtime mlx is requested,
# since mlx-lm is a heavyweight dep that won't be on most boxes.
_mlx_models: dict[str, Any] = {}
_mlx_lock = threading.Lock()


def _mlx_chat(model: str, messages: list[dict], options: dict | None,
              state: "ServerState") -> dict:
    try:
        import mlx_lm  # type: ignore
    except ImportError as e:
        raise RuntimeError("mlx-lm is not installed; pip install mlx-lm") from e

    served = state.served_ids().get(model)
    if not served:
        raise RuntimeError(f"unknown model: {model}")
    model_dir = os.path.expanduser(served.get("merged_dir") or served.get("model_dir") or "")
    if not model_dir or not Path(model_dir).exists():
        raise RuntimeError(f"model dir missing: {model_dir}")

    with _mlx_lock:
        if model not in _mlx_models:
            _mlx_models[model] = mlx_lm.load(model_dir)
    mdl, tok = _mlx_models[model]

    # Render to a single prompt string via the tokenizer's chat template.
    prompt = tok.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    max_tokens = (options or {}).get("num_predict", 1024)
    text = mlx_lm.generate(mdl, tok, prompt=prompt, max_tokens=max_tokens, verbose=False)
    return {"message": {"role": "assistant", "content": text}}


# ── HTTP handler ──────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    state: ServerState  # injected at server boot

    def log_message(self, fmt, *args):  # quiet default access log
        if os.environ.get("JARVIS_SERVE_DEBUG") == "1":
            sys.stderr.write("jarvis-serve: " + fmt % args + "\n")

    def _json(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # GET routes
    def do_GET(self):
        if self.path == "/healthz":
            self._json(200, self._healthz())
        elif self.path == "/v1/models":
            served = self.state.served_ids()
            self._json(200, {"object": "list", "data": [
                {"id": sid, "object": "model", "owned_by": "jarvis",
                 "tier": meta.get("tier")}
                for sid, meta in served.items()
            ]})
        elif self.path == "/metrics":
            self._json(200, self._metrics())
        else:
            self._json(404, {"error": "not found"})

    # POST routes
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            body = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid JSON"})
            return

        if self.path == "/v1/chat/completions":
            self._handle_chat(body)
        elif self.path == "/admin/reload":
            self.state.reload()
            self._json(200, {"reloaded": True,
                             "models": list(self.state.served_ids().keys())})
        else:
            self._json(404, {"error": "not found"})

    def _handle_chat(self, body: dict) -> None:
        model = body.get("model")
        messages = body.get("messages") or []
        tools = body.get("tools")
        options = {
            "num_predict": body.get("max_tokens", 1024),
            "temperature": body.get("temperature", 0.7),
        }
        if not model or not messages:
            self._json(400, {"error": "model and messages required"})
            return

        served = self.state.served_ids().get(model)
        if not served:
            self._json(404, {"error": f"unknown model: {model}",
                             "available": list(self.state.served_ids().keys())})
            return

        rendered = _render_messages_for_hermes(messages, tools)

        t0 = time.monotonic()
        try:
            if self.state.runtime == "ollama":
                # Ollama tag for the served model is the same id.
                resp = _ollama_chat(model, rendered, options)
                content = (resp.get("message") or {}).get("content", "")
            else:
                resp = _mlx_chat(model, rendered, options, self.state)
                content = (resp.get("message") or {}).get("content", "")
        except Exception as e:
            self._json(502, {"error": f"backend failure: {e}",
                             "runtime": self.state.runtime})
            return
        latency_ms = int((time.monotonic() - t0) * 1000)
        self.state.record_request(served.get("tier", "unknown"), latency_ms)

        text, tool_calls = _parse_hermes_response(content)
        msg: dict[str, Any] = {"role": "assistant", "content": text or None}
        if tool_calls:
            msg["tool_calls"] = tool_calls

        self._json(200, {
            "id": f"chatcmpl-{int(time.time() * 1000)}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [{
                "index": 0,
                "message": msg,
                "finish_reason": "tool_calls" if tool_calls else "stop",
            }],
            "usage": {
                "prompt_tokens": resp.get("prompt_eval_count"),
                "completion_tokens": resp.get("eval_count"),
                "total_tokens": (resp.get("prompt_eval_count") or 0) + (resp.get("eval_count") or 0),
                "latency_ms": latency_ms,
            },
        })

    # health + metrics
    def _healthz(self) -> dict:
        served = self.state.served_ids()
        out: dict = {
            "status": "ok",
            "runtime": self.state.runtime,
            "uptime_s": int(time.monotonic() - self.state.start_time),
            "served_models": list(served.keys()),
        }
        if self.state.runtime == "ollama":
            health = _ollama_health()
            out["backend"] = health
            ok = health.get("ok") and all(any(m.startswith(sid) for m in health.get("models", []))
                                          for sid in served.keys())
            if not ok:
                out["status"] = "degraded"
                missing = [sid for sid in served.keys()
                           if not any(m.startswith(sid) for m in health.get("models", []))]
                if missing:
                    out["missing_models"] = missing
        else:
            # mlx: each model is loaded lazily on first call; report status.
            out["backend"] = {"runtime": "mlx",
                              "loaded": list(_mlx_models.keys())}
        return out

    def _metrics(self) -> dict:
        rows = list(self.state.metrics_window)
        now = time.time()
        recent = [(ts, tier, lat) for ts, tier, lat in rows if now - ts <= 300]

        def _p(xs: list[int], q: float) -> int | None:
            if not xs:
                return None
            xs = sorted(xs); idx = max(0, int(round(q * (len(xs) - 1))))
            return xs[idx]

        latencies_all = [lat for _, _, lat in recent]
        by_tier: dict[str, list[int]] = {}
        for _, tier, lat in recent:
            by_tier.setdefault(tier, []).append(lat)

        return {
            "window_s": 300,
            "request_count": len(recent),
            "rps": round(len(recent) / 300.0, 3),
            "latency_p50_ms": _p(latencies_all, 0.5),
            "latency_p95_ms": _p(latencies_all, 0.95),
            "by_tier": {
                tier: {
                    "count": len(xs),
                    "p50_ms": _p(xs, 0.5),
                    "p95_ms": _p(xs, 0.95),
                } for tier, xs in by_tier.items()
            },
            "uptime_s": int(time.monotonic() - self.state.start_time),
        }


# ── CLI ───────────────────────────────────────────────────────────────
def _parse_args(argv: list[str]) -> dict:
    args = {"port": DEFAULT_PORT, "runtime": DEFAULT_RUNTIME, "host": "127.0.0.1"}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--port" and i + 1 < len(argv):
            args["port"] = int(argv[i + 1]); i += 2; continue
        if a == "--runtime" and i + 1 < len(argv):
            args["runtime"] = argv[i + 1]; i += 2; continue
        if a == "--host" and i + 1 < len(argv):
            args["host"] = argv[i + 1]; i += 2; continue
        if a in ("-h", "--help"):
            sys.stdout.write(__doc__ or ""); sys.exit(0)
        sys.stderr.write(f"unknown arg: {a}\n"); sys.exit(2)
    if args["runtime"] not in ("ollama", "mlx"):
        sys.stderr.write("--runtime must be ollama|mlx\n"); sys.exit(2)
    return args


def main(argv: list[str]) -> int:
    opts = _parse_args(argv[1:])
    state = ServerState(runtime=opts["runtime"])

    served = state.served_ids()
    if not served:
        sys.stderr.write(
            f"jarvis-serve: no models in {TRAINING_CONFIG} — "
            "fill in `tiers.tier1.served_model_id` and `tiers.tier2.served_model_id`.\n"
        )
        return 2

    Handler.state = state
    httpd = ThreadingHTTPServer((opts["host"], opts["port"]), Handler)
    sys.stderr.write(
        f"jarvis-serve: listening on {opts['host']}:{opts['port']} "
        f"(runtime={opts['runtime']}, models={list(served.keys())})\n"
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("jarvis-serve: shutting down\n")
        httpd.server_close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except KeyboardInterrupt:
        sys.exit(130)
