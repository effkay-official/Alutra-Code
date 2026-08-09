const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const SERVER_PORT = Number(process.env.PORT || 8787);
const APP_URL = `http://localhost:${SERVER_PORT}`;

let serverProcess = null;
let mainWindow = null;
let quitting = false;

function resolveServerEntry() {
  const candidate = path.join(__dirname, "..", "server", "src", "index.js");
  if (fs.existsSync(candidate)) return candidate;
  return path.join(process.resourcesPath, "app", "server", "src", "index.js");
}

function startServer() {
  const userData = app.getPath("userData");
  process.env.DATA_DIR = process.env.DATA_DIR || path.join(userData, "data");
  process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(userData, "agent-workspaces");
  process.env.ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || APP_URL;

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

function serverReady(timeoutMs = 20000) {
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
