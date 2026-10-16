import { api, hooks, Loader, ready, session } from "./api.js";
import { Engine } from "./engine.js";
import { CRITERIA, DEFAULTS, keyFit, Player, shiftCamelot } from "./player.js";
import * as theme from "./theme.js";
import { bendNote, fmt, KIND_VI, short, splitTitle, Viz } from "./viz.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");

const engine = new Engine();
const loader = new Loader(engine);
const player = new Player(engine, loader);
const viz = new Viz($("#viz"), player, {
  center: $("#ring-center"),
  tip: $("#viz-tip"),
  onPick: (tr) => player.planTransition(tr),
  onCaption: () => renderStage(),
});

let metas = [];
let workerState = null;
let serverStale = false;
let lastLinks = null;
// The sample library: songs kept analysed on the server, for a first visit
// that does not know what to add. They come in ready and the chain starts.
const samples = { name: "", ids: [] };
// The server forgot this visit's library (it restarted): add the songs back.
hooks.restore = async () => {
  const ids = metas.map((m) => m.id);
  if (ids.length) await api.restore(ids).catch(() => {});
};
// Playlists of the personal app (none hosted). `all` counts the whole store.
const pls = { lists: [], all: 0 };
// The library row whose delete waits for a yes (personal app, "Tất cả bài").
let confirming = null;
hooks.playlistGone = () => {
  ui.playlist = null;
  save();
  loadPlaylists();
};
const byId = () => new Map(metas.map((m) => [m.id, m]));
const songOf = (m) => splitTitle(m?.title || "", m?.channel || "");
const titleOf = (id) => {
  const m = byId().get(id);
  return m ? songOf(m).title : id;
};

player.enabled = (id) => {
  const m = byId().get(id);
  return !!m && m.status === "ready" && m.enabled !== false;
};
loader.protect = () => [player.cur?.track.id, player.plan?.tr.to, player.blend?.B.id, ...player.prefetchIds].filter(Boolean);
loader.addEventListener("transitions", () => {
  viz.invalidate();
  renderExits();
});

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
  out: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M9 12h6"/></svg>',
  in: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M9 12h6M12 9v6"/></svg>',
  retry: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12a7 7 0 1 0 2.1-5"/><path d="M5 4v4h4"/></svg>',
  del: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  inf: '<svg viewBox="0 0 48 24" aria-hidden="true"><path d="M24 12 C 30 4, 42 4, 42 12 C 42 20, 30 20, 24 12 C 18 4, 6 4, 6 12 C 6 20, 18 20, 24 12 Z"/></svg>',
};

// ------------------------------------------------------------- segmented

// The amber pill slides to whichever option is on (mode switch, panel tabs).
function placeIndicator(seg) {
  const on = seg.querySelector("button.on");
  const ind = seg.querySelector(".seg__ind");
  if (!on || !ind) return;
  ind.style.setProperty("--ind-x", `${on.offsetLeft}px`);
  ind.style.setProperty("--ind-w", `${on.offsetWidth}px`);
}
const placeIndicators = () => document.querySelectorAll(".seg").forEach(placeIndicator);
window.addEventListener("resize", placeIndicators);
document.fonts?.ready.then(placeIndicators);

// ------------------------------------------------------------------ settings

const STORE = "loopbox.settings.v1";
// 2: the abrupt effects (brake, roll) became opt-in; older saved settings that
// had them on from the first release of effects are switched off once.
const SETTINGS_VERSION = 2;
const ui = { freq: 0.45, strict: 0.5, volume: 0.85, theme: "mood", playlist: null };
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || "null");
  if (saved) {
    Object.assign(ui, saved.ui || {});
    Object.assign(player.settings, saved.player || {});
    player.settings.allow = { ...DEFAULTS.allow, ...(saved.player?.allow || {}) };
    if ((saved.v || 1) < 2) {
      player.settings.allow.brake = false;
      player.settings.allow.roll = false;
    }
  }
} catch (_) {
  /* storage unavailable */
}
session.playlist = ui.playlist || null;

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ v: SETTINGS_VERSION, ui, player: player.settings }));
  } catch (_) {
    /* storage unavailable */
  }
}

// Range fill: the amber part of the track follows the value.
function syncRange(input) {
  const min = +input.min || 0, max = +input.max || 1;
  input.style.setProperty("--v", `${((+input.value - min) / (max - min)) * 100}%`);
}

function applySettings() {
  const s = player.settings;
  // Log scale: 60 s between jumps at the far left, 6 s at the far right.
  s.jumpEvery = 60 * Math.pow(0.1, ui.freq);
  s.keep = 0.15 + 0.85 * ui.strict;
  if (s.dwellMax < s.dwellMin) s.dwellMax = s.dwellMin;
  engine.setVolume(ui.volume);
  $("#s-freq").value = ui.freq;
  $("#v-freq").textContent = `~${Math.round(s.jumpEvery)} giây một lần`;
  $("#s-strict").value = ui.strict;
  $("#v-strict").textContent = `giữ ${Math.round(s.keep * 100)}% điểm tốt nhất`;
  $("#s-dmin").value = s.dwellMin;
  $("#v-dmin").textContent = fmt(s.dwellMin);
  $("#s-dmax").value = s.dwellMax;
  $("#v-dmax").textContent = fmt(s.dwellMax);
  if (!CRITERIA[s.criterion]) s.criterion = "balanced";
  for (const r of document.querySelectorAll('input[name="criterion"]')) r.checked = r.value === s.criterion;
  $("#s-variety").value = s.variety;
  $("#v-variety").textContent = `${Math.round(s.variety * 100)}%`;
  $("#s-cut").checked = s.allow.cut;
  $("#s-blend").checked = s.allow.blend;
  $("#s-fade").checked = s.allow.fade;
  $("#s-echo").checked = s.allow.echo !== false;
  $("#s-brake").checked = s.allow.brake !== false;
  $("#s-roll").checked = s.allow.roll !== false;
  $("#s-vol").value = ui.volume;
  $("#v-vol").textContent = `${Math.round(ui.volume * 100)}`;
  if (!theme.THEMES[ui.theme]) ui.theme = "mood";
  for (const r of document.querySelectorAll('input[name="look"]')) r.checked = r.value === ui.theme;
  if (theme.setTheme(ui.theme)) recolor();
  document.querySelectorAll('input[type="range"]').forEach(syncRange);
  for (const b of document.querySelectorAll(".mode button")) {
    const on = b.dataset.mode === s.mode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on);
  }
  placeIndicator($(".mode"));
  viz.invalidate();
  renderTransport();
  save();
}

