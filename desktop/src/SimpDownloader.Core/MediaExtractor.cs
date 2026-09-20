using System.Text.Json;
using System.Text.RegularExpressions;

namespace SimpDownloader.Core;

public static class MediaExtractor
{
    static readonly Regex MediaExt = new(
        @"\.(jpe?g|png|gif|webp|avif|bmp|svg|mp4|webm|mkv|mov|m4v|avi|mp3|m4a|flac|wav|ogg|opus)(?:$|\?)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public static MediaKind KindFrom(string url, string? mime = null)
    {
        var m = (mime ?? "").ToLowerInvariant();
        if (m.StartsWith("image/")) return MediaKind.Image;
        if (m.StartsWith("video/")) return MediaKind.Video;
        if (m.StartsWith("audio/")) return MediaKind.Audio;
        var path = url.Split('?')[0].ToLowerInvariant();
        if (Regex.IsMatch(path, @"\.(jpe?g|png|gif|webp|avif|bmp|svg)$")) return MediaKind.Image;
        if (Regex.IsMatch(path, @"\.(mp4|webm|mkv|mov|m4v|avi)$")) return MediaKind.Video;
        if (Regex.IsMatch(path, @"\.(mp3|m4a|flac|wav|ogg|opus)$")) return MediaKind.Audio;
        return MediaKind.Other;
    }

    public static bool LooksLikeMedia(string url) => MediaExt.IsMatch(url.Split('#')[0]);

    public static string FilenameFrom(string url)
    {
        try
        {
            var u = new Uri(url);
            var last = Uri.UnescapeDataString(u.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries).LastOrDefault() ?? "");
            if (last.Contains('.') && last.Length < 180) return Sanitize(last);
        }
        catch { /* ignore */ }
        var kind = KindFrom(url);
        var ext = kind switch { MediaKind.Image => ".jpg", MediaKind.Video => ".mp4", MediaKind.Audio => ".mp3", _ => ".bin" };
        return $"media-{Math.Abs(url.GetHashCode()):x}{ext}";
    }

    public static string Sanitize(string name)
    {
        foreach (var c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
        name = name.Trim();
        return name.Length == 0 ? "download" : name[..Math.Min(180, name.Length)];
    }

    public static (List<(string Url, MediaKind Kind)> Media, List<string> Links, string? Title) FromHtml(string html, string baseUrl)
    {
        var media = new Dictionary<string, MediaKind>();
        var title = Regex.Match(html, @"<title[^>]*>([^<]{1,200})", RegexOptions.IgnoreCase).Groups[1].Value;
        if (string.IsNullOrWhiteSpace(title)) title = null;

        void Add(string raw)
        {
            if (!Uri.TryCreate(new Uri(baseUrl), raw.Replace("&", "&").Trim(), out var u)) return;
            if (u.Scheme is not ("http" or "https")) return;
            var s = u.GetLeftPart(UriPartial.Query);
            if (!LooksLikeMedia(s) && !s.Contains("picsum.photos", StringComparison.OrdinalIgnoreCase)
                && !s.Contains("images", StringComparison.OrdinalIgnoreCase)
                && !s.Contains("media", StringComparison.OrdinalIgnoreCase))
                return;
            media.TryAdd(s, KindFrom(s));
        }

        foreach (Match tag in Regex.Matches(html, @"<(img|source|video|audio|embed|meta|a)([^>]*?)>", RegexOptions.IgnoreCase))
        {
            var name = tag.Groups[1].Value.ToLowerInvariant();
            var attrs = tag.Groups[2].Value;
            if (name == "meta")
            {
                var prop = Regex.Match(attrs, @"(?:property|name)=[""']([^""']+)", RegexOptions.IgnoreCase).Groups[1].Value.ToLowerInvariant();
                if (prop.Contains("og:image") || prop.Contains("twitter:image") || prop.Contains("og:video"))
                {
                    var content = Regex.Match(attrs, @"content=[""']([^""']+)", RegexOptions.IgnoreCase).Groups[1].Value;
                    if (!string.IsNullOrEmpty(content)) Add(content);
                }
                continue;
            }
            foreach (var attr in new[] { "src", "data-src", "data-original", "data-lazy-src", "data-url", "poster", "href" })
            {
                var v = Regex.Match(attrs, attr + @"=[""']([^""']+)", RegexOptions.IgnoreCase).Groups[1].Value;
                if (string.IsNullOrEmpty(v)) continue;
                if (attr == "href" && !LooksLikeMedia(v)) continue;
                Add(v);
            }
        }

        var links = new List<string>();
        var seen = new HashSet<string>();
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var baseUri)) baseUri = new Uri("https://example.invalid/");
        foreach (Match a in Regex.Matches(html, @"<a[^>]+href=[""']([^""'#]+)[""']", RegexOptions.IgnoreCase))
        {
            if (!Uri.TryCreate(baseUri, a.Groups[1].Value, out var u)) continue;
            if (!u.Host.Equals(baseUri.Host, StringComparison.OrdinalIgnoreCase)) continue;
            if (LooksLikeMedia(u.AbsoluteUri)) continue;
            if (seen.Add(u.AbsoluteUri)) links.Add(u.AbsoluteUri);
        }

        return (media.Select(kv => (kv.Key, kv.Value)).ToList(), links, title);
    }

    public static List<(string Url, MediaKind Kind)> FromJson(string text, string baseUrl)
    {
        var media = new Dictionary<string, MediaKind>();
        void Add(string raw)
        {
            if (!Uri.TryCreate(raw, UriKind.Absolute, out var u) && !Uri.TryCreate(new Uri(baseUrl), raw, out u)) return;
            media.TryAdd(u.AbsoluteUri, KindFrom(u.AbsoluteUri));
        }
        try
        {
            using var doc = JsonDocument.Parse(text);
            Walk(doc.RootElement);
            void Walk(JsonElement el)
            {
                switch (el.ValueKind)
                {
                    case JsonValueKind.String:
                        var s = el.GetString();
                        if (s != null && (s.StartsWith("http") || LooksLikeMedia(s))) Add(s);
                        break;
                    case JsonValueKind.Array:
                        foreach (var c in el.EnumerateArray()) Walk(c);
                        break;
                    case JsonValueKind.Object:
                        foreach (var p in el.EnumerateObject())
                        {
                            if (p.Name is "download_url" or "url" or "src" or "image" or "media" or "file" && p.Value.ValueKind == JsonValueKind.String)
                                Add(p.Value.GetString()!);
                            else Walk(p.Value);
                        }
                        break;
                }
            }
        }
        catch
        {
            foreach (var line in text.Split('\n'))
            {
                var t = line.Trim();
                if (t.StartsWith("http")) Add(t);
            }
        }
        return media.Select(kv => (kv.Key, kv.Value)).ToList();
    }
}
