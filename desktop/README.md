# Fathomrail desktop

The shipping Windows build is **Electron** wrapping the same UI as the live preview (`electron/`).

```
npm run build
npx electron-builder --win zip --x64
```

Portable zip: extract and run `Fathomrail.exe`.
Setup wizard: `desktop/src/SimpDownloader.Setup` embeds that zip.

The older Avalonia C# project in this folder is a fallback, not the product UI.
