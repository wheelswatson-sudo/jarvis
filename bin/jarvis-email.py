#!/usr/bin/env python3
"""Email agent for Jarvis — read, draft, send, reply via Gmail API.

Functions exposed (all return JSON-serializable dicts so jarvis-think.py
can wire them straight into the tool layer):

    check_email(max_results=5, query="is:unread") → list of summaries
    draft_email(to, subject, body)                → {draft_id, ...}
    list_drafts(max_results=5)                    → list of drafts
    send_email(draft_id=None, to/subject/body=…)  → {sent: True}
    reply_email(thread_id, body)                  → {sent: True}

Auth — first run requires browser-based OAuth:

    bin/jarvis-email.py --auth

Setup expected at ~/.jarvis/credentials/oauth_client.json (download from
Google Cloud Console → "Desktop app" OAuth client). Token gets stored at
~/.jarvis/credentials/google.json with both Gmail + Calendar scopes — the
calendar agent (bin/jarvis-calendar.py) reads the same file.

Dependencies (single pip command, both agents):
    pip install google-api-python-client google-auth-httplib2 \\
                google-auth-oauthlib --break-system-packages

Missing libraries / no auth → every function returns {"error": "..."}.
The voice loop never breaks; the model just gets a structured error.

Gate: JARVIS_EMAIL=1 (default 1).
"""
from __future__ import annotations

import base64
import json
import os
import sys
from email.mime.text import MIMEText
from pathlib import Path

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
CRED_DIR = ASSISTANT_DIR / "credentials"
OAUTH_CLIENT_FILE = CRED_DIR / "oauth_client.json"
TOKEN_FILE = CRED_DIR / "google.json"

# Gmail + Calendar in a single grant — one consent screen, both agents work.
SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
]


def _try_import_google():
    """Lazy import — google-api-python-client is heavy. Returns the bag of
    handles or None on any failure. Each call to get_service() reuses cached
    credentials, so the import cost is paid once per process."""
    try:
        from google.oauth2.credentials import Credentials  # type: ignore
        from google_auth_oauthlib.flow import InstalledAppFlow  # type: ignore
        from google.auth.transport.requests import Request  # type: ignore
        from googleapiclient.discovery import build  # type: ignore
        from googleapiclient.errors import HttpError  # type: ignore
        return {
            "Credentials": Credentials,
            "InstalledAppFlow": InstalledAppFlow,
            "Request": Request,
            "build": build,
            "HttpError": HttpError,
        }
    except ImportError as e:
        sys.stderr.write(
            f"jarvis-email: google-api-python-client missing ({e})\n"
            "  pip install google-api-python-client google-auth-httplib2 "
            "google-auth-oauthlib --break-system-packages\n"
        )
        return None


def _load_credentials():
    """Load saved token, refresh if expired. Returns Credentials or None."""
    g = _try_import_google()
    if g is None or not TOKEN_FILE.exists():
        return None
    try:
        creds = g["Credentials"].from_authorized_user_file(str(TOKEN_FILE), SCOPES)
    except Exception as e:
        sys.stderr.write(f"jarvis-email: token load failed ({e})\n")
        return None
    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(g["Request"]())
            TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
        except Exception as e:
            sys.stderr.write(f"jarvis-email: token refresh failed ({e})\n")
            return None
    if creds and creds.valid:
        return creds
    return None


def authorize() -> bool:
    """Run the InstalledAppFlow — opens a browser tab. Saves token to disk.
    Idempotent: re-running just refreshes the existing token if it's stale."""
    g = _try_import_google()
    if g is None:
        return False
    if not OAUTH_CLIENT_FILE.exists():
        sys.stderr.write(
            f"jarvis-email: missing client secrets at {OAUTH_CLIENT_FILE}\n"
            "  Download from Google Cloud Console → APIs & Services → "
            "Credentials → 'Desktop app' OAuth client. Save as oauth_client.json.\n"
        )
        return False
    CRED_DIR.mkdir(parents=True, exist_ok=True)
    flow = g["InstalledAppFlow"].from_client_secrets_file(
        str(OAUTH_CLIENT_FILE), SCOPES,
    )
    creds = flow.run_local_server(port=0)
    TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
    print(f"Authorized. Token saved to {TOKEN_FILE}", flush=True)
    return True


