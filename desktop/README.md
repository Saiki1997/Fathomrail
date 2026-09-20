# Fathomrail desktop (C#)

Avalonia / .NET 8 companion to the Fathomrail web app: same five-stage pipeline, live monitor, Chrome cookie import, folder picker, forum/post organization.

```
dotnet publish src/SimpDownloader.App/SimpDownloader.App.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o dist/portable
```

Portable ZIP is `dist/portable`. The setup wizard project embeds that payload as a single Setup EXE.
