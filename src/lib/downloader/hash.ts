export async function sha256Hex(data: ArrayBuffer | Blob): Promise<string> {
  const buf = data instanceof Blob ? await data.arrayBuffer() : data;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function shortHash(hex: string | null | undefined): string {
  if (!hex) return "—";
  return hex.slice(0, 8);
}

const KEY = "fathomrail-hashes";

export function loadKnownHashes(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(arr.slice(-4000));
  } catch {
    return new Set();
  }
}

export function rememberHash(hex: string) {
  const set = loadKnownHashes();
  set.add(hex);
  localStorage.setItem(KEY, JSON.stringify([...set].slice(-4000)));
}

export function forgetHashes() {
  localStorage.removeItem(KEY);
}