$("#s-freq").addEventListener("input", (e) => ((ui.freq = +e.target.value), applySettings()));
$("#s-strict").addEventListener("input", (e) => ((ui.strict = +e.target.value), applySettings()));
$("#s-dmin").addEventListener("input", (e) => {
  player.settings.dwellMin = +e.target.value;
  if (player.settings.dwellMax < player.settings.dwellMin) player.settings.dwellMax = player.settings.dwellMin;
  applySettings();
});
$("#s-dmax").addEventListener("input", (e) => {
  player.settings.dwellMax = +e.target.value;
  if (player.settings.dwellMin > player.settings.dwellMax) player.settings.dwellMin = player.settings.dwellMax;
  applySettings();
});
for (const k of ["cut", "blend", "fade", "echo", "brake", "roll"]) {
  $(`#s-${k}`).addEventListener("change", (e) => ((player.settings.allow[k] = e.target.checked), applySettings()));
}
$("#s-vol").addEventListener("input", (e) => ((ui.volume = +e.target.value), applySettings()));
for (const r of document.querySelectorAll('input[name="look"]')) {
  r.addEventListener("change", () => ((ui.theme = r.value), applySettings()));
}

// The theme tiles preview their colours with three songs of this library.
function renderLooks() {
  const ids = theme.spreadIds();
  for (const tile of document.querySelectorAll(".look")) {
    const cols = theme.preview(tile.querySelector("input").value, ids);
    tile.querySelectorAll(".swatch i").forEach((dot, k) => dot.style.setProperty("--c", theme.css(cols[k])));
  }
}
$("#s-variety").addEventListener("input", (e) => ((player.settings.variety = +e.target.value), applySettings()));
for (const r of document.querySelectorAll('input[name="criterion"]')) {
  r.addEventListener("change", () => {
    player.settings.criterion = r.value;
    // An exit the chain chose under the old criterion is chosen again; one
    // the listener picked on the stage stays.
    if (player.plan && !player.plan.picked) player.cancelPlan();
    player.prefetchedFor = null;
    applySettings();
  });
}
for (const b of document.querySelectorAll(".mode button")) {
  b.addEventListener("click", () => {
    player.settings.mode = b.dataset.mode;
    player.cancelPlan();
    applySettings();
  });
}
for (const b of document.querySelectorAll(".tabs button")) {
  b.addEventListener("click", () => {
    for (const x of document.querySelectorAll(".tabs button")) {
      x.classList.toggle("on", x === b);
      x.setAttribute("aria-selected", x === b);
    }
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("on", t.id === `tab-${b.dataset.tab}`);
    placeIndicator($(".tabs"));
  });
}
$("#btn-relink").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "Đang tính lại…";
  await api.relink().catch(() => {});
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = "Tính lại điểm nối giữa các bài";
  }, 2500);
  refresh();
});

// ----------------------------------------------------------------- transport

let busy = false;

async function play(id) {
  // Resume inside the click itself: browsers only unlock audio on a user gesture.
  engine.ctx.resume();
  try {
    setBusy(true);
    await player.start(id);
  } catch (e) {
    alert(`Không phát được: ${e.message}`);
  } finally {
    setBusy(false);
  }
}

function setBusy(b) {
  busy = b;
  renderTransport();
}

$("#btn-play").addEventListener("click", async () => {
  if (busy) return;
  if (player.cur) await player.togglePause();
  else {
    const first = metas.find((m) => m.status === "ready" && m.enabled !== false) || metas.find((m) => m.status === "ready");
    if (first) await play(first.id);
  }
  renderTransport();
});
$("#btn-jump").addEventListener("click", () => player.requestJump());
$("#btn-next").addEventListener("click", () => player.requestNextSong());
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select")) return;
  if (e.code === "Space") {
    if (e.target.closest("button")) return; // a focused button handles Space itself
    e.preventDefault();
    $("#btn-play").click();
  } else if (e.key === "j" || e.key === "J") player.requestJump();
  else if (e.key === "n" || e.key === "N") player.requestNextSong();
});
player.addEventListener("state", renderTransport);
player.addEventListener("track", () => {
  renderLibrary();
  renderExits();
});
player.addEventListener("plan", renderExits);

function renderTransport() {
  const btn = $("#btn-play");
  const state = busy ? "load" : player.cur && player.playing ? "pause" : "play";
  btn.dataset.state = state;
  btn.setAttribute("aria-label", state === "load" ? "Đang tải bài" : state === "pause" ? "Tạm dừng" : player.cur ? "Tiếp tục" : "Phát");
  btn.disabled = busy || (!player.cur && !metas.some((m) => m.status === "ready"));
  $("#btn-jump").disabled = !player.cur;
  $("#btn-next").disabled = !player.cur || player.settings.mode !== "chain";
}

// ------------------------------------------------------------------ library

const STAGES = {
  queued: "đang chờ", downloading: "đang tải về", converting: "chuyển định dạng", analyzing: "đang phân tích",
  loading: "đọc audio", beats: "dò beat", stems: "tách giọng và nhạc cụ", features: "đo đặc trưng", structure: "tìm cấu trúc",
  jumps: "tìm điểm nhảy", analyzed: "xong phân tích", linking: "nối với thư viện", ready: "sẵn sàng", error: "lỗi",
};

