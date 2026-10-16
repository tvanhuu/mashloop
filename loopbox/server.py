"""Web server: python -m loopbox.server [--open] [--host H] [--port P]

Personal by default (http://127.0.0.1:8765, one library on disk). With
MASHLOOP_MULTIUSER=1 every visit gets a library of its own (X-Session header)
over a shared store of songs; see sessions.py."""
import argparse
import hashlib
import os
import tempfile
import webbrowser
import zipfile
from pathlib import Path
from urllib.parse import unquote

import base64

import numpy as np
import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import download, ingest, library, playlists, ratelimit, sessions, worker
from .config import DATA_DIR, HOST, MAX_PLAYLIST, MAX_SESSION_TRACKS, MAX_UPLOAD_MB, MULTIUSER, PORT, WEB_DIR

# Songs waiting to be fetched and analysed, all listeners together: past this
# the server says it is busy rather than queueing for hours.
MAX_BACKLOG = 60

app = FastAPI(title="Mash ∞ Loop", docs_url=None if MULTIUSER else "/docs", redoc_url=None,
              openapi_url=None if MULTIUSER else "/openapi.json")


class AddRequest(BaseModel):
    text: str | None = None
    ids: list[str] | None = None  # songs of a library being restored after a server restart


class PatchRequest(BaseModel):
    enabled: bool | None = None


class PlaylistRequest(BaseModel):
    name: str | None = None
    ids: list[str] | None = None


def view_of(x_session: str | None = Header(default=None),
            x_playlist: str | None = Header(default=None)) -> sessions.View:
    """The library a request works on. In the personal app, X-Playlist narrows
    it to one playlist; an unknown playlist is 404, not 410 (410 makes the
    page open a new session)."""
    if x_playlist and not MULTIUSER:
        try:
            return sessions.playlist(x_playlist)
        except sessions.UnknownPlaylist:
            raise HTTPException(404, "unknown playlist")
    v = sessions.get(x_session)
    if v is None:
        raise HTTPException(410, "session expired")
    return v


def _public(m: dict) -> dict:
    keys = ("id", "title", "channel", "duration", "thumbnail", "url", "status", "stage", "progress",
            "error", "enabled", "bpm", "key", "camelot", "jumps", "beats", "added_at", "mood", "source")
    return {k: m.get(k) for k in keys}


def _meta(tid: str) -> dict:
    m = library.read_meta(tid) if library.valid_id(tid) else None
    if not m:
        raise HTTPException(404, "unknown track")
    return m


def _ready(tid: str) -> dict:
    m = _meta(tid)
    if m.get("status") != "ready":
        raise HTTPException(409, "track not analysed yet")
    return m


def _ip(request: Request) -> str:
    # uvicorn takes the client address from HAProxy's X-Forwarded-For.
    return request.client.host if request.client else "?"


def _is_new(tid: str) -> bool:
    """True when adding tid means fetching and analysing it (it is not in the
    store, nor on its way for someone else)."""
    m = library.read_meta(tid)
    return not m or m.get("status") == "error"


def _admit(ip: str, v: sessions.View, ids: list[str]) -> tuple[list[str], str | None]:
    """Of the songs asked for, the ones this library has room for and this
    client may still bring in new. Returns them and a note on what was left out."""
    have = set(v.track_ids())
    samples = set(library.samples()["ids"])
    fresh = [t for t in dict.fromkeys(ids) if t not in have]
    room = v.room()
    keep, note = [], None
    for t in fresh:
        if t not in samples:
            if room <= 0:
                note = f"Thư viện tối đa {MAX_SESSION_TRACKS} bài: phần còn lại không được thêm"
                break
            room -= 1
        keep.append(t)
    new = [t for t in keep if _is_new(t)]
    if new:
        allowed = min(ratelimit.room(ip, "new_track"), max(0, MAX_BACKLOG - worker.backlog()))
        if allowed <= 0:
            if worker.backlog() >= MAX_BACKLOG:
                raise HTTPException(503, "Server đang bận phân tích nhiều bài, thử lại sau ít phút")
            ratelimit.check(ip, "new_track", len(new))  # raises 429 with the wait
        if len(new) > allowed:
            drop = set(new[allowed:])
            keep = [t for t in keep if t not in drop]
            new = new[:allowed]
            note = "Một số bài chưa được thêm: bạn đã thêm nhiều bài mới, thử lại sau"
        ratelimit.check(ip, "new_track", len(new))
    return keep, note


