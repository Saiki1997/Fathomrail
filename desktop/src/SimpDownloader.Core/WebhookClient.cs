using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace SimpDownloader.Core;

public static class WebhookClient
{
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(12) };

    public static async Task<(bool Ok, string? Error)> PostAsync(string url, object payload, CancellationToken ct)
    {
        url = url.Trim();
        if (url.Length == 0) return (true, null);
        try
        {
            UrlGuard.AssertPublicHttpUrl(url);
            var json = JsonSerializer.Serialize(payload);
            using var req = new HttpRequestMessage(HttpMethod.Post, url)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json")
            };
            req.Headers.TryAddWithoutValidation("User-Agent", "Fathomrail/1.1");
            using var res = await Http.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode) return (false, $"HTTP {(int)res.StatusCode}");
            return (true, null);
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    public static object JobPayload(string status, string source, DateTimeOffset started, IEnumerable<MediaItem> items)
    {
        var done = items.Where(i => i.Phase == ItemPhase.Complete).ToList();
        return new
        {
            app = "Fathomrail",
            status,
            source,
            startedAt = started.ToUnixTimeMilliseconds(),
            finishedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            files = done.Count,
            failed = items.Count(i => i.Phase == ItemPhase.Failed),
            bytes = done.Sum(i => i.BytesDone),
            items = done.Select(i => new { filename = i.Filename, bytes = i.BytesDone, sha256 = i.Sha256, url = i.Url })
        };
    }
}
