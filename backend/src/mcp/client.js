import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { flattenContent, parseToolResult, stringifyValue } from './types.js';

/** MCP revision we propose during `initialize` (servers may negotiate down). */
export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const CLIENT_NAME = 'codebase-agent';
export const CLIENT_VERSION = '1.0.0';
/** Per-request timeout when the caller does not pass `timeoutMs` (§11). */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** How long `stop()` waits for a graceful exit before killing the process tree. */
const KILL_GRACE_MS = 1_500;
/** Hard cap for one buffered JSON-RPC line (defensive: broken servers can spam). */
const MAX_BUFFER_CHARS = 8 * 1024 * 1024;
/** Cap for the captured stderr tail exposed as `lastError`. */
const STDERR_TAIL_CHARS = 2_000;

/**
 * Spawn a stdio MCP server and talk JSON-RPC 2.0 over newline-delimited JSON.
 *
 * Events:
 *  - `'exit'` `{ code, signal }` — the child process ended (always emitted).
 *  - `'stderr'` `string` — a chunk of the child's stderr (also kept in `lastError`).
 *
 * @extends {EventEmitter}
 */
export class McpClient extends EventEmitter {
  /**
   * @param {import('./types.js').McpServerConfig} server
   * @param {{ logger?: { debug?: Function, info?: Function, warn?: Function, error?: Function },
   *           timeoutMs?: number,
   *           spawnImpl?: typeof spawn }} [options]
   */
  constructor(server, options = {}) {
    super();
    const config = server && typeof server === 'object' ? server : /** @type {any} */ ({});
    /** @type {import('./types.js').McpServerConfig} */
    this.server = {
      id: config.id ?? null,
      name: typeof config.name === 'string' && config.name ? config.name : 'mcp-server',
      command: typeof config.command === 'string' ? config.command : '',
      args: Array.isArray(config.args) ? config.args.filter((arg) => typeof arg === 'string') : [],
      env: config.env && typeof config.env === 'object' ? config.env : {},
      cwd: typeof config.cwd === 'string' && config.cwd ? config.cwd : undefined
    };
    this.logger = options.logger || null;
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0
      ? Number(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
    // Injectable for tests / alternative transports; defaults to node:child_process.
    this.spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn;

    /** @type {import('./types.js').McpStatus} */
    this.status = 'stopped';
    /** @type {string|undefined} */
    this.lastError = undefined;
    /** @type {any} */
    this.serverInfo = undefined;
    /** @type {any} */
    this.capabilities = undefined;

    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null;
    /** @type {Map<number, {resolve: Function, reject: Function, timer: any, method: string}>} */
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.stderrTail = '';
    this.stopping = false;
    this.exited = false;
    this.exitInfo = null;
  }

  /**
   * Spawn the child, perform the `initialize` handshake and send
   * `notifications/initialized`.
   * @returns {Promise<{ serverInfo: any, capabilities: any }>}
   */
  async start() {
    if (this.status === 'ready') return { serverInfo: this.serverInfo, capabilities: this.capabilities };
    if (this.child) throw new Error(`MCP "${this.server.name}" allaqachon ishga tushirilgan.`);
    if (!this.server.command) throw new Error(`MCP "${this.server.name}": command ko‘rsatilmagan.`);

    this.status = 'starting';
    this.lastError = undefined;
    this.stopping = false;
    this.exited = false;
    this.exitInfo = null;
    this.buffer = '';
    this.stderrTail = '';

    const spec = resolveSpawnSpec(this.server);
    this.log(`debug`, `starting MCP "${this.server.name}": ${describeCommand(spec)}`);

    let child;
    try {
      child = this.spawnImpl(spec.command, spec.args, {
        cwd: this.server.cwd || process.env.CODEBASE_DATA_DIR || process.cwd(),
        env: buildEnv(this.server.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true
      });
    } catch (error) {
      this.status = 'error';
      this.lastError = `Spawn failed: ${describeError(error)}`;
      throw new Error(`MCP "${this.server.name}" ishga tushmadi: ${this.lastError}`);
    }

    this.child = child;
    attachStdio(child, this);

    try {
      const result = await this.call('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { roots: { listChanged: false }, sampling: {} },
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION }
      });
      if (this.stopping || this.child !== child) {
        throw new Error(`MCP "${this.server.name}" to‘xtatildi (initialize paytida).`);
      }
      this.serverInfo = result?.serverInfo ?? null;
      this.capabilities = result?.capabilities ?? null;
      this.status = 'ready';
      // Fire-and-forget notification: the server must not answer it.
      this._writeMessage({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      if (this.stopping) throw new Error(`MCP "${this.server.name}" to‘xtatildi (initialize paytida).`);
      this.log('info', `MCP "${this.server.name}" tayyor (${this.serverInfo?.name || 'unknown server'} ${this.serverInfo?.version || ''})`.trim());
      return { serverInfo: this.serverInfo, capabilities: this.capabilities };
    } catch (error) {
      const message = describeError(error);
      if (!this.lastError) this.lastError = message;
      if (this.status !== 'crashed') this.status = this.stopping ? 'stopped' : 'error';
      if (this.child) await this.stop();
      throw new Error(`MCP "${this.server.name}" initialize muvaffaqiyatsiz: ${message}`);
    }
  }

  /**
   * Stop the server: graceful stdin close, then kill the whole process tree on
   * Windows (`taskkill /pid <pid> /T /F`). Idempotent and never throws.
   * @returns {Promise<void>}
   */
  async stop() {
    const child = this.child;
    const wasStopping = this.stopping;
    this.stopping = true;
    this._failAll(new Error(`MCP "${this.server.name}" to‘xtatildi.`));
    this.removeAllListeners('exit');
    this.removeAllListeners('stderr');

    if (!child) {
      this.status = 'stopped';
      this.buffer = '';
      this.stopping = wasStopping;
      return;
    }

    let exited = false;
    const waitForExit = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) {
        exited = true;
        return resolve(undefined);
      }
      const timer = setTimeout(() => resolve(undefined), KILL_GRACE_MS);
      // Keep this ref'd: `stop()` awaits it, and an unref'd timer would let the process
      // exit before the graceful-shutdown window elapsed.
      child.once('exit', () => {
        exited = true;
        clearTimeout(timer);
        resolve(undefined);
      });
    });

