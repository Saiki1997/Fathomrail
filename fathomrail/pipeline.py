from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import re
import socket
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx

from . import APP_UA
from .cookies import header_for
from .extract import (
    canonicalize,
    extract_from_html,
    extract_from_json,
    filename_from,
    inferred_next_page,
    is_stream,
    kind_of,
    looks_like_album,
    looks_like_media,
    looks_like_pagination,
    parse_thread_ids,
    sanitize,
)

PROFILES = {
    "fast": (1, 8.0, 40),
    "balanced": (3, 14.0, 120),
    "deep": (6, 20.0, 240),
}

SAMPLE = {
    "picsum": "https://picsum.photos/v2/list?page=2&limit=12",
    "direct": "\n".join([
        "https://picsum.photos/id/10/800/500.jpg",
        "https://picsum.photos/id/11/800/500.jpg",
        "https://picsum.photos/id/12/800/500.jpg",
    ]),
}


def assert_public(url: str) -> None:
    p = urlparse(url)
    if p.scheme not in ("http", "https"):
        raise ValueError("Only http(s) URLs are allowed")
    host = (p.hostname or "").lower()
    if host in {"localhost", "127.0.0.1", "0.0.0.0", "::1"} or host.endswith(".local"):
        raise ValueError("That host is not allowed")
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError as e:
        raise ValueError(f"Could not resolve {host}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local:
            raise ValueError("Private or local addresses are not allowed")


def ordered_name(index: int, name: str) -> str:
    base = sanitize(re.sub(r"^\d{3,4}_", "", name))
    return f"{index:03d}_{base}"


def dest_dir(settings: dict, item: dict) -> Path:
    root = Path(settings.get("downloadRoot") or str(Path.home() / "Pictures" / "Fathomrail"))
    folder = sanitize(settings.get("folderName") or "Fathomrail")
    base = root / folder
    mode = settings.get("organizeBy") or "forumPost"
    forum = "forum_" + sanitize(item.get("forumId") or "unknown")
    post = "post_" + sanitize(item.get("postId") or item.get("threadId") or "unknown")
    if mode == "forum":
        return base / forum
    if mode == "post":
        return base / post
    if mode == "forumPost":
        return base / forum / post
    return base


class HashStore:
    def __init__(self, path: Path):
        self.path = path
        self._set: set[str] = set()
        try:
            self._set = set(json.loads(path.read_text()))
        except Exception:
            self._set = set()

    def has(self, h: str) -> bool:
        return h in self._set

    def add(self, h: str) -> None:
        if h in self._set:
            return
        self._set.add(h)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(sorted(self._set)))


