from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from typing import Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

MEDIA_EXT = re.compile(
    r"\.(jpe?g|png|gif|webp|avif|bmp|svg|mp4|webm|mkv|mov|m4v|avi|mp3|m4a|flac|wav|ogg|opus)(?:$|\?)",
    re.I,
)
JSON_KEYS = {
    "download_url", "downloadurl", "file_url", "image_url", "media_url", "contenturl",
    "original", "original_url", "full", "full_url", "src", "source", "url", "image",
    "media", "file", "video", "audio",
}
TRACKING = {"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"}


def kind_of(url: str, mime: str | None = None) -> str:
    m = (mime or "").lower()
    if m.startswith("image/"):
        return "image"
    if m.startswith("video/"):
        return "video"
    if m.startswith("audio/"):
        return "audio"
    path = url.split("?")[0].lower()
    if re.search(r"\.(jpe?g|png|gif|webp|avif|bmp|svg)$", path):
        return "image"
    if re.search(r"\.(mp4|webm|mkv|mov|m4v|avi)$", path):
        return "video"
    if re.search(r"\.(mp3|m4a|flac|wav|ogg|opus)$", path):
        return "audio"
    return "other"


def looks_like_media(url: str) -> bool:
    clean = url.split("#")[0]
    if MEDIA_EXT.search(clean):
        return True
    if re.search(r"picsum\.photos/(?:id/\d+|\d+)", clean, re.I):
        return True
    if re.search(r"/id/\d+/\d+/\d+", clean):
        return True
    if re.search(r"/attachments/\d+", clean, re.I):
        return True
    if re.search(r"/data/attachments/", clean, re.I):
        return True
    return False


def is_stream(url: str) -> bool:
    return bool(re.search(r"\.(m3u8|mpd)(?:$|\?)", url, re.I))


def decode_entities(s: str) -> str:
    return (
        s.replace("\u0026amp;", "&")
        .replace("\u0026quot;", '"')
        .replace("\u0026#39;", "'")
        .replace("\u0026apos;", "'")
        .replace("\u0026lt;", "<")
        .replace("\u0026gt;", ">")
    )


def abs_url(raw: str, base: str) -> str | None:
    raw = decode_entities(raw.strip())
    try:
        u = urljoin(base, raw)
    except Exception:
        return None
    p = urlparse(u)
    if p.scheme not in ("http", "https"):
        return None
    return urlunparse((p.scheme, p.netloc, p.path, p.params, p.query, ""))


def canonicalize(url: str) -> str:
    p = urlparse(url)
    q = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if k.lower() not in TRACKING]
    path = p.path.rstrip("/") if len(p.path) > 1 else p.path
    return urlunparse((p.scheme, p.netloc.lower(), path, "", urlencode(q), ""))


def is_thumb(url: str) -> bool:
    path = url.split("?")[0].lower()
    return bool(
        re.search(r"(?:^|[/_-])(thumb|thumbnail|thumbs|preview|small|icon|mini|tiny)(?:[/_-]|$)", path)
        or re.search(r"-\d{2,3}x\d{2,3}(?:\.\w+)?$", path)
    )


def upgrade_original(url: str) -> str:
    p = urlparse(url)
    path = re.sub(r"/thumbs?/", "/", p.path, flags=re.I)
    path = re.sub(r"/previews?/", "/", path, flags=re.I)
    path = re.sub(r"[-_](?:thumb|small|preview|150x150|300x300)", "", path, flags=re.I)
    return urlunparse((p.scheme, p.netloc, path, p.params, p.query, p.fragment))


def media_key(url: str) -> str:
    try:
        p = urlparse(canonicalize(url))
        parts = [x for x in p.path.lower().strip("/").split("/") if x]
        if not parts:
            return p.netloc
        last = parts[-1]
        if re.search(r"\.[a-z0-9]{2,5}$", last):
            stem = re.sub(r"[-_](?:thumb|small|preview|\d{2,4}x\d{2,4})$", "", last.rsplit(".", 1)[0], flags=re.I)
            return p.netloc + "/" + stem
        if len(parts) >= 3 and parts[-1].isdigit() and parts[-2].isdigit():
            return p.netloc + "/" + "/".join(parts[:-2])
        return p.netloc + "/" + "/".join(parts)
    except Exception:
        return url


def looks_like_album(url: str) -> bool:
    return bool(re.search(
        r"/(a|album|albums|gallery|galleries|g|post|posts|thread|threads|view|v|f|file|attachments?)/[^/?#]+",
        url, re.I,
    ))


def looks_like_pagination(url: str) -> bool:
    return bool(
        re.search(r"[?&]page=\d+", url, re.I)
        or re.search(r"/page-\d+", url, re.I)
        or re.search(r"[?&]p=\d+", url, re.I)
    )


