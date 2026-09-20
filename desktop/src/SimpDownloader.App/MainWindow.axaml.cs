using System.Collections.ObjectModel;
using System.Net.Http;
using Avalonia.Controls;
using Avalonia.Media;
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
        };
        Log("Idle. Paste a URL and press Run. Only download content you are authorized to access.");
    }

    void Log(string msg) => Dispatcher.UIThread.Post(() =>
    {
        LogList.Items.Insert(0, $"{DateTime.Now:HH:mm:ss}  {msg}");
    });

    void SetStage(int idx)
    {
        TextBlock[] rails = [StCrawl, StDiscover, StResolve, StDownload, StFinalize];
        for (var i = 0; i < rails.Length; i++)
            rails[i].Foreground = new SolidColorBrush(i == idx ? Color.Parse("#F3F3F4") : i < idx ? Color.Parse("#7DBA98") : Color.Parse("#6D6D75"));
    }

    async Task WaitPause()
    {
        while (_paused) await Task.Delay(120);
    }

    async Task RunAsync()
    {
        var urls = (UrlBox.Text ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(u => u.StartsWith("http")).ToList();
        if (urls.Count == 0) { Log("Paste one or more http(s) URLs"); return; }

        _settings.Profile = ProfileBox.SelectedIndex switch { 0 => CrawlProfile.Fast, 2 => CrawlProfile.Deep, _ => CrawlProfile.Balanced };
        _cts?.Cancel();
        _cts = new CancellationTokenSource();
        _paused = false;
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
                Log($"Found {result.Items.Count} media on {result.Followed.Count} page(s) · keeping page order");
            }
            if (_items.Count == 0) { Log("Nothing matched"); return; }

            SetStage(2);
            Log($"Resolving {_items.Count} URLs");
            await DownloadService.RunPool(_items.ToList(), _settings.Workers, async item =>
            {
                await WaitPause();
                await crawl.ProbeAsync(item, _settings, ct);
                if (_settings.NumberFiles) item.Filename = Organize.OrderedName(item.OrderIndex, item.Filename);
                Dispatcher.UIThread.Post(() => GridItems.ItemsSource = null);
                Dispatcher.UIThread.Post(() => GridItems.ItemsSource = _items);
            }, ct);

            SetStage(3);
            var selected = _items.Where(i => i.Selected).OrderBy(i => i.OrderIndex).ToList();
            var workers = _settings.SequentialDownload ? 1 : _settings.Workers;
            Log(_settings.SequentialDownload
                ? $"Downloading {selected.Count} files in order"
                : $"Downloading {selected.Count} files · {workers} workers");
            var progress = new Progress<MediaItem>(_ => Dispatcher.UIThread.Post(() =>
            {
                HdrStats.Text = $"{_items.Count(i => i.Phase == ItemPhase.Complete)}/{_items.Count} files";
            }));
            await DownloadService.RunPool(selected, workers, async item =>
            {
                await WaitPause();
                await dl.DownloadAsync(item, _settings, progress, ct);
                Log(item.Phase == ItemPhase.Complete ? $"Saved {item.Filename}" : $"{item.Filename}: {item.Error}");
            }, ct);

            SetStage(4);
            var done = _items.Count(i => i.Phase == ItemPhase.Complete);
            Log($"Verified {done} file(s) in {_settings.DownloadRoot}");
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
            BtnRun.IsEnabled = true;
            BtnStop.IsEnabled = false;
            BtnPause.IsEnabled = false;
        }
    }
}
