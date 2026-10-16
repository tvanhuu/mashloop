"""Whose library is it. Hosted (MULTIUSER), every visit opens a session with a
library of its own that starts empty and lives in memory until the visit has
been idle for SESSION_TTL_S; the songs themselves are a store shared by all
sessions. Personal, there is one library: the whole store, kept on disk."""
import secrets
import threading
import time

from . import library, playlists, worker
from .config import MAX_SESSION_TRACKS, MULTIUSER, SESSION_TTL_S

_lock = threading.RLock()
_sessions: dict[str, "SessionView"] = {}
_local = None
_playlist_views: dict[str, "PlaylistView"] = {}


class LimitError(Exception):
    pass


class View:
    """A library: which songs, which are in the chain, and the transitions
    between them assembled from the shared pairs."""

    def __init__(self):
        self.link_ver = 0
        self._assembled_key = None
        self._assembled = {}
        self._assemble_lock = threading.Lock()

    # -- songs
    def track_ids(self) -> list[str]:
        raise NotImplementedError

    def metas(self) -> list[dict]:
        out = []
        for tid in self.track_ids():
            m = library.read_meta(tid)
            if m:
                out.append({**m, "enabled": self.is_enabled(tid, m)})
        return out

    def ready_ids(self) -> list[str]:
        return [m["id"] for m in self.metas() if m.get("status") == "ready"]

    def is_enabled(self, tid: str, meta: dict) -> bool:
        raise NotImplementedError

    # -- transitions
    def transitions(self, tid: str) -> list[dict]:
        from .analysis import transitions
        ready = tuple(sorted(self.ready_ids()))
        key = (ready, self.link_ver)
        with self._assemble_lock:
            if key != self._assembled_key:
                self._assembled = transitions.assemble(list(ready))
                self._assembled_key = key
            return self._assembled.get(tid, [])

    def link(self, tid: str | None = None) -> None:
        """Schedules the missing pairs: of one newly ready song with the rest,
        or of the whole library."""
        ready = self.ready_ids()
        for t in ([tid] if tid else ready):
            if t in ready:
                worker.enqueue_links(t, ready)

    def linked(self) -> None:
        with _lock:
            self.link_ver += 1


class SessionView(View):
    def __init__(self, sid: str):
        super().__init__()
        self.id = sid
        self.ids: list[str] = []
        self.off: set[str] = set()
        self.seen = time.time()
        # Scrambles the audio this session is sent (see server.audio).
        self.key = secrets.token_bytes(32)

    def track_ids(self) -> list[str]:
        return list(self.ids)

    def is_enabled(self, tid, meta):
        return tid not in self.off

    def room(self) -> int:
        """Songs the listener may still add. The sample library does not
        count: it is already on the server and costs nothing to hold."""
        samples = set(library.samples()["ids"])
        return max(0, MAX_SESSION_TRACKS - sum(1 for t in self.ids if t not in samples))

    def add(self, tid: str) -> None:
        with _lock:
            if tid in self.ids:
                return
            if tid not in library.samples()["ids"] and self.room() <= 0:
                raise LimitError(f"Thư viện đã đủ {MAX_SESSION_TRACKS} bài: bỏ bớt một bài để thêm bài khác")
            self.ids.append(tid)
        library.touch(tid)

    def remove(self, tid: str) -> None:
        with _lock:
            if tid in self.ids:
                self.ids.remove(tid)
            self.off.discard(tid)

    def set_enabled(self, tid: str, on: bool) -> None:
        with _lock:
            (self.off.discard if on else self.off.add)(tid)


class LocalView(View):
    """The personal app: the library is everything on disk."""

    id = "local"
    key = None

    def room(self):
        return 1 << 30

    def track_ids(self):
        return [m["id"] for m in library.list_tracks()]

    def metas(self):
        return library.list_tracks()

    def is_enabled(self, tid, meta):
        return meta.get("enabled") is not False

    def add(self, tid):
        library.touch(tid)

    def remove(self, tid):
        library.delete(tid)
        playlists.drop_track(tid)

    def set_enabled(self, tid, on):
        library.update(tid, enabled=on)


class PlaylistView(View):
    """The personal app, one playlist open: a set of songs from the store, kept
    on disk (playlists.py). Taking a song out leaves it in the store. The pairs
    are already computed for the whole store, so its transitions only need
    assembling over its own songs."""

    key = None

    def __init__(self, pid: str):
        super().__init__()
        self.pid = pid
        self.id = f"pl:{pid}"

    def room(self):
        return 1 << 30

    def track_ids(self):
        return playlists.track_ids(self.pid)

    def is_enabled(self, tid, meta):
        return tid not in ((playlists.get(self.pid) or {}).get("off") or [])

    def metas(self):
        off = set((playlists.get(self.pid) or {}).get("off") or [])
        out = []
        for tid in self.track_ids():
            m = library.read_meta(tid)
            if m:
                out.append({**m, "enabled": tid not in off})
        return out

    def add(self, tid):
        playlists.add(self.pid, tid)
        library.touch(tid)

    def remove(self, tid):
        playlists.remove(self.pid, tid)

    def set_enabled(self, tid, on):
        playlists.set_enabled(self.pid, tid, on)


class UnknownPlaylist(Exception):
    pass


def playlist(pid: str) -> PlaylistView:
    """The view of a playlist (one per playlist, so its assembled transitions
    are cached). Raises UnknownPlaylist when it does not exist."""
    if playlists.get(pid) is None:
        with _lock:
            _playlist_views.pop(pid, None)
        raise UnknownPlaylist(pid)
    with _lock:
        v = _playlist_views.get(pid)
        if v is None:
            v = _playlist_views[pid] = PlaylistView(pid)
        return v


def create() -> View:
    if not MULTIUSER:
        return local()
    _sweep()
    sid = secrets.token_urlsafe(18)
    with _lock:
        v = SessionView(sid)
        _sessions[sid] = v
    return v


def get(sid: str | None) -> View | None:
    if not MULTIUSER:
        return local()
    with _lock:
        v = _sessions.get(sid or "")
        if v is None:
            return None
        if time.time() - v.seen > SESSION_TTL_S:
            _sessions.pop(v.id, None)
            return None
        v.seen = time.time()
        return v


def local() -> LocalView:
    global _local
    with _lock:
        if _local is None:
            _local = LocalView()
        return _local


def views() -> list[View]:
    if not MULTIUSER:
        with _lock:
            return [local(), *_playlist_views.values()]
    with _lock:
        return list(_sessions.values())


def in_use() -> set[str]:
    """Songs some live library holds, and the sample library: never evicted."""
    keep = set(library.samples()["ids"])
    if not MULTIUSER:
        return keep | set(library.ready_ids())
    with _lock:
        return keep | {t for v in _sessions.values() for t in v.ids}


def _sweep() -> None:
    now = time.time()
    with _lock:
        for sid in [s for s, v in _sessions.items() if now - v.seen > SESSION_TTL_S]:
            _sessions.pop(sid, None)


# A song just analysed is linked into every library that holds it; a pair
# just computed refreshes the libraries holding both of its songs.
def _on_ready(tid: str) -> None:
    for v in views():
        if tid in v.track_ids():
            v.link(tid)


def _on_linked(tids: set[str]) -> None:
    for v in views():
        if len(tids & set(v.track_ids())) >= 2:
            v.linked()


worker.on_ready.append(_on_ready)
worker.on_linked.append(_on_linked)
worker.keep_ids = in_use
