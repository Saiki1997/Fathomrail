const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

export function extractHttpUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const url = (m[0] ?? "").replace(/[),.;]+$/, "");
    if (!url.startsWith("http") || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

export function mergeUrlLines(existing: string, incoming: string[]): { text: string; added: number } {
  const have = new Set(extractHttpUrls(existing));
  const extra = incoming.filter((u) => !have.has(u));
  if (!extra.length) return { text: existing, added: 0 };
  const base = existing.trim();
  return { text: base ? `${base}\n${extra.join("\n")}` : extra.join("\n"), added: extra.length };
}
