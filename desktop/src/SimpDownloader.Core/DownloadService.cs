using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;

namespace SimpDownloader.Core;

public sealed class DownloadService
{
    readonly HttpClient _http;
    readonly HostGate _hosts = new();
    readonly ByteLimiter _limiter = new();
    const string Ua = "Fathomrail/1.1";

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
            IDisposable? hostLock = null;
            try
            {
                var url = item.ResolvedUrl ?? item.Url;
                UrlGuard.AssertPublicHttpUrl(url);
                var host = new Uri(url).Host;
                hostLock = await _hosts.Acquire(host, Math.Max(1, settings.HostMaxConcurrent), settings.HostGapMs, ct);
                using var req = new HttpRequestMessage(HttpMethod.Get, url);
                req.Headers.TryAddWithoutValidation("User-Agent", Ua);
                var cookie = CookieJar.HeaderFor(settings.Cookies, url);
                if (cookie != null) req.Headers.TryAddWithoutValidation("Cookie", cookie);
                if (!string.IsNullOrWhiteSpace(item.SourcePage))
                    req.Headers.TryAddWithoutValidation("Referer", item.SourcePage);
                using var res = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
                if ((int)res.StatusCode is 429 or 503)
                    throw new HttpRequestException($"HTTP {(int)res.StatusCode}");
                res.EnsureSuccessStatusCode();
                var total = res.Content.Headers.ContentLength ?? item.BytesTotal ?? 0;
                if (total > settings.MaxFileMb * 1024L * 1024L) throw new InvalidOperationException("Over size limit");
                await using var src = await res.Content.ReadAsStreamAsync(ct);
                await using var dst = File.Create(dest);
                using var sha = settings.VerifyHash ? SHA256.Create() : null;
                var buf = new byte[64 * 1024];
                var sw = System.Diagnostics.Stopwatch.StartNew();
                int read;
                while ((read = await src.ReadAsync(buf, ct)) > 0)
                {
                    await dst.WriteAsync(buf.AsMemory(0, read), ct);
                    sha?.TransformBlock(buf, 0, read, null, 0);
                    item.BytesDone += read;
                    if (item.BytesDone > settings.MaxFileMb * 1024L * 1024L)
                        throw new InvalidOperationException("Over size limit");
                    item.BytesTotal = total > 0 ? total : item.BytesDone;
                    item.SpeedBps = sw.Elapsed.TotalSeconds > 0 ? item.BytesDone / sw.Elapsed.TotalSeconds : 0;
                    if (settings.BandwidthKbps > 0) await _limiter.Take(read, settings.BandwidthKbps, ct);
                    progress?.Report(item);
                }
                sha?.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
                item.Phase = ItemPhase.Verifying;
                progress?.Report(item);
                if (item.BytesDone == 0) throw new InvalidOperationException("Zero-byte file");
                if (sha?.Hash is { } hash)
                {
                    item.Sha256 = Convert.ToHexString(hash).ToLowerInvariant();
                    if (settings.SkipKnownHashes && HashStore.Contains(item.Sha256))
                    {
                        dst.Dispose();
                        try { File.Delete(dest); } catch { /* ignore */ }
                        item.Phase = ItemPhase.Skipped;
                        item.Error = "known hash";
                        item.SpeedBps = 0;
                        progress?.Report(item);
                        return;
                    }
                    HashStore.Remember(item.Sha256);
                }
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
                var backoff = ex.Message.Contains("429") || ex.Message.Contains("503")
                    ? settings.RetryDelayMs * (int)Math.Pow(2, attempt)
                    : settings.RetryDelayMs;
                await Task.Delay(backoff, ct);
            }
            finally
            {
                hostLock?.Dispose();
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

sealed class HostGate
{
    readonly ConcurrentDictionary<string, SemaphoreSlim> _sem = new();
    readonly ConcurrentDictionary<string, long> _last = new();

    public async Task<IDisposable> Acquire(string host, int max, int gapMs, CancellationToken ct)
    {
        var sem = _sem.GetOrAdd(host, _ => new SemaphoreSlim(Math.Max(1, max)));
        await sem.WaitAsync(ct);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var last = _last.GetOrAdd(host, 0);
        var wait = last + gapMs - now;
        if (wait > 0) await Task.Delay((int)wait, ct);
        _last[host] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return new Releaser(sem);
    }

    sealed class Releaser(SemaphoreSlim sem) : IDisposable
    {
        public void Dispose() => sem.Release();
    }
}

sealed class ByteLimiter
{
    readonly object _gate = new();
    long _windowStart = Environment.TickCount64;
    long _used;

    public async Task Take(int bytes, int kbps, CancellationToken ct)
    {
        if (kbps <= 0) return;
        var cap = kbps * 1000L;
        while (true)
        {
            int wait;
            lock (_gate)
            {
                var now = Environment.TickCount64;
                if (now - _windowStart >= 1000)
                {
                    _windowStart = now;
                    _used = 0;
                }
                if (_used + bytes <= cap)
                {
                    _used += bytes;
                    return;
                }
                wait = (int)Math.Max(20, 1000 - (now - _windowStart));
            }
            await Task.Delay(wait, ct);
        }
    }
}