    try {
      child.stdin?.end();
    } catch {
      // stdin may already be closed; ignore.
    }

    await waitForExit;
    if (!exited) await killProcessTree(child);

    this.child = null;
    this.buffer = '';
    this.status = 'stopped';
    this.stopping = wasStopping;
  }

  /**
   * Perform a JSON-RPC request and await its response.
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  async call(method, params = {}, timeoutMs) {
    if (!this.child || this.exited) {
      throw this._fail(new Error(`MCP "${this.server.name}" ishlamayapti (status: ${this.status}).`), method);
    }
    const id = this.nextId++;
    const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Number(timeoutMs) : this.timeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        const error = new Error(`MCP "${this.server.name}" "${method}" javob bermadi (${effectiveTimeout} ms timeout).`);
        this.lastError = error.message;
        reject(error);
      }, effectiveTimeout);
      // Deliberately NOT unref'd: a pending JSON-RPC request is real work. With an
      // unref'd timer a short-lived process (a test file, a CLI run) can run out of
      // handles and exit while the request is still pending, which surfaces as
      // "Promise resolution is still pending but the event loop has already resolved".

      this.pending.set(id, { resolve, reject, timer, method });
      const sent = this._writeMessage({ jsonrpc: '2.0', id, method, params: params ?? {} });
      if (!sent) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(this._fail(new Error(`MCP "${this.server.name}": "${method}" so‘rovini yuborib bo‘lmadi (stdin yopiq).`), method));
      }
    });
  }

  /**
   * Send a notification (no id, no response expected).
   * @param {string} method
   * @param {object} [params]
   * @returns {boolean} true when the message reached the child's stdin.
   */
  notify(method, params = {}) {
    return this._writeMessage({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  /**
   * @returns {Promise<import('./types.js').McpTool[]>}
   */
  async listTools() {
    const result = await this.call('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  /**
   * @param {string} name
   * @param {object} [args]
   * @returns {Promise<import('./types.js').McpToolCallResult>}
   */
  async callTool(name, args = {}) {
    const result = await this.call('tools/call', { name, arguments: args ?? {} });
    const parsed = parseToolResult(result);
    return { ...(result && typeof result === 'object' ? result : {}), content: parsed.content, isError: parsed.isError || undefined };
  }

  /**
   * @returns {Promise<import('./types.js').McpResource[]>}
   */
  async listResources() {
    const result = await this.call('resources/list', {});
    return Array.isArray(result?.resources) ? result.resources : [];
  }

  /**
   * @param {string} uri
   * @returns {Promise<{ contents: any[] }>}
   */
  async readResource(uri) {
    const result = await this.call('resources/read', { uri });
    return { ...(result && typeof result === 'object' ? result : {}), contents: Array.isArray(result?.contents) ? result.contents : [] };
  }

  /**
   * @returns {Promise<import('./types.js').McpPrompt[]>}
   */
  async listPrompts() {
    const result = await this.call('prompts/list', {});
    return Array.isArray(result?.prompts) ? result.prompts : [];
  }

  /**
   * @param {string} name
   * @param {object} [args]
   * @returns {Promise<{ messages: any[] }>}
   */
  async getPrompt(name, args = {}) {
    const result = await this.call('prompts/get', { name, arguments: args ?? {} });
    return { ...(result && typeof result === 'object' ? result : {}), messages: Array.isArray(result?.messages) ? result.messages : [] };
  }

  /**
   * Convenience: `tools/call` result flattened to text (§11).
   * @param {string} name
   * @param {object} [args]
   * @returns {Promise<string>}
   */
  async callToolText(name, args = {}) {
    const result = await this.callTool(name, args);
    return flattenContent(result.content);
  }

  /**
   * Push `message` into `lastError` and return it (never throws).
   * @private
   */
  _fail(error, method) {
    const message = describeError(error);
    this.lastError = method ? `[${method}] ${message}` : message;
    return error instanceof Error ? error : new Error(message);
  }

  /** @private */
  _failAll(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      try {
        entry.reject(error);
      } catch {
        // A rejected promise must never escape as an unhandled rejection here.
      }
    }
  }

  /** @private */
  _writeMessage(message) {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed || !child.stdin.writable) return false;
    try {
      // Newline-delimited JSON-RPC 2.0 — no Content-Length framing (§11).
      return child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.log('warn', `MCP "${this.server.name}" yozishda xato: ${describeError(error)}`);
      return false;
    }
  }

  /** @private */
  _respond(id, result, error) {
    const payload = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result };
    this._writeMessage(payload);
  }

  /** @private */
  _onLine(line) {
    const text = line.trim();
    if (!text) return; // tolerate blank lines
    if (/^content-length:/i.test(text)) return; // tolerate stray LSP framing headers

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.log('warn', `MCP "${this.server.name}": JSON parse xatosi, satr tashlandi (${text.slice(0, 120)})`);
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;

    // Server → client request: answer immediately so the server never hangs.
    if (message.method !== undefined) {
      if (message.id === undefined || message.id === null) {
        this.log('debug', `MCP "${this.server.name}" notification: ${String(message.method)}`);
        return;
      }
      this.log('debug', `MCP "${this.server.name}" server so‘rovi rad etildi: ${String(message.method)}`);
      this._respond(message.id, undefined, { code: -32601, message: 'Method not found' });
      return;
    }

    if (message.id === undefined) return;
    const entry = this.pending.get(message.id);
    if (!entry) {
      this.log('debug', `MCP "${this.server.name}": kutilmagan javob id=${String(message.id)}`);
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      const detail = message.error?.message || stringifyValue(message.error, 300);
      entry.reject(this._fail(new Error(`${detail} (code ${message.error?.code ?? 'unknown'})`), entry.method));
      return;
    }
    entry.resolve(message.result);
  }

  /** @private */
  _handleData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_BUFFER_CHARS) {
      this.log('warn', `MCP "${this.server.name}": stdout buffer limiti oshdi, tozalandi.`);
      this.buffer = '';
      return;
    }
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this._onLine(raw.replace(/\r$/, ''));
      index = this.buffer.indexOf('\n');
    }
  }

  /** @private */
  _handleExit(code, signal, unexpected) {
    const child = this.child;
    this.exited = true;
    this.exitInfo = { code: code ?? null, signal: signal ?? null };
    this.child = null;
    this.buffer = '';
    this._failAll(new Error(`MCP "${this.server.name}" processi to‘xtadi (code ${code ?? 'null'}).`));

    if (unexpected && !this.stopping) {
      this.status = 'crashed';
      if (!this.lastError) {
        this.lastError = `Process exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`;
      }
      this.log('warn', `MCP "${this.server.name}" kutilmaganda to‘xtadi (code ${code ?? 'null'}${signal ? `, ${signal}` : ''}).`);
    } else if (this.status !== 'stopped') {
      this.status = this.stopping ? 'stopped' : 'crashed';
    }

    try {
      this.emit('exit', { code: code ?? null, signal: signal ?? null });
    } catch (error) {
      this.log('error', `MCP "${this.server.name}" 'exit' handler xatosi: ${describeError(error)}`);
    }
  }

  /** @private */
  log(level, message) {
    const fn = this.logger?.[level] || this.logger?.info;
    if (typeof fn === 'function') {
      try {
        fn.call(this.logger, message);
      } catch {
        // Logging must never break the transport.
      }
    }
  }
}

