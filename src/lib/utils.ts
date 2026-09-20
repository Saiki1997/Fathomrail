import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatSpeed(bps: number | null | undefined): string {
  if (bps == null || bps <= 0) return "—";
  return `${formatBytes(bps)}/s`;
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 180) || "download";
}

export function filenameFromUrl(url: string, fallback = "file"): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    if (last && last.includes(".")) return sanitizeFilename(last.split("?")[0] ?? last);
    return sanitizeFilename(`${fallback}${extFromPath(u.pathname) || ".bin"}`);
  } catch {
    return sanitizeFilename(fallback);
  }
}

export function extFromPath(path: string): string {
  const m = path.toLowerCase().match(/(\.[a-z0-9]{2,5})$/);
  return m?.[1] ?? "";
}
