#!/usr/bin/env python3
"""
Sync local Jarvis data into the Supabase Postgres database.

Sources (read):
  ~/.jarvis/contacts/people.json     — canonical contact map (Apple + Apollo)
  ~/.jarvis/interactions/*.json      — message/email logs (stub; not wired yet)

Sinks (write):
  contacts                           — upsert on (user_id, email) then (user_id, phone)
  interactions                       — append-only (stub for now)

Auth:
  SUPABASE_URL                       — required
  SUPABASE_SERVICE_ROLE_KEY          — preferred; bypasses RLS so we can write
                                       on behalf of any user_id
  SUPABASE_ANON_KEY                  — fallback; only writes if a user session
                                       is already active (not the case for cron)
  JARVIS_USER_ID                     — UUID of the auth.users row that owns
                                       these contacts; required because
                                       contacts.user_id is NOT NULL with RLS

Usage:
  jarvis-supabase-sync.py                       # dry-run, prints planned ops
  jarvis-supabase-sync.py --live                # actually writes
  jarvis-supabase-sync.py --live --limit 5      # smoke-test with 5 contacts
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

HOME = Path.home()
PEOPLE_JSON = HOME / ".jarvis" / "contacts" / "people.json"
ENV_FILE = HOME / ".jarvis" / "config" / ".env"
INTERACTIONS_DIR = HOME / ".jarvis" / "interactions"


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def get_client():
    from supabase import create_client

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get(
        "SUPABASE_ANON_KEY"
    )
    if not url or not key:
        sys.exit(
            "ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (preferred) "
            "or SUPABASE_ANON_KEY in ~/.jarvis/config/.env"
        )
    if "SUPABASE_SERVICE_ROLE_KEY" not in os.environ:
        print(
            "WARN: using anon key — RLS will block writes unless a user "
            "session is active. Set SUPABASE_SERVICE_ROLE_KEY for cron use.",
            file=sys.stderr,
        )
    return create_client(url, key)


def normalize_phone(p: str | None) -> str | None:
    if not p:
        return None
    digits = "".join(ch for ch in p if ch.isdigit() or ch == "+")
    return digits or None


def normalize_email(e: str | None) -> str | None:
    if not e:
        return None
    e = e.strip().lower()
    return e or None


def split_name(full: str) -> tuple[str, str | None]:
    parts = (full or "").strip().split(None, 1)
    if not parts:
        return "Unknown", None
    if len(parts) == 1:
        return parts[0], None
    return parts[0], parts[1]


def map_contact(person: dict[str, Any]) -> dict[str, Any]:
    """people.json record → contacts row (no user_id; caller adds it)."""
    emails = person.get("emails") or []
    phones = person.get("phones") or []
    email = normalize_email(person.get("email") or (emails[0] if emails else None))
    phone = normalize_phone(person.get("phone") or (phones[0] if phones else None))
    tags = person.get("topics_discussed") or []
    if not isinstance(tags, list):
        tags = []
    full_name = person.get("name") or person.get("canonical_key") or "Unknown"
    first_name, last_name = split_name(full_name)
    return {
        "first_name": first_name,
        "last_name": last_name,
        "email": email,
        "phone": phone,
        "company": person.get("organization"),
        "title": person.get("title"),
        "linkedin_url": person.get("linkedin_url"),
        "tags": tags or None,
        "half_life_days": 30,
        "sentiment_slope": 0.5,
    }


def find_existing(client, user_id: str, email: str | None, phone: str | None):
    """Return existing contact row for this user matching email or phone, else None."""
    if email:
        res = (
            client.table("contacts")
            .select("id,email,phone")
            .eq("user_id", user_id)
            .eq("email", email)
            .limit(1)
            .execute()
        )
        if res.data:
            return res.data[0]
    if phone:
        res = (
            client.table("contacts")
            .select("id,email,phone")
            .eq("user_id", user_id)
            .eq("phone", phone)
            .limit(1)
            .execute()
        )
        if res.data:
            return res.data[0]
    return None


def sync_contacts(client, user_id: str, *, dry_run: bool, limit: int | None) -> dict:
    if not PEOPLE_JSON.exists():
        sys.exit(f"ERROR: {PEOPLE_JSON} not found")

    people = json.loads(PEOPLE_JSON.read_text())
    items = list(people.values())
    if limit:
        items = items[:limit]

    stats = {"total": len(items), "insert": 0, "update": 0, "skip": 0, "error": 0}

    for person in items:
        row = map_contact(person)
        if not row["email"] and not row["phone"]:
            stats["skip"] += 1
            continue

        try:
            existing = (
                None if dry_run else find_existing(client, user_id, row["email"], row["phone"])
            )
        except Exception as e:  # network / auth failure stops the run early
            sys.exit(f"ERROR: select failed for {row['first_name']}: {e}")

        if existing:
            if dry_run:
                pass
            else:
                # Update only fields we have a value for, leave NULLs alone
                patch = {k: v for k, v in row.items() if v is not None}
                client.table("contacts").update(patch).eq("id", existing["id"]).execute()
            stats["update"] += 1
        else:
            payload = {**row, "user_id": user_id}
            if dry_run:
                pass
            else:
                try:
                    client.table("contacts").insert(payload).execute()
                except Exception as e:
                    print(f"  insert failed: {row['first_name']} {row.get('last_name') or ''}: {e}", file=sys.stderr)
                    stats["error"] += 1
                    continue
            stats["insert"] += 1

    return stats


def sync_interactions(client, user_id: str, *, dry_run: bool) -> dict:
    """Stub. Wire up Gmail and iMessage ingestion here.

    Each interaction maps to a row in `interactions`:
      contact_id, channel ('email'|'imessage'|'sms'|'linkedin'|...),
      direction ('inbound'|'outbound'), summary, body, occurred_at
    """
    stats = {"scanned": 0, "insert": 0, "skip": 0}
    if not INTERACTIONS_DIR.exists():
        return stats
    # Placeholder — leaves the real ingestion to a follow-up pass.
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync Jarvis local data → Supabase")
    parser.add_argument("--live", action="store_true", help="actually write (default: dry run)")
    parser.add_argument("--limit", type=int, help="cap number of contacts processed")
    parser.add_argument("--skip-interactions", action="store_true")
    args = parser.parse_args()

    load_dotenv(ENV_FILE)
    user_id = os.environ.get("JARVIS_USER_ID")
    if not user_id:
        sys.exit("ERROR: set JARVIS_USER_ID (auth.users UUID) in env or .env file")

    dry_run = not args.live

    if dry_run:
        print("DRY RUN — no writes. Pass --live to commit.")
        client = None
    else:
        client = get_client()

    print(f"\n[contacts] sync from {PEOPLE_JSON}")
    cstats = sync_contacts(client, user_id, dry_run=dry_run, limit=args.limit)
    print(
        f"  total={cstats['total']} insert={cstats['insert']} "
        f"update={cstats['update']} skip={cstats['skip']} error={cstats['error']}"
    )

    if not args.skip_interactions:
        print(f"\n[interactions] sync from {INTERACTIONS_DIR}")
        istats = sync_interactions(client, user_id, dry_run=dry_run)
        print(f"  scanned={istats['scanned']} insert={istats['insert']} skip={istats['skip']}")

    return 0 if cstats["error"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
