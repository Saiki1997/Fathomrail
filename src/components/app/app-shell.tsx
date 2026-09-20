import {
  CalendarClock,
  CircleHelp,
  Clipboard,
  Download,
  FolderArchive,
  FolderOpen,
  Moon,
  Pause,
  Play,
  Settings2,
  Square,
  Sun,
  Trash2,
} from "lucide-react";
import { type DragEvent, useEffect, useMemo } from "react";
import { toast, Toaster } from "sonner";
import {
  CompanionDialog,
  CookiesDialog,
  DistroDialog,
  SchedulerDialog,
  SettingsDialog,
} from "@/components/app/dialogs";
import { DownloadMonitor } from "@/components/app/download-monitor";
import { Button } from "@/components/ui/button";
import { pauseJob, resumeJob, runJob, saveAllZip, stopJob } from "@/lib/downloader/engine";
import { APP_NAME, APP_TAGLINE } from "@/lib/brand";
import { currentFolderLabel, restoreDirectoryHandle } from "@/lib/downloader/folder";
import { SAMPLE_PAGES } from "@/lib/downloader/sample";
import { applyTheme, stageIndex, useAppStore } from "@/lib/downloader/store";
import { startClipboardWatcher, startCompanionListener, startScheduler } from "@/lib/downloader/watchers";
import { PROFILE_META, STAGES, type StageId } from "@/lib/downloader/types";
import { cn, formatBytes, formatEta, formatSpeed } from "@/lib/utils";

export function AppShell() {
  const s = useAppStore();
  const running = s.jobStatus === "running";
  const paused = s.jobStatus === "paused";

  useEffect(() => {
    if (!s.settings.cookiesDismissed) s.setCookiesOpen(true);
  }, [s.settings.cookiesDismissed, s.setCookiesOpen]);

  useEffect(() => {
    void restoreDirectoryHandle().then((h) => {
      if (h) s.patchSettings({ downloadPathLabel: h.name });
    });
  }, [s.patchSettings]);

  useEffect(() => {
    applyTheme(s.settings.theme);
  }, [s.settings.theme]);

  useEffect(() => {
    const offClip = startClipboardWatcher();
    const offComp = startCompanionListener();
    const offSched = startScheduler();
    return () => {
      offClip();
      offComp();
      offSched();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "Escape" && running) stopJob();
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void runJob();
      }
      if (e.key === "Enter" && tag !== "TEXTAREA" && tag !== "INPUT") void runJob();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running]);

  const stats = useMemo(() => {
    const total = s.items.length;
    const done = s.items.filter((i) => i.status === "complete").length;
    const failed = s.items.filter((i) => i.status === "failed").length;
    const bytes = s.items.reduce((n, i) => n + (i.bytesDone || 0), 0);
    const speed = s.items.reduce((n, i) => n + (i.status === "fetching" ? i.speedBps : 0), 0);
    const remain = s.items.filter((i) => i.status !== "complete" && i.status !== "failed" && i.status !== "skipped");
    const remainBytes = remain.reduce((n, i) => n + Math.max(0, (i.bytesTotal ?? 0) - i.bytesDone), 0);
    const eta = speed > 0 ? remainBytes / speed : null;
    return { total, done, failed, bytes, speed, eta };
  }, [s.items]);

  const light = s.settings.theme === "light";

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-foreground">
      <Toaster theme={light ? "light" : "dark"} position="top-right" />
      <header className="flex items-center gap-3 border-b border-border px-4 py-3 md:px-6">
        <div className="flex size-9 items-center justify-center overflow-hidden rounded-md border border-border bg-surface-2">
          <img src="/logo.svg" alt="" className="size-9" width={36} height={36} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h1 className="font-display text-base font-semibold tracking-tight">{APP_NAME}</h1>
            <span className="hidden text-xs text-subtle sm:inline">v1.0</span>
          </div>
          <p className="truncate text-xs text-muted-foreground">{APP_TAGLINE}</p>
        </div>
        <div className="hidden items-center gap-3 text-xs tabular-nums text-muted-foreground md:flex">
          <span className="max-w-40 truncate font-sans normal-nums">{currentFolderLabel(s.settings.downloadPathLabel)}</span>
          <span>
            {stats.done}/{stats.total} files
          </span>
          <span>{formatBytes(stats.bytes)}</span>
          <span>{formatSpeed(stats.speed)}</span>
          {stats.eta != null && <span>ETA {formatEta(stats.eta)}</span>}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Toggle theme"
          onClick={() => s.patchSettings({ theme: light ? "dark" : "light" })}
        >
          {light ? <Moon className="size-4" /> : <Sun className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => s.setSchedulerOpen(true)} aria-label="Scheduler">
          <CalendarClock className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => s.setSettingsOpen(true)} aria-label="Download folder">
          <FolderOpen className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => s.setDistroOpen(true)} aria-label="Distribution">
          <FolderArchive className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => s.setSettingsOpen(true)} aria-label="Settings">
          <Settings2 className="size-4" />
        </Button>
      </header>

      <UrlComposer />
      <StageRail stage={s.stage} running={running || paused} />

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <PreviewPane />
        <ActivityFeed />
      </div>

      <DownloadMonitor stats={stats} />
      <SettingsDialog />
      <CookiesDialog />
      <CompanionDialog />
      <SchedulerDialog />
      <DistroDialog />
    </div>
  );
}

