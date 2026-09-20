import { createFileRoute } from "@tanstack/react-router";
import { APP_UA } from "@/lib/brand";
import { cookieHeaderForUrl } from "@/lib/downloader/cookies";
import { assertPublicHttpUrl } from "@/lib/downloader/url-guard";

const UA = APP_UA;

const MAX_BYTES = 80 * 1024 * 1024;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export const Route = createFileRoute("/api/media")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const target = url.searchParams.get("url");
        const cookies = url.searchParams.get("cookies") ?? "";
        const referer = url.searchParams.get("referer") ?? "";
        if (!target) return Response.json({ error: "Missing url" }, { status: 400 });
        try {
          assertPublicHttpUrl(target);
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Bad URL" }, { status: 400 });
        }

        const headers: Record<string, string> = {
          "User-Agent": UA,
          Accept: "*/*",
        };
        const cookie = cookieHeaderForUrl(cookies, target);
        if (cookie) headers.Cookie = cookie;
        if (referer) {
          try {
            assertPublicHttpUrl(referer);
            headers.Referer = referer;
          } catch {
            /* ignore bad referer */
          }
        }
        const range = request.headers.get("range");
        if (range) headers.Range = range;

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60_000);
        try {
          let res = await fetch(target, { headers, signal: ctrl.signal, redirect: "follow" });
          if (res.status === 429 || res.status === 503) {
            const wait = Number(res.headers.get("retry-after"));
            await sleep((Number.isFinite(wait) ? wait * 1000 : 800));
            res = await fetch(target, { headers, signal: ctrl.signal, redirect: "follow" });
          }
          if (res.url) {
            try {
              assertPublicHttpUrl(res.url);
            } catch {
              return Response.json({ error: "Redirected to a blocked host" }, { status: 400 });
            }
          }
          const len = Number(res.headers.get("content-length") ?? "0");
          if (len > MAX_BYTES) {
            return Response.json({ error: "File exceeds size limit" }, { status: 413 });
          }
          const outHeaders = new Headers();
          const pass = ["content-type", "content-length", "content-range", "accept-ranges", "last-modified"];
          for (const h of pass) {
            const v = res.headers.get(h);
            if (v) outHeaders.set(h, v);
          }
          outHeaders.set("Cache-Control", "private, max-age=120");
          return new Response(res.body, { status: res.status, headers: outHeaders });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Fetch failed" },
            { status: 502 },
          );
        } finally {
          clearTimeout(timer);
        }
      },
    },
  },
});
