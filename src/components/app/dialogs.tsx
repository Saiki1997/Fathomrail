import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { importCookieFile, isChromeBrowser, pickCookieFile } from "@/lib/downloader/chrome-import";
import { bookmarkletSource } from "@/lib/downloader/companion";
import { summarizeCookies } from "@/lib/downloader/cookies";
import { pickDownloadFolder } from "@/lib/downloader/folder";
import { forgetHashes } from "@/lib/downloader/hash";
import { useAppStore } from "@/lib/downloader/store";
import type { ScheduledJob, ThemeMode } from "@/lib/downloader/types";
import { cn } from "@/lib/utils";

export function SettingsDialog() {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const settings = useAppStore((s) => s.settings);
  const urlsText = useAppStore((s) => s.urlsText);
  const history = useAppStore((s) => s.history);
  const patch = useAppStore((s) => s.patchSettings);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title="Settings" className="max-h-[min(90dvh,44rem)] overflow-auto">
        <div className="grid gap-5">
          <Section title="Appearance">
            <div className="grid grid-cols-3 gap-1 rounded-md border border-border bg-surface p-1">
              {(["dark", "light", "system"] as ThemeMode[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => patch({ theme: id })}
                  className={cn(
                    "h-9 rounded-sm text-xs font-medium capitalize",
                    settings.theme === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {id}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Save location">
            <Field label="Download location">
              <div className="flex gap-2">
                <Input value={settings.downloadPathLabel} readOnly />
                <Button type="button" variant="secondary" onClick={() => void chooseFolder(patch)}>
                  Browse
                </Button>
              </div>
            </Field>
            <Field label="Folder name">
              <Input value={settings.folderName} onChange={(e) => patch({ folderName: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-surface p-1">
              {(
                [
                  ["flat", "One folder"],
                  ["post", "By post ID"],
                  ["forum", "By forum ID"],
                  ["forum-post", "Forum / post"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => patch({ organizeBy: id })}
                  className={cn(
                    "h-9 rounded-sm px-2 text-xs font-medium",
                    settings.organizeBy === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <Toggle label="Number files in page order" checked={settings.numberFiles} onChange={(v) => patch({ numberFiles: v })} />
            <Toggle label="Download strictly in order" checked={settings.sequentialDownload} onChange={(v) => patch({ sequentialDownload: v })} />
          </Section>

          <Section title="Pace">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Workers">
                <Input type="number" min={1} max={8} value={settings.workers} onChange={(e) => patch({ workers: clamp(Number(e.target.value), 1, 8) })} />
              </Field>
              <Field label="Max MB">
                <Input type="number" min={1} max={80} value={settings.maxFileMb} onChange={(e) => patch({ maxFileMb: clamp(Number(e.target.value), 1, 80) })} />
              </Field>
              <Field label="Bandwidth cap KB/s (0 = off)">
                <Input type="number" min={0} max={20000} value={settings.bandwidthKbps} onChange={(e) => patch({ bandwidthKbps: clamp(Number(e.target.value), 0, 20000) })} />
              </Field>
              <Field label="Per-host gap ms">
                <Input type="number" min={0} max={10000} value={settings.hostGapMs} onChange={(e) => patch({ hostGapMs: clamp(Number(e.target.value), 0, 10000) })} />
              </Field>
              <Field label="Max concurrent / host">
                <Input type="number" min={1} max={8} value={settings.hostMaxConcurrent} onChange={(e) => patch({ hostMaxConcurrent: clamp(Number(e.target.value), 1, 8) })} />
              </Field>
              <Field label="Retries">
                <Input type="number" min={0} max={6} value={settings.retries} onChange={(e) => patch({ retries: clamp(Number(e.target.value), 0, 6) })} />
              </Field>
            </div>
          </Section>

          <Section title="Integrity">
            <Toggle label="SHA-256 verify after each file" checked={settings.verifyHash} onChange={(v) => patch({ verifyHash: v })} />
            <Toggle label="Skip files with a known SHA-256" checked={settings.skipKnownHashes} onChange={(v) => patch({ skipKnownHashes: v })} />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                forgetHashes();
                toast.success("Hash memory cleared");
              }}
            >
              Clear remembered hashes
            </Button>
          </Section>

          <Section title="Watchers">
            <Toggle label="Clipboard URL watcher" checked={settings.clipboardWatch} onChange={(v) => patch({ clipboardWatch: v })} />
            <Toggle label="Auto-run when a new URL is copied" checked={settings.clipboardAutoRun} onChange={(v) => patch({ clipboardAutoRun: v })} />
            <Toggle label="Desktop notification when a job finishes" checked={settings.notifyDone} onChange={(v) => void enableNotify(v, patch)} />
            <Field label="Finish webhook (HTTPS POST JSON)">
              <Input
                value={settings.webhookUrl}
                onChange={(e) => patch({ webhookUrl: e.target.value })}
                placeholder="https://example.com/hooks/simp"
              />
            </Field>
          </Section>

          <Section title="Media">
            <Toggle label="Images" checked={settings.includeImages} onChange={(v) => patch({ includeImages: v })} />
            <Toggle label="Videos" checked={settings.includeVideos} onChange={(v) => patch({ includeVideos: v })} />
            <Toggle label="Audio" checked={settings.includeAudio} onChange={(v) => patch({ includeAudio: v })} />
            <Toggle label="Skip duplicate URLs" checked={settings.skipDuplicates} onChange={(v) => patch({ skipDuplicates: v })} />
            <Toggle label="Also save a ZIP when a job finishes" checked={settings.autoZip} onChange={(v) => patch({ autoZip: v })} />
          </Section>

          <CookieEditor seedUrl={firstUrl(urlsText)} cookies={settings.cookies} onChange={(v) => patch({ cookies: v })} />

          {history.length > 0 && (
            <Section title="Recent jobs">
              <ul className="space-y-1 font-mono text-[0.6875rem] text-muted-foreground">
                {history.slice(0, 6).map((h) => (
                  <li key={h.id}>
                    {new Date(h.at).toLocaleTimeString()} · {h.status} · {h.files} files · {h.source}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CookiesDialog() {
  const open = useAppStore((s) => s.cookiesOpen);
  const setOpen = useAppStore((s) => s.setCookiesOpen);
  const setCompanion = useAppStore((s) => s.setCompanionOpen);
  const settings = useAppStore((s) => s.settings);
  const urlsText = useAppStore((s) => s.urlsText);
  const patch = useAppStore((s) => s.patchSettings);

  const dismiss = () => {
    patch({ cookiesDismissed: true });
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : dismiss())}>
      <DialogContent title="Session cookies">
        <p className="mb-3 text-sm text-muted-foreground">
          {isChromeBrowser()
            ? "Use the cookie companion bookmarklet, import a Chrome export, or let the Windows app read Chrome directly."
            : "Public galleries do not need this. For logged-in threads, import cookies or use the companion bookmarklet."}
        </p>
        <CookieEditor seedUrl={firstUrl(urlsText)} cookies={settings.cookies} onChange={(v) => patch({ cookies: v })} />
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              dismiss();
              setCompanion(true);
            }}
          >
            Cookie companion
          </Button>
          <Button variant="secondary" onClick={dismiss}>
            Continue without
          </Button>
          <Button onClick={dismiss}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CompanionDialog() {
  const open = useAppStore((s) => s.companionOpen);
  const setOpen = useAppStore((s) => s.setCompanionOpen);
  const href = typeof window === "undefined" ? "" : window.location.origin;
  const src = useMemo(() => bookmarkletSource(href || "https://app.local"), [href]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title="Cookie companion" className="max-w-lg">
        <p className="text-sm text-muted-foreground">
          Drag this bookmarklet onto your bookmarks bar. On a logged-in gallery tab, click it — non-HttpOnly cookies
          are sent back here. HttpOnly session cookies still need a Chrome cookies.txt export.
        </p>
        <p className="mt-3">
          <a
            href={src}
            className="inline-flex h-10 items-center rounded-md border border-border bg-surface-2 px-3 text-sm font-medium"
            onClick={(e) => e.preventDefault()}
          >
            Send cookies to Fathomrail
          </a>
        </p>
        <p className="mt-3 text-xs text-subtle">Right-click the button → bookmark it, or copy the javascript: URL.</p>
        <div className="mt-3 flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              await navigator.clipboard.writeText(src);
              toast.success("Bookmarklet copied");
            }}
          >
            Copy bookmarklet
          </Button>
          <Button variant="secondary" size="sm" onClick={() => window.open("/companion", "simpdl")}>
            Open companion tab
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function SchedulerDialog() {
  const open = useAppStore((s) => s.schedulerOpen);
  const setOpen = useAppStore((s) => s.setSchedulerOpen);
  const schedules = useAppStore((s) => s.schedules);
  const urlsText = useAppStore((s) => s.urlsText);
  const webhook = useAppStore((s) => s.settings.webhookUrl);
  const upsert = useAppStore((s) => s.upsertSchedule);
  const remove = useAppStore((s) => s.removeSchedule);
  const [label, setLabel] = useState("Thread watch");
  const [mins, setMins] = useState(60);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title="Job scheduler" className="max-w-lg">
        <p className="mb-3 text-sm text-muted-foreground">
          Repeat the current seed URLs on an interval. When a run finishes, the webhook in Settings is posted unless
          you override it per job.
        </p>
        <div className="grid gap-3">
          <Field label="Label">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label="Every (minutes)">
            <Input type="number" min={1} max={10080} value={mins} onChange={(e) => setMins(clamp(Number(e.target.value), 1, 10080))} />
          </Field>
          <Button
            onClick={() => {
              const job: ScheduledJob = {
                id: `s${Date.now()}`,
                label: label.trim() || "Scheduled job",
                urls: urlsText,
                enabled: true,
                intervalMin: mins,
                nextRunAt: Date.now() + mins * 60_000,
                webhookUrl: webhook,
              };
              upsert(job);
              toast.success(`Next run in ${mins} min`);
            }}
          >
            Schedule current URLs
          </Button>
        </div>
        <ul className="mt-4 space-y-2">
          {!schedules.length && <li className="text-sm text-subtle">No scheduled jobs yet.</li>}
          {schedules.map((job) => (
            <li key={job.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{job.label}</div>
                <div className="text-xs text-subtle">
                  every {job.intervalMin}m · next {job.nextRunAt ? new Date(job.nextRunAt).toLocaleTimeString() : "—"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={job.enabled}
                  onCheckedChange={(v) =>
                    upsert({
                      ...job,
                      enabled: v,
                      nextRunAt: v ? Date.now() + job.intervalMin * 60_000 : job.nextRunAt,
                    })
                  }
                />
                <Button size="sm" variant="ghost" onClick={() => remove(job.id)}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function CookieEditor({
  cookies,
  onChange,
  seedUrl,
}: {
  cookies: string;
  onChange: (v: string) => void;
  seedUrl?: string;
}) {
  const setCompanion = useAppStore((s) => s.setCompanionOpen);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>Session cookies</Label>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => setCompanion(true)}>
            Companion
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => void loadChromeExport(seedUrl, onChange)}>
            Import Chrome export
          </Button>
        </div>
      </div>
      <Textarea
        rows={4}
        className="font-mono text-xs"
        value={cookies}
        onChange={(e) => onChange(e.target.value)}
        placeholder="# Netscape HTTP Cookie File  or  Chrome JSON array"
      />
      <p className="text-xs text-subtle">{summarizeCookies(cookies, seedUrl)}</p>
    </div>
  );
}

async function loadChromeExport(seedUrl: string | undefined, onChange: (v: string) => void) {
  try {
    const file = await pickCookieFile();
    if (!file) return;
    const result = await importCookieFile(file, seedUrl);
    onChange(result.netscape);
    toast.success(result.summary);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Import failed");
  }
}

async function chooseFolder(patch: (p: { downloadPathLabel: string }) => void) {
  try {
    const handle = await pickDownloadFolder();
    if (!handle) {
      toast.error("This browser cannot pick a folder. Files will save as a ZIP.");
      return;
    }
    patch({ downloadPathLabel: handle.name });
    toast.success(`Saving into ${handle.name}`);
  } catch {
    toast.error("Folder picker cancelled");
  }
}

async function enableNotify(v: boolean, patch: (p: { notifyDone: boolean }) => void) {
  patch({ notifyDone: v });
  if (v && typeof Notification !== "undefined" && Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

export function DistroDialog() {
  const open = useAppStore((s) => s.distroOpen);
  const setOpen = useAppStore((s) => s.setDistroOpen);
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState("C:\\Program Files\\Fathomrail");
  const [desktop, setDesktop] = useState(true);
  const [startMenu, setStartMenu] = useState(true);

  const reset = (v: boolean) => {
    setOpen(v);
    if (!v) setStep(0);
  };

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent title="Windows distribution" className="max-w-lg">
        {step === 0 && (
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              The Windows build can read cookies straight from your Chrome profile and write files to any folder you
              pick. This live app uses a cookie companion bookmarklet or a Chrome export.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button onClick={() => setStep(1)}>Setup wizard options</Button>
            </div>
          </div>
        )}
        {step === 1 && (
          <div className="space-y-3">
            <Field label="Install directory">
              <Input value={dir} onChange={(e) => setDir(e.target.value)} />
            </Field>
            <Toggle label="Create desktop shortcut" checked={desktop} onChange={setDesktop} />
            <Toggle label="Create Start Menu shortcut" checked={startMenu} onChange={setStartMenu} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-subtle">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function firstUrl(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("http"));
}

function clamp(n: number, min: number, max: number) {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}
