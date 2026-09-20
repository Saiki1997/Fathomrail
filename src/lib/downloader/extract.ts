import {
  absUrl,
  bestSrcset,
  canonicalize,
  decodeEntities,
  isThumbUrl,
  looksLikeAlbum,
  looksLikePagination,
  mediaKey,
  upgradeOriginal,
} from "./canonical";
import { forumIdFromHtml, parseThreadIds, postIdFromAttrs } from "./thread-ids";
import type { MediaKind } from "./types";

const MEDIA_EXT =
  /\.(jpe?g|png|gif|webp|avif|bmp|svg|mp4|webm|mkv|mov|m4v|avi|mp3|m4a|flac|wav|ogg|opus)(?:$|\?)/i;

const MEDIA_JSON_KEYS = new Set([
  "download_url",
  "downloadurl",
  "file_url",
  "fileurl",
  "image_url",
  "imageurl",
  "media_url",
  "contenturl",
  "content_url",
  "original",
  "original_url",
  "full",
  "full_url",
  "src",
  "source",
  "url",
  "image",
  "media",
  "file",
  "video",
  "audio",
  "thumbnailurl",
  "og:image",
]);

export function kindFromUrlOrMime(url: string, mime?: string | null): MediaKind {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  const path = url.split("?")[0]?.toLowerCase() ?? "";
  if (/\.(jpe?g|png|gif|webp|avif|bmp|svg)$/.test(path)) return "image";
  if (/\.(mp4|webm|mkv|mov|m4v|avi)$/.test(path)) return "video";
  if (/\.(mp3|m4a|flac|wav|ogg|opus)$/.test(path)) return "audio";
  return "other";
}

