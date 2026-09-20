using System.Text.RegularExpressions;

namespace SimpDownloader.Core;

public static class Canonical
{
    static readonly HashSet<string> Tracking = new(StringComparer.OrdinalIgnoreCase)
    {
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "ref", "referrer"
    };

    public static string DecodeEntities(string s) => s
        .Replace("\u0026amp;", "&")
        .Replace("\u0026quot;", "\"")
        .Replace("\u0026#39;", "'")
        .Replace("\u0026apos;", "'")
        .Replace("\u0026lt;", "<")
        .Replace("\u0026gt;", ">");

    public static string? Abs(string raw, string baseUrl)
    {
        raw = DecodeEntities(raw.Trim());
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var b)) return null;
        if (!Uri.TryCreate(b, raw, out var u)) return null;
        if (u.Scheme is not ("http" or "https")) return null;
        return u.GetLeftPart(UriPartial.Query);
    }

    public static Dictionary<string, string> Query(Uri u)
    {
        var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var part in u.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var kv = part.Split('=', 2);
            d[Uri.UnescapeDataString(kv[0])] = kv.Length > 1 ? Uri.UnescapeDataString(kv[1]) : "";
        }
        return d;
    }

    public static string Canonicalize(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return url;
        var q = Query(u);
        foreach (var key in q.Keys.Where(Tracking.Contains).ToList()) q.Remove(key);
        var qs = string.Join("&", q.Select(kv => Uri.EscapeDataString(kv.Key) + "=" + Uri.EscapeDataString(kv.Value)));
        var path = u.AbsolutePath.Length > 1 ? u.AbsolutePath.TrimEnd('/') : u.AbsolutePath;
        var b = new UriBuilder(u) { Fragment = "", Host = u.Host.ToLowerInvariant(), Path = path, Query = qs };
        return b.Uri.ToString();
    }

    public static bool IsThumb(string url)
    {
        var path = url.Split('?')[0].ToLowerInvariant();
        return Regex.IsMatch(path, @"(?:^|[/_-])(thumb|thumbnail|thumbs|preview|small|icon|mini|tiny)(?:[/_-]|$)")
            || Regex.IsMatch(path, @"-\d{2,3}x\d{2,3}(?:\.\w+)?$");
    }

    public static string UpgradeOriginal(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return url;
        var path = Regex.Replace(u.AbsolutePath, @"/thumbs?/", "/", RegexOptions.IgnoreCase);
        path = Regex.Replace(path, @"/previews?/", "/", RegexOptions.IgnoreCase);
        path = Regex.Replace(path, @"[-_](?:thumb|small|preview|150x150|300x300)", "", RegexOptions.IgnoreCase);
        return new UriBuilder(u) { Path = path }.Uri.ToString();
    }

    public static string MediaKey(string url)
    {
        try
        {
            var u = new Uri(Canonicalize(url));
            var parts = u.AbsolutePath.Trim('/').ToLowerInvariant().Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) return u.Host;
            var last = parts[^1];
            if (Regex.IsMatch(last, @"\.[a-z0-9]{2,5}$"))
            {
                var stem = Regex.Replace(Path.GetFileNameWithoutExtension(last), @"[-_](?:thumb|small|preview|\d{2,4}x\d{2,4})$", "", RegexOptions.IgnoreCase);
                return u.Host + "/" + stem;
            }
            if (parts.Length >= 3 && parts[^1].All(char.IsDigit) && parts[^2].All(char.IsDigit))
                return u.Host + "/" + string.Join("/", parts.Take(parts.Length - 2));
            return u.Host + "/" + string.Join("/", parts);
        }
        catch { return url; }
    }

    public static bool LooksLikeAlbum(string url) =>
        Regex.IsMatch(url, @"/(a|album|albums|gallery|galleries|g|post|posts|thread|threads|view|v|f|file|attachments?)/[^/?#]+", RegexOptions.IgnoreCase);

    public static bool LooksLikePagination(string url) =>
        Regex.IsMatch(url, @"[?&]page=\d+", RegexOptions.IgnoreCase)
        || Regex.IsMatch(url, @"/page-\d+", RegexOptions.IgnoreCase)
        || Regex.IsMatch(url, @"[?&]p=\d+", RegexOptions.IgnoreCase);

    public static string? InferredNextPage(string current)
    {
        if (!Uri.TryCreate(current, UriKind.Absolute, out var u)) return null;
        var q = Query(u);
        foreach (var key in new[] { "page", "p" })
        {
            if (q.TryGetValue(key, out var vs) && int.TryParse(vs, out var n))
            {
                q[key] = (n + 1).ToString();
                var qs = string.Join("&", q.Select(kv => Uri.EscapeDataString(kv.Key) + "=" + Uri.EscapeDataString(kv.Value)));
                return new UriBuilder(u) { Query = qs }.Uri.ToString();
            }
        }
        var m = Regex.Match(u.AbsolutePath, @"/page-(\d+)/?$", RegexOptions.IgnoreCase);
        if (m.Success)
            return new UriBuilder(u) { Path = Regex.Replace(u.AbsolutePath, @"page-\d+", "page-" + (int.Parse(m.Groups[1].Value) + 1), RegexOptions.IgnoreCase) }.Uri.ToString();
        if (Regex.IsMatch(u.AbsolutePath, @"/threads/[^/]+/?$", RegexOptions.IgnoreCase))
            return new UriBuilder(u) { Path = u.AbsolutePath.TrimEnd('/') + "/page-2" }.Uri.ToString();
        return null;
    }

    public static string? BestSrcset(string srcset)
    {
        string best = "";
        var score = -1.0;
        foreach (var part in srcset.Split(','))
        {
            var bits = part.Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (bits.Length == 0) continue;
            var d = bits.Length > 1 ? bits[1] : "1x";
            double n = 1;
            if (d.EndsWith("w") && double.TryParse(d.TrimEnd('w'), out var w)) n = w;
            else if (d.EndsWith("x") && double.TryParse(d.TrimEnd('x'), out var x)) n = x * 1000;
            if (n >= score) { score = n; best = bits[0]; }
        }
        return string.IsNullOrEmpty(best) ? null : best;
    }
}
