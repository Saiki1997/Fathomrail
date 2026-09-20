from __future__ import annotations

import asyncio
import io
import json
import os
import sys
import time
import zipfile
from pathlib import Path

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import APP_NAME, APP_VERSION
from .cookies import load_chrome_netscape
from .pipeline import Pipeline, SAMPLE

STATIC = Path(__file__).parent / "static"
DATA = Path(os.environ.get("FATHOMRAIL_HOME") or (Path.home() / ".fathomrail"))
DATA.mkdir(parents=True, exist_ok=True)
SETTINGS_PATH = DATA / "settings.json"
DOWNLOADS = Path(os.environ.get("FATHOMRAIL_DOWNLOADS") or (DATA / "downloads"))
DOWNLOADS.mkdir(parents=True, exist_ok=True)

DEFAULTS = {
    "profile": "balanced",
    "workers": 4,
    "retries": 2,
    "retryDelayMs": 800,
    "folderName": "Fathomrail",
    "cookies": "",
    "includeImages": True,
    "includeVideos": True,
    "includeAudio": True,
    "skipDuplicates": True,
    "maxFileMb": 80,
    "downloadRoot": str(DOWNLOADS),
    "organizeBy": "forumPost",
    "numberFiles": True,
    "sequentialDownload": True,
    "theme": "dark",
    "clipboardWatch": False,
    "clipboardAutoRun": False,
    "bandwidthKbps": 0,
    "hostGapMs": 250,
    "hostMaxConcurrent": 2,
    "verifyHash": True,
    "skipKnownHashes": True,
    "webhookUrl": "",
    "schedulerEnabled": False,
    "schedulerMinutes": 60,
}


def load_settings() -> dict:
    try:
        data = json.loads(SETTINGS_PATH.read_text())
        return {**DEFAULTS, **data}
    except Exception:
        return dict(DEFAULTS)


def save_settings(s: dict) -> None:
    SETTINGS_PATH.write_text(json.dumps(s, indent=2))


class Hub:
    def __init__(self):
        self.listeners: list[asyncio.Queue] = []
        self.job: Pipeline | None = None
        self.task: asyncio.Task | None = None
        self.settings = load_settings()
        self.title = "Ready when you are"
        self.logs: list[str] = []

    async def emit(self, event: dict):
        if event.get("type") == "log":
            line = f"{time.strftime('%H:%M:%S')}  {event.get('msg','')}"
            self.logs.insert(0, line)
            self.logs = self.logs[:200]
            event = {**event, "line": line}
        if event.get("type") == "title":
            self.title = event.get("msg") or self.title
        dead = []
        for q in self.listeners:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            self.listeners.remove(q)


hub = Hub()


async def index(_req: Request):
    return FileResponse(STATIC / "index.html")


async def api_state(_req: Request):
    items = hub.job.items if hub.job else []
    return JSONResponse({
        "app": APP_NAME,
        "version": APP_VERSION,
        "title": hub.title,
        "settings": {k: v for k, v in hub.settings.items() if k != "cookies"} | {
            "cookies": hub.settings.get("cookies") or "",
            "cookieCount": len([ln for ln in (hub.settings.get("cookies") or "").splitlines() if ln.strip() and not ln.startswith("#")]),
        },
        "running": bool(hub.task and not hub.task.done()),
        "paused": bool(hub.job and hub.job.paused),
        "items": items,
        "logs": hub.logs[:40],
        "downloadRoot": hub.settings.get("downloadRoot"),
        "samples": SAMPLE,
    })


async def api_settings(req: Request):
    body = await req.json()
    hub.settings = {**hub.settings, **{k: v for k, v in body.items() if k in DEFAULTS}}
    save_settings(hub.settings)
    return JSONResponse({"ok": True})


async def api_chrome(_req: Request):
    try:
        text = load_chrome_netscape()
        hub.settings["cookies"] = text
        save_settings(hub.settings)
        return JSONResponse({"ok": True, "cookies": text, "count": text.count("\n") - 1})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)


