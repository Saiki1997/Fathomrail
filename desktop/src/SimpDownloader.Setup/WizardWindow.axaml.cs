using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;

namespace SimpDownloader.Setup;

public partial class WizardWindow : Window
{
    int _step;
    string _dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Fathomrail");
    bool _desktop = true;
    bool _startMenu = true;
    TextBox? _dirBox;
    CheckBox? _deskBox;
    CheckBox? _menuBox;
    TextBlock? _status;

    public WizardWindow()
    {
        InitializeComponent();
        BtnCancel.Click += (_, _) => Close();
        BtnBack.Click += (_, _) => { _step = Math.Max(0, _step - 1); Render(); };
        BtnNext.Click += async (_, _) => await Next();
        Render();
    }

    async Task Next()
    {
        if (_step == 1)
        {
            _dir = _dirBox?.Text?.Trim() ?? _dir;
            _desktop = _deskBox?.IsChecked == true;
            _startMenu = _menuBox?.IsChecked == true;
        }
        if (_step == 2)
        {
            await Install();
            return;
        }
        if (_step >= 3) { Close(); return; }
        _step++;
        Render();
    }

    void Render()
    {
        BtnBack.IsEnabled = _step > 0 && _step < 3;
        BtnNext.Content = _step switch { 2 => "Install", 3 => "Finish", _ => "Next" };
        Host.Children.Clear();
        Host.Children.Add(_step switch
        {
            0 => Welcome(),
            1 => Options(),
            2 => Ready(),
            _ => Done()
        });
    }

    Control Welcome() => Col(
        Title("Fathomrail Setup"),
        Body("This wizard installs Fathomrail 1.2 — the same app as the live preview, in a desktop window."),
        Body("You can choose the install folder and whether to create Desktop and Start Menu shortcuts."));

    Control Options()
    {
        _dirBox = new TextBox { Text = _dir };
        _deskBox = new CheckBox { Content = "Create a desktop shortcut", IsChecked = _desktop, Margin = new Thickness(0, 12, 0, 4) };
        _menuBox = new CheckBox { Content = "Create a Start Menu shortcut", IsChecked = _startMenu };
        return Col(Title("Install location"), Body("Folder:"), _dirBox, _deskBox, _menuBox);
    }

    Control Ready()
    {
        _status = Body("Ready to install.");
        return Col(Title("Ready"), Body($"Folder: {_dir}"), Body($"Desktop shortcut: {(_desktop ? "yes" : "no")}"), Body($"Start Menu shortcut: {(_startMenu ? "yes" : "no")}"), _status);
    }

    Control Done() => Col(
        Title("Completed"),
        Body("Fathomrail is installed. Use Finish to close the wizard, then run Fathomrail.exe from the install folder or a shortcut."));

    static TextBlock Title(string t) => new() { Text = t, FontSize = 22, FontWeight = FontWeight.Medium, Margin = new Thickness(0, 0, 0, 12) };
    static TextBlock Body(string t) => new() { Text = t, TextWrapping = TextWrapping.Wrap, Foreground = new SolidColorBrush(Color.Parse("#9A9AA3")), Margin = new Thickness(0, 0, 0, 8) };
    static StackPanel Col(params Control[] c)
    {
        var p = new StackPanel { Spacing = 4 };
        foreach (var x in c) p.Children.Add(x);
        return p;
    }

    async Task Install()
    {
        BtnNext.IsEnabled = false;
        BtnBack.IsEnabled = false;
        try
        {
            Directory.CreateDirectory(_dir);
            var asm = Assembly.GetExecutingAssembly();
            await using var stream = asm.GetManifestResourceStream("payload.zip")
                ?? throw new InvalidOperationException("Installer payload is missing.");
            using var zip = new ZipArchive(stream, ZipArchiveMode.Read);
            foreach (var entry in zip.Entries)
            {
                if (string.IsNullOrEmpty(entry.Name)) continue;
                var dest = Path.Combine(_dir, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                entry.ExtractToFile(dest, true);
            }
            var exe = Path.Combine(_dir, "Fathomrail.exe");
            if (_desktop) TryShortcut(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), exe);
            if (_startMenu)
            {
                var sm = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Fathomrail");
                Directory.CreateDirectory(sm);
                TryShortcut(sm, exe);
            }
            WriteUninstall();
            if (_status != null) _status.Text = "Files copied.";
            _step = 3;
            Render();
        }
        catch (Exception ex)
        {
            if (_status != null) _status.Text = ex.Message;
        }
        finally
        {
            BtnNext.IsEnabled = true;
        }
    }

    void WriteUninstall()
    {
        var bat = Path.Combine(_dir, "Uninstall.bat");
        File.WriteAllText(bat, $"""
            @echo off
            echo Removing Fathomrail...
            rmdir /s /q "{_dir}"
            del "%USERPROFILE%\Desktop\Fathomrail.lnk" 2>nul
            rmdir /s /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Fathomrail" 2>nul
            """);
    }

    static void TryShortcut(string folder, string target)
    {
        try
        {
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                File.WriteAllText(Path.Combine(folder, "Fathomrail.url"), $"[InternetShortcut]\r\nURL=file:///{target.Replace("\\", "/")}\r\n");
                return;
            }
            var t = Type.GetTypeFromProgID("WScript.Shell");
            if (t == null) return;
            dynamic shell = Activator.CreateInstance(t)!;
            var link = shell.CreateShortcut(Path.Combine(folder, "Fathomrail.lnk"));
            link.TargetPath = target;
            link.WorkingDirectory = Path.GetDirectoryName(target);
            link.Description = "Fathomrail";
            link.Save();
        }
        catch
        {
            File.WriteAllText(Path.Combine(folder, "Fathomrail.url"), $"[InternetShortcut]\r\nURL=file:///{target.Replace("\\", "/")}\r\n");
        }
    }
}
