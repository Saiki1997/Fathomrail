import { PHASES, type ItemStatus } from "@/lib/downloader/types";
import { cn } from "@/lib/utils";

const ORDER = ["queued", "resolving", "fetching", "verifying", "complete"] as const;

export function PhaseBar({ status }: { status: ItemStatus }) {
  const failed = status === "failed";
  const skipped = status === "skipped" || status === "paused";
  const idx = ORDER.indexOf(status as (typeof ORDER)[number]);
  const active = idx < 0 ? (failed ? 5 : 0) : idx;
  return (
    <div className="flex gap-0.5" aria-hidden>
      {PHASES.map((p, i) => (
        <span
          key={p}
          title={p}
          className={cn(
            "h-1.5 flex-1 rounded-full",
            failed && i <= Math.max(active, 2) ? "bg-danger" : "",
            !failed && !skipped && i <= active && "bg-ok",
            !failed && !skipped && i > active && "bg-surface-3",
            skipped && "bg-surface-3",
            !failed && i === active && status !== "complete" && "bg-foreground",
          )}
        />
      ))}
    </div>
  );
}
