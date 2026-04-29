#!/usr/bin/env python3
"""Stripe revenue intelligence — MRR, customers, alerts.

Watson runs the business; Jarvis should know how the business is doing
without him having to log in. This module talks to the Stripe REST API
directly (stdlib urllib + json — no Stripe SDK), shapes the responses
into voice-ready dicts, and feeds revenue into the briefing, context,
notification, and contact subsystems.

Public functions (all return JSON-serializable dicts):

    stripe_dashboard()
        Quick snapshot — MRR, new subscribers (7d), 30d trend, churn,
        outstanding invoices. Voice-ready summary string included.

    stripe_customers(status="active", limit=20)
        List customers, filtered by subscription status, sorted by MRR
        contribution. status ∈ {"active", "past_due", "canceled", "all"}.

    stripe_customer(name_or_email)
        Deep dive on one customer. Fuzzy matches by name or email.
        Returns subscription history, payments, refunds, disputes,
        lifetime value, and a payment-reliability score.

    stripe_revenue(period="month")
        Aggregated revenue. period ∈ {"day", "week", "month"}. Includes
        plan breakdown and growth rate.

    stripe_alerts()
        Proactive signals — failed payments, expiring subs, signup
        spikes/drops, at-risk customers. Feeds the notification bus.

    briefing_section()
        Markdown block for the morning briefing.

    context_hint(mentioned_names=None)
        One-liner for jarvis-context when a Stripe customer is named.

    customer_for_contact(name_or_email)
        Look up the Stripe record for a given contact name/email so
        jarvis-network can enrich its records with subscription data.

Files:
    ~/.jarvis/stripe/cache.json      short-lived API response cache
    ~/.jarvis/logs/stripe.log        diagnostic log

Auth: STRIPE_SECRET_KEY env var (sk_live_… or sk_test_…). Without it the
module is a silent no-op and the gate reports the missing key.

Gate: JARVIS_STRIPE=1 (defaults on iff STRIPE_SECRET_KEY is present).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
BIN_DIR = ASSISTANT_DIR / "bin"
LIB_DIR = ASSISTANT_DIR / "lib"
STRIPE_DIR = ASSISTANT_DIR / "stripe"
CACHE_FILE = STRIPE_DIR / "cache.json"
LOG_DIR = ASSISTANT_DIR / "logs"
STRIPE_LOG = LOG_DIR / "stripe.log"

STRIPE_API = "https://api.stripe.com/v1"
HTTP_TIMEOUT_S = float(os.environ.get("JARVIS_STRIPE_HTTP_TIMEOUT_S", "12"))
CACHE_TTL_S = float(os.environ.get("JARVIS_STRIPE_CACHE_TTL_S", "120"))
LIST_PAGE_SIZE = int(os.environ.get("JARVIS_STRIPE_PAGE_SIZE", "100"))
MAX_PAGES = int(os.environ.get("JARVIS_STRIPE_MAX_PAGES", "5"))


# ── logging + gate ────────────────────────────────────────────────────
def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with STRIPE_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def _gate_default() -> str:
    return "1" if os.environ.get("STRIPE_SECRET_KEY") else "0"


def _gate_check() -> dict | None:
    enabled = os.environ.get("JARVIS_STRIPE", _gate_default())
    if str(enabled).strip().lower() in ("0", "false", "no", "off", ""):
        return {"error": "stripe disabled (JARVIS_STRIPE=0)"}
    if not os.environ.get("STRIPE_SECRET_KEY"):
        return {"error": "STRIPE_SECRET_KEY not set"}
    return None


# ── primitive (lazy) ──────────────────────────────────────────────────
_primitive_mod = None


def _primitive():
    global _primitive_mod
    if _primitive_mod is not None:
        return _primitive_mod
    src = LIB_DIR / "primitive.py"
    if not src.exists():
        src = Path(__file__).parent.parent / "lib" / "primitive.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("primitive", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _primitive_mod = mod
        return mod
    except Exception:
        return None


# ── HTTP ──────────────────────────────────────────────────────────────
def _stripe_get(path: str, params: dict | None = None) -> dict:
    """GET /v1/<path>. Returns the parsed JSON or {"error": "..."}.
    Best-effort — never raises. Stripe expects form-encoded query args."""
    key = os.environ.get("STRIPE_SECRET_KEY", "")
    if not key:
        return {"error": "STRIPE_SECRET_KEY not set"}
    qs = ""
    if params:
        # Stripe encodes nested dicts like expand[]=foo, but we keep it flat —
        # the call sites we use don't need the nested form.
        qs = "?" + urllib.parse.urlencode(
            [(k, v) for k, v in params.items() if v is not None],
            doseq=True,
        )
    url = f"{STRIPE_API}/{path.lstrip('/')}{qs}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {key}",
            "Stripe-Version": "2024-04-10",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read()).get("error", {}).get("message", str(e))
        except Exception:
            err = str(e)
        _log(f"GET {path} HTTP {e.code}: {err}")
        return {"error": f"HTTP {e.code}: {err}"}
    except (urllib.error.URLError, TimeoutError) as e:
        _log(f"GET {path} network: {e}")
        return {"error": f"network: {e}"}
    except Exception as e:
        _log(f"GET {path} unexpected: {e}")
        return {"error": f"unexpected: {e}"}


def _list_all(path: str, params: dict | None = None,
              max_pages: int = MAX_PAGES) -> list[dict]:
    """Paginate /v1/<path> via starting_after cursor. Capped to max_pages
    so we never accidentally pull a whole production account into memory."""
    out: list[dict] = []
    p = dict(params or {})
    p.setdefault("limit", LIST_PAGE_SIZE)
    for _ in range(max(1, max_pages)):
        rec = _stripe_get(path, p)
        if rec.get("error"):
            _log(f"list {path}: {rec['error']}")
            return out
        data = rec.get("data") or []
        out.extend(data)
        if not rec.get("has_more") or not data:
            break
        p["starting_after"] = data[-1].get("id")
    return out


# ── cache ─────────────────────────────────────────────────────────────
def _cache_load() -> dict:
    if not CACHE_FILE.exists():
        return {}
    try:
        return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _cache_save(data: dict) -> None:
    try:
        STRIPE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = CACHE_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(CACHE_FILE)
    except Exception:
        pass


def _cached_or(key: str, builder, ttl_s: float = CACHE_TTL_S):
    """Return cached value if fresh, otherwise call builder(), cache, return."""
    data = _cache_load()
    entry = data.get(key)
    if entry and (time.time() - float(entry.get("ts") or 0)) < ttl_s:
        return entry.get("value")
    value = builder()
    data[key] = {"ts": time.time(), "value": value}
    _cache_save(data)
    return value


# ── helpers ───────────────────────────────────────────────────────────
def _cents_to_dollars(cents: int | None) -> float:
    return round(int(cents or 0) / 100.0, 2)


def _ts_iso(ts: int | float | None) -> str:
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat(timespec="seconds")
    except Exception:
        return ""


def _customer_label(c: dict) -> str:
    return (c.get("name") or c.get("email") or c.get("id") or "")[:80]


def _sub_mrr_cents(sub: dict) -> int:
    """Sum of unit_amount * quantity across all sub-items, normalized to a
    monthly cadence. Treats yearly as /12, weekly as *4.33, daily as *30."""
    total = 0
    for it in (sub.get("items") or {}).get("data") or []:
        price = it.get("price") or {}
        amount = int(price.get("unit_amount") or 0)
        qty = int(it.get("quantity") or 1)
        recur = price.get("recurring") or {}
        interval = (recur.get("interval") or "month").lower()
        count = int(recur.get("interval_count") or 1) or 1
        per_month = amount * qty
        if interval == "year":
            per_month = per_month / (12 * count)
        elif interval == "month":
            per_month = per_month / count
        elif interval == "week":
            per_month = per_month * 4.33 / count
        elif interval == "day":
            per_month = per_month * 30 / count
        total += int(per_month)
    return total


def _sub_plan_label(sub: dict) -> str:
    items = (sub.get("items") or {}).get("data") or []
    labels: list[str] = []
    for it in items:
        price = it.get("price") or {}
        nick = price.get("nickname")
        prod = price.get("product")
        if nick:
            labels.append(nick)
        elif isinstance(prod, dict) and prod.get("name"):
            labels.append(prod["name"])
        elif isinstance(prod, str):
            labels.append(prod)
    return ", ".join(labels) or "—"


# ── PUBLIC: stripe_dashboard ──────────────────────────────────────────
def stripe_dashboard() -> dict:
    """Snapshot for the voice surface. Cached for CACHE_TTL_S so a
    cluster of "how's revenue" turns doesn't burn rate limit."""
    gate = _gate_check()
    if gate:
        return gate

    def _build():
        now = datetime.now(tz=timezone.utc)
        thirty_ago = int((now - timedelta(days=30)).timestamp())
        sixty_ago = int((now - timedelta(days=60)).timestamp())
        seven_ago = int((now - timedelta(days=7)).timestamp())

        # Active subscriptions (for MRR + churn signal)
        active_subs = _list_all("subscriptions", {"status": "active",
                                                  "expand[]": "data.items.data.price.product"})
        canceled_recent = _list_all(
            "subscriptions",
            {"status": "canceled",
             "created[gte]": thirty_ago},
            max_pages=2,
        )

        mrr_cents = sum(_sub_mrr_cents(s) for s in active_subs)

        # New subscribers in last 7 days — count subscriptions by created
        new_7d = [s for s in active_subs if int(s.get("created") or 0) >= seven_ago]

        # Charges last 30d vs prior 30d (succeeded only)
        ch_recent = _list_all(
            "charges",
            {"created[gte]": thirty_ago, "limit": LIST_PAGE_SIZE},
            max_pages=3,
        )
        ch_prev = _list_all(
            "charges",
            {"created[gte]": sixty_ago, "created[lt]": thirty_ago,
             "limit": LIST_PAGE_SIZE},
            max_pages=3,
        )
        rev_recent = sum(int(c.get("amount") or 0) for c in ch_recent
                         if c.get("status") == "succeeded" and not c.get("refunded"))
        rev_prev = sum(int(c.get("amount") or 0) for c in ch_prev
                       if c.get("status") == "succeeded" and not c.get("refunded"))
        trend_pct: float | None
        if rev_prev:
            trend_pct = round((rev_recent - rev_prev) / rev_prev * 100.0, 1)
        else:
            trend_pct = None

        # Outstanding invoices (open / past_due)
        open_invoices = _list_all(
            "invoices",
            {"status": "open", "limit": LIST_PAGE_SIZE},
            max_pages=2,
        )
        outstanding_cents = sum(int(i.get("amount_due") or 0) for i in open_invoices)

        # Failed payments — recent failed charges as a proxy for at-risk
        failed_recent = [c for c in ch_recent if c.get("status") == "failed"]

        snap = {
            "ok": True,
            "as_of": now.isoformat(timespec="seconds"),
            "mrr_dollars": _cents_to_dollars(mrr_cents),
            "active_subscriptions": len(active_subs),
            "new_subscribers_7d": len(new_7d),
            "revenue_30d_dollars": _cents_to_dollars(rev_recent),
            "revenue_prev_30d_dollars": _cents_to_dollars(rev_prev),
            "revenue_trend_pct": trend_pct,
            "churned_30d": len(canceled_recent),
            "outstanding_invoices_count": len(open_invoices),
            "outstanding_invoices_dollars": _cents_to_dollars(outstanding_cents),
            "failed_payments_30d": len(failed_recent),
        }
        bits = [
            f"MRR ${snap['mrr_dollars']:,.0f} across "
            f"{snap['active_subscriptions']} active subs",
        ]
        if snap["new_subscribers_7d"]:
            bits.append(f"{snap['new_subscribers_7d']} new this week")
        if trend_pct is not None:
            arrow = "↑" if trend_pct >= 0 else "↓"
            bits.append(f"30d revenue {arrow}{abs(trend_pct)}%")
        if snap["churned_30d"]:
            bits.append(f"{snap['churned_30d']} churned (30d)")
        if snap["failed_payments_30d"]:
            bits.append(f"{snap['failed_payments_30d']} failed payments")
        if snap["outstanding_invoices_count"]:
            bits.append(
                f"${snap['outstanding_invoices_dollars']:,.0f} outstanding "
                f"on {snap['outstanding_invoices_count']} invoices"
            )
        snap["voice_summary"] = " · ".join(bits)
        return snap

    return _cached_or("dashboard", _build, ttl_s=CACHE_TTL_S)


