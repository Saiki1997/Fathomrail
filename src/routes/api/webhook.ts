import { createFileRoute } from "@tanstack/react-router";
import { assertPublicHttpUrl } from "@/lib/downloader/url-guard";

export const Route = createFileRoute("/api/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: { url?: string; payload?: unknown };
        try {
          body = (await request.json()) as { url?: string; payload?: unknown };
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        if (!body.url) return Response.json({ error: "Missing url" }, { status: 400 });
        try {
          assertPublicHttpUrl(body.url);
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Bad URL" }, { status: 400 });
        }
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        try {
          const res = await fetch(body.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": "Fathomrail/1.0.0" },
            body: JSON.stringify(body.payload ?? {}),
            signal: ctrl.signal,
            redirect: "follow",
          });
          return Response.json({ ok: res.ok, status: res.status });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Webhook failed" }, { status: 502 });
        } finally {
          clearTimeout(t);
        }
      },
    },
  },
});
