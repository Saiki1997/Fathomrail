import { APP_UA } from "../brand";
import { canonicalize, inferredNextPage, looksLikeAlbum, looksLikePagination } from "./canonical";
import { cookieHeaderForUrl } from "./cookies";
import {
  extractFromHtml,
  extractFromJson,
  filenameFrom,
  isStreamManifest,
  kindFromUrlOrMime,
  looksLikeMedia,
} from "./extract";
import { parseThreadIds } from "./thread-ids";
import type { CrawlProfile, DiscoverResult, MediaKind, ProbeResult } from "./types";
import { PROFILE_META } from "./types";
import { assertPublicHttpUrl } from "./url-guard";

const UA = APP_UA;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin + "/";
  } catch {
    return undefined;
  }
}

async function fetchOnce(
  url: string,
  opts: { cookies: string; timeoutMs: number; referer?: string; method?: string; headers?: Record<string, string> },
): Promise<Response> {
  assertPublicHttpUrl(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const headers: Record<string, string> = {
      "User-Agent": UA,
      Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      ...opts.headers,
    };
    const cookie = cookieHeaderForUrl(opts.cookies, url);
    if (cookie) headers.Cookie = cookie;
    const referer = opts.referer ?? originOf(url);
    if (referer) headers.Referer = referer;
    return await fetch(url, { method: opts.method ?? "GET", signal: ctrl.signal, headers, redirect: "follow" });
  } finally {
    clearTimeout(t);
  }
}

async function fetchWithRetry(
  url: string,
  opts: { cookies: string; timeoutMs: number; referer?: string; method?: string; headers?: Record<string, string> },
): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchOnce(url, opts);
    last = res;
    if (res.status !== 429 && res.status !== 503) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep((Number.isFinite(retryAfter) ? retryAfter * 1000 : 600 * 2 ** attempt) + 50);
  }
  return last!;
}

async function fetchText(
  url: string,
  cookies: string,
  timeoutMs: number,
  referer?: string,
): Promise<{ url: string; contentType: string; body: string; status: number }> {
  const res = await fetchWithRetry(url, { cookies, timeoutMs, referer });
  const finalUrl = res.url || url;
  assertPublicHttpUrl(finalUrl);
  const contentType = res.headers.get("content-type") ?? "";
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 2_500_000) throw new Error("Page is too large to parse");
  const body = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { url: finalUrl, contentType, body, status: res.status };
}

type Found = {
  url: string;
  filename: string;
  kind: MediaKind;
  forumId: string | null;
  postId: string | null;
  threadId: string | null;
  extractor: string;
};

function addFound(found: Map<string, Found>, item: Found, maxItems: number) {
  if (found.size >= maxItems) return;
  const key = canonicalize(item.url);
  if (found.has(key)) return;
  found.set(key, { ...item, url: key, filename: filenameFrom(key) });
}