/**
 * Attach stdio handlers to a freshly spawned child.
 * @param {import('node:child_process').ChildProcess} child
 * @param {McpClient} client
 */
function attachStdio(child, client) {
  const stdout = child.stdout;
  if (stdout) {
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk) => {
      try {
        client._handleData(chunk);
      } catch (error) {
        client.log('error', `MCP "${client.server.name}" stdout handler xatosi: ${describeError(error)}`);
      }
    });
    stdout.on('error', () => {});
  }

  const stderr = child.stderr;
  if (stderr) {
    stderr.setEncoding('utf8');
    stderr.on('data', (chunk) => {
      const text = String(chunk);
      client.stderrTail = `${client.stderrTail}${text}`.slice(-STDERR_TAIL_CHARS);
      client.log('debug', `MCP "${client.server.name}" stderr: ${text.trim().slice(0, 300)}`);
      try {
        client.emit('stderr', text);
      } catch {
        // Ignore listener failures.
      }
    });
    stderr.on('error', () => {});
  }

  if (child.stdin) {
    // EPIPE after an unexpected child exit must not become an unhandled error.
    child.stdin.on('error', () => {});
  }

  child.on('error', (error) => {
    client.lastError = `Process error: ${describeError(error)}`;
    if (client.status !== 'crashed' && !client.stopping) client.status = 'crashed';
    client.child = null;
    client.exited = true;
    client._failAll(error instanceof Error ? error : new Error(describeError(error)));
    try {
      client.emit('exit', { code: null, signal: null, error: describeError(error) });
    } catch {
      // Ignore listener failures.
    }
  });

  child.on('exit', (code, signal) => {
    const unexpected = !client.stopping;
    try {
      client._handleExit(code, signal, unexpected);
    } catch (error) {
      client.log('error', `MCP "${client.server.name}" exit handler xatosi: ${describeError(error)}`);
    }
  });
}

