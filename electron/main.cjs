'use strict';

/**
 * CodeBase Agent — Electron main process.
 *
 * Responsibilities: single instance, backend child process (dynamic port + token),
 * secure window with a preload bridge, native dialogs, and clean shutdown of every
 * child process (backend + MCP servers, which are children of the backend).
 */

const { app, BrowserWindow, dialog, shell, ipcMain, Menu, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Supervisor } = require('./supervisor.cjs');

const isDev = !app.isPackaged;
app.setName('CodeBase');
app.setAppUserModelId('com.codebase.localai');
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'CodeBase'));
} catch {
  /* keep the default path */
}

let mainWindow = null;
let supervisor = null;
const log = (...args) => console.log('[CodeBase]', ...args);
app.isQuitting = false;

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('before-quit', async () => {
    app.isQuitting = true;
    if (supervisor) {
      await supervisor.stop().catch(() => {});
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && supervisor?.status?.running) createWindow();
  });

  app.whenReady().then(bootstrap).catch((error) => {
    fatal(error);
  });
}

async function bootstrap() {
  Menu.setApplicationMenu(null);
  nativeTheme.themeSource = 'dark';

  supervisor = new Supervisor({ app, isDev, logger: console });
  supervisor.on('status', (status) => broadcast('codebase:status', { backend: status }));
  supervisor.on('ollama', (result) => broadcast('codebase:status', { ollama: result }));

  try {
    await supervisor.start();
  } catch (error) {
    fatal(error);
    return;
  }

  registerIpc();
  createWindow();

  // Start Ollama in the background so the user never needs a terminal window.
  supervisor.ensureOllama();
}

function registerIpc() {
  ipcMain.handle('codebase:system-info', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    userData: app.getPath('userData'),
    isPackaged: app.isPackaged,
    port: supervisor.port,
    apiBase: supervisor.apiBase
  }));

  ipcMain.handle('codebase:pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Workspace papkani tanlang',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Tanlash'
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('codebase:open-path', async (_event, target) => {
    if (typeof target !== 'string' || !target) return { ok: false, error: 'Yo‘l bo‘sh.' };
    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved)) return { ok: false, error: 'Yo‘l topilmadi.' };
    const error = await shell.openPath(resolved);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle('codebase:show-in-folder', (_event, target) => {
    if (typeof target !== 'string' || !target) return { ok: false };
    shell.showItemInFolder(path.resolve(target));
    return { ok: true };
  });

  ipcMain.handle('codebase:ollama-status', () => supervisor.ollamaStatus());
  ipcMain.handle('codebase:ollama-start', () => supervisor.startOllama());
  ipcMain.handle('codebase:ollama-stop', () => supervisor.stopOllama());
  ipcMain.handle('codebase:ollama-autostart-get', () => supervisor.autostartEnabled());
  ipcMain.handle('codebase:ollama-autostart-set', (_event, enabled) => supervisor.setAutostart(enabled));
  ipcMain.handle('codebase:backend-restart', async () => {
    await supervisor.restart();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    return { ok: true, port: supervisor.port };
  });
  ipcMain.handle('codebase:backend-logs', () => supervisor.logs(200));
  ipcMain.handle('codebase:open-external', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false };
  });
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'CodeBase Agent',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      additionalArguments: [
        `--codebase-port=${supervisor.port}`,
        `--codebase-token=${supervisor.token}`,
        `--codebase-version=${app.getVersion()}`
      ]
    }
  });

  const url = `http://127.0.0.1:${supervisor.port}/`;
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    broadcast('codebase:status', { backend: supervisor.status });
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url) && !target.startsWith(`http://127.0.0.1:${supervisor.port}`)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    }
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('Renderer crashed:', details.reason);
    if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
  });

  mainWindow.loadURL(url).catch((error) => {
    dialog.showErrorBox('CodeBase yuklanmadi', `${error.message}\n\nBackend: http://127.0.0.1:${supervisor.port}/`);
  });
}

function fatal(error) {
  const message = error?.message || String(error);
  log('FATAL', message);
  try {
    dialog.showErrorBox(
      'CodeBase ishga tushmadi',
      `${message}\n\nBackend loglari:\n${(supervisor?.logs(15) || []).join('\n') || '(yo‘q)'}`
    );
  } catch {
    /* dialog may be unavailable */
  }
  app.quit();
}
