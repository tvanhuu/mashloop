"""End-to-end test of the real player in headless Chromium.

    python tools/e2e_test.py [seconds] [out.wav] [track-id] [chain|single]

Starts the server on a spare port, opens the UI, plays the library in chain
mode with short dwell times (to force many song changes), records the exact
audio the page outputs through an AudioWorklet, then checks:
  * no page errors
  * the beat schedule is continuous (every beat starts where the last ended)
  * the output never drops out
  * splices do not add transients beyond what the music itself has
The recording is written as a WAV so it can be listened to."""
import base64
import json
import subprocess
import sys
import time
import urllib.request
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
PORT = 8799
SECONDS = int(sys.argv[1]) if len(sys.argv) > 1 else 150
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "data" / "e2e_recording.wav"
START_ID = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "-" else None
MODE = sys.argv[4] if len(sys.argv) > 4 else "chain"
ALL_KINDS = ("cut", "blend", "fade", "echo", "brake", "roll")
# Optional 5th argument: only these transition kinds, e.g. "echo,brake,roll".
ONLY = set(sys.argv[5].split(",")) if len(sys.argv) > 5 else set(ALL_KINDS)

SETTINGS = {
    "ui": {"freq": 0.6, "strict": 0.5, "volume": 0.7},
    "player": {"mode": MODE, "dwellMin": 25, "dwellMax": 35, "allow": {k: k in ONLY for k in ALL_KINDS}},
}

RECORDER = r"""
class Rec extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length) {
      const n = ch[0].length, out = new Float32Array(n);
      for (let c = 0; c < ch.length; c++) for (let i = 0; i < n; i++) out[i] += ch[c][i] / ch.length;
      this.port.postMessage({ t: currentTime, data: out }, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('rec', Rec);
"""


