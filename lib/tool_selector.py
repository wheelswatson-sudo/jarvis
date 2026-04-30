#!/usr/bin/env python3
"""Tool selector — pick the relevant subset of tools for one user turn.

Sending all 80 tool schemas on every turn is the single biggest cost wedge
in the brain (~20K tokens of definitions before the conversation even starts).
Most turns only need 1-2 capability groups. This module classifies the user
text into capability groups via keyword + context signals and returns the
tool subset to load.

Designed for safe rollout:
  - Always-include core tools (execute_plan, get_briefing, web_search,
    recall, remember, read_memory_file) so the model never loses orchestration.
  - Conservative fallback: any sign of ambiguity → return the full toolset.
  - Caller-side retry on miss: if the model says "I don't have a tool for
    that", retry with the full set. So worst case we do one wasted call;
    typical case we save 60–80% of tool tokens.

Public API:
    select_tools(user_text, all_tool_schemas, *, history_messages=None,
                 max_tools=15, ledger_module=None) -> SelectionResult

SelectionResult fields:
    selected_names    list[str]   tool names to send to the API
    tokens_full       int         estimated tokens if we sent everything
    tokens_selected   int         estimated tokens after filtering
    matched_groups    list[str]   capability groups that fired
    fallback          bool        True → we punted to the full set
    reason            str         short human-readable trace
"""
from __future__ import annotations

import json
import os
import re

# ── Capability groups ─────────────────────────────────────────────────
# Keep in sync with TOOL_CAPABILITY_MAP in jarvis-think.py. Groups here are
# what the *user request* maps to, which is more granular than the ledger's
# health-rollup categories (e.g. trello + commitments are separate groups
# even though they both report under `commitments` for health).
TOOL_GROUPS: dict[str, set[str]] = {
    # Communication is split by channel so the common case ("draft an email")
    # only loads 4 email tools instead of all 12. The "messaging" pseudo-group
    # below is a union for ambiguous "send a message" phrasings.
    "email": {"draft_email", "send_email", "check_email", "reply_email"},
    "telegram": {
        "send_telegram", "check_telegram", "telegram_digest", "telegram_search",
    },
    "imessage": {
        "imessage_send", "imessage_read", "imessage_check",
        "imessage_search_contacts",
    },
    "calendar": {
        "check_calendar", "create_event", "update_event", "delete_event",
        "meeting_prep", "meeting_prep_settings",
    },
    "research": {"web_search", "research_topic"},
    "finance": {
        "stripe_dashboard", "stripe_customers", "stripe_customer",
        "stripe_revenue", "stripe_alerts",
    },
    "contacts": {
        "lookup_contact", "relationship_brief", "enrich_contact",
        "search_contacts", "apple_contacts_search",
    },
    "network": {
        "network_search", "network_map", "relationship_score",
        "network_suggest", "enrich_network", "network_alerts",
    },
    "social": {
        "check_social", "social_digest", "social_reply", "social_post",
        "social_search",
    },
    "linkedin": {
        "linkedin_enrich", "linkedin_sync", "linkedin_monitor",
        "linkedin_changes", "linkedin_search",
    },
    "tasks": {
        "extract_commitments", "add_commitment", "list_commitments",
        "complete_commitment", "commitment_report",
    },
    "trello": {"trello_sync", "trello_boards", "trello_add", "trello_move"},
    "apple": {
        "apple_add_reminder", "apple_list_reminders", "apple_complete_reminder",
        "apple_save_note", "apple_read_note",
    },
    "workflows": {
        "create_workflow", "list_workflows", "run_workflow",
        "update_workflow", "delete_workflow",
    },
    "system": {"run_command", "set_timer", "set_reminder"},
    "style": {"style_apply", "style_status"},
    "notifications": {
        "check_notifications", "dismiss_notification", "notification_preferences",
    },
    "memory_extra": {"remember", "recall", "read_memory_file"},
    "clock": {"get_time", "get_date"},
}