def _add(v: sessions.View, tid: str, added: list) -> None:
    try:
        v.add(tid)
    except sessions.LimitError as e:
        raise HTTPException(409, str(e))
    m = library.read_meta(tid) or {}
    if m.get("status") == "ready":
        v.link(tid)
    else:
        worker.enqueue_ingest(tid)
    added.append(_public({**m, "enabled": True}))


@app.post("/api/session")
def new_session(request: Request):
    ratelimit.check(_ip(request), "session")
    v = sessions.create()
    return {"sid": v.id, "multiuser": MULTIUSER, "k": base64.b64encode(v.key).decode() if v.key else None,
            "playlists": not MULTIUSER, "limits": {"tracks": MAX_SESSION_TRACKS if MULTIUSER else None, "playlist": MAX_PLAYLIST,
                       "upload_mb": MAX_UPLOAD_MB}}


@app.get("/api/tracks")
def tracks(v: sessions.View = Depends(view_of)):
    metas = v.metas()
    return {"tracks": [_public(m) for m in metas], "worker": worker.status([m["id"] for m in metas]),
            "links": v.link_ver, "room": v.room() if MULTIUSER else None, "stale_server": worker.stale(metas)}


@app.get("/api/search")
def search(q: str, request: Request, v: sessions.View = Depends(view_of)):
    ratelimit.check(_ip(request), "search")
    try:
        return {"results": download.search(q[:200], 8)}
    except Exception as e:
        raise HTTPException(502, f"YouTube search failed: {e}")


@app.post("/api/tracks")
def add(req: AddRequest, request: Request, v: sessions.View = Depends(view_of)):
    ip = _ip(request)
    added: list = []
    if req.ids:  # songs already on the server (a restored library, the samples)
        ids = [t for t in req.ids[:MAX_SESSION_TRACKS * 3] if library.valid_id(t) and library.read_meta(t)]
        keep, note = _admit(ip, v, ids)
        for tid in keep:
            _add(v, tid, added)
        return {"added": added, "note": note}
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(400, "nothing to add")
    if v.room() <= 0:
        raise HTTPException(409, f"Thư viện đã đủ {MAX_SESSION_TRACKS} bài: bỏ bớt một bài để thêm bài khác")
    if not text.startswith(("http://", "https://")):
        ratelimit.check(ip, "search")
    try:
        entries = download.resolve(text)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"could not resolve: {e}")
    if not entries:
        raise HTTPException(404, "nothing found")
    by_id = {e["id"]: e for e in entries}
    keep, note = _admit(ip, v, list(by_id))
    for tid in keep:
        ingest.register(by_id[tid])
        _add(v, tid, added)
    return {"added": added, "note": note}


AUDIO_EXT = {".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg", ".oga", ".opus", ".webm", ".aiff", ".aif", ".wma"}


