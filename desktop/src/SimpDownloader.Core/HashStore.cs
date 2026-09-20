using System.Text.Json;

namespace SimpDownloader.Core;

public static class HashStore
{
    static readonly object Gate = new();
    static HashSet<string>? _set;

    static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Fathomrail", "hashes.json");

    static HashSet<string> Load()
    {
        if (_set != null) return _set;
        try
        {
            var json = File.ReadAllText(FilePath);
            _set = JsonSerializer.Deserialize<HashSet<string>>(json) ?? new(StringComparer.OrdinalIgnoreCase);
        }
        catch
        {
            _set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        }
        return _set;
    }

    public static bool Contains(string hex)
    {
        lock (Gate) return Load().Contains(hex);
    }

    public static void Remember(string hex)
    {
        lock (Gate)
        {
            var set = Load();
            if (!set.Add(hex)) return;
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(set));
        }
    }

    public static void Clear()
    {
        lock (Gate)
        {
            _set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try { File.Delete(FilePath); } catch { /* ignore */ }
        }
    }
}
