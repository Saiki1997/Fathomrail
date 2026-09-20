using System.Text.Json;
using System.Text.RegularExpressions;

namespace SimpDownloader.Core;

public sealed class ExtractedMedia
{
    public string Url { get; init; } = "";
    public MediaKind Kind { get; init; }
    public string? PostId { get; init; }
    public string? ForumId { get; init; }
    public string? ThreadId { get; init; }
    public string Extractor { get; init; } = "html-generic";
}

public sealed class ExtractedPage
{
    public List<ExtractedMedia> Media { get; init; } = new();
    public List<string> Links { get; init; } = new();
    public List<string> Pagination { get; init; } = new();
    public string? Title { get; init; }
    public string? ForumId { get; init; }
    public string? ThreadId { get; init; }
    public string Extractor { get; init; } = "html-generic";
}

public static class MediaExtractor
{
    static readonly Regex MediaExt = new(
        @"\.(jpe?g|png|gif|webp|avif|bmp|svg|mp4|webm|mkv|mov|m4v|avi|mp3|m4a|flac|wav|ogg|opus)(?:$|\?)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    static readonly HashSet<string> JsonKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "download_url", "downloadurl", "file_url", "image_url", "media_url", "contenturl", "original", "original_url",
        "full", "full_url", "src", "source", "url", "image", "media", "file", "video", "audio"
    };

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

    public static bool LooksLikeMedia(string url)
    {
        var clean = url.Split('#')[0];
        if (MediaExt.IsMatch(clean)) return true;
        if (Regex.IsMatch(clean, @"picsum\.photos/(?:id/\d+|\d+)", RegexOptions.IgnoreCase)) return true;
        if (Regex.IsMatch(clean, @"/id/\d+/\d+/\d+")) return true;
        return false;
    }

    public static bool IsStreamManifest(string url) => Regex.IsMatch(url, @"\.(m3u8|mpd)(?:$|\?)", RegexOptions.IgnoreCase);

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

    static string? Accept(string raw, string baseUrl)
    {
        var url = Canonical.Abs(raw, baseUrl);
        if (url == null || IsStreamManifest(url)) return null;
        var upgraded = Canonical.UpgradeOriginal(url);
        if (LooksLikeMedia(upgraded)) return Canonical.Canonicalize(upgraded);
        if (Regex.IsMatch(upgraded, @"/(?:images?|media|files?|attachments?|cdn)/", RegexOptions.IgnoreCase)
            && !Regex.IsMatch(upgraded, @"/(?:css|js|fonts?)/", RegexOptions.IgnoreCase))
            return Canonical.Canonicalize(upgraded);
        return null;
    }

