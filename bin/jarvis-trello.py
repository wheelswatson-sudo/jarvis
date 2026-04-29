#!/usr/bin/env python3
"""Trello integration — bidirectional sync between commitments and a board.

The commitment store at ~/.jarvis/commitments/items.json stays canonical;
Trello is a secondary surface so Watson can drag cards on his phone and
have those state changes reflect back in Jarvis. This module:

  * fetches all cards on the configured board(s),
  * pushes every open commitment that isn't on Trello yet,
  * pulls 'done'-list cards back into the store as completed,
  * lets Watson add / move cards directly from the voice surface.

Stdlib only — urllib + json + html.parser. Auth is two env vars:

    TRELLO_API_KEY      from https://trello.com/app-key
    TRELLO_TOKEN        OAuth token from the same page

Setup wizard (`--setup`) walks Watson through:
  1. listing his boards,
  2. picking the default board,
  3. mapping his lists to the three statuses Jarvis cares about
     (todo / doing / done),
  4. writing config to ~/.jarvis/trello/config.json.

Public tools (returned by jarvis-think):

    trello_sync()        bidirectional pass over the configured board
    trello_boards()      list boards (and optionally the cards on one)
    trello_add(...)      create a card on a specific list
    trello_move(...)     move a card to a different list

Files:
    ~/.jarvis/trello/config.json     {api_key, token, board_id, list_map}
    ~/.jarvis/logs/trello.log        diagnostic log

Gate: JARVIS_TRELLO=1 (defaults on iff TRELLO_API_KEY + TRELLO_TOKEN both
present).
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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
BIN_DIR = ASSISTANT_DIR / "bin"
LIB_DIR = ASSISTANT_DIR / "lib"
TRELLO_DIR = ASSISTANT_DIR / "trello"
CONFIG_FILE = TRELLO_DIR / "config.json"
LOG_DIR = ASSISTANT_DIR / "logs"
TRELLO_LOG = LOG_DIR / "trello.log"

TRELLO_API = "https://api.trello.com/1"
HTTP_TIMEOUT_S = float(os.environ.get("JARVIS_TRELLO_HTTP_TIMEOUT_S", "12"))


# ── logging + gate ────────────────────────────────────────────────────
def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().astimezone().isoformat(timespec="seconds")
        with TRELLO_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def _gate_default() -> str:
    return "1" if (os.environ.get("TRELLO_API_KEY")
                   and os.environ.get("TRELLO_TOKEN")) else "0"


def _gate_check() -> dict | None:
    if os.environ.get("JARVIS_TRELLO", _gate_default()) != "1":
        return {"error": "trello disabled (JARVIS_TRELLO=0 or no keys)"}
    if not (os.environ.get("TRELLO_API_KEY") and os.environ.get("TRELLO_TOKEN")):
        return {"error": "TRELLO_API_KEY + TRELLO_TOKEN env vars required"}
    return None


# ── module loaders ────────────────────────────────────────────────────
def _load_module(mod_id: str, filename: str, search_dirs: list[Path]) -> Any:
    for d in search_dirs:
        src = d / filename
        if src.exists():
            try:
                spec = importlib.util.spec_from_file_location(mod_id, src)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)  # type: ignore[union-attr]
                return mod
            except Exception as e:
                _log(f"load {filename} failed: {e}")
                return None
    return None


_BIN_SEARCH = [BIN_DIR, Path(__file__).parent]
_LIB_SEARCH = [LIB_DIR, Path(__file__).parent.parent / "lib"]

_cache: dict[str, Any] = {}


def _commitments():
    if "commitments" not in _cache:
        _cache["commitments"] = _load_module(
            "jarvis_commitments_for_trello",
            "jarvis-commitments.py", _BIN_SEARCH)
    return _cache["commitments"]


def _primitive():
    if "primitive" not in _cache:
        _cache["primitive"] = _load_module("primitive", "primitive.py", _LIB_SEARCH)
    return _cache["primitive"]


def _emit(action: str, status: str, **ctx) -> None:
    p = _primitive()
    if p is None:
        return
    try:
        p.emit(cap="commitments", action=action, status=status, context=ctx)
    except Exception:
        pass


# ── config I/O ────────────────────────────────────────────────────────
def _load_config() -> dict:
    if not CONFIG_FILE.exists():
        return {}
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_config(cfg: dict) -> None:
    TRELLO_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, indent=2, ensure_ascii=False),
                   encoding="utf-8")
    os.replace(tmp, CONFIG_FILE)
    # Trello tokens grant read/write to all the boards Watson authorized;
    # keep the file user-only so a misconfigured backup tool doesn't
    # leak it.
    try:
        os.chmod(CONFIG_FILE, 0o600)
    except OSError:
        pass


# ── HTTP ──────────────────────────────────────────────────────────────
def _auth_params() -> dict:
    return {
        "key": os.environ.get("TRELLO_API_KEY", ""),
        "token": os.environ.get("TRELLO_TOKEN", ""),
    }


def _build_url(path: str, **params) -> str:
    qs = {**_auth_params(), **{k: v for k, v in params.items() if v is not None}}
    return f"{TRELLO_API}{path}?{urllib.parse.urlencode(qs)}"


def _http_get(path: str, **params) -> tuple[int, Any]:
    url = _build_url(path, **params)
    try:
        with urllib.request.urlopen(url, timeout=HTTP_TIMEOUT_S) as r:
            body = r.read()
            try:
                return r.status, json.loads(body)
            except json.JSONDecodeError:
                return r.status, body.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            err = e.read().decode("utf-8", "replace")
        except Exception:
            err = str(e)
        return e.code, err
    except (urllib.error.URLError, TimeoutError) as e:
        _log(f"GET {path} -> {e}")
        return -1, str(e)


def _http_send(path: str, method: str, body: dict | None = None,
               **params) -> tuple[int, Any]:
    url = _build_url(path, **params)
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw)
            except json.JSONDecodeError:
                return r.status, raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            err = e.read().decode("utf-8", "replace")
        except Exception:
            err = str(e)
        return e.code, err
    except (urllib.error.URLError, TimeoutError) as e:
        _log(f"{method} {path} -> {e}")
        return -1, str(e)


# ── PUBLIC: trello_boards ─────────────────────────────────────────────
def trello_boards(board_id: str | None = None,
                  include_cards: bool = False) -> dict:
    """List boards. With board_id, drill into one board's lists (and
    optionally cards) so Watson can see what's queued without leaving
    voice."""
    gate = _gate_check()
    if gate:
        _emit("trello_boards", "skipped", reason="gate")
        return gate
    if board_id:
        status, lists = _http_get(f"/boards/{board_id}/lists",
                                  fields="name,closed", filter="open")
        if status != 200 or not isinstance(lists, list):
            _emit("trello_boards", "failed", reason=f"lists: {status}")
            return {"error": f"trello lists fetch: {status}",
                    "raw": (lists if isinstance(lists, str) else "")[:200]}
        out_lists: list[dict] = []
        for lst in lists:
            entry: dict = {"id": lst.get("id"), "name": lst.get("name")}
            if include_cards:
                cstatus, cards = _http_get(f"/lists/{lst['id']}/cards",
                                            fields="name,due,dateLastActivity,closed")
                if cstatus == 200 and isinstance(cards, list):
                    entry["cards"] = [{
                        "id": c.get("id"), "name": c.get("name"),
                        "due": c.get("due"),
                    } for c in cards if not c.get("closed")]
            out_lists.append(entry)
        _emit("trello_boards", "success", board_id=board_id,
              lists_count=len(out_lists))
        return {"ok": True, "board_id": board_id, "lists": out_lists}

    status, boards = _http_get("/members/me/boards",
                                fields="name,url,closed", filter="open")
    if status != 200 or not isinstance(boards, list):
        _emit("trello_boards", "failed", reason=f"boards: {status}")
        return {"error": f"trello boards fetch: {status}",
                "raw": (boards if isinstance(boards, str) else "")[:200]}
    out = [{"id": b.get("id"), "name": b.get("name"), "url": b.get("url")}
           for b in boards if not b.get("closed")]
    _emit("trello_boards", "success", count=len(out))
    return {"ok": True, "boards": out, "count": len(out)}


# ── PUBLIC: trello_add ────────────────────────────────────────────────
def trello_add(name: str, list_id: str | None = None,
               list_name: str | None = None,
               due: str | None = None,
               desc: str | None = None) -> dict:
    """Create a card on a specific list. If list_id is omitted, falls
    back to list_name lookup against the configured board, then to the
    'todo' mapping in config."""
    gate = _gate_check()
    if gate:
        _emit("trello_add", "skipped", reason="gate")
        return gate
    if not name or not name.strip():
        return {"error": "name is required"}

    target_id = list_id
    if not target_id:
        target_id = _resolve_list(list_name=list_name, default_role="todo")
    if not target_id:
        return {"error": "no list_id resolved — pass list_id or run --setup"}

    body = {"name": name.strip(), "idList": target_id}
    if due:
        body["due"] = due
    if desc:
        body["desc"] = desc
    status, card = _http_send("/cards", method="POST", body=body)
    if status not in (200, 201) or not isinstance(card, dict):
        _emit("trello_add", "failed", reason=f"create: {status}")
        return {"error": f"trello card create: {status}",
                "raw": (card if isinstance(card, str) else "")[:200]}
    _emit("trello_add", "success", card_id=card.get("id"),
          list_id=target_id)
    _log(f"add card {card.get('id')} list={target_id} name={name[:80]!r}")
    return {"ok": True, "card": {
        "id": card.get("id"), "name": card.get("name"),
        "list_id": card.get("idList"), "url": card.get("url"),
        "due": card.get("due"),
    }}


# ── PUBLIC: trello_move ───────────────────────────────────────────────
def trello_move(card_id: str, list_id: str | None = None,
                list_name: str | None = None) -> dict:
    """Move a card to a different list. Either list_id (exact) or
    list_name (looked up against the configured board) must resolve."""
    gate = _gate_check()
    if gate:
        _emit("trello_move", "skipped", reason="gate")
        return gate
    if not card_id:
        return {"error": "card_id is required"}
    target_id = list_id
    if not target_id:
        target_id = _resolve_list(list_name=list_name)
    if not target_id:
        return {"error": "no list resolved"}
    status, card = _http_send(f"/cards/{card_id}", method="PUT",
                               body={"idList": target_id})
    if status != 200 or not isinstance(card, dict):
        _emit("trello_move", "failed", reason=f"move: {status}")
        return {"error": f"trello move: {status}",
                "raw": (card if isinstance(card, str) else "")[:200]}
    _emit("trello_move", "success", card_id=card_id, list_id=target_id)
    _log(f"move card {card_id} -> {target_id}")
    return {"ok": True, "card_id": card_id, "list_id": target_id}


# ── helpers shared across tools ───────────────────────────────────────
def _resolve_list(list_name: str | None = None,
                  default_role: str | None = None) -> str | None:
    """Resolve a list to an id. Lookup order:
       1. Exact-id match in config.list_map values
       2. Role match (todo/doing/done) when list_name is one of those
       3. Name match against open lists on the configured board
       4. Role default (default_role) from config.list_map
    """
    cfg = _load_config()
    list_map = cfg.get("list_map") or {}
    board_id = cfg.get("board_id")

    if list_name:
        ln = list_name.strip().lower()
        if ln in ("todo", "doing", "done") and ln in list_map:
            return list_map[ln]
        # By id?
        if list_name in list_map.values():
            return list_name
        if board_id:
            status, lists = _http_get(f"/boards/{board_id}/lists",
                                      fields="name", filter="open")
            if status == 200 and isinstance(lists, list):
                for lst in lists:
                    if (lst.get("name") or "").strip().lower() == ln:
                        return lst.get("id")
    if default_role and default_role in list_map:
        return list_map[default_role]
    return None


def _list_role_for(list_id: str, list_map: dict) -> str | None:
    """Inverse — given a list id, return the role it maps to ('todo' /
    'doing' / 'done'), or None when the list isn't part of the sync."""
    for role, lid in list_map.items():
        if lid == list_id:
            return role
    return None


