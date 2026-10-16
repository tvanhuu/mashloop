# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Mash ∞ Loop is an endless jukebox: it analyses songs (beats, stems, singer, key, mood), loops each one through
seamless in-song jump points, and chains a library into one continuous DJ-style set. Python backend (`loopbox/`,
FastAPI + PyTorch), vanilla-JS Web Audio frontend (`web/`, ES modules, no framework, no build step). The UI text is
Vietnamese; code and comments are in English. Originally developed on Windows (paths in the README use
`.venv\Scripts\`); on macOS/Linux use `.venv/bin/python`. `README.md` is the user-facing overview; `DOCS.md` (Vietnamese)
covers native, Docker and env-var setup.

## Commands

Setup (torch must go in first, and `beat-this`/`demucs` with `--no-deps`, or their pins replace the CUDA torch):

```
python -m venv .venv
.venv/bin/pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124
.venv/bin/pip install --no-deps beat-this demucs
.venv/bin/pip install -r requirements.txt   # add -c constraints.txt to pin the CUDA torch/numpy builds
```

The pinned torch is a CUDA build; without a GPU (e.g. macOS) install the plain torch 2.6.0 wheels instead. Newer
torch lacks the torchaudio that Beat This! needs. Analysis falls back to CPU automatically (slower).

Needs `ffmpeg` on `PATH` and Node 20+ (yt-dlp uses it for YouTube; `MASHLOOP_JS_RUNTIME=deno` on the server).

Run:
- `python -m loopbox.server --open` (personal mode, http://127.0.0.1:8765). `./run.sh` (macOS/Linux) and `run.ps1`
  (Windows) do the same after killing any server left on port 8765, so the current code is always what's served.
  Add `MASHLOOP_MULTIUSER=1` for the hosted mode.
- Docker: `docker compose up -d --build` (logs: `docker compose logs -f`). The compose file joins an **external**
  network `pingvin-net` (used by a Cloudflare tunnel), so create it first (`docker network create pingvin-net`)
  or the stack won't start. `./data` is mounted at `/app/data`. The image installs CPU torch from PyPI unless
  built with `--build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu124`; the GPU `deploy:` block in the
  compose file is commented out. The image copies only `loopbox/` and `web/` (no `tools/`), and model weights go to
  the torch hub cache inside the container, not to `/app/data`, so a fresh container downloads them again.
- `python -m loopbox.cli add "<url or search>" | analyze [ids] | list | relink | rejump | samples [--name N] [ids]`.
  `rejump` recomputes in-song jumps from stored `features.npz` (no GPU, seconds) then relinks; `relink` recomputes
  every cross-song pair and exports `data/transitions/`.

There is no unit-test suite or linter. Verification is done with these tools, all of which read the real library
in `data/` (they need analysed songs there):
- `node tools/sim_player.mjs [minutes=180] [chain|single] [seed]` — runs the real `web/js/player.js` against a fake
  audio engine for hours of simulated playback; reports continuity/overlap/leak problems and library coverage.
  `CRITERION=mood|tempo|key|free` selects the chain criterion. Reads `data/transitions/*.json`, so run
  `cli relink` (or `cli add/analyze`) first after changing transition code.
- `python tools/e2e_test.py [seconds] [out.wav] [track-id|-] [chain|single]` — starts the server on port 8799, drives
  the UI in headless Chromium (Playwright), records the page's audio output to WAV and checks for page errors,
  dropouts and splice transients.
- `python tools/eval_splices.py [ids]`, `tools/eval_voice.py [ids]` — objective quality of in-song jumps (spectral
  mismatch, clicks; singer changes, mid-line cuts, phrase placement).
- `python tools/link_report.py` — how well the library's songs connect; `tools/inspect_track.py [ids]` — per-track
  diagnostics.

## Architecture

**Data on disk** (`MASHLOOP_DATA`, default `data/`, git-ignored): `library/<id>/` holds `meta.json` (status, stage,
progress, summary stats), `audio.flac` (44.1 kHz; the browser plays the same samples the analysis saw, so beat
times map to samples directly), `analysis.json` (sent to the browser) and `features.npz` (per-beat feature matrices,
kept server-side for linking). `pairs/<a>/<b>.json` holds the transitions from song a to song b. Track ids are
content-derived (YouTube id, `x`+hash for other sites, `u`+SHA-1 for uploads; see `library.py`), so the same song
added by anyone is the same track. All JSON is written atomically via `library.write_json` with `allow_nan=False`.

**Request → analysed song.** `server.py` resolves input (`download.py`, yt-dlp; site allow-list) and registers
the track (`ingest.register`/`register_upload`), then `worker.enqueue_ingest`. `worker.py` runs two
`ProcessPoolExecutor`s with the **spawn** context (CUDA can't be forked): an ingest pool (`ANALYSIS_WORKERS`, each
process loads its own models on the GPU) that runs `ingest.process` → download, convert, `analysis/pipeline.analyze`;
and a link pool (`LINK_WORKERS`) that computes cross-song pairs. The server process only schedules and fires the
`on_ready` / `on_linked` callbacks; a crashed worker resets its pool and the song is retried once.

**Analysis pipeline** (`loopbox/analysis/pipeline.py` orchestrates): `beats.py` (Beat This! + onset refinement,
bar positions) → `models.py` (Demucs stems) → `features.py` (per-beat chroma, MFCC, loudness, rhythm, stem levels,
vocal pitch/timbre) → `structure.py` (tempo, key/Camelot, sections, phrase grid) → `jumps.py` (in-song jump edges,
using `similarity.py`; bridges out of trap regions, `lbp` = last branch point) → `mood.py`.
`transitions.py` is the cross-song search: per ordered pair it finds cuts, drops, beat-locked blends (with tempo
bending up to ~12 % and half/double time), fades and effects (echo/brake/roll), each with a quality `q`.
`assemble(ids)` builds a library's transition lists from the stored pairs and adds fallback fades so every song has
≥ `MIN_LINKS` exits and ≥ `MIN_IN` entries.

**Versioning.** `config.ANALYSIS_VERSION` — bump when `analysis.json`/`features.npz` change in a way that needs
re-analysis (on startup, `worker.start` re-queues every ready track with an older version).
`config.TRANSITIONS_VERSION` — bump when only the pair search changes (pairs with another version are treated as
missing and recomputed on demand). Data written by a *newer* version is never overwritten, and `worker.stale` makes
the UI tell the user to restart an old server.

**Personal vs hosted** (`sessions.py`). Every API route takes a `View` (via the `X-Session` header). `LocalView`
(default) = the whole on-disk store, persistent, deleting a song deletes it from disk. Personal mode also has
playlists (`playlists.py`, `data/playlists.json`): an `X-Playlist` header makes `view_of` return a `PlaylistView`, a
subset of the store, so the same track routes add to / remove from that playlist and transitions are assembled over
its songs only (the pairs already exist for the whole store). With `MASHLOOP_MULTIUSER=1`,
`SessionView` is an in-memory per-visit library (TTL, track limit, sample library doesn't count toward it) over the
shared store; deleting only removes it from that view, and LRU eviction (`MAX_STORE_GB`) never touches songs some
live session holds. Hosted-only guards: per-IP rate limits (`ratelimit.py`, in memory), backlog cap, data served
only to sessions holding the song, and audio XOR-scrambled with a per-session SHA-256 keystream
(`server.keystream`; `web/js/api.js` derives the same keystream to undo it — keep the two in sync). All tunables are
`MASHLOOP_*` env vars in `config.py`; production values are in `deploy/mashloop.service`.

**Frontend** (`web/js/`, plain ES modules served statically by FastAPI):
- `api.js` — session, REST calls, `Loader` (fetch + unscramble + decode, prefetching).
- `graph.js` — `Track`: the beat graph (sequential edges + jumps from `analysis.json`).
- `player.js` — the brain: each tick (40 ms) decides LOOKAHEAD (0.6 s) ahead whether to continue, jump, or leave
  via a planned transition (Dijkstra over the jump graph to the exit beat), scored by criterion (`CRITERIA`),
  type bias, mood distance, key fit. `engine.js` does the sample-accurate Web Audio scheduling (`Voice` per splice).
- `viz.js` (canvas ∞ stage), `theme.js` (mood → OKLCH colour, CSS custom properties), `main.js` (UI wiring).

`graph.js` and `player.js` must stay free of DOM/browser globals: `tools/sim_player.mjs` imports them directly
in Node. Changes to the shape of `analysis.json` or transition items have to be reflected in `graph.js`/`player.js`
(and the analysis version bumped).

**Design.** `design/` holds the concept and art direction (the ∞ as the instrument, one emissive accent colour =
the playing song's mood colour, fonts Unbounded / Be Vietnam Pro / JetBrains Mono). Read `ART_DIRECTION.md` before
changing visuals. Vietnamese labels stay sentence case.

**Deploy.** Two separate paths:
- `deploy/` (the production box behind https://mashloop.truclv.com): `pack.py <out.tgz>` packs tracked and
  untracked-but-not-ignored files; `setup.sh` installs on the Ubuntu GPU box (uv venv, torch, deno, systemd unit,
  app on 127.0.0.1 behind HAProxy with Let's Encrypt).
- `Dockerfile` / `docker-compose.yml` (see Commands).

Python dependencies are listed twice: `requirements.txt` (local dev, includes Playwright for `e2e_test.py`) and
`deploy/requirements-server.txt` (used by both `setup.sh` and the Dockerfile). A new runtime dependency must go in
both. `.sh`, `.service` and `.cfg` files must keep LF line endings (`.gitattributes`).