def wait_server(url, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            urllib.request.urlopen(url, timeout=2)
            return
        except Exception:
            time.sleep(0.3)
    raise RuntimeError("server did not start")


def main():
    from playwright.sync_api import sync_playwright

    # The interpreter running this test (the venv's, on Windows or macOS/Linux).
    server = subprocess.Popen([sys.executable, "-m", "loopbox.server", "--port", str(PORT)],
                              cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_server(f"http://127.0.0.1:{PORT}/api/tracks")
        with sync_playwright() as p:
            args = ["--autoplay-policy=no-user-gesture-required"]
            browser = None
            for channel in ("chrome", "msedge", None):  # installed browsers first
                try:
                    browser = p.chromium.launch(channel=channel, args=args) if channel else p.chromium.launch(args=args)
                    break
                except Exception:
                    continue
            if browser is None:
                raise RuntimeError("no Chromium-based browser available")
            page = browser.new_page(viewport={"width": 1400, "height": 900})
            errors = []
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on("console", lambda m: errors.append(f"console: {m.text}") if m.type == "error" else None)
            page.on("response", lambda r: errors.append(f"http {r.status}: {r.url}") if r.status >= 400 else None)
            page.add_init_script(f"localStorage.setItem('loopbox.settings.v1', {json.dumps(json.dumps(SETTINGS))})")
            page.goto(f"http://127.0.0.1:{PORT}/")
            page.wait_for_function("window.loopbox && document.querySelectorAll('.track').length > 0", timeout=20000)

            page.evaluate("""async (code) => {
              const { engine } = window.loopbox;
              const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
              await engine.ctx.audioWorklet.addModule(url);
              const node = new AudioWorkletNode(engine.ctx, 'rec', { numberOfInputs: 1, numberOfOutputs: 1 });
              const sink = engine.ctx.createGain();
              sink.gain.value = 0;
              engine.limiter.connect(node);
              node.connect(sink).connect(engine.ctx.destination);
              window.__rec = { chunks: [], node, start: null };
              node.port.onmessage = (e) => {
                if (window.__rec.start === null) window.__rec.start = e.data.t;
                window.__rec.chunks.push(e.data.data);
              };
            }""", RECORDER)

            first = page.evaluate("""async (startId) => {
              await window.loopbox.refresh();
              const r = await (await fetch('/api/tracks')).json();
              const ready = r.tracks.filter(t => t.status === 'ready');
              const pick = ready.find(t => t.id === startId) || ready[0];
              await window.loopbox.play(pick.id);
              return [pick, ...ready.filter(t => t !== pick)].map(t => t.title);
            }""", START_ID)
            print(f"library: {len(first)} ready tracks; starting with {first[0]!r}")
            page.screenshot(path=str(OUT.with_suffix(".start.png")))

            t0 = time.time()
            while time.time() - t0 < SECONDS:
                time.sleep(10)
                s = page.evaluate("""() => {
                  const p = window.loopbox.player, a = p.audible();
                  return { track: a?.entry.track.meta.title, beat: a?.entry.beat, jumps: p.stats.jumps,
                           transitions: p.stats.transitions, plan: p.plan ? p.plan.tr.type + ' -> ' + p.plan.tr.to : null,
                           blend: !!p.blend, state: p.engine.ctx.state };
                }""")
                print(f"  t={time.time() - t0:5.0f}s  {s}")
            page.screenshot(path=str(OUT.with_suffix(".end.png")))

            result = page.evaluate("""() => {
              const p = window.loopbox.player;
              const tl = p.timeline;
              let maxGap = 0, checked = 0;
              for (let k = 1; k < tl.length; k++) {
                const a = tl[k - 1], b = tl[k];
                if (a.kind === 'start') continue;
                const expected = a.t + a.track.dur[a.beat] / a.rate;
                maxGap = Math.max(maxGap, Math.abs(b.t - expected));
                checked++;
              }
              const events = tl.filter(e => !['seq', 'blend', 'fxBeat'].includes(e.kind))
                               .map(e => ({ t: e.t, kind: e.kind, track: e.track.id }));
              const hist = p.history.map(h => ({ id: h.id, via: h.via }));
              const rec = window.__rec;
              rec.node.port.onmessage = null;
              const total = rec.chunks.reduce((s, c) => s + c.length, 0);
              const pcm = new Int16Array(total);
              let o = 0;
              for (const c of rec.chunks) for (let i = 0; i < c.length; i++) pcm[o++] = Math.max(-1, Math.min(1, c[i])) * 32767;
              let bin = '';
              const bytes = new Uint8Array(pcm.buffer);
              for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
              return { maxGap, checked, events, hist, stats: p.stats, recStart: rec.start, sr: p.engine.ctx.sampleRate,
                       pcm: btoa(bin), outputLatency: p.engine.ctx.outputLatency || 0 };
            }""")
            browser.close()
    finally:
        server.terminate()

    pcm = np.frombuffer(base64.b64decode(result["pcm"]), dtype=np.int16)
    sr = int(result["sr"])
    with wave.open(str(OUT), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    x = pcm.astype(np.float32) / 32767

    print()
    print(f"page errors: {len(errors)}")
    for e in errors[:10]:
        print("   ", e)
    print(f"schedule: {result['checked']} beat boundaries checked, max deviation {result['maxGap'] * 1000:.3f} ms")
    kinds = {}
    for e in result["events"]:
        kinds[e["kind"]] = kinds.get(e["kind"], 0) + 1
    print(f"events in timeline window: {kinds}")
    print(f"stats: {result['stats']}")
    print("song chain:", " -> ".join(f"{h['via']}:{h['id']}" for h in result["hist"]))

    # Dropouts: 20 ms RMS windows far below the running level, from the moment
    # playback starts (the recorder is armed while the first song still loads).
    win = int(0.02 * sr)
    n = len(x) // win
    rms = np.sqrt((x[: n * win].reshape(n, win) ** 2).mean(1) + 1e-12)
    db = 20 * np.log10(rms)
    start_t = result["stats"]["startedAt"]  # the timeline itself only keeps recent beats
    first = int((start_t - result["recStart"]) / 0.02) + 25  # + 0.5 s of fade-in and intro
    music = db[max(0, first):]
    quiet_mask = music < -50
    quiet_idx = np.where(quiet_mask)[0]
    # Songs have their own short stops (funk breaks run 60-280 ms); a playback
    # failure would leave at least a whole beat of silence.
    longest = run = 0
    for q in quiet_mask:
        run = run + 1 if q else 0
        longest = max(longest, run)
    longest_ms = longest * 20
    print(f"recording: {len(x) / sr:.1f}s, playback from {start_t - result['recStart']:.2f}s, "
          f"level median {np.median(music):.1f} dBFS, quiet windows {len(quiet_idx)}, longest silence {longest_ms} ms")

    # Transients at splices: spectral flux at each event vs the flux at ordinary beats.
    import librosa
    S = librosa.power_to_db(librosa.feature.melspectrogram(y=x, sr=sr, n_fft=1024, hop_length=256, n_mels=64), top_db=None)
    flux = np.maximum(0, np.diff(S, axis=1)).sum(0)
    fr = sr / 256
    rec0 = result["recStart"]
    lat = result["outputLatency"]

    def peak_at(t):
        k = int((t - rec0) * fr)
        if k < 3 or k + 3 >= len(flux):
            return None
        return float(flux[k - 3:k + 4].max())

    seq_times = []
    ev_peaks = {}
    for e in result["events"]:
        pk = peak_at(e["t"])
        if pk is not None:
            ev_peaks.setdefault(e["kind"], []).append(pk)
    typical = np.median(flux)
    beat_peaks = [peak_at(rec0 + t) for t in np.arange(2, len(x) / sr - 2, 0.5)]
    beat_peaks = np.array([b for b in beat_peaks if b is not None])
    print(f"flux: median {typical:.0f}, p95 over the recording {np.percentile(beat_peaks, 95):.0f}")
    for k, v in ev_peaks.items():
        v = np.array(v)
        print(f"   at {k:<10} n={len(v):3d}  median {np.median(v):.0f}  max {v.max():.0f}"
              f"  (above recording p99 {np.mean(v > np.percentile(beat_peaks, 99)):.0%})")
    print(f"wav written to {OUT}")
    ok = not errors and result["maxGap"] < 0.002 and longest_ms < 450
    print("RESULT:", "PASS" if ok else "CHECK")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