def _tmp_dir() -> Path:
    d = DATA_DIR / "tmp"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _unzip(path: Path, v: sessions.View, added: list, ip: str) -> str | None:
    """Every audio file in a zip becomes a track (a playlist exported from
    somewhere, a folder of songs), as many as the library has room for;
    anything else in it is ignored. Returns a note on what was left out."""
    limit = MAX_UPLOAD_MB * 1024 * 1024
    note = None
    with zipfile.ZipFile(path) as z:
        members = [i for i in z.infolist()
                   if not i.is_dir() and Path(i.filename).suffix.lower() in AUDIO_EXT
                   and not Path(i.filename).name.startswith("._")]
        if not members:
            raise HTTPException(400, "trong file zip không có bài nhạc nào")
        room = min(v.room(), ratelimit.room(ip, "upload"))
        if len(members) > room:
            note = f"Chỉ thêm {room} bài đầu: thư viện tối đa {MAX_SESSION_TRACKS} bài" if room else None
            members = members[:room]
            if not members:
                raise HTTPException(409, f"Thư viện đã đủ {MAX_SESSION_TRACKS} bài: bỏ bớt một bài để thêm bài khác")
        if sum(i.file_size for i in members) > 4 * limit:
            raise HTTPException(413, "file zip giải nén ra quá lớn")
        ratelimit.check(ip, "upload", len(members))
        for info in members:
            fd, name = tempfile.mkstemp(dir=_tmp_dir())
            tmp, h, size = Path(name), hashlib.sha1(), 0
            try:
                with z.open(info) as src, os.fdopen(fd, "wb") as dst:
                    while chunk := src.read(1 << 20):
                        size += len(chunk)
                        if size > limit:
                            raise HTTPException(413, f"{Path(info.filename).name} lớn hơn {MAX_UPLOAD_MB} MB")
                        h.update(chunk)
                        dst.write(chunk)
                tid = "u" + h.hexdigest()[:16]
                if _is_new(tid) and worker.backlog() >= MAX_BACKLOG:
                    raise HTTPException(503, "Server đang bận phân tích nhiều bài, thử lại sau ít phút")
                ingest.register_upload(tid, Path(info.filename).name, tmp)
            finally:
                tmp.unlink(missing_ok=True)
            _add(v, tid, added)
    return note