export async function crawlDiscover(input: {
  url: string;
  cookies: string;
  profile: CrawlProfile;
}): Promise<DiscoverResult> {
  const meta = PROFILE_META[input.profile];
  const seed = input.url.trim();
  if (!seed) throw new Error("Paste a URL first");

  if (isStreamManifest(seed)) {
    return {
      pageUrl: seed,
      title: filenameFrom(seed),
      items: [],
      followed: [],
      previewHtmlSnippet: null,
      warning: "HLS/DASH manifests are skipped in this build (no ffmpeg muxer).",
    };
  }

  if (looksLikeMedia(seed)) {
    const ids = parseThreadIds(seed);
    return {
      pageUrl: seed,
      title: filenameFrom(seed),
      items: [
        {
          url: canonicalize(seed),
          filename: filenameFrom(seed),
          kind: kindFromUrlOrMime(seed),
          forumId: ids.forumId,
          postId: ids.postId,
          threadId: ids.threadId,
          extractor: "direct",
        },
      ],
      followed: [],
      previewHtmlSnippet: null,
      warning: null,
    };
  }

  const queue: string[] = [canonicalize(seed)];
  const seenPages = new Set<string>();
  const found = new Map<string, Found>();
  let title: string | null = null;
  let warning: string | null = null;
  let snippet: string | null = null;
  let extractorUsed = "html-generic";

  while (queue.length && seenPages.size < meta.pages && found.size < meta.maxItems) {
    const page = queue.shift()!;
    const pageKey = canonicalize(page);
    if (seenPages.has(pageKey)) continue;
    seenPages.add(pageKey);
    try {
      const fetched = await fetchText(page, input.cookies, meta.timeoutMs, seenPages.size === 1 ? originOf(page) : seed);
      const ct = fetched.contentType.toLowerCase();
      if (ct.includes("application/json") || fetched.body.trim().startsWith("[") || fetched.body.trim().startsWith("{")) {
        extractorUsed = "json-feed";
        for (const item of extractFromJson(fetched.body, fetched.url)) {
          addFound(found, { ...item, filename: filenameFrom(item.url) }, meta.maxItems);
        }
      } else {
        const extracted = extractFromHtml(fetched.body, fetched.url);
        extractorUsed = extracted.extractor;
        if (!title) title = extracted.title;
        if (!snippet) snippet = extracted.title ?? fetched.url;
        for (const item of extracted.media) {
          addFound(found, { ...item, filename: filenameFrom(item.url) }, meta.maxItems);
        }
        const follow = [...extracted.pagination, ...extracted.links.filter((l) => looksLikeAlbum(l) || looksLikePagination(l))];
        if (extracted.media.length && inferredNextPage(fetched.url)) {
          follow.unshift(inferredNextPage(fetched.url)!);
        }
        for (const link of follow) {
          if (seenPages.size + queue.length >= meta.pages) break;
          const canon = canonicalize(link);
          if (!seenPages.has(canon) && !queue.includes(canon)) queue.push(canon);
        }
        for (const link of extracted.links) {
          if (seenPages.size + queue.length >= meta.pages) break;
          if (!seenPages.has(link) && !queue.includes(link)) queue.push(link);
        }
      }
    } catch (err) {
      warning = err instanceof Error ? err.message : "Failed to fetch page";
    }
  }

  return {
    pageUrl: seed,
    title,
    items: [...found.values()].map((it) => ({ ...it, extractor: it.extractor || extractorUsed })),
    followed: [...seenPages],
    previewHtmlSnippet: snippet,
    warning: found.size === 0 ? warning ?? "No media found on this page" : warning,
  };
}

export async function probeUrl(input: { url: string; cookies: string; referer?: string }): Promise<ProbeResult> {
  return resolveUrl(input.url, input.cookies, input.referer, 0);
}

async function resolveUrl(url: string, cookies: string, referer: string | undefined, hop: number): Promise<ProbeResult> {
  const fail = (error: string): ProbeResult => ({
    url,
    ok: false,
    mime: null,
    bytes: null,
    filename: filenameFrom(url),
    kind: kindFromUrlOrMime(url),
    error,
    resolvedUrl: null,
    extractor: "resolver",
  });

  if (isStreamManifest(url)) return fail("Stream manifest skipped");

  try {
    assertPublicHttpUrl(url);
    const headers: Record<string, string> = {};
    let res = await fetchWithRetry(url, {
      cookies,
      timeoutMs: 12000,
      referer,
      method: "HEAD",
      headers,
    });
    if (!res.ok || !res.headers.get("content-type")) {
      res = await fetchWithRetry(url, {
        cookies,
        timeoutMs: 12000,
        referer,
        method: "GET",
        headers: { Range: "bytes=0-0" },
      });
    }
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() ?? null;
    const finalUrl = res.url || url;
    assertPublicHttpUrl(finalUrl);

    if (mime?.includes("text/html") && hop < 1) {
      const page = await fetchText(finalUrl, cookies, 12000, referer ?? url);
      const extracted = extractFromHtml(page.body, page.url);
      const best = extracted.media.find((m) => !m.url.includes("preview")) ?? extracted.media[0];
      if (best) return resolveUrl(best.url, cookies, page.url, hop + 1);
    }

    const len = res.headers.get("content-length");
    const disp = res.headers.get("content-disposition");
    const nameFromDisp = disp?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1];
    const filename = nameFromDisp ? decodeURIComponent(nameFromDisp.replace(/['"]/g, "")) : filenameFrom(finalUrl);
    return {
      url: finalUrl,
      ok: res.ok,
      mime,
      bytes: len ? Number(len) : null,
      filename,
      kind: kindFromUrlOrMime(finalUrl, mime),
      error: res.ok ? null : `HTTP ${res.status}`,
      resolvedUrl: finalUrl,
      extractor: "resolver",
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Probe failed");
  }
}