class Pipeline:
    def __init__(self, settings: dict, emit):
        self.settings = settings
        self.emit = emit
        self.paused = False
        self.cancel = asyncio.Event()
        self.items: list[dict] = []
        self._host_last: dict[str, float] = {}
        self._host_sem: dict[str, asyncio.Semaphore] = {}
        self._used_window = 0.0
        self._used_bytes = 0
        self.hashes = HashStore(Path.home() / ".fathomrail" / "hashes.json")

    async def wait_pause(self):
        while self.paused and not self.cancel.is_set():
            await asyncio.sleep(0.12)
        if self.cancel.is_set():
            raise asyncio.CancelledError()

    async def acquire_host(self, host: str):
        max_c = max(1, int(self.settings.get("hostMaxConcurrent") or 2))
        gap = float(self.settings.get("hostGapMs") or 250) / 1000.0
        sem = self._host_sem.setdefault(host, asyncio.Semaphore(max_c))
        await sem.acquire()
        last = self._host_last.get(host, 0)
        wait = last + gap - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        self._host_last[host] = time.monotonic()
        return sem

    async def take_bytes(self, n: int):
        kbps = int(self.settings.get("bandwidthKbps") or 0)
        if kbps <= 0:
            return
        cap = kbps * 1000
        while True:
            now = time.monotonic()
            if now - self._used_window >= 1:
                self._used_window = now
                self._used_bytes = 0
            if self._used_bytes + n <= cap:
                self._used_bytes += n
                return
            await asyncio.sleep(0.05)

    async def fetch(self, client: httpx.AsyncClient, url: str, timeout: float, referer: str | None = None) -> httpx.Response:
        assert_public(url)
        headers = {"User-Agent": APP_UA, "Accept": "text/html,application/json;q=0.9,*/*;q=0.8"}
        cookie = header_for(self.settings.get("cookies") or "", url)
        if cookie:
            headers["Cookie"] = cookie
        if referer:
            headers["Referer"] = referer
        last = None
        last_exc: Exception | None = None
        for attempt in range(3):
            try:
                last = await client.get(url, headers=headers, timeout=timeout, follow_redirects=True)
            except httpx.HTTPError as e:
                last_exc = e
                await asyncio.sleep(0.6 * (2 ** attempt))
                continue
            if last.status_code in (429, 503):
                wait = float(last.headers.get("retry-after") or (0.6 * (2 ** attempt)))
                await asyncio.sleep(min(wait, 8))
                continue
            return last
        if last is not None:
            return last
        raise last_exc  # type: ignore

    async def discover_one(self, client: httpx.AsyncClient, seed: str) -> dict:
        seed = seed.strip()
        if is_stream(seed):
            return {"items": [], "warning": "HLS/DASH manifests are skipped.", "followed": [], "title": None}
        if looks_like_media(seed):
            ids = parse_thread_ids(seed)
            item = {
                "id": "m0",
                "url": canonicalize(seed),
                "sourcePage": seed,
                "filename": filename_from(seed),
                "kind": kind_of(seed),
                "extractor": "direct",
                **ids,
            }
            extra = await self._external(seed)
            return {"items": extra or [item], "followed": [seed], "title": item["filename"], "warning": None}

        pages, timeout, max_items = PROFILES.get(self.settings.get("profile") or "balanced", PROFILES["balanced"])
        queue = [canonicalize(seed)]
        seen: set[str] = set()
        found: dict[str, dict] = {}
        title = None
        warning = None
        while queue and len(seen) < pages and len(found) < max_items:
            page = queue.pop(0)
            if page in seen:
                continue
            seen.add(page)
            await self.emit({"type": "log", "msg": f"Fetching {page}"})
            try:
                res = await self.fetch(client, page, timeout, referer=seed if len(seen) > 1 else None)
                body = res.text
                ct = res.headers.get("content-type") or ""
                final = str(res.url)
                if res.status_code >= 400:
                    blob = body[:800]
                    if re.search(r"ddos-guard|cf-challenge|just a moment|access forbidden|forums are currently closed", blob, re.I):
                        warning = f"HTTP {res.status_code} — this host blocks anonymous crawls. Import cookies from a logged-in Chrome session."
                    elif res.status_code == 403:
                        warning = "HTTP 403 Forbidden — import cookies from a logged-in session and retry."
                    else:
                        warning = f"HTTP {res.status_code}"
                    extra = await self._external(page) if not found else []
                    for it in extra:
                        found[it["url"]] = it
                    continue
                items = []
                follow: list[str] = []
                if "json" in ct or body.lstrip()[:1] in "[{":
                    items = extract_from_json(body, final)
                    extractor = "json-feed"
                else:
                    extracted = extract_from_html(body, final)
                    items = extracted["media"]
                    title = title or extracted["title"]
                    extractor = extracted["extractor"]
                    follow = extracted["pagination"] + [
                        l for l in extracted["links"] if looks_like_album(l) or looks_like_pagination(l)
                    ]
                    nxt = inferred_next_page(final)
                    if extracted["media"] and nxt:
                        follow.insert(0, nxt)
                    follow += extracted["links"]
                extra = await self._external(final) if not items else []
                items = extra + items
                kinds = self.settings
                for it in items:
                    if len(found) >= max_items:
                        break
                    if it["kind"] == "image" and not kinds.get("includeImages", True):
                        continue
                    if it["kind"] == "video" and not kinds.get("includeVideos", True):
                        continue
                    if it["kind"] == "audio" and not kinds.get("includeAudio", True):
                        continue
                    key = canonicalize(it["url"])
                    if kinds.get("skipDuplicates", True) and key in found:
                        continue
                    it = {**it, "url": key, "sourcePage": final, "filename": filename_from(key), "extractor": it.get("extractor") or extractor}
                    found[key] = it
                for link in follow:
                    canon = canonicalize(link)
                    if canon not in seen and canon not in queue and len(seen) + len(queue) < pages:
                        queue.append(canon)
            except Exception as e:
                warning = str(e)
        return {"items": list(found.values()), "followed": list(seen), "title": title, "warning": warning if found else (warning or "No media found on this page")}

    async def _external(self, url: str) -> list[dict]:
        out: list[dict] = []
        ids = parse_thread_ids(url)
        # yt-dlp (Unlicense) — videos, playlists, many hosts
        try:
            import yt_dlp  # type: ignore
            opts = {"quiet": True, "no_warnings": True, "skip_download": True, "extract_flat": False}
            def _run():
                with yt_dlp.YoutubeDL(opts) as ydl:
                    return ydl.extract_info(url, download=False)
            info = await asyncio.to_thread(_run)
            entries = info.get("entries") if isinstance(info, dict) else None
            rows = list(entries) if entries else ([info] if info else [])
            for i, e in enumerate(rows):
                if not isinstance(e, dict):
                    continue
                media_url = e.get("url") if e.get("ext") in {"jpg", "png", "webp", "gif", "mp4", "webm", "mkv"} else None
                media_url = media_url or e.get("webpage_url") or e.get("original_url")
                req = e.get("requested_downloads") or e.get("formats") or []
                if isinstance(req, list) and req:
                    best = req[-1] if isinstance(req[-1], dict) else None
                    if best and best.get("url") and looks_like_media(best["url"]):
                        media_url = best["url"]
                if not media_url or not looks_like_media(str(media_url)):
                    continue
                out.append({
                    "url": canonicalize(str(media_url)),
                    "kind": kind_of(str(media_url)),
                    "filename": sanitize(e.get("title") or filename_from(str(media_url))),
                    "extractor": f"yt-dlp:{e.get('extractor', 'generic')}",
                    "sourcePage": url,
                    **ids,
                })
        except Exception:
            pass
        # gallery-dl if the user has it installed (not bundled — GPL)
        try:
            proc = await asyncio.create_subprocess_exec(
                "gallery-dl", "-j", "-q", url,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=20)
            if proc.returncode == 0 and stdout:
                data = json.loads(stdout.decode("utf-8", "ignore"))
                rows = data if isinstance(data, list) else [data]
                for row in rows:
                    if not isinstance(row, (list, dict)):
                        continue
                    payload = row[1] if isinstance(row, list) and len(row) > 1 and isinstance(row[1], dict) else row
                    if not isinstance(payload, dict):
                        continue
                    u = payload.get("url") or payload.get("file") or payload.get("download")
                    if u and looks_like_media(str(u)):
                        out.append({
                            "url": canonicalize(str(u)),
                            "kind": kind_of(str(u)),
                            "filename": filename_from(str(u)),
                            "extractor": "gallery-dl",
                            "sourcePage": url,
                            **ids,
                        })
        except Exception:
            pass
        return out

    async def resolve_item(self, client: httpx.AsyncClient, item: dict):
        item["phase"] = "resolving"
        await self.emit({"type": "item", "item": item})
        if is_stream(item["url"]):
            item["error"] = "Stream manifest skipped"
            item["phase"] = "queued"
            return
        try:
            res = await self.fetch(client, item["url"], 12.0, referer=item.get("sourcePage"))
            mime = res.headers.get("content-type")
            if mime and "html" in mime and res.text:
                extracted = extract_from_html(res.text, str(res.url))
                best = next((m for m in extracted["media"] if "preview" not in m["url"]), None) or (extracted["media"][0] if extracted["media"] else None)
                if best:
                    item["url"] = best["url"]
                    item["extractor"] = best["extractor"]
                    res = await self.fetch(client, item["url"], 12.0, referer=str(res.url))
                    mime = res.headers.get("content-type")
            item["mime"] = mime
            cl = res.headers.get("content-length")
            item["bytesTotal"] = int(cl) if cl and cl.isdigit() else None
            cd = res.headers.get("content-disposition") or ""
            m = re.search(r'filename="?([^";]+)"?', cd)
            if m:
                item["filename"] = sanitize(m.group(1))
            else:
                item["filename"] = filename_from(str(res.url))
            item["kind"] = kind_of(item["url"], mime)
            item["resolvedUrl"] = str(res.url)
            item["phase"] = "queued"
        except Exception as e:
            item["error"] = str(e)
            item["phase"] = "queued"
        await self.emit({"type": "item", "item": item})

    async def download_item(self, client: httpx.AsyncClient, item: dict, dest_root: Path):
        await self.wait_pause()
        url = item.get("resolvedUrl") or item["url"]
        host = urlparse(url).hostname or "host"
        sem = await self.acquire_host(host)
        try:
            retries = int(self.settings.get("retries") or 2)
            delay = float(self.settings.get("retryDelayMs") or 800) / 1000.0
            max_b = int(self.settings.get("maxFileMb") or 80) * 1024 * 1024
            folder = dest_dir(self.settings, item)
            folder.mkdir(parents=True, exist_ok=True)
            dest = folder / item["filename"]
            last_err = None
            for attempt in range(retries + 1):
                if self.cancel.is_set():
                    raise asyncio.CancelledError()
                item["phase"] = "fetching"
                item["bytesDone"] = 0
                item["error"] = None
                await self.emit({"type": "item", "item": item})
                try:
                    headers = {"User-Agent": APP_UA}
                    cookie = header_for(self.settings.get("cookies") or "", url)
                    if cookie:
                        headers["Cookie"] = cookie
                    if item.get("sourcePage"):
                        headers["Referer"] = item["sourcePage"]
                    async with client.stream("GET", url, headers=headers, timeout=120.0, follow_redirects=True) as res:
                        if res.status_code >= 400:
                            raise httpx.HTTPStatusError(f"HTTP {res.status_code}", request=res.request, response=res)
                        total = int(res.headers.get("content-length") or 0)
                        if total > max_b:
                            raise ValueError("Over size limit")
                        h = hashlib.sha256()
                        done = 0
                        t0 = time.monotonic()
                        with open(dest, "wb") as fh:
                            async for chunk in res.aiter_bytes(64 * 1024):
                                await self.wait_pause()
                                fh.write(chunk)
                                h.update(chunk)
                                done += len(chunk)
                                if done > max_b:
                                    raise ValueError("Over size limit")
                                await self.take_bytes(len(chunk))
                                item["bytesDone"] = done
                                item["bytesTotal"] = total or done
                                dt = time.monotonic() - t0
                                item["speedBps"] = done / dt if dt > 0 else 0
                                await self.emit({"type": "progress", "item": item})
                        if done == 0:
                            raise ValueError("Zero-byte file")
                        item["phase"] = "verifying"
                        await self.emit({"type": "item", "item": item})
                        if self.settings.get("verifyHash", True):
                            digest = h.hexdigest()
                            item["sha256"] = digest
                            if self.settings.get("skipKnownHashes", True) and self.hashes.has(digest):
                                try:
                                    dest.unlink()
                                except OSError:
                                    pass
                                item["phase"] = "skipped"
                                item["error"] = "known hash"
                                item["speedBps"] = 0
                                await self.emit({"type": "item", "item": item})
                                return
                            self.hashes.add(digest)
                        item["phase"] = "complete"
                        item["speedBps"] = 0
                        item["savedTo"] = str(dest)
                        await self.emit({"type": "item", "item": item})
                        return
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    last_err = e
                    await asyncio.sleep(delay * (2 ** attempt))
            item["phase"] = "failed"
            item["error"] = str(last_err) if last_err else "failed"
            item["speedBps"] = 0
            await self.emit({"type": "item", "item": item})
        finally:
            sem.release()

    async def run(self, urls: list[str], dest_root: Path):
        await self.emit({"type": "stage", "i": 0})
        limits = httpx.Limits(max_connections=8, max_keepalive_connections=8)
        async with httpx.AsyncClient(headers={"User-Agent": APP_UA}, limits=limits, http2=False) as client:
            order = 1
            for url in urls:
                await self.wait_pause()
                result = await self.discover_one(client, url)
                await self.emit({"type": "stage", "i": 1})
                if result.get("warning"):
                    await self.emit({"type": "log", "msg": result["warning"]})
                if result.get("title"):
                    await self.emit({"type": "title", "msg": result["title"]})
                for it in result["items"]:
                    it["id"] = f"m{order}"
                    it["orderIndex"] = order
                    it["phase"] = "queued"
                    it["selected"] = True
                    it["bytesDone"] = 0
                    if self.settings.get("numberFiles", True):
                        it["filename"] = ordered_name(order, it.get("filename") or filename_from(it["url"]))
                    order += 1
                    self.items.append(it)
                    await self.emit({"type": "item", "item": it})
                await self.emit({"type": "log", "msg": f"Found {len(result['items'])} media on {len(result['followed'])} page(s)"})
            if not self.items:
                await self.emit({"type": "log", "msg": "Nothing matched"})
                await self.emit({"type": "done"})
                return
            await self.emit({"type": "stage", "i": 2})
            await self.emit({"type": "log", "msg": f"Resolving {len(self.items)} URLs"})
            workers = max(1, int(self.settings.get("workers") or 4))
            sem = asyncio.Semaphore(workers)

            async def resolve(it):
                async with sem:
                    await self.wait_pause()
                    await self.resolve_item(client, it)
                    if self.settings.get("numberFiles", True):
                        it["filename"] = ordered_name(it["orderIndex"], it["filename"])

            await asyncio.gather(*(resolve(it) for it in self.items))
            await self.emit({"type": "stage", "i": 3})
            selected = [i for i in self.items if i.get("selected", True)]
            selected.sort(key=lambda x: x.get("orderIndex") or 0)
            dl_workers = 1 if self.settings.get("sequentialDownload", True) else workers
            await self.emit({"type": "log", "msg": f"Downloading {len(selected)} files"})
            dlsem = asyncio.Semaphore(dl_workers)

            async def dl(it):
                async with dlsem:
                    await self.download_item(client, it, dest_root)

            await asyncio.gather(*(dl(it) for it in selected))
            await self.emit({"type": "stage", "i": 4})
            ok = sum(1 for i in self.items if i.get("phase") == "complete")
            await self.emit({"type": "log", "msg": f"Verified {ok} file(s)"})
            hook = (self.settings.get("webhookUrl") or "").strip()
            if hook:
                try:
                    assert_public(hook)
                    payload = {
                        "app": "Fathomrail",
                        "status": "complete",
                        "files": ok,
                        "failed": sum(1 for i in self.items if i.get("phase") == "failed"),
                        "bytes": sum(i.get("bytesDone") or 0 for i in self.items if i.get("phase") == "complete"),
                    }
                    await client.post(hook, json=payload, timeout=12.0)
                    await self.emit({"type": "log", "msg": "Webhook sent"})
                except Exception as e:
                    await self.emit({"type": "log", "msg": f"Webhook: {e}"})
            await self.emit({"type": "done"})
