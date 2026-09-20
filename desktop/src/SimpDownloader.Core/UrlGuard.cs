using System.Net;

namespace SimpDownloader.Core;

public static class UrlGuard
{
    public static Uri AssertPublicHttpUrl(string raw)
    {
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var url))
            throw new InvalidOperationException("Invalid URL");
        if (url.Scheme is not ("http" or "https"))
            throw new InvalidOperationException("Only http(s) URLs are allowed");
        var host = url.Host.ToLowerInvariant();
        if (host is "localhost" or "127.0.0.1" or "0.0.0.0" or "::1" ||
            host.EndsWith(".local") || host.EndsWith(".internal"))
            throw new InvalidOperationException("That host is not allowed");
        if (IPAddress.TryParse(host, out var ip) && IsPrivate(ip))
            throw new InvalidOperationException("Private or local addresses are not allowed");
        return url;
    }

    static bool IsPrivate(IPAddress ip)
    {
        if (IPAddress.IsLoopback(ip)) return true;
        var b = ip.GetAddressBytes();
        if (b.Length != 4) return true;
        return b[0] == 10 || b[0] == 127 || b[0] == 0
            || (b[0] == 192 && b[1] == 168)
            || (b[0] == 169 && b[1] == 254)
            || (b[0] == 172 && b[1] >= 16 && b[1] <= 31);
    }
}
