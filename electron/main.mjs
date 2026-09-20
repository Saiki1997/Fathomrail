import { app, BrowserWindow, dialog, shell } from "electron";
import { spawn } from "node:child_process";
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
        resolve(true);
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
    return {
      boot: path.join(__dirname, "boot-server.mjs"),
      staticDir: path.join(process.resourcesPath, "output", "static"),
      entry: path.join(process.resourcesPath, "output", "server", "index.mjs"),
    };
  }
  return {
    boot: path.join(__dirname, "boot-server.mjs"),
    staticDir: path.join(__dirname, "..", ".vercel", "output", "static"),
    entry: path.join(__dirname, "..", ".vercel", "output", "functions", "__server.func", "index.mjs"),
  };
}

async function startServer() {
  if (process.env.FATHOMRAIL_DEV === "1") return 8080;
  const port = await pickPort();
  const { boot, staticDir, entry } = resourcePaths();
  if (!fs.existsSync(entry)) throw new Error(`Missing server bundle at ${entry}`);
  child = spawn(process.execPath, [boot], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(port),
      FATHOMRAIL_STATIC: staticDir,
      FATHOMRAIL_ENTRY: entry,
    },
    stdio: "pipe",
    windowsHide: true,
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
  if (child && !child.killed) child.kill();
  app.quit();
});

app.on("before-quit", () => {
  if (child && !child.killed) child.kill();
});
