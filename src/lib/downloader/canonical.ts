/** URL identity, thumbnail filtering, original-size upgrades (gallery-dl / yt-dlp style). */

const TRACKING = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "ref", "referrer"]);

export function decodeEntities(s: string): string {
  return s
    .replace(/&/g, "&")
    .replace(/"/g, '"')
    .replace(/&#39;|'/g, "'")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

export function absUrl(raw: string, base: string): string | null {
  try {
    const u = new URL(decodeEntities(raw.trim()), base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export function canonicalize(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING.has(k.toLowerCase())) u.searchParams.delete(k);
    }
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return url;
  }
}

export function isThumbUrl(url: string): boolean {
  const path = url.split("?")[0]?.toLowerCase() ?? "";
  return /(?:^|[/_-])(thumb|thumbnail|thumbs|preview|small|icon|mini|tiny)(?:[/_-]|$)/.test(path) || /-\d{2,3}x\d{2,3}(?:\.\w+)?$/.test(path);
}

export function upgradeOriginal(url: string): string {
  try {
    const u = new URL(url);
    u.pathname = u.pathname
      .replace(/\/thumbs?\//gi, "/")
      .replace(/\/previews?\//gi, "/")
      .replace(/\/small\//gi, "/")
      .replace(/[-_](?:thumb|small|preview|150x150|300x300)/gi, "");
    for (const k of ["w", "h", "width", "height", "size"]) {
      const v = u.searchParams.get(k);
      if (v && Number(v) > 0 && Number(v) < 800) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return url;
  }
}

export function mediaKey(url: string): string {
  try {
    const u = new URL(canonicalize(url));
    const parts = u.pathname.replace(/\/+$/, "").toLowerCase().split("/").filter(Boolean);
    const last = parts[parts.length - 1] ?? "";
    if (/\.[a-z0-9]{2,5}$/.test(last)) {
      const stem = last
        .replace(/\.[a-z0-9]{2,5}$/, "")
        .replace(/[-_](?:thumb|small|preview|\d{2,4}x\d{2,4})$/i, "");
      return `${u.hostname}/${stem}`;
    }
    if (parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1] ?? "") && /^\d+$/.test(parts[parts.length - 2] ?? "")) {
      return `${u.hostname}/${parts.slice(0, -2).join("/")}`;
    }
    return `${u.hostname}/${parts.join("/")}`;
  } catch {
    return url;
  }
}

export function looksLikeAlbum(url: string): boolean {
  return /\/(a|album|albums|gallery|galleries|g|post|posts|thread|threads|view|v|f|file|attachments?)\/[^/?#]+/i.test(url);
}

export function looksLikePagination(url: string): boolean {
  return /[?&]page=\d+/i.test(url) || /\/page-\d+/i.test(url) || /[?&]p=\d+/i.test(url) || /\/offset\/\d+/i.test(url);
}

export function inferredNextPage(current: string): string | null {
  try {
    const u = new URL(current);
    const q = u.searchParams.get("page") ?? u.searchParams.get("p");
    if (q && /^\d+$/.test(q)) {
      const key = u.searchParams.get("page") != null ? "page" : "p";
      u.searchParams.set(key, String(Number(q) + 1));
      return u.toString();
    }
    const m = u.pathname.match(/\/page-(\d+)\/?$/i);
    if (m) {
      u.pathname = u.pathname.replace(/page-\d+/i, `page-${Number(m[1]) + 1}`);
      return u.toString();
    }
    if (/\/threads\/[^/]+\/?$/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/?$/, "/") + "page-2";
      return u.toString();
    }
    return null;
  } catch {
    return null;
  }
}

export function bestSrcset(srcset: string): string | null {
  let bestUrl = "";
  let best = -1;
  for (const part of srcset.split(",")) {
    const bits = part.trim().split(/\s+/);
    const u = bits[0];
    if (!u) continue;
    const d = bits[1] ?? "1x";
    const n = d.endsWith("w") ? parseInt(d, 10) : d.endsWith("x") ? parseFloat(d) * 1000 : 1;
    if (n >= best) {
      best = n;
      bestUrl = u;
    }
  }
  return bestUrl || null;
}