// Mini loops: each ready track drawn as a small beat ring from its analysis,
// in its own colours, so the library reads as a palette of moods.
const analysisCache = new Map(); // id -> Promise<analysis|null>
const miniCache = new Map(); // `${id}|${palette}` -> Promise<HTMLCanvasElement|null>

function analysisOf(id) {
  if (!analysisCache.has(id)) {
    analysisCache.set(id, api.analysis(id).catch(() => {
      analysisCache.delete(id);
      return null;
    }));
  }
  return analysisCache.get(id);
}

function miniRing(id) {
  const key = `${id}|${theme.paletteVersion()}`;
  if (!miniCache.has(key)) {
    miniCache.set(key, analysisOf(id).then((a) => {
      if (!a) {
        miniCache.delete(key);
        return null;
      }
      const size = 76;
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      const ctx = c.getContext("2d");
      const r = size / 2 - 7;
      const end = a.duration;
      const lmax = Math.max(...a.loud), lmin = Math.min(...a.loud);
      const colors = theme.beatColors(id, a.color);
      ctx.lineWidth = 6;
      for (let b = 0; b < a.beats.length; b++) {
        const t0 = a.beats[b], t1 = b + 1 < a.beats.length ? a.beats[b + 1] : end;
        ctx.globalAlpha = 0.35 + 0.65 * ((a.loud[b] - lmin) / Math.max(1, lmax - lmin));
        ctx.strokeStyle = colors[b];
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, r, -Math.PI / 2 + (Math.PI * 2 * t0) / end, -Math.PI / 2 + (Math.PI * 2 * t1) / end + 0.01);
        ctx.stroke();
      }
      return c;
    }));
  }
  return miniCache.get(key);
}

function forget(id) {
  analysisCache.delete(id);
  for (const k of [...miniCache.keys()]) if (k.startsWith(`${id}|`)) miniCache.delete(k);
}

// Colours changed (another theme, or the library's moods moved): repaint.
function recolor() {
  miniCache.clear();
  for (const c of document.querySelectorAll("canvas.mini[data-id]")) delete c.dataset.painted;
  paintMinis();
  viz.invalidate();
  renderLooks();
  if (setlistEl) setlistEl.dataset.html = "";
}

function paintMinis() {
  const palette = theme.paletteVersion();
  for (const c of document.querySelectorAll("canvas.mini[data-id]")) {
    if (c.dataset.painted === palette) continue;
    c.dataset.painted = palette;
    miniRing(c.dataset.id).then((img) => {
      if (!img) return;
      const ctx = c.getContext("2d");
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
    });
  }
}

function trackRow(m) {
  const playing = player.audible()?.entry.track.id === m.id;
  let lead, status;
  if (m.status === "ready") {
    lead = `<canvas class="mini" data-id="${esc(m.id)}" width="76" height="76" aria-hidden="true"></canvas>`;
    const artist = songOf(m).artist;
    status = `<div class="s">${artist ? `<span class="a">${esc(artist)}</span> · ` : ""}${m.bpm ? m.bpm.toFixed(0) : "?"} BPM · ${esc(m.camelot || "")}</div>`;
  } else if (m.status === "error") {
    lead = `<span class="pending" style="--p:0;opacity:.5" aria-hidden="true"></span>`;
    status = `<div class="s err">${esc(m.error || "lỗi")}</div>`;
  } else {
    lead = `<span class="pending" style="--p:${(m.progress || 0).toFixed(3)}" aria-hidden="true"></span>`;
    status = `<div class="s">${STAGES[m.stage] || m.stage || "đang chờ"} · ${Math.round(100 * (m.progress || 0))}%</div><div class="progress"><i style="width:${Math.round(100 * (m.progress || 0))}%"></i></div>`;
  }
  const title = esc(songOf(m).title);
  const full = esc(`${m.title}${m.status === "ready" ? ` · ${m.jumps ?? 0} nhánh nhảy · ${fmt(m.duration || 0)}` : ""}`);
  const acts = m.status === "ready"
    ? `<button type="button" data-act="play" aria-label="Phát ${title}" title="Phát từ bài này">${ICON.play}</button>
       <button type="button" data-act="toggle" aria-label="${m.enabled === false ? "Đưa vào chuỗi" : "Bỏ khỏi chuỗi"}" title="${m.enabled === false ? "Đưa vào chuỗi" : "Bỏ khỏi chuỗi"}">${m.enabled === false ? ICON.in : ICON.out}</button>`
    : m.status === "error" ? `<button type="button" data-act="retry" aria-label="Thử lại" title="Thử lại">${ICON.retry}</button>` : "";
  const del = session.playlist ? ["Bỏ khỏi playlist", `Bỏ ${title} khỏi playlist`] : ["Xoá", `Xoá ${title}`];
  const ask = confirming === m.id && !session.playlist
    ? `<div class="track__confirm" role="group" aria-label="Xác nhận xoá ${title}">
        <p>Xoá bài này khỏi thư viện? File nhạc và phân tích trên máy cũng bị xoá${pls.lists.length ? ", bài bị bỏ khỏi mọi playlist" : ""}.</p>
        <div class="track__confirm-acts"><button type="button" class="danger" data-act="delete-yes">Xoá</button><button type="button" class="quiet" data-act="delete-no">Huỷ</button></div>
      </div>`
    : "";
  return `<li class="track ${playing ? "playing" : ""} ${m.enabled === false ? "off" : ""} ${ask ? "confirming" : ""}" data-id="${esc(m.id)}">
    ${lead}
    <div><div class="t" title="${full}">${title}</div>${status}</div>
    <div class="acts">${acts}<button type="button" data-act="delete" aria-label="${del[1]}" title="${del[0]}" aria-expanded="${!!ask}">${ICON.del}</button></div>${ask}
  </li>`;
}

