'use strict';

/**
 * Backend child-process supervisor.
 *
 * The old CodeBase ran the Express server inside the Electron main process, which
 * made startup fragile and blocked the UI. The backend now runs as its own Node
 * process (ELECTRON_RUN_AS_NODE), on a dynamically chosen free port, with a
 * per-launch auth token, and it is restarted automatically if it crashes.
 *
 * Ollama lifecycle is owned by the backend (/api/system/ollama/*) — the supervisor
 * simply drives those endpoints so the user never has to open a terminal.
 */

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const MAX_RESTARTS = 3;

class Supervisor extends EventEmitter {
  constructor({ app, isDev = false, logger = console } = {}) {
    super();
    this.app = app;
    this.logger = logger;
    this.isDev = isDev;
    this.child = null;
    this.port = 0;
    this.token = crypto.randomBytes(24).toString('hex');
    this.status = { running: false, starting: false, restarts: 0, port: 0, error: '', pid: 0 };
    this.restarts = 0;
    this.intentionalStop = false;
    this.readyWaiters = [];
    this.logBuffer = [];
  }

  get apiBase() {
    return this.port ? `http://127.0.0.1:${this.port}/api` : '';
  }

  logs(limit = 200) {
    return this.logBuffer.slice(-limit);
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch, port: this.port, token: undefined };
    this.emit('status', this.status);
  }

  resolveBackendEntry() {
    if (this.app?.isPackaged) {
      return path.join(process.resourcesPath, 'backend', 'dist', 'server.mjs');
    }
    return path.resolve(__dirname, '..', 'backend', 'src', 'server.js');
  }

  resolveWebDir() {
    if (this.app?.isPackaged) return path.join(process.resourcesPath, 'web');
    return path.resolve(__dirname, '..', 'frontend', 'dist');
  }

  dataDir() {
    const base = this.app?.getPath?.('userData') || path.join(os.homedir(), 'AppData', 'Roaming', 'CodeBase');
    return path.join(base, 'data');
  }

  /** Start the backend; resolves with `{ port, apiBase }` once it reports READY. */
  async start() {
    if (this.child) return { port: this.port, apiBase: this.apiBase };
    const entry = this.resolveBackendEntry();
    if (!fs.existsSync(entry)) {
      throw new Error(
        `Backend topilmadi: ${entry}\n\nIshlab chiqishda: npm run build:backend. O‘rnatilgan ilovada: qayta o‘rnating.`
      );
    }

    const dataDir = this.dataDir();
    fs.mkdirSync(dataDir, { recursive: true });

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CODEBASE_PORT: '0', // let the OS pick a free port — no more "port 3030 is busy"
      CODEBASE_HOST: '127.0.0.1',
      CODEBASE_TOKEN: this.token,
      CODEBASE_DATA_DIR: dataDir,
      CODEBASE_VERSION: this.app?.getVersion?.() || '1.0.0',
      CODEBASE_ELECTRON: process.versions.electron || '',
      CODEBASE_LOG: process.env.CODEBASE_LOG || 'info'
    };

    const webDir = this.resolveWebDir();
    if (fs.existsSync(path.join(webDir, 'index.html'))) env.CODEBASE_WEB_DIR = webDir;

    this.intentionalStop = false;
    this.setStatus({ starting: true, running: false, error: '' });

    const child = spawn(process.execPath, [entry], {
      env,
      cwd: path.dirname(entry),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    this.child = child;
    this.setStatus({ pid: child.pid });

    const onLine = (line) => {
      if (!line) return;
      this.logBuffer.push(line);
      if (this.logBuffer.length > 400) this.logBuffer.shift();
      this.logger.log?.(`[backend] ${line}`);
      const match = /CODEBASE_READY\s+(\{.*\})/.exec(line);
      if (match) {
        try {
          const info = JSON.parse(match[1]);
          this.port = Number(info.port) || this.port;
          this.setStatus({ running: true, starting: false, restarts: this.restarts, pid: info.pid || child.pid });
          for (const waiter of this.readyWaiters.splice(0)) waiter.resolve({ port: this.port, apiBase: this.apiBase, info });
        } catch (error) {
          this.logger.warn?.(`READY qatorini o‘qib bo‘lmadi: ${error.message}`);
        }
      }
    };

    let stdoutBuffer = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      let index = stdoutBuffer.indexOf('\n');
      while (index >= 0) {
        onLine(stdoutBuffer.slice(0, index).trim());
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        index = stdoutBuffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) onLine(line.trim());
    });

    child.on('exit', (code, signal) => this.onExit(code, signal));

    return this.waitForReady(30_000);
  }

  waitForReady(timeoutMs = 30_000) {
    if (this.status.running && this.port) return Promise.resolve({ port: this.port, apiBase: this.apiBase });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Backend ${Math.round(timeoutMs / 1000)} soniyada ishga tushmadi.\n${this.logs(12).join('\n')}`));
      }, timeoutMs);
      this.readyWaiters.push({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        }
      });
    });
  }

  onExit(code, signal) {
    const wasIntentional = this.intentionalStop;
    this.child = null;
    this.setStatus({ running: false, starting: false, pid: 0 });
    this.logger.warn?.(`Backend to‘xtadi (code=${code}, signal=${signal})`);
    if (wasIntentional || this.app?.isQuitting) return;

    if (this.restarts < MAX_RESTARTS) {
      this.restarts += 1;
      const delay = 1000 * 2 ** (this.restarts - 1);
      this.setStatus({ error: `Backend qayta ishga tushirilmoqda (${this.restarts}/${MAX_RESTARTS})...` });
      setTimeout(() => {
        this.start().catch((error) => {
          this.logger.error?.(`Qayta ishga tushirish muvaffaqiyatsiz: ${error.message}`);
          this.setStatus({ error: error.message });
        });
      }, delay);
    } else {
      this.setStatus({ error: 'Backend qayta-qayta to‘xtadi. Ilovani qayta oching.' });
    }
  }

  killTree() {
    const child = this.child;
    if (!child?.pid) return;
    this.intentionalStop = true;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, 2_000).unref?.();
      }
    } catch (error) {
      this.logger.warn?.(`Backend to‘xtatilmadi: ${error.message}`);
    }
  }

  async stop() {
    this.killTree();
    this.child = null;
    this.setStatus({ running: false, starting: false, pid: 0 });
  }

  async restart() {
    await this.stop();
    this.restarts = 0;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return this.start();
  }

  // ── backend API helpers (Ollama lifecycle lives in the backend) ─────────────

  async apiFetch(pathname, { method = 'GET', body, timeoutMs = 20_000 } = {}) {
    if (!this.port) throw new Error('Backend hali tayyor emas.');
    const response = await fetch(`${this.apiBase}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CodeBase-Token': this.token },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async ollamaStatus() {
    try {
      return await this.apiFetch('/system/ollama');
    } catch (error) {
      return { connected: false, error: error.message };
    }
  }

  /** Boot Ollama if it is not running — the fix for the "keep CMD open" problem. */
  async ensureOllama() {
    setImmediate(() => {
      this.apiFetch('/system/ollama/start', { method: 'POST', body: { force: false }, timeoutMs: 60_000 })
        .then((result) => {
          this.logger.log?.(`Ollama: ${result.ok ? 'online' : result.error || 'javob yo‘q'}`);
          this.emit('ollama', result);
        })
        .catch((error) => this.emit('ollama', { ok: false, error: error.message }));
    });
  }

  async startOllama() {
    return this.apiFetch('/system/ollama/start', { method: 'POST', body: { force: true }, timeoutMs: 60_000 });
  }

  async stopOllama() {
    return this.apiFetch('/system/ollama/stop', { method: 'POST', timeoutMs: 30_000 });
  }

  async autostartEnabled() {
    const data = await this.apiFetch('/system/ollama/autostart').catch(() => ({ enabled: false }));
    return Boolean(data.enabled);
  }

  async setAutostart(enabled) {
    const data = await this.apiFetch('/system/ollama/autostart', {
      method: 'POST',
      body: { enabled: Boolean(enabled) },
      timeoutMs: 30_000
    });
    return Boolean(data.enabled);
  }
}

module.exports = { Supervisor, MAX_RESTARTS };