# Bridge ledger capability buckets back to selector groups so we can mine
# recent ledger entries for context. (The ledger uses the rollup names from
# TOOL_CAPABILITY_MAP; we map each back to one or more selector groups.)
LEDGER_CAP_TO_GROUP: dict[str, str] = {
    "email": "email",
    "telegram": "telegram",
    "messaging": "imessage",
    "calendar": "calendar",
    "meeting_prep": "calendar",
    "research": "research",
    "stripe": "finance",
    "contacts": "contacts",
    "network": "network",
    "social": "social",
    "commitments": "tasks",
    "apple": "apple",
    "workflows": "workflows",
    "notifications": "notifications",
    "style": "style",
    "memory": "memory_extra",
    "timer": "system",
    "shell": "system",
    "clock": "clock",
}

# Tools that are cheap and broadly useful — always loaded. Kept tight so
# we leave room under max_tools for the matched groups.
ALWAYS_INCLUDE: set[str] = {
    "execute_plan",   # orchestrator — escalation hatch
    "get_briefing",   # zero-arg, often fits the answer outright
    "web_search",     # single most-used tool, tiny schema
}

# Keyword triggers per group. Order matters: longer / more-specific phrases
# first so we don't mis-fire (e.g. "remind me in 5 minutes" → system, not
# the bare "remember" → memory_extra).
GROUP_KEYWORDS: dict[str, list[str]] = {
    "email": [
        "email", "inbox", "gmail", "draft a", "draft an", "draft the",
        "reply to", "compose", "send him an", "send her an", "send them an",
    ],
    "telegram": ["telegram", " tg ", "telegram chat", "telegram group"],
    "imessage": [
        "imessage", "i-message", "text message", "send a text",
        "send him a text", "send her a text", "send them a text",
        " sms ", "shoot a text",
    ],
    "calendar": [
        "calendar", "schedule", "meeting", "appointment", "event",
        "agenda", "free time", "busy", "availability", "prep for",
        "prep me for", "what's on my calendar", "what's my day",
        "next meeting", "this morning", "this afternoon", "tomorrow",
    ],
    "research": [
        "research", "look up", "find out", "google", "news",
        "search the web", "search online", "what's the latest",
        "what is the latest", "background on",
    ],
    "finance": [
        "revenue", "stripe", "payment", "subscription", "mrr",
        " arr ", "income", "sales", "billing", "refund", "churn",
        "paying customer", "how's revenue", "customer count",
    ],
    "contacts": [
        "who is", "who's ", "contact", "phone number", "email of",
        "contact info", "look up the contact", "find the contact",
    ],
    "network": [
        "network", "introduce", "intro to", "warm intro", "mutual",
        "who knows", "who in my network",
    ],
    "social": [
        "twitter", "x.com", "tweet", "social media", "instagram",
        "engagement", "mentions", "social post", "reply to the post",
        "reply to the tweet",
    ],
    "linkedin": [
        "linkedin", " li post", " li dm", "professional network",
        "connection request",
    ],
    "tasks": [
        "commitment", "promised", "follow up", "follow-up", "deadline",
        "todo", "to do", "outstanding", "i owe", "what do i owe",
    ],
    "trello": ["trello", "kanban", "board card", "card on the board"],
    "apple": [
        "reminder", "apple notes", "apple reminders",
        "save a note", "read the note", "make a note",
    ],
    "workflows": [
        "workflow", "automation", "automate", "recurring", "every morning",
        "every monday", "every day at", "schedule this",
    ],
    "system": [
        "timer", "set a timer", "alarm", "remind me in", "remind me at",
        "remind me tomorrow", "shell", "run the command",
    ],
    "style": ["voice match", "match the style", "tone", "style guide"],
    "notifications": [
        "notification", "alert me", "ping me", "notify me",
    ],
    "memory_extra": [
        "remember that", "do you remember", "what do you know about",
        "what do you remember", "memory of", "recall ",
    ],
    "clock": [
        "what time", "what's the time", "what is the time", "what day",
        "today's date", "what's the date", "what is the date",
    ],
}