let lastListHtml = "";
function renderLibrary() {
  const sampleBtn = samples.ids.length
    ? `<button type="button" class="ghost sample-btn" data-act="samples">Nghe thử ${esc(samples.name)} · ${samples.ids.length} bài</button>`
    : "";
  const html = metas.length
    ? metas.slice().reverse().map(trackRow).join("")
    : session.playlist
      ? `<li class="empty">${ICON.inf}Playlist này chưa có bài nào.<br>Thêm bài ở ô phía trên, hoặc chọn những bài đã có trong thư viện.<button type="button" class="ghost sample-btn" data-act="pick">Thêm từ thư viện</button></li>`
    : session.multiuser
      ? `<li class="empty">${ICON.inf}Thư viện của bạn đang trống.<br>Dán link YouTube, SoundCloud, Zing MP3, gõ tên bài, hoặc thả file nhạc (cả file zip) vào đây.<br>Chưa biết thêm gì? Nghe thử một thư viện có sẵn:${sampleBtn}</li>`
      : `<li class="empty">${ICON.inf}Thư viện còn trống.<br>Gõ tên một bài ở ô phía trên để thêm vòng đầu tiên.${sampleBtn}</li>`;
  if (html !== lastListHtml) {
    lastListHtml = html;
    $("#track-list").innerHTML = html;
    paintMinis();
  }
  const readyCount = metas.filter((m) => m.status === "ready").length;
  const own = metas.filter((m) => !samples.ids.includes(m.id)).length;
  $("#lib-count").textContent = session.limits.tracks
    ? `${own}/${session.limits.tracks} bài`
    : metas.length ? `${readyCount}/${metas.length}` : "";
  const w = workerState || {};
  const busy = metas.filter((m) => m.status !== "ready" && m.status !== "error");
  const active = busy.filter((m) => m.status !== "queued");
  let line = "";
  if (serverStale) line = "Server đang chạy phiên bản cũ: tắt nó (Ctrl+C) rồi chạy lại run.ps1";
  else if (w.relink) line = "Đang tính lại điểm nối giữa các bài…";
  else if (busy.length) {
    line = active.length === 1
      ? `Đang xử lý ${short(songOf(active[0]).title, 30)} · ${STAGES[active[0].stage] || active[0].stage}`
      : active.length > 1 ? `Đang xử lý ${active.length} bài cùng lúc` : "Đang chờ tới lượt xử lý";
    if (busy.length > active.length) line += ` · ${busy.length - active.length} bài chờ`;
  } else if (w.linking) line = `Đang nối các bài với nhau · còn ${w.linking} cặp`;
  $("#worker").textContent = line;
  viz.setTitles(new Map(metas.map((m) => [m.id, songOf(m).title])));
  renderTransport();
}

async function loadSamples(btn) {
  btn.disabled = true;
  btn.textContent = "Đang mở thư viện mẫu…";
  engine.ctx.resume(); // inside the click: lets the chain start playing below
  try {
    await api.restore(samples.ids);
    await refresh();
    const first = metas.find((m) => m.status === "ready");
    if (first && !player.cur) await play(first.id);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = `Không mở được: ${err.message}`;
  }
}

$("#track-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  if (btn.dataset.act === "samples") return loadSamples(btn);
  if (btn.dataset.act === "pick") return openPicker();
  const id = btn.closest(".track").dataset.id;
  const m = byId().get(id);
  switch (btn.dataset.act) {
    case "play":
      await play(id);
      break;
    case "toggle":
      await api.patch(id, { enabled: m.enabled === false });
      break;
    case "retry":
      await api.reanalyze(id);
      break;
    case "delete":
      // In a playlist the song only leaves the list: it stays in the store,
      // and if it is playing it carries on and hands over to the playlist.
      if (session.playlist) {
        await api.remove(id);
        break;
      }
      // Personal, deleting removes the files: the row asks first. Hosted the
      // song only leaves this visit's library, so no question.
      if (!session.multiuser) return askDelete(confirming === id ? null : id);
    // falls through
    case "delete-yes":
      confirming = null;
      if (player.cur?.track.id === id) player.stop();
      loader.drop(id);
      forget(id);
      await api.remove(id);
      break;
    case "delete-no":
      return askDelete(null);
  }
  refresh();
});

$("#track-list").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && confirming) askDelete(null);
});

// Asks on the row itself before deleting a song from the store (`confirming`
// is the row waiting for a yes).
function askDelete(id) {
  const back = confirming;
  confirming = id;
  renderLibrary();
  const row = (t) => $(`#track-list .track[data-id="${t}"]`);
  if (id) row(id)?.querySelector('[data-act="delete-no"]')?.focus();
  else if (back) row(back)?.querySelector('[data-act="delete"]')?.focus();
}

async function refresh() {
  try {
    const r = await api.tracks();
    metas = r.tracks;
    workerState = r.worker;
    loader.setMetas(metas);
    // New pairs were linked in this library: loaded songs pick up their new exits.
    if (lastLinks !== null && r.links !== lastLinks) {
      loader.refreshAll();
      viz.invalidate();
    }
    lastLinks = r.links;
    if (theme.setMoods(metas.filter((m) => m.status === "ready"))) recolor();
    // An old server process (started before an update) is still serving: its
    // results would not match the files on disk. Servers older than this check
    // do not send the flag at all.
    serverStale = !("stale_server" in r) || r.stale_server;
    const open = pls.lists.find((p) => p.id === session.playlist);
    if (open) open.count = metas.length;
    else if (!session.playlist) pls.all = metas.length;
    renderPlaylists();
    renderLibrary();
  } catch (_) {
    $("#worker").textContent = "Mất kết nối tới server";
  }
}

let pollTimer = null;
function schedulePoll() {
  clearTimeout(pollTimer);
  const working = metas.some((m) => m.status !== "ready" && m.status !== "error") || workerState?.current;
  pollTimer = setTimeout(async () => {
    await refresh();
    schedulePoll();
  }, working ? 1200 : 5000);
}