@app.post("/api/upload")
async def upload(request: Request, v: sessions.View = Depends(view_of), x_filename: str = Header(default="upload")):
    """The file itself is the request body; its name comes URL-encoded in X-Filename.
    Identical files, from anyone, become the same track. A zip adds every song in it."""
    ip = _ip(request)
    if v.room() <= 0:
        raise HTTPException(409, f"Thư viện đã đủ {MAX_SESSION_TRACKS} bài: bỏ bớt một bài để thêm bài khác")
    if ratelimit.room(ip, "upload") <= 0:
        ratelimit.check(ip, "upload")
    limit = MAX_UPLOAD_MB * 1024 * 1024
    fd, name = tempfile.mkstemp(dir=_tmp_dir())
    tmp = Path(name)
    h, size = hashlib.sha1(), 0
    added: list = []
    try:
        with os.fdopen(fd, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > limit:
                    raise HTTPException(413, f"file lớn hơn {MAX_UPLOAD_MB} MB")
                h.update(chunk)
                f.write(chunk)
        if size < 4096:
            raise HTTPException(400, "file trống hoặc quá nhỏ")
        if zipfile.is_zipfile(tmp):
            note = _unzip(tmp, v, added, ip)
            return {"added": added, "note": note}
        tid = "u" + h.hexdigest()[:16]
        if _is_new(tid) and worker.backlog() >= MAX_BACKLOG:
            raise HTTPException(503, "Server đang bận phân tích nhiều bài, thử lại sau ít phút")
        ratelimit.check(ip, "upload")
        ingest.register_upload(tid, unquote(x_filename)[:200], tmp)
    finally:
        tmp.unlink(missing_ok=True)
    _add(v, tid, added)
    return {"added": added}


@app.get("/api/samples")
def samples():
    """The sample library offered to an empty library: songs kept analysed on the server."""
    s = library.samples()
    ready = [tid for tid in s["ids"] if (library.read_meta(tid) or {}).get("status") == "ready"]
    return {"name": s["name"], "ids": ready}


def _personal() -> None:
    if MULTIUSER:
        raise HTTPException(404, "not found")


def _playlist_public(p: dict) -> dict:
    return {"id": p["id"], "name": p["name"], "count": len(playlists.track_ids(p["id"]))}


@app.get("/api/playlists")
def playlist_list():
    _personal()
    return {"playlists": [_playlist_public(p) for p in playlists.list_all()],
            "all": len(library.list_tracks())}


@app.post("/api/playlists")
def playlist_create(req: PlaylistRequest):
    _personal()
    return _playlist_public(playlists.create(req.name or "", req.ids))


@app.patch("/api/playlists/{pid}")
def playlist_rename(pid: str, req: PlaylistRequest):
    _personal()
    p = playlists.rename(pid, req.name or "") if playlists.valid_id(pid) else None
    if p is None:
        raise HTTPException(404, "unknown playlist")
    return _playlist_public(p)


@app.delete("/api/playlists/{pid}")
def playlist_delete(pid: str):
    """Only the list goes: its songs stay in the store."""
    _personal()
    if not (playlists.valid_id(pid) and playlists.delete(pid)):
        raise HTTPException(404, "unknown playlist")
    return {"deleted": pid}


@app.patch("/api/tracks/{tid}")
def patch(tid: str, req: PatchRequest, v: sessions.View = Depends(view_of)):
    m = _meta(tid)
    if req.enabled is not None:
        v.set_enabled(tid, req.enabled)
    return _public({**m, "enabled": v.is_enabled(tid, library.read_meta(tid) or m)})


@app.delete("/api/tracks/{tid}")
def delete(tid: str, v: sessions.View = Depends(view_of)):
    """Hosted, the song only leaves this library (the store keeps it for others)."""
    _meta(tid)
    v.remove(tid)
    return {"deleted": tid}


@app.post("/api/tracks/{tid}/reanalyze")
def reanalyze(tid: str, v: sessions.View = Depends(view_of)):
    m = _meta(tid)
    if MULTIUSER and m.get("status") != "error":
        raise HTTPException(409, "only failed songs can be retried")
    library.update(tid, status="queued", stage="queued", progress=0.0, error=None)
    worker.enqueue_ingest(tid)
    return {"queued": tid}


@app.post("/api/relink")
def relink(v: sessions.View = Depends(view_of)):
    if MULTIUSER:
        v.link()  # only what is missing: pairs are shared, never recomputed for one listener
    else:
        worker.relink_all()
    return {"queued": True}


def _held(v: sessions.View, tid: str) -> None:
    """Hosted, a song's data only goes to a library that holds it."""
    if MULTIUSER and tid not in v.track_ids():
        raise HTTPException(404, "unknown track")


def keystream(key: bytes, tid: str) -> bytes:
    """4 KiB of SHA-256 output from the session key and the track id, repeated
    over the audio (web/js/api.js derives the same block to undo it)."""
    t = tid.encode()
    return b"".join(hashlib.sha256(key + t + i.to_bytes(4, "big")).digest() for i in range(128))


@app.get("/api/tracks/{tid}/analysis")
def analysis(tid: str, v: sessions.View = Depends(view_of)):
    _ready(tid)
    _held(v, tid)
    return FileResponse(library.analysis_path(tid), media_type="application/json",
                        headers={"Cache-Control": "no-cache"})


@app.get("/api/tracks/{tid}/audio")
def audio(tid: str, request: Request, v: sessions.View = Depends(view_of)):
    """Hosted, the audio is not a file anyone can save: it only goes to the
    session that holds the song, scrambled with that session's key, and the
    page unscrambles it in memory right before decoding. (A browser has to
    receive playable sound, so this stops download tools and casual saving,
    not a determined listener.)"""
    _ready(tid)
    _held(v, tid)
    library.touch(tid)
    if not MULTIUSER:
        return FileResponse(library.audio_path(tid), media_type="audio/flac",
                            headers={"Cache-Control": "private, max-age=86400"})
    ratelimit.check(_ip(request), "audio")
    data = np.frombuffer(library.audio_path(tid).read_bytes(), dtype=np.uint8)
    ks = np.frombuffer(keystream(v.key, tid), dtype=np.uint8)
    body = (data ^ np.resize(ks, data.size)).tobytes()
    return Response(body, media_type="application/octet-stream",
                    headers={"Cache-Control": "no-store", "X-Mash": "1"})


@app.get("/api/tracks/{tid}/transitions")
def transitions(tid: str, v: sessions.View = Depends(view_of)):
    _ready(tid)
    _held(v, tid)
    return {"items": v.transitions(tid)}


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--open", action="store_true", help="open the browser")
    ap.add_argument("--host", default=HOST)
    ap.add_argument("--port", type=int, default=PORT)
    args = ap.parse_args()
    worker.start()
    if not MULTIUSER:
        sessions.local().link()  # pairs missing after an update are computed in the background
    if args.open:
        webbrowser.open(f"http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning", proxy_headers=True,
                forwarded_allow_ips="127.0.0.1")


if __name__ == "__main__":
    main()
