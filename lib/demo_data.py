"""
JARVIS demo-mode fixtures.

Activated by `JARVIS_DEMO=1`. Tools that would otherwise hit external
APIs route through `demo_dispatch(tool_name, args)` and return realistic
mock payloads instead of crashing. Existence test: `is_demo()`.

Design:
- The dispatch table keys mirror the tool names in jarvis-think.py's
  TOOLS dict and jarvis-orchestrate.py's TOOLS dict — same name → same
  shape, so callers don't branch.
- Returns None for tools that don't need mocking (memory, clock, timers,
  shell, workflows). The caller falls through to the real handler.
- Anything that returns prose embeds a today/tomorrow stamp via
  _today_iso() / _tomorrow_iso() so the demo keeps feeling current
  weeks from now.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any, Callable


def is_demo() -> bool:
    return os.environ.get("JARVIS_DEMO", "").strip() == "1"


# ── time helpers ──────────────────────────────────────────────────────
def _now() -> datetime:
    return datetime.now().astimezone()

def _today_iso() -> str:
    return _now().strftime("%Y-%m-%d")

def _tomorrow_iso() -> str:
    return (_now() + timedelta(days=1)).strftime("%Y-%m-%d")

def _at(hour: int, minute: int = 0) -> str:
    """ISO timestamp for HH:MM today, in local TZ. Used for mock events
    so the briefing reads as 'today 9 AM' not a stale fixture date."""
    return _now().replace(hour=hour, minute=minute, second=0, microsecond=0).isoformat(timespec="seconds")


# ── calendar ──────────────────────────────────────────────────────────
def mock_calendar() -> dict:
    """3 events for today: an investor pitch, a 1:1, an internal review."""
    return {
        "ok": True,
        "events": [
            {
                "id": "evt_demo_001",
                "summary": "Pitch — Sequoia (Series A intro)",
                "start": _at(10, 0),
                "end": _at(11, 0),
                "attendees": ["roelof@sequoiacap.com", "watson@jarvis.ai"],
                "location": "Zoom",
                "description": "30-min intro; Roelof saw the LinkedIn post on EA latency.",
            },
            {
                "id": "evt_demo_002",
                "summary": "1:1 with Karina",
                "start": _at(13, 30),
                "end": _at(14, 0),
                "attendees": ["karina@jarvis.ai"],
                "location": "Office",
                "description": "Weekly check-in. She wanted to talk about hiring.",
            },
            {
                "id": "evt_demo_003",
                "summary": "Demo dry-run for May 1",
                "start": _at(16, 0),
                "end": _at(17, 0),
                "attendees": ["watson@jarvis.ai", "dalton@jarvis.ai"],
                "location": "Office",
                "description": "Run through the orchestrator + briefing demo end to end.",
            },
        ],
    }


def mock_create_event(args: dict) -> dict:
    return {
        "ok": True,
        "demo": True,
        "id": "evt_demo_new",
        "summary": args.get("summary", "(untitled)"),
        "start": args.get("start") or _at(15, 0),
        "note": "Demo mode — no event was actually created.",
    }


# ── email ─────────────────────────────────────────────────────────────
def _email_msg(frm: str, subject: str, snippet: str, hours_ago: int = 2,
               starred: bool = False) -> dict:
    ts = (_now() - timedelta(hours=hours_ago)).isoformat(timespec="seconds")
    return {
        "id": f"msg_demo_{abs(hash(subject)) % 10000:04d}",
        "thread_id": f"thr_demo_{abs(hash(frm)) % 10000:04d}",
        "from": frm,
        "subject": subject,
        "snippet": snippet,
        "date": ts,
        "starred": starred,
        "unread": True,
    }


def mock_email_inbox(query: str | None = None, max_results: int = 5) -> dict:
    """Realistic inbox: a hot lead, an investor reply, a customer fire,
    a vendor follow-up, a newsletter. Filtered loosely by query."""
    all_msgs = [
        _email_msg("Roelof Botha <roelof@sequoiacap.com>",
                   "Re: EA latency — 10am tomorrow?",
                   "Confirmed for 10. Bringing Pat. We'll want to dig into the Haiku cache numbers.",
                   hours_ago=1, starred=True),
        _email_msg("Dalton Caldwell <dalton@yc.com>",
                   "Demo Day prep — your pitch lands at 14:32",
                   "Nailed your dry-run. One ask: open with the latency demo, not the slides.",
                   hours_ago=3, starred=True),
        _email_msg("Karina Patel <karina@jarvis.ai>",
                   "Hiring — engineer #3 shortlist",
                   "Three candidates make it through. All ex-Stripe. Want my take by EOD?",
                   hours_ago=5),
        _email_msg("billing@stripe.com",
                   "Your subscription renewed — $2,400",
                   "Receipt attached. No action needed.",
                   hours_ago=8),
        _email_msg("noreply@linkedin.com",
                   "5 new people viewed your profile",
                   "Including someone at a16z. View them all.",
                   hours_ago=11),
        _email_msg("Customer <ops@acmehvac.com>",
                   "URGENT: Jarvis stopped responding to voice",
                   "Mic shows green but nothing happens after wake word. Production usage.",
                   hours_ago=2, starred=True),
    ]
    q = (query or "").lower()
    if "starred" in q:
        msgs = [m for m in all_msgs if m["starred"]]
    elif "unread" in q:
        msgs = all_msgs
    else:
        msgs = all_msgs
    msgs = msgs[:max_results]
    return {"ok": True, "messages": msgs, "query": query or "is:unread", "count": len(msgs)}


def mock_draft_email(args: dict) -> dict:
    return {
        "ok": True,
        "demo": True,
        "draft_id": "draft_demo_001",
        "to": args.get("to", "(unspecified)"),
        "subject": args.get("subject", "(no subject)"),
        "body_preview": (args.get("body") or "")[:200],
        "note": "Demo mode — draft saved to fixture, not Gmail.",
    }


def mock_send_email(args: dict) -> dict:
    return {
        "ok": True,
        "demo": True,
        "sent_id": "sent_demo_001",
        "to": args.get("to", "(unspecified)"),
        "subject": args.get("subject", "(no subject)"),
        "note": "Demo mode — email NOT actually sent.",
    }


# ── telegram ──────────────────────────────────────────────────────────
def mock_telegram_digest(hours: int = 12) -> dict:
    return {
        "ok": True,
        "hours": hours,
        "groups": [
            {
                "id": "grp_demo_founders",
                "name": "Founder Roundtable",
                "message_count": 14,
                "priority": "high",
                "urgent": True,
                "summary": "Big debate on whether to take the Sequoia term sheet. Three founders pinged you directly.",
                "action_items": [
                    "Reply to Marcus on his @ — he wants your read on the dilution math",
                    "Read Priya's GP-friction thread",
                ],
            },
            {
                "id": "grp_demo_jarvis",
                "name": "Jarvis Team",
                "message_count": 7,
                "priority": "normal",
                "urgent": False,
                "summary": "Karina shipped the streaming TTS fix. Dalton confirmed dry-run for tomorrow.",
                "action_items": [],
            },
            {
                "id": "grp_demo_yc",
                "name": "YC W26 Batch",
                "message_count": 22,
                "priority": "low",
                "urgent": False,
                "summary": "Mostly Demo Day logistics chatter. Nothing requires a response.",
                "action_items": [],
            },
        ],
    }


def mock_check_telegram(_args: dict) -> dict:
    return {
        "ok": True,
        "messages": [
            {"from": "Marcus Chen", "text": "@Watson — what's your read on 25% at $40M post?", "ts": _at(8, 14)},
            {"from": "Priya Shah", "text": "Just hit publish on the GP-friction post. Tag if you want.", "ts": _at(7, 51)},
        ],
    }


def mock_send_telegram(args: dict) -> dict:
    return {
        "ok": True, "demo": True,
        "to": args.get("chat_id") or args.get("group") or "(unspecified)",
        "note": "Demo mode — message NOT actually sent.",
    }


# ── contacts / network ────────────────────────────────────────────────
def mock_search_contacts(args: dict) -> dict:
    name = (args.get("query") or "").strip().title() or "Unknown"
    return {
        "ok": True,
        "matches": [{
            "name": name,
            "phone": "+1-555-0142",
            "email": f"{name.lower().split()[0]}@example.com",
            "last_message": f"Last texted you {((_now() - timedelta(days=4)).strftime('%b %d'))}",
            "notes": "Demo contact.",
        }],
    }


def mock_lookup_contact(args: dict) -> dict:
    """Used by jarvis-think for the curated relationship layer."""
    return mock_search_contacts(args)


def mock_relationship_brief(args: dict) -> dict:
    name = (args.get("name") or "").strip().title() or "Unknown"
    return {
        "ok": True,
        "name": name,
        "brief": f"{name} — Series A investor, met at YC W24, warm. Last interaction 4 days ago.",
        "last_interaction": "Email re: pitch deck, 4 days ago",
        "talking_points": [
            "Their portfolio just funded a competitor in adjacent space — ask what they learned",
            "They mentioned interest in voice latency benchmarks last call",
        ],
        "open_threads": ["Owe them: deck v3 with ARR breakdown"],
    }


def mock_relationship_score(args: dict) -> dict:
    name = (args.get("name") or "").strip().title() or "Unknown"
    return {
        "ok": True,
        "name": name,
        "strength": 0.78,
        "trajectory": "warming",
        "responsiveness": "high",
        "next_action": {
            "channel": "email",
            "timing": "this week",
            "rationale": f"{name} responds to email within 24h on average; momentum from last meeting still fresh.",
        },
    }


def mock_network_search(args: dict) -> dict:
    return {
        "ok": True,
        "query": args.get("query", ""),
        "results": [
            {"name": "Marcus Chen", "trust": "warm", "expertise": ["GTM", "B2B SaaS"], "intro_path": "direct"},
            {"name": "Priya Shah", "trust": "close", "expertise": ["product", "AI infra"], "intro_path": "direct"},
        ],
    }


def mock_network_suggest(args: dict) -> dict:
    return {
        "ok": True,
        "goal": args.get("goal", ""),
        "primary": "Marcus Chen",
        "supporting": ["Priya Shah", "Dalton Caldwell"],
        "intro_path": "Direct — you've texted Marcus this week, no warming needed.",
        "sequence": [
            "1. Text Marcus today: 'Quick ask — got 10 min this week?'",
            "2. After his yes, send the one-pager Priya helped draft.",
            "3. Loop in Dalton if Marcus wants a YC reference.",
        ],
    }


# ── stripe ────────────────────────────────────────────────────────────
def mock_stripe_dashboard() -> dict:
    return {
        "ok": True,
        "demo": True,
        "mrr_dollars": 47820,
        "arr_dollars": 573840,
        "active_subscriptions": 142,
        "new_subscribers_7d": 11,
        "churned_7d": 2,
        "revenue_trend_pct": 18.4,
        "failed_payments_30d": 3,
        "top_customers": [
            {"name": "Acme HVAC", "mrr": 2400, "since": "2025-09-12"},
            {"name": "Beacon Studios", "mrr": 1200, "since": "2025-11-04"},
            {"name": "Curated Capital", "mrr": 900,  "since": "2026-01-19"},
        ],
        "alerts": [
            "3 cards declined this week — auto-retry in 24h",
        ],
    }


def mock_stripe_customer(args: dict) -> dict:
    needle = args.get("name_or_email") or args.get("query") or "Customer"
    return {
        "ok": True,
        "demo": True,
        "name": str(needle).title(),
        "email": f"{str(needle).lower().split()[0]}@example.com",
        "mrr": 1200,
        "since": "2025-10-21",
        "lifetime_value": 14400,
        "status": "active",
    }


def mock_stripe_revenue(args: dict) -> dict:
    days = int(args.get("days") or 30)
    return {
        "ok": True,
        "demo": True,
        "window_days": days,
        "gross_dollars": int(47820 * days / 30),
        "net_dollars": int(45200 * days / 30),
        "trend_pct": 18.4,
    }


def mock_stripe_alerts() -> dict:
    return {
        "ok": True,
        "demo": True,
        "alerts": [
            {"severity": "low",  "message": "3 cards declined this week", "count": 3},
            {"severity": "info", "message": "MRR crossed $45K threshold", "count": 1},
        ],
    }


# ── apple / imessage ──────────────────────────────────────────────────
def mock_apple_list_reminders(_args: dict) -> dict:
    return {
        "ok": True,
        "reminders": [
            {"title": "Send deck v3 to Roelof", "due": _tomorrow_iso(), "completed": False},
            {"title": "Sign payroll docs",       "due": _today_iso(),    "completed": False},
        ],
    }


def mock_apple_add_reminder(args: dict) -> dict:
    return {"ok": True, "demo": True, "title": args.get("title", "(untitled)"),
            "due": args.get("due") or _tomorrow_iso(),
            "note": "Demo mode — not actually added to Reminders.app."}


def mock_apple_complete_reminder(args: dict) -> dict:
    return {"ok": True, "demo": True, "id": args.get("id"), "completed": True}


def mock_apple_save_note(args: dict) -> dict:
    return {"ok": True, "demo": True, "title": args.get("title", "(untitled)"),
            "note": "Demo mode — not actually saved to Notes.app."}


def mock_apple_read_note(args: dict) -> dict:
    return {"ok": True, "demo": True, "title": args.get("title", "(untitled)"),
            "body": "Demo note. Lorem ipsum dolor sit amet."}


def mock_apple_contacts_search(args: dict) -> dict:
    return mock_search_contacts(args)


def mock_imessage_check(_args: dict) -> dict:
    return {
        "ok": True,
        "by_handle": {
            "+1-555-0142": [
                {"text": "Got 15 min later? Want to run the term sheet by you.",
                 "ts": _at(8, 22), "direction": "in"},
            ],
            "Karina Patel": [
                {"text": "Streaming TTS fix is live. Latency p50 is now 380ms.",
                 "ts": _at(9, 1), "direction": "in"},
            ],
        },
    }


def mock_imessage_read(args: dict) -> dict:
    handle = args.get("handle", "+1-555-0142")
    return {
        "ok": True,
        "handle": handle,
        "messages": [
            {"text": "Hey — saw your post on EA latency.",          "ts": _at(8, 1),  "direction": "in"},
            {"text": "Thanks — happy to chat. When works?",         "ts": _at(8, 14), "direction": "out"},
            {"text": "Got 15 min later? Want to run the term sheet by you.",
             "ts": _at(8, 22), "direction": "in"},
        ],
    }


def mock_imessage_send(args: dict) -> dict:
    return {"ok": True, "demo": True, "to": args.get("handle", "(unspecified)"),
            "note": "Demo mode — iMessage NOT actually sent."}


# ── trello ────────────────────────────────────────────────────────────
def mock_trello_boards(_args: dict) -> dict:
    return {
        "ok": True,
        "boards": [
            {"id": "brd_demo_jarvis", "name": "Jarvis Roadmap"},
            {"id": "brd_demo_pers",   "name": "Personal"},
        ],
    }


def mock_trello_add(args: dict) -> dict:
    return {"ok": True, "demo": True, "card_id": "card_demo_001",
            "name": args.get("name", "(untitled)"),
            "list": args.get("list", "Inbox"),
            "note": "Demo mode — not actually added to Trello."}


def mock_trello_move(args: dict) -> dict:
    return {"ok": True, "demo": True,
            "card_id": args.get("card_id"),
            "to_list": args.get("to_list"),
            "note": "Demo mode — not actually moved."}


def mock_trello_sync(_args: dict) -> dict:
    return {"ok": True, "demo": True, "synced_cards": 0,
            "note": "Demo mode — Trello sync skipped."}


# ── social / linkedin ─────────────────────────────────────────────────
def mock_social_digest(hours: int = 12) -> dict:
    return {
        "ok": True,
        "hours": hours,
        "platforms": [
            {
                "name": "twitter", "item_count": 8, "urgent": False,
                "summary": "3 mentions of your latency post; one from a Pulumi engineer asking how you measured p50.",
                "action_items": ["Reply to @pulumi_dev with the benchmark methodology"],
            },
            {
                "name": "linkedin", "item_count": 12, "urgent": False,
                "summary": "Your EA-latency post hit 4.2K impressions. Two warm comments from investors.",
                "action_items": [],
            },
        ],
    }


def mock_check_social(_args: dict) -> dict:
    return mock_social_digest()


def mock_social_post(args: dict) -> dict:
    return {"ok": True, "demo": True,
            "platform": args.get("platform", "twitter"),
            "preview": (args.get("text") or "")[:140],
            "note": "Demo mode — post NOT actually published."}


def mock_social_reply(args: dict) -> dict:
    return {"ok": True, "demo": True,
            "to_id": args.get("to_id"),
            "preview": (args.get("text") or "")[:140],
            "note": "Demo mode — reply NOT actually published."}


def mock_linkedin_changes(_args: dict) -> dict:
    return {
        "ok": True,
        "changes": [
            {"name": "Marcus Chen", "field": "title", "old": "Founder", "new": "CEO",
             "detected_at": _at(7, 30)},
            {"name": "Priya Shah", "field": "company", "old": "Stripe", "new": "Anthropic",
             "detected_at": _at(8, 15)},
        ],
    }


def mock_linkedin_search(args: dict) -> dict:
    return {
        "ok": True,
        "query": args.get("query", ""),
        "results": [
            {"name": "Marcus Chen", "headline": "CEO @ Stealth AI", "url": "linkedin.com/in/marcus-demo"},
            {"name": "Priya Shah",  "headline": "PM @ Anthropic",   "url": "linkedin.com/in/priya-demo"},
        ],
    }


# ── research / web search ─────────────────────────────────────────────
def mock_web_search(args: dict) -> dict:
    q = args.get("query", "")
    return {
        "ok": True,
        "query": q,
        "results": [
            {"title": f"Top result for {q}", "url": "https://example.com/1",
             "snippet": "Demo snippet — first result placeholder."},
            {"title": f"{q} — analysis (demo)", "url": "https://example.com/2",
             "snippet": "Demo snippet — second result, more depth."},
            {"title": f"How to {q.lower()}", "url": "https://example.com/3",
             "snippet": "Demo snippet — practitioner guide."},
        ],
    }


def mock_research_topic(args: dict) -> dict:
    topic = args.get("topic", "(unspecified)")
    return {
        "ok": True,
        "demo": True,
        "topic": topic,
        "summary": (f"Demo research on '{topic}': three competing approaches dominate the space. "
                    "The leading one trades latency for accuracy; the new contender does the inverse. "
                    "Anthropic's recent paper suggests a hybrid is feasible."),
        "sources": ["https://example.com/research/1", "https://example.com/research/2"],
    }


# ── notifications / pending ───────────────────────────────────────────
def mock_pending_notifications() -> list[dict]:
    return [
        {"id": "ntf_demo_1",
         "message": "Roelof confirmed for 10am — pull up the deck before the call.",
         "created_at": _at(7, 0)},
        {"id": "ntf_demo_2",
         "message": "Customer Acme HVAC reports voice loop frozen — prod incident.",
         "created_at": _at(8, 30)},
    ]


# ── memory / recall (overlay, not replacement) ────────────────────────
def mock_memory_recent(_limit: int = 5) -> list[dict]:
    return [
        {"text": "Watson is preparing for May 1 demo to Sequoia + Dalton.", "ts": _at(8, 0)},
        {"text": "Streaming TTS landed; p50 latency is 380ms.",              "ts": _at(9, 1)},
        {"text": "Karina shortlisted three engineers, all ex-Stripe.",       "ts": _at(11, 15)},
    ]


# ── weather ───────────────────────────────────────────────────────────
def mock_weather() -> dict:
    return {
        "now_temp_f": 68,
        "now_desc": "Partly cloudy",
        "today_min_f": 54,
        "today_max_f": 74,
        "today_chance_rain": "10",
    }


# ── stripe-shaped briefing payload (for jarvis-briefing._pull_stripe) ──
def mock_briefing_stripe() -> dict:
    """jarvis-briefing.py renders this with `if stripe.get("ok")`. The
    full dashboard is heavier than what the briefing needs; this is the
    trimmed shape."""
    d = mock_stripe_dashboard()
    return {
        "ok": True,
        "mrr_dollars": d["mrr_dollars"],
        "active_subscriptions": d["active_subscriptions"],
        "new_subscribers_7d": d["new_subscribers_7d"],
        "revenue_trend_pct": d["revenue_trend_pct"],
        "failed_payments_30d": d["failed_payments_30d"],
    }


# ── briefing payload (called by jarvis-briefing in demo mode) ─────────
def mock_briefing_payload() -> dict:
    """The full dict jarvis-briefing.py assembles before synthesis. Each
    field matches the real _pull_*() return shape."""
    return {
        "calendar":               mock_calendar(),
        "email": {
            "starred": mock_email_inbox("is:starred"),
            "unread":  mock_email_inbox("is:unread"),
        },
        "telegram":               mock_telegram_digest(),
        "social":                 mock_social_digest(),
        "pending_notifications":  mock_pending_notifications(),
        "memory_recent":          mock_memory_recent(),
        "stripe":                 mock_briefing_stripe(),
        "weather":                mock_weather(),
    }


# ── commitments (light overlay) ───────────────────────────────────────
def mock_list_commitments(_args: dict) -> dict:
    return {
        "ok": True,
        "items": [
            {"id": "cmt_demo_1", "summary": "Send deck v3 to Roelof",
             "owner": "Watson", "due": _tomorrow_iso(), "status": "open"},
            {"id": "cmt_demo_2", "summary": "Reply to Marcus on term-sheet math",
             "owner": "Watson", "due": _today_iso(), "status": "open"},
        ],
    }


def mock_commitment_report() -> dict:
    return {
        "ok": True,
        "overdue":      [],
        "due_today":    [{"summary": "Reply to Marcus on term-sheet math"}],
        "due_this_week":[{"summary": "Send deck v3 to Roelof"}],
    }


# ── meeting prep ──────────────────────────────────────────────────────
def mock_meeting_prep(args: dict) -> dict:
    title = args.get("title") or "(upcoming meeting)"
    return {
        "ok": True,
        "demo": True,
        "title": title,
        "brief": (
            f"For '{title}': lead with the latency demo (p50 380ms with streaming TTS), "
            "then walk through the orchestrator. Avoid getting pulled into pricing on this call."
        ),
        "talking_points": [
            "Open with the live demo — voice in, structured response in <500ms",
            "Mention the May 1 launch milestone",
            "Don't commit to integration timelines without engineering's read",
        ],
    }


# ── Dispatch table ────────────────────────────────────────────────────
# Maps tool_name → callable(args: dict) -> dict. Only tools that actually
# touch external systems are listed; everything else falls through to the
# real handler (memory, clock, timers, shell, workflows, notifications).
_DISPATCH: dict[str, Callable[[dict], Any]] = {
    # email
    "check_email":       lambda a: mock_email_inbox(a.get("query"), int(a.get("max_results") or 5)),
    "draft_email":       mock_draft_email,
    "send_email":        mock_send_email,
    "reply_email":       mock_send_email,
    # calendar
    "check_calendar":    lambda _a: mock_calendar(),
    "create_event":      mock_create_event,
    "update_event":      lambda a: {"ok": True, "demo": True, "id": a.get("id"), "note": "Demo mode — not updated."},
    "delete_event":      lambda a: {"ok": True, "demo": True, "id": a.get("id"), "note": "Demo mode — not deleted."},
    # telegram
    "check_telegram":    mock_check_telegram,
    "telegram_digest":   lambda a: mock_telegram_digest(int(a.get("hours") or 12)),
    "telegram_search":   lambda a: {"ok": True, "matches": [], "query": a.get("query", "")},
    "send_telegram":     mock_send_telegram,
    # social
    "check_social":      mock_check_social,
    "social_digest":     lambda a: mock_social_digest(int(a.get("hours") or 12)),
    "social_search":     lambda a: {"ok": True, "matches": [], "query": a.get("query", "")},
    "social_post":       mock_social_post,
    "social_reply":      mock_social_reply,
    # network / linkedin
    "network_search":    mock_network_search,
    "network_map":       lambda _a: {"ok": True, "nodes": 142, "edges": 387, "demo": True},
    "relationship_score":mock_relationship_score,
    "network_suggest":   mock_network_suggest,
    "enrich_network":    lambda _a: {"ok": True, "demo": True, "enriched": 0},
    "network_alerts":    lambda _a: {"ok": True, "alerts": []},
    "linkedin_enrich":   lambda a: {"ok": True, "demo": True, "name": a.get("name", "")},
    "linkedin_sync":     lambda _a: {"ok": True, "demo": True, "synced": 0},
    "linkedin_monitor":  lambda _a: {"ok": True, "demo": True},
    "linkedin_changes":  mock_linkedin_changes,
    "linkedin_search":   mock_linkedin_search,
    # contacts
    "search_contacts":   mock_search_contacts,
    "lookup_contact":    mock_lookup_contact,
    "relationship_brief":mock_relationship_brief,
    "enrich_contact":    lambda a: {"ok": True, "demo": True, "name": a.get("name", "")},
    # apple
    "apple_add_reminder":      mock_apple_add_reminder,
    "apple_list_reminders":    mock_apple_list_reminders,
    "apple_complete_reminder": mock_apple_complete_reminder,
    "apple_save_note":         mock_apple_save_note,
    "apple_read_note":         mock_apple_read_note,
    "apple_contacts_search":   mock_apple_contacts_search,
    # imessage
    "imessage_check":          mock_imessage_check,
    "imessage_read":           mock_imessage_read,
    "imessage_send":           mock_imessage_send,
    "imessage_search_contacts":mock_apple_contacts_search,
    # stripe
    "stripe_dashboard":  lambda _a: mock_stripe_dashboard(),
    "stripe_customers":  lambda _a: {"ok": True, "demo": True, "customers": mock_stripe_dashboard()["top_customers"]},
    "stripe_customer":   mock_stripe_customer,
    "stripe_revenue":    mock_stripe_revenue,
    "stripe_alerts":     lambda _a: mock_stripe_alerts(),
    # trello
    "trello_sync":       mock_trello_sync,
    "trello_boards":     mock_trello_boards,
    "trello_add":        mock_trello_add,
    "trello_move":       mock_trello_move,
    # research
    "web_search":        mock_web_search,
    "research_topic":    mock_research_topic,
    # commitments overlay (light — real handlers are local but we mock for a
    # populated-looking demo even if Watson hasn't logged any)
    "list_commitments":  mock_list_commitments,
    "commitment_report": lambda _a: mock_commitment_report(),
    # meeting prep
    "meeting_prep":      mock_meeting_prep,
}


def demo_dispatch(tool_name: str, args: dict | None = None) -> dict | None:
    """Route a tool call through the demo fixtures.

    Returns the mock result dict if `tool_name` is mocked, or None if the
    tool isn't in the demo table — in which case the caller should fall
    through to the real handler (memory, timers, get_time, etc., all
    work fine without external APIs)."""
    if not is_demo():
        return None
    fn = _DISPATCH.get(tool_name)
    if fn is None:
        return None
    try:
        return fn(args or {})
    except Exception as e:
        return {"error": f"demo fixture for {tool_name} failed: {e}", "demo": True}
