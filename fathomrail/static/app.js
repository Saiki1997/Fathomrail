const $ = (id) => document.getElementById(id);
const state = { items: {}, running: false, clip: false, lastClip: "", nextRun: 0 };

function fmt(n) {
  n = Number(n || 0);
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

function setStage(i) {
  document.querySelectorAll("#rail span").forEach((el) => {
    const n = Number(el.dataset.i);
    el.classList.toggle("on", n === i);
    el.classList.toggle("done", n < i);
  });
}

function upsertItem(item) {
  if (!item || !item.id) return;
  state.items[item.id] = { ...(state.items[item.id] || {}), ...item };
  render();
}

function render() {
  const items = Object.values(state.items).sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0));
  $("media-list").innerHTML = items.map((it) =>
    `<li>${String(it.orderIndex || 0).padStart(3, "0")}  ${it.kind || ""}  ${escapeHtml(it.filename || "")}</li>`
  ).join("");
  $("mon-rows").innerHTML = items.map((it) =>
    `<tr><td>${escapeHtml(it.filename || "")}</td><td>${escapeHtml(it.extractor || "")}</td><td>${it.phase || ""}</td><td>${fmt(it.bytesDone)}</td><td>${escapeHtml((it.sha256 || "").slice(0, 16))}</td><td>${escapeHtml(it.error || "")}</td></tr>`
  ).join("");
  const done = items.filter((i) => i.phase === "complete" || i.phase === "skipped").length;
  const bytes = items.reduce((s, i) => s + (i.bytesDone || 0), 0);
  $("mon-stats").textContent = `${done}/${items.length} · ${fmt(bytes)}`;
  $("hdr-stats").textContent = items.length ? `${done}/${items.length} files` : "";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "\u0026amp;", "<": "\u0026lt;", ">": "\u0026gt;", '"': "\u0026quot;", "'": "\u0026#39;" }[c]));
}

function logLine(line) {
  const li = document.createElement("li");
  li.textContent = line;
  $("log").prepend(li);
}

async function refresh() {
  const s = await (await fetch("/api/state")).json();
  $("preview-title").textContent = s.title || "Ready when you are";
  $("s-root").value = s.settings.downloadRoot || "";
  $("s-folder").value = s.settings.folderName || "";
  $("s-org").value = s.settings.organizeBy || "forumPost";
  $("s-num").checked = !!s.settings.numberFiles;
  $("s-seq").checked = !!s.settings.sequentialDownload;
  $("s-workers").value = s.settings.workers;
  $("s-retries").value = s.settings.retries;
  $("s-max").value = s.settings.maxFileMb;
  $("s-bw").value = s.settings.bandwidthKbps;
  $("s-gap").value = s.settings.hostGapMs;
  $("s-host").value = s.settings.hostMaxConcurrent;
  $("s-hash").checked = !!s.settings.verifyHash;
  $("s-skiphash").checked = !!s.settings.skipKnownHashes;
  $("s-img").checked = s.settings.includeImages !== false;
  $("s-vid").checked = s.settings.includeVideos !== false;
  $("s-aud").checked = s.settings.includeAudio !== false;
  $("s-hook").value = s.settings.webhookUrl || "";
  $("s-cookies").value = s.settings.cookies || "";
  $("sc-on").checked = !!s.settings.schedulerEnabled;
  $("sc-min").value = s.settings.schedulerMinutes || 60;
  $("profile").value = s.settings.profile || "balanced";
  document.documentElement.dataset.theme = s.settings.theme || "dark";
  (s.logs || []).slice().reverse().forEach((line) => {
    if (![...$("log").children].some((el) => el.textContent === line)) logLine(line);
  });
  state.items = {};
  (s.items || []).forEach(upsertItem);
  setRunning(!!s.running, !!s.paused);
  window.__samples = s.samples || {};
}

function setRunning(on, paused) {
  state.running = on;
  $("btn-run").disabled = on;
  $("btn-pause").disabled = !on;
  $("btn-stop").disabled = !on;
  $("btn-pause").textContent = paused ? "Resume" : "Pause";
}

