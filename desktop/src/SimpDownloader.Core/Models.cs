using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace SimpDownloader.Core;

public enum CrawlProfile { Fast, Balanced, Deep }
public enum MediaKind { Image, Video, Audio, Other }
public enum ItemPhase { Queued, Resolving, Fetching, Verifying, Complete, Failed, Skipped }
public enum OrganizeBy { Flat, Post, Forum, ForumPost }

public sealed class AppSettings
{
    public CrawlProfile Profile { get; set; } = CrawlProfile.Balanced;
    public int Workers { get; set; } = 4;
    public int Retries { get; set; } = 2;
    public int RetryDelayMs { get; set; } = 800;
    public string FolderName { get; set; } = "Fathomrail";
    public string Cookies { get; set; } = "";
    public bool IncludeImages { get; set; } = true;
    public bool IncludeVideos { get; set; } = true;
    public bool IncludeAudio { get; set; } = true;
    public bool SkipDuplicates { get; set; } = true;
    public int MaxFileMb { get; set; } = 80;
    public string DownloadRoot { get; set; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.MyPictures), "Fathomrail");
    public OrganizeBy OrganizeBy { get; set; } = OrganizeBy.ForumPost;
    public bool NumberFiles { get; set; } = true;
    public bool SequentialDownload { get; set; } = true;
    public string ChromeProfile { get; set; } = "Default";
    public bool LightTheme { get; set; }
    public bool ClipboardWatch { get; set; }
    public bool ClipboardAutoRun { get; set; }
    public int BandwidthKbps { get; set; }
    public int HostGapMs { get; set; } = 250;
    public int HostMaxConcurrent { get; set; } = 2;
    public bool VerifyHash { get; set; } = true;
    public bool SkipKnownHashes { get; set; } = true;
    public string WebhookUrl { get; set; } = "";
    public bool SchedulerEnabled { get; set; }
    public int SchedulerMinutes { get; set; } = 60;
    public DateTimeOffset? NextRunAt { get; set; }
}

public sealed class MediaItem : INotifyPropertyChanged
{
    string _filename = "file.bin";
    ItemPhase _phase = ItemPhase.Queued;
    long _bytesDone;
    long? _bytesTotal;
    string? _error;
    double _speedBps;
    string? _sha256;
    string _url = "";

    public string Id { get; init; } = Guid.NewGuid().ToString("n");
    public string Url { get => _url; set { _url = value; OnChanged(); } }
    public string SourcePage { get; set; } = "";
    public string Filename { get => _filename; set { _filename = value; OnChanged(); } }
    public MediaKind Kind { get; set; }
    public string? Mime { get; set; }
    public long? BytesTotal { get => _bytesTotal; set { _bytesTotal = value; OnChanged(); } }
    public long BytesDone { get => _bytesDone; set { _bytesDone = value; OnChanged(); } }
    public ItemPhase Phase { get => _phase; set { _phase = value; OnChanged(); } }
    public bool Selected { get; set; } = true;
    public string? Error { get => _error; set { _error = value; OnChanged(); } }
    public double SpeedBps { get => _speedBps; set { _speedBps = value; OnChanged(); } }
    public int OrderIndex { get; set; }
    public string? ForumId { get; set; }
    public string? PostId { get; set; }
    public string? ThreadId { get; set; }
    public string Extractor { get; set; } = "generic";
    public string? ResolvedUrl { get; set; }
    public string? Sha256 { get => _sha256; set { _sha256 = value; OnChanged(); } }

    public event PropertyChangedEventHandler? PropertyChanged;
    void OnChanged([CallerMemberName] string? n = null) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(n));
}

public sealed class DiscoverResult
{
    public string PageUrl { get; init; } = "";
    public string? Title { get; init; }
    public List<MediaItem> Items { get; init; } = new();
    public List<string> Followed { get; init; } = new();
    public string? Warning { get; init; }
}

public static class ProfileMeta
{
    public static (int Pages, int TimeoutMs, int MaxItems) For(CrawlProfile p) => p switch
    {
        CrawlProfile.Fast => (1, 8000, 40),
        CrawlProfile.Deep => (6, 20000, 240),
        _ => (3, 14000, 120),
    };
}

public static class Organize
{
    public static string Dir(AppSettings s, MediaItem item)
    {
        var root = Path.Combine(s.DownloadRoot, MediaExtractor.Sanitize(s.FolderName));
        var forum = item.ForumId is { Length: > 0 } ? "forum_" + MediaExtractor.Sanitize(item.ForumId) : "forum_unknown";
        var post = item.PostId is { Length: > 0 }
            ? "post_" + MediaExtractor.Sanitize(item.PostId)
            : item.ThreadId is { Length: > 0 } ? "thread_" + MediaExtractor.Sanitize(item.ThreadId) : "post_unknown";
        return s.OrganizeBy switch
        {
            OrganizeBy.Forum => Path.Combine(root, forum),
            OrganizeBy.Post => Path.Combine(root, post),
            OrganizeBy.ForumPost => Path.Combine(root, forum, post),
            _ => root,
        };
    }

    public static string OrderedName(int index, string name)
    {
        var baseName = MediaExtractor.Sanitize(System.Text.RegularExpressions.Regex.Replace(name, @"^\d{3,4}_", ""));
        return $"{index:000}_{baseName}";
    }
}
