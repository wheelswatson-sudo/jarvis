#!/usr/bin/env python3
"""Smart Notifications — central bus that scores and routes alerts.

Replaces dumb proactive alerts with intelligent triage. Every event
(email, telegram, calendar, orchestrator, anything else) calls enqueue()
with a source/sender/content tuple. The bus computes a priority score
from four components — source weight, sender importance (from
jarvis-contacts), urgency keywords, and time sensitivity — and routes:

    score >= 8     interrupt now (jarvis-notify --force)
    score 5..7     queue for next conversation pause
    score <= 4     batch into the next briefing

Public functions (all return JSON-serializable dicts):

    enqueue(source, content, sender=None, urgency_keywords=None,
            time_sensitivity=0, route="auto")
        Score and route a single notification. Returns
        {ok, id, score, components, route}.

    get_notifications(filter=None) -> {ok, notifications, count}
        List queued notifications. filter ∈ {None, "pending",
        "delivered", "high", "low"}.

    mark_delivered(id) -> {ok}
    dismiss(id)        -> {ok}

    set_rules(rules) -> {ok, rules}
    get_rules()      -> dict

CLI:
    bin/jarvis-notifications.py --enqueue SOURCE 'content' [--sender X]
                                                          [--keywords k1,k2]
                                                          [--time-sensitivity N]
    bin/jarvis-notifications.py --list [--filter pending|high|...]
    bin/jarvis-notifications.py --status
    bin/jarvis-notifications.py --rules-show
    bin/jarvis-notifications.py --dismiss ID
    bin/jarvis-notifications.py --flush-low      (drain low-tier into briefing)

Files written:
    ~/.jarvis/notifications/queue.json   pending + recently-delivered
    ~/.jarvis/notifications/rules.json   per-source rules + sender allow/deny
    ~/.jarvis/logs/notifications.log     diagnostic log

Note on the `pending.json` file used by jarvis-notify:
    This bus writes to a NEW queue file (queue.json) so it can carry
    structured notifications. jarvis-notify still reads/writes the
    legacy pending.json string queue — we keep them parallel so
    upstream tools (timers, reminders) keep working unchanged.

Gate: JARVIS_NOTIFICATIONS=1 (default).
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import shlex
import subprocess
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
NOTIF_DIR = ASSISTANT_DIR / "notifications"
QUEUE_FILE = NOTIF_DIR / "queue.json"
RULES_FILE = NOTIF_DIR / "rules.json"
LOG_DIR = ASSISTANT_DIR / "logs"
NOTIF_LOG = LOG_DIR / "notifications.log"

# Score thresholds — also overridable via rules.json
DEFAULT_INTERRUPT_THRESHOLD = 8
DEFAULT_QUEUE_THRESHOLD = 5
MAX_QUEUE_SIZE = 200  # truncate oldest delivered/dismissed beyond this

# Default per-source weight — represents the baseline "stakes" for each channel.
DEFAULT_SOURCE_WEIGHTS = {
    "calendar": 5,
    "orchestrator": 4,
    "telegram": 3,
    "social": 2,
    "email": 2,
    "timer": 4,
    "reminder": 4,
    "manual": 2,
    "system": 1,
}

# Urgency keyword categories — content-driven urgency signal.
DEFAULT_URGENCY_TERMS = {
    3: ["urgent", "asap", "emergency", "now", "critical", "fire", "down", "outage"],
    2: ["today", "deadline", "before eod", "by eod", "by tomorrow", "right away",
        "please respond", "blocking", "blocker"],
    1: ["soon", "this week", "follow up", "quick", "heads up", "fyi"],
}

CONVO_FLAG = ASSISTANT_DIR / "state" / "convo_active"


# ── Logging ─────────────────────────────────────────────────────────
def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with NOTIF_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


# ── Gate ────────────────────────────────────────────────────────────
def _gate_check() -> dict | None:
    if os.environ.get("JARVIS_NOTIFICATIONS", "1") != "1":
        return {"error": "smart notifications disabled (JARVIS_NOTIFICATIONS=0)"}
    return None


# ── Queue / rules I/O ───────────────────────────────────────────────
def _load_queue() -> list[dict]:
    if not QUEUE_FILE.exists():
        return []
    try:
        data = json.loads(QUEUE_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        _log(f"queue read failed: {e}")
        return []
    if not isinstance(data, list):
        return []
    return data


def _save_queue(queue: list[dict]) -> None:
    NOTIF_DIR.mkdir(parents=True, exist_ok=True)
    if len(queue) > MAX_QUEUE_SIZE:
        # Drop the oldest delivered/dismissed first; keep all pending.
        pending = [n for n in queue if n.get("state") == "pending"]
        finished = [n for n in queue if n.get("state") != "pending"]
        finished.sort(key=lambda n: n.get("ts") or 0, reverse=True)
        keep = pending + finished[: MAX_QUEUE_SIZE - len(pending)]
        keep.sort(key=lambda n: n.get("ts") or 0)
        queue = keep
    tmp = QUEUE_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(queue, f, indent=2, ensure_ascii=False)
    os.replace(tmp, QUEUE_FILE)


def _load_rules() -> dict:
    if not RULES_FILE.exists():
        return {}
    try:
        data = json.loads(RULES_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        _log(f"rules read failed: {e}")
        return {}
    return data if isinstance(data, dict) else {}


def _save_rules(rules: dict) -> None:
    NOTIF_DIR.mkdir(parents=True, exist_ok=True)
    tmp = RULES_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(rules, f, indent=2, ensure_ascii=False)
    os.replace(tmp, RULES_FILE)


def _ensure_rules_defaults(rules: dict) -> dict:
    rules.setdefault("interrupt_threshold", DEFAULT_INTERRUPT_THRESHOLD)
    rules.setdefault("queue_threshold", DEFAULT_QUEUE_THRESHOLD)
    rules.setdefault("source_weights", dict(DEFAULT_SOURCE_WEIGHTS))
    rules.setdefault("source_filters", {})  # source → "off" | "queue_only" | "interrupt_only"
    rules.setdefault("sender_overrides", {})  # canonical sender id → "high" | "block" | "low"
    rules.setdefault("quiet_hours", None)  # e.g. {"start": "22:00", "end": "07:00"}
    return rules


# ── Sender importance from jarvis-contacts ──────────────────────────
def _bin_dir() -> Path:
    deployed = ASSISTANT_DIR / "bin"
    if deployed.exists():
        return deployed
    return Path(__file__).parent


def _load_contacts():
    src = _bin_dir() / "jarvis-contacts.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location(
            "jarvis_contacts_for_notif", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    except Exception as e:
        _log(f"contacts load failed: {e}")
        return None


def _load_network():
    """Lazy-load jarvis-network. Returns the module or None — caller treats
    as a no-op when missing so an install without the network module still
    routes notifications cleanly."""
    src = _bin_dir() / "jarvis-network.py"
    if not src.exists():
        return None
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("jarvis_network_notif", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    except Exception as e:
        _log(f"network module load failed: {e}")
        return None


def _trust_to_importance(trust: str) -> int | None:
    """Map jarvis-network trust_level to a sender importance score.
    Returns None when trust isn't a known label so the caller falls back
    to the legacy relationship-string heuristic."""
    return {
        "inner_circle": 4,
        "trusted":      3,
        "professional": 2,
        "acquaintance": 1,
        "cold":         1,
    }.get((trust or "").lower())


def _sender_importance(sender: str | None, rules: dict) -> int:
    """Return a 0..4 importance score for the sender. Order:
    1. Explicit rule override (block=-99, low=0, high=4)
    2. Network trust_level (inner_circle=4 ... cold=1)
    3. Contacts relationship_label / interaction_count fallback
    4. Default 1 (unknown).

    Adds a +2 bump when the sender is a fading inner_circle contact (per
    the network alerts cache) so a "hey, where've you been" from a quiet
    co-founder cuts through the queue threshold."""
    if not sender:
        return 0
    s_norm = (sender or "").strip().lower().lstrip("@")
    overrides = rules.get("sender_overrides") or {}
    if s_norm in overrides:
        v = overrides[s_norm]
        if v == "block":
            return -99
        if v == "high":
            return 4
        if v == "low":
            return 0
    mod = _load_contacts()
    if mod is None:
        return 1
    try:
        res = mod.lookup_contact(sender)
    except Exception:
        return 1
    if not isinstance(res, dict) or not res.get("found"):
        return 1
    rec = res.get("contact") or {}

    # Prefer the network's trust_level when present — it's a composite
    # signal, more reliable than a single relationship label string.
    base = _trust_to_importance(rec.get("trust_level"))
    if base is None:
        rel = (rec.get("relationship") or "").lower()
        if any(tok in rel for tok in ("investor", "client", "founder peer",
                                       "co-founder", "spouse", "partner")):
            base = 4
        elif any(tok in rel for tok in ("friend", "team", "advisor", "mentor")):
            base = 3
        else:
            count = int(rec.get("interaction_count") or 0)
            base = 3 if count > 30 else 2 if count > 5 else 1

    # Fading inner-circle bump (only when feature is on).
    net = _load_network()
    if net is not None:
        try:
            bump = net.fading_inner_circle_priority_boost(sender)
        except Exception:
            bump = 0
        if bump:
            base = min(4, base + bump)
    return base


# ── Urgency keyword scan ────────────────────────────────────────────
_URGENCY_TABLE: list[tuple[int, re.Pattern]] = [
    (weight, re.compile(r"\b(?:" + "|".join(re.escape(t) for t in terms) + r")\b", re.I))
    for weight, terms in sorted(DEFAULT_URGENCY_TERMS.items(), reverse=True)
]


def _urgency_score(content: str, extra_keywords: list[str] | None = None) -> int:
    """Pick the highest-weight urgency category triggered by the content
    plus any extra_keywords the caller flagged. Caps at 3."""
    text = (content or "").lower()
    best = 0
    for weight, pat in _URGENCY_TABLE:
        if pat.search(text):
            if weight > best:
                best = weight
            if best == 3:
                break
    if extra_keywords:
        for kw in extra_keywords:
            if kw and kw.lower() in text:
                best = max(best, 1)
    return best


# ── Quiet hours ─────────────────────────────────────────────────────
def _in_quiet_hours(rules: dict) -> bool:
    qh = rules.get("quiet_hours") or {}
    if not qh:
        return False
    try:
        h_start, m_start = (int(x) for x in (qh.get("start") or "0:0").split(":"))
        h_end, m_end = (int(x) for x in (qh.get("end") or "0:0").split(":"))
    except Exception:
        return False
    now = datetime.now().astimezone()
    cur_min = now.hour * 60 + now.minute
    s = h_start * 60 + m_start
    e = h_end * 60 + m_end
    if s == e:
        return False
    if s < e:
        return s <= cur_min < e
    return cur_min >= s or cur_min < e


# ── Score routing ───────────────────────────────────────────────────
def _route_for_score(score: int, rules: dict, source: str) -> str:
    """Return one of "interrupt" | "queue" | "batch" | "drop"."""
    filters = (rules.get("source_filters") or {})
    f = filters.get(source)
    if f == "off":
        return "drop"
    interrupt = int(rules.get("interrupt_threshold", DEFAULT_INTERRUPT_THRESHOLD))
    queue = int(rules.get("queue_threshold", DEFAULT_QUEUE_THRESHOLD))
    if _in_quiet_hours(rules) and score < interrupt + 2:
        # Quiet hours: only ultra-high scores break through. Everything
        # else gets queued or batched.
        return "queue" if score >= queue else "batch"
    if f == "queue_only":
        return "queue" if score >= queue else "batch"
    if f == "interrupt_only":
        return "interrupt" if score >= interrupt else "drop"
    if score >= interrupt:
        return "interrupt"
    if score >= queue:
        return "queue"
    return "batch"


def _score_components(source: str, sender: str | None, content: str,
                      rules: dict, urgency_keywords: list[str] | None,
                      time_sensitivity: int) -> dict:
    """Decompose the score so callers can see WHY something interrupted."""
    src_w = int((rules.get("source_weights") or DEFAULT_SOURCE_WEIGHTS).get(
        source, DEFAULT_SOURCE_WEIGHTS.get(source, 1)))
    snd_w = _sender_importance(sender, rules)
    urg = _urgency_score(content, urgency_keywords)
    ts = max(0, min(int(time_sensitivity or 0), 4))
    # Block sender → strongly negative; drop everything.
    if snd_w == -99:
        return {
            "source_weight": src_w, "sender_importance": -99,
            "urgency": urg, "time_sensitivity": ts, "total": -99,
        }
    return {
        "source_weight": src_w,
        "sender_importance": snd_w,
        "urgency": urg,
        "time_sensitivity": ts,
        "total": src_w + snd_w + urg + ts,
    }


# ── Public: enqueue ─────────────────────────────────────────────────
def enqueue(source: str, content: str, sender: str | None = None,
            urgency_keywords: list[str] | None = None,
            time_sensitivity: int = 0,
            route: str = "auto") -> dict:
    """Score and route a notification.
    `route="auto"` (default) honours score thresholds.
    `route="interrupt"|"queue"|"batch"` forces a specific delivery."""
    gate = _gate_check()
    if gate:
        return gate
    source = (source or "").strip().lower() or "manual"
    content = (content or "").strip()
    if not content:
        return {"error": "content is required"}

    rules = _ensure_rules_defaults(_load_rules())
    components = _score_components(
        source, sender, content, rules, urgency_keywords, time_sensitivity,
    )
    chosen_route = route if route in ("interrupt", "queue", "batch", "drop") \
        else _route_for_score(components["total"], rules, source)

    notif = {
        "id": uuid.uuid4().hex[:12],
        "ts": time.time(),
        "iso": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": source,
        "sender": sender,
        "content": content[:1000],
        "components": components,
        "score": components["total"],
        "route": chosen_route,
        "state": "pending",
    }
    if chosen_route == "drop":
        notif["state"] = "dropped"
        _log(f"drop: source={source} sender={sender!r} score={notif['score']}")
        return {"ok": True, "id": notif["id"], "score": notif["score"],
                "components": components, "route": chosen_route, "delivered": False}

    queue = _load_queue()
    queue.append(notif)
    _save_queue(queue)

    delivered = False
    if chosen_route == "interrupt":
        delivered = _deliver_interrupt(content)
        if delivered:
            notif["state"] = "delivered"
            notif["delivered_at"] = datetime.now().astimezone().isoformat(
                timespec="seconds")
            _save_queue(queue)
    _log(f"{chosen_route}: source={source} sender={sender!r} "
         f"score={notif['score']} id={notif['id']}")
    return {
        "ok": True,
        "id": notif["id"],
        "score": notif["score"],
        "components": components,
        "route": chosen_route,
        "delivered": delivered,
    }


def _deliver_interrupt(content: str) -> bool:
    """Spawn jarvis-notify --force. Returns True on successful spawn."""
    notify_bin = _bin_dir() / "jarvis-notify"
    if not notify_bin.exists():
        _log("interrupt: jarvis-notify not found, falling back to log only")
        return False
    try:
        subprocess.Popen(
            [str(notify_bin), "--force", content],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return True
    except Exception as e:
        _log(f"interrupt spawn failed: {e}")
        return False


# ── Public: get_notifications ───────────────────────────────────────
def get_notifications(filter: str | None = None) -> dict:
    gate = _gate_check()
    if gate:
        return gate
    queue = _load_queue()
    f = (filter or "").strip().lower() or None
    if f in ("pending", None):
        items = [n for n in queue if n.get("state") == "pending"]
        if f is None:
            items = queue  # return everything when no filter
            items = items[-50:]  # cap default response
    elif f == "all":
        items = queue
    elif f == "delivered":
        items = [n for n in queue if n.get("state") == "delivered"]
    elif f == "dropped":
        items = [n for n in queue if n.get("state") == "dropped"]
    elif f == "high":
        rules = _ensure_rules_defaults(_load_rules())
        items = [n for n in queue if n.get("score", 0) >= rules["interrupt_threshold"]]
    elif f == "low":
        rules = _ensure_rules_defaults(_load_rules())
        items = [n for n in queue if n.get("score", 0) < rules["queue_threshold"]]
    else:
        items = [n for n in queue if (n.get("source") or "") == f]
    items = sorted(items, key=lambda n: n.get("ts") or 0, reverse=True)
    return {
        "ok": True,
        "filter": f or "pending",
        "count": len(items),
        "notifications": [
            {
                "id": n.get("id"),
                "iso": n.get("iso"),
                "source": n.get("source"),
                "sender": n.get("sender"),
                "score": n.get("score"),
                "route": n.get("route"),
                "state": n.get("state"),
                "content": n.get("content"),
            }
            for n in items[:50]
        ],
    }


# ── Public: dismiss / mark_delivered ────────────────────────────────
def mark_delivered(id: str) -> dict:
    gate = _gate_check()
    if gate:
        return gate
    queue = _load_queue()
    for n in queue:
        if n.get("id") == id:
            n["state"] = "delivered"
            n["delivered_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
            _save_queue(queue)
            return {"ok": True, "id": id}
    return {"error": f"no notification with id {id!r}"}


def dismiss(id: str) -> dict:
    gate = _gate_check()
    if gate:
        return gate
    queue = _load_queue()
    for n in queue:
        if n.get("id") == id:
            n["state"] = "dismissed"
            n["dismissed_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
            _save_queue(queue)
            return {"ok": True, "id": id}
    return {"error": f"no notification with id {id!r}"}


# ── Public: rules ───────────────────────────────────────────────────
def get_rules() -> dict:
    return _ensure_rules_defaults(_load_rules())


def set_rules(rules: dict) -> dict:
    """Replace or merge user-supplied rules. Top-level keys are merged,
    inner dicts are merged, list/scalar values are replaced."""
    gate = _gate_check()
    if gate:
        return gate
    if not isinstance(rules, dict):
        return {"error": "rules must be an object"}
    cur = _ensure_rules_defaults(_load_rules())
    for k, v in rules.items():
        if isinstance(v, dict) and isinstance(cur.get(k), dict):
            cur[k].update(v)
        else:
            cur[k] = v
    _save_rules(cur)
    return {"ok": True, "rules": cur}


# ── Public: status ──────────────────────────────────────────────────
def status() -> dict:
    queue = _load_queue()
    rules = _ensure_rules_defaults(_load_rules())
    pending = [n for n in queue if n.get("state") == "pending"]
    by_source: dict[str, int] = {}
    for n in pending:
        by_source[n.get("source") or "?"] = by_source.get(n.get("source") or "?", 0) + 1
    return {
        "ok": True,
        "pending": len(pending),
        "total_logged": len(queue),
        "pending_by_source": by_source,
        "thresholds": {
            "interrupt": rules.get("interrupt_threshold"),
            "queue": rules.get("queue_threshold"),
        },
        "quiet_hours": rules.get("quiet_hours"),
        "queue_path": str(QUEUE_FILE),
        "rules_path": str(RULES_FILE),
    }


# ── Briefing hint (consumed by jarvis-context.py) ───────────────────
def context_hint() -> str:
    """Return a one-line context-engine hint when there are pending
    interrupts or a backlog of queued items. Empty otherwise — same
    contract as jarvis-telegram.context_hint()."""
    if os.environ.get("JARVIS_NOTIFICATIONS", "1") != "1":
        return ""
    queue = _load_queue()
    pending = [n for n in queue if n.get("state") == "pending"]
    if not pending:
        return ""
    rules = _ensure_rules_defaults(_load_rules())
    interrupt_t = int(rules.get("interrupt_threshold", DEFAULT_INTERRUPT_THRESHOLD))
    high = sum(1 for n in pending if n.get("score", 0) >= interrupt_t)
    if high:
        return (
            f"**Notifications:** {high} high-priority pending "
            f"(plus {len(pending) - high} queued). If Watson asks 'anything "
            "urgent' or similar, lead with `check_notifications(filter=\"high\")`."
        )
    return (
        f"**Notifications:** {len(pending)} queued. Surface via "
        "`check_notifications` if Watson asks what's pending."
    )


# ── CLI ─────────────────────────────────────────────────────────────
def _cli() -> int:
    args = sys.argv[1:]
    if not args:
        print(json.dumps(status(), indent=2, ensure_ascii=False))
        return 0
    if args[0] in ("-h", "--help"):
        sys.stdout.write(__doc__ or "")
        return 0
    cmd = args[0]
    rest = args[1:]

    def _flag(name: str, default: str | None = None) -> str | None:
        if name in rest:
            i = rest.index(name)
            if i + 1 < len(rest):
                return rest[i + 1]
        return default

    if cmd == "--enqueue":
        if len(rest) < 2 or rest[0].startswith("--"):
            print("usage: --enqueue SOURCE 'content' [--sender X] "
                  "[--keywords k1,k2] [--time-sensitivity N] [--route X]",
                  file=sys.stderr)
            return 2
        source = rest[0]
        content = rest[1]
        sender = _flag("--sender")
        kw = _flag("--keywords")
        urgency_keywords = [k.strip() for k in (kw or "").split(",") if k.strip()] or None
        ts_raw = _flag("--time-sensitivity", "0") or "0"
        time_sensitivity = int(ts_raw) if ts_raw.lstrip("-").isdigit() else 0
        route = _flag("--route", "auto") or "auto"
        print(json.dumps(enqueue(
            source=source, content=content, sender=sender,
            urgency_keywords=urgency_keywords,
            time_sensitivity=time_sensitivity, route=route,
        ), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--list":
        f = _flag("--filter")
        print(json.dumps(get_notifications(filter=f), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--status":
        print(json.dumps(status(), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--rules-show":
        print(json.dumps(get_rules(), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--rules-set":
        # JSON blob from stdin or one --key value pair.
        if rest and rest[0] == "--from-stdin":
            try:
                rules = json.load(sys.stdin)
            except Exception as e:
                print(f"failed to read JSON from stdin: {e}", file=sys.stderr)
                return 2
        elif len(rest) >= 2:
            key = rest[0].lstrip("-")
            try:
                val: object = json.loads(rest[1])
            except json.JSONDecodeError:
                val = rest[1]
            rules = {key: val}
        else:
            print("usage: --rules-set KEY VALUE  OR  --rules-set --from-stdin",
                  file=sys.stderr)
            return 2
        print(json.dumps(set_rules(rules), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--dismiss":
        if not rest:
            print("usage: --dismiss ID", file=sys.stderr)
            return 2
        print(json.dumps(dismiss(rest[0]), indent=2, ensure_ascii=False))
        return 0
    if cmd == "--mark-delivered":
        if not rest:
            print("usage: --mark-delivered ID", file=sys.stderr)
            return 2
        print(json.dumps(mark_delivered(rest[0]), indent=2, ensure_ascii=False))
        return 0
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
