import { filenameFromUrl, sanitizeFilename } from "../utils";
import { APP_NAME } from "../brand";
import { clearBlobs, getBlob, setBlob } from "./blobs";
import { summarizeCookies } from "./cookies";
import { discoverPage, probeMedia } from "./fns";
import { hasDirectoryHandle, restoreDirectoryHandle, writeRelativeFile } from "./folder";
import { loadKnownHashes, rememberHash, sha256Hex } from "./hash";
import { orderedFilename, relativePath, stripOrderPrefix } from "./organize";
import { SAMPLE_PAGES } from "./sample";
import { useAppStore } from "./store";
import { acquireHost, ByteLimiter, hostOf, releaseHost } from "./throttle";
import type { MediaItem } from "./types";
import { jobWebhookPayload, postWebhook } from "./webhook";
import { triggerDownload, zipFiles } from "./zip";

let abort: AbortController | null = null;
let paused = false;
const pauseWaiters: Array<() => void> = [];

function waitIfPaused() {
  if (!paused) return Promise.resolve();
  return new Promise<void>((resolve) => pauseWaiters.push(resolve));
}

export function pauseJob() {
  paused = true;
  useAppStore.getState().setJobStatus("paused");
  useAppStore.getState().addEvent({ level: "warn", stage: "download", message: "Paused" });
}

export function resumeJob() {
  paused = false;
  useAppStore.getState().setJobStatus("running");
  useAppStore.getState().addEvent({ level: "info", stage: "download", message: "Resumed" });
  while (pauseWaiters.length) pauseWaiters.pop()?.();
}

export function stopJob() {
  abort?.abort();
  paused = false;
  while (pauseWaiters.length) pauseWaiters.pop()?.();
  useAppStore.getState().setJobStatus("stopping");
}

export function loadSample(id: string) {
  const s = SAMPLE_PAGES.find((p) => p.id === id);
  if (s) useAppStore.getState().setUrlsText(s.url);
}

function parseUrls(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("http"));
}