def inferred_next_page(current: str) -> str | None:
    p = urlparse(current)
    q = dict(parse_qsl(p.query, keep_blank_values=True))
    for key in ("page", "p"):
        if key in q and q[key].isdigit():
            q[key] = str(int(q[key]) + 1)
            return urlunparse((p.scheme, p.netloc, p.path, p.params, urlencode(q), ""))
    m = re.search(r"/page-(\d+)/?$", p.path, re.I)
    if m:
        nxt = re.sub(r"page-\d+", f"page-{int(m.group(1)) + 1}", p.path, flags=re.I)
        return urlunparse((p.scheme, p.netloc, nxt, p.params, p.query, ""))
    if re.search(r"/threads/[^/]+/?$", p.path, re.I):
        path = p.path.rstrip("/") + "/page-2"
        return urlunparse((p.scheme, p.netloc, path, p.params, p.query, ""))
    return None


def parse_thread_ids(url: str) -> dict[str, str | None]:
    p = urlparse(url)
    path = p.path
    q = dict(parse_qsl(p.query))

    def m(src: str, pat: str) -> str | None:
        hit = re.search(pat, src, re.I)
        return hit.group(1) if hit else None

    forum = m(path, r"/forums/(?:[^/]*?\.)?(\d+)") or q.get("forum_id") or q.get("f")
    thread = m(path, r"/threads/(?:[^/]*?\.)?(\d+)") or q.get("thread_id") or q.get("t")
    post = m(path, r"/posts/(\d+)") or m(p.fragment, r"post-(\d+)") or q.get("post_id") or q.get("p")
    return {"forumId": forum, "threadId": thread, "postId": post}


def filename_from(url: str) -> str:
    try:
        last = urlparse(url).path.rstrip("/").split("/")[-1]
        last = re.sub(r"%[0-9A-Fa-f]{2}", lambda m: bytes.fromhex(m.group(0)[1:]).decode("utf-8", "ignore"), last)
        if "." in last and len(last) < 180:
            return sanitize(last)
    except Exception:
        pass
    ext = { "image": ".jpg", "video": ".mp4", "audio": ".mp3" }.get(kind_of(url), ".bin")
    return f"media-{abs(hash(url)) & 0xFFFFFFFF:x}{ext}"


def sanitize(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*]', "_", name).strip()
    return (name or "download")[:180]


def accept_candidate(raw: str, base: str) -> str | None:
    url = abs_url(raw, base)
    if not url or is_stream(url):
        return None
    upgraded = upgrade_original(url)
    if looks_like_media(upgraded):
        return canonicalize(upgraded)
    if re.search(r"/(?:images?|media|files?|attachments?|cdn)/", upgraded, re.I) and not re.search(
        r"/(?:css|js|fonts?)/", upgraded, re.I
    ):
        return canonicalize(upgraded)
    return None


def _push(media: list[dict], seen: set[str], keys: dict[str, int], raw: str, base: str, ids: dict, extractor: str):
    url = accept_candidate(raw, base)
    if not url:
        return
    key = media_key(url)
    if key in keys:
        prev = media[keys[key]]
        if is_thumb(prev["url"]) and not is_thumb(url):
            media[keys[key]] = { "url": url, "kind": kind_of(url), **ids, "extractor": extractor }
        return
    if url in seen:
        return
    seen.add(url)
    keys[key] = len(media)
    media.append({ "url": url, "kind": kind_of(url), **ids, "extractor": extractor })


def extract_from_json(text: str, base: str, extractor: str = "json-feed") -> list[dict]:
    ids = parse_thread_ids(base)
    media: list[dict] = []
    seen: set[str] = set()
    keys: dict[str, int] = {}

    def walk(el: Any, parent: str | None = None):
        if isinstance(el, str):
            key = (parent or "").lower()
            loose = bool(re.search(r"download|original|image|video|audio|media|contenturl|file_url", key))
            if (key in JSON_KEYS or looks_like_media(el)) and (looks_like_media(el) or loose):
                _push(media, seen, keys, el, base, ids, extractor)
        elif isinstance(el, list):
            for c in el:
                walk(c, parent)
        elif isinstance(el, dict):
            for k, v in el.items():
                walk(v, str(k))

    try:
        walk(json.loads(text))
    except Exception:
        for line in text.splitlines():
            t = line.strip()
            if looks_like_media(t):
                _push(media, seen, keys, t, base, ids, extractor)
    return media


