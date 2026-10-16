"""Playlists of the personal app: named sets of songs from the store, kept in
data/playlists.json. A song may be in several; taking it out of a playlist
leaves it in the store, deleting it from the store takes it out of every
playlist. Hosted (MULTIUSER) there are none: each visit is its own library."""
import re
import secrets
import threading
import time

from . import library
from .config import DATA_DIR

PATH = DATA_DIR / "playlists.json"
_ID = re.compile(r"^[0-9a-f]{8}$")
_lock = threading.RLock()


def valid_id(pid: str) -> bool:
    return bool(pid) and bool(_ID.match(pid))


def _load() -> list[dict]:
    return (library.read_json(PATH) or {}).get("lists") or []


def _save(lists: list[dict]) -> None:
    library.write_json(PATH, {"lists": lists})


def _find(lists: list[dict], pid: str) -> dict | None:
    return next((p for p in lists if p["id"] == pid), None)


def _clean_name(name: str) -> str:
    return " ".join((name or "").split())[:80] or "Playlist mới"


def list_all() -> list[dict]:
    with _lock:
        return _load()


def get(pid: str) -> dict | None:
    if not valid_id(pid):
        return None
    with _lock:
        return _find(_load(), pid)


def track_ids(pid: str) -> list[str]:
    """The playlist's songs still in the store, in the order they were added."""
    p = get(pid)
    return [t for t in (p or {}).get("ids", []) if library.valid_id(t) and library.read_meta(t)]


def create(name: str, ids: list[str] | None = None) -> dict:
    with _lock:
        lists = _load()
        pid = secrets.token_hex(4)
        while _find(lists, pid):
            pid = secrets.token_hex(4)
        ids = [t for t in dict.fromkeys(ids or []) if library.valid_id(t) and library.read_meta(t)]
        p = {"id": pid, "name": _clean_name(name), "ids": ids, "off": [], "created_at": time.time()}
        lists.append(p)
        _save(lists)
        return p


def _edit(pid: str, fn) -> dict | None:
    with _lock:
        lists = _load()
        p = _find(lists, pid)
        if p is None:
            return None
        fn(p)
        _save(lists)
        return p


def rename(pid: str, name: str) -> dict | None:
    return _edit(pid, lambda p: p.update(name=_clean_name(name)))


def delete(pid: str) -> bool:
    with _lock:
        lists = _load()
        keep = [p for p in lists if p["id"] != pid]
        if len(keep) == len(lists):
            return False
        _save(keep)
        return True


def add(pid: str, tid: str) -> None:
    def fn(p):
        if tid not in p["ids"]:
            p["ids"].append(tid)
    _edit(pid, fn)


def remove(pid: str, tid: str) -> None:
    def fn(p):
        p["ids"] = [t for t in p["ids"] if t != tid]
        p["off"] = [t for t in p["off"] if t != tid]
    _edit(pid, fn)


def set_enabled(pid: str, tid: str, on: bool) -> None:
    def fn(p):
        off = [t for t in p["off"] if t != tid]
        p["off"] = off if on else off + [tid]
    _edit(pid, fn)


def drop_track(tid: str) -> None:
    """A song left the store: it leaves every playlist too."""
    with _lock:
        lists = _load()
        changed = False
        for p in lists:
            if tid in p["ids"] or tid in p["off"]:
                p["ids"] = [t for t in p["ids"] if t != tid]
                p["off"] = [t for t in p["off"] if t != tid]
                changed = True
        if changed:
            _save(lists)
