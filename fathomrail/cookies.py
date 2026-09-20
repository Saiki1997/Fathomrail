from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse


def parse_cookie_dump(raw: str) -> list[dict]:
    text = raw.strip()
    if not text:
        return []
    if text.startswith("[") or text.startswith("{"):
        try:
            data = json.loads(text)
            rows = data if isinstance(data, list) else data.get("cookies") or []
            out = []
            for r in rows:
                if not isinstance(r, dict):
                    continue
                name = str(r.get("name") or r.get("Name") or "")
                if not name:
                    continue
                out.append({
                    "domain": str(r.get("domain") or r.get("host") or r.get("host_key") or ""),
                    "path": str(r.get("path") or "/"),
                    "name": name,
                    "value": str(r.get("value") or r.get("Value") or ""),
                })
            return out
        except Exception:
            pass
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) >= 7:
            out.append({"domain": parts[0], "path": parts[2], "name": parts[5], "value": parts[6]})
        elif "=" in line and not line.lower().startswith("set-cookie"):
            name, _, value = line.partition("=")
            out.append({"domain": "", "path": "/", "name": name.strip(), "value": value.strip()})
    return out


def header_for(raw: str, url: str) -> str | None:
    host = (urlparse(url).hostname or "").lower()
    parts = []
    for c in parse_cookie_dump(raw):
        d = c["domain"].lstrip(".").lower()
        if d and host != d and not host.endswith("." + d) and not d.endswith(host):
            continue
        if c["name"]:
            parts.append(f"{c['name']}={c['value']}")
    return "; ".join(parts) if parts else None


def load_chrome_netscape(profile: str = "Default") -> str:
    if sys.platform != "win32":
        raise RuntimeError("Direct Chrome import works on Windows. Paste a cookies.txt export here.")
    local = Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "User Data"
    state = local / "Local State"
    if not state.exists():
        raise RuntimeError("Chrome user data was not found. Is Google Chrome installed?")
    key = _unwrap_key(state)
    db = local / profile / "Network" / "Cookies"
    if not db.exists():
        db = local / profile / "Cookies"
    if not db.exists():
        raise RuntimeError(f"No Chrome cookies database for profile '{profile}'.")
    uri = db.as_posix().replace("?", "%3F")
    conn = sqlite3.connect(f"file:{uri}?mode=ro&nolock=1", uri=True)
    try:
        rows = conn.execute(
            "SELECT host_key, path, is_secure, expires_utc, name, encrypted_value FROM cookies"
        ).fetchall()
    finally:
        conn.close()
    lines = ["# Netscape HTTP Cookie File", "# Imported from Google Chrome"]
    for host, path, secure, expires, name, blob in rows:
        value = _decrypt_cookie(key, blob or b"")
        if not value:
            continue
        unix = max(0, int(expires / 1_000_000) - 11644473600) if expires else 0
        lines.append("\t".join([host, "TRUE", path, "TRUE" if secure else "FALSE", str(unix), name, value]))
    if len(lines) <= 2:
        raise RuntimeError("No cookies could be decrypted. Close Chrome and retry, or paste an export.")
    return "\n".join(lines)


def _unwrap_key(state_path: Path) -> bytes:
    data = json.loads(state_path.read_text(encoding="utf-8"))
    b64 = data["os_crypt"]["encrypted_key"]
    import base64
    raw = base64.b64decode(b64)
    if raw[:5] != b"DPAPI":
        raise RuntimeError("Unexpected Chrome key prefix")
    return _dpapi_unprotect(raw[5:])


def _dpapi_unprotect(blob: bytes) -> bytes:
    import ctypes
    from ctypes import wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]

    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    buf = ctypes.create_string_buffer(blob)
    inn = DATA_BLOB(len(blob), ctypes.cast(buf, ctypes.POINTER(ctypes.c_byte)))
    out = DATA_BLOB()
    if not crypt32.CryptUnprotectData(ctypes.byref(inn), None, None, None, None, 0, ctypes.byref(out)):
        raise RuntimeError("DPAPI could not unwrap the Chrome key")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(out.pbData)


def _decrypt_cookie(key: bytes, encrypted: bytes) -> str:
    if not encrypted:
        return ""
    if len(encrypted) > 3 and encrypted[:3] in (b"v10", b"v11", b"v20"):
        nonce = encrypted[3:15]
        cipher = encrypted[15:-16]
        tag = encrypted[-16:]
        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            return AESGCM(key).decrypt(nonce, cipher + tag, None).decode("utf-8", "ignore")
        except Exception:
            return ""
    try:
        return _dpapi_unprotect(encrypted).decode("utf-8", "ignore")
    except Exception:
        return ""