# ── PUBLIC: trello_sync (bidirectional) ───────────────────────────────
def trello_sync() -> dict:
    """Bidirectional sync between the commitment store and the
    configured board.

    Push: every commitment with status open/overdue and no
          synced_to.trello_card_id gets a new card on the 'todo' list.
    Pull: every card on the 'done' list whose id matches a tracked
          commitment marks that commitment as completed in the store.
    Move: when a commitment is completed inside Jarvis but its card is
          still on todo/doing, move the card to 'done' to keep Trello
          in sync.

    Returns a structured tally so the briefing layer can mention what
    moved without re-running the call."""
    started = time.monotonic()
    gate = _gate_check()
    if gate:
        _emit("trello_sync", "skipped", reason="gate")
        return gate
    cfg = _load_config()
    if not cfg.get("board_id") or not cfg.get("list_map"):
        return {"error": "trello not set up — run "
                         "`bin/jarvis-trello.py --setup`"}
    board_id = cfg["board_id"]
    list_map = cfg["list_map"]
    todo_id = list_map.get("todo")
    done_id = list_map.get("done")
    if not todo_id or not done_id:
        return {"error": "list_map missing 'todo' or 'done' role"}

    cmt = _commitments()
    if cmt is None:
        return {"error": "jarvis-commitments module not installed"}
    items = cmt._load_items()  # type: ignore[attr-defined]

    # Pull all cards once — saves N round trips when looking up by id.
    cards_status, cards = _http_get(f"/boards/{board_id}/cards",
                                     fields="name,idList,due,closed,desc",
                                     filter="open")
    if cards_status != 200 or not isinstance(cards, list):
        return {"error": f"trello cards fetch: {cards_status}",
                "raw": (cards if isinstance(cards, str) else "")[:200]}
    by_id = {c.get("id"): c for c in cards}

    pushed: list[str] = []
    pulled_done: list[str] = []
    moved_done: list[str] = []
    errors: list[str] = []

    # Pass 1 — push open/overdue commitments that aren't on Trello yet.
    for rec in items:
        if rec.get("status") not in ("open", "overdue"):
            continue
        synced = (rec.get("synced_to") or {}).get("trello_card_id")
        if synced and synced in by_id:
            continue  # already on the board
        # Push
        body = {"name": rec.get("text") or "(untitled)",
                "idList": todo_id,
                "desc": _format_card_desc(rec)}
        if rec.get("due"):
            body["due"] = rec["due"]
        cstatus, card = _http_send("/cards", method="POST", body=body)
        if cstatus in (200, 201) and isinstance(card, dict):
            rec.setdefault("synced_to", {})["trello_card_id"] = card.get("id")
            rec["updated_at"] = datetime.now(timezone.utc).isoformat(
                timespec="seconds")
            pushed.append(rec["id"])
            by_id[card.get("id")] = card  # keep local mirror current
        else:
            errors.append(f"push {rec['id']}: {cstatus}")

    # Pass 2 — pull cards on the 'done' list back into the store.
    for card in cards:
        if card.get("idList") != done_id:
            continue
        cid = card.get("id")
        rec = next((r for r in items
                    if (r.get("synced_to") or {}).get("trello_card_id") == cid),
                   None)
        if rec is None:
            # Untracked card — skip (it predates sync, or someone added
            # it directly on Trello). We could also auto-add it as a
            # done commitment, but that's noisier than helpful.
            continue
        if rec.get("status") in ("done", "cancelled"):
            continue
        rec["status"] = "done"
        rec["completed_at"] = datetime.now(timezone.utc).isoformat(
            timespec="seconds")
        rec["updated_at"] = rec["completed_at"]
        pulled_done.append(rec["id"])

    # Pass 3 — push completions back: commitments marked done in Jarvis
    # whose Trello card hasn't been moved yet.
    for rec in items:
        if rec.get("status") != "done":
            continue
        cid = (rec.get("synced_to") or {}).get("trello_card_id")
        if not cid or cid not in by_id:
            continue
        if by_id[cid].get("idList") == done_id:
            continue
        mstatus, _ = _http_send(f"/cards/{cid}", method="PUT",
                                 body={"idList": done_id})
        if mstatus == 200:
            moved_done.append(rec["id"])
        else:
            errors.append(f"move {cid}: {mstatus}")

    # Persist whatever changed.
    if pushed or pulled_done or moved_done:
        cmt._save_items(items)  # type: ignore[attr-defined]

    elapsed = int((time.monotonic() - started) * 1000)
    _emit("trello_sync",
          "success" if not errors else "failed",
          pushed=len(pushed), pulled_done=len(pulled_done),
          moved_done=len(moved_done), errors_count=len(errors),
          latency_ms=elapsed)
    _log(f"sync pushed={len(pushed)} pulled_done={len(pulled_done)} "
         f"moved_done={len(moved_done)} errors={len(errors)} ({elapsed}ms)")
    return {
        "ok": True,
        "pushed": pushed,
        "pulled_done": pulled_done,
        "moved_done": moved_done,
        "errors": errors,
    }