def _gmail_service():
    g = _try_import_google()
    if g is None:
        return None, None
    creds = _load_credentials()
    if creds is None:
        return None, g
    try:
        return g["build"]("gmail", "v1", credentials=creds, cache_discovery=False), g
    except Exception as e:
        sys.stderr.write(f"jarvis-email: gmail service build failed ({e})\n")
        return None, g


def _gate_check() -> dict | None:
    if os.environ.get("JARVIS_EMAIL", "1") != "1":
        return {"error": "email is disabled (JARVIS_EMAIL=0)"}
    return None


def _decode_header(headers: list, name: str) -> str:
    for h in headers or []:
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def _summarize_message(svc, message_id: str) -> dict:
    msg = svc.users().messages().get(
        userId="me", id=message_id, format="metadata",
        metadataHeaders=["From", "Subject", "Date"],
    ).execute()
    payload = msg.get("payload", {})
    headers = payload.get("headers", [])
    return {
        "id": message_id,
        "thread_id": msg.get("threadId"),
        "from": _decode_header(headers, "From"),
        "subject": _decode_header(headers, "Subject"),
        "date": _decode_header(headers, "Date"),
        "snippet": msg.get("snippet", "")[:200],
        "unread": "UNREAD" in (msg.get("labelIds") or []),
    }


def check_email(max_results: int = 5, query: str = "is:unread") -> dict:
    """Fetch and summarize the latest matching messages."""
    gate = _gate_check()
    if gate:
        return gate
    svc, _ = _gmail_service()
    if svc is None:
        return {"error": "gmail service unavailable — run `jarvis-email --auth`"}
    try:
        resp = svc.users().messages().list(
            userId="me", q=query, maxResults=max(1, min(int(max_results), 25)),
        ).execute()
    except Exception as e:
        return {"error": f"list failed: {e}"}
    msgs = resp.get("messages", []) or []
    summaries = []
    for m in msgs:
        try:
            summaries.append(_summarize_message(svc, m["id"]))
        except Exception as e:
            summaries.append({"id": m.get("id"), "error": str(e)})
    return {"count": len(summaries), "query": query, "messages": summaries}


def _build_raw(to: str, subject: str, body: str,
               in_reply_to: str | None = None,
               references: str | None = None) -> str:
    msg = MIMEText(body)
    msg["To"] = to
    msg["Subject"] = subject
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
    if references:
        msg["References"] = references
    return base64.urlsafe_b64encode(msg.as_bytes()).decode()


def draft_email(to: str, subject: str, body: str,
                thread_id: str | None = None) -> dict:
    """Save a draft. Returns the draft_id so a follow-up send_email can
    pick it up after the user confirms."""
    gate = _gate_check()
    if gate:
        return gate
    if not (to and subject and body):
        return {"error": "to, subject, body all required"}
    svc, _ = _gmail_service()
    if svc is None:
        return {"error": "gmail service unavailable — run `jarvis-email --auth`"}
    raw = _build_raw(to, subject, body)
    msg_body: dict = {"message": {"raw": raw}}
    if thread_id:
        msg_body["message"]["threadId"] = thread_id
    try:
        d = svc.users().drafts().create(userId="me", body=msg_body).execute()
    except Exception as e:
        return {"error": f"draft create failed: {e}"}
    return {
        "draft_id": d.get("id"),
        "message_id": (d.get("message") or {}).get("id"),
        "to": to,
        "subject": subject,
        "preview": body[:200],
    }