// ---------------------------------------------------------------- playlists

// Personal app only. "Tất cả bài" is the store itself; a playlist is a set of
// its songs, and while one is open the whole page works on it: the list, what
// is added, and the chain (the server assembles its exits over the playlist).
const HINT = $("#add-hint").textContent;
const openPlaylist = () => pls.lists.find((p) => p.id === session.playlist) || null;

async function loadPlaylists() {
  if (!session.playlists) return;
  try {
    const r = await api.playlists();
    pls.lists = r.playlists;
    pls.all = r.all;
  } catch (_) {
    return;
  }
  if (session.playlist && !openPlaylist()) await switchPlaylist(null);
  renderPlaylists();
}

let lastChipsHtml = "";
function renderPlaylists() {
  const box = $("#playlists");
  box.hidden = !session.playlists;
  if (box.hidden) return;
  const pl = openPlaylist();
  const chip = (id, name, n) => `<button type="button" class="chip ${(id || null) === session.playlist ? "on" : ""}" data-pl="${esc(id)}" aria-pressed="${(id || null) === session.playlist}" title="${esc(name)}"><span>${esc(name)}</span><span class="n">${n}</span></button>`;
  const html = chip("", "Tất cả bài", pls.all) + pls.lists.map((p) => chip(p.id, p.name, p.count)).join("") +
    `<button type="button" class="chip new" data-act="new">+ Playlist mới</button>`;
  if (html !== lastChipsHtml) {
    lastChipsHtml = html;
    $("#pl-chips").innerHTML = html;
  }
  $("#pl-acts").hidden = !pl;
  $('label[for="add-input"]').textContent = pl ? `Thêm bài vào ${pl.name}` : "Thêm bài vào thư viện";
  $("#shelf-title").textContent = pl ? `Các vòng trong ${pl.name}` : "Các vòng trong thư viện";
  $("#add-hint").textContent = pl
    ? `Bài mới được tải về, phân tích, rồi vào ${pl.name}. Bài đã có trong thư viện thì vào ngay.`
    : HINT;
}

async function switchPlaylist(pid) {
  if (pid === session.playlist) return;
  session.playlist = pid;
  ui.playlist = pid;
  save();
  confirming = null;
  closePicker();
  $("#search-results").innerHTML = "";
  lastLinks = null;
  await refresh();
  // Every loaded song re-reads its exits inside the new set, except the one
  // playing when it is not in it: its old exits lead it into the new set
  // through a real transition (an empty list would loop it forever).
  const cur = player.cur?.track;
  const outside = cur && !metas.some((m) => m.id === cur.id);
  loader.refreshAll(outside ? cur.id : null);
  player.prefetchedFor = null;
  if (player.plan && !player.enabled(player.plan.tr.to)) player.cancelPlan();
  viz.invalidate();
  if (outside) {
    if (cur.transitions.some((tr) => player.enabled(tr.to))) player.requestNextSong();
    else {
      const first = metas.find((m) => m.status === "ready" && m.enabled !== false);
      if (first) await play(first.id);
    }
  }
  renderExits();
}

// One box under the chips holds whatever the playlist row is asking: a name
// (new, rename), a confirmation (delete), or the songs to pick. In the page's
// own style, never the browser's prompt or confirm.
const picker = $("#pl-picker");
function closePicker() {
  picker.innerHTML = "";
  delete picker.dataset.mode;
}

function showPanel(mode, html) {
  picker.dataset.mode = mode;
  picker.innerHTML = html;
}

function askName(mode) {
  const pl = openPlaylist();
  if (mode === "rename" && !pl) return;
  showPanel(mode, `<form class="pl-form">
      <label class="label" for="pl-name">${mode === "new" ? "Tên playlist mới" : "Đổi tên playlist"}</label>
      <div class="add__field">
        <input id="pl-name" type="text" maxlength="80" autocomplete="off" enterkeyhint="done" placeholder="Ví dụ: Đêm chill" value="${mode === "rename" ? esc(pl.name) : ""}">
        <button type="submit">${mode === "new" ? "Tạo" : "Lưu"}</button>
      </div>
      <p class="pl-err" role="alert"></p>
    </form>
    <div class="pick-foot"><button type="button" class="quiet" data-pick="close">Huỷ</button></div>`);
  const input = $("#pl-name");
  input.focus();
  input.select();
}

function askDrop() {
  const pl = openPlaylist();
  if (!pl) return;
  showPanel("drop", `<div class="msg">Xoá playlist <strong>${esc(pl.name)}</strong>? Các bài vẫn còn trong thư viện.</div>
    <div class="pick-foot"><button type="button" class="danger" data-pick="drop">Xoá playlist</button><button type="button" class="quiet" data-pick="close">Huỷ</button></div>`);
  picker.querySelector('[data-pick="drop"]').focus();
}

picker.addEventListener("submit", async (e) => {
  e.preventDefault();
  const mode = picker.dataset.mode;
  const name = $("#pl-name").value.trim();
  const btn = picker.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    if (mode === "new") {
      const p = await api.createPlaylist(name);
      pls.lists.push(p);
      await switchPlaylist(p.id);
      if (pls.all) openPicker();
    } else {
      if (name) await api.renamePlaylist(session.playlist, name);
      closePicker();
      await loadPlaylists();
    }
  } catch (err) {
    btn.disabled = false;
    picker.querySelector(".pl-err").textContent = `${mode === "new" ? "Không tạo được" : "Không đổi tên được"}: ${err.message}`;
  }
});

picker.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePicker();
});

