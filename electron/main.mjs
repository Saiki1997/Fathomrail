import { app, BrowserWindow, dialog, shell, utilityProcess } from "electron";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let child = null;
let win = null;

function pickPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 17331;
      s.close(() => resolve(port));
    });
  });
}

function waitFor(url, timeoutMs = 45000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve(true);
          return;
        }
        if (Date.now() - start > timeoutMs) reject(new Error("App server returned " + res.statusCode));
        else setTimeout(tick, 250);
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error("App server did not start"));
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
}

function resourcePaths() {
  if (app.isPackaged) {
    const root = path.join(process.resourcesPath, "output");
    return {
      boot: path.join(root, "boot-server.mjs"),
      staticDir: path.join(root, "static"),
      entry: path.join(root, "server", "index.mjs"),
      html: path.join(root, "prerender.html"),
    };
  }
  return {
    boot: path.join(__dirname, "boot-server.mjs"),
    staticDir: path.join(__dirname, "..", ".vercel", "output", "static"),
    entry: path.join(__dirname, "..", ".vercel", "output", "functions", "__server.func", "index.mjs"),
    html: path.join(__dirname, "prerender.html"),
  };
}

async function startServer() {
  if (process.env.FATHOMRAIL_DEV === "1") return 8080;
  const port = await pickPort();
  const { boot, staticDir, entry, html } = resourcePaths();
  if (!fs.existsSync(boot)) throw new Error(`Missing boot server at ${boot}`);
  if (!fs.existsSync(html)) throw new Error(`Missing UI shell at ${html}`);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.PORT = String(port);
  env.FATHOMRAIL_STATIC = staticDir;
  env.FATHOMRAIL_ENTRY = entry;
  env.FATHOMRAIL_HTML = html;
  env.NODE_ENV = "production";
  child = utilityProcess.fork(boot, [], {
    serviceName: "fathomrail-server",
    stdio: "pipe",
    env,
  });
  child.stderr?.on("data", (d) => process.stderr.write(d));
  child.stdout?.on("data", (d) => process.stdout.write(d));
  child.on("exit", (code) => {
    if (code && win) dialog.showErrorBox("Fathomrail", `Background server exited (${code}).`);
  });
  await waitFor(`http://127.0.0.1:${port}/`);
  return port;
}

async function createWindow(port) {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 640,
    title: "Fathomrail",
    backgroundColor: "#0b0b0c",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  await win.loadURL(`http://127.0.0.1:${port}/`);
  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(async () => {
  try {
    const port = await startServer();
    await createWindow(port);
  } catch (err) {
    dialog.showErrorBox("Fathomrail failed to start", err instanceof Error ? err.message : String(err));
    app.quit();
  }
});

app.on("window-all-closed", () => {
  child?.kill();
  app.quit();
});

app.on("before-quit", () => {
  child?.kill();
});
