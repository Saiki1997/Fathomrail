using System.Text.RegularExpressions;

namespace SimpDownloader.Core;

public readonly record struct ThreadIds(string? ForumId, string? ThreadId, string? PostId);

public static class ThreadIdParser
{
    public static ThreadIds Parse(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return default;
        var path = u.AbsolutePath;
        string? Forum() => M(path, @"/forums/(?:[^/]*?\.)?(\d+)");
        string? Thread() => M(path, @"/threads/(?:[^/]*?\.)?(\d+)");
        string? Post() => M(path, @"/posts/(\d+)") ?? M(u.Fragment, @"post-(\d+)");
        return new ThreadIds(Forum() ?? Q(u, "forum_id") ?? Q(u, "f"), Thread() ?? Q(u, "thread_id") ?? Q(u, "t"), Post() ?? Q(u, "post_id") ?? Q(u, "p"));
    }

    public static string? PostFromAttrs(string attrs)
    {
        var m = Regex.Match(attrs, @"\b(?:id|data-content|data-post-id)=[""'](?:js-)?post-?(\d+)", RegexOptions.IgnoreCase);
        return m.Success ? m.Groups[1].Value : null;
    }

    static string? M(string input, string pattern)
    {
        var m = Regex.Match(input, pattern, RegexOptions.IgnoreCase);
        return m.Success && m.Groups[1].Value.Length > 0 ? m.Groups[1].Value : null;
    }

    static string? Q(Uri u, string key)
    {
        foreach (var part in u.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var kv = part.Split('=', 2);
            if (kv.Length == 2 && kv[0].Equals(key, StringComparison.OrdinalIgnoreCase))
                return Uri.UnescapeDataString(kv[1]);
        }
        return null;
    }
}
