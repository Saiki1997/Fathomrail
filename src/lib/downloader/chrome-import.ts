import { parseCookieDump, summarizeCookies, toNetscape } from "./cookies";

export async function importCookieFile(file: File, seedUrl?: string): Promise<{ netscape: string; summary: string; count: number }> {
  const text = await file.text();
  const records = parseCookieDump(text);
  if (!records.length) throw new Error("Could not read cookies from that file. Use cookies.txt or a Chrome JSON export.");
  const netscape = toNetscape(records);
  return { netscape, summary: summarizeCookies(netscape, seedUrl), count: records.length };
}

export function isChromeBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Chrome|Chromium|Edg\//i.test(navigator.userAgent) && !/Firefox/i.test(navigator.userAgent);
}

export async function pickCookieFile(): Promise<File | null> {
  const w = window as Window & {
    showOpenFilePicker?: (opts: unknown) => Promise<Array<{ getFile: () => Promise<File> }>>;
  };
  if (w.showOpenFilePicker) {
    try {
      const [h] = await w.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: "Chrome cookie export",
            accept: { "text/plain": [".txt"], "application/json": [".json"] },
          },
        ],
      });
      return h ? await h.getFile() : null;
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,.json,text/plain,application/json";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}
