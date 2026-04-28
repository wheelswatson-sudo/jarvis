#!/usr/bin/env python3
"""Skill acquisition — codify multi-step workflows so Jarvis can replay them.

A "skill" is a JSON record under ~/.jarvis/skills/<slug>.json:

    {
      "slug": "prep_for_a_meeting",
      "trigger": "prep for a meeting",
      "trigger_aliases": ["prep my next meeting", "meeting prep"],
      "description": "...natural-language description of the workflow...",
      "steps": [
        {"action": "check_calendar", "params": {"days": 1}},
        {"action": "check_email",    "params": {"query": "from:{attendees}"}},
        {"action": "recall",         "params": {"query": "{attendees}"}}
      ],
      "output": "spoken brief: attendees, agenda, last interaction notes",
      "learned_from": "conversation_<ts>",
      "uses": 0,
      "confirmed_first_use": false
    }

Detection — two paths:

  1. User-explicit teach. If the latest user turn matches:
        "from now on when i say X, do Y..."
        "teach you a skill"
        "remember this workflow as X"
     extract_from_conversation() pulls the trigger phrase + the steps the
     assistant listed in the prior assistant turn.

  2. Assistant-volunteered. If the assistant turn contains a numbered
     list of steps AND the user said "yes" or "save that" right after,
     same extraction.

Execution — match() compares an incoming user query to known triggers
(>=0.6 word overlap or alias hit) and returns the skill record. The
caller (jarvis-think.py via tool or post-processing) decides whether to
follow the steps. First-use safety: if confirmed_first_use is False, the
caller MUST ask the user to confirm before executing — same pattern as
send_email's confirm flag.

Outputs:
    ~/.jarvis/skills/<slug>.json   one per skill
    ~/.jarvis/skills/index.json    cached lookup (slug → trigger map)

system_prompt_hint() lists available skills so Claude knows what's there.

Usage:
    bin/jarvis-skills.py list                        list known skills
    bin/jarvis-skills.py inspect <slug>              show one
    bin/jarvis-skills.py forget  <slug>              delete one
    bin/jarvis-skills.py learn                       scan history + auto-add

Gate: JARVIS_SKILL_LEARN (default 1).
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
HISTORY_FILE = ASSISTANT_DIR / "cache" / "conversation.json"
SKILLS_DIR = ASSISTANT_DIR / "skills"
INDEX_FILE = SKILLS_DIR / "index.json"
LAST_PROCESSED = SKILLS_DIR / "last_processed.json"

# Detection patterns
TEACH_PATTERNS = [
    re.compile(r"from now on,?\s+when (?:i|you) (?:say|hear) [\"']?(?P<trigger>[^\"']+?)[\"']?,?\s+(?:do|run|execute|please|i want you to)", re.I),
    re.compile(r"(?:remember|save) this (?:as a |as )?(?:skill|workflow|routine)(?: called)? [\"']?(?P<trigger>[^\"']+?)[\"']?", re.I),
    re.compile(r"(?:teach you|learn) (?:a |the )?(?:skill|workflow|routine)(?: called)? [\"']?(?P<trigger>[^\"']+?)[\"']?", re.I),
    re.compile(r"call (?:that|this) [\"']?(?P<trigger>[^\"']+?)[\"']?", re.I),
]
APPROVAL_PATTERNS = re.compile(
    r"^\s*(yes|yeah|yep|save (?:that|it)|do it|sounds good|that works|"
    r"perfect|exactly|let'?s do (?:that|it))\b", re.I,
)
# Step extraction — numbered or bulleted items, often with a verb
STEP_LINE_RE = re.compile(
    r"^\s*(?:\d+\.|-|\*|•)\s*(.+?)\s*$", re.M,
)


def _slugify(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")
    return s[:60] or "skill"


def _word_overlap(a: str, b: str) -> float:
    aw = set(re.findall(r"[a-z0-9']+", (a or "").lower()))
    bw = set(re.findall(r"[a-z0-9']+", (b or "").lower()))
    if not aw or not bw:
        return 0.0
    return len(aw & bw) / max(len(aw), len(bw))


# ── Storage ─────────────────────────────────────────────────────────
def _list_skill_files() -> list[Path]:
    if not SKILLS_DIR.exists():
        return []
    return sorted(p for p in SKILLS_DIR.glob("*.json") if p.name != "index.json")


def list_skills() -> list[dict]:
    out = []
    for p in _list_skill_files():
        try:
            with p.open() as f:
                d = json.load(f)
            if isinstance(d, dict):
                out.append(d)
        except (json.JSONDecodeError, OSError):
            pass
    return out


def save_skill(skill: dict) -> Path | None:
    slug = skill.get("slug")
    if not slug:
        return None
    try:
        SKILLS_DIR.mkdir(parents=True, exist_ok=True)
        path = SKILLS_DIR / f"{slug}.json"
        with path.open("w", encoding="utf-8") as f:
            json.dump(skill, f, indent=2, ensure_ascii=False)
        _rebuild_index()
        return path
    except OSError:
        return None


def _rebuild_index() -> None:
    try:
        SKILLS_DIR.mkdir(parents=True, exist_ok=True)
        idx = {s["slug"]: {"trigger": s.get("trigger", ""),
                           "aliases": s.get("trigger_aliases", []),
                           "uses": s.get("uses", 0)}
               for s in list_skills() if "slug" in s}
        with INDEX_FILE.open("w", encoding="utf-8") as f:
            json.dump(idx, f, indent=2, ensure_ascii=False)
    except OSError:
        pass


def forget(slug: str) -> bool:
    path = SKILLS_DIR / f"{slug}.json"
    try:
        path.unlink()
        _rebuild_index()
        return True
    except FileNotFoundError:
        return False


# ── Step extraction from text ───────────────────────────────────────
# Map verbs to canonical tool actions. Rough; the goal is "what kind of
# operation is this," not "exact tool args."
VERB_TO_ACTION = [
    (re.compile(r"\bcheck (?:my )?(?:email|inbox|messages)\b", re.I), "check_email"),
    (re.compile(r"\b(?:read|reply|respond) (?:to )?(?:that |the )?email\b", re.I), "reply_email"),
    (re.compile(r"\bdraft (?:an? )?email\b", re.I), "draft_email"),
    (re.compile(r"\bsend (?:an? |the )?email\b", re.I), "send_email"),
    (re.compile(r"\b(?:check|look at|read) (?:my )?calendar\b", re.I), "check_calendar"),
    (re.compile(r"\b(?:create|schedule|book|add) (?:an? )?(?:event|meeting)\b", re.I), "create_event"),
    (re.compile(r"\b(?:cancel|delete) (?:an? |the )?(?:event|meeting)\b", re.I), "delete_event"),
    (re.compile(r"\b(?:remember|save|note)\b", re.I), "remember"),
    (re.compile(r"\b(?:recall|search memory|look up)\b", re.I), "recall"),
    (re.compile(r"\b(?:set a? ?timer|countdown)\b", re.I), "set_timer"),
    (re.compile(r"\b(?:remind|reminder)\b", re.I), "set_reminder"),
    (re.compile(r"\b(?:find|search) (?:contact|person)\b", re.I), "search_contacts"),
    (re.compile(r"\bwhat'?s? the time|current time\b", re.I), "get_time"),
    (re.compile(r"\bwhat'?s? the date|today'?s date\b", re.I), "get_date"),
]


def _extract_steps(text: str) -> list[dict]:
    """Return [{action, description}, ...] from a numbered/bulleted list."""
    steps: list[dict] = []
    matches = STEP_LINE_RE.findall(text or "")
    for line in matches:
        action = None
        for regex, name in VERB_TO_ACTION:
            if regex.search(line):
                action = name
                break
        steps.append({"action": action or "freeform",
                      "description": line.strip()[:200]})
    return steps


# ── Detection from history ──────────────────────────────────────────
def _load_history_messages() -> list[dict]:
    if not HISTORY_FILE.exists():
        return []
    try:
        with HISTORY_FILE.open() as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return []
    if isinstance(data, dict):
        return list(data.get("messages") or [])
    return list(data) if isinstance(data, list) else []


def _load_checkpoint() -> int:
    if not LAST_PROCESSED.exists():
        return -1
    try:
        with LAST_PROCESSED.open() as f:
            return int(json.load(f).get("idx", -1))
    except (json.JSONDecodeError, OSError, ValueError):
        return -1


def _save_checkpoint(idx: int) -> None:
    try:
        SKILLS_DIR.mkdir(parents=True, exist_ok=True)
        with LAST_PROCESSED.open("w", encoding="utf-8") as f:
            json.dump({"idx": idx, "ts": datetime.now().isoformat()}, f)
    except OSError:
        pass


def extract_from_conversation(messages: list[dict] | None = None) -> list[dict]:
    """Walk the conversation looking for explicit teach moments and
    save any new skills. Returns the new skill records added."""
    if messages is None:
        messages = _load_history_messages()
    last = _load_checkpoint()
    new_skills: list[dict] = []

    for i, m in enumerate(messages):
        if i <= last or m.get("role") != "user":
            continue
        content = m.get("content")
        if not isinstance(content, str):
            continue

        # Path 1: explicit teach phrase
        trigger = None
        for pat in TEACH_PATTERNS:
            mm = pat.search(content)
            if mm:
                trigger = mm.group("trigger").strip()
                break

        # Path 2: approval right after an assistant numbered list
        if not trigger and APPROVAL_PATTERNS.match(content):
            # Look back for an assistant turn with a numbered list
            for j in range(i - 1, max(-1, i - 4), -1):
                prev = messages[j]
                if prev.get("role") != "assistant":
                    continue
                ptext = prev.get("content") if isinstance(prev.get("content"), str) else ""
                if ptext and len(STEP_LINE_RE.findall(ptext)) >= 2:
                    # The user approved a list. Pull the trigger from the
                    # earlier user turn that asked the question — first
                    # ~6 words is a good slug source.
                    for k in range(j - 1, -1, -1):
                        ask = messages[k]
                        if ask.get("role") == "user" and isinstance(ask.get("content"), str):
                            words = ask["content"].split()
                            trigger = " ".join(words[:6]).strip().rstrip("?.!,")
                            break
                    break

        if not trigger:
            continue

        # Find the assistant turn that holds the steps — the one before
        # this user approval / the one right after the teach phrase.
        steps_source: str | None = None
        for j in range(i - 1, max(-1, i - 4), -1):
            prev = messages[j]
            if prev.get("role") == "assistant" and isinstance(prev.get("content"), str):
                steps_source = prev["content"]
                break
        if not steps_source:
            continue
        steps = _extract_steps(steps_source)
        if len(steps) < 2:
            continue

        slug = _slugify(trigger)
        if (SKILLS_DIR / f"{slug}.json").exists():
            # Update use count or skip — for now: skip, don't overwrite
            continue

        skill = {
            "slug": slug,
            "trigger": trigger,
            "trigger_aliases": [],
            "description": steps_source[:300].strip(),
            "steps": steps,
            "output": "natural language summary of step results",
            "learned_from": f"conversation_{int(time.time())}",
            "uses": 0,
            "confirmed_first_use": False,
            "created": datetime.now().isoformat(timespec="seconds"),
        }
        if save_skill(skill):
            new_skills.append(skill)

    _save_checkpoint(len(messages) - 1)
    return new_skills


# ── Match an incoming query to a learned skill ──────────────────────
def match(user_text: str, threshold: float = 0.6) -> dict | None:
    if os.environ.get("JARVIS_SKILL_LEARN", "1") != "1":
        return None
    if not user_text:
        return None
    best: tuple[float, dict] | None = None
    for skill in list_skills():
        candidates = [skill.get("trigger", "")] + (skill.get("trigger_aliases") or [])
        for c in candidates:
            score = _word_overlap(user_text, c)
            if score < threshold:
                continue
            if best is None or score > best[0]:
                best = (score, skill)
    return best[1] if best else None


def record_use(slug: str, confirmed: bool = False) -> None:
    """Increment uses counter and (optionally) mark the first use as
    confirmed. Caller invokes this after the skill has actually run."""
    path = SKILLS_DIR / f"{slug}.json"
    try:
        with path.open() as f:
            s = json.load(f)
        s["uses"] = int(s.get("uses", 0)) + 1
        if confirmed:
            s["confirmed_first_use"] = True
        s["last_used"] = datetime.now().isoformat(timespec="seconds")
        with path.open("w", encoding="utf-8") as f:
            json.dump(s, f, indent=2, ensure_ascii=False)
    except (json.JSONDecodeError, OSError):
        pass


# ── System prompt hint ──────────────────────────────────────────────
def system_prompt_hint() -> str:
    if os.environ.get("JARVIS_SKILL_LEARN", "1") != "1":
        return ""
    skills = list_skills()
    if not skills:
        return ""
    lines = ["## Learned Skills"]
    lines.append(
        "These are workflows you've learned from Watson. When a user "
        "request matches one (>=60% word overlap with the trigger), you "
        "may run its steps in sequence rather than re-reasoning from "
        "scratch. On a skill's FIRST use (confirmed_first_use=false), "
        "ASK Watson to confirm before executing — read back the steps "
        "and require a clear yes."
    )
    for s in skills[:10]:
        steps = s.get("steps") or []
        confirmed = "✓" if s.get("confirmed_first_use") else "✗ first-use"
        lines.append(
            f"- **{s.get('slug')}** [{confirmed}] — trigger: '{s.get('trigger')}', "
            f"{len(steps)} steps, used {s.get('uses', 0)}×"
        )
    return "\n".join(lines).strip()


def _cli() -> int:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        sys.stdout.write(__doc__ or "")
        return 0
    if args[0] == "list":
        skills = list_skills()
        if not skills:
            print("(no skills yet)")
        for s in skills:
            print(f"{s.get('slug'):30s}  trigger={s.get('trigger')!r:50s}  uses={s.get('uses',0)}")
        return 0
    if args[0] == "inspect" and len(args) > 1:
        path = SKILLS_DIR / f"{args[1]}.json"
        if not path.exists():
            print(f"unknown skill: {args[1]}")
            return 1
        print(path.read_text())
        return 0
    if args[0] == "forget" and len(args) > 1:
        ok = forget(args[1])
        print("forgotten" if ok else "not found")
        return 0 if ok else 1
    if args[0] == "learn":
        added = extract_from_conversation()
        print(f"added {len(added)} skill(s)")
        for s in added:
            print(f"  {s.get('slug')} ← {s.get('trigger')!r}")
        return 0
    if args[0] == "match" and len(args) > 1:
        m = match(args[1])
        print(json.dumps(m or {"matched": False}, indent=2))
        return 0
    if args[0] == "--reset":
        for p in _list_skill_files():
            p.unlink()
        for p in (INDEX_FILE, LAST_PROCESSED):
            try:
                p.unlink()
            except FileNotFoundError:
                pass
        print("skills reset")
        return 0
    sys.stderr.write(f"unknown command: {args[0]}\n")
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