function UrlComposer() {
  const s = useAppStore();
  const running = s.jobStatus === "running";
  const paused = s.jobStatus === "paused";

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const text = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text/uri-list");
    if (text) s.setUrlsText(s.urlsText ? `${s.urlsText}\n${text}` : text);
  };

  return (
    <section className="border-b border-border px-4 py-3 md:px-6" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <label className="min-w-0 flex-1">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Seed URLs — one per line</span>
          <textarea
            value={s.urlsText}
            onChange={(e) => s.setUrlsText(e.target.value)}
            placeholder="https://picsum.photos/v2/list?page=2&limit=16"
            rows={2}
            className="w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-foreground placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-border bg-surface p-0.5">
            {(["fast", "balanced", "deep"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => s.patchSettings({ profile: p })}
                className={cn(
                  "h-9 rounded-sm px-3 text-xs font-medium",
                  s.settings.profile === p ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {PROFILE_META[p].label}
              </button>
            ))}
          </div>
          {!running && !paused && (
            <Button onClick={() => void runJob()} className="min-w-24">
              <Play className="size-4" />
              Run
            </Button>
          )}
          {running && (
            <>
              <Button variant="secondary" onClick={pauseJob}>
                <Pause className="size-4" />
                Pause
              </Button>
              <Button variant="danger" onClick={stopJob}>
                <Square className="size-4" />
                Stop
              </Button>
            </>
          )}
          {paused && (
            <>
              <Button onClick={resumeJob}>
                <Play className="size-4" />
                Resume
              </Button>
              <Button variant="danger" onClick={stopJob}>
                <Square className="size-4" />
                Stop
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {SAMPLE_PAGES.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => s.setUrlsText(p.url)}
            className="rounded-sm border border-border bg-surface px-2 py-1 text-[0.6875rem] text-muted-foreground hover:text-foreground"
            title={p.hint}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => s.patchSettings({ clipboardWatch: !s.settings.clipboardWatch })}
          className={cn(
            "inline-flex items-center gap-1 rounded-sm border px-2 py-1 text-[0.6875rem]",
            s.settings.clipboardWatch
              ? "border-ok/40 bg-ok/10 text-ok"
              : "border-border bg-surface text-muted-foreground hover:text-foreground",
          )}
        >
          <Clipboard className="size-3" />
          {s.settings.clipboardWatch ? "Watching clipboard" : "Watch clipboard"}
        </button>
        <button
          type="button"
          className="rounded-sm px-2 py-1 text-[0.6875rem] text-subtle hover:text-foreground"
          onClick={() => toast("Drop URLs onto the composer, or press Ctrl+Enter to run.")}
        >
          <CircleHelp className="mr-1 inline size-3" />
          Shortcuts
        </button>
      </div>
    </section>
  );
}

function StageRail({ stage, running }: { stage: StageId; running: boolean }) {
  const idx = stageIndex(stage);
  const jobStatus = useAppStore((s) => s.jobStatus);
  return (
    <ol className="flex gap-1 overflow-x-auto border-b border-border px-4 py-2 md:px-6">
      {STAGES.map((id, i) => {
        const done = i < idx || (!running && i <= idx && jobStatus === "complete");
        const current = i === idx && running;
        return (
          <li
            key={id}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-[0.6875rem] font-medium uppercase tracking-wide",
              current && "bg-surface-2 text-foreground",
              done && !current && "text-ok",
              !done && !current && "text-subtle",
            )}
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                current && "bg-foreground",
                done && !current && "bg-ok",
                !done && !current && "bg-surface-3",
              )}
            />
            {id}
          </li>
        );
      })}
    </ol>
  );
}