function mediaProxy(url: string, cookies: string, referer?: string): string {
  const u = new URL("/api/media", window.location.origin);
  u.searchParams.set("url", url);
  if (cookies) u.searchParams.set("cookies", cookies);
  if (referer) u.searchParams.set("referer", referer);
  return u.toString();
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const q = [...items];
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (q.length) {
      if (abort?.signal.aborted) return;
      await waitIfPaused();
      const item = q.shift();
      if (!item) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runJob(opts?: { urls?: string; webhookUrl?: string; source?: string }) {
  const store = useAppStore.getState();
  if (store.jobStatus === "running") return;
  const urls = parseUrls(opts?.urls ?? store.urlsText);
  if (!urls.length) {
    store.addEvent({ level: "error", stage: "crawl", message: "Paste one or more http(s) URLs" });
    return;
  }

  abort = new AbortController();
  paused = false;
  clearBlobs();
  store.resetJob();
  store.setJobStatus("running");
  store.setStartedAt(Date.now());
  store.setStage("crawl");
  await restoreDirectoryHandle();
  const cookieNote = summarizeCookies(store.settings.cookies, urls[0]);
  const cap = store.settings.bandwidthKbps;
  store.addEvent({
    level: "info",
    stage: "crawl",
    message: `Starting ${urls.length} seed URL${urls.length === 1 ? "" : "s"} · ${store.settings.profile} · ${cookieNote}${cap ? ` · cap ${cap} KB/s` : ""}`,
  });

  const limiter = new ByteLimiter(cap > 0 ? cap * 1024 : 0);
  const source = opts?.source ?? "manual";

  try {
    const discovered: MediaItem[] = [];
    const seen = new Set<string>();
    let i = 0;
    for (const url of urls) {
      if (abort.signal.aborted) throw new Error("Stopped");
      await waitIfPaused();
      store.addEvent({ level: "info", stage: "crawl", message: `Fetching ${url}` });
      const result = await discoverPage({ data: { url, cookies: store.settings.cookies, profile: store.settings.profile } });
      store.setPreviewLabel(result.title ?? result.pageUrl);
      if (result.warning) store.addEvent({ level: "warn", stage: "crawl", message: result.warning });
      store.setStage("discover");
      for (const item of result.items) {
        if (store.settings.skipDuplicates && seen.has(item.url)) continue;
        const kind = item.kind;
        if (kind === "image" && !store.settings.includeImages) continue;
        if (kind === "video" && !store.settings.includeVideos) continue;
        if (kind === "audio" && !store.settings.includeAudio) continue;
        if (kind === "other" && !store.settings.includeImages) continue;
        seen.add(item.url);
        const orderIndex = i + 1;
        discovered.push({
          id: `m${i++}`,
          url: item.url,
          sourcePage: result.pageUrl,
          filename: store.settings.numberFiles
            ? orderedFilename(orderIndex, item.filename)
            : sanitizeFilename(item.filename),
          kind,
          mime: null,
          bytesTotal: null,
          bytesDone: 0,
          status: "queued",
          selected: true,
          error: null,
          speedBps: 0,
          startedAt: null,
          orderIndex,
          forumId: item.forumId,
          postId: item.postId,
          threadId: item.threadId,
          sha256: null,
          extractor: item.extractor ?? "generic",
          resolvedUrl: null,
        });
      }
      store.addEvent({
        level: "ok",
        stage: "discover",
        message: `${result.items[0]?.extractor ?? "generic"} found ${result.items.length} media on ${result.followed.length || 1} page(s)`,
      });
      store.setItems([...discovered]);
    }

    if (!discovered.length) {
      store.addEvent({ level: "error", stage: "discover", message: "Nothing matched the current filters" });
      store.setJobStatus("failed");
      await finishNotify("failed", source, opts?.webhookUrl);
      return;
    }

    store.setStage("resolve");
    store.addEvent({ level: "info", stage: "resolve", message: `Resolving ${discovered.length} URLs` });
    await pool(discovered, store.settings.workers, async (item) => {
      if (abort?.signal.aborted) return;
      store.updateItem(item.id, { status: "resolving" });
      const probe = await probeMedia({
        data: { url: item.url, cookies: store.settings.cookies, referer: item.sourcePage },
      });
      const probedName = sanitizeFilename(probe.filename || stripOrderPrefix(item.filename));
      store.updateItem(item.id, {
        status: "queued",
        mime: probe.mime,
        bytesTotal: probe.bytes,
        filename: store.settings.numberFiles ? orderedFilename(item.orderIndex, probedName) : probedName,
        kind: probe.kind || item.kind,
        error: probe.ok ? null : probe.error,
        resolvedUrl: probe.resolvedUrl ?? probe.url,
        url: probe.resolvedUrl || item.url,
      });
    });

    const current = useAppStore.getState().items.filter((it) => it.selected);
    current.sort((a, b) => a.orderIndex - b.orderIndex);
    store.setStage("download");
    const workers = store.settings.sequentialDownload ? 1 : store.settings.workers;
    store.addEvent({
      level: "info",
      stage: "download",
      message: store.settings.sequentialDownload
        ? `Downloading ${current.length} files in order`
        : `Downloading ${current.length} files · ${workers} workers · ${store.settings.hostMaxConcurrent}/host`,
    });

    await pool(current, workers, async (item) => {
      if (abort?.signal.aborted) return;
      await downloadOne(item, limiter);
    });

    if (abort.signal.aborted) throw new Error("Stopped");

    store.setStage("finalize");
    const done = useAppStore
      .getState()
      .items.filter((it) => it.status === "complete")
      .sort((a, b) => a.orderIndex - b.orderIndex);
    store.addEvent({
      level: "ok",
      stage: "finalize",
      message: `Verified ${done.length} file${done.length === 1 ? "" : "s"}${store.settings.verifyHash ? " · SHA-256" : ""}`,
    });

    if (hasDirectoryHandle() && done.length) {
      store.addEvent({ level: "info", stage: "finalize", message: `Writing ${done.length} files to chosen folder` });
      for (const it of done) {
        const blob = getBlob(it.id);
        if (!blob) continue;
        await writeRelativeFile(relativePath(store.settings, it), blob);
      }
      store.addEvent({ level: "ok", stage: "finalize", message: "Saved into the selected download folder" });
    }

    if (store.settings.autoZip && done.length) {
      store.addEvent({ level: "info", stage: "finalize", message: "Packing ZIP archive in order" });
      const files = [];
      for (const it of done) {
        const blob = getBlob(it.id);
        if (!blob) continue;
        files.push({
          name: relativePath(store.settings, it),
          data: new Uint8Array(await blob.arrayBuffer()),
        });
      }
      if (files.length) {
        const zip = await zipFiles(files);
        triggerDownload(zip, `${sanitizeFilename(store.settings.folderName)}.zip`);
        store.addEvent({ level: "ok", stage: "finalize", message: `Saved ${files.length} files to ZIP` });
      }
    }

    store.setJobStatus("complete");
    await finishNotify("complete", source, opts?.webhookUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Job failed";
    const stopped = msg === "Stopped" || abort?.signal.aborted;
    store.addEvent({
      level: stopped ? "warn" : "error",
      stage: useAppStore.getState().stage,
      message: stopped ? "Stopped by user" : msg,
    });
    store.setJobStatus(stopped ? "idle" : "failed");
    if (!stopped) await finishNotify("failed", source, opts?.webhookUrl);
  } finally {
    abort = null;
    paused = false;
  }
}

async function finishNotify(status: string, source: string, extraWebhook?: string) {
  const store = useAppStore.getState();
  const items = store.items;
  const files = items.filter((i) => i.status === "complete").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const bytes = items.reduce((n, i) => n + (i.status === "complete" ? i.bytesDone : 0), 0);
  store.pushHistory({
    id: `j${Date.now()}`,
    at: Date.now(),
    status: status === "complete" ? "complete" : "failed",
    files,
    failed,
    bytes,
    source,
  });
  const payload = jobWebhookPayload({
    status,
    source,
    startedAt: store.startedAt,
    files: items.map((i) => ({
      filename: i.filename,
      bytes: i.bytesDone,
      sha256: i.sha256,
      url: i.url,
      status: i.status,
    })),
  });
  const hook = (extraWebhook ?? store.settings.webhookUrl).trim();
  if (hook) {
    const res = await postWebhook(hook, payload);
    store.addEvent({
      level: res.ok ? "ok" : "warn",
      stage: "finalize",
      message: res.ok ? `Webhook delivered` : `Webhook: ${res.error}`,
    });
  }
  if (store.settings.notifyDone && typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      new Notification(APP_NAME, {
        body: status === "complete" ? `${files} files verified` : `Job ${status} · ${failed} failed`,
      });
    } catch {
      /* ignore */
    }
  }
}

async function downloadOne(item: MediaItem, limiter: ByteLimiter) {
  const store = useAppStore.getState();
  const { cookies, retries, retryDelayMs, maxFileMb, verifyHash, skipKnownHashes, hostGapMs, hostMaxConcurrent } =
    store.settings;
  const host = hostOf(item.url);
  let attempt = 0;
  while (attempt <= retries) {
    if (abort?.signal.aborted) return;
    await waitIfPaused();
    store.updateItem(item.id, { status: "fetching", startedAt: Date.now(), bytesDone: 0, error: null });
    try {
      await acquireHost(host, hostGapMs, hostMaxConcurrent, abort?.signal ?? undefined);
      try {
        const live = store.items.find((i) => i.id === item.id) ?? item;
        const res = await fetch(mediaProxy(live.resolvedUrl || live.url, cookies, live.sourcePage), { signal: abort?.signal });
        if (res.status === 429 || res.status === 503) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get("content-length") ?? store.items.find((i) => i.id === item.id)?.bytesTotal ?? 0);
        if (total && total > maxFileMb * 1024 * 1024) throw new Error("Over size limit");
        const reader = res.body?.getReader();
        if (!reader) throw new Error("Empty body");
        const chunks: Uint8Array[] = [];
        let doneBytes = 0;
        const t0 = performance.now();
        for (;;) {
          if (abort?.signal.aborted) return;
          await waitIfPaused();
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            doneBytes += value.length;
            if (doneBytes > maxFileMb * 1024 * 1024) throw new Error("Over size limit");
            await limiter.take(value.length, abort?.signal ?? undefined);
            const elapsed = (performance.now() - t0) / 1000;
            store.updateItem(item.id, {
              bytesDone: doneBytes,
              bytesTotal: total || doneBytes,
              speedBps: elapsed > 0 ? doneBytes / elapsed : 0,
            });
          }
        }
        store.updateItem(item.id, { status: "verifying", bytesDone: doneBytes, bytesTotal: total || doneBytes });
        const blob = new Blob(chunks as BlobPart[]);
        if (blob.size === 0) throw new Error("Zero-byte file");
        let hex: string | null = null;
        if (verifyHash || skipKnownHashes) {
          hex = await sha256Hex(blob);
          if (skipKnownHashes && loadKnownHashes().has(hex)) {
            store.updateItem(item.id, { status: "skipped", sha256: hex, speedBps: 0, error: "Duplicate SHA-256" });
            store.addEvent({ level: "warn", stage: "download", message: `Skipped duplicate ${item.filename}` });
            return;
          }
          if (hex) rememberHash(hex);
        }
        setBlob(item.id, blob);
        const name = store.items.find((i) => i.id === item.id)?.filename || filenameFromUrl(item.url);
        store.updateItem(item.id, { status: "complete", speedBps: 0, filename: name, sha256: hex });
        store.addEvent({
          level: "ok",
          stage: "download",
          message: hex ? `Saved ${name} · ${hex.slice(0, 8)}` : `Saved ${name}`,
        });
        return;
      } finally {
        releaseHost(host);
      }
    } catch (err) {
      if (abort?.signal.aborted) return;
      attempt += 1;
      const msg = err instanceof Error ? err.message : "Download failed";
      if (attempt > retries) {
        store.updateItem(item.id, { status: "failed", error: msg, speedBps: 0 });
        store.addEvent({ level: "error", stage: "download", message: `${item.filename}: ${msg}` });
        return;
      }
      store.addEvent({ level: "warn", stage: "download", message: `${item.filename}: retry ${attempt}/${retries} (${msg})` });
      const backoff = /429|503/.test(msg) ? retryDelayMs * 2 ** attempt : retryDelayMs;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

export async function retryItem(id: string) {
  const store = useAppStore.getState();
  const item = store.items.find((i) => i.id === id);
  if (!item) return;
  abort = abort ?? new AbortController();
  store.setJobStatus("running");
  const limiter = new ByteLimiter(store.settings.bandwidthKbps > 0 ? store.settings.bandwidthKbps * 1024 : 0);
  await downloadOne(item, limiter);
  const remaining = useAppStore.getState().items.some((i) => i.status === "fetching" || i.status === "resolving");
  if (!remaining) store.setJobStatus("complete");
}

export async function retryFailed() {
  const failed = useAppStore.getState().items.filter((i) => i.status === "failed");
  for (const it of failed) await retryItem(it.id);
}

export async function saveItem(id: string) {
  const item = useAppStore.getState().items.find((i) => i.id === id);
  const blob = getBlob(id);
  if (!item || !blob) return;
  triggerDownload(blob, item.filename);
}

export async function saveAllZip() {
  const store = useAppStore.getState();
  const files = [];
  for (const it of store.items.filter((i) => i.status === "complete").sort((a, b) => a.orderIndex - b.orderIndex)) {
    const blob = getBlob(it.id);
    if (!blob) continue;
    files.push({
      name: relativePath(store.settings, it),
      data: new Uint8Array(await blob.arrayBuffer()),
    });
  }
  if (!files.length) return;
  const zip = await zipFiles(files);
  triggerDownload(zip, `${sanitizeFilename(store.settings.folderName)}.zip`);
}

export async function exportHashReport() {
  const store = useAppStore.getState();
  const rows = store.items
    .filter((i) => i.sha256)
    .map((i) => `${i.sha256}  ${i.filename}`)
    .join("\n");
  if (!rows) return;
  triggerDownload(new Blob([rows], { type: "text/plain" }), "fathomrail-sha256.txt");
}