def list_drafts(max_results: int = 5) -> dict:
    gate = _gate_check()
    if gate:
        return gate
    svc, _ = _gmail_service()
    if svc is None:
        return {"error": "gmail service unavailable — run `jarvis-email --auth`"}
    try:
        resp = svc.users().drafts().list(
            userId="me", maxResults=max(1, min(int(max_results), 25)),
        ).execute()
    except Exception as e:
        return {"error": f"list drafts failed: {e}"}
    drafts = []
    for d in resp.get("drafts", []) or []:
        try:
            full = svc.users().drafts().get(userId="me", id=d["id"], format="metadata",
                                             metadataHeaders=["To", "Subject"]).execute()
            headers = ((full.get("message") or {}).get("payload") or {}).get("headers", [])
            drafts.append({
                "draft_id": d["id"],
                "to": _decode_header(headers, "To"),
                "subject": _decode_header(headers, "Subject"),
            })
        except Exception as e:
            drafts.append({"draft_id": d.get("id"), "error": str(e)})
    return {"count": len(drafts), "drafts": drafts}


def send_email(draft_id: str | None = None,
               to: str | None = None, subject: str | None = None,
               body: str | None = None,
               confirm: bool = False) -> dict:
    """Send a previously-saved draft, OR construct + send in one call.

    Voice-confirmation guard: if `confirm` is not True the call refuses with
    a message Claude can read back asking the user to confirm. That keeps
    the model from sending mail without an explicit user yes."""
    gate = _gate_check()
    if gate:
        return gate
    if not confirm:
        return {
            "sent": False,
            "needs_confirmation": True,
            "hint": "User must say 'yes' / 'send it' before this fires. "
                    "Re-call with confirm=true.",
        }
    svc, _ = _gmail_service()
    if svc is None:
        return {"error": "gmail service unavailable — run `jarvis-email --auth`"}
    try:
        if draft_id:
            sent = svc.users().drafts().send(
                userId="me", body={"id": draft_id},
            ).execute()
            return {"sent": True, "message_id": sent.get("id"), "thread_id": sent.get("threadId")}
        if not (to and subject and body):
            return {"error": "draft_id OR (to, subject, body) required"}
        raw = _build_raw(to, subject, body)
        sent = svc.users().messages().send(
            userId="me", body={"raw": raw},
        ).execute()
        return {"sent": True, "message_id": sent.get("id"), "thread_id": sent.get("threadId")}
    except Exception as e:
        return {"error": f"send failed: {e}"}


def reply_email(thread_id: str, body: str, confirm: bool = False) -> dict:
    """Reply to an existing thread. Same confirm guard as send_email."""
    gate = _gate_check()
    if gate:
        return gate
    if not confirm:
        return {
            "sent": False,
            "needs_confirmation": True,
            "hint": "Re-call with confirm=true after Watson says yes.",
        }
    svc, _ = _gmail_service()
    if svc is None:
        return {"error": "gmail service unavailable — run `jarvis-email --auth`"}
    try:
        thread = svc.users().threads().get(
            userId="me", id=thread_id, format="metadata",
            metadataHeaders=["From", "Subject", "Message-Id", "References"],
        ).execute()
    except Exception as e:
        return {"error": f"thread fetch failed: {e}"}
    msgs = thread.get("messages") or []
    if not msgs:
        return {"error": "thread has no messages"}
    last = msgs[-1]
    headers = (last.get("payload") or {}).get("headers", [])
    sender = _decode_header(headers, "From")
    subj = _decode_header(headers, "Subject")
    if not subj.lower().startswith("re:"):
        subj = "Re: " + subj
    msg_id = _decode_header(headers, "Message-Id")
    refs = _decode_header(headers, "References")
    new_refs = (refs + " " + msg_id).strip() if refs else msg_id
    raw = _build_raw(sender, subj, body, in_reply_to=msg_id, references=new_refs)
    try:
        sent = svc.users().messages().send(
            userId="me", body={"raw": raw, "threadId": thread_id},
        ).execute()
        return {"sent": True, "message_id": sent.get("id"), "thread_id": thread_id}
    except Exception as e:
        return {"error": f"reply send failed: {e}"}


def _cli() -> int:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        sys.stdout.write(__doc__ or "")
        return 0
    if args[0] == "--auth":
        return 0 if authorize() else 1
    if args[0] == "--check":
        print(json.dumps(check_email(), indent=2))
        return 0
    sys.stderr.write(f"unknown command: {args[0]}\n")
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
