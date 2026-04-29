#!/usr/bin/env python3
"""Orchestrator — multi-step planning + execution for high-level goals.

When Watson says "close the deal with Corbin" or "prepare for my 2pm meeting",
the orchestrator decomposes the goal into a dependency graph of concrete tool
calls, executes them (parallelizing siblings), and returns a structured result
the voice layer summarizes naturally.

    from jarvis_orchestrate import execute_plan
    summary = execute_plan("prepare for my 2pm meeting")

The plan is produced by Claude Sonnet (one call). Execution then walks the
graph in dependency order: leaves first, fan-out to ThreadPoolExecutor for
sibling tasks. Each step's result is fed into downstream tasks via simple
{{step.id.field}} placeholders. After execution, one final Sonnet call
synthesizes a briefing-style summary.

Tools the planner can compose (kept tight on purpose — the orchestrator's
job is choreography, not surface-area):

    check_calendar     read upcoming events
    check_email        read recent inbox / threads
    recall             search Watson's memory
    search_contacts    look up a person via jarvis-recall
    web_search         single web query (jarvis-research)
    research_topic     multi-query deep research (jarvis-research)
    synthesize         Haiku call that combines prior step outputs into prose

The orchestrator does NOT do anything irreversible (no send_email, no
create_event, no delete_event). Those still go through the normal
jarvis-think tool-use loop with confirm-required semantics. The orchestrator
prepares context; Watson decides.

Gate: JARVIS_ORCHESTRATOR=1 (default 1).

Standalone CLI:
    bin/jarvis-orchestrate.py "prepare for my 2pm meeting"
"""
from __future__ import annotations

import concurrent.futures as cf
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
BIN_DIR = ASSISTANT_DIR / "bin"
LOG_DIR = ASSISTANT_DIR / "logs"
ORCH_LOG = LOG_DIR / "orchestrator.log"
ORCH_DIR = ASSISTANT_DIR / "orchestrator"
RUNS_DIR = ORCH_DIR / "runs"

LIB_DIR = ASSISTANT_DIR / "lib"


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


_ledger_mod = _load_ledger()


def _load_demo():
    src = LIB_DIR / "demo_data.py"
    if not src.exists():
        src = Path(__file__).parent.parent / "lib" / "demo_data.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("demo_data", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    except Exception:
        return None


_demo_mod = _load_demo()


PLANNER_MODEL = os.environ.get("JARVIS_ORCH_PLANNER_MODEL", "claude-sonnet-4-6")
SYNTH_MODEL = os.environ.get("JARVIS_ORCH_SYNTH_MODEL", "claude-sonnet-4-6")
MAX_TASKS = int(os.environ.get("JARVIS_ORCH_MAX_TASKS", "8"))
TASK_TIMEOUT_S = float(os.environ.get("JARVIS_ORCH_TASK_TIMEOUT_S", "30"))
PLAN_TIMEOUT_S = float(os.environ.get("JARVIS_ORCH_PLAN_TIMEOUT_S", "20"))
PARALLEL_WORKERS = int(os.environ.get("JARVIS_ORCH_WORKERS", "4"))


# ── Sibling module lazy loaders (mirrors jarvis-think's pattern) ──────
def _load_sibling(name: str):
    src = BIN_DIR / f"{name}.py"
    if not src.exists():
        src = Path(__file__).parent / f"{name}.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location(name.replace("-", "_"), src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    except Exception as e:
        sys.stderr.write(f"jarvis-orchestrate: load {name} failed ({e})\n")
        return None


_email_mod = None
_calendar_mod = None
_memory_mod = None
_research_mod = None


def _email():
    global _email_mod
    if _email_mod is None:
        _email_mod = _load_sibling("jarvis-email")
    return _email_mod


def _calendar():
    global _calendar_mod
    if _calendar_mod is None:
        _calendar_mod = _load_sibling("jarvis-calendar")
    return _calendar_mod


def _memory():
    global _memory_mod
    if _memory_mod is None:
        _memory_mod = _load_sibling("jarvis_memory")
    return _memory_mod


def _research():
    global _research_mod
    if _research_mod is None:
        _research_mod = _load_sibling("jarvis-research")
    return _research_mod


# ── Anthropic call (slim, blocking — one shot per planner/synth) ─────
def _anthropic_call(api_key: str, model: str, system: str,
                    user_text: str, max_tokens: int = 1500,
                    timeout: float = 30.0) -> str:
    """Single non-streaming Messages call. Returns the text content joined."""
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
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read())
            blocks = data.get("content") or []
            return "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(1 + attempt * 1.5)
                continue
            try:
                err = json.loads(e.read()).get("error", {}).get("message", str(e))
            except Exception:
                err = str(e)
            raise RuntimeError(f"API error {e.code}: {err}") from e
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last_err = e
            if attempt < 2:
                time.sleep(1 + attempt * 1.5)
                continue
            raise RuntimeError(f"network error: {e}") from e
    raise RuntimeError(f"unexpected: {last_err}")


