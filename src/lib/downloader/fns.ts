import { createServerFn } from "@tanstack/react-start";
import type { CrawlProfile, DiscoverResult, ProbeResult } from "./types";

export const discoverPage = createServerFn({ method: "POST" })
  .validator((data: { url: string; cookies: string; profile: CrawlProfile }) => data)
  .handler(async ({ data }): Promise<DiscoverResult> => {
    const { crawlDiscover } = await import("./crawl.server");
    return crawlDiscover(data);
  });

export const probeMedia = createServerFn({ method: "POST" })
  .validator((data: { url: string; cookies: string; referer?: string }) => data)
  .handler(async ({ data }): Promise<ProbeResult> => {
    const { probeUrl } = await import("./crawl.server");
    return probeUrl(data);
  });
