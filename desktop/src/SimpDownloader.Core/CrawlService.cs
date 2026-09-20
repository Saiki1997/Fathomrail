namespace SimpDownloader.Core;

public sealed class CrawlService
{
    readonly HttpClient _http;

    public CrawlService(HttpClient http) => _http = http;

    public async Task<DiscoverResult> DiscoverAsync(string seed, AppSettings settings, CancellationToken ct)
    {
        seed = seed.Trim();
        if (string.IsNullOrEmpty(seed)) throw new InvalidOperationException("Paste a URL first");
        if (MediaExtractor.LooksLikeMedia(seed))
        {
            return new DiscoverResult
            {
                PageUrl = seed,
                Title = MediaExtractor.FilenameFrom(seed),
                Items = { new MediaItem { Url = seed, Filename = MediaExtractor.FilenameFrom(seed), Kind = MediaExtractor.KindFrom(seed) } }
            };
        }

        var (pages, timeoutMs, maxItems) = ProfileMeta.For(settings.Profile);
        var queue = new Queue<string>();
        queue.Enqueue(seed);
        var seen = new HashSet<string>();
        var found = new Dictionary<string, MediaItem>();
        string? title = null;
        string? warning = null;

        while (queue.Count > 0 && seen.Count < pages && found.Count < maxItems)
        {
            var page = queue.Dequeue();
            if (!seen.Add(page)) continue;
            try
            {
                UrlGuard.AssertPublicHttpUrl(page);
                using var req = new HttpRequestMessage(HttpMethod.Get, page);
                req.Headers.TryAddWithoutValidation("User-Agent", "SimpDownloader/2.0");
                var cookie = CookieJar.HeaderFor(settings.Cookies, page);
                if (cookie != null) req.Headers.TryAddWithoutValidation("Cookie", cookie);
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                cts.CancelAfter(timeoutMs);
                using var res = await _http.SendAsync(req, cts.Token);
                res.EnsureSuccessStatusCode();
                var body = await res.Content.ReadAsStringAsync(ct);
                if (body.Length > 2_500_000) throw new InvalidOperationException("Page is too large to parse");
                var ctHeader = res.Content.Headers.ContentType?.MediaType ?? "";
                var finalUrl = res.RequestMessage?.RequestUri?.ToString() ?? page;
                List<(string Url, MediaKind Kind)> items;
                List<string> links = new();
                if (ctHeader.Contains("json") || body.TrimStart().StartsWith('[') || body.TrimStart().StartsWith('{'))
                    items = MediaExtractor.FromJson(body, finalUrl);
                else
                {
                    var extracted = MediaExtractor.FromHtml(body, finalUrl);
                    items = extracted.Media;
                    links = extracted.Links;
                    title ??= extracted.Title;
                }
                foreach (var item in items)
                {
                    if (found.Count >= maxItems) break;
                    if (settings.SkipDuplicates && found.ContainsKey(item.Url)) continue;
                    if (item.Kind == MediaKind.Image && !settings.IncludeImages) continue;
                    if (item.Kind == MediaKind.Video && !settings.IncludeVideos) continue;
                    if (item.Kind == MediaKind.Audio && !settings.IncludeAudio) continue;
                    var ids = ThreadIdParser.Parse(finalUrl);
                    found[item.Url] = new MediaItem
                    {
                        Url = item.Url,
                        Filename = MediaExtractor.FilenameFrom(item.Url),
                        Kind = item.Kind,
                        ForumId = ids.ForumId,
                        PostId = ids.PostId,
                        ThreadId = ids.ThreadId,
                    };
                }
                foreach (var link in links)
                    if (seen.Count + queue.Count < pages && !seen.Contains(link))
                        queue.Enqueue(link);
            }
            catch (Exception ex)
            {
                warning = ex.Message;
            }
        }

        return new DiscoverResult
        {
            PageUrl = seed,
            Title = title,
            Items = found.Values.ToList(),
            Followed = seen.ToList(),
            Warning = found.Count == 0 ? warning ?? "No media found on this page" : warning
        };
    }

    public async Task ProbeAsync(MediaItem item, AppSettings settings, CancellationToken ct)
    {
        item.Phase = ItemPhase.Resolving;
        try
        {
            UrlGuard.AssertPublicHttpUrl(item.Url);
            using var req = new HttpRequestMessage(HttpMethod.Head, item.Url);
            req.Headers.TryAddWithoutValidation("User-Agent", "SimpDownloader/2.0");
            var cookie = CookieJar.HeaderFor(settings.Cookies, item.Url);
            if (cookie != null) req.Headers.TryAddWithoutValidation("Cookie", cookie);
            using var res = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            item.Mime = res.Content.Headers.ContentType?.MediaType;
            item.BytesTotal = res.Content.Headers.ContentLength;
            if (res.Content.Headers.ContentDisposition?.FileName is string n)
                item.Filename = MediaExtractor.Sanitize(n.Trim('"'));
            item.Kind = MediaExtractor.KindFrom(item.Url, item.Mime);
            item.Phase = ItemPhase.Queued;
        }
        catch (Exception ex)
        {
            item.Error = ex.Message;
            item.Phase = ItemPhase.Queued;
        }
    }
}
