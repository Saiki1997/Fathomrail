namespace SimpDownloader.Core;

public sealed class DownloadService
{
    readonly HttpClient _http;

    public DownloadService(HttpClient http) => _http = http;

    public async Task DownloadAsync(MediaItem item, AppSettings settings, IProgress<MediaItem>? progress, CancellationToken ct)
    {
        var destDir = Organize.Dir(settings, item);
        Directory.CreateDirectory(destDir);
        var dest = Path.Combine(destDir, item.Filename);
        var attempt = 0;
        while (attempt <= settings.Retries)
        {
            ct.ThrowIfCancellationRequested();
            item.Phase = ItemPhase.Fetching;
            item.BytesDone = 0;
            item.Error = null;
            progress?.Report(item);
            try
            {
                UrlGuard.AssertPublicHttpUrl(item.Url);
                using var req = new HttpRequestMessage(HttpMethod.Get, item.Url);
                req.Headers.TryAddWithoutValidation("User-Agent", "Fathomrail/1.0");
                var cookie = CookieJar.HeaderFor(settings.Cookies, item.Url);
                if (cookie != null) req.Headers.TryAddWithoutValidation("Cookie", cookie);
                using var res = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
                res.EnsureSuccessStatusCode();
                var total = res.Content.Headers.ContentLength ?? item.BytesTotal ?? 0;
                if (total > settings.MaxFileMb * 1024L * 1024L) throw new InvalidOperationException("Over size limit");
                await using var src = await res.Content.ReadAsStreamAsync(ct);
                await using var dst = File.Create(dest);
                var buf = new byte[64 * 1024];
                var sw = System.Diagnostics.Stopwatch.StartNew();
                int read;
                while ((read = await src.ReadAsync(buf, ct)) > 0)
                {
                    await dst.WriteAsync(buf.AsMemory(0, read), ct);
                    item.BytesDone += read;
                    if (item.BytesDone > settings.MaxFileMb * 1024L * 1024L)
                        throw new InvalidOperationException("Over size limit");
                    item.BytesTotal = total > 0 ? total : item.BytesDone;
                    item.SpeedBps = sw.Elapsed.TotalSeconds > 0 ? item.BytesDone / sw.Elapsed.TotalSeconds : 0;
                    progress?.Report(item);
                }
                item.Phase = ItemPhase.Verifying;
                progress?.Report(item);
                if (item.BytesDone == 0) throw new InvalidOperationException("Zero-byte file");
                item.Phase = ItemPhase.Complete;
                item.SpeedBps = 0;
                progress?.Report(item);
                return;
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                attempt++;
                if (attempt > settings.Retries)
                {
                    item.Phase = ItemPhase.Failed;
                    item.Error = ex.Message;
                    item.SpeedBps = 0;
                    progress?.Report(item);
                    return;
                }
                await Task.Delay(settings.RetryDelayMs, ct);
            }
        }
    }

    public static async Task RunPool<T>(IEnumerable<T> items, int workers, Func<T, Task> fn, CancellationToken ct)
    {
        var q = new Queue<T>(items);
        var tasks = Enumerable.Range(0, Math.Max(1, workers)).Select(async _ =>
        {
            while (true)
            {
                ct.ThrowIfCancellationRequested();
                T item;
                lock (q)
                {
                    if (q.Count == 0) return;
                    item = q.Dequeue();
                }
                await fn(item);
            }
        });
        await Task.WhenAll(tasks);
    }
}
