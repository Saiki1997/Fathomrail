using System.Collections.ObjectModel;
using System.Net.Http;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.Styling;
using Avalonia.Threading;
using SimpDownloader.Core;

namespace SimpDownloader.App;

public partial class MainWindow : Window
{
    readonly AppSettings _settings = new();
    readonly ObservableCollection<MediaItem> _items = new();
    readonly HttpClient _http = new(new HttpClientHandler { AllowAutoRedirect = true }) { Timeout = TimeSpan.FromMinutes(2) };
    CancellationTokenSource? _cts;
    bool _paused;
    bool _running;
    string? _lastClip;
    DateTimeOffset _started;

    public MainWindow()
    {
        InitializeComponent();
        GridItems.ItemsSource = _items;
        UrlBox.Text = "https://picsum.photos/v2/list?page=2&limit=12";
        BtnRun.Click += async (_, _) => await RunAsync();
        BtnStop.Click += (_, _) => { _cts?.Cancel(); };
        BtnPause.Click += (_, _) =>
        {
            _paused = !_paused;
            BtnPause.Content = _paused ? "Resume" : "Pause";
            Log(_paused ? "Paused" : "Resumed");
        };
        BtnSettings.Click += async (_, _) =>
        {
            var dlg = new SettingsWindow(_settings);
            await dlg.ShowDialog(this);
            ApplyTheme();
            BtnClip.IsChecked = _settings.ClipboardWatch;
        };
        BtnTheme.IsCheckedChanged += (_, _) =>
        {
            _settings.LightTheme = BtnTheme.IsChecked == true;
            ApplyTheme();
        };
        BtnClip.IsCheckedChanged += (_, _) => _settings.ClipboardWatch = BtnClip.IsChecked == true;
        BtnHashes.Click += (_, _) => ExportHashes();
        var clipTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1200) };
        clipTimer.Tick += async (_, _) => await PollClipboard();
        clipTimer.Start();
        var schedTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(15) };
        schedTimer.Tick += async (_, _) =>
        {
            if (!_settings.SchedulerEnabled || _running || _settings.NextRunAt is not { } next) return;
            if (DateTimeOffset.UtcNow < next) return;
            _settings.NextRunAt = DateTimeOffset.UtcNow.AddMinutes(Math.Max(5, _settings.SchedulerMinutes));
            Log($"Scheduler firing · next {_settings.NextRunAt:t}");
            await RunAsync();
        };
        schedTimer.Start();
        ApplyTheme();
        Log("Idle. Paste a URL and press Run. Only download content you are authorized to access.");
    }

    void ApplyTheme()
    {
        if (Application.Current != null)
            Application.Current.RequestedThemeVariant = _settings.LightTheme ? ThemeVariant.Light : ThemeVariant.Dark;
        BtnTheme.IsChecked = _settings.LightTheme;
    }

    void Log(string msg) => Dispatcher.UIThread.Post(() =>
    {
        LogList.Items.Insert(0, $"{DateTime.Now:HH:mm:ss}  {msg}");
    });

    void SetStage(int idx)
    {
        TextBlock[] rails = [StCrawl, StDiscover, StResolve, StDownload, StFinalize];
        for (var i = 0; i < rails.Length; i++)
            rails[i].Opacity = i == idx ? 1 : i < idx ? 0.85 : 0.45;
        rails[Math.Clamp(idx, 0, rails.Length - 1)].FontWeight = FontWeight.SemiBold;
    }

    async Task WaitPause()
    {
        while (_paused) await Task.Delay(120);
    }

    async Task PollClipboard()
    {
        if (_settings.ClipboardWatch != true || Clipboard == null) return;
        try
        {
            var text = await Clipboard.GetTextAsync();
            if (string.IsNullOrWhiteSpace(text) || text == _lastClip) return;
            _lastClip = text;
            var urls = text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(u => u.StartsWith("http://") || u.StartsWith("https://")).ToList();
            if (urls.Count == 0) return;
            var existing = UrlBox.Text ?? "";
            foreach (var u in urls)
                if (!existing.Contains(u, StringComparison.OrdinalIgnoreCase))
                    existing = string.IsNullOrWhiteSpace(existing) ? u : existing.TrimEnd() + "\n" + u;
            UrlBox.Text = existing;
            Log($"Clipboard: {urls.Count} URL(s)");
            if (_settings.ClipboardAutoRun && !_running) await RunAsync();
        }
        catch { /* clipboard can be empty */ }
    }

    void ExportHashes()
    {
        var rows = _items.Where(i => i.Sha256 != null).Select(i => $"{i.Sha256}  {i.Filename}");
        var path = Path.Combine(_settings.DownloadRoot, "fathomrail-sha256.txt");
        Directory.CreateDirectory(_settings.DownloadRoot);
        File.WriteAllLines(path, rows);
        Log("Wrote " + path);
    }

    async Task RunAsync()
    {
        if (_running) return;
        var urls = (UrlBox.Text ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(u => u.StartsWith("http")).ToList();
        if (urls.Count == 0) { Log("Paste one or more http(s) URLs"); return; }

        _settings.Profile = ProfileBox.SelectedIndex switch { 0 => CrawlProfile.Fast, 2 => CrawlProfile.Deep, _ => CrawlProfile.Balanced };
        _cts?.Cancel();
        _cts = new CancellationTokenSource();
        _paused = false;
        _running = true;
        _started = DateTimeOffset.UtcNow;
        _items.Clear();
        MediaList.Items.Clear();
        BtnRun.IsEnabled = false;
        BtnStop.IsEnabled = true;
        BtnPause.IsEnabled = true;
        var crawl = new CrawlService(_http);
        var dl = new DownloadService(_http);
        var ct = _cts.Token;
        try
        {
            SetStage(0);
            if (string.IsNullOrWhiteSpace(_settings.Cookies))
            {
                try
                {
                    _settings.Cookies = ChromeCookieReader.LoadNetscape();
                    Log("Loaded cookies from Google Chrome");
                }
                catch (Exception ex)
                {
                    Log("Chrome cookies: " + ex.Message);
                }
            }
            Log($"Starting {urls.Count} seed(s) · {_settings.Profile} · save to {_settings.DownloadRoot}");
            var order = 1;
            foreach (var url in urls)
            {
                ct.ThrowIfCancellationRequested();
                await WaitPause();
                Log($"Fetching {url}");
                var result = await crawl.DiscoverAsync(url, _settings, ct);
                SetStage(1);
                PreviewTitle.Text = result.Title ?? result.PageUrl;
                if (result.Warning != null) Log(result.Warning);
                foreach (var item in result.Items)
                {
                    item.OrderIndex = order;
                    if (_settings.NumberFiles) item.Filename = Organize.OrderedName(order, item.Filename);
                    order++;
                    _items.Add(item);
                    MediaList.Items.Add($"{item.OrderIndex:000}  {item.Kind}  {item.Filename}");
                }
                Log($"{result.Items.FirstOrDefault()?.Extractor ?? "generic"} found {result.Items.Count} media on {result.Followed.Count} page(s)");
            }
            if (_items.Count == 0) { Log("Nothing matched"); return; }

            SetStage(2);
            Log($"Resolving {_items.Count} URLs");
            await DownloadService.RunPool(_items.ToList(), _settings.Workers, async item =>
            {
                await WaitPause();
                await crawl.ProbeAsync(item, _settings, ct);
                if (_settings.NumberFiles) item.Filename = Organize.OrderedName(item.OrderIndex, item.Filename);
            }, ct);

            SetStage(3);
            var selected = _items.Where(i => i.Selected).OrderBy(i => i.OrderIndex).ToList();
            var workers = _settings.SequentialDownload ? 1 : _settings.Workers;
            Log(_settings.SequentialDownload
                ? $"Downloading {selected.Count} files in order"
                : $"Downloading {selected.Count} files · {workers} workers");
            var progress = new Progress<MediaItem>(_ => Dispatcher.UIThread.Post(() =>
            {
                var done = _items.Count(i => i.Phase is ItemPhase.Complete or ItemPhase.Skipped);
                HdrStats.Text = $"{done}/{_items.Count} files";
                MonTitle.Text = $"DOWNLOAD MONITOR  {done}/{_items.Count}";
            }));
            await DownloadService.RunPool(selected, workers, async item =>
            {
                await WaitPause();
                await dl.DownloadAsync(item, _settings, progress, ct);
                Log(item.Phase == ItemPhase.Complete ? $"Saved {item.Filename} · {(item.Sha256 ?? "")[..Math.Min(8, item.Sha256?.Length ?? 0)]}"
                    : item.Phase == ItemPhase.Skipped ? $"Skipped {item.Filename}"
                    : $"{item.Filename}: {item.Error}");
            }, ct);

            SetStage(4);
            var ok = _items.Count(i => i.Phase == ItemPhase.Complete);
            Log($"Verified {ok} file(s) in {_settings.DownloadRoot}");
            if (!string.IsNullOrWhiteSpace(_settings.WebhookUrl))
            {
                var (okHook, err) = await WebhookClient.PostAsync(_settings.WebhookUrl, WebhookClient.JobPayload("complete", urls[0], _started, _items), ct);
                Log(okHook ? "Webhook sent" : "Webhook: " + err);
            }
            if (_settings.SchedulerEnabled)
            {
                _settings.NextRunAt = DateTimeOffset.UtcNow.AddMinutes(Math.Max(5, _settings.SchedulerMinutes));
                Log($"Next scheduled run {_settings.NextRunAt:t}");
            }
        }
        catch (OperationCanceledException)
        {
            Log("Stopped by user");
        }
        catch (Exception ex)
        {
            Log(ex.Message);
        }
        finally
        {
            _running = false;
            BtnRun.IsEnabled = true;
            BtnStop.IsEnabled = false;
            BtnPause.IsEnabled = false;
        }
    }
}