# Cross-group "compound intent" hints — phrases that imply multiple groups.
# Example: "prep for my meeting with John" needs calendar + contacts + network.
COMPOUND_HINTS: list[tuple[str, list[str]]] = [
    ("prep for my meeting", ["calendar", "contacts", "network"]),
    ("prep me for", ["calendar", "contacts", "network"]),
    ("meeting with", ["calendar", "contacts"]),
    ("call with", ["calendar", "contacts"]),
    ("morning brief", ["calendar", "email", "tasks"]),
    ("daily brief", ["calendar", "email", "tasks"]),
    ("status report", ["finance", "tasks", "calendar"]),
    ("how am i doing", ["finance", "tasks", "calendar"]),
    # Generic "send a message / dm / reach out" — could be any channel, so
    # pull all three so the model picks the right one.
    ("send a message", ["email", "telegram", "imessage"]),
    ("send him a message", ["email", "telegram", "imessage"]),
    ("send her a message", ["email", "telegram", "imessage"]),
    ("reach out to", ["email", "telegram", "imessage", "contacts"]),
    (" dm ", ["telegram", "imessage", "social"]),
]


# Plain class instead of @dataclass: spec_from_file_location loaders skip
# registering the module in sys.modules before exec, which @dataclass needs
# under Python 3.14 (it resolves forward-ref annotations via __module__
# lookup). A plain __init__ avoids the issue and keeps the public surface
# identical.
class SelectionResult:
    __slots__ = (
        "selected_names", "tokens_full", "tokens_selected",
        "matched_groups", "fallback", "reason",
    )

    def __init__(
        self,
        selected_names: list[str],
        tokens_full: int,
        tokens_selected: int,
        matched_groups: list[str] | None = None,
        fallback: bool = False,
        reason: str = "",
    ) -> None:
        self.selected_names = selected_names
        self.tokens_full = tokens_full
        self.tokens_selected = tokens_selected
        self.matched_groups = matched_groups if matched_groups is not None else []
        self.fallback = fallback
        self.reason = reason

    @property
    def tokens_saved(self) -> int:
        return max(0, self.tokens_full - self.tokens_selected)

    def to_dict(self) -> dict:
        return {
            "selected": self.selected_names,
            "selected_count": len(self.selected_names),
            "matched_groups": self.matched_groups,
            "fallback": self.fallback,
            "tokens_full": self.tokens_full,
            "tokens_selected": self.tokens_selected,
            "tokens_saved": self.tokens_saved,
            "reason": self.reason,
        }