    public static ExtractedPage FromHtml(string html, string baseUrl)
    {
        var ids = ThreadIdParser.Parse(baseUrl);
        var forumId = ids.ForumId ?? ForumFromHtml(html);
        var threadId = ids.ThreadId;
        var titleM = Regex.Match(html, @"<title[^>]*>([^<]{1,200})", RegexOptions.IgnoreCase);
        var title = titleM.Success ? Canonical.DecodeEntities(titleM.Groups[1].Value.Trim()) : null;
        var extractor = threadId != null || forumId != null ? "forum-thread" : Canonical.LooksLikeAlbum(baseUrl) ? "album" : "html-generic";
        var media = new List<ExtractedMedia>();
        var seen = new HashSet<string>();
        var keys = new Dictionary<string, int>();
        var currentPost = ids.PostId;

        void Push(string raw, string ext)
        {
            var url = Accept(raw, baseUrl);
            if (url == null) return;
            var key = Canonical.MediaKey(url);
            if (keys.TryGetValue(key, out var idx))
            {
                var prev = media[idx];
                if (Canonical.IsThumb(prev.Url) && !Canonical.IsThumb(url))
                    media[idx] = new ExtractedMedia { Url = url, Kind = KindFrom(url), PostId = currentPost, ForumId = forumId, ThreadId = threadId, Extractor = ext };
                return;
            }
            if (!seen.Add(url)) return;
            keys[key] = media.Count;
            media.Add(new ExtractedMedia { Url = url, Kind = KindFrom(url), PostId = currentPost, ForumId = forumId, ThreadId = threadId, Extractor = ext });
        }

        foreach (Match block in Regex.Matches(html, @"<script[^>]*type=[""']application/ld\+json[""'][^>]*>([\s\S]*?)</script>", RegexOptions.IgnoreCase))
            foreach (var item in FromJson(block.Groups[1].Value, baseUrl, "json-ld"))
                Push(item.Url, item.Extractor);

        var next = Regex.Match(html, @"<script[^>]*id=[""']__NEXT_DATA__[""'][^>]*>([\s\S]*?)</script>", RegexOptions.IgnoreCase);
        if (next.Success)
            foreach (var item in FromJson(next.Groups[1].Value, baseUrl, "next-data"))
                Push(item.Url, item.Extractor);

        foreach (Match tag in Regex.Matches(html, @"<(article|li|div|section|img|source|video|audio|embed|a|meta|link)([^>]*?)>", RegexOptions.IgnoreCase))
        {
            var name = tag.Groups[1].Value.ToLowerInvariant();
            var attrs = tag.Groups[2].Value;
            if (name is "article" or "li" or "div" or "section")
            {
                var pid = ThreadIdParser.PostFromAttrs(attrs);
                if (pid != null) currentPost = pid;
                continue;
            }
            if (name == "meta")
            {
                var prop = Regex.Match(attrs, @"(?:property|name)=[""']([^""']+)", RegexOptions.IgnoreCase).Groups[1].Value.ToLowerInvariant();
                if (Regex.IsMatch(prop, @"og:image|twitter:image|og:video|og:audio|twitter:player:stream"))
                {
                    var content = Regex.Match(attrs, @"content=[""']([^""']+)", RegexOptions.IgnoreCase).Groups[1].Value;
                    if (content.Length > 0) Push(content, "opengraph");
                }
                continue;
            }
            foreach (var attr in new[] { "src", "data-src", "data-original", "data-lazy-src", "data-full", "data-url", "data-file", "poster", "href" })
            {
                var v = Regex.Match(attrs, attr + @"=[""']([^""']+)", RegexOptions.IgnoreCase).Groups[1].Value;
                if (string.IsNullOrEmpty(v)) continue;
                if (attr == "href" && !LooksLikeMedia(v) && !v.Contains("/attachment", StringComparison.OrdinalIgnoreCase)) continue;
                Push(v, extractor);
            }
            var srcset = Regex.Match(attrs, @"(?:srcset|data-srcset)=[""']([^""']+)", RegexOptions.IgnoreCase).Groups[1].Value;
            if (!string.IsNullOrEmpty(srcset))
            {
                var best = Canonical.BestSrcset(srcset);
                if (best != null) Push(best, extractor);
            }
        }

        var links = new List<string>();
        var pagination = new List<string>();
        var seenLinks = new HashSet<string>();
        Uri.TryCreate(baseUrl, UriKind.Absolute, out var baseUri);
        var baseHost = baseUri?.Host ?? "";

        foreach (Match tag in Regex.Matches(html, @"<(?:link|a)[^>]+rel=[""'][^""']*next[^""']*[""'][^>]*>", RegexOptions.IgnoreCase))
        {
            var href = Regex.Match(tag.Value, @"href=[""']([^""']+)", RegexOptions.IgnoreCase).Groups[1].Value;
            var resolved = href.Length > 0 ? Canonical.Abs(href, baseUrl) : null;
            if (resolved != null) pagination.Add(Canonical.Canonicalize(resolved));
        }

        foreach (Match a in Regex.Matches(html, @"<a[^>]+href=[""']([^""']+)[""']", RegexOptions.IgnoreCase))
        {
            var resolved = Canonical.Abs(a.Groups[1].Value, baseUrl);
            if (resolved == null) continue;
            var canon = Canonical.Canonicalize(resolved);
            if (!seenLinks.Add(canon)) continue;
            if (LooksLikeMedia(resolved)) { Push(resolved, extractor); continue; }
            if (!Uri.TryCreate(resolved, UriKind.Absolute, out var u)) continue;
            if (Canonical.LooksLikePagination(resolved) && u.Host.Equals(baseHost, StringComparison.OrdinalIgnoreCase))
            {
                pagination.Add(canon);
                continue;
            }
            var same = u.Host.Equals(baseHost, StringComparison.OrdinalIgnoreCase);
            if (!same && !Canonical.LooksLikeAlbum(resolved)) continue;
            if (Regex.IsMatch(u.AbsolutePath, @"\.(css|js|xml|json)$", RegexOptions.IgnoreCase)) continue;
            links.Add(canon);
        }

        return new ExtractedPage
        {
            Media = media,
            Links = links,
            Pagination = pagination,
            Title = string.IsNullOrWhiteSpace(title) ? null : title,
            ForumId = forumId,
            ThreadId = threadId,
            Extractor = extractor
        };
    }

    public static List<ExtractedMedia> FromJson(string text, string baseUrl, string extractor = "json-feed")
    {
        var ids = ThreadIdParser.Parse(baseUrl);
        var media = new List<ExtractedMedia>();
        var seen = new HashSet<string>();
        void Push(string raw)
        {
            var url = Accept(raw, baseUrl);
            if (url == null || !seen.Add(url)) return;
            media.Add(new ExtractedMedia { Url = url, Kind = KindFrom(url), PostId = ids.PostId, ForumId = ids.ForumId, ThreadId = ids.ThreadId, Extractor = extractor });
        }
        try
        {
            using var doc = JsonDocument.Parse(text);
            Walk(doc.RootElement, null);
            void Walk(JsonElement el, string? parentKey)
            {
                switch (el.ValueKind)
                {
                    case JsonValueKind.String:
                        var s = el.GetString();
                        if (s == null) return;
                        var key = (parentKey ?? "").ToLowerInvariant();
                        var loose = Regex.IsMatch(key, @"download|original|image|video|audio|media|contenturl|file_url");
                        if ((JsonKeys.Contains(key) || LooksLikeMedia(s)) && (LooksLikeMedia(s) || loose))
                            Push(s);
                        break;
                    case JsonValueKind.Array:
                        foreach (var c in el.EnumerateArray()) Walk(c, parentKey);
                        break;
                    case JsonValueKind.Object:
                        foreach (var p in el.EnumerateObject()) Walk(p.Value, p.Name);
                        break;
                }
            }
        }
        catch
        {
            foreach (var line in text.Split('\n'))
            {
                var t = line.Trim();
                if (LooksLikeMedia(t)) Push(t);
            }
        }
        return media;
    }

    static string? ForumFromHtml(string html)
    {
        var m = Regex.Match(html, @"data-forum-id=[""'](\d+)", RegexOptions.IgnoreCase);
        return m.Success ? m.Groups[1].Value : null;
    }
}