# ── Tool registry — read-only / safe-by-construction tools only ──────
def _tool_check_calendar(args: dict) -> dict:
    mod = _calendar()
    if mod is None:
        return {"error": "jarvis-calendar not installed"}
    return mod.check_calendar(
        date=args.get("date"),
        days=int(args.get("days") or 1),
        calendar_id=args.get("calendar_id") or "primary",
    )


def _tool_check_email(args: dict) -> dict:
    mod = _email()
    if mod is None:
        return {"error": "jarvis-email not installed"}
    return mod.check_email(
        max_results=int(args.get("max_results") or 5),
        query=args.get("query") or "is:unread",
    )


def _tool_recall(args: dict) -> dict:
    mod = _memory()
    if mod is None:
        return {"error": "jarvis_memory not available"}
    mem = mod.Memory()
    query = args.get("query") or ""
    limit = int(args.get("limit") or 5)
    hits = mem.recall(query, limit=limit) if query else mem.recent(limit)
    return {
        "memories": [
            {"id": r["id"], "created_at": r["created_at"][:10], "text": r["text"]}
            for r in hits
        ],
        "count": len(hits),
    }


def _tool_search_contacts(args: dict) -> dict:
    query = (args.get("query") or "").strip()
    if not query:
        return {"error": "query is required"}
    recall_bin = BIN_DIR / "jarvis-recall"
    if not recall_bin.exists():
        return {"error": "jarvis-recall not installed", "query": query}
    try:
        result = subprocess.run(
            [str(recall_bin), "who", query],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            return {"error": (result.stderr or "lookup failed").strip()[:500]}
        return json.loads(result.stdout or "{}")
    except subprocess.TimeoutExpired:
        return {"error": "contact lookup timed out"}
    except json.JSONDecodeError:
        return {"error": "could not parse jarvis-recall output"}


def _contacts():
    """Lazy-load jarvis-contacts.py, mirror of _research()."""
    global _contacts_mod_cached  # type: ignore[name-defined]
    try:
        return _contacts_mod_cached  # type: ignore[name-defined]
    except NameError:
        pass
    src = BIN_DIR / "jarvis-contacts.py"
    if not src.exists():
        _contacts_mod_cached = None  # type: ignore[name-defined]
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_contacts", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _contacts_mod_cached = mod  # type: ignore[name-defined]
        return mod
    except Exception:
        _contacts_mod_cached = None  # type: ignore[name-defined]
        return None


def _tool_relationship_brief(args: dict) -> dict:
    mod = _contacts()
    if mod is None:
        return {"error": "jarvis-contacts not installed"}
    name = (args.get("name") or "").strip()
    if not name:
        return {"error": "name is required"}
    return mod.relationship_brief(name)


_network_mod_cached = None


def _network():
    global _network_mod_cached
    if _network_mod_cached is not None:
        return _network_mod_cached
    src = BIN_DIR / "jarvis-network.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-network.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_network_orch", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _network_mod_cached = mod
        return mod
    except Exception as e:
        sys.stderr.write(f"jarvis-orchestrate: network module load failed ({e})\n")
        return None


def _tool_network_search(args: dict) -> dict:
    mod = _network()
    if mod is None:
        return {"error": "jarvis-network not installed"}
    query = (args.get("query") or "").strip()
    if not query:
        return {"error": "query is required"}
    filters = args.get("filters") or {}
    if not isinstance(filters, dict):
        filters = {}
    return mod.network_search(query, filters=filters,
                              limit=int(args.get("limit") or 8))


def _tool_relationship_score(args: dict) -> dict:
    mod = _network()
    if mod is None:
        return {"error": "jarvis-network not installed"}
    name = (args.get("name") or "").strip()
    if not name:
        return {"error": "name is required"}
    return mod.relationship_score(name)


def _tool_network_suggest(args: dict) -> dict:
    mod = _network()
    if mod is None:
        return {"error": "jarvis-network not installed"}
    goal = (args.get("goal") or "").strip()
    if not goal:
        return {"error": "goal is required"}
    return mod.network_suggest(goal)


def _tool_web_search(args: dict) -> dict:
    mod = _research()
    if mod is None:
        return {"error": "jarvis-research not installed"}
    query = (args.get("query") or "").strip()
    if not query:
        return {"error": "query is required"}
    return mod.web_search(query)


def _tool_research_topic(args: dict) -> dict:
    mod = _research()
    if mod is None:
        return {"error": "jarvis-research not installed"}
    topic = (args.get("topic") or "").strip()
    if not topic:
        return {"error": "topic is required"}
    depth = args.get("depth") or "quick"
    return mod.research_topic(topic, depth=depth)


_commitments_mod_cached = None


def _commitments():
    global _commitments_mod_cached
    if _commitments_mod_cached is not None:
        return _commitments_mod_cached
    src = BIN_DIR / "jarvis-commitments.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-commitments.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_commitments_orch", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _commitments_mod_cached = mod
        return mod
    except Exception:
        return None


_apple_mod_cached = None


def _apple():
    global _apple_mod_cached
    if _apple_mod_cached is not None:
        return _apple_mod_cached
    src = BIN_DIR / "jarvis-apple.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-apple.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_apple_orch", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _apple_mod_cached = mod
        return mod
    except Exception:
        return None


def _tool_list_commitments(args: dict) -> dict:
    mod = _commitments()
    if mod is None:
        return {"error": "jarvis-commitments not installed"}
    return mod.list_commitments(
        status=args.get("status"),
        owner=args.get("owner"),
        related_contact=args.get("related_contact"),
        days_ahead=args.get("days_ahead"),
        limit=int(args.get("limit") or 50),
    )


def _tool_commitment_report(_args: dict) -> dict:
    mod = _commitments()
    if mod is None:
        return {"error": "jarvis-commitments not installed"}
    return mod.commitment_report()


def _tool_imessage_check(args: dict) -> dict:
    mod = _apple()
    if mod is None:
        return {"error": "jarvis-apple not installed"}
    return mod.imessage_check(hours=int(args.get("hours") or 24))


def _tool_imessage_read(args: dict) -> dict:
    mod = _apple()
    if mod is None:
        return {"error": "jarvis-apple not installed"}
    handle = (args.get("handle") or "").strip()
    if not handle:
        return {"error": "handle is required"}
    return mod.imessage_read(handle, limit=int(args.get("limit") or 20))


def _tool_apple_list_reminders(args: dict) -> dict:
    mod = _apple()
    if mod is None:
        return {"error": "jarvis-apple not installed"}
    return mod.apple_list_reminders(
        include_completed=bool(args.get("include_completed")),
        limit=int(args.get("limit") or 50),
    )


_stripe_mod_cached = None


def _stripe():
    global _stripe_mod_cached
    if _stripe_mod_cached is not None:
        return _stripe_mod_cached
    src = BIN_DIR / "jarvis-stripe.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-stripe.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_stripe_orch", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _stripe_mod_cached = mod
        return mod
    except Exception:
        return None


def _tool_stripe_dashboard(_args: dict) -> dict:
    mod = _stripe()
    if mod is None:
        return {"error": "jarvis-stripe not installed"}
    return mod.stripe_dashboard()


def _tool_stripe_customer(args: dict) -> dict:
    mod = _stripe()
    if mod is None:
        return {"error": "jarvis-stripe not installed"}
    needle = (args.get("name_or_email") or args.get("query") or "").strip()
    if not needle:
        return {"error": "name_or_email is required"}
    return mod.stripe_customer(needle)


def _tool_synthesize(args: dict) -> dict:
    """Cheap Haiku call that combines prior outputs into a short prose
    block. The planner uses this as the final 'roll up the briefing'
    step. Inputs are the resolved {{step.X}} placeholders the executor
    has already substituted into args['inputs']."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {"error": "ANTHROPIC_API_KEY not set"}
    instruction = (args.get("instruction") or "Synthesize the inputs.").strip()
    inputs = args.get("inputs") or ""
    if isinstance(inputs, (dict, list)):
        inputs_text = json.dumps(inputs, ensure_ascii=False, indent=2)
    else:
        inputs_text = str(inputs)
    prompt = (
        f"{instruction}\n\nInputs:\n{inputs_text}\n\n"
        "Return a tight prose block, suitable to be read aloud. "
        "No bullet lists unless the structure genuinely helps. "
        "British-butler register, lead with what matters."
    )
    try:
        text = _anthropic_call(
            api_key, "claude-haiku-4-5-20251001",
            system="", user_text=prompt, max_tokens=600, timeout=20,
        )
    except Exception as e:
        return {"error": f"synthesize failed: {e}"}
    return {"text": text}


TOOLS: dict[str, Callable[[dict], dict]] = {
    "check_calendar": _tool_check_calendar,
    "check_email": _tool_check_email,
    "recall": _tool_recall,
    "search_contacts": _tool_search_contacts,
    "relationship_brief": _tool_relationship_brief,
    "network_search": _tool_network_search,
    "relationship_score": _tool_relationship_score,
    "network_suggest": _tool_network_suggest,
    "list_commitments": _tool_list_commitments,
    "commitment_report": _tool_commitment_report,
    "imessage_check": _tool_imessage_check,
    "imessage_read": _tool_imessage_read,
    "apple_list_reminders": _tool_apple_list_reminders,
    "stripe_dashboard": _tool_stripe_dashboard,
    "stripe_customer": _tool_stripe_customer,
    "web_search": _tool_web_search,
    "research_topic": _tool_research_topic,
    "synthesize": _tool_synthesize,
}


# ── Planner ──────────────────────────────────────────────────────────
PLANNER_SYSTEM = """You are JARVIS's task planner. Watson gives you a
high-level goal; you produce a concrete dependency graph of tool calls
that, when executed, will give Watson everything he needs.

You return ONLY a single JSON object — no prose, no code fences:

{
  "rationale": "one short sentence on why this plan",
  "tasks": [
    {
      "id": "t1",
      "tool": "<tool_name>",
      "args": { ... },
      "depends_on": []
    },
    ...
  ]
}

Rules:
- Each task has a unique `id` (t1, t2, ...).
- `depends_on` is a list of task ids whose outputs this task needs.
- To pipe a previous task's output into args, use placeholders:
    "{{t1.events}}"          → the events array from t1's result
    "{{t1.events[0].summary}}"→ a specific path
    "{{t1}}"                 → the entire result dict
  The executor substitutes these AFTER the dependency runs.
- Tasks with no shared dependencies run in parallel automatically.
- The LAST task should almost always be a `synthesize` step that rolls
  the prior outputs into one prose briefing.
- Do NOT plan irreversible actions (no send_email, create_event,
  delete_event). The orchestrator only PREPARES context; Watson confirms
  any irreversible action himself afterwards.
- Keep plans tight: 2–6 tasks is typical. Hard cap: 8 tasks.

Tools available:

- check_calendar(date?, days?) — list events. date defaults to today.
- check_email(query?, max_results?) — Gmail search. Default "is:unread".
- recall(query, limit?) — search Watson's memory store.
- search_contacts(query) — look up a person (Apple Contacts + Messages).
- relationship_brief(name) — Watson's curated relationship memory: brief, last interaction, talking points, open threads. Use when a meeting attendee is named — strictly better than search_contacts for prep.
- network_search(query, filters?, limit?) — semantic search across Watson's network for skills / expertise / intro paths. Use when the goal needs "who do we know who can do X". Filters: {trust:[...], tag:[...], min_strength:0..1, recent_within_days:N}.
- relationship_score(name) — deep per-relationship analysis: strength, trajectory, responsiveness, suggested next action with channel + timing. Use over relationship_brief when the goal is "what's the play with X" rather than "who is X".
- network_suggest(goal) — Sonnet-backed planner for "who should I leverage to do X": picks primary + supporting contacts, suggests intro paths, sequences the approach. Heavier than network_search; use when the goal explicitly asks for a play.
- list_commitments(status?, owner?, related_contact?, days_ahead?) — Watson's tracked commitments. Use whenever a goal needs "what does Watson owe X", "what's due before the meeting", or "what's overdue".
- commitment_report() — overdue / due-today / due-this-week summary; cheap, no API call. Lead with this in any "what's on my plate" plan.
- imessage_check(hours?) — recent inbound iMessages grouped by handle. Use for prep when Watson's about to talk to someone he texts.
- imessage_read(handle, limit?) — message history with one handle, oldest→newest. Use when context for a reply matters.
- apple_list_reminders(include_completed?) — pending reminders in the 'Jarvis' list. Pair with list_commitments when the goal touches reminders the iPhone might already hold.
- stripe_dashboard() — MRR / new subs / 30d trend / churn / outstanding invoices. Reach for this in any "close the deal", "wrap up the day on revenue", or "prep for X customer" plan.
- stripe_customer(name_or_email) — single-customer deep dive: subscriptions, payments, refunds, lifetime value, reliability. Pair with relationship_brief when prepping for a meeting with a paying customer.
- web_search(query) — single search query, summarized.
- research_topic(topic, depth?) — multi-query deep research. depth: "quick"|"thorough".
- synthesize(instruction, inputs) — Haiku-summarize the prior outputs into prose.

Examples:

Goal: "prepare for my 2pm meeting"
{
  "rationale": "Pull meeting context, attendee relationship brief, and recent threads, then synthesize.",
  "tasks": [
    {"id":"t1","tool":"check_calendar","args":{"date":"today","days":1},"depends_on":[]},
    {"id":"t2","tool":"relationship_brief","args":{"name":"{{t1.events[0].attendees[0]}}"},"depends_on":["t1"]},
    {"id":"t3","tool":"check_email","args":{"query":"newer_than:7d {{t1.events[0].summary}}","max_results":5},"depends_on":["t1"]},
    {"id":"t4","tool":"synthesize","args":{
        "instruction":"Brief Watson on his next meeting. Lead with who is there (use the relationship brief), then open threads with them, then 2-3 talking points.",
        "inputs":{"meeting":"{{t1}}","attendee":"{{t2}}","recent_email":"{{t3}}"}},
      "depends_on":["t1","t2","t3"]}
  ]
}

Goal: "research Acme Corp before my call"
{
  "rationale": "Deep web research on the company plus any prior context.",
  "tasks": [
    {"id":"t1","tool":"research_topic","args":{"topic":"Acme Corp company background, recent news, leadership","depth":"thorough"},"depends_on":[]},
    {"id":"t2","tool":"recall","args":{"query":"Acme Corp"},"depends_on":[]},
    {"id":"t3","tool":"synthesize","args":{
        "instruction":"Brief Watson on Acme Corp before his call. Cover: what they do, recent news, who's relevant.",
        "inputs":{"web":"{{t1}}","memory":"{{t2}}"}},
      "depends_on":["t1","t2"]}
  ]
}

Goal: "close the Forge deal"
{
  "rationale": "Pull Watson's network plan for the deal, recent thread state, and synthesize.",
  "tasks": [
    {"id":"t1","tool":"network_suggest","args":{"goal":"close the Forge deal"},"depends_on":[]},
    {"id":"t2","tool":"check_email","args":{"query":"Forge","max_results":5},"depends_on":[]},
    {"id":"t3","tool":"synthesize","args":{
        "instruction":"Roll the network plan and recent emails into a play: lead with primary contact + approach, then open threads, then sequence.",
        "inputs":{"play":"{{t1}}","email":"{{t2}}"}},
      "depends_on":["t1","t2"]}
  ]
}

Goal: "I need a React engineer for the rewrite"
{
  "rationale": "Network search for matching skills, then suggest the approach.",
  "tasks": [
    {"id":"t1","tool":"network_search","args":{"query":"react frontend engineer","filters":{"min_strength":0.3}},"depends_on":[]},
    {"id":"t2","tool":"network_suggest","args":{"goal":"hire a React engineer for the rewrite"},"depends_on":[]},
    {"id":"t3","tool":"synthesize","args":{
        "instruction":"Brief Watson on candidates and the play. Lead with the strongest contacts, then the suggested sequence.",
        "inputs":{"candidates":"{{t1}}","plan":"{{t2}}"}},
      "depends_on":["t1","t2"]}
  ]
}
"""


def _extract_first_json(text: str) -> dict | None:
    """Pull the first balanced { ... } block out of a model response.
    Handles models that sneak code fences or commentary in despite instructions."""
    if not text:
        return None
    # Strip code fences if present
    fence = re.search(r"```(?:json)?\s*\n(.+?)\n```", text, re.DOTALL)
    if fence:
        candidate = fence.group(1)
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass
    # Find the first balanced JSON object
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def plan(goal: str, api_key: str) -> dict:
    """Ask Sonnet for a task graph. Returns {rationale, tasks} or
    {error}. Validates structure before returning so a malformed plan
    never makes it to execution."""
    if not goal.strip():
        return {"error": "empty goal"}
    try:
        raw = _anthropic_call(
            api_key, PLANNER_MODEL, PLANNER_SYSTEM, goal,
            max_tokens=1500, timeout=PLAN_TIMEOUT_S,
        )
    except Exception as e:
        return {"error": f"planner call failed: {e}"}

    parsed = _extract_first_json(raw)
    if not parsed:
        return {"error": "planner did not return JSON", "raw": raw[:500]}

    tasks = parsed.get("tasks") or []
    if not isinstance(tasks, list) or not tasks:
        return {"error": "plan has no tasks", "raw": raw[:500]}
    if len(tasks) > MAX_TASKS:
        return {"error": f"plan exceeds max tasks ({len(tasks)} > {MAX_TASKS})"}

    seen_ids: set[str] = set()
    for t in tasks:
        if not isinstance(t, dict):
            return {"error": "task is not an object"}
        tid = t.get("id")
        tool = t.get("tool")
        if not tid or not tool:
            return {"error": "task missing id or tool"}
        if tid in seen_ids:
            return {"error": f"duplicate task id: {tid}"}
        seen_ids.add(tid)
        if tool not in TOOLS:
            return {"error": f"unknown tool: {tool}"}
        deps = t.get("depends_on") or []
        if not isinstance(deps, list):
            return {"error": f"task {tid}: depends_on must be a list"}
        for d in deps:
            if d not in seen_ids and d != tid:
                # Forward references are illegal — we declare in topological-ish
                # order; a dep must already have been seen.
                return {"error": f"task {tid}: forward dependency {d}"}
        t.setdefault("args", {})
        t.setdefault("depends_on", [])

    return {
        "rationale": parsed.get("rationale", ""),
        "tasks": tasks,
        "raw": raw,
    }


# ── Placeholder substitution ────────────────────────────────────────
_PLACEHOLDER_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)((?:\.[a-zA-Z0-9_]+|\[\d+\])*)\s*\}\}")


def _resolve_path(value: Any, path: str) -> Any:
    """Walk a dotted/indexed path on a value. Missing keys → None."""
    if not path:
        return value
    cur = value
    for part in re.findall(r"\.([a-zA-Z0-9_]+)|\[(\d+)\]", path):
        attr, idx = part
        if attr:
            if isinstance(cur, dict):
                cur = cur.get(attr)
            else:
                return None
        elif idx:
            try:
                cur = cur[int(idx)]
            except (IndexError, TypeError, KeyError):
                return None
        if cur is None:
            return None
    return cur


def _substitute(args: Any, results: dict[str, Any]) -> Any:
    """Recursively replace {{tid.path}} references with actual values from
    completed task results. Whole-value substitution (`"{{t1}}"`) preserves
    the underlying type; embedded substitution (`"summary: {{t1.foo}}"`)
    coerces to string."""
    if isinstance(args, str):
        # Whole-string single placeholder → preserve type
        whole = _PLACEHOLDER_RE.fullmatch(args.strip())
        if whole:
            tid, path = whole.group(1), whole.group(2)
            val = results.get(tid)
            if val is None:
                return None
            return _resolve_path(val, path)

        def _replace(m: re.Match) -> str:
            tid, path = m.group(1), m.group(2)
            val = results.get(tid)
            resolved = _resolve_path(val, path) if val is not None else None
            if resolved is None:
                return ""
            if isinstance(resolved, (dict, list)):
                return json.dumps(resolved, ensure_ascii=False)
            return str(resolved)

        return _PLACEHOLDER_RE.sub(_replace, args)

    if isinstance(args, list):
        return [_substitute(a, results) for a in args]
    if isinstance(args, dict):
        return {k: _substitute(v, results) for k, v in args.items()}
    return args


# ── Executor ────────────────────────────────────────────────────────
def _run_one(task: dict, results: dict[str, Any]) -> tuple[str, dict, float]:
    """Execute a single task. Returns (id, result, duration_s)."""
    tid = task["id"]
    tool = task["tool"]
    raw_args = task.get("args") or {}
    args = _substitute(raw_args, results)
    start = time.monotonic()

    # Demo mode short-circuit. `synthesize` is special — even in demo mode
    # it runs the real Haiku call, because the whole point of the demo
    # is showing the model rolling up the (mock) inputs into prose.
    if (_demo_mod is not None and _demo_mod.is_demo() and tool != "synthesize"
            and isinstance(args, dict)):
        mock = _demo_mod.demo_dispatch(tool, args)
        if mock is not None:
            return tid, mock, time.monotonic() - start

    handler = TOOLS.get(tool)
    if handler is None:
        return tid, {"error": f"unknown tool: {tool}"}, 0.0
    try:
        result = handler(args if isinstance(args, dict) else {"_args": args})
    except Exception as e:
        result = {"error": f"{tool} raised: {e}"}
    return tid, result, time.monotonic() - start


def execute(plan_obj: dict) -> dict:
    """Walk the dependency graph. Tasks with no remaining unmet deps run
    in parallel via ThreadPoolExecutor. Returns a structured run record."""
    tasks = plan_obj.get("tasks") or []
    by_id = {t["id"]: t for t in tasks}
    pending: set[str] = set(by_id.keys())
    completed: set[str] = set()
    results: dict[str, Any] = {}
    timings: dict[str, float] = {}
    errors: list[str] = []

    deadline = time.monotonic() + TASK_TIMEOUT_S * max(1, len(tasks))

    while pending:
        if time.monotonic() > deadline:
            errors.append("overall execution deadline exceeded")
            break

        ready = [tid for tid in pending
                 if all(d in completed for d in by_id[tid].get("depends_on", []))]
        if not ready:
            unmet = {tid: by_id[tid].get("depends_on", []) for tid in pending}
            errors.append(f"deadlock — no ready tasks; pending deps: {unmet}")
            break

        with cf.ThreadPoolExecutor(max_workers=min(PARALLEL_WORKERS, len(ready))) as pool:
            futures = {pool.submit(_run_one, by_id[tid], results): tid for tid in ready}
            for fut in cf.as_completed(futures, timeout=TASK_TIMEOUT_S):
                tid = futures[fut]
                try:
                    rid, result, dur = fut.result(timeout=1.0)
                except Exception as e:
                    rid, result, dur = tid, {"error": f"task crashed: {e}"}, 0.0
                results[rid] = result
                timings[rid] = round(dur, 3)
                completed.add(rid)
                pending.discard(rid)
                if isinstance(result, dict) and result.get("error"):
                    errors.append(f"{rid}: {result['error']}")

    final_id = tasks[-1]["id"] if tasks else None
    final = results.get(final_id) if final_id else None
    final_text = ""
    if isinstance(final, dict) and isinstance(final.get("text"), str):
        final_text = final["text"]

    return {
        "ok": not errors,
        "final_text": final_text,
        "tasks_completed": len(completed),
        "tasks_total": len(tasks),
        "timings": timings,
        "errors": errors,
        "results": results,
    }


def _log_run(goal: str, plan_obj: dict, run: dict) -> Path | None:
    try:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().strftime("%Y%m%dT%H%M%S")
        path = RUNS_DIR / f"{ts}.json"
        record = {
            "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
            "goal": goal,
            "rationale": plan_obj.get("rationale", ""),
            "plan": plan_obj.get("tasks") or [],
            "run": {k: v for k, v in run.items() if k != "results"},
            "ok": run.get("ok", False),
            "final_text": run.get("final_text", ""),
        }
        path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")

        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with ORCH_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps({
                "ts": record["ts"],
                "goal": goal,
                "ok": run.get("ok", False),
                "tasks": run.get("tasks_total", 0),
                "errors": run.get("errors", []),
                "duration_total_s": round(sum(run.get("timings", {}).values()), 3),
            }, ensure_ascii=False) + "\n")
        return path
    except Exception:
        return None


# ── Public entrypoint ───────────────────────────────────────────────
def execute_plan(goal: str) -> dict:
    """End-to-end: plan(goal) → execute → structured summary.

    Returns:
        {
          "ok": bool,
          "summary": <string suitable to be read aloud>,
          "rationale": <planner's one-liner>,
          "tasks": [{id, tool, ok, duration_s}],
          "errors": [...],
          "run_path": "/path/to/run.json" or None,
        }
    """
    if os.environ.get("JARVIS_ORCHESTRATOR", "1") != "1":
        return {"ok": False, "summary": "", "errors": ["orchestrator disabled (JARVIS_ORCHESTRATOR=0)"]}

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {"ok": False, "summary": "", "errors": ["ANTHROPIC_API_KEY not set"]}

    plan_obj = plan(goal, api_key)
    if plan_obj.get("error"):
        return {"ok": False, "summary": "", "errors": [plan_obj["error"]]}

    run = execute(plan_obj)
    run_path = _log_run(goal, plan_obj, run)

    summary = run.get("final_text") or ""
    if not summary and run.get("ok"):
        summary = f"Plan completed: {len(plan_obj.get('tasks', []))} tasks ran cleanly."
    if not summary and not run.get("ok"):
        summary = "I ran the plan but hit issues, sir. " + "; ".join(run.get("errors", [])[:2])

    task_summary = []
    for t in plan_obj.get("tasks") or []:
        tid = t["id"]
        result = run.get("results", {}).get(tid) or {}
        task_summary.append({
            "id": tid,
            "tool": t["tool"],
            "ok": isinstance(result, dict) and not result.get("error"),
            "duration_s": run.get("timings", {}).get(tid, 0.0),
        })

    final = {
        "ok": run.get("ok", False),
        "summary": summary,
        "rationale": plan_obj.get("rationale", ""),
        "tasks": task_summary,
        "errors": run.get("errors", []),
        "run_path": str(run_path) if run_path else None,
    }

    # Ledger: one record per execute_plan with the full task graph summary so
    # reconciliation can attribute orchestrator drift to specific sub-tools.
    if _ledger_mod is not None:
        try:
            total_ms = int(sum(
                float(v) for v in (run.get("timings") or {}).values()
                if isinstance(v, (int, float))
            ) * 1000)
            _ledger_mod.emit(
                cap="orchestrator",
                action="execute_plan",
                status="success" if final["ok"] else "failed",
                latency_ms=total_ms,
                context={
                    "goal": goal[:200],
                    "task_count": len(task_summary),
                    "tools": [t["tool"] for t in task_summary],
                    "failed_task_ids": [t["id"] for t in task_summary if not t["ok"]],
                    "run_path": final["run_path"],
                },
            )
        except Exception:
            pass

    return final


# ── Stats / metacognition hook for jarvis-improve ───────────────────
STATS_FILE = ORCH_DIR / "stats.json"
MIN_RUNS_FOR_HINT = int(os.environ.get("JARVIS_ORCH_MIN_RUNS_FOR_HINT", "5"))
LOW_OK_RATE_THRESHOLD = float(os.environ.get("JARVIS_ORCH_LOW_OK_THRESHOLD", "0.7"))


def stats(window: int = 50) -> dict:
    """Read the last `window` run records and return a lightweight metric
    block. Consumed by jarvis-improve so orchestrator success rate makes
    it into the metacognition tracking."""
    if not RUNS_DIR.exists():
        return {"runs": 0, "ok_rate": 0.0, "avg_tasks": 0.0, "avg_duration_s": 0.0}
    files = sorted(RUNS_DIR.glob("*.json"))[-window:]
    runs = 0
    ok_count = 0
    total_tasks = 0
    total_duration = 0.0
    common_failures: dict[str, int] = {}
    for p in files:
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        runs += 1
        if rec.get("ok"):
            ok_count += 1
        else:
            for err in (rec.get("run") or {}).get("errors") or []:
                # Bucket on the leading error fragment so "t3: web_search timeout"
                # and "t1: web_search timeout" cluster.
                key = re.sub(r"^t\d+:\s*", "", str(err)).strip()[:80]
                if key:
                    common_failures[key] = common_failures.get(key, 0) + 1
        run = rec.get("run") or {}
        total_tasks += int(run.get("tasks_total") or 0)
        timings = run.get("timings") or {}
        if isinstance(timings, dict):
            total_duration += sum(float(v) for v in timings.values() if isinstance(v, (int, float)))
    top_failures = sorted(common_failures.items(), key=lambda kv: -kv[1])[:3]
    return {
        "runs": runs,
        "ok_rate": round(ok_count / runs, 3) if runs else 0.0,
        "avg_tasks": round(total_tasks / runs, 2) if runs else 0.0,
        "avg_duration_s": round(total_duration / runs, 2) if runs else 0.0,
        "top_failures": [{"error": e, "count": n} for e, n in top_failures],
    }


def update() -> dict:
    """Compute current stats and persist them to disk. Called by
    jarvis-improve. Returns the same dict that gets written so the daemon
    can log a one-liner. Safe to call frequently — pure file I/O."""
    s = stats()
    s["updated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    try:
        ORCH_DIR.mkdir(parents=True, exist_ok=True)
        STATS_FILE.write_text(
            json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8",
        )
    except Exception as e:
        sys.stderr.write(f"jarvis-orchestrate: stats write failed ({e})\n")
    return s


def system_prompt_hint() -> str:
    """Behavioral hint for jarvis-think's system prompt when the
    orchestrator has been failing recently. Empty when fewer than
    MIN_RUNS_FOR_HINT runs are available, or when ok_rate is healthy.
    Mirrors jarvis-metacog's hook."""
    if not STATS_FILE.exists():
        return ""
    try:
        s = json.loads(STATS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return ""
    runs = int(s.get("runs") or 0)
    if runs < MIN_RUNS_FOR_HINT:
        return ""
    ok_rate = float(s.get("ok_rate") or 0.0)
    if ok_rate >= LOW_OK_RATE_THRESHOLD:
        return ""
    bits = [
        f"## Orchestrator confidence",
        f"Recent multi-step plans have a {int(ok_rate * 100)}% success rate "
        f"over the last {runs} runs. Prefer direct atomic tools when the goal "
        "is crisp; reach for `execute_plan` only when decomposition is genuinely "
        "needed. If a plan fails, fall back to chaining tools yourself rather "
        "than retrying the same goal.",
    ]
    failures = s.get("top_failures") or []
    if failures:
        bits.append("Common failure modes recently: " +
                    "; ".join(f"\"{f['error']}\" ×{f['count']}" for f in failures[:3]) + ".")
    return "\n".join(bits)


# ── CLI ─────────────────────────────────────────────────────────────
def _cli() -> int:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        sys.stdout.write(__doc__ or "")
        return 0
    if args[0] == "--stats":
        print(json.dumps(stats(), indent=2))
        return 0
    if args[0] == "--update":
        # Daemon entry — recompute + persist stats. Quiet on success.
        s = update()
        print(json.dumps(s, indent=2))
        return 0
    if args[0] == "--hint":
        # Debug print of the system prompt hint
        print(system_prompt_hint() or "(no hint — ok_rate is healthy or runs < threshold)")
        return 0
    if args[0] == "--plan":
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if not api_key:
            print("ANTHROPIC_API_KEY not set", file=sys.stderr)
            return 1
        goal = " ".join(args[1:])
        print(json.dumps(plan(goal, api_key), indent=2))
        return 0
    goal = " ".join(args)
    result = execute_plan(goal)
    print(json.dumps(result, indent=2, default=str))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(_cli())