# ── PUBLIC: stripe_customers ──────────────────────────────────────────
def stripe_customers(status: str = "active", limit: int = 20) -> dict:
    """List customers ranked by MRR contribution. status filters the
    underlying subscription query — `all` returns everyone with any sub
    history."""
    gate = _gate_check()
    if gate:
        return gate
    status = (status or "active").strip().lower()
    if status not in ("active", "past_due", "canceled", "trialing", "all"):
        return {"error": f"unknown status: {status}"}

    sub_params = {"expand[]": "data.items.data.price.product",
                  "expand[]2": "data.customer"}
    # Stripe doesn't accept duplicate keys via urlencode-doseq the way we'd want,
    # so we pass expand without trying to nest two distinct paths in one call.
    sub_params = {"expand[]": "data.items.data.price.product"}
    if status != "all":
        sub_params["status"] = status
    subs = _list_all("subscriptions", sub_params)

    by_cust: dict[str, dict[str, Any]] = {}
    for s in subs:
        cid = s.get("customer")
        if isinstance(cid, dict):
            cid = cid.get("id")
        if not cid:
            continue
        entry = by_cust.setdefault(cid, {
            "id": cid,
            "mrr_cents": 0,
            "plan_labels": [],
            "subscription_ids": [],
            "statuses": [],
            "created": s.get("created"),
        })
        entry["mrr_cents"] += _sub_mrr_cents(s) if s.get("status") in ("active", "trialing", "past_due") else 0
        entry["plan_labels"].append(_sub_plan_label(s))
        entry["subscription_ids"].append(s.get("id"))
        entry["statuses"].append(s.get("status"))
        if s.get("created") and (entry["created"] is None
                                 or int(s["created"]) < int(entry["created"])):
            entry["created"] = s["created"]

    customers: list[dict] = []
    for cid, entry in by_cust.items():
        c = _stripe_get(f"customers/{cid}")
        if c.get("error"):
            continue
        # Last payment — fetch one charge to populate "last_payment_at"
        charges = _stripe_get("charges", {"customer": cid, "limit": 1})
        last_paid = None
        if isinstance(charges, dict) and charges.get("data"):
            last_paid = (charges["data"][0] or {}).get("created")
        customers.append({
            "id": cid,
            "name": c.get("name") or "",
            "email": c.get("email") or "",
            "plan": " / ".join(sorted(set(p for p in entry["plan_labels"] if p))) or "—",
            "subscription_status": ", ".join(sorted(set(entry["statuses"]))),
            "mrr_dollars": _cents_to_dollars(entry["mrr_cents"]),
            "created": _ts_iso(entry["created"]),
            "last_payment_at": _ts_iso(last_paid),
        })

    customers.sort(key=lambda r: r["mrr_dollars"], reverse=True)
    return {
        "ok": True,
        "status_filter": status,
        "count": len(customers),
        "customers": customers[: max(1, int(limit))],
    }


