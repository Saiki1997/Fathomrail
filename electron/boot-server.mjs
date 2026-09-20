import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.env.PORT || 17331);
const staticDir = process.env.FATHOMRAIL_STATIC;
const entry = process.env.FATHOMRAIL_ENTRY;
const htmlPath = process.env.FATHOMRAIL_HTML;

if (!staticDir || !entry) {
  console.error("FATHOMRAIL_STATIC and FATHOMRAIL_ENTRY are required");
  process.exit(1);
}

process.chdir(path.dirname(entry));

const SKIP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-connection",
  "content-length",
  "accept-encoding",
  "host",
]);

const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

let fetchFn = null;
try {
  const mod = await import(pathToFileURL(entry).href);
  fetchFn = mod.default?.fetch ?? mod.fetch ?? null;
} catch (err) {
  console.error("Failed to load server entry", err);
}

function tryStatic(urlPath, res) {
  const rel = decodeURIComponent((urlPath.split("?")[0] ?? "/").replace(/^\/+/, ""));
  if (!rel) return false;
  const root = path.resolve(staticDir);
  const file = path.resolve(root, rel);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (file !== root && !file.toLowerCase().startsWith(prefix.toLowerCase())) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
  return true;
}

function wantsDocument(req) {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  const p = (req.url ?? "/").split("?")[0] ?? "/";
  if (p.startsWith("/assets/") || p.startsWith("/api/") || p.startsWith("/_")) return false;
  if (/\.[a-z0-9]{1,8}$/i.test(p) && !p.endsWith(".html")) return false;
  return true;
}

function sendHtml(res, file) {
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    if (tryStatic(req.url ?? "/", res)) return;

    if (wantsDocument(req) && htmlPath && fs.existsSync(htmlPath)) {
      sendHtml(res, htmlPath);
      return;
    }

    if (typeof fetchFn !== "function") {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("Fathomrail server is not ready.");
      return;
    }

    const url = `http://127.0.0.1:${port}${req.url ?? "/"}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      if (SKIP_HEADERS.has(k.toLowerCase())) continue;
      headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    const method = req.method ?? "GET";
    let body;
    if (method !== "GET" && method !== "HEAD") {
      body = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      });
    }
    const request = new Request(url, { method, headers, body });
    const response = await fetchFn(request, {});
    const out = {};
    response.headers.forEach((value, key) => {
      out[key] = value;
    });
    const buf = Buffer.from(await response.arrayBuffer());
    if (
      wantsDocument(req) &&
      htmlPath &&
      fs.existsSync(htmlPath) &&
      (response.status >= 500 || (out["content-type"] ?? "").includes("application/json"))
    ) {
      sendHtml(res, htmlPath);
      return;
    }
    res.writeHead(response.status, out);
    res.end(buf);
  } catch (err) {
    if (htmlPath && fs.existsSync(htmlPath) && wantsDocument(req)) {
      sendHtml(res, htmlPath);
      return;
    }
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(err instanceof Error ? err.message : "Server error");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Fathomrail listening on http://127.0.0.1:${port}`);
});