// "Thêm từ thư viện": the songs of the store not in the open playlist, to tick.
async function openPicker() {
  if (!session.playlist) return;
  showPanel("pick", `<div class="msg">Đang mở thư viện…</div>`);
  let all;
  try {
    all = (await api.storeTracks()).tracks;
  } catch (err) {
    picker.innerHTML = `<div class="msg">Không mở được thư viện: ${esc(err.message)}</div>`;
    return;
  }
  const have = new Set(metas.map((m) => m.id));
  const rest = all.filter((m) => !have.has(m.id) && m.status !== "error").reverse();
  const close = `<button type="button" class="quiet" data-pick="close">Đóng</button>`;
  if (!rest.length) {
    picker.innerHTML = `<div class="msg">Mọi bài trong thư viện đã có trong playlist này.</div><div class="pick-foot">${close}</div>`;
    return;
  }
  const row = (m) => {
    const song = songOf(m);
    const info = m.status === "ready" ? `${m.bpm ? m.bpm.toFixed(0) : "?"} BPM · ${esc(m.camelot || "")}` : "đang phân tích";
    return `<label class="pick"><input type="checkbox" value="${esc(m.id)}"><span><span class="t">${esc(song.title)}</span><span class="s">${song.artist ? `${esc(song.artist)} · ` : ""}${info}</span></span></label>`;
  };
  picker.innerHTML = `<div class="pick-list">${rest.map(row).join("")}</div>
    <div class="pick-foot"><button type="button" data-pick="add" disabled>Thêm vào playlist</button>${close}</div>`;
}

picker.addEventListener("change", () => {
  const n = picker.querySelectorAll("input:checked").length;
  const add = picker.querySelector('[data-pick="add"]');
  if (!add) return;
  add.disabled = !n;
  add.textContent = n ? `Thêm ${n} bài vào playlist` : "Thêm vào playlist";
});

picker.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-pick]");
  if (!btn) return;
  if (btn.dataset.pick === "close") return closePicker();
  if (btn.dataset.pick === "drop") {
    const pid = session.playlist;
    btn.disabled = true;
    await api.deletePlaylist(pid).catch(() => {});
    pls.lists = pls.lists.filter((p) => p.id !== pid);
    await switchPlaylist(null);
    return loadPlaylists();
  }
  const ids = [...picker.querySelectorAll("input:checked")].map((i) => i.value);
  btn.disabled = true;
  try {
    await api.restore(ids);
    closePicker();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = `Không thêm được: ${err.message}`;
  }
  await refresh();
  schedulePoll();
});

$("#playlists").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn || btn.closest("#pl-picker")) return;
  if ("pl" in btn.dataset) return switchPlaylist(btn.dataset.pl || null);
  const act = btn.dataset.act;
  if (!act) return;
  // The same button again closes what it opened.
  if (picker.dataset.mode === act) return closePicker();
  if (act === "new" || act === "rename") askName(act);
  else if (act === "pick") openPicker();
  else if (act === "drop") askDrop();
});

// --------------------------------------------------------------- add / search

const isUrl = (s) => /^https?:\/\//i.test(s.trim());

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#add-input").value.trim();
  if (!text) return;
  const box = $("#search-results");
  const submit = $("#add-form button[type=submit]");
  submit.disabled = true;
  if (isUrl(text)) {
    box.innerHTML = `<div class="msg">Đang thêm…</div>`;
    try {
      const r = await api.add(text);
      const have = r.added.filter((m) => m.status === "ready").length;
      const todo = r.added.length - have;
      box.innerHTML = `<div class="msg">${[have && `Đã thêm ${have} bài có sẵn`, todo && `${have ? "" : "Đã thêm "}${todo} bài vào hàng đợi phân tích`].filter(Boolean).join(", ") || "Không thêm được bài nào"}.${r.note ? ` ${esc(r.note)}.` : ""}</div>`;
      $("#add-input").value = "";
      setTimeout(() => (box.innerHTML = ""), 3000);
    } catch (err) {
      box.innerHTML = `<div class="msg">Không thêm được: ${esc(err.message)}</div>`;
    }
    submit.disabled = false;
    refresh();
    schedulePoll();
    return;
  }
  box.innerHTML = `<div class="msg">Đang tìm trên YouTube…</div>`;
  try {
    const { results } = await api.search(text);
    const have = byId();
    box.innerHTML = results.length
      ? results.map((r) => `<div class="result">
          <img src="${esc(r.thumbnail)}" alt="" loading="lazy" width="64" height="36">
          <div><div class="t" title="${esc(r.title)}">${esc(r.title)}</div><div class="s">${esc(r.channel)}${r.duration ? ` · ${fmt(r.duration)}` : ""}</div></div>
          <button type="button" data-url="${esc(r.url)}" ${have.has(r.id) ? "disabled" : ""}>${have.has(r.id) ? "Đã có" : "Thêm"}</button>
        </div>`).join("")
      : `<div class="msg">Không tìm thấy bài nào. Thử tên khác, hoặc dán link YouTube.</div>`;
  } catch (err) {
    box.innerHTML = `<div class="msg">Tìm không được: ${esc(err.message)}</div>`;
  }
  submit.disabled = false;
});

$("#search-results").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-url]");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    await api.add(btn.dataset.url);
    btn.textContent = "Đã thêm";
  } catch (err) {
    btn.textContent = "Lỗi";
    btn.title = err.message;
  }
  refresh();
  schedulePoll();
});

// ------------------------------------------------------------------ upload

// Files go up one after another (the server analyses several at once anyway);
// each gets a line with its progress in the results box.
const uploads = [];
let uploading = false;

function renderUploads() {
  const box = $("#search-results");
  if (!uploads.length) return;
  box.innerHTML = uploads.map((u) => `<div class="upload-row ${u.error ? "err" : ""}">
      <div class="t">${esc(u.name)}</div>
      ${u.error ? `<small>${esc(u.error)}</small>`
        : u.done ? `<small>${u.count > 1 ? `Đã thêm ${u.count} bài` : "Đã thêm"}, đang phân tích${u.note ? `. ${esc(u.note)}` : ""}</small>`
        : `<div class="progress"><i style="width:${Math.round(100 * u.p)}%"></i></div>`}
    </div>`).join("");
}

