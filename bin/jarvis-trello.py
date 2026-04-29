#!/usr/bin/env python3
"""Trello mirror — sync Jarvis commitments to a Trello board, pull
completion signals back.

Trello is a peripheral, not a source of truth. items.json is canonical.
This module pushes new commitments into a "To Do" list and listens for
cards moved to "Done" so Jarvis can mark the underlying commitment
complete. Sync state lives in ~/.jarvis/commitments/sync_state.json so
we don't repeatedly create the same card.

Stdlib only — urllib + json — so it works on any clean Python install.

Auth (from env, falls back to ~/.jarvis/config/.env if loaded already):
    TRELLO_API_KEY    https://trello.com/app-key
    TRELLO_TOKEN      Personal token from the same page

Setup:
    bin/jarvis-trello.py setup      one-time interactive board pick
    bin/jarvis-trello.py boards     list boards (debug)

Daily ops:
    bin/jarvis-trello.py sync       bidirectional reconciliation
    bin/jarvis-trello.py add "Send proposal" --list todo --due 2026-05-01
    bin/jarvis-trello.py move <card_id> doing
    bin/jarvis-trello.py complete <card_id>

Config file: ~/.jarvis/trello/config.json
    {"board_id": "...", "lists": {"todo": "...", "doing": "...", "done": "..."}}

Gate: JARVIS_TRELLO=1 (also requires TRELLO_API_KEY + TRELLO_TOKEN).
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
TRELLO_DIR = ASSISTANT_DIR / "trello"
CONFIG_FILE = TRELLO_DIR / "config.json"
LOG_DIR = ASSISTANT_DIR / "logs"
TRELLO_LOG = LOG_DIR / "trello.log"
BIN_DIR = Path(__file__).resolve().parent

API_BASE = "https://api.trello.com/1"
DEFAULT_LIST_NAMES = {
    "todo": ["To Do", "Todo", "Backlog", "Up Next"],
    "doing": ["Doing", "In Progress", "Active"],
    "done": ["Done", "Complete", "Completed"],
}

JARVIS_MARKER = "jarvis-id:"  # we embed this in card descriptions


# ── logging / IO ─────────────────────────────────────────────────────
def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with TRELLO_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def _gate_enabled() -> bool:
    return os.environ.get("JARVIS_TRELLO", "1") not in ("0", "false", "no", "off")


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path: Path, data: Any) -> bool:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                       encoding="utf-8")
        tmp.replace(path)
        return True
    except Exception as e:
        _log(f"write {path.name} failed: {e}")
        return False


def _credentials() -> tuple[str, str] | None:
    key = os.environ.get("TRELLO_API_KEY", "").strip()
    tok = os.environ.get("TRELLO_TOKEN", "").strip()
    if key and tok:
        return key, tok
    return None


def _emit(action: str, status: str, context: dict | None = None,
          latency_ms: int | None = None) -> None:
    try:
        sys.path.insert(0, str(ASSISTANT_DIR / "lib"))
        sys.path.insert(0, str(BIN_DIR.parent / "lib"))
        from outcome_ledger import emit  # type: ignore
        emit("trello", action, status, context=context, latency_ms=latency_ms)
    except Exception:
        pass


# ── HTTP ─────────────────────────────────────────────────────────────
def _api(method: str, path: str, params: dict | None = None,
         body: dict | None = None, timeout: float = 15.0) -> Any:
    creds = _credentials()
    if creds is None:
        raise RuntimeError("TRELLO_API_KEY / TRELLO_TOKEN not set")
    key, token = creds
    qp = dict(params or {})
    qp["key"] = key
    qp["token"] = token
    url = f"{API_BASE}{path}?{urllib.parse.urlencode(qp)}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method.upper())
    req.add_header("Accept", "application/json")
    if body:
        req.add_header("Content-Type", "application/json")
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                if not raw:
                    return None
                return json.loads(raw)
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(1 + attempt * 1.5)
                continue
            try:
                detail = e.read().decode("utf-8", "replace")
            except Exception:
                detail = ""
            raise RuntimeError(f"Trello API {e.code}: {detail[:200]}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            if attempt < 2:
                time.sleep(1 + attempt * 1.5)
                continue
            raise RuntimeError(f"Trello network: {e}") from e
    raise RuntimeError(f"Trello unexpected: {last_err}")


# ── config ───────────────────────────────────────────────────────────
def _load_config() -> dict:
    cfg = _read_json(CONFIG_FILE, {})
    return cfg if isinstance(cfg, dict) else {}


def _save_config(cfg: dict) -> bool:
    return _write_json(CONFIG_FILE, cfg)


def trello_boards() -> dict:
    """List Watson's boards. Used by setup and by 'what's on my Trello'."""
    if not _gate_enabled():
        return {"error": "JARVIS_TRELLO=0"}
    if _credentials() is None:
        return {"error": "TRELLO_API_KEY / TRELLO_TOKEN not set"}
    try:
        boards = _api("GET", "/members/me/boards",
                      params={"fields": "name,closed,url,shortUrl",
                              "filter": "open"})
    except RuntimeError as e:
        return {"error": str(e)}
    rows = [{"id": b["id"], "name": b.get("name"), "url": b.get("shortUrl") or b.get("url")}
            for b in (boards or []) if not b.get("closed")]
    return {"ok": True, "boards": rows}


def _board_lists(board_id: str) -> list[dict]:
    return _api("GET", f"/boards/{board_id}/lists",
                params={"fields": "name,closed", "cards": "none"}) or []


def trello_setup(board_id: str | None = None,
                 board_name: str | None = None) -> dict:
    """Pick the default board and map todo/doing/done lists. Without
    args, returns the choice menu Watson can pick from."""
    if not _gate_enabled():
        return {"error": "JARVIS_TRELLO=0"}
    if _credentials() is None:
        return {"error": "TRELLO_API_KEY / TRELLO_TOKEN not set"}

    boards = trello_boards()
    if not boards.get("ok"):
        return boards
    if not board_id and not board_name:
        return {"ok": True, "needs_choice": True, "boards": boards["boards"]}
    if not board_id and board_name:
        match = next((b for b in boards["boards"]
                      if board_name.lower() in (b["name"] or "").lower()), None)
        if not match:
            return {"error": f"no board matched {board_name!r}"}
        board_id = match["id"]

    try:
        lists = _board_lists(board_id)
    except RuntimeError as e:
        return {"error": str(e)}
    open_lists = [l for l in lists if not l.get("closed")]
    mapping: dict[str, str] = {}
    for key, candidates in DEFAULT_LIST_NAMES.items():
        for cand in candidates:
            hit = next((l for l in open_lists
                        if (l.get("name") or "").strip().lower() == cand.lower()),
                       None)
            if hit:
                mapping[key] = hit["id"]
                break
    # Fall back to position order: 1st = todo, 2nd = doing, 3rd = done.
    if "todo" not in mapping and open_lists:
        mapping["todo"] = open_lists[0]["id"]
    if "doing" not in mapping and len(open_lists) >= 2:
        mapping["doing"] = open_lists[1]["id"]
    if "done" not in mapping and len(open_lists) >= 3:
        mapping["done"] = open_lists[-1]["id"]

    cfg = _load_config()
    cfg["board_id"] = board_id
    cfg["lists"] = mapping
    cfg["lists_full"] = [{"id": l["id"], "name": l["name"]} for l in open_lists]
    cfg["configured_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    _save_config(cfg)
    _log(f"setup board={board_id} lists={mapping}")
    return {"ok": True, "board_id": board_id, "lists": mapping,
            "available_lists": cfg["lists_full"]}


# ── commitments bridge ───────────────────────────────────────────────
def _load_commitments_module():
    src = BIN_DIR / "jarvis-commitments.py"
    if not src.exists():
        src = ASSISTANT_DIR / "bin" / "jarvis-commitments.py"
    if not src.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("jarvis_commitments_t", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    except Exception:
        return None


def _commitment_card_desc(commitment: dict) -> str:
    """Embed the canonical id in the card description so we can
    correlate card → commitment on subsequent syncs."""
    parts = [f"{JARVIS_MARKER} {commitment['id']}"]
    if commitment.get("priority") and commitment["priority"] != "medium":
        parts.append(f"priority: {commitment['priority']}")
    if commitment.get("related_contact"):
        parts.append(f"contact: {commitment['related_contact']}")
    if commitment.get("source"):
        src = commitment["source"]
        ctx = src.get("context")
        if ctx:
            parts.append(f"context: {ctx[:200]}")
    if commitment.get("notes"):
        parts.append(f"notes: {commitment['notes'][:300]}")
    return "\n".join(parts)


def _extract_jarvis_id(desc: str) -> str | None:
    if not desc or JARVIS_MARKER not in desc:
        return None
    line = next((l for l in desc.splitlines() if JARVIS_MARKER in l), "")
    after = line.split(JARVIS_MARKER, 1)[1].strip()
    cid = after.split()[0] if after else ""
    return cid if cid.startswith("cmt_") else None


# ── card ops ─────────────────────────────────────────────────────────
def _create_card(list_id: str, name: str, desc: str = "",
                 due: str | None = None) -> dict:
    body: dict = {"idList": list_id, "name": name, "desc": desc, "pos": "bottom"}
    if due:
        body["due"] = due + "T17:00:00.000Z"  # pin to 5pm so Trello doesn't
                                              # show it as overdue at midnight
    return _api("POST", "/cards", body=body)


def _move_card(card_id: str, list_id: str) -> dict:
    return _api("PUT", f"/cards/{card_id}", body={"idList": list_id})


def _close_card(card_id: str) -> dict:
    return _api("PUT", f"/cards/{card_id}", body={"dueComplete": True})


def trello_add(text: str, list_name: str = "todo",
               due: str | None = None,
               labels: list[str] | None = None,
               commitment_id: str | None = None) -> dict:
    """Create one card. Optional label binding to a commitment id so
    later syncs can find it. Returns the created card."""
    if not _gate_enabled():
        return {"error": "JARVIS_TRELLO=0"}
    if _credentials() is None:
        return {"error": "TRELLO_API_KEY / TRELLO_TOKEN not set"}
    cfg = _load_config()
    lists = cfg.get("lists") or {}
    list_id = lists.get(list_name) or lists.get("todo")
    if not list_id:
        return {"error": "Trello not configured — run `jarvis-trello.py setup`"}
    desc = ""
    if commitment_id:
        desc = f"{JARVIS_MARKER} {commitment_id}"
    try:
        card = _create_card(list_id, text, desc=desc, due=due)
    except RuntimeError as e:
        _emit("add", "failed", context={"error": str(e)})
        return {"error": str(e)}
    _emit("add", "success", context={"card_id": card.get("id")})
    return {"ok": True, "card": card}


def trello_move(card_id: str, list_name: str = "doing") -> dict:
    if not _gate_enabled():
        return {"error": "JARVIS_TRELLO=0"}
    cfg = _load_config()
    lists = cfg.get("lists") or {}
    list_id = lists.get(list_name)
    if not list_id:
        return {"error": f"no list mapped for {list_name!r}"}
    try:
        card = _move_card(card_id, list_id)
    except RuntimeError as e:
        _emit("move", "failed", context={"error": str(e)})
        return {"error": str(e)}
    _emit("move", "success", context={"card_id": card_id, "list": list_name})
    return {"ok": True, "card": card}


def complete_card(card_id: str) -> dict:
    if not _gate_enabled():
        return {"error": "JARVIS_TRELLO=0"}
    cfg = _load_config()
    done_id = (cfg.get("lists") or {}).get("done")
    try:
        if done_id:
            _move_card(card_id, done_id)
        _close_card(card_id)
    except RuntimeError as e:
        _emit("complete", "failed", context={"card_id": card_id, "error": str(e)})
        return {"error": str(e)}
    _emit("complete", "success", context={"card_id": card_id})
    return {"ok": True, "card_id": card_id}


# ── sync ─────────────────────────────────────────────────────────────
def _board_cards(board_id: str) -> list[dict]:
    return _api("GET", f"/boards/{board_id}/cards",
                params={"fields": "name,desc,due,dueComplete,idList,closed,shortUrl",
                        "filter": "open"}) or []


def trello_sync() -> dict:
    """Bidirectional reconciliation:

    1. For every open commitment with no Trello card, create one in
       the 'todo' list and store the card id back on the commitment.
    2. For every Trello card whose dueComplete=True or whose list is
       the 'done' list, mark the matching commitment complete.
    3. For every Trello card with a due date and no matching local
       commitment (i.e. Watson made it directly in Trello), import as
       a new commitment so list_commitments shows it.

    Returns a summary dict: {created, completed, imported, errors}."""
    started = time.time()
    if not _gate_enabled():
        return {"error": "JARVIS_TRELLO=0"}
    if _credentials() is None:
        return {"skipped": "TRELLO_API_KEY / TRELLO_TOKEN not set"}
    cfg = _load_config()
    board_id = cfg.get("board_id")
    lists = cfg.get("lists") or {}
    if not board_id or not lists.get("todo"):
        return {"skipped": "Trello not configured — run `jarvis-trello.py setup`"}
    cmt_mod = _load_commitments_module()
    if cmt_mod is None:
        return {"error": "jarvis-commitments not installed"}

    summary = {"created": 0, "completed": 0, "imported": 0, "errors": []}

    # 1. Push new commitments → cards.
    items_data = cmt_mod._load_items()
    items = items_data["items"]
    todo_list = lists["todo"]
    for c in items:
        if c.get("status") != "open":
            continue
        if (c.get("synced_to") or {}).get("trello"):
            continue
        try:
            card = _create_card(todo_list, c["text"],
                                desc=_commitment_card_desc(c),
                                due=c.get("due"))
        except RuntimeError as e:
            summary["errors"].append({"phase": "create", "id": c["id"],
                                      "error": str(e)})
            continue
        c.setdefault("synced_to", {})["trello"] = card.get("id")
        summary["created"] += 1
    if summary["created"]:
        cmt_mod._save_items(items_data)

    # 2. + 3. Pull Trello state.
    try:
        cards = _board_cards(board_id)
    except RuntimeError as e:
        summary["errors"].append({"phase": "fetch", "error": str(e)})
        _emit("sync", "failed", context=summary,
              latency_ms=int((time.time() - started) * 1000))
        return {"ok": False, "summary": summary}

    done_list = lists.get("done")
    by_id = {c.get("synced_to", {}).get("trello"): c for c in items
             if c.get("synced_to", {}).get("trello")}

    items_data = cmt_mod._load_items()  # reload after step 1
    items = items_data["items"]
    by_id = {c.get("synced_to", {}).get("trello"): c for c in items
             if c.get("synced_to", {}).get("trello")}
    by_jarvis_id = {c["id"]: c for c in items}

    dirty = False
    for card in cards:
        cid = card.get("id")
        in_done = (done_list and card.get("idList") == done_list)
        is_complete = bool(card.get("dueComplete")) or in_done
        # Map card → local commitment by stored id, falling back to the
        # marker line in description.
        local = by_id.get(cid)
        if local is None:
            jarvis_id = _extract_jarvis_id(card.get("desc") or "")
            if jarvis_id and jarvis_id in by_jarvis_id:
                local = by_jarvis_id[jarvis_id]
                local.setdefault("synced_to", {})["trello"] = cid
                dirty = True

        if local is not None:
            if is_complete and local.get("status") != "done":
                local["status"] = "done"
                local["completed"] = datetime.now().astimezone().isoformat(
                    timespec="seconds")
                summary["completed"] += 1
                dirty = True
            continue

        # Untracked card with a due date — import.
        if card.get("due"):
            due_iso = (card["due"] or "")[:10]
            new_rec = cmt_mod._build_record(
                text=card.get("name") or "(untitled)",
                owner="watson",
                due=due_iso if due_iso else None,
                priority="medium",
                contact=None,
                tags=["trello-import"],
                source={"type": "trello", "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
                        "context": card.get("shortUrl") or ""},
            )
            new_rec["synced_to"] = {"trello": cid}
            if is_complete:
                new_rec["status"] = "done"
                new_rec["completed"] = new_rec["created"]
            items.append(new_rec)
            summary["imported"] += 1
            dirty = True

    if dirty:
        cmt_mod._save_items(items_data)

    latency_ms = int((time.time() - started) * 1000)
    _emit("sync", "success", context={k: v for k, v in summary.items() if k != "errors"},
          latency_ms=latency_ms)
    _log(f"sync created={summary['created']} completed={summary['completed']} "
         f"imported={summary['imported']} errors={len(summary['errors'])}")
    return {"ok": True, "summary": summary, "latency_ms": latency_ms}


# ── CLI ──────────────────────────────────────────────────────────────
def _cli(argv: list[str]) -> int:
    import argparse

    p = argparse.ArgumentParser(description="Jarvis Trello mirror")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("boards")

    psetup = sub.add_parser("setup")
    psetup.add_argument("--board-id", default=None)
    psetup.add_argument("--board-name", default=None)

    sub.add_parser("sync")

    pa = sub.add_parser("add")
    pa.add_argument("text")
    pa.add_argument("--list", dest="list_name", default="todo",
                    choices=("todo", "doing", "done"))
    pa.add_argument("--due", default=None)
    pa.add_argument("--commitment-id", default=None)

    pm = sub.add_parser("move")
    pm.add_argument("card_id")
    pm.add_argument("list_name", choices=("todo", "doing", "done"))

    pc = sub.add_parser("complete")
    pc.add_argument("card_id")

    args = p.parse_args(argv)
    if args.cmd == "boards":
        print(json.dumps(trello_boards(), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "setup":
        print(json.dumps(trello_setup(board_id=args.board_id,
                                      board_name=args.board_name),
                         ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "sync":
        print(json.dumps(trello_sync(), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "add":
        print(json.dumps(trello_add(args.text, list_name=args.list_name,
                                    due=args.due,
                                    commitment_id=args.commitment_id),
                         ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "move":
        print(json.dumps(trello_move(args.card_id, args.list_name),
                         ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "complete":
        print(json.dumps(complete_card(args.card_id),
                         ensure_ascii=False, indent=2))
        return 0
    return 2


if __name__ == "__main__":
    try:
        sys.exit(_cli(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
