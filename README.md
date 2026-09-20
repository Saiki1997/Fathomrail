# Fathomrail

Five-stage gallery downloader: **crawl → discover → resolve → download → verify**.

Python 3 app for Windows. Built-in HTML/JSON/XenForo discovery, plus [yt-dlp](https://github.com/yt-dlp/yt-dlp) (bundled) and [gallery-dl](https://github.com/mikf/gallery-dl) if you have it on PATH.

## Windows x64

From [Releases v2.0.0](https://github.com/Saiki1997/Fathomrail/releases/tag/v2.0.0):

| File | Notes |
| --- | --- |
| `Fathomrail-Setup.exe` | Setup wizard — pick install folder, desktop + Start Menu shortcuts |
| `Fathomrail-Portable.zip` | Extract and double-click `Fathomrail.exe` — no install, no registry |

Requires nothing extra (embedded Python). Chrome cookie import works on Windows.

## How to use

1. Open Fathomrail (`Fathomrail.exe`).
2. Paste a gallery / thread / media URL (or click **Sample stills**).
3. If the site needs a login: **Settings → Load from Google Chrome**, or paste a `cookies.txt`.
4. Pick **Fast / Balanced / Deep**, then **Run**.
5. Watch the stage rail and download monitor. Files save under the folder in Settings (numbered, optional forum/post folders).

![How to use](docs/how-to.gif)

## Pipeline

| Stage | What it does |
| --- | --- |
| Crawl | Fetches the page with cookies, referer, 429 backoff |
| Discover | JSON-LD, Open Graph, srcset, XenForo attachments, yt-dlp, gallery-dl |
| Resolve | HEAD / wrapper-page hop, Content-Disposition names |
| Download | Ordered filenames, per-host rate limit, optional bandwidth cap |
| Verify | SHA-256, skip known hashes, optional finish webhook |

## Requirements

- Windows 10/11 x64 for the desktop build
- Or Python 3.10+ (`pip install -r requirements.txt && python -m fathomrail`)
- Optional: `gallery-dl` on PATH for extra gallery hosts
- Only download content you are authorized to access