async function uploadFiles(files) {
  const maxMb = session.limits.upload_mb || 80;
  for (const f of files) {
    const u = { name: f.name, p: 0, done: false, error: null, file: f };
    if (f.size > maxMb * 1024 * 1024) u.error = `Lớn hơn ${maxMb} MB`;
    else if (f.type && !/^(audio|video)\/|zip/.test(f.type) && !/\.zip$/i.test(f.name)) u.error = "Không phải file âm thanh";
    uploads.push(u);
  }
  renderUploads();
  if (uploading) return;
  uploading = true;
  for (const u of uploads) {
    if (u.done || u.error) continue;
    try {
      const r = await api.upload(u.file, (p) => ((u.p = p), renderUploads()));
      u.done = true;
      u.count = r?.added?.length || 0;
      u.note = r?.note || "";
    } catch (err) {
      u.error = `Không tải lên được: ${err.message}`;
    }
    u.file = null;
    renderUploads();
    refresh();
    schedulePoll();
  }
  uploading = false;
  setTimeout(() => {
    if (uploading) return;
    uploads.length = 0;
    $("#search-results").innerHTML = "";
  }, 6000);
}

$("#file-input").addEventListener("change", (e) => {
  uploadFiles([...e.target.files]);
  e.target.value = "";
});

// Drop files anywhere on the page.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
document.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add("dragging");
});
document.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove("dragging");
});
document.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  uploadFiles([...e.dataTransfer.files]);
});

// ------------------------------------------------------------- stage text

const KIND = { cut: "nối thẳng", drop: "drop", blend: "blend khớp nhịp", fade: "crossfade", echo: "echo vang", brake: "phanh đĩa", roll: "cuộn nhịp" };
const KIND_CAP = KIND_VI;
const CRIT_TAG = { mood: "CÙNG MOOD", tempo: "CÙNG NHỊP", key: "HỢP TÔNG", free: "TỰ DO" };

// Why the chain picked this exit, in the terms of the chosen criterion.
function criterionNote(T, tr) {
  const m = byId().get(tr.to);
  switch (player.settings.criterion) {
    case "mood": {
      const d = tr.mood ?? 0;
      return ` · ${d < 0.25 ? "mood rất gần" : d < 0.5 ? "mood gần" : "mood hơi khác"}`;
    }
    case "tempo":
      return m?.bpm ? ` · ${Math.round(T.analysis.bpm)} → ${Math.round(m.bpm)} BPM` : "";
    case "key": {
      if (!m?.camelot) return "";
      const fit = keyFit(T.analysis.camelot, m.camelot, tr.semis ?? 0);
      return ` · tông ${esc(T.analysis.camelot)} → ${esc(shiftCamelot(m.camelot, tr.semis ?? 0))}${fit >= 0.8 ? ", hợp" : fit > 0.3 ? ", gần hợp" : ""}`;
    }
    default:
      return "";
  }
}

function setHTML(el, html) {
  if (el.innerHTML !== html) el.innerHTML = html;
}

function renderStage() {
  const view = player.audible();
  const p = player;
  const T = view?.entry.track;
  if (!T) {
    const empty = !metas.some((m) => m.status === "ready");
    setHTML($("#rc-kicker"), "HAI VÒNG ĐANG CHỜ");
    setHTML($("#rc-title"), empty ? "Thêm một bài để có vòng đầu tiên" : "Chọn một bài để bắt đầu vòng lặp");
    setHTML($("#rc-meta"), empty ? "Gõ tên bài ở ô Thêm bài trong thư viện" : "Bấm phát, hoặc nút ▶ ở một bài trong thư viện");
    setHTML($("#ro-tl"), `<b>MASH ∞ LOOP</b> // ${p.settings.mode === "chain" ? "chuỗi" : "một bài"} · chưa phát`);
    setHTML($("#ro-tr"), `<span class="mono">∞ 0:00</span><span class="ro-stats"> · chưa có vòng nào</span>`);
    setHTML($("#next-info"), "");
    return;
  }
  // The mix as heard (the stage holds it until its end reaches the speakers).
  const held = viz.mixNow;
  const b = held?.blend ? held.m : null;
  const fx = held && !held.blend ? held.m : null;
  const blending = b && view.now >= b.times[0];
  setHTML($("#rc-kicker"), blending ? "ĐANG BLEND" : p.settings.mode === "chain" ? "ĐANG PHÁT · CHUỖI" : "ĐANG PHÁT · LẶP MÃI");
  // Past the middle of a blend the caption has moved into the next loop.
  const shown = viz.captionTrack?.analysis ? viz.captionTrack : T;
  const sa = shown.analysis;
  const song = songOf(shown.meta);
  setHTML($("#rc-title"), esc(song.title || shown.id));
  setHTML($("#rc-meta"), `${song.artist ? `<span class="rc-artist">${esc(song.artist)}</span>` : ""}<span class="mono">${sa.bpm.toFixed(0)} BPM · ${esc(sa.camelot)} · ${esc(sa.key)}</span>`);
  const crit = p.settings.mode === "chain" && CRIT_TAG[p.settings.criterion] ? ` · ${CRIT_TAG[p.settings.criterion]}` : "";
  setHTML($("#ro-tl"), `<b>${p.settings.mode === "chain" ? "CHUỖI" : "LẶP"}${crit}</b> // ${esc(short(shown.meta.channel || shown.meta.title || "", 34))}`);
  const listened = Math.max(0, view.now - p.stats.startedAt);
  setHTML($("#ro-tr"), `<span class="mono">∞ ${fmt(listened)}</span><span class="ro-stats"> · ${p.stats.jumps} nhảy · ${p.stats.transitions} chuyển</span>`);

  const now = view.now;
  const name = (id) => esc(short(titleOf(id), 46));
  let next;
  if (blending) {
    const k = Math.min(1, (now - b.times[0]) / (b.times[b.L] - b.times[0]));
    const note = bendNote(b.tr);
    next = `Đang blend sang <strong>${name(b.B.id)}</strong> · <span class="eta">${Math.round(k * 100)}%</span>${note ? ` · ${note}` : ""}`;
  } else if (fx) {
    next = `Đang ${KIND[fx.tr.type]} sang <strong>${name(fx.B.id)}</strong>`;
  } else if (p.plan) {
    const eta = Math.max(0, p.plan.eta - now);
    const note = bendNote(p.plan.tr);
    next = `${p.plan.picked ? "Bạn đã chọn: " : "Sắp "}${KIND[p.plan.tr.type] || p.plan.tr.type} sang <strong>${name(p.plan.tr.to)}</strong> · <span class="eta">${fmt(eta)}</span>` +
      ` · khớp ${Math.round(p.plan.tr.q * 100)}%${criterionNote(T, p.plan.tr)}${note ? ` · ${note}` : ""}${p.plan.target ? "" : " · đang tải"}`;
  } else if (p.settings.mode === "chain") {
    const left = p.dwellStart + p.settings.dwellMin - now;
    next = left > 0
      ? `Có thể chuyển bài sau <span class="eta">${fmt(left)}</span>, ở điểm nối tốt gần nhất`
      : `Đang chờ điểm nối tốt gần nhất…`;
  } else {
    next = "Lặp mãi bài này. Chạm một chấm ngoài vòng để tự chọn điểm chuyển bài.";
  }
  setHTML($("#next-info"), next);
}

