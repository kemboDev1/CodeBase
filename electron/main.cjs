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
app.isQuitting = false;

/**
 * File logger. A GUI app has no console on Windows, so without this file a startup
 * failure is invisible — which is exactly how the old build "silently did nothing".
 */
const logFile = (() => {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'main.log');
  } catch {
    return '';
  }
})();

function logLine(level, ...args) {
  const text = args
    .map((value) => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return `${value.message}\n${value.stack || ''}`;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(' ');
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${text}`;
  try {
    if (logFile) fs.appendFileSync(logFile, `${line}\n`);
  } catch {
    /* logging must never break startup */
  }
  if (isDev) process.stdout.write(`${line}\n`);
}

const log = (...args) => logLine('INFO', ...args);
const logger = {
  log: (...args) => logLine('INFO', ...args),
  warn: (...args) => logLine('WARN', ...args),
  error: (...args) => logLine('ERROR', ...args),
  debug: (...args) => logLine('DEBUG', ...args)
};

process.on('uncaughtException', (error) => logLine('FATAL', 'uncaughtException', error));
process.on('unhandledRejection', (reason) => logLine('FATAL', 'unhandledRejection', reason));

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
  log(`CodeBase ${app.getVersion()} ishga tushmoqda (packaged=${app.isPackaged}, electron=${process.versions.electron})`);
  log(`userData: ${app.getPath('userData')}`);
  Menu.setApplicationMenu(null);
  nativeTheme.themeSource = 'dark';

  supervisor = new Supervisor({ app, isDev, logger });
  supervisor.on('status', (status) => broadcast('codebase:status', { backend: status }));
  supervisor.on('ollama', (result) => broadcast('codebase:status', { ollama: result }));

  try {
    const info = await supervisor.start();
    log(`Backend tayyor: http://127.0.0.1:${info.port}`);
  } catch (error) {
    fatal(error);
    return;
  }

  registerIpc();
  createWindow();
  log('Oyna yaratildi.');

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
  // Renderer errors are otherwise invisible: a thrown error during render paints a blank
  // window and the main process never hears about it. Write them to main.log.
  mainWindow.webContents.on('console-message', (...args) => {
    const first = args[1];
    if (first && typeof first === 'object') {
      if (first.level === 'error' || first.level === 'warning' || first.level >= 2) {
        logLine('RENDERER', `${first.message} (${first.sourceId || ''}:${first.lineNumber || 0})`);
      }
      return;
    }
    const level = Number(first);
    if (level >= 2) logLine('RENDERER', `${args[2]} (${args[4] || ''}:${args[3] || 0})`);
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    logLine('ERROR', `Sahifa yuklanmadi: ${description} (${code}) ${url}`);
  });

  mainWindow.loadURL(url).catch((error) => {
    dialog.showErrorBox('CodeBase yuklanmadi', `${error.message}\n\nBackend: http://127.0.0.1:${supervisor.port}/`);
  });
}

function fatal(error) {
  const message = error?.message || String(error);
  logLine('FATAL', message, error);
  try {
    const details = `${message}\n\nLog fayli:\n${logFile}\n\nBackend loglari:\n${(supervisor?.logs(15) || []).join('\n') || '(yo‘q)'}`;
    dialog.showErrorBox('CodeBase ishga tushmadi', details);
  } catch {
    /* dialog may be unavailable in a non-interactive session */
  }
  app.quit();
}
