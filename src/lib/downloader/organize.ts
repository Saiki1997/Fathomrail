import { sanitizeFilename } from "../utils";
import type { MediaItem, OrganizeBy, Settings } from "./types";

export function padIndex(n: number, width = 3): string {
  return String(n).padStart(width, "0");
}

export function stripOrderPrefix(name: string): string {
  return name.replace(/^\d{3,4}_/, "");
}

export function orderedFilename(index: number, name: string): string {
  const base = sanitizeFilename(stripOrderPrefix(name));
  return `${padIndex(index)}_${base}`;
}

export function organizeDir(settings: Settings, item: Pick<MediaItem, "forumId" | "postId" | "threadId">): string {
  const root = sanitizeFilename(settings.folderName || "SimpDownloads");
  const forum = item.forumId ? `forum_${sanitizeFilename(item.forumId)}` : "forum_unknown";
  const post = item.postId ? `post_${sanitizeFilename(item.postId)}` : item.threadId ? `thread_${sanitizeFilename(item.threadId)}` : "post_unknown";
  switch (settings.organizeBy as OrganizeBy) {
    case "forum":
      return `${root}/${forum}`;
    case "post":
      return `${root}/${post}`;
    case "forum-post":
      return `${root}/${forum}/${post}`;
    default:
      return root;
  }
}

export function relativePath(settings: Settings, item: MediaItem): string {
  return `${organizeDir(settings, item)}/${item.filename}`;
}