class _HtmlExtractor(HTMLParser):
    def __init__(self, base: str):
        super().__init__(convert_charrefs=True)
        self.base = base
        self.ids = parse_thread_ids(base)
        self.current_post = self.ids.get("postId")
        self.forum_id = self.ids.get("forumId")
        self.thread_id = self.ids.get("threadId")
        self.title: str | None = None
        self._in_title = False
        self.media: list[dict] = []
        self.seen: set[str] = set()
        self.keys: dict[str, int] = {}
        self.links: list[str] = []
        self.pagination: list[str] = []
        self.seen_links: set[str] = set()
        self.extractor = (
            "forum-thread" if self.thread_id or self.forum_id
            else "album" if looks_like_album(base) else "html-generic"
        )
        self.host = urlparse(base).hostname or ""
        self._json_buf = ""
        self._in_ld = False
        self._in_next = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag in ("article", "li", "div", "section"):
            blob = " ".join(a.values())
            m = re.search(r"(?:id|data-content|data-post-id)=(?:js-)?post-?(\d+)", blob, re.I)
            if not m:
                m = re.search(r"\b(?:js-)?post-(\d+)\b", blob, re.I)
            if m:
                self.current_post = m.group(1)
            fid = a.get("data-forum-id")
            if fid:
                self.forum_id = fid
        if tag == "title":
            self._in_title = True
        if tag == "script":
            t = a.get("type", "")
            i = a.get("id", "")
            if "ld+json" in t:
                self._in_ld = True
                self._json_buf = ""
            if i == "__NEXT_DATA__":
                self._in_next = True
                self._json_buf = ""
        if tag == "meta":
            prop = (a.get("property") or a.get("name") or "").lower()
            if re.search(r"og:image|twitter:image|og:video|og:audio|twitter:player:stream", prop):
                if a.get("content"):
                    self._add(a["content"], "opengraph")
        ids = {
            "postId": self.current_post,
            "forumId": self.forum_id,
            "threadId": self.thread_id,
        }
        for name in ("src", "data-src", "data-original", "data-lazy-src", "data-full", "data-url", "data-file", "data-src-hd", "poster", "href"):
            v = a.get(name)
            if not v:
                continue
            if name == "href" and not looks_like_media(v) and "/attachment" not in v.lower():
                if tag == "a":
                    self._link(v, a.get("rel", ""))
                continue
            self._add(v, self.extractor)
        srcset = a.get("srcset") or a.get("data-srcset")
        if srcset:
            best = _best_srcset(srcset)
            if best:
                self._add(best, self.extractor)
        if tag == "link" and "next" in (a.get("rel") or "").lower() and a.get("href"):
            resolved = abs_url(a["href"], self.base)
            if resolved:
                self.pagination.append(canonicalize(resolved))

    def handle_endtag(self, tag: str):
        if tag == "title":
            self._in_title = False
        if tag == "script" and (self._in_ld or self._in_next):
            ext = "json-ld" if self._in_ld else "next-data"
            for item in extract_from_json(self._json_buf, self.base, ext):
                self._add(item["url"], item["extractor"])
            self._in_ld = self._in_next = False
            self._json_buf = ""

    def handle_data(self, data: str):
        if self._in_title and not self.title:
            self.title = decode_entities(data.strip())[:200] or None
        if self._in_ld or self._in_next:
            self._json_buf += data

    def _add(self, raw: str, extractor: str):
        ids = {"postId": self.current_post, "forumId": self.forum_id, "threadId": self.thread_id}
        _push(self.media, self.seen, self.keys, raw, self.base, ids, extractor)

    def _link(self, href: str, rel: str):
        resolved = abs_url(href, self.base)
        if not resolved:
            return
        canon = canonicalize(resolved)
        if canon in self.seen_links:
            return
        self.seen_links.add(canon)
        if looks_like_media(resolved):
            self._add(resolved, self.extractor)
            return
        host = urlparse(resolved).hostname or ""
        if looks_like_pagination(resolved) and host.lower() == self.host.lower():
            self.pagination.append(canon)
            return
        if host.lower() != self.host.lower() and not looks_like_album(resolved):
            return
        if re.search(r"\.(css|js|xml|json)$", urlparse(resolved).path, re.I):
            return
        self.links.append(canon)


def _best_srcset(srcset: str) -> str | None:
    best, score = "", -1.0
    for part in srcset.split(","):
        bits = part.strip().split()
        if not bits:
            continue
        d = bits[1] if len(bits) > 1 else "1x"
        n = 1.0
        try:
            if d.endswith("w"):
                n = float(d[:-1])
            elif d.endswith("x"):
                n = float(d[:-1]) * 1000
        except ValueError:
            n = 1.0
        if n >= score:
            score, best = n, bits[0]
    return best or None


def extract_from_html(html: str, base: str) -> dict:
    p = _HtmlExtractor(base)
    try:
        p.feed(html)
        p.close()
    except Exception:
        pass
    return {
        "media": p.media,
        "links": p.links,
        "pagination": p.pagination,
        "title": p.title,
        "forumId": p.forum_id,
        "threadId": p.thread_id,
        "extractor": p.extractor,
    }
