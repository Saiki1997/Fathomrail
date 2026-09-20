import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.env.PORT || 17331);
const staticDir = process.env.FATHOMRAIL_STATIC;
const entry = process.env.FATHOMRAIL_ENTRY;

if (!staticDir || !entry) {
  console.error("FATHOMRAIL_STATIC and FATHOMRAIL_ENTRY are required");
  process.exit(1);
}

const mod = await import(pathToFileURL(entry).href);
const fetchFn = mod.default?.fetch ?? mod.fetch;
if (typeof fetchFn !== "function") {
  console.error("Server entry has no fetch handler");
  process.exit(1);
}

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
};

function tryStatic(urlPath, res) {
  const rel = decodeURIComponent((urlPath.split("?")[0] ?? "/").replace(/^\/+/, ""));
  if (!rel) return false;
  const file = path.resolve(staticDir, rel);
  const root = path.resolve(staticDir);
  if (!file.startsWith(root + path.sep) && file !== root) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = createServer(async (req, res) => {
  try {
    if (tryStatic(req.url ?? "/", res)) return;
    const url = `http://127.0.0.1:${port}${req.url ?? "/"}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
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
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(err instanceof Error ? err.message : "Server error");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Fathomrail listening on http://127.0.0.1:${port}`);
});