def _format_card_desc(rec: dict) -> str:
    """Human-readable description on the Trello card. Includes the
    Jarvis id so a future reverse-lookup doesn't depend solely on
    synced_to."""
    parts = [f"jarvis:{rec.get('id', '?')}"]
    if rec.get("priority") and rec["priority"] != "normal":
        parts.append(f"priority: {rec['priority']}")
    if rec.get("related_contact"):
        parts.append(f"with: {rec['related_contact']}")
    if rec.get("tags"):
        parts.append("tags: " + ", ".join(rec["tags"]))
    return "\n".join(parts)


# ── setup wizard ──────────────────────────────────────────────────────
def setup() -> int:
    """Interactive — only runs from a TTY. Walks Watson through picking
    the board and mapping his lists to (todo / doing / done)."""
    gate = _gate_check()
    if gate:
        print(gate["error"], file=sys.stderr)
        return 2
    if not sys.stdin.isatty():
        print("--setup requires a TTY (interactive prompts).", file=sys.stderr)
        return 2

    print("\n— Jarvis Trello setup —\n")
    res = trello_boards()
    if not res.get("ok"):
        print(f"Failed to fetch boards: {res.get('error')}", file=sys.stderr)
        return 2
    boards = res.get("boards") or []
    if not boards:
        print("No open boards found on this account.", file=sys.stderr)
        return 2
    for i, b in enumerate(boards, 1):
        print(f"  {i}. {b['name']}  ({b['url']})")
    pick_idx = input("\nWhich board? (number) ").strip()
    try:
        i = int(pick_idx) - 1
        board = boards[i]
    except (ValueError, IndexError):
        print("Invalid selection.", file=sys.stderr)
        return 2

    lres = trello_boards(board_id=board["id"])
    if not lres.get("ok"):
        print(f"Failed to fetch lists: {lres.get('error')}", file=sys.stderr)
        return 2
    lists = lres.get("lists") or []
    if not lists:
        print("Board has no open lists.", file=sys.stderr)
        return 2
    print(f"\nLists on {board['name']}:")
    for i, lst in enumerate(lists, 1):
        print(f"  {i}. {lst['name']}")

    list_map: dict[str, str] = {}
    for role, label in (("todo", "to-do (new commitments land here)"),
                        ("doing", "in-progress (optional, press Enter to skip)"),
                        ("done", "done (completed commitments end up here)")):
        while True:
            choice = input(f"\nWhich list is your {role} list — {label}? "
                           "(number, or blank to skip) ").strip()
            if not choice:
                if role in ("todo", "done"):
                    print("  Required — please choose a list.")
                    continue
                break
            try:
                idx = int(choice) - 1
                lst = lists[idx]
                list_map[role] = lst["id"]
                break
            except (ValueError, IndexError):
                print("  Invalid selection — try again.")

    cfg = {
        "board_id": board["id"],
        "board_name": board["name"],
        "list_map": list_map,
        "configured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    _save_config(cfg)
    print(f"\nSaved {CONFIG_FILE}.\nRun `bin/jarvis-trello.py sync` "
          "to push your existing commitments to the board.")
    return 0


# ── main entrypoint (jarvis-improve hook) ─────────────────────────────
def main() -> int:
    """Tier-1 entrypoint. One bidirectional sync per pass when the board
    is configured. Always exits 0."""
    if _gate_check() is not None:
        return 0
    cfg = _load_config()
    if not cfg.get("board_id"):
        return 0
    try:
        trello_sync()
    except Exception as e:
        _log(f"main sync: {e}")
    return 0


# ── CLI ────────────────────────────────────────────────────────────────
def _cli() -> int:
    p = argparse.ArgumentParser(description="Jarvis Trello sync")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("--setup", help="interactive setup wizard")
    pl = sub.add_parser("boards", help="list boards / lists / cards")
    pl.add_argument("--board", default=None)
    pl.add_argument("--cards", action="store_true",
                    help="include cards on each list (with --board)")
    pa = sub.add_parser("add", help="add a card")
    pa.add_argument("name")
    pa.add_argument("--list", default=None,
                    help="list id, list name, or role (todo/doing/done)")
    pa.add_argument("--due", default=None)
    pa.add_argument("--desc", default=None)
    pm = sub.add_parser("move", help="move a card to another list")
    pm.add_argument("card_id")
    pm.add_argument("--list", default=None)
    sub.add_parser("sync", help="bidirectional sync with commitments store")
    sub.add_parser("status", help="config + last sync info")

    # argparse doesn't allow --setup as a subcommand cleanly — fall back
    # to a manual flag parse.
    if len(sys.argv) >= 2 and sys.argv[1] == "--setup":
        return setup()

    args = p.parse_args()

    if args.cmd == "boards":
        print(json.dumps(trello_boards(board_id=args.board,
                                        include_cards=args.cards),
                         ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "add":
        # Heuristic: does --list look like an id? Trello ids are 24 hex
        # chars. Otherwise treat as name/role.
        list_arg = args.list or ""
        if len(list_arg) == 24 and all(c in "0123456789abcdef" for c in list_arg):
            print(json.dumps(trello_add(args.name, list_id=list_arg,
                                         due=args.due, desc=args.desc),
                             ensure_ascii=False, indent=2))
        else:
            print(json.dumps(trello_add(args.name, list_name=list_arg or None,
                                         due=args.due, desc=args.desc),
                             ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "move":
        list_arg = args.list or ""
        if len(list_arg) == 24 and all(c in "0123456789abcdef" for c in list_arg):
            print(json.dumps(trello_move(args.card_id, list_id=list_arg),
                             ensure_ascii=False, indent=2))
        else:
            print(json.dumps(trello_move(args.card_id, list_name=list_arg or None),
                             ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "sync":
        print(json.dumps(trello_sync(), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "status":
        cfg = _load_config()
        print(json.dumps({
            "ok": True,
            "configured": bool(cfg.get("board_id")),
            "board_name": cfg.get("board_name"),
            "list_map_roles": list((cfg.get("list_map") or {}).keys()),
            "config_file": str(CONFIG_FILE),
            "enabled": _gate_check() is None,
        }, ensure_ascii=False, indent=2))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(_cli() if len(sys.argv) > 1 else main())
