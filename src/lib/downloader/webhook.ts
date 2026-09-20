import { APP_NAME } from "../brand";

export async function postWebhook(url: string, payload: unknown): Promise<{ ok: boolean; error?: string }> {
  const target = url.trim();
  if (!target) return { ok: true };
  try {
    const res = await fetch("/api/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: target, payload }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Webhook failed" };
  }
}

export function jobWebhookPayload(input: {
  status: string;
  source: string;
  startedAt: number | null;
  files: Array<{ filename: string; bytes: number; sha256: string | null; url: string; status: string }>;
}) {
  const done = input.files.filter((f) => f.status === "complete");
  return {
    app: APP_NAME,
    status: input.status,
    source: input.source,
    startedAt: input.startedAt,
    finishedAt: Date.now(),
    files: done.length,
    failed: input.files.filter((f) => f.status === "failed").length,
    bytes: done.reduce((n, f) => n + f.bytes, 0),
    items: done.map((f) => ({ filename: f.filename, bytes: f.bytes, sha256: f.sha256, url: f.url })),
  };
}
