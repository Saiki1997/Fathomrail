import { ChevronDown, FolderOpen, RotateCcw, ShieldCheck } from "lucide-react";
import { PhaseBar } from "@/components/app/phase-bar";
import { Button } from "@/components/ui/button";
import { exportHashReport, retryFailed, retryItem, saveItem } from "@/lib/downloader/engine";
import { shortHash } from "@/lib/downloader/hash";
import { useAppStore } from "@/lib/downloader/store";
import { cn, formatBytes, formatEta, formatSpeed } from "@/lib/utils";

export function DownloadMonitor({
  stats,
}: {
  stats: { total: number; done: number; failed: number; bytes: number; speed: number; eta?: number | null };
}) {
  const items = useAppStore((s) => s.items);
  const open = useAppStore((s) => s.monitorOpen);
  const setOpen = useAppStore((s) => s.setMonitorOpen);
  const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;

  return (
    <section className="border-t border-border bg-elevated">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left md:px-6"
        onClick={() => setOpen(!open)}
      >
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Download monitor</span>
        <span className="font-mono text-xs tabular-nums text-foreground">
          {stats.done}/{stats.total}
          {stats.failed ? ` · ${stats.failed} failed` : ""}
        </span>
        <span className="hidden font-mono text-xs tabular-nums text-subtle sm:inline">
          {formatBytes(stats.bytes)} · {formatSpeed(stats.speed)}
          {stats.eta != null ? ` · ETA ${formatEta(stats.eta)}` : ""}
        </span>
        <span className="ml-auto h-1 w-24 overflow-hidden rounded-full bg-surface-3">
          <span className="block h-full bg-ok" style={{ width: `${pct}%` }} />
        </span>
        <ChevronDown className={cn("size-4 text-subtle transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="max-h-64 overflow-auto border-t border-border">
          {items.length > 0 && (
            <div className="flex justify-end gap-2 px-4 py-2 md:px-6">
              {stats.failed > 0 && (
                <Button size="sm" variant="secondary" onClick={() => void retryFailed()}>
                  <RotateCcw className="size-3.5" />
                  Retry failed
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => void exportHashReport()}>
                <ShieldCheck className="size-3.5" />
                SHA-256 list
              </Button>
            </div>
          )}
          {!items.length ? (
            <p className="px-4 py-6 text-center text-sm text-subtle">No transfers yet. Run a job to populate this drawer.</p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-elevated text-[0.6875rem] uppercase tracking-wide text-subtle">
                <tr>
                  <th className="px-4 py-2 font-medium md:px-6">File</th>
                  <th className="hidden px-2 py-2 font-medium sm:table-cell">Phase</th>
                  <th className="px-2 py-2 font-medium">Size</th>
                  <th className="hidden px-2 py-2 font-medium md:table-cell">SHA-256</th>
                  <th className="hidden px-2 py-2 font-medium md:table-cell">Speed</th>
                  <th className="px-4 py-2 font-medium md:px-6" />
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const ratio =
                    it.bytesTotal && it.bytesTotal > 0 ? Math.min(1, it.bytesDone / it.bytesTotal) : it.status === "complete" ? 1 : 0;
                  return (
                    <tr key={it.id} className="border-t border-border">
                      <td className="max-w-[10rem] px-4 py-2 md:px-6">
                        <div className="truncate font-medium">{it.filename}</div>
                        {it.extractor && <div className="truncate text-subtle">{it.extractor}</div>}
                        {it.error && <div className="truncate text-danger">{it.error}</div>}
                        <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-surface-3 sm:hidden">
                          <span className="block h-full bg-ok" style={{ width: `${ratio * 100}%` }} />
                        </div>
                      </td>
                      <td className="hidden min-w-40 px-2 py-2 sm:table-cell">
                        <PhaseBar status={it.status} />
                        <div className="mt-1 capitalize text-subtle">{it.status}</div>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 font-mono tabular-nums text-muted-foreground">
                        {formatBytes(it.bytesDone)}
                        {it.bytesTotal ? ` / ${formatBytes(it.bytesTotal)}` : ""}
                      </td>
                      <td className="hidden px-2 py-2 font-mono text-subtle md:table-cell">{shortHash(it.sha256)}</td>
                      <td className="hidden whitespace-nowrap px-2 py-2 font-mono tabular-nums text-muted-foreground md:table-cell">
                        {formatSpeed(it.speedBps)}
                      </td>
                      <td className="px-4 py-2 text-right md:px-6">
                        {it.status === "failed" && (
                          <Button size="icon-sm" variant="ghost" onClick={() => void retryItem(it.id)} aria-label="Retry">
                            <RotateCcw className="size-3.5" />
                          </Button>
                        )}
                        {it.status === "complete" && (
                          <Button size="icon-sm" variant="ghost" onClick={() => void saveItem(it.id)} aria-label="Save file">
                            <FolderOpen className="size-3.5" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
