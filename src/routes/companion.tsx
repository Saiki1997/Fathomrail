import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { COMPANION_CHANNEL, cookiesFromCompanion } from "@/lib/downloader/companion";

export const Route = createFileRoute("/companion")({ component: CompanionPage });

function CompanionPage() {
  const [status, setStatus] = useState("Waiting for the bookmarklet…");

  useEffect(() => {
    const apply = (host: string, cookies: string, href?: string) => {
      if (!cookies) {
        setStatus("No document cookies on that page (HttpOnly sessions need a Chrome export).");
        return;
      }
      const netscape = cookiesFromCompanion(host, cookies);
      localStorage.setItem(
        "fathomrail-companion-inbox",
        JSON.stringify({ netscape, host, href, at: Date.now() }),
      );
      try {
        const ch = new BroadcastChannel(COMPANION_CHANNEL);
        ch.postMessage({ type: "simpdl-cookies", host, href, cookies });
        ch.close();
      } catch {
        /* ignore */
      }
      setStatus(`Captured cookies for ${host}. Return to Fathomrail — they apply automatically.`);
    };

    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; host?: string; cookies?: string; href?: string };
      if (d?.type === "simpdl-cookies" && d.host && d.cookies != null) apply(d.host, d.cookies, d.href);
    };
    window.addEventListener("message", onMsg);
    let ch: BroadcastChannel | null = null;
    try {
      ch = new BroadcastChannel(COMPANION_CHANNEL);
      ch.onmessage = (e) => onMsg(e as MessageEvent);
    } catch {
      /* ignore */
    }
    const q = new URLSearchParams(window.location.search);
    if (q.get("c") && q.get("h")) apply(q.get("h") ?? "", q.get("c") ?? "", q.get("href") ?? undefined);
    return () => {
      window.removeEventListener("message", onMsg);
      ch?.close();
    };
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 px-6 py-12">
      <p className="text-xs uppercase tracking-wide text-subtle">Cookie companion</p>
      <h1 className="font-display text-2xl font-semibold tracking-tight">Waiting for a logged-in tab</h1>
      <p className="text-sm text-muted-foreground">
        Drag the bookmarklet onto a page you are signed into. Non-HttpOnly cookies are sent here and stored for the
        next crawl. HttpOnly session cookies still need a Chrome export or the Windows app.
      </p>
      <p className="rounded-md border border-border bg-surface px-3 py-2 text-sm">{status}</p>
      <Link to="/" className="text-sm font-medium text-foreground underline-offset-4 hover:underline">
        Back to downloader
      </Link>
    </main>
  );
}
