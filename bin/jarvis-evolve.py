#!/usr/bin/env python3
"""Prompt evolution engine — Jarvis proposes edits to its own personality.

Reads:
    config/personality.md                 current system prompt
    ~/.jarvis/feedback/profile.json       behavior aggregates
    ~/.jarvis/feedback/session_*.json     raw signals (last EVOLUTION_WINDOW)
    ~/.jarvis/autopsies/fixes.json        learned-fix counts (optional)

Calls Claude (Sonnet — judgment matters more than speed) and asks for a
JSON array of proposed edits to personality.md, each with section,
action (add | modify | remove), and content. Applies them to a DRAFT
at config/personality.draft.md and writes a unified-diff-style record
to ~/.jarvis/evolution/pending_<ts>.md.

CRITICAL: This script NEVER overwrites personality.md without explicit
user approval. The flow is:
    1. evolve.py runs → produces draft + pending record + summary
    2. wake-listener (or boot path) sees a pending record and tells the
       user: "I have N suggestions for how I communicate. Want to hear?"
    3. User says yes → narrate via system_prompt_hint() in next reply,
       then a separate `bin/jarvis-evolve.py --approve` accepts it.
    4. User says no → `bin/jarvis-evolve.py --reject` archives the draft.

Schedule: at most once per RUN_INTERVAL_HOURS (default 168 / week) or
after RUN_AFTER_SESSIONS (default 10), whichever comes first.

Files:
    config/personality.draft.md             pending draft (NOT live)
    ~/.jarvis/evolution/pending_<ts>.md     human-readable proposal
    ~/.jarvis/evolution/applied/            archived approved edits
    ~/.jarvis/evolution/rejected/           archived rejected edits
    ~/.jarvis/evolution/last_evolved.txt    last run timestamp

Usage:
    bin/jarvis-evolve.py                   run if schedule met, write draft
    bin/jarvis-evolve.py --force           run regardless of schedule
    bin/jarvis-evolve.py --status          summarize pending vs applied
    bin/jarvis-evolve.py --approve         accept the latest pending draft
    bin/jarvis-evolve.py --reject [reason] reject and archive
    bin/jarvis-evolve.py --print           show the latest pending diff
    bin/jarvis-evolve.py --reset           wipe drafts (for debugging)

Gate: JARVIS_EVOLVE (default 1).
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
PERSONALITY_FILE = ASSISTANT_DIR / "config" / "personality.md"
DRAFT_FILE = ASSISTANT_DIR / "config" / "personality.draft.md"
EVOLUTION_DIR = ASSISTANT_DIR / "evolution"
APPLIED_DIR = EVOLUTION_DIR / "applied"
REJECTED_DIR = EVOLUTION_DIR / "rejected"
LAST_EVOLVED = EVOLUTION_DIR / "last_evolved.txt"

FEEDBACK_DIR = ASSISTANT_DIR / "feedback"
PROFILE_FILE = FEEDBACK_DIR / "profile.json"

EVOLVE_MODEL = os.environ.get("JARVIS_EVOLVE_MODEL", "claude-sonnet-4-6")
RUN_INTERVAL_HOURS = float(os.environ.get("JARVIS_EVOLVE_INTERVAL_HOURS", "168"))
RUN_AFTER_SESSIONS = int(os.environ.get("JARVIS_EVOLVE_AFTER_SESSIONS", "10"))
EVOLVE_MAX_TOKENS = int(os.environ.get("JARVIS_EVOLVE_MAX_TOKENS", "2000"))
EVOLVE_WINDOW_SESSIONS = int(os.environ.get("JARVIS_EVOLVE_WINDOW", "10"))


def _read_text(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def _read_json(p: Path, default):
    if not p.exists():
        return default
    try:
        with p.open() as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return default


def _count_sessions() -> int:
    if not FEEDBACK_DIR.exists():
        return 0
    try:
        return sum(1 for _ in FEEDBACK_DIR.glob("session_*.json"))
    except OSError:
        return 0


def _last_run_ts() -> float:
    if not LAST_EVOLVED.exists():
        return 0.0
    try:
        line = LAST_EVOLVED.read_text(encoding="utf-8").strip().splitlines()[0]
        return float(line.split()[0])
    except (OSError, ValueError, IndexError):
        return 0.0


def _last_run_sessions() -> int:
    if not LAST_EVOLVED.exists():
        return 0
    try:
        line = LAST_EVOLVED.read_text(encoding="utf-8").strip().splitlines()[0]
        bits = line.split()
        return int(bits[1]) if len(bits) > 1 else 0
    except (OSError, ValueError, IndexError):
        return 0


def _record_run(sessions: int) -> None:
    try:
        EVOLUTION_DIR.mkdir(parents=True, exist_ok=True)
        LAST_EVOLVED.write_text(f"{time.time():.0f} {sessions} {datetime.now().isoformat()}\n", encoding="utf-8")
    except OSError:
        pass


def should_run() -> bool:
    if os.environ.get("JARVIS_EVOLVE", "1") != "1":
        return False
    age_h = (time.time() - _last_run_ts()) / 3600.0
    if age_h >= RUN_INTERVAL_HOURS:
        return True
    sessions = _count_sessions()
    return (sessions - _last_run_sessions()) >= RUN_AFTER_SESSIONS


def _load_recent_sessions(limit: int = EVOLVE_WINDOW_SESSIONS) -> list[dict]:
    if not FEEDBACK_DIR.exists():
        return []
    files = sorted(FEEDBACK_DIR.glob("session_*.json"))[-limit:]
    out = []
    for p in files:
        try:
            with p.open() as f:
                out.append(json.load(f))
        except (json.JSONDecodeError, OSError):
            continue
    return out


def _build_prompt() -> str:
    personality = _read_text(PERSONALITY_FILE)
    profile = _read_json(PROFILE_FILE, {})
    sessions = _load_recent_sessions()
    fixes = _read_json(ASSISTANT_DIR / "autopsies" / "fixes.json", {})

    parts: list[str] = [
        "You are a prompt engineer analyzing an AI voice assistant's "
        "performance. Propose SPECIFIC, TIGHT edits to the personality "
        "prompt that would fix recurring failures while preserving what "
        "works. Output is a JSON array — no commentary, no markdown fences.",
        "",
        "Each edit must look like:",
        '  {"section": "<heading text or path>",',
        '   "action": "add" | "modify" | "remove",',
        '   "content": "<full new content for add/modify,'
        ' or brief deletion target for remove>",',
        '   "rationale": "<one sentence — what failure this fixes>"}',
        "",
        "Rules:",
        "- Maximum 5 edits per pass. Quality over volume.",
        "- Don't rewrite the document. Surgical changes only.",
        "- Don't propose anything Watson would have to argue down.",
        "- If the data shows the prompt is already working, return [].",
        "",
        "## Current personality.md",
        "```markdown",
        personality.rstrip(),
        "```",
        "",
        "## Behavior aggregate (profile.json)",
        json.dumps(profile, indent=2),
        "",
        "## Last sessions of raw signals",
        json.dumps(sessions, indent=2)[:6000],
        "",
        "## Top failure types (fixes.json)",
        json.dumps(fixes.get("by_type", {}) if isinstance(fixes, dict) else {}, indent=2),
    ]
    return "\n".join(parts)


# ── Edit application ────────────────────────────────────────────────
def _apply_edits(personality: str, edits: list[dict]) -> tuple[str, list[str]]:
    """Apply edit objects to the personality text. Returns (new_text,
    notes_for_record). Best-effort — unknown sections become "add" at
    end of file with the section header included."""
    text = personality
    notes: list[str] = []
    for e in edits:
        if not isinstance(e, dict):
            notes.append(f"skipped non-dict edit: {e!r}")
            continue
        action = (e.get("action") or "").lower()
        section = (e.get("section") or "").strip()
        content = (e.get("content") or "").strip()
        rationale = (e.get("rationale") or "").strip()

        if action == "add":
            block = f"\n\n### {section}\n\n{content}\n" if section else f"\n\n{content}\n"
            text = text.rstrip() + block
            notes.append(f"ADD section={section!r}: {rationale or 'no rationale'}")
        elif action == "modify":
            # Find heading "section" (case-sensitive substring) and
            # replace the paragraph below it. Coarse but safe — we leave
            # the original prefix untouched if the heading isn't found
            # and append the new content as a follow-up bullet.
            idx = text.find(section)
            if idx >= 0:
                # Replace from end of the heading line to next heading
                line_end = text.find("\n", idx)
                if line_end == -1:
                    line_end = len(text)
                # Find the next heading (## or ###) after this one
                next_heading = -1
                for marker in ("\n## ", "\n### "):
                    j = text.find(marker, line_end)
                    if j != -1 and (next_heading == -1 or j < next_heading):
                        next_heading = j
                end = next_heading if next_heading != -1 else len(text)
                text = text[:line_end + 1] + "\n" + content.rstrip() + "\n\n" + text[end:].lstrip("\n")
                notes.append(f"MODIFY section={section!r}: {rationale or 'no rationale'}")
            else:
                # Section not found — append as a new addition
                text = text.rstrip() + f"\n\n### {section}\n\n{content}\n"
                notes.append(f"MODIFY (section not found, appended) section={section!r}: {rationale or 'no rationale'}")
        elif action == "remove":
            target = content or section
            if target and target in text:
                text = text.replace(target, "")
                notes.append(f"REMOVE target={target!r}: {rationale or 'no rationale'}")
            else:
                notes.append(f"REMOVE skipped (target not found): {target!r}")
        else:
            notes.append(f"unknown action: {action!r}")
    return text, notes


def _write_pending_record(edits: list[dict], notes: list[str], draft_text: str) -> Path | None:
    try:
        EVOLUTION_DIR.mkdir(parents=True, exist_ok=True)
        ts = int(time.time())
        path = EVOLUTION_DIR / f"pending_{ts}.md"
        body = [f"# Pending evolution proposal — {datetime.now().isoformat(timespec='seconds')}", ""]
        body.append("## Proposed edits")
        body.append("")
        body.append("```json")
        body.append(json.dumps(edits, indent=2, ensure_ascii=False))
        body.append("```")
        body.append("")
        body.append("## Application notes")
        for n in notes:
            body.append(f"- {n}")
        body.append("")
        body.append("## Approve / reject")
        body.append("- `bin/jarvis-evolve.py --approve` to accept this draft")
        body.append("- `bin/jarvis-evolve.py --reject \"reason\"` to discard it")
        body.append("")
        body.append("## Draft (full new personality.md)")
        body.append("")
        body.append("```markdown")
        body.append(draft_text)
        body.append("```")
        path.write_text("\n".join(body), encoding="utf-8")
        return path
    except OSError as e:
        sys.stderr.write(f"jarvis-evolve: pending record write failed ({e})\n")
        return None


def _latest_pending() -> Path | None:
    if not EVOLUTION_DIR.exists():
        return None
    pending = sorted(EVOLUTION_DIR.glob("pending_*.md"))
    return pending[-1] if pending else None


def _archive_draft(target_dir: Path, reason: str = "") -> Path | None:
    """Move the pending draft + record into target_dir (applied/ or rejected/)."""
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        moved: list[str] = []
        if DRAFT_FILE.exists():
            shutil.move(str(DRAFT_FILE), target_dir / f"personality.{int(time.time())}.md")
            moved.append("draft")
        latest = _latest_pending()
        if latest is not None:
            shutil.move(str(latest), target_dir / latest.name)
            moved.append("pending record")
        if reason:
            (target_dir / f"reason_{int(time.time())}.txt").write_text(reason + "\n", encoding="utf-8")
        return target_dir
    except OSError as e:
        sys.stderr.write(f"jarvis-evolve: archive failed ({e})\n")
        return None


# ── Sonnet call + edit pipeline ──────────────────────────────────────
def run(force: bool = False) -> dict | None:
    if not force and not should_run():
        return None
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        sys.stderr.write("jarvis-evolve: ANTHROPIC_API_KEY not set\n")
        return None

    if not PERSONALITY_FILE.exists():
        sys.stderr.write(f"jarvis-evolve: {PERSONALITY_FILE} missing\n")
        return None

    prompt = _build_prompt()
    body = {
        "model": EVOLVE_MODEL,
        "max_tokens": EVOLVE_MAX_TOKENS,
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
            resp = json.loads(r.read())
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        sys.stderr.write(f"jarvis-evolve: API error {e}\n")
        return None

    text_blocks = resp.get("content") or []
    text = "".join(b.get("text", "") for b in text_blocks if b.get("type") == "text").strip()
    if not text:
        return None
    if text.startswith("```"):
        text = text.split("\n", 1)[-1]
        if text.endswith("```"):
            text = text.rsplit("```", 1)[0]
        text = text.strip()
    try:
        edits = json.loads(text)
        if not isinstance(edits, list):
            raise ValueError("edits is not a list")
    except (json.JSONDecodeError, ValueError) as e:
        sys.stderr.write(f"jarvis-evolve: JSON parse failed ({e}); raw: {text[:200]!r}\n")
        return None

    if not edits:
        # Model said no edits needed. Bump the timestamp anyway so we
        # don't re-call until the next interval.
        _record_run(_count_sessions())
        return {"edits": [], "applied": False, "reason": "no edits proposed"}

    personality = _read_text(PERSONALITY_FILE)
    new_text, notes = _apply_edits(personality, edits)

    try:
        DRAFT_FILE.parent.mkdir(parents=True, exist_ok=True)
        DRAFT_FILE.write_text(new_text, encoding="utf-8")
    except OSError as e:
        sys.stderr.write(f"jarvis-evolve: draft write failed ({e})\n")
        return None

    pending_path = _write_pending_record(edits, notes, new_text)
    _record_run(_count_sessions())
    return {
        "edits": edits,
        "draft": str(DRAFT_FILE),
        "pending": str(pending_path) if pending_path else None,
        "notes": notes,
        "applied": False,
    }


# ── Approve / reject (NEVER auto-apply) ──────────────────────────────
def approve() -> bool:
    """Promote the draft to live personality.md. Archives the prior live
    file under ~/.jarvis/evolution/applied/ for rollback."""
    if not DRAFT_FILE.exists():
        sys.stderr.write("jarvis-evolve: no draft to approve\n")
        return False
    try:
        APPLIED_DIR.mkdir(parents=True, exist_ok=True)
        if PERSONALITY_FILE.exists():
            backup = APPLIED_DIR / f"personality_pre_{int(time.time())}.md"
            shutil.copy(str(PERSONALITY_FILE), str(backup))
        shutil.move(str(DRAFT_FILE), str(PERSONALITY_FILE))
        latest = _latest_pending()
        if latest is not None:
            shutil.move(str(latest), APPLIED_DIR / latest.name)
        print(f"approved — personality.md updated; backup at {APPLIED_DIR}")
        return True
    except OSError as e:
        sys.stderr.write(f"jarvis-evolve: approve failed ({e})\n")
        return False


def reject(reason: str = "") -> bool:
    if not DRAFT_FILE.exists() and _latest_pending() is None:
        sys.stderr.write("jarvis-evolve: nothing pending to reject\n")
        return False
    archived = _archive_draft(REJECTED_DIR, reason=reason)
    if archived:
        print(f"rejected — archived to {archived}")
        return True
    return False


def has_pending() -> bool:
    return DRAFT_FILE.exists() and _latest_pending() is not None


def system_prompt_hint() -> str:
    """When a pending evolution exists, tell Claude to surface it on the
    next user turn. Caller (wake-listener) is the one that hears the
    user's yes/no — this just primes Claude to ask once."""
    if os.environ.get("JARVIS_EVOLVE", "1") != "1":
        return ""
    if not has_pending():
        return ""
    latest = _latest_pending()
    if latest is None:
        return ""
    return (
        "## Pending Self-Improvement\n\n"
        "I've drafted some suggested edits to my own personality based on "
        "recent sessions. On the NEXT user turn, naturally ask once: "
        "'I've been thinking about how I can communicate better — I have "
        "a few suggestions. Want to hear them?' If yes, summarize the "
        f"top edits from {latest.name} concisely and ask 'Should I apply "
        "them?' If yes again, the user will run `jarvis-evolve --approve`. "
        "If no at any step, drop it and don't bring it up again this turn."
    )


