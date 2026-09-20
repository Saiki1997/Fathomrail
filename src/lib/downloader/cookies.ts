import { APP_NAME } from "../brand";

export interface CookieRecord {
  domain: string;
  path: string;
  name: string;
  value: string;
}

function hostMatches(cookieDomain: string, host: string): boolean {
  const d = cookieDomain.replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  if (!d) return true;
  return h === d || h.endsWith(`.${d}`);
}

export function parseCookieDump(raw: string): CookieRecord[] {
  const text = raw.trim();
  if (!text) return [];

  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const data = JSON.parse(text) as unknown;
      const rows = Array.isArray(data)
        ? data
        : data && typeof data === "object" && Array.isArray((data as { cookies?: unknown }).cookies)
          ? (data as { cookies: unknown[] }).cookies
          : [];
      const out: CookieRecord[] = [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        const name = String(r.name ?? r.Name ?? "");
        const value = String(r.value ?? r.Value ?? "");
        if (!name) continue;
        out.push({
          domain: String(r.domain ?? r.host ?? r.host_key ?? r.Domain ?? ""),
          path: String(r.path ?? r.Path ?? "/"),
          name,
          value,
        });
      }
      if (out.length) return out;
    } catch {
      /* fall through */
    }
  }

  if (text.includes("\t")) {
    const out: CookieRecord[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const cols = line.split("\t");
      if (cols.length < 7) continue;
      const name = cols[5];
      if (!name) continue;
      out.push({
        domain: (cols[0] ?? "").replace(/^\./, ""),
        path: cols[2] || "/",
        name,
        value: cols[6] ?? "",
      });
    }
    if (out.length) return out;
  }

  const out: CookieRecord[] = [];
  const blob = text.replace(/\n/g, ";");
  for (const part of blob.split(";")) {
    const t = part.trim();
    if (!t || t.includes("expires=") || t.toLowerCase().startsWith("path=") || t.toLowerCase().startsWith("domain=")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out.push({ domain: "", path: "/", name: t.slice(0, eq).trim(), value: t.slice(eq + 1).trim() });
  }
  return out;
}

export function cookiesForHost(records: CookieRecord[], host: string): CookieRecord[] {
  return records.filter((c) => hostMatches(c.domain, host));
}

export function cookieHeaderForUrl(raw: string, targetUrl: string): string | null {
  const records = parseCookieDump(raw);
  if (!records.length) return null;
  let host = "";
  let path = "/";
  try {
    const u = new URL(targetUrl);
    host = u.hostname;
    path = u.pathname || "/";
  } catch {
    return null;
  }
  const pairs = records
    .filter((c) => hostMatches(c.domain, host) && (!c.path || path.startsWith(c.path)))
    .map((c) => `${c.name}=${c.value}`);
  return pairs.length ? pairs.join("; ") : null;
}

export function summarizeCookies(raw: string, seedUrl?: string): string {
  const records = parseCookieDump(raw);
  if (!records.length) return "No cookies loaded";
  if (!seedUrl) return `${records.length} cookie${records.length === 1 ? "" : "s"} loaded`;
  try {
    const host = new URL(seedUrl).hostname;
    const n = cookiesForHost(records, host).length;
    return `${n} of ${records.length} cookies match ${host}`;
  } catch {
    return `${records.length} cookies loaded`;
  }
}

export function toNetscape(records: CookieRecord[]): string {
  const lines = ["# Netscape HTTP Cookie File", `# Imported by ${APP_NAME}`];
  for (const c of records) {
    const domain = c.domain.startsWith(".") || !c.domain ? c.domain || "" : c.domain;
    lines.push([domain || ".imported.local", "TRUE", c.path || "/", "FALSE", "0", c.name, c.value].join("\t"));
  }
  return lines.join("\n");
}