// Setlist: the session as a chain of linked loops, each in its song's colour.
const setlistEl = $("#history");
function renderSetlist() {
  const hist = player.history.filter((h) => h.at <= engine.audibleTime()).slice(-11);
  const col = (id) => theme.css(theme.songColor(id));
  const html = hist.slice(-10).map((h, k, list) => {
    const prev = k ? list[k - 1] : hist.length > list.length ? hist[0] : null;
    return `<li data-via="${h.via}" style="--hue:${col(h.id)}${prev ? `;--from:${col(prev.id)}` : ""}"><span class="loop" aria-hidden="true"></span><span>${esc(short(titleOf(h.id), 30))}</span><span class="sr">, vào bằng ${h.via === "start" ? "bắt đầu" : KIND[h.via] || h.via}</span></li>`;
  }).join("");
  const ol = setlistEl;
  if (ol.dataset.html !== html) {
    ol.dataset.html = html;
    ol.innerHTML = html;
    ol.scrollLeft = ol.scrollWidth;
  }
}

// Keyboard and screen-reader access to the exits that the stage draws as dots.
const exits = document.createElement("div");
exits.className = "exits";
exits.innerHTML = `<p class="label">Điểm nối sang bài khác</p><ul></ul>`;
$("#canvas-wrap").append(exits);

function renderExits() {
  const T = player.cur?.track;
  const list = T ? T.transitions.filter((tr) => player.enabled(tr.to)).sort((x, y) => y.q - x.q).slice(0, 8) : [];
  exits.querySelector("ul").innerHTML = list.map((tr, k) =>
    `<li><button type="button" data-k="${k}">${KIND_CAP[tr.type]} → ${esc(short(titleOf(tr.to), 32))} <span class="mono">${Math.round(tr.q * 100)}%</span></button></li>`).join("");
  exits.hidden = !list.length;
  exits._list = list;
}
exits.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-k]");
  if (!btn) return;
  const ok = player.planTransition(exits._list[+btn.dataset.k]);
  btn.classList.toggle("is-bad", !ok);
});

setInterval(() => {
  renderStage();
  renderSetlist();
}, 250);

let lastPlaying = null;
setInterval(() => {
  const id = player.audible()?.entry.track.id || null;
  if (id !== lastPlaying) {
    lastPlaying = id;
    renderLibrary();
  }
}, 500);

// Mark: the dot runs along the ∞. One fast lap when the mark is hovered.
(function traceMark() {
  const path = document.querySelector(".brand__path");
  const dot = document.querySelector(".brand__dot");
  if (!path || !dot) return;
  const len = path.getTotalLength();
  let u = 0.25, last = performance.now(), boost = 0;
  document.querySelector(".brand").addEventListener("pointerenter", () => (boost = 1));
  const step = (now) => {
    const dt = (now - last) / 1000;
    last = now;
    if (!reduceMQ.matches) {
      u = (u + dt * (1 / 6 + boost * 1.2)) % 1;
      boost = Math.max(0, boost - dt * 0.9);
    }
    const pt = path.getPointAtLength(u * len);
    dot.setAttribute("cx", pt.x.toFixed(2));
    dot.setAttribute("cy", pt.y.toFixed(2));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
})();

applySettings();
renderLooks();
renderTransport();
renderStage();
placeIndicators();
ready().then(() => {
  if (session.multiuser) {
    // Hosted: a library per visit; pairs are linked automatically and shared.
    $("#add-hint").textContent = "Mỗi lần mở trang là một thư viện mới. Bài ai đó đã thêm trước sẽ vào ngay, không phải chờ phân tích.";
    $("#btn-relink").hidden = true;
  }
  if (!session.playlists && session.playlist) {
    session.playlist = null;
    refresh();
  }
  loadPlaylists();
  if (session.limits.upload_mb) $("#upload-limit").textContent = `, tối đa ${session.limits.upload_mb} MB`;
  renderLibrary();
  api.samples().then((s) => {
    Object.assign(samples, s);
    lastListHtml = "";
    renderLibrary();
  }, () => {});
}).catch(() => {});
refresh().then(schedulePoll);

// Handle for the browser console and the end-to-end test.
window.loopbox = { player, engine, loader, play, refresh, applySettings, ui, viz, session };