function PreviewPane() {
  const items = useAppStore((s) => s.items);
  const previewLabel = useAppStore((s) => s.previewLabel);
  const jobStatus = useAppStore((s) => s.jobStatus);
  const toggle = useAppStore((s) => s.toggleSelect);
  const selectAll = useAppStore((s) => s.selectAll);

  if (!items.length) {
    return (
      <main className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
        <div className="flex size-14 items-center justify-center rounded-xl border border-border bg-surface">
          <Download className="size-6 text-muted-foreground" />
        </div>
        <h2 className="font-display text-xl font-medium tracking-tight">Ready when you are</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Paste a public gallery, thread, or direct media URL. Discover uses a generic extractor
          (open graph, JSON-LD, srcset, album pagination); resolve follows wrapper pages; download
          retries 429s with backoff.
        </p>
        <p className="max-w-md text-xs text-subtle">
          Only fetch content you have the right to download. Private hosts and local addresses are blocked.
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-0 overflow-auto p-4 md:p-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-display text-sm font-medium">{previewLabel ?? "Discovered media"}</h2>
          <p className="text-xs text-muted-foreground">
            {items.length} items · {jobStatus}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => selectAll(true)}>
            All
          </Button>
          <Button size="sm" variant="ghost" onClick={() => selectAll(false)}>
            None
          </Button>
        </div>
      </div>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        {items.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              onClick={() => toggle(it.id)}
              className={cn(
                "group flex w-full flex-col overflow-hidden rounded-lg border bg-surface text-left",
                it.selected ? "border-border-strong" : "border-border opacity-60",
              )}
            >
              <div className="relative aspect-4/3 bg-surface-2">
                {it.kind === "image" ? (
                  <img
                    src={`/api/media?url=${encodeURIComponent(it.resolvedUrl || it.url)}&referer=${encodeURIComponent(it.sourcePage)}`}
                    alt=""
                    className="size-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex size-full items-center justify-center text-xs uppercase tracking-wide text-subtle">
                    {it.kind}
                  </div>
                )}
                <span className="absolute left-2 top-2 rounded-sm bg-bg/80 px-1.5 py-0.5 text-[0.625rem] uppercase">
                  {it.kind}
                </span>
              </div>
              <div className="truncate px-2 py-1.5 font-mono text-[0.6875rem] text-muted-foreground">
                {it.filename}
                {it.sha256 && <span className="ml-1 text-subtle">{it.sha256.slice(0, 8)}</span>}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

function ActivityFeed() {
  const events = useAppStore((s) => s.events);
  const resetJob = useAppStore((s) => s.resetJob);
  return (
    <aside className="flex min-h-72 flex-col border-t border-border lg:border-l lg:border-t-0">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Activity</h2>
        <button type="button" className="text-subtle hover:text-foreground" onClick={resetJob} aria-label="Clear">
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <ol className="min-h-0 flex-1 space-y-2 overflow-auto p-3 font-mono text-[0.6875rem] leading-5">
        {!events.length && <li className="text-subtle">Waiting for a run…</li>}
        {[...events].reverse().map((e) => (
          <li key={e.id} className="flex gap-2">
            <span className="w-16 shrink-0 uppercase text-subtle">{e.stage}</span>
            <span
              className={cn(
                e.level === "ok" && "text-ok",
                e.level === "warn" && "text-warn",
                e.level === "error" && "text-danger",
                e.level === "info" && "text-muted-foreground",
              )}
            >
              {e.message}
            </span>
          </li>
        ))}
      </ol>
      <div className="border-t border-border p-2">
        <Button variant="secondary" size="sm" className="w-full" onClick={() => void saveAllZip()}>
          <FolderArchive className="size-3.5" />
          Save completed ZIP
        </Button>
      </div>
    </aside>
  );
}