def _cli() -> int:
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        sys.stdout.write(__doc__ or "")
        return 0
    if args and args[0] == "--status":
        latest = _latest_pending()
        print(f"pending: {'yes' if has_pending() else 'no'}")
        print(f"draft: {DRAFT_FILE}  exists={DRAFT_FILE.exists()}")
        print(f"latest pending record: {latest if latest else '(none)'}")
        print(f"last_run_ts: {datetime.fromtimestamp(_last_run_ts()).isoformat() if _last_run_ts() else '(never)'}")
        print(f"sessions_at_last_run: {_last_run_sessions()}")
        print(f"sessions_now: {_count_sessions()}")
        return 0
    if args and args[0] == "--print":
        latest = _latest_pending()
        if not latest:
            print("(no pending evolution)")
            return 1
        print(latest.read_text())
        return 0
    if args and args[0] == "--approve":
        return 0 if approve() else 1
    if args and args[0] == "--reject":
        reason = " ".join(args[1:]).strip()
        return 0 if reject(reason) else 1
    if args and args[0] == "--reset":
        for p in (DRAFT_FILE, LAST_EVOLVED):
            try:
                p.unlink()
            except FileNotFoundError:
                pass
        for d in (EVOLUTION_DIR,):
            if d.exists():
                for f in d.glob("pending_*.md"):
                    f.unlink()
        print("evolve reset")
        return 0
    if args and args[0] == "--force":
        result = run(force=True)
        print(json.dumps(result, indent=2, default=str) if result else "(no run)")
        return 0
    if os.environ.get("JARVIS_EVOLVE", "1") != "1":
        return 0
    run(force=False)
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
