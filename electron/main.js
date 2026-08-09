const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const net = require("net");
const { spawn } = require("child_process");

let serverProcess = null;
let mainWindow = null;
let quitting = false;

// Give the internal HTTP server a fixed range; pick the first free port so the
// packaged app never dies because 8787 (or any preferred port) is already taken.
const PREFERRED_PORT = Number(process.env.PORT || 8787);
const MAX_PORT_TRIES = 20;
let SERVER_PORT = PREFERRED_PORT;
let APP_URL = "";

function resolveServerEntry() {
  // In a packaged app the server may live at app.asar/app or (if electron-builder
  // unpacks it) at app.asar.unpacked. In "dev" it is ../server. ELECTRON_RUN_AS_NODE
  // can require from inside the asar; this order works for every case.
  const unpacked = path.join(process.resourcesPath, "app.asar.unpacked", "server", "src", "index.js");
  if (fs.existsSync(unpacked)) return unpacked;
  const dev = path.join(__dirname, "..", "server", "src", "index.js");
  if (fs.existsSync(dev)) return dev;
  return path.join(process.resourcesPath, "app", "server", "src", "index.js");
}

// Find a free local port starting at the preferred one (no fast-forwards). This
// avoids clashing with an existing PID on a laptop that already runs another app.
function findFreePort(start, tries) {
  return new Promise((resolve) => {
    const attempt = (port, remaining) => {
      const server = net.createServer();
      server.unref();
      server.on("error", () => remaining > 0 ? attempt(port + 1, remaining - 1) : resolve(null));
      server.listen(port, "127.0.0.1", () => {
        const { port: boundPort } = server.address();
        server.close(() => resolve(boundPort));
      });
    };
    attempt(start, tries);
  });
}

function startServer() {
  const userData = app.getPath("userData");
  process.env.DATA_DIR = process.env.DATA_DIR || path.join(userData, "data");
  process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(userData, "agent-workspaces");
  // Desktop sessions are served from this local origin only; never reuse a
  // tunnel url from the bundled .env (CORS + GitHub redirects).
  process.env.ALLOWED_ORIGIN = APP_URL;
  process.env.GITHUB_REDIRECT_URI = `${APP_URL}/api/github/callback`;
  process.env.PORT = String(SERVER_PORT);

  const entry = resolveServerEntry();
  serverProcess = spawn(process.execPath, [entry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    windowsHide: true
  });
  serverProcess.on("error", (error) => console.error("Failed to start Alutra server:", error));
  serverProcess.on("exit", (code) => {
    if (!quitting && code !== 0) console.error(`Alutra server exited with code ${code}`);
  });
}

function serverReady(timeoutMs = 25000) {
  const url = `${APP_URL}/api/providers`;
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) return resolve(true);
      } catch {}
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 300);
    };
    tick();
  });
}

function createWindow() {
  const iconPath = path.join(__dirname, "..", "build", "icon.png");
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#111411",
    title: "Alutra Code",
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  const tryLoad = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.loadURL(APP_URL).catch(() => {
      setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) tryLoad(); }, 1000);
    });
  };
  tryLoad();
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  const boundPort = await findFreePort(PREFERRED_PORT, MAX_PORT_TRIES);
  SERVER_PORT = boundPort || PREFERRED_PORT;
  APP_URL = `http://localhost:${SERVER_PORT}`;

  startServer();
  const started = await serverReady();
  if (!started) console.error("Alutra server did not start. Review the console output above.");
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  if (serverProcess) { try { serverProcess.kill(); } catch {} }
});
