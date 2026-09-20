export const STAGES = ["crawl", "discover", "resolve", "download", "finalize"] as const;
export type StageId = (typeof STAGES)[number];

export const PHASES = ["queued", "resolving", "fetching", "verifying", "complete"] as const;
export type PhaseId = (typeof PHASES)[number];

export type CrawlProfile = "fast" | "balanced" | "deep";

export type MediaKind = "image" | "video" | "audio" | "other";

export type JobStatus = "idle" | "running" | "paused" | "stopping" | "complete" | "failed";

export type ItemStatus = PhaseId | "failed" | "paused" | "skipped";

export type OrganizeBy = "flat" | "post" | "forum" | "forum-post";

export type ThemeMode = "dark" | "light" | "system";

export interface Settings {
  profile: CrawlProfile;
  workers: number;
  retries: number;
  retryDelayMs: number;
  folderName: string;
  downloadPathLabel: string;
  cookies: string;
  includeImages: boolean;
  includeVideos: boolean;
  includeAudio: boolean;
  skipDuplicates: boolean;
  autoZip: boolean;
  maxFileMb: number;
  cookiesDismissed: boolean;
  organizeBy: OrganizeBy;
  numberFiles: boolean;
  sequentialDownload: boolean;
  theme: ThemeMode;
  clipboardWatch: boolean;
  clipboardAutoRun: boolean;
  bandwidthKbps: number;
  hostGapMs: number;
  hostMaxConcurrent: number;
  verifyHash: boolean;
  skipKnownHashes: boolean;
  notifyDone: boolean;
  webhookUrl: string;
}

export interface MediaItem {
  id: string;
  url: string;
  sourcePage: string;
  filename: string;
  kind: MediaKind;
  mime: string | null;
  bytesTotal: number | null;
  bytesDone: number;
  status: ItemStatus;
  selected: boolean;
  error: string | null;
  speedBps: number;
  startedAt: number | null;
  orderIndex: number;
  forumId: string | null;
  postId: string | null;
  threadId: string | null;
  sha256: string | null;
  extractor: string;
  resolvedUrl: string | null;
}

export interface ActivityEvent {
  id: string;
  at: number;
  level: "info" | "ok" | "warn" | "error";
  stage: StageId;
  message: string;
}

export interface DiscoverResult {
  pageUrl: string;
  title: string | null;
  items: Array<{
    url: string;
    filename: string;
    kind: MediaKind;
    forumId: string | null;
    postId: string | null;
    threadId: string | null;
    extractor: string;
  }>;
  followed: string[];
  previewHtmlSnippet: string | null;
  warning: string | null;
}

export interface ProbeResult {
  url: string;
  ok: boolean;
  mime: string | null;
  bytes: number | null;
  filename: string;
  kind: MediaKind;
  error: string | null;
  resolvedUrl: string | null;
  extractor: string;
}

export interface ScheduledJob {
  id: string;
  label: string;
  urls: string;
  enabled: boolean;
  intervalMin: number;
  nextRunAt: number | null;
  webhookUrl: string;
}

export interface JobRecord {
  id: string;
  at: number;
  status: JobStatus;
  files: number;
  failed: number;
  bytes: number;
  source: string;
}

export const DEFAULT_SETTINGS: Settings = {
  profile: "balanced",
  workers: 4,
  retries: 2,
  retryDelayMs: 800,
  folderName: "Fathomrail",
  downloadPathLabel: "Browser downloads (ZIP)",
  cookies: "",
  includeImages: true,
  includeVideos: true,
  includeAudio: true,
  skipDuplicates: true,
  autoZip: true,
  maxFileMb: 80,
  cookiesDismissed: false,
  organizeBy: "forum-post",
  numberFiles: true,
  sequentialDownload: true,
  theme: "dark",
  clipboardWatch: false,
  clipboardAutoRun: false,
  bandwidthKbps: 0,
  hostGapMs: 250,
  hostMaxConcurrent: 2,
  verifyHash: true,
  skipKnownHashes: true,
  notifyDone: true,
  webhookUrl: "",
};

export const PROFILE_META: Record<
  CrawlProfile,
  { label: string; hint: string; pages: number; timeoutMs: number; maxItems: number }
> = {
  fast: { label: "Fast", hint: "First page only, short waits", pages: 1, timeoutMs: 8000, maxItems: 40 },
  balanced: { label: "Balanced", hint: "A few related pages", pages: 3, timeoutMs: 14000, maxItems: 120 },
  deep: { label: "Deep", hint: "Follow more same-host links", pages: 6, timeoutMs: 20000, maxItems: 240 },
};
