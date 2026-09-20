# Fathomrail desktop (C#)

Avalonia / .NET 8 companion to the Fathomrail web app: same five-stage pipeline, live monitor, Chrome cookie import, folder picker, forum/post organization.

```
dotnet publish src/SimpDownloader.App/SimpDownloader.App.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:EnableWindowsTargeting=true -o dist/portable
```

- **Portable ZIP** — `Fathomrail.exe` + README. Extract and run.
- **Setup wizard** — `Fathomrail-Setup.exe` embeds the portable zip. Choose install directory, desktop + Start Menu shortcuts.

Published Windows builds: https://github.com/Saiki1997/Fathomrail/releases
