namespace SimpDownloader.Core;

public static class CookieJar
{
    public static string? HeaderFor(string raw, string targetUrl)
    {
        var text = raw.Trim();
        if (text.Length == 0) return null;
        if (!Uri.TryCreate(targetUrl, UriKind.Absolute, out var url)) return null;
        var host = url.Host.ToLowerInvariant();
        var path = string.IsNullOrEmpty(url.AbsolutePath) ? "/" : url.AbsolutePath;
        if (!text.Contains('\t') && !text.StartsWith('#'))
            return text.Replace('\n', ';');

        var pairs = new List<string>();
        foreach (var line in text.Split('\n'))
        {
            var t = line.TrimEnd('\r');
            if (t.Length == 0 || t.StartsWith('#')) continue;
            var cols = t.Split('\t');
            if (cols.Length < 7) continue;
            var domain = cols[0].TrimStart('.').ToLowerInvariant();
            var cookiePath = string.IsNullOrEmpty(cols[2]) ? "/" : cols[2];
            var name = cols[5];
            var value = cols[6];
            if (string.IsNullOrEmpty(name)) continue;
            if (domain.Length > 0 && host != domain && !host.EndsWith("." + domain)) continue;
            if (!path.StartsWith(cookiePath, StringComparison.Ordinal)) continue;
            pairs.Add($"{name}={value}");
        }
        return pairs.Count == 0 ? null : string.Join("; ", pairs);
    }
}
