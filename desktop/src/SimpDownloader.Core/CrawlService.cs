using System.Net;

namespace SimpDownloader.Core;

public sealed class CrawlService
{
    readonly HttpClient _http;
    const string Ua = "Fathomrail/1.1";

    public CrawlService(HttpClient http) => _http = http;

    static string? OriginOf(string url)
    {
        try { return new Uri(url).GetLeftPart(UriPartial.Authority) + "/"; }
        catch { return null; }
    }

    async Task<HttpResponseMessage> SendAsync(Func<HttpRequestMessage> factory, int timeoutMs, CancellationToken ct)
    {
        HttpResponseMessage? last = null;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var req = factory();
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(timeoutMs);
            last = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
            if ((int)last.StatusCode is not (429 or 503)) return last;
            var wait = last.Headers.RetryAfter?.Delta ?? TimeSpan.FromMilliseconds(600 * Math.Pow(2, attempt));
            last.Dispose();
            last = null;
            await Task.Delay(wait, ct);
        }
        throw new HttpRequestException("Host kept returning 429/503");
    }

    HttpRequestMessage Build(HttpMethod method, string url, AppSettings settings, string? referer)
    {
        UrlGuard.AssertPublicHttpUrl(url);
        var req = new HttpRequestMessage(method, url);
        req.Headers.TryAddWithoutValidation("User-Agent", Ua);
        req.Headers.TryAddWithoutValidation("Accept", "text/html,application/json;q=0.9,*/*;q=0.8");
        var cookie = CookieJar.HeaderFor(settings.Cookies, url);
        if (cookie != null) req.Headers.TryAddWithoutValidation("Cookie", cookie);
        var r = referer ?? OriginOf(url);
        if (r != null) req.Headers.TryAddWithoutValidation("Referer", r);
        return req;
    }

    public async Task<DiscoverResult> DiscoverAsync(string seed, AppSettings settings, CancellationToken ct)
    {
        seed = seed.Trim();
        if (string.IsNullOrEmpty(seed)) throw new InvalidOperationException("Paste a URL first");
        if (MediaExtractor.IsStreamManifest(seed))
            return new DiscoverResult { PageUrl = seed, Warning = "HLS/DASH manifests are skipped (no muxer)." };
        if (MediaExtractor.LooksLikeMedia(seed))
        {
            var ids = ThreadIdParser.Parse(seed);
            return new DiscoverResult
            {
                PageUrl = seed,
                Title = MediaExtractor.FilenameFrom(seed),
                Items =
                {
                    new MediaItem
                    {
                        Url = Canonical.Canonicalize(seed),
                        SourcePage = seed,
                        Filename = MediaExtractor.FilenameFrom(seed),
                        Kind = MediaExtractor.KindFrom(seed),
                        ForumId = ids.ForumId,
                        PostId = ids.PostId,
                        ThreadId = ids.ThreadId,
                        Extractor = "direct"
                    }
                }
            };
        }

        var (pages, timeoutMs, maxItems) = ProfileMeta.For(settings.Profile);
        var queue = new Queue<string>();
        queue.Enqueue(Canonical.Canonicalize(seed));
        var seen = new HashSet<string>();
        var found = new Dictionary<string, MediaItem>();
        string? title = null;
        string? warning = null;
        var extractorUsed = "html-generic";

        while (queue.Count > 0 && seen.Count < pages && found.Count < maxItems)
        {
            var page = queue.Dequeue();
            if (!seen.Add(page)) continue;
            try
            {
                using var res = await SendAsync(() => Build(HttpMethod.Get, page, settings, seen.Count == 1 ? OriginOf(page) : seed), timeoutMs, ct);
                res.EnsureSuccessStatusCode();
                var body = await res.Content.ReadAsStringAsync(ct);
                if (body.Length > 2_500_000) throw new InvalidOperationException("Page is too large to parse");
                var ctHeader = res.Content.Headers.ContentType?.MediaType ?? "";
                var finalUrl = res.RequestMessage?.RequestUri?.ToString() ?? page;

                void Add(ExtractedMedia item)
                {
                    if (found.Count >= maxItems) return;
                    if (item.Kind == MediaKind.Image && !settings.IncludeImages) return;
                    if (item.Kind == MediaKind.Video && !settings.IncludeVideos) return;
                    if (item.Kind == MediaKind.Audio && !settings.IncludeAudio) return;
                    var key = Canonical.Canonicalize(item.Url);
                    if (settings.SkipDuplicates && found.ContainsKey(key)) return;
                    found[key] = new MediaItem
                    {
                        Url = key,
                        SourcePage = finalUrl,
                        Filename = MediaExtractor.FilenameFrom(key),
                        Kind = item.Kind,
                        ForumId = item.ForumId,
                        PostId = item.PostId,
                        ThreadId = item.ThreadId,
                        Extractor = item.Extractor
                    };
                }

                if (ctHeader.Contains("json") || body.TrimStart().StartsWith('[') || body.TrimStart().StartsWith('{'))
                {
                    extractorUsed = "json-feed";
                    foreach (var item in MediaExtractor.FromJson(body, finalUrl)) Add(item);
                }
                else
                {
                    var extracted = MediaExtractor.FromHtml(body, finalUrl);
                    extractorUsed = extracted.Extractor;
                    title ??= extracted.Title;
                    foreach (var item in extracted.Media) Add(item);
                    var follow = extracted.Pagination.Concat(extracted.Links.Where(l => Canonical.LooksLikeAlbum(l) || Canonical.LooksLikePagination(l))).ToList();
                    var next = Canonical.InferredNextPage(finalUrl);
                    if (extracted.Media.Count > 0 && next != null) follow.Insert(0, next);
                    foreach (var link in follow.Concat(extracted.Links))
                    {
                        if (seen.Count + queue.Count >= pages) break;
                        var canon = Canonical.Canonicalize(link);
                        if (!seen.Contains(canon) && !queue.Contains(canon)) queue.Enqueue(canon);
                    }
                }
            }
            catch (Exception ex)
            {
                warning = ex.Message;
            }
        }

        foreach (var item in found.Values)
            if (string.IsNullOrEmpty(item.Extractor)) item.Extractor = extractorUsed;

        return new DiscoverResult
        {
            PageUrl = seed,
            Title = title,
            Items = found.Values.ToList(),
            Followed = seen.ToList(),
            Warning = found.Count == 0 ? warning ?? "No media found on this page" : warning
        };
    }

    public async Task ProbeAsync(MediaItem item, AppSettings settings, CancellationToken ct) =>
        await ResolveAsync(item, settings, item.SourcePage, 0, ct);

    async Task ResolveAsync(MediaItem item, AppSettings settings, string? referer, int hop, CancellationToken ct)
    {
        item.Phase = ItemPhase.Resolving;
        if (MediaExtractor.IsStreamManifest(item.Url))
        {
            item.Error = "Stream manifest skipped";
            item.Phase = ItemPhase.Queued;
            return;
        }
        try
        {
            using var res = await SendAsync(() => Build(HttpMethod.Head, item.Url, settings, referer), 12000, ct);
            var mime = res.Content.Headers.ContentType?.MediaType;
            var finalUrl = res.RequestMessage?.RequestUri?.ToString() ?? item.Url;
            UrlGuard.AssertPublicHttpUrl(finalUrl);

            if (mime != null && mime.Contains("html") && hop < 1)
            {
                using var page = await SendAsync(() => Build(HttpMethod.Get, finalUrl, settings, referer ?? item.Url), 12000, ct);
                var body = await page.Content.ReadAsStringAsync(ct);
                var extracted = MediaExtractor.FromHtml(body, finalUrl);
                var best = extracted.Media.FirstOrDefault(m => !m.Url.Contains("preview")) ?? extracted.Media.FirstOrDefault();
                if (best != null)
                {
                    item.Url = best.Url;
                    item.Extractor = best.Extractor;
                    await ResolveAsync(item, settings, finalUrl, hop + 1, ct);
                    return;
                }
            }

            item.Mime = mime;
            item.BytesTotal = res.Content.Headers.ContentLength;
            var name = res.Content.Headers.ContentDisposition?.FileName?.Trim('"');
            if (!string.IsNullOrWhiteSpace(name)) item.Filename = MediaExtractor.Sanitize(name);
            else item.Filename = MediaExtractor.FilenameFrom(finalUrl);
            item.Kind = MediaExtractor.KindFrom(finalUrl, mime);
            item.ResolvedUrl = finalUrl;
            item.Url = finalUrl;
            item.Error = res.IsSuccessStatusCode ? null : $"HTTP {(int)res.StatusCode}";
            item.Phase = ItemPhase.Queued;
        }
        catch (Exception ex)
        {
            item.Error = ex.Message;
            item.Phase = ItemPhase.Queued;
        }
    }
}