export function looksLikeMedia(url: string): boolean {
  const clean = url.split("#")[0] ?? url;
  if (MEDIA_EXT.test(clean)) return true;
  if (/picsum\.photos\/(?:id\/\d+|\d+)/i.test(clean)) return true;
  if (/\/id\/\d+\/\d+\/\d+/.test(clean)) return true;
  if (/\/attachments\/\d+/i.test(clean)) return true;
  if (/\/data\/attachments\//i.test(clean)) return true;
  return false;
}

export function isStreamManifest(url: string): boolean {
  return /\.(m3u8|mpd)(?:$|\?)/i.test(url);
}

export interface ExtractedMedia {
  url: string;
  kind: MediaKind;
  postId: string | null;
  forumId: string | null;
  threadId: string | null;
  extractor: string;
}

function acceptCandidate(raw: string, base: string): string | null {
  const url = absUrl(raw, base);
  if (!url) return null;
  if (isStreamManifest(url)) return null;
  const upgraded = upgradeOriginal(url);
  if (looksLikeMedia(upgraded)) return canonicalize(upgraded);
  if (/\/(?:images?|media|files?|attachments?|cdn)\//i.test(upgraded) && !/\/(?:css|js|fonts?)\//i.test(upgraded)) {
    return canonicalize(upgraded);
  }
  return null;
}

function pushMedia(
  list: ExtractedMedia[],
  seen: Set<string>,
  keys: Map<string, number>,
  raw: string,
  base: string,
  ids: { postId: string | null; forumId: string | null; threadId: string | null },
  extractor: string,
) {
  const url = acceptCandidate(raw, base);
  if (!url) return;
  const key = mediaKey(url);
  const existingIdx = keys.get(key);
  if (existingIdx != null) {
    const prev = list[existingIdx];
    if (prev && isThumbUrl(prev.url) && !isThumbUrl(url)) {
      list[existingIdx] = { url, kind: kindFromUrlOrMime(url), ...ids, extractor };
      seen.delete(canonicalize(prev.url));
      seen.add(url);
    }
    return;
  }
  if (seen.has(url)) return;
  if (isThumbUrl(url) && keys.size > 0) {
    /* keep thumbs only when they are the only copy */
  }
  seen.add(url);
  keys.set(key, list.length);
  list.push({ url, kind: kindFromUrlOrMime(url), ...ids, extractor });
}

export function extractFromHtml(html: string, baseUrl: string): {
  media: ExtractedMedia[];
  links: string[];
  pagination: string[];
  title: string | null;
  forumId: string | null;
  threadId: string | null;
  extractor: string;
} {
  const pageIds = parseThreadIds(baseUrl);
  const forumId = pageIds.forumId ?? forumIdFromHtml(html);
  const threadId = pageIds.threadId;
  const title = decodeEntities(html.match(/<title[^>]*>([^<]{1,200})/i)?.[1]?.trim() ?? "") || null;
  const media: ExtractedMedia[] = [];
  const seen = new Set<string>();
  const keys = new Map<string, number>();
  let currentPost = pageIds.postId;
  const extractor = threadId || forumId ? "forum-thread" : looksLikeAlbum(baseUrl) ? "album" : "html-generic";

  const jsonLd = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of jsonLd) {
    for (const item of extractFromJson(block[1] ?? "", baseUrl, "json-ld")) {
      pushMedia(media, seen, keys, item.url, baseUrl, item, item.extractor);
    }
  }
  const nextData = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (nextData) {
    for (const item of extractFromJson(nextData, baseUrl, "next-data")) {
      pushMedia(media, seen, keys, item.url, baseUrl, item, item.extractor);
    }
  }

  const tokenRe = /<(article|li|div|section|img|source|video|audio|embed|a|meta|link)([^>]*?)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html))) {
    const tag = (m[1] ?? "").toLowerCase();
    const attrs = m[2] ?? "";
    if (tag === "article" || tag === "li" || tag === "div" || tag === "section") {
      const pid = postIdFromAttrs(attrs);
      if (pid) currentPost = pid;
      continue;
    }
    const ids = { postId: currentPost, forumId, threadId };
    if (tag === "meta") {
      const prop = attrs.match(/(?:property|name)=["']([^"']+)/i)?.[1]?.toLowerCase() ?? "";
      if (/og:image|twitter:image|og:video|og:audio|twitter:player:stream/.test(prop)) {
        const content = attrs.match(/content=["']([^"']+)/i)?.[1];
        if (content) pushMedia(media, seen, keys, content, baseUrl, ids, "opengraph");
      }
      continue;
    }
    if (tag === "link") {
      const rel = attrs.match(/rel=["']([^"']+)/i)?.[1]?.toLowerCase() ?? "";
      const href = attrs.match(/href=["']([^"']+)/i)?.[1];
      if (href && /image_src|preload/.test(rel) && looksLikeMedia(href)) {
        pushMedia(media, seen, keys, href, baseUrl, ids, "html-generic");
      }
      continue;
    }
    for (const name of ["src", "data-src", "data-original", "data-lazy-src", "data-full", "data-url", "data-file", "data-src-hd", "poster", "href"]) {
      const v = attrs.match(new RegExp(`${name}=["']([^"']+)`, "i"))?.[1];
      if (!v) continue;
      if (name === "href" && !looksLikeMedia(v) && !/\/attachments?\//i.test(v)) continue;
      pushMedia(media, seen, keys, v, baseUrl, ids, extractor);
    }
    const srcset = attrs.match(/(?:srcset|data-srcset)=["']([^"']+)/i)?.[1];
    if (srcset) {
      const best = bestSrcset(srcset);
      if (best) pushMedia(media, seen, keys, best, baseUrl, ids, extractor);
    }
  }

  const cssUrl = /url\((['"]?)([^)'"]+)\1\)/gi;
  let cssMatch: RegExpExecArray | null;
  while ((cssMatch = cssUrl.exec(html))) {
    const u = cssMatch[2];
    if (u && looksLikeMedia(u)) pushMedia(media, seen, keys, u, baseUrl, { postId: currentPost, forumId, threadId }, extractor);
  }

  const links: string[] = [];
  const pagination: string[] = [];
  const seenLinks = new Set<string>();
  let baseHost = "";
  try {
    baseHost = new URL(baseUrl).host;
  } catch {
    baseHost = "";
  }

  const relNext = html.matchAll(/<(?:link|a)[^>]+rel=["'][^"']*next[^"']*["'][^>]*>/gi);
  for (const tag of relNext) {
    const href = (tag[0] ?? "").match(/href=["']([^"']+)/i)?.[1];
    const resolved = href ? absUrl(href, baseUrl) : null;
    if (resolved) pagination.push(canonicalize(resolved));
  }

  const aRe = /<a[^>]+href=["']([^"']+)["']/gi;
  let aMatch: RegExpExecArray | null;
  while ((aMatch = aRe.exec(html))) {
    const resolved = absUrl(aMatch[1] ?? "", baseUrl);
    if (!resolved) continue;
    try {
      const u = new URL(resolved);
      const canon = canonicalize(resolved);
      if (seenLinks.has(canon)) continue;
      if (looksLikeMedia(resolved)) {
        pushMedia(media, seen, keys, resolved, baseUrl, { postId: currentPost, forumId, threadId }, extractor);
        continue;
      }
      if (looksLikePagination(resolved) && u.host === baseHost) {
        seenLinks.add(canon);
        pagination.push(canon);
        continue;
      }
      const sameHost = u.host === baseHost || u.host.endsWith(`.${baseHost}`) || baseHost.endsWith(`.${u.host}`);
      if (!sameHost && !looksLikeAlbum(resolved)) continue;
      if (u.pathname === new URL(baseUrl).pathname && u.search === new URL(baseUrl).search) continue;
      if (/\.(css|js|xml|json)$/i.test(u.pathname)) continue;
      seenLinks.add(canon);
      links.push(canon);
    } catch {
      /* skip */
    }
  }

  const filtered = media.filter((item, i, arr) => {
    if (!isThumbUrl(item.url)) return true;
    return !arr.some((other, j) => j !== i && mediaKey(other.url) === mediaKey(item.url) && !isThumbUrl(other.url));
  });

  return { media: filtered, links, pagination, title, forumId, threadId, extractor };
}

export function extractFromJson(text: string, baseUrl: string, extractor = "json-feed"): ExtractedMedia[] {
  const pageIds = parseThreadIds(baseUrl);
  const media: ExtractedMedia[] = [];
  const seen = new Set<string>();
  const keys = new Map<string, number>();
  const ids = { postId: pageIds.postId, forumId: pageIds.forumId, threadId: pageIds.threadId };
  try {
    const data = JSON.parse(text) as unknown;
    const walk = (node: unknown, parentKey?: string) => {
      if (typeof node === "string") {
        const key = (parentKey ?? "").toLowerCase();
        const loose = /download|original|image|video|audio|media|contenturl|file_url/.test(key);
        if ((MEDIA_JSON_KEYS.has(key) || looksLikeMedia(node)) && (looksLikeMedia(node) || loose)) {
          pushMedia(media, seen, keys, node, baseUrl, ids, extractor);
        }
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((n) => walk(n, parentKey));
        return;
      }
      if (node && typeof node === "object") {
        const rec = node as Record<string, unknown>;
        for (const [key, v] of Object.entries(rec)) {
          if (typeof v === "string") walk(v, key);
          else walk(v, key);
        }
      }
    };
    walk(data);
  } catch {
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (looksLikeMedia(t)) pushMedia(media, seen, keys, t, baseUrl, ids, extractor);
    }
  }
  return media;
}

export function filenameFrom(url: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last.slice(0, 180);
    const kind = kindFromUrlOrMime(url);
    const ext = kind === "image" ? ".jpg" : kind === "video" ? ".mp4" : kind === "audio" ? ".mp3" : ".bin";
    return `media-${Math.abs(hash(url)).toString(16)}${ext}`;
  } catch {
    return "file.bin";
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
