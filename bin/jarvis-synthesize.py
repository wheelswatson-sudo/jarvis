#!/usr/bin/env python3
"""Knowledge synthesis — distill memories + conversation into a deep
profile of Watson.

Reads:
    ~/.jarvis/memory/memories.jsonl       all stored memories
    ~/.jarvis/cache/conversation.json     rolling conversation + summary

Calls Claude (Sonnet — this needs intelligence, not speed) once and asks
it to extract:
    decision_patterns
    communication_preferences
    values_and_priorities
    stress_indicators
    knowledge_domains  {expert: [...], novice: [...]}
    relationship_map   {name: relation_summary}
    goals_and_projects

Saves:
    ~/.jarvis/synthesis/watson_profile.json
    ~/.jarvis/synthesis/last_run.json     (timestamp, sessions_at_run)

Schedule: re-runs at most once per RUN_INTERVAL_HOURS (default 168 / week)
or after RUN_AFTER_SESSIONS (default 20) new sessions, whichever comes
first. The synth call costs real tokens — don't fire it on every convo.

system_prompt_hint() pulls the current profile and emits a tight "## User
Profile" block for jarvis-think.py's _build_system_blocks. Caps the
injection at PROFILE_PROMPT_BUDGET chars so a long synthesis doesn't
swamp the context.

Usage:
    bin/jarvis-synthesize.py             run if interval/session conditions met
    bin/jarvis-synthesize.py --force     run regardless of schedule
    bin/jarvis-synthesize.py --print     show current profile
    bin/jarvis-synthesize.py --reset     wipe profile + last_run

Gate: JARVIS_SYNTHESIZE (default 1).
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
MEMORY_FILE = ASSISTANT_DIR / "memory" / "memories.jsonl"
HISTORY_FILE = ASSISTANT_DIR / "cache" / "conversation.json"
SYNTH_DIR = ASSISTANT_DIR / "synthesis"
PROFILE_FILE = SYNTH_DIR / "watson_profile.json"
LAST_RUN_FILE = SYNTH_DIR / "last_run.json"

SYNTH_MODEL = os.environ.get("JARVIS_SYNTH_MODEL", "claude-sonnet-4-6")
RUN_INTERVAL_HOURS = float(os.environ.get("JARVIS_SYNTH_INTERVAL_HOURS", "168"))
RUN_AFTER_SESSIONS = int(os.environ.get("JARVIS_SYNTH_AFTER_SESSIONS", "20"))
SYNTH_MAX_TOKENS = int(os.environ.get("JARVIS_SYNTH_MAX_TOKENS", "1500"))

# Cap how much of the corpus we send. Memories tend to be short; the
# rolling conversation summary is a tight memo. Combined cap keeps the
# Sonnet call to a few-cent operation.
MAX_MEMORIES = int(os.environ.get("JARVIS_SYNTH_MAX_MEMORIES", "300"))
MAX_RECENT_TURNS = int(os.environ.get("JARVIS_SYNTH_MAX_TURNS", "60"))
PROFILE_PROMPT_BUDGET = int(os.environ.get("JARVIS_SYNTH_PROMPT_BUDGET", "1200"))


def _load_memories(limit: int = MAX_MEMORIES) -> list[dict]:
    if not MEMORY_FILE.exists():
        return []
    out: list[dict] = []
    try:
        with MEMORY_FILE.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    # Most recent N (file is append-only; tail is freshest)
    return out[-limit:]


def _load_history() -> dict:
    if not HISTORY_FILE.exists():
        return {"summary": "", "messages": []}
    try:
        with HISTORY_FILE.open(encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return {"summary": "", "messages": []}
    if not isinstance(data, dict):
        return {"summary": "", "messages": []}
    return data


def _load_last_run() -> dict:
    if not LAST_RUN_FILE.exists():
        return {"ts": 0.0, "sessions_at_run": 0}
    try:
        with LAST_RUN_FILE.open(encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"ts": 0.0, "sessions_at_run": 0}
        return data
    except (json.JSONDecodeError, OSError):
        return {"ts": 0.0, "sessions_at_run": 0}


def _save_last_run(sessions: int) -> None:
    try:
        SYNTH_DIR.mkdir(parents=True, exist_ok=True)
        tmp = LAST_RUN_FILE.with_suffix(LAST_RUN_FILE.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump({"ts": time.time(), "sessions_at_run": sessions}, f)
        os.replace(tmp, LAST_RUN_FILE)
    except OSError:
        pass


def _count_sessions() -> int:
    """Cheap proxy for "sessions since last run": number of feedback
    session files in the feedback dir."""
    fb_dir = ASSISTANT_DIR / "feedback"
    if not fb_dir.exists():
        return 0
    try:
        return sum(1 for p in fb_dir.glob("session_*.json"))
    except OSError:
        return 0


def should_run() -> bool:
    if os.environ.get("JARVIS_SYNTHESIZE", "1") != "1":
        return False
    last = _load_last_run()
    age_h = (time.time() - float(last.get("ts", 0))) / 3600.0
    if age_h >= RUN_INTERVAL_HOURS:
        return True
    sessions_now = _count_sessions()
    delta = sessions_now - int(last.get("sessions_at_run", 0))
    return delta >= RUN_AFTER_SESSIONS


# ── Sonnet call ──────────────────────────────────────────────────────
def _build_synthesis_prompt(memories: list[dict], history: dict) -> str:
    summary = (history.get("summary") or "").strip()
    messages = list(history.get("messages") or [])[-MAX_RECENT_TURNS:]

    parts: list[str] = [
        "You are analyzing interaction history to build a deep profile of Watson, "
        "a user of the JARVIS voice assistant. Extract structured insight from "
        "the data below — patterns, not single anecdotes. Keep each field "
        "concise; total output budget is roughly 1000 words.",
        "",
        "## Memories Watson asked Jarvis to remember (most recent first)",
    ]
    for m in reversed(memories):
        text = (m.get("text") or "").strip()
        if not text:
            continue
        when = (m.get("created_at") or "")[:10]
        tags = ",".join(m.get("tags") or [])
        parts.append(f"- [{when}] {text}" + (f"  (tags: {tags})" if tags else ""))

    if summary:
        parts.append("")
        parts.append("## Rolling conversation summary")
        parts.append(summary)

    if messages:
        parts.append("")
        parts.append("## Recent conversation excerpt (last turns)")
        for m in messages:
            content = m.get("content")
            if not isinstance(content, str):
                continue
            content = content.strip()
            if not content:
                continue
            role = m.get("role", "?").upper()
            # Truncate any single turn so one rambling user message can't
            # dominate the prompt budget.
            if len(content) > 600:
                content = content[:580] + " …"
            parts.append(f"{role}: {content}")

    parts.append("")
    parts.append(
        "Now produce a JSON object with exactly these keys, each value being a "
        "concise string OR a small object as indicated. NO commentary outside "
        "the JSON. NO markdown fences."
    )
    parts.append('''
{
  "decision_patterns": "How does Watson decide things? (1-2 sentences)",
  "communication_preferences": "How does he like information delivered?",
  "values_and_priorities": "What does he weight heavily?",
  "stress_indicators": "What signals he's under pressure?",
  "knowledge_domains": {"expert": ["..."], "novice": ["..."]},
  "relationship_map": {"name": "1-line relation summary", ...},
  "goals_and_projects": "Active goals and projects (compact list)."
}
''')
    return "\n".join(parts)


def run(force: bool = False) -> dict | None:
    """Run a synthesis pass and write watson_profile.json. Returns the
    profile dict on success, None when skipped or errored."""
    if not force and not should_run():
        return None
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        sys.stderr.write("jarvis-synthesize: ANTHROPIC_API_KEY not set\n")
        return None

    memories = _load_memories()
    history = _load_history()
    if not memories and not (history.get("summary") or history.get("messages")):
        # Nothing to synthesize from — don't burn the call.
        return None

    prompt = _build_synthesis_prompt(memories, history)

    body = {
        "model": SYNTH_MODEL,
        "max_tokens": SYNTH_MAX_TOKENS,
        "messages": [{"role": "user", "content": prompt}],
    }
    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read())
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        sys.stderr.write(f"jarvis-synthesize: API error {e}\n")
        return None

    blocks = data.get("content") or []
    text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()
    if not text:
        return None

    # Strip code fences if Claude wrapped the JSON despite the instruction
    if text.startswith("```"):
        text = text.split("\n", 1)[-1]
        if text.endswith("```"):
            text = text.rsplit("```", 1)[0]
        text = text.strip()

    try:
        profile = json.loads(text)
        if not isinstance(profile, dict):
            raise ValueError("profile is not a dict")
    except (json.JSONDecodeError, ValueError) as e:
        sys.stderr.write(f"jarvis-synthesize: JSON parse failed ({e}); raw: {text[:200]!r}\n")
        return None

    profile["_meta"] = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "model": SYNTH_MODEL,
        "memories_used": len(memories),
        "messages_used": min(MAX_RECENT_TURNS, len(history.get("messages") or [])),
    }
    try:
        SYNTH_DIR.mkdir(parents=True, exist_ok=True)
        tmp = PROFILE_FILE.with_suffix(PROFILE_FILE.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(profile, f, indent=2, ensure_ascii=False)
        os.replace(tmp, PROFILE_FILE)
    except OSError as e:
        sys.stderr.write(f"jarvis-synthesize: write failed ({e})\n")
        return None
    _save_last_run(_count_sessions())
    return profile


# ── System prompt hint ───────────────────────────────────────────────
def _format_compact(profile: dict) -> str:
    """Emit a single multi-line block under the prompt budget."""
    parts: list[str] = ["## User Profile (synthesized)"]
    for key, label in [
        ("decision_patterns", "Decisions"),
        ("communication_preferences", "Comms style"),
        ("values_and_priorities", "Priorities"),
        ("stress_indicators", "Stress signals"),
        ("goals_and_projects", "Active goals"),
    ]:
        v = profile.get(key)
        if isinstance(v, str) and v.strip():
            parts.append(f"- {label}: {v.strip()}")

    domains = profile.get("knowledge_domains")
    if isinstance(domains, dict):
        expert = domains.get("expert") or []
        novice = domains.get("novice") or []
        if expert:
            parts.append("- Expert: " + ", ".join(str(x) for x in expert)[:200])
        if novice:
            parts.append("- Novice: " + ", ".join(str(x) for x in novice)[:200])

    rel = profile.get("relationship_map")
    if isinstance(rel, dict) and rel:
        # Top 5 most distinct names
        items = list(rel.items())[:5]
        rel_str = "; ".join(f"{n}: {v}" for n, v in items)
        parts.append(f"- People: {rel_str}")

    body = "\n".join(parts).strip()
    if len(body) > PROFILE_PROMPT_BUDGET:
        body = body[: PROFILE_PROMPT_BUDGET - 1].rstrip() + "…"
    return body


def system_prompt_hint() -> str:
    if os.environ.get("JARVIS_SYNTHESIZE", "1") != "1":
        return ""
    if not PROFILE_FILE.exists():
        return ""
    try:
        with PROFILE_FILE.open() as f:
            profile = json.load(f)
        if not isinstance(profile, dict):
            return ""
    except (json.JSONDecodeError, OSError):
        return ""
    return _format_compact(profile)


def _cli() -> int:
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        sys.stdout.write(__doc__ or "")
        return 0
    if args and args[0] == "--print":
        if PROFILE_FILE.exists():
            print(PROFILE_FILE.read_text())
        else:
            print("(no profile yet)")
        return 0
    if args and args[0] == "--reset":
        for p in (PROFILE_FILE, LAST_RUN_FILE):
            try:
                p.unlink()
            except FileNotFoundError:
                pass
        print("synthesis reset")
        return 0
    if args and args[0] == "--force":
        prof = run(force=True)
        if prof:
            print(json.dumps(prof, indent=2, ensure_ascii=False))
            return 0
        return 1
    if os.environ.get("JARVIS_SYNTHESIZE", "1") != "1":
        return 0
    run(force=False)
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
