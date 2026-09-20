import { toast } from "sonner";
import { COMPANION_CHANNEL, cookiesFromCompanion } from "./companion";
import { runJob } from "./engine";
import { useAppStore } from "./store";
import { extractHttpUrls, mergeUrlLines } from "./urls";

export function ingestUrls(text: string, autoRun: boolean) {
  const urls = extractHttpUrls(text);
  if (!urls.length) return 0;
  const store = useAppStore.getState();
  const merged = mergeUrlLines(store.urlsText, urls);
  if (!merged.added) return 0;
  store.setUrlsText(merged.text);
  store.addEvent({
    level: "ok",
    stage: "crawl",
    message: `Clipboard watcher added ${merged.added} URL${merged.added === 1 ? "" : "s"}`,
  });
  toast.success(`Added ${merged.added} URL${merged.added === 1 ? "" : "s"}`);
  if (autoRun && store.jobStatus !== "running" && store.jobStatus !== "paused") void runJob({ source: "clipboard" });
  return merged.added;
}

export function startClipboardWatcher() {
  let last = "";
  const onPaste = (e: ClipboardEvent) => {
    const s = useAppStore.getState().settings;
    if (!s.clipboardWatch) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    ingestUrls(text, s.clipboardAutoRun);
  };
  document.addEventListener("paste", onPaste);

  const poll = window.setInterval(() => {
    const s = useAppStore.getState().settings;
    if (!s.clipboardWatch || document.hidden) return;
    void navigator.clipboard
      ?.readText()
      .then((text) => {
        if (!text || text === last) return;
        last = text;
        ingestUrls(text, s.clipboardAutoRun);
      })
      .catch(() => {
        /* paste events still work without clipboard-read */
      });
  }, 2000);

  return () => {
    document.removeEventListener("paste", onPaste);
    window.clearInterval(poll);
  };
}

export function startCompanionListener() {
  const apply = (host: string, cookies: string) => {
    if (!cookies) return;
    const netscape = cookiesFromCompanion(host, cookies);
    useAppStore.getState().patchSettings({ cookies: netscape });
    useAppStore.getState().addEvent({
      level: "ok",
      stage: "crawl",
      message: `Companion cookies for ${host}`,
    });
    toast.success(`Cookies from ${host}`);
  };

  const onMsg = (e: MessageEvent) => {
    const d = e.data as { type?: string; host?: string; cookies?: string };
    if (d?.type === "simpdl-cookies" && d.host && d.cookies) apply(d.host, d.cookies);
  };
  window.addEventListener("message", onMsg);
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(COMPANION_CHANNEL);
    ch.onmessage = (ev) => onMsg(ev as MessageEvent);
  } catch {
    /* ignore */
  }

  const drainInbox = () => {
    try {
      const raw = localStorage.getItem("fathomrail-companion-inbox");
      if (!raw) return;
      localStorage.removeItem("fathomrail-companion-inbox");
      const data = JSON.parse(raw) as { netscape?: string; host?: string };
      if (data.netscape) {
        useAppStore.getState().patchSettings({ cookies: data.netscape });
        toast.success(`Cookies from ${data.host ?? "companion"}`);
      }
    } catch {
      /* ignore */
    }
  };
  drainInbox();
  window.addEventListener("storage", drainInbox);

  return () => {
    window.removeEventListener("message", onMsg);
    window.removeEventListener("storage", drainInbox);
    ch?.close();
  };
}

export function startScheduler() {
  const tick = () => {
    const store = useAppStore.getState();
    if (store.jobStatus === "running" || store.jobStatus === "paused" || store.jobStatus === "stopping") return;
    const now = Date.now();
    for (const job of store.schedules) {
      if (!job.enabled || !job.nextRunAt || job.nextRunAt > now) continue;
      const next = job.intervalMin > 0 ? now + job.intervalMin * 60_000 : null;
      store.upsertSchedule({ ...job, nextRunAt: next, enabled: next != null });
      store.addEvent({ level: "info", stage: "crawl", message: `Scheduled run: ${job.label}` });
      void runJob({ urls: job.urls || store.urlsText, webhookUrl: job.webhookUrl || undefined, source: `schedule:${job.label}` });
      break;
    }
  };
  const id = window.setInterval(tick, 5000);
  tick();
  return () => window.clearInterval(id);
}