async def api_run(req: Request):
    body = await req.json()
    urls = [u.strip() for u in str(body.get("urls") or "").splitlines() if u.strip().startswith("http")]
    if not urls:
        return JSONResponse({"error": "Paste one or more http(s) URLs"}, status_code=400)
    if hub.task and not hub.task.done():
        return JSONResponse({"error": "A job is already running"}, status_code=409)
    if body.get("profile") in ("fast", "balanced", "deep"):
        hub.settings["profile"] = body["profile"]
    hub.logs = []
    hub.title = "Working…"
    pipe = Pipeline(hub.settings, hub.emit)
    hub.job = pipe

    async def _run():
        try:
            await pipe.run(urls, Path(hub.settings["downloadRoot"]))
        except asyncio.CancelledError:
            await hub.emit({"type": "log", "msg": "Stopped by user"})
            await hub.emit({"type": "done"})
        except Exception as e:
            await hub.emit({"type": "log", "msg": str(e)})
            await hub.emit({"type": "done"})

    hub.task = asyncio.create_task(_run())
    await hub.emit({"type": "log", "msg": f"Starting {len(urls)} seed(s) · {hub.settings['profile']}"})
    return JSONResponse({"ok": True})


async def api_stop(_req: Request):
    if hub.job:
        hub.job.cancel.set()
    if hub.task:
        hub.task.cancel()
    return JSONResponse({"ok": True})


async def api_pause(_req: Request):
    if hub.job:
        hub.job.paused = not hub.job.paused
        await hub.emit({"type": "log", "msg": "Paused" if hub.job.paused else "Resumed"})
        return JSONResponse({"paused": hub.job.paused})
    return JSONResponse({"paused": False})


async def api_events(req: Request):
    q: asyncio.Queue = asyncio.Queue(maxsize=200)
    hub.listeners.append(q)

    async def gen():
        try:
            yield f"data: {json.dumps({'type':'hello','version': APP_VERSION})}\n\n"
            while True:
                if await req.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(q.get(), timeout=20)
                    yield f"data: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ":\n\n"
        finally:
            if q in hub.listeners:
                hub.listeners.remove(q)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


async def api_zip(_req: Request):
    items = [i for i in (hub.job.items if hub.job else []) if i.get("phase") == "complete" and i.get("savedTo")]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for it in items:
            p = Path(it["savedTo"])
            if p.is_file():
                z.write(p, p.name)
    data = buf.getvalue()
    return Response(data, media_type="application/zip", headers={"Content-Disposition": "attachment; filename=Fathomrail.zip"})


async def api_hashes(_req: Request):
    items = hub.job.items if hub.job else []
    lines = [f"{i.get('sha256')}  {i.get('filename')}" for i in items if i.get("sha256")]
    return Response("\n".join(lines) + ("\n" if lines else ""), media_type="text/plain")


routes = [
    Route("/", index),
    Route("/api/state", api_state),
    Route("/api/settings", api_settings, methods=["POST"]),
    Route("/api/chrome-cookies", api_chrome, methods=["POST"]),
    Route("/api/run", api_run, methods=["POST"]),
    Route("/api/stop", api_stop, methods=["POST"]),
    Route("/api/pause", api_pause, methods=["POST"]),
    Route("/api/events", api_events),
    Route("/api/zip", api_zip),
    Route("/api/hashes", api_hashes),
    Mount("/static", StaticFiles(directory=str(STATIC)), name="static"),
]

app = Starlette(debug=False, routes=routes)


def main():
    import threading
    import webbrowser
    import uvicorn
    host = os.environ.get("HOST") or ("0.0.0.0" if os.environ.get("FATHOMRAIL_PREVIEW") else "127.0.0.1")
    port = int(os.environ.get("PORT") or ("8080" if host == "0.0.0.0" else "17331"))
    url = f"http://127.0.0.1:{port}/"
    if os.environ.get("FATHOMRAIL_OPEN", "1") != "0":
        threading.Timer(0.9, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