# ── PUBLIC: stripe_customer (single deep dive) ────────────────────────
def _resolve_customer(name_or_email: str) -> dict | None:
    """Fuzzy match against Stripe. Email exact > email substring > name."""
    if not name_or_email:
        return None
    needle = name_or_email.strip().lower()

    # Try the search API first when the key looks like an email — it's
    # exact and cheap. Falls through to scan-and-filter on free names.
    if "@" in needle:
        rec = _stripe_get("customers/search", {"query": f"email:'{needle}'"})
        items = (rec or {}).get("data") or []
        if items:
            return items[0]

    rec = _stripe_get("customers", {"email": needle, "limit": 5})
    items = (rec or {}).get("data") or []
    if items:
        return items[0]

    # Scan recent customers (capped) for fuzzy name/email substring match
    customers = _list_all("customers", {"limit": LIST_PAGE_SIZE}, max_pages=2)
    for c in customers:
        name = (c.get("name") or "").lower()
        email = (c.get("email") or "").lower()
        if needle in name or needle in email:
            return c
    # Last resort: try Stripe's search-by-name (only on accounts where
    # the search index has been enabled — silent if it 404s)
    rec = _stripe_get("customers/search", {"query": f"name~'{needle}'"})
    items = (rec or {}).get("data") or []
    return items[0] if items else None