async function defPost(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

$("btn-run").onclick = async () => {
  try {
    state.items = {};
    $("media-list").innerHTML = "";
    $("mon-rows").innerHTML = "";
    await defPost("/api/run", { urls: $("urls").value, profile: $("profile").value });
    setRunning(true, false);
    setStage(0);
  } catch (e) { logLine(String(e.message || e)); }
};
$("btn-stop").onclick = () => defPost("/api/stop");
$("btn-pause").onclick = () => defPost("/api/pause");
$("btn-clear").onclick = () => { $("log").innerHTML = ""; };
$("btn-settings").onclick = () => $("dlg-settings").showModal();
$("btn-sched").onclick = () => $("dlg-sched").showModal();
$("btn-theme").onclick = async () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  await defPost("/api/settings", { theme: next });
};
$("mon-toggle").onclick = () => $("mon-body").classList.toggle("open");
document.querySelectorAll("[data-sample]").forEach((btn) => {
  btn.onclick = () => { $("urls").value = (window.__samples || {})[btn.dataset.sample] || ""; };
});
$("btn-clip").onclick = () => {
  state.clip = !state.clip;
  $("btn-clip").textContent = state.clip ? "Watching clipboard" : "Watch clipboard";
};
$("s-save").onclick = async (ev) => {
  ev.preventDefault();
  await defPost("/api/settings", {
    downloadRoot: $("s-root").value,
    folderName: $("s-folder").value,
    organizeBy: $("s-org").value,
    numberFiles: $("s-num").checked,
    sequentialDownload: $("s-seq").checked,
    workers: Number($("s-workers").value),
    retries: Number($("s-retries").value),
    maxFileMb: Number($("s-max").value),
    bandwidthKbps: Number($("s-bw").value),
    hostGapMs: Number($("s-gap").value),
    hostMaxConcurrent: Number($("s-host").value),
    verifyHash: $("s-hash").checked,
    skipKnownHashes: $("s-skiphash").checked,
    includeImages: $("s-img").checked,
    includeVideos: $("s-vid").checked,
    includeAudio: $("s-aud").checked,
    webhookUrl: $("s-hook").value,
    cookies: $("s-cookies").value,
  });
  $("dlg-settings").close();
};
$("s-chrome").onclick = async () => {
  const res = await fetch("/api/chrome-cookies", { method: "POST" });
  const data = await res.json();
  if (data.ok) { $("s-cookies").value = data.cookies; logLine("Loaded Chrome cookies"); }
  else logLine(data.error || "Chrome cookies failed");
};
$("dlg-sched").addEventListener("close", async () => {
  await defPost("/api/settings", {
    schedulerEnabled: $("sc-on").checked,
    schedulerMinutes: Number($("sc-min").value || 60),
  });
  if ($("sc-on").checked) state.nextRun = Date.now() + Math.max(5, Number($("sc-min").value || 60)) * 60000;
});

const es = new EventSource("/api/events");
es.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "log") logLine(msg.line || msg.msg);
  if (msg.type === "stage") setStage(msg.i);
  if (msg.type === "title") $("preview-title").textContent = msg.msg;
  if (msg.type === "item" || msg.type === "progress") upsertItem(msg.item);
  if (msg.type === "done") setRunning(false, false);
};

document.addEventListener("paste", (e) => {
  const t = e.clipboardData && e.clipboardData.getData("text");
  if (!t) return;
  const urls = t.split(/\s+/).filter((u) => /^https?:\/\//.test(u));
  if (!urls.length) return;
  const cur = $("urls").value;
  urls.forEach((u) => { if (!cur.includes(u)) $("urls").value = ($("urls").value.trim() + "\n" + u).trim(); });
  if (state.clip) logLine("Clipboard: " + urls.length + " URL(s)");
});
setInterval(async () => {
  if (!state.clip || !navigator.clipboard) return;
  try {
    const t = await navigator.clipboard.readText();
    if (!t || t === state.lastClip) return;
    state.lastClip = t;
    const urls = t.split(/\s+/).filter((u) => /^https?:\/\//.test(u));
    if (urls.length) {
      urls.forEach((u) => { if (!$("urls").value.includes(u)) $("urls").value = ($("urls").value.trim() + "\n" + u).trim(); });
      logLine("Clipboard: " + urls.length + " URL(s)");
    }
  } catch (_) {}
}, 1500);
setInterval(() => {
  if (!state.nextRun || state.running || Date.now() < state.nextRun) return;
  state.nextRun = Date.now() + Math.max(5, Number($("sc-min").value || 60)) * 60000;
  $("btn-run").click();
}, 15000);

refresh().catch((e) => logLine(String(e)));
