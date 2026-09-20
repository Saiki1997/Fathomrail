using Avalonia.Controls;
using Avalonia.Platform.Storage;
using SimpDownloader.Core;

namespace SimpDownloader.App;

public partial class SettingsWindow : Window
{
    public SettingsWindow(AppSettings settings)
    {
        InitializeComponent();
        FolderBox.Text = settings.FolderName;
        RootBox.Text = settings.DownloadRoot;
        WorkersBox.Value = settings.Workers;
        RetriesBox.Value = settings.Retries;
        MaxBox.Value = settings.MaxFileMb;
        ImgBox.IsChecked = settings.IncludeImages;
        VidBox.IsChecked = settings.IncludeVideos;
        AudBox.IsChecked = settings.IncludeAudio;
        DupBox.IsChecked = settings.SkipDuplicates;
        CookieBox.Text = settings.Cookies;
        NumberBox.IsChecked = settings.NumberFiles;
        SeqBox.IsChecked = settings.SequentialDownload;
        OrganizeBox.SelectedIndex = settings.OrganizeBy switch
        {
            OrganizeBy.Post => 1,
            OrganizeBy.Forum => 2,
            OrganizeBy.ForumPost => 3,
            _ => 0,
        };

        BtnBrowse.Click += async (_, _) =>
        {
            var folders = await StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions
            {
                Title = "Download location",
                AllowMultiple = false,
            });
            var path = folders.Count > 0 ? folders[0].TryGetLocalPath() : null;
            if (!string.IsNullOrWhiteSpace(path)) RootBox.Text = path;
        };
        BtnChrome.Click += (_, _) =>
        {
            try
            {
                CookieBox.Text = ChromeCookieReader.LoadNetscape();
            }
            catch (Exception ex)
            {
                CookieBox.Text = "# " + ex.Message + "\n" + (CookieBox.Text ?? "");
            }
        };
        BtnOk.Click += (_, _) =>
        {
            settings.FolderName = FolderBox.Text ?? settings.FolderName;
            settings.DownloadRoot = RootBox.Text ?? settings.DownloadRoot;
            settings.Workers = (int)(WorkersBox.Value ?? 4);
            settings.Retries = (int)(RetriesBox.Value ?? 2);
            settings.MaxFileMb = (int)(MaxBox.Value ?? 80);
            settings.IncludeImages = ImgBox.IsChecked == true;
            settings.IncludeVideos = VidBox.IsChecked == true;
            settings.IncludeAudio = AudBox.IsChecked == true;
            settings.SkipDuplicates = DupBox.IsChecked == true;
            settings.Cookies = CookieBox.Text ?? "";
            settings.NumberFiles = NumberBox.IsChecked == true;
            settings.SequentialDownload = SeqBox.IsChecked == true;
            settings.OrganizeBy = OrganizeBox.SelectedIndex switch
            {
                1 => OrganizeBy.Post,
                2 => OrganizeBy.Forum,
                3 => OrganizeBy.ForumPost,
                _ => OrganizeBy.Flat,
            };
            Close();
        };
    }
}