def estimate_tool_tokens(schema: dict) -> int:
    """Rough char-to-token estimate (1 token ≈ 4 chars). Cheap, no tokenizer
    dependency. Off by ±15% in practice but plenty good for savings logging."""
    try:
        s = json.dumps(schema, ensure_ascii=False)
    except Exception:
        s = str(schema)
    return max(1, len(s) // 4)


def estimate_tools_total(schemas: list[dict]) -> int:
    return sum(estimate_tool_tokens(s) for s in schemas)


def _normalize(text: str) -> str:
    return " " + (text or "").lower().strip() + " "


def _match_groups_by_keywords(text: str) -> tuple[set[str], list[str]]:
    """Scan `text` for keyword triggers. Returns (matched_groups, hits) where
    hits is the list of (group, phrase) pairs that fired — handy for tracing."""
    norm = _normalize(text)
    matched: set[str] = set()
    hits: list[str] = []
    for group, phrases in GROUP_KEYWORDS.items():
        for p in phrases:
            if p in norm:
                matched.add(group)
                hits.append(f"{group}:{p.strip()}")
                break  # one hit per group is enough
    for phrase, groups in COMPOUND_HINTS:
        if phrase in norm:
            for g in groups:
                matched.add(g)
            hits.append(f"compound:{phrase}")
    return matched, hits


def _recent_ledger_groups(ledger_module, lookback_minutes: int = 5) -> set[str]:
    """Read the last few ledger entries to find capability groups recently
    active. Used to keep related tools loaded across a multi-turn thread
    (e.g. user is mid-email; the next turn should keep email tools warm)."""
    if ledger_module is None:
        return set()
    try:
        rows = ledger_module.query(hours=lookback_minutes / 60.0, limit=10)
    except Exception:
        return set()
    out: set[str] = set()
    for r in rows:
        cap = r.get("cap")
        g = LEDGER_CAP_TO_GROUP.get(cap or "")
        if g:
            out.add(g)
    return out


def _resolve_tools(groups: set[str], available_names: set[str]) -> set[str]:
    """Expand groups to tool names, keeping only tools that actually exist."""
    out: set[str] = set()
    for g in groups:
        for tool in TOOL_GROUPS.get(g, ()):
            if tool in available_names:
                out.add(tool)
    return out


# Heuristics for "this turn is too ambiguous, send everything." These are
# intentionally cautious — false positives just mean we send all tools (no
# correctness loss; we miss the savings on this one turn).
_AMBIGUOUS_PATTERNS = [
    re.compile(r"^\s*(go|continue|keep going|do it|yes|sure|please)\s*[.!?]?\s*$",
               re.IGNORECASE),
    re.compile(r"\b(everything|all of it|whatever|figure it out|you decide)\b",
               re.IGNORECASE),
    re.compile(r"\b(brainstorm|think through|ponder|explore options)\b",
               re.IGNORECASE),
]


def _looks_ambiguous(text: str) -> bool:
    if not text or len(text.strip()) < 4:
        return True
    return any(p.search(text) for p in _AMBIGUOUS_PATTERNS)


def select_tools(
    user_text: str,
    all_tool_schemas: list[dict],
    *,
    history_messages: list[dict] | None = None,
    max_tools: int = 20,
    ledger_module=None,
) -> SelectionResult:
    """Pick a subset of tools to load for this turn.

    Conservative-by-default: ambiguous user text or zero matched groups →
    fall back to the full toolset. Confidence rises with the number of
    distinct keyword hits and the presence of compound-intent phrases.

    Args:
        user_text: the user's message this turn.
        all_tool_schemas: every tool schema (the `tools` array we'd otherwise
            send). Each must have a "name" key.
        history_messages: optional list of {"role", "content"} dicts; if
            provided, the previous assistant turn is scanned for context.
        max_tools: cap on selected tools (excluding always-include). If we
            blow past this we fall back to the full set.
        ledger_module: optional already-loaded outcome_ledger module; if
            provided, recent capability rows boost continuity.
    """
    # Index of available tool names (we should never select a tool the
    # caller didn't pass us).
    available_names = {s.get("name") for s in all_tool_schemas if s.get("name")}
    full_tokens = estimate_tools_total(all_tool_schemas)

    # Ambiguous turn → send everything. Cheaper than retrying.
    if _looks_ambiguous(user_text):
        return SelectionResult(
            selected_names=sorted(available_names),
            tokens_full=full_tokens,
            tokens_selected=full_tokens,
            matched_groups=[],
            fallback=True,
            reason="ambiguous user text",
        )

    matched, hits = _match_groups_by_keywords(user_text)

    # Pull in recently-active groups (continuity) — counted as soft hints,
    # not enough on their own to override fallback.
    recent_groups = _recent_ledger_groups(ledger_module)
    if recent_groups:
        matched.update(recent_groups)
        hits.append(f"recent:{','.join(sorted(recent_groups))}")

    # Also scan the previous assistant turn for capability hints (helps with
    # follow-ups like "draft it" after Jarvis just summarized an email).
    prev_assistant = ""
    if history_messages:
        for m in reversed(history_messages):
            if m.get("role") == "assistant" and isinstance(m.get("content"), str):
                prev_assistant = m["content"][:500]
                break
    if prev_assistant:
        prev_matched, prev_hits = _match_groups_by_keywords(prev_assistant)
        if prev_matched:
            matched.update(prev_matched)
            hits.append(f"prev:{','.join(sorted(prev_matched))}")

    # Zero matched groups → ambiguous-by-coverage. Fall back rather than
    # gamble on always-include alone.
    if not matched:
        return SelectionResult(
            selected_names=sorted(available_names),
            tokens_full=full_tokens,
            tokens_selected=full_tokens,
            matched_groups=[],
            fallback=True,
            reason="no group keywords matched",
        )

    selected = set(ALWAYS_INCLUDE) & available_names
    selected |= _resolve_tools(matched, available_names)

    # Hard cap. If we somehow ballooned past max_tools, fall back to full
    # rather than try to rank-truncate (truncation risks dropping the
    # actually-needed tool).
    if len(selected) > max_tools:
        return SelectionResult(
            selected_names=sorted(available_names),
            tokens_full=full_tokens,
            tokens_selected=full_tokens,
            matched_groups=sorted(matched),
            fallback=True,
            reason=f"selection {len(selected)} > max {max_tools}",
        )

    selected_schemas = [s for s in all_tool_schemas if s.get("name") in selected]
    return SelectionResult(
        selected_names=sorted(selected),
        tokens_full=full_tokens,
        tokens_selected=estimate_tools_total(selected_schemas),
        matched_groups=sorted(matched),
        fallback=False,
        reason="; ".join(hits[:6]) if hits else "matched",
    )


# Sentinel phrases the model emits when it wanted a tool we didn't load.
# Used by the caller to decide whether to retry with the full toolset.
_MISS_PATTERNS = [
    re.compile(r"\bi (don'?t|do not) have (a |the )?tool\b", re.IGNORECASE),
    re.compile(r"\bno tool (is |)available\b", re.IGNORECASE),
    re.compile(r"\bunable to (find|access) (a |the )?tool\b", re.IGNORECASE),
    re.compile(r"\bi (cannot|can'?t) (do that|access|reach|check)\b.*\btool\b",
               re.IGNORECASE),
    re.compile(r"\b(no|missing) capability for\b", re.IGNORECASE),
]


def looks_like_tool_miss(text: str) -> bool:
    """Heuristic: did the model whiff because it lacked a tool? Used by the
    caller to trigger a retry with the full toolset. Conservative — only
    catches the obvious phrasings; subtle whiffs get caught the next turn
    via continuity (recent_groups) instead."""
    if not text:
        return False
    return any(p.search(text) for p in _MISS_PATTERNS)


# ── CLI for quick manual checks ───────────────────────────────────────
def _cli(argv: list[str]) -> int:
    """Usage: tool_selector.py "user message" [tool_name1 tool_name2 ...]

    With no tool names, simulates against a stub toolset built from
    TOOL_GROUPS + ALWAYS_INCLUDE (so you can see what *would* be selected
    without depending on jarvis-think being importable)."""
    if len(argv) < 2:
        print("usage: tool_selector.py <user text> [tool_name ...]", file=__import__("sys").stderr)
        return 2
    user_text = argv[1]
    tool_names = argv[2:] if len(argv) > 2 else None
    if not tool_names:
        names: set[str] = set(ALWAYS_INCLUDE)
        for s in TOOL_GROUPS.values():
            names |= s
        tool_names = sorted(names)
    schemas = [
        {"name": n, "description": f"stub for {n}",
         "input_schema": {"type": "object", "properties": {}}}
        for n in tool_names
    ]
    res = select_tools(user_text, schemas)
    print(json.dumps(res.to_dict(), indent=2))
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(_cli(sys.argv))