/**
 * Kill the child and everything it spawned. On Windows `taskkill /pid /T /F`
 * terminates the whole tree; elsewhere a plain SIGTERM/SIGKILL is used.
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<void>}
 */
export function killProcessTree(child) {
  return new Promise((resolve) => {
    const pid = child?.pid;
    if (!pid) return resolve(undefined);
    const finish = () => resolve(undefined);
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false });
        const timer = setTimeout(finish, KILL_GRACE_MS);
        // Ref'd on purpose: callers await this promise.
        killer.on('error', () => {
          clearTimeout(timer);
          try {
            child.kill();
          } catch {
            // Ignore: process already gone.
          }
          finish();
        });
        killer.on('close', () => {
          clearTimeout(timer);
          finish();
        });
        return;
      }
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore: process already gone.
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore: process already gone.
        }
        finish();
      }, 500);
      // Ref'd on purpose: callers await this promise.
      child.once('exit', () => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      finish();
    }
  });
}

/**
 * Merge `process.env` with the server-specific environment (strings only).
 * @param {Record<string, unknown>} extra
 * @returns {Record<string, string>}
 */
export function buildEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (value === undefined || value === null) continue;
    env[key] = String(value);
  }
  return env;
}

/**
 * Resolve what to actually spawn. `shell:false` is kept in all cases; on
 * Windows a command that is not on PATH (e.g. the `npx.cmd` shim) is routed
 * through `cmd.exe /d /s /c`, because CreateProcess cannot run `.cmd`/`.bat`.
 * @param {import('./types.js').McpServerConfig} server
 * @param {{ platform?: string, env?: Record<string, string> }} [options]
 * @returns {{ command: string, args: string[], wrapped: boolean }}
 */
export function resolveSpawnSpec(server, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || buildEnv(server.env);
  const command = String(server.command || '');
  const args = Array.isArray(server.args) ? server.args.map((arg) => String(arg)) : [];
  if (platform !== 'win32' || env.MCP_NO_CMD_WRAP === '1') return { command, args, wrapped: false };
  if (isOnPath(command, env)) return { command, args, wrapped: false };
  return {
    command: env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', formatCmdLine(command, args)],
    wrapped: true
  };
}

/** @param {string} command @param {Record<string, string>} env */
function isOnPath(command, env) {
  if (!command) return false;
  if (command.includes('/') || command.includes('\\')) return isFile(command);
  const pathValue = env.PATH || env.Path || '';
  const exts = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const base = path.join(dir, command);
    if (isFile(base)) return true;
    if (!path.extname(command)) {
      for (const ext of exts) {
        if (isFile(`${base}${ext}`)) return true;
      }
    }
  }
  return false;
}

/** @param {string} candidate */
function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Quote a command line for `cmd.exe /d /s /c` (all-args-quoted form).
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
export function formatCmdLine(command, args = []) {
  return [command, ...args].map(quoteCmdArg).join(' ');
}

/** @param {unknown} value */
function quoteCmdArg(value) {
  const text = String(value ?? '');
  if (!text) return '""';
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}

/** @param {{command: string, args: string[]}} spec */
function describeCommand(spec) {
  return [spec.command, ...spec.args].join(' ');
}

/** @param {unknown} error */
export function describeError(error) {
  if (error instanceof Error) return error.message || error.name || 'Error';
  if (error && typeof error === 'object') return stringifyValue(error, 500);
  return String(error);
}

export default McpClient;