def stripe_customer(name_or_email: str) -> dict:
    """Full history for one customer."""
    gate = _gate_check()
    if gate:
        return gate
    if not name_or_email:
        return {"error": "name_or_email is required"}

    cust = _resolve_customer(name_or_email)
    if not cust:
        return {"ok": False, "found": False, "query": name_or_email}
    cid = cust["id"]

    subs = _list_all("subscriptions",
                     {"customer": cid, "status": "all",
                      "expand[]": "data.items.data.price.product"})
    charges = _list_all("charges", {"customer": cid}, max_pages=3)
    refunds = _list_all("refunds", {}, max_pages=1)
    refunds = [r for r in refunds
               if r.get("charge") in {c.get("id") for c in charges}]
    disputes = _list_all("disputes", {}, max_pages=1)
    disputes = [d for d in disputes
                if d.get("charge") in {c.get("id") for c in charges}]
    invoices = _list_all("invoices", {"customer": cid}, max_pages=2)

    succeeded = [c for c in charges if c.get("status") == "succeeded" and not c.get("refunded")]
    failed = [c for c in charges if c.get("status") == "failed"]
    ltv_cents = sum(int(c.get("amount") or 0) for c in succeeded)
    avg_cents = (ltv_cents // len(succeeded)) if succeeded else 0
    total_attempts = len(charges)
    success_rate = round(len(succeeded) / total_attempts, 3) if total_attempts else None

    # Reliability: success rate weighted, drop chargebacks count heavily
    reliability = success_rate if success_rate is not None else 0.0
    reliability -= 0.1 * len(disputes)
    reliability = max(0.0, min(1.0, reliability))

    return {
        "ok": True,
        "found": True,
        "id": cid,
        "name": cust.get("name"),
        "email": cust.get("email"),
        "created": _ts_iso(cust.get("created")),
        "delinquent": bool(cust.get("delinquent")),
        "currency": cust.get("currency"),
        "subscriptions": [
            {
                "id": s.get("id"),
                "status": s.get("status"),
                "plan": _sub_plan_label(s),
                "mrr_dollars": _cents_to_dollars(_sub_mrr_cents(s))
                    if s.get("status") in ("active", "trialing", "past_due") else 0.0,
                "started": _ts_iso(s.get("start_date") or s.get("created")),
                "current_period_end": _ts_iso(s.get("current_period_end")),
                "cancel_at_period_end": bool(s.get("cancel_at_period_end")),
                "canceled_at": _ts_iso(s.get("canceled_at")),
            } for s in subs
        ],
        "lifetime_value_dollars": _cents_to_dollars(ltv_cents),
        "average_payment_dollars": _cents_to_dollars(avg_cents),
        "payments_succeeded": len(succeeded),
        "payments_failed": len(failed),
        "refunds": [
            {"id": r.get("id"), "amount": _cents_to_dollars(r.get("amount")),
             "reason": r.get("reason"), "created": _ts_iso(r.get("created"))}
            for r in refunds
        ],
        "disputes": [
            {"id": d.get("id"), "status": d.get("status"),
             "reason": d.get("reason"),
             "amount": _cents_to_dollars(d.get("amount")),
             "created": _ts_iso(d.get("created"))}
            for d in disputes
        ],
        "outstanding_invoices": [
            {"id": i.get("id"), "amount_due": _cents_to_dollars(i.get("amount_due")),
             "due_date": _ts_iso(i.get("due_date")), "status": i.get("status")}
            for i in invoices
            if i.get("status") in ("open", "past_due", "uncollectible")
        ],
        "reliability_score": round(reliability, 3),
    }


# ── PUBLIC: stripe_revenue ────────────────────────────────────────────
def stripe_revenue(period: str = "month") -> dict:
    """Aggregate revenue by period. period ∈ {day, week, month}."""
    gate = _gate_check()
    if gate:
        return gate
    period = (period or "month").strip().lower()
    if period not in ("day", "week", "month"):
        return {"error": f"unknown period: {period}"}

    # 6 buckets back at the chosen cadence
    now = datetime.now(tz=timezone.utc)
    if period == "day":
        delta = timedelta(days=1)
        buckets = 14
    elif period == "week":
        delta = timedelta(days=7)
        buckets = 8
    else:
        delta = timedelta(days=30)
        buckets = 6

    span_start = int((now - delta * buckets).timestamp())
    charges = _list_all(
        "charges",
        {"created[gte]": span_start, "limit": LIST_PAGE_SIZE},
        max_pages=5,
    )
    succeeded = [c for c in charges if c.get("status") == "succeeded" and not c.get("refunded")]

    series: list[dict] = []
    for i in range(buckets, 0, -1):
        bstart = now - delta * i
        bend = now - delta * (i - 1)
        bs = int(bstart.timestamp())
        be = int(bend.timestamp())
        in_bucket = [c for c in succeeded
                     if bs <= int(c.get("created") or 0) < be]
        series.append({
            "from": bstart.isoformat(timespec="seconds"),
            "to": bend.isoformat(timespec="seconds"),
            "revenue_dollars": _cents_to_dollars(
                sum(int(c.get("amount") or 0) for c in in_bucket)
            ),
            "transactions": len(in_bucket),
        })

    # Plan / product breakdown — cheapest signal is to scan active subs
    # and weight them by their MRR contribution.
    subs = _list_all("subscriptions",
                     {"status": "active",
                      "expand[]": "data.items.data.price.product"})
    by_plan: dict[str, int] = {}
    for s in subs:
        label = _sub_plan_label(s)
        by_plan[label] = by_plan.get(label, 0) + _sub_mrr_cents(s)
    plan_breakdown = [
        {"plan": k, "mrr_dollars": _cents_to_dollars(v)}
        for k, v in sorted(by_plan.items(), key=lambda kv: -kv[1])
    ]

    # Growth rate: compare last bucket vs prior bucket's revenue
    growth_pct: float | None = None
    if len(series) >= 2 and series[-2]["revenue_dollars"]:
        last = series[-1]["revenue_dollars"]
        prev = series[-2]["revenue_dollars"]
        growth_pct = round((last - prev) / prev * 100.0, 1)

    return {
        "ok": True,
        "period": period,
        "buckets": series,
        "plan_breakdown": plan_breakdown,
        "growth_pct_last_bucket": growth_pct,
        "total_dollars": _cents_to_dollars(
            sum(int(c.get("amount") or 0) for c in succeeded)
        ),
    }


# ── PUBLIC: stripe_alerts ─────────────────────────────────────────────
def stripe_alerts() -> dict:
    """Return + enqueue proactive revenue signals.

    Returned alerts:
      * failed_payments       — failed charges in last 7 days
      * past_due              — subscriptions in past_due status
      * expiring_soon         — subs ending within 7 days that aren't auto-renewing
      * signup_anomaly        — week-over-week signup spike or drop > 50%
      * at_risk_customers     — recently failed + previously reliable
    """
    gate = _gate_check()
    if gate:
        return gate

    now = datetime.now(tz=timezone.utc)
    seven_ago = int((now - timedelta(days=7)).timestamp())
    fourteen_ago = int((now - timedelta(days=14)).timestamp())
    in_seven = int((now + timedelta(days=7)).timestamp())

    alerts: dict[str, list[dict]] = {
        "failed_payments": [],
        "past_due": [],
        "expiring_soon": [],
        "at_risk_customers": [],
    }

    failed = _list_all(
        "charges",
        {"created[gte]": seven_ago, "limit": LIST_PAGE_SIZE},
        max_pages=2,
    )
    failed = [c for c in failed if c.get("status") == "failed"]
    for c in failed:
        cid = c.get("customer")
        cust = _stripe_get(f"customers/{cid}") if cid else {}
        alerts["failed_payments"].append({
            "charge_id": c.get("id"),
            "customer_id": cid,
            "customer_name": cust.get("name") or "",
            "customer_email": cust.get("email") or "",
            "amount_dollars": _cents_to_dollars(c.get("amount")),
            "failure_message": (c.get("failure_message") or "")[:200],
            "created": _ts_iso(c.get("created")),
        })

    past_due_subs = _list_all("subscriptions", {"status": "past_due"})
    for s in past_due_subs:
        cid = s.get("customer")
        cust = _stripe_get(f"customers/{cid}") if cid else {}
        alerts["past_due"].append({
            "subscription_id": s.get("id"),
            "customer_name": cust.get("name") or "",
            "customer_email": cust.get("email") or "",
            "plan": _sub_plan_label(s),
            "mrr_dollars": _cents_to_dollars(_sub_mrr_cents(s)),
        })

    active = _list_all("subscriptions",
                       {"status": "active",
                        "expand[]": "data.items.data.price.product"})
    for s in active:
        if not s.get("cancel_at_period_end"):
            continue
        end = int(s.get("current_period_end") or 0)
        if 0 < end <= in_seven:
            cid = s.get("customer")
            cust = _stripe_get(f"customers/{cid}") if cid else {}
            alerts["expiring_soon"].append({
                "subscription_id": s.get("id"),
                "customer_name": cust.get("name") or "",
                "customer_email": cust.get("email") or "",
                "plan": _sub_plan_label(s),
                "ends": _ts_iso(end),
            })

    # Signup anomaly — compare last 7d to prior 7d
    new_subs_7d = [s for s in active if int(s.get("created") or 0) >= seven_ago]
    new_subs_prior = [s for s in active
                      if fourteen_ago <= int(s.get("created") or 0) < seven_ago]
    anomaly = None
    if len(new_subs_prior) >= 2 or len(new_subs_7d) >= 2:
        prev = max(1, len(new_subs_prior))
        change = (len(new_subs_7d) - prev) / prev * 100.0
        if abs(change) >= 50:
            anomaly = {
                "kind": "spike" if change > 0 else "drop",
                "change_pct": round(change, 1),
                "current_7d": len(new_subs_7d),
                "previous_7d": len(new_subs_prior),
            }

    # At-risk: customers whose last charge failed but who have a history of
    # successful payments. Heuristic but cheap.
    seen_at_risk: set[str] = set()
    for f in alerts["failed_payments"]:
        cid = f.get("customer_id")
        if not cid or cid in seen_at_risk:
            continue
        prior = _stripe_get("charges", {"customer": cid, "limit": 5})
        prior_data = (prior or {}).get("data") or []
        succeeded_count = sum(
            1 for x in prior_data
            if x.get("status") == "succeeded" and not x.get("refunded")
        )
        if succeeded_count >= 2:
            alerts["at_risk_customers"].append({
                "customer_id": cid,
                "customer_name": f.get("customer_name"),
                "customer_email": f.get("customer_email"),
                "prior_successful_payments": succeeded_count,
                "last_failure": f.get("created"),
            })
            seen_at_risk.add(cid)

    if anomaly:
        alerts["signup_anomaly"] = [anomaly]

    # Push high-signal items into the smart-notification bus.
    _enqueue_alerts(alerts)
    return {
        "ok": True,
        "as_of": now.isoformat(timespec="seconds"),
        **alerts,
    }


def _enqueue_alerts(alerts: dict) -> None:
    """Best-effort fan-out to the notification bus. Silent on every failure."""
    src = BIN_DIR / "jarvis-notifications.py"
    if not src.exists():
        src = Path(__file__).parent / "jarvis-notifications.py"
    if not src.exists():
        return
    try:
        spec = importlib.util.spec_from_file_location("jarvis_notifications_stripe", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
    except Exception:
        return
    state_path = STRIPE_DIR / "alerted.json"
    seen: set[str] = set()
    if state_path.exists():
        try:
            seen = set(json.loads(state_path.read_text(encoding="utf-8")) or [])
        except Exception:
            seen = set()

    def _push(key: str, content: str, sender: str | None,
              keywords: list[str], time_sens: int) -> None:
        if key in seen:
            return
        try:
            mod.enqueue(
                source="stripe", content=content, sender=sender,
                urgency_keywords=keywords, time_sensitivity=time_sens,
            )
            seen.add(key)
        except Exception:
            pass

    for f in alerts.get("failed_payments") or []:
        key = f"failed:{f.get('charge_id')}"
        sender = f.get("customer_name") or f.get("customer_email") or ""
        content = (
            f"Payment failed: {sender or 'unknown customer'} "
            f"(${f.get('amount_dollars')}). {f.get('failure_message', '')}"
        )
        _push(key, content, sender, ["urgent", "blocking"], 2)

    for d in alerts.get("expiring_soon") or []:
        key = f"expire:{d.get('subscription_id')}"
        sender = d.get("customer_name") or d.get("customer_email") or ""
        content = (
            f"Subscription expiring soon: {sender} on {d.get('plan')} "
            f"ends {d.get('ends', '')}."
        )
        _push(key, content, sender, ["soon", "follow up"], 1)

    for a in alerts.get("signup_anomaly") or []:
        key = f"anomaly:{a.get('kind')}:{a.get('change_pct')}"
        kind_label = "Signup spike" if a.get("kind") == "spike" else "Signup drop"
        content = (
            f"{kind_label}: {a.get('change_pct')}% change "
            f"({a.get('current_7d')} this week vs {a.get('previous_7d')} prior)."
        )
        _push(key, content, None, ["heads up"], 1)

    try:
        STRIPE_DIR.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps(sorted(seen)), encoding="utf-8")
    except Exception:
        pass


# ── briefing + context surface ────────────────────────────────────────
def briefing_section() -> str:
    """Markdown block for the morning briefing. Empty when revenue data
    looks too sparse to surface (no MRR, no new subs, no failed payments
    — keeps the briefing clean for accounts not yet wired up)."""
    if _gate_check():
        return ""
    snap = stripe_dashboard()
    if not snap.get("ok"):
        return ""
    if not (snap.get("mrr_dollars") or snap.get("new_subscribers_7d")
            or snap.get("failed_payments_30d")):
        return ""
    lines = [
        "## Revenue",
        f"- **MRR:** ${snap['mrr_dollars']:,.2f} "
        f"({snap['active_subscriptions']} active subscriptions)",
    ]
    if snap.get("new_subscribers_7d"):
        lines.append(f"- **New this week:** {snap['new_subscribers_7d']}")
    if snap.get("revenue_trend_pct") is not None:
        arrow = "↑" if snap["revenue_trend_pct"] >= 0 else "↓"
        lines.append(
            f"- **30d revenue:** ${snap['revenue_30d_dollars']:,.2f} "
            f"({arrow}{abs(snap['revenue_trend_pct'])}%)"
        )
    if snap.get("failed_payments_30d"):
        lines.append(f"- **Failed payments (30d):** {snap['failed_payments_30d']}")
    if snap.get("churned_30d"):
        lines.append(f"- **Churned (30d):** {snap['churned_30d']}")
    if snap.get("outstanding_invoices_count"):
        lines.append(
            f"- **Outstanding:** ${snap['outstanding_invoices_dollars']:,.2f} "
            f"on {snap['outstanding_invoices_count']} invoices"
        )
    return "\n".join(lines) + "\n"


def context_hint(mentioned_names: list[str] | None = None) -> str:
    """One-liner for jarvis-context when a Stripe customer is named."""
    if _gate_check() or not mentioned_names:
        return ""
    for nm in mentioned_names[:2]:
        rec = stripe_customer(nm)
        if not rec.get("ok") or not rec.get("found"):
            continue
        active = [s for s in (rec.get("subscriptions") or [])
                  if s.get("status") in ("active", "trialing", "past_due")]
        if not active:
            continue
        plan = active[0].get("plan", "—")
        mrr = active[0].get("mrr_dollars", 0)
        status = active[0].get("status", "—")
        return (
            f"**Stripe — {rec.get('name') or nm}:** {plan} "
            f"(${mrr:.0f}/mo, {status}, LTV ${rec.get('lifetime_value_dollars', 0):.0f})."
        )
    return ""


def customer_for_contact(name_or_email: str) -> dict:
    """Cheap shape for jarvis-network to pull subscription metadata onto a
    contact record. Returns {found, customer_since, plan, mrr_dollars,
    ltv_dollars, status} or {found: False}."""
    if _gate_check():
        return {"found": False, "error": "stripe disabled"}
    if not name_or_email:
        return {"found": False}
    rec = stripe_customer(name_or_email)
    if not rec.get("ok") or not rec.get("found"):
        return {"found": False}
    active = [s for s in (rec.get("subscriptions") or [])
              if s.get("status") in ("active", "trialing", "past_due")]
    chosen = active[0] if active else (rec.get("subscriptions") or [None])[0]
    return {
        "found": True,
        "customer_id": rec.get("id"),
        "customer_since": rec.get("created"),
        "plan": (chosen or {}).get("plan"),
        "mrr_dollars": (chosen or {}).get("mrr_dollars", 0.0),
        "ltv_dollars": rec.get("lifetime_value_dollars", 0.0),
        "status": (chosen or {}).get("status"),
        "delinquent": rec.get("delinquent", False),
        "reliability_score": rec.get("reliability_score"),
    }


# ── CLI ────────────────────────────────────────────────────────────────
def _cli() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("dashboard")
    pc = sub.add_parser("customers")
    pc.add_argument("--status", default="active")
    pc.add_argument("--limit", type=int, default=20)

    pcust = sub.add_parser("customer")
    pcust.add_argument("name_or_email")

    pr = sub.add_parser("revenue")
    pr.add_argument("--period", default="month")

    sub.add_parser("alerts")
    sub.add_parser("briefing")

    args = parser.parse_args()
    cmd = args.cmd or "dashboard"

    if cmd == "dashboard":
        out = stripe_dashboard()
    elif cmd == "customers":
        out = stripe_customers(status=args.status, limit=args.limit)
    elif cmd == "customer":
        out = stripe_customer(args.name_or_email)
    elif cmd == "revenue":
        out = stripe_revenue(period=args.period)
    elif cmd == "alerts":
        out = stripe_alerts()
    elif cmd == "briefing":
        print(briefing_section())
        return 0
    else:
        parser.print_help()
        return 2
    print(json.dumps(out, indent=2, ensure_ascii=False, default=str))
    return 0 if (isinstance(out, dict) and not out.get("error")) else 1


if __name__ == "__main__":
    sys.exit(_cli())
