using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace SimpDownloader.Core;

public static class ChromeCookieReader
{
    public static string LoadNetscape(string? hostFilter = null, string profile = "Default")
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            throw new InvalidOperationException("Direct Chrome import is available on Windows. Use a cookies.txt export elsewhere.");

        var userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "User Data");
        var localState = Path.Combine(userData, "Local State");
        if (!File.Exists(localState))
            throw new InvalidOperationException("Chrome user data was not found. Is Google Chrome installed?");

        var key = UnwrapKey(localState);
        var cookieDb = Path.Combine(userData, profile, "Network", "Cookies");
        if (!File.Exists(cookieDb)) cookieDb = Path.Combine(userData, profile, "Cookies");
        if (!File.Exists(cookieDb))
            throw new InvalidOperationException($"No Chrome cookies database for profile '{profile}'.");

        var tmp = Path.Combine(Path.GetTempPath(), "simp-chrome-cookies-" + Guid.NewGuid().ToString("n") + ".db");
        File.Copy(cookieDb, tmp, true);
        try
        {
            var lines = new List<string> { "# Netscape HTTP Cookie File", "# Imported from Google Chrome" };
            using var conn = new SqliteConnection($"Data Source={tmp};Mode=ReadOnly");
            conn.Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT host_key, path, is_secure, expires_utc, name, encrypted_value FROM cookies";
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                var host = r.GetString(0);
                if (!string.IsNullOrEmpty(hostFilter))
                {
                    var h = hostFilter.ToLowerInvariant();
                    var d = host.TrimStart('.').ToLowerInvariant();
                    if (h != d && !h.EndsWith("." + d) && !d.EndsWith(h)) continue;
                }
                var value = Decrypt(key, (byte[])r["encrypted_value"]);
                if (string.IsNullOrEmpty(value)) continue;
                var secure = r.GetInt32(2) != 0 ? "TRUE" : "FALSE";
                var expires = r.GetInt64(3);
                var unix = expires > 0 ? Math.Max(0, (expires / 1_000_000) - 11644473600) : 0;
                lines.Add(string.Join('\t', host, "TRUE", r.GetString(1), secure, unix.ToString(), r.GetString(4), value));
            }
            if (lines.Count <= 2) throw new InvalidOperationException("No cookies matched. Close Chrome and try again, or pick another profile.");
            return string.Join('\n', lines);
        }
        finally
        {
            try { File.Delete(tmp); } catch { /* ignore */ }
        }
    }

    static byte[] UnwrapKey(string localStatePath)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(localStatePath));
        var b64 = doc.RootElement.GetProperty("os_crypt").GetProperty("encrypted_key").GetString()
            ?? throw new InvalidOperationException("Chrome Local State is missing os_crypt.encrypted_key");
        var raw = Convert.FromBase64String(b64);
        // prefix "DPAPI"
        var blob = raw.AsSpan(5).ToArray();
        return ProtectedData.Unprotect(blob, null, DataProtectionScope.CurrentUser);
    }

    static string Decrypt(byte[] key, byte[] encrypted)
    {
        if (encrypted.Length == 0) return "";
        if (encrypted.Length > 3 && encrypted[0] == (byte)'v' && encrypted[1] == (byte)'1')
        {
            var nonce = encrypted.AsSpan(3, 12);
            var cipher = encrypted.AsSpan(15, encrypted.Length - 15 - 16);
            var tag = encrypted.AsSpan(encrypted.Length - 16, 16);
            var plain = new byte[cipher.Length];
            using var aes = new AesGcm(key, 16);
            aes.Decrypt(nonce, cipher, tag, plain);
            return Encoding.UTF8.GetString(plain);
        }
        try
        {
            return Encoding.UTF8.GetString(ProtectedData.Unprotect(encrypted, null, DataProtectionScope.CurrentUser));
        }
        catch
        {
            return "";
        }
    }
}
