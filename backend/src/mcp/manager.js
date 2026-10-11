import { McpClient, describeError } from './client.js';
import { flattenContent, stringifyValue, toolNameFor, truncate } from './types.js';

/** Default per-request timeout for MCP clients (§11). */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Auto-restart budget: at most 3 restarts inside 5 minutes (§11). */
const RESTART_LIMIT = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1_000;
/** Delay before an automatic restart attempt. */
const RESTART_DELAY_MS = 1_000;
/** Text kept in a tool result before truncation. */
const MAX_TOOL_TEXT = 12_000;

/**
 * Create the MCP manager: owns one `McpClient` per server and mirrors their
 * tools into the agent tool registry (§11).
 *
 * @param {{
 *   store: { mcpServers?: any[] } | (() => any) | (() => Promise<any>),
 *   registry: { register: Function, get?: Function, list?: Function, unregister?: Function },
 *   logger?: { debug?: Function, info?: Function, warn?: Function, error?: Function },
 *   emit?: (event: object) => void,
 *   timeoutMs?: number,
 *   spawnImpl?: Function
 * }} deps
 */
export function createMcpManager({ store, registry, logger, emit, timeoutMs, spawnImpl } = {}) {
  if (!registry || typeof registry.register !== 'function') {
    throw new Error('createMcpManager: registry.register funksiyasi kerak.');
  }

  const log = makeLogger(logger);
  const safeEmit = makeEmitter(emit);
  const clientOptions = {
    logger: log,
    timeoutMs: Number.isFinite(timeoutMs) ? Number(timeoutMs) : DEFAULT_REQUEST_TIMEOUT_MS
  };
  if (typeof spawnImpl === 'function') clientOptions.spawnImpl = spawnImpl;

  /**
   * Live state per server id.
   * @type {Map<string, {
   *   id: string, server: any, client: McpClient|null, started: boolean,
   *   starting: Promise<any>|null, stopping: boolean, restarts: number[],
   *   restartAttempts: number, restartTimer: any, registered: string[], tools: any[]
   * }>}
   */
  const entries = new Map();

  /** Last server snapshot read from the store, so `list()` can stay synchronous. */
  const knownServers = new Map();

  /** @param {string} serverId */
  function entryFor(serverId) {
    const id = String(serverId ?? '');
    let entry = entries.get(id);
    if (!entry) {
      entry = {
        id,
        server: null,
        client: null,
        started: false,
        starting: null,
        stopping: false,
        restarts: [],
        restartAttempts: 0,
        restartTimer: null,
        registered: [],
        tools: []
      };
      entries.set(id, entry);
    }
    return entry;
  }

  async function resolveServers() {
    try {
      const value = typeof store === 'function' ? await store() : store;
      const servers = value && Array.isArray(value.mcpServers)
        ? value.mcpServers
        : (value && Array.isArray(value.servers) ? value.servers : []);
      knownServers.clear();
      for (const server of servers) {
        if (server && server.id !== undefined) knownServers.set(String(server.id), server);
      }
      return servers;
    } catch (error) {
      log.warn(`MCP store o‘qilmadi: ${describeError(error)}`);
      return [];
    }
  }

  /** @param {string} id */
  async function findServer(id) {
    const servers = await resolveServers();
    return servers.find((server) => String(server?.id) === String(id)) || null;
  }

  /** Remember a server even when `resolveServers()` was not the caller. */
  function rememberServer(server) {
    if (server && server.id !== undefined) knownServers.set(String(server.id), server);
    return server;
  }

  /** Best-effort synchronous store read so `list()` works without a prior start. */
  function readStoreSync() {
    try {
      if (store && typeof store === 'object' && !store.then) {
        if (Array.isArray(store.mcpServers)) return store.mcpServers;
        if (Array.isArray(store.servers)) return store.servers;
      }
    } catch {
      // Defensive: a store getter must never break listing.
    }
    return null;
  }

  async function persistStatus(server, status) {
    try {
      if (server && typeof server === 'object') server.lastStatus = status;
      const value = typeof store === 'function' ? await store() : store;
      const save = value && typeof value.saveStore === 'function'
        ? value.saveStore.bind(value)
        : (value && typeof value.save === 'function' ? value.save.bind(value) : null);
      if (save) await save();
    } catch (error) {
      log.debug(`MCP status saqlanmadi: ${describeError(error)}`);
    }
  }

  /** @param {{id: string, server: any, client: McpClient|null, started: boolean, restartAttempts?: number}} entry */
  function statusOf(entry) {
    // The restart budget is spent: the manager gave up on this server.
    if (entry.restartAttempts >= RESTART_LIMIT && !entry.client) return 'error';
    if (entry.client) return entry.client.status;
    if (entry.started) return 'ready';
    return entry.server?.lastStatus || 'stopped';
  }

  /** @param {{client: McpClient|null, server: any}} entry */
  function errorOf(entry) {
    return entry.client?.lastError ?? entry.server?.lastError ?? undefined;
  }

  /** @param {any} server */
  async function registerTools(server) {
    const entry = entryFor(server?.id);
    const client = entry.client;
    if (!client || client.status !== 'ready') {
      log.warn(`MCP "${server?.name}": tools ro‘yxatini olish uchun server tayyor emas.`);
      return [];
    }
    // Re-registering after a restart must replace the previous tools (§11).
    unregisterTools(entry);

    let tools = [];
    try {
      tools = await client.listTools();
    } catch (error) {
      client.lastError = describeError(error);
      log.warn(`MCP "${server?.name}": tools/list xatosi — ${client.lastError}`);
      return [];
    }

    const registered = [];
    const collected = [];
    for (const tool of Array.isArray(tools) ? tools : []) {
      const toolName = typeof tool?.name === 'string' ? tool.name : '';
      if (!toolName) continue;
      const name = toolNameFor(server, toolName);
      if (typeof registry.get === 'function' && registry.get(name)) {
        log.warn(`MCP "${server?.name}": "${name}" allaqachon ro‘yxatda, mavjudi saqlanadi.`);
        continue;
      }
      const descriptor = makeTool({ server, tool, name, entry, log, safeEmit });
      try {
        registry.register(descriptor);
      } catch (error) {
        log.warn(`MCP "${server?.name}": "${name}" ro‘yxatga olinmadi — ${describeError(error)}`);
        continue;
      }
      registered.push(name);
      collected.push(descriptor);
    }

    entry.registered = registered;
    entry.tools = collected;
    log.info(`MCP "${server?.name}": ${registered.length} ta tool ro‘yxatga olindi.`);
    return collected;
  }

  /** @param {{registered: string[]}} entry */
  function unregisterTools(entry) {
    const names = Array.isArray(entry.registered) ? entry.registered : [];
    if (names.length && typeof registry.unregister === 'function') {
      for (const name of names) {
        try {
          registry.unregister(name);
        } catch (error) {
          log.warn(`MCP tool "${name}" ro‘yxatdan chiqarilmadi — ${describeError(error)}`);
        }
      }
    } else if (names.length) {
      log.warn('Registry.unregister mavjud emas: eski MCP tool nomlari ro‘yxatda qoladi.');
    }
    entry.registered = [];
    entry.tools = [];
  }

  /** @param {{id: string, server: any}} entry */
  function detach(entry) {
    const client = entry.client;
    entry.client = null;
    entry.started = false;
    if (!client) return;
    client.removeAllListeners('exit');
    client.removeAllListeners('stderr');
  }

  /** @param {string} serverId */
  async function stop(serverId) {
    const entry = entryFor(serverId);
    entry.stopping = true;
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = null;
    }
    const client = entry.client;
    detach(entry);
    if (client) {
      try {
        await client.stop(); // idempotent, never throws
      } catch (error) {
        log.debug(`MCP "${entry.server?.name}" stop xatosi: ${describeError(error)}`);
      }
    }
    unregisterTools(entry);
    entry.stopping = false;
    if (entry.server) {
      entry.server.lastStatus = 'stopped';
      await persistStatus(entry.server, 'stopped');
    }
    return true;
  }

  /** @param {string} serverId */
  async function start(serverId) {
    const entry = entryFor(serverId);
    if (!entry.server) {
      entry.server = rememberServer(await findServer(serverId));
      if (!entry.server) throw new Error(`MCP server topilmadi: ${serverId}`);
    }
    const server = entry.server;
    // An explicit start (user action) starts a fresh crash budget. Automatic
    // restarts go through the internal `startInternal` and keep counting.
    clearRestartBudget(entry);
    return startInternal(entry);
  }

  /** Spawn + handshake + tool registration for one entry. @param {any} entry */
  async function startInternal(entry) {
    const server = entry.server;
    if (entry.client && entry.client.status === 'ready') {
      return entry.client;
    }
    if (entry.starting) return entry.starting;

    const client = new McpClient(server, clientOptions);
    entry.client = client;
    entry.stopping = false;
    attachHandlers(entry, client);

    entry.starting = (async () => {
      try {
        await client.start();
        entry.started = true;
        server.lastStatus = 'ready';
        await persistStatus(server, 'ready');
        safeEmit({ type: 'mcp_server', serverId: entry.id, name: server.name, status: 'ready' });
        await registerTools(server);
        return client;
      } catch (error) {
        client.lastError = describeError(error);
        if (client.status !== 'crashed') client.status = 'error';
        server.lastStatus = 'error';
        await persistStatus(server, 'error');
        safeEmit({
          type: 'mcp_server',
          serverId: entry.id,
          name: server.name,
          status: 'error',
          error: client.lastError
        });
        // `client.start()` already prefixes its message with the server name.
        if (client.lastError.startsWith(`MCP "${server.name}"`)) throw error;
        throw new Error(`MCP "${server.name}" ishga tushmadi: ${client.lastError}`);
      } finally {
        entry.starting = null;
      }
    })();

    return entry.starting;
  }

  /** @param {any} entry */
  function clearRestartBudget(entry) {
    entry.restarts = [];
    entry.restartAttempts = 0;
  }

  /** @param {string} serverId */
  async function restart(serverId) {
    const entry = entryFor(serverId);
    if (!entry.server) entry.server = rememberServer(await findServer(serverId));
    log.info(`MCP "${entry.server?.name || serverId}" qayta ishga tushirilmoqda…`);
    await stop(serverId);
    if (!entry.server) throw new Error(`MCP server topilmadi: ${serverId}`);
    clearRestartBudget(entry);
    return start(serverId);
  }

  /** @param {string} serverId */
  async function ensureRestart(serverId) {
    const entry = entryFor(serverId);
    if (entry.stopping || entry.restartTimer || entry.starting) return;
    const now = Date.now();
    entry.restarts = entry.restarts.filter((at) => now - at < RESTART_WINDOW_MS);
    if (entry.restarts.length >= RESTART_LIMIT) {
      const message = `MCP "${entry.server?.name}": ${RESTART_LIMIT} marta qayta ishga tushdi va yana yiqildi (5 daqiqa ichida).`;
      entry.started = false;
      entry.restartAttempts = RESTART_LIMIT;
      // Drop the dead client so `list()` reports the terminal error status.
      unregisterTools(entry);
      entry.client = null;
      if (entry.server) {
        entry.server.lastStatus = 'error';
        entry.server.lastError = message;
        await persistStatus(entry.server, 'error');
      }
      safeEmit({ type: 'mcp_server', serverId: entry.id, name: entry.server?.name, status: 'error', error: message });
      return;
    }
    entry.restarts.push(now);
    entry.restartAttempts += 1;
    const delay = RESTART_DELAY_MS * entry.restartAttempts;
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null;
      // Never let a restart failure become an unhandled rejection.
      Promise.resolve()
        .then(() => startInternal(entry))
        .catch((error) => log.warn(`MCP "${entry.server?.name}" avtomatik qayta ishga tushmadi: ${describeError(error)}`));
    }, delay);
    // Deliberately ref'd: a scheduled restart is real work. When the backend runs it
    // has a listening server keeping the loop alive anyway, while in a short-lived
    // process (a test file) an unref'd timer lets Node exit mid-restart and every
    // remaining test fails with "event loop has already resolved".
    log.warn(`MCP "${entry.server?.name}" yiqildi; ${delay} ms dan keyin qayta uriniladi (${entry.restartAttempts}/${RESTART_LIMIT}).`);
  }

  /** @param {any} entry @param {McpClient} client */
  function attachHandlers(entry, client) {
    client.on('exit', ({ code, signal }) => {
      entry.started = false;
      if (entry.stopping || client.status !== 'crashed') return;
      if (entry.server) {
        entry.server.lastStatus = 'crashed';
        entry.server.lastError = client.lastError;
      }
      safeEmit({
        type: 'mcp_server',
        serverId: entry.id,
        name: entry.server?.name,
        status: 'crashed',
        code: code ?? null,
        signal: signal ?? null,
        error: client.lastError
      });
      // Tool calls simply fail while the server is down; the restart below
      // re-registers the tools once the process is healthy again.
      const run = () => {
        Promise.resolve()
          .then(() => ensureRestart(entry.id))
          .catch((error) => log.warn(`MCP restart xatosi: ${describeError(error)}`));
      };
      try {
        run();
      } catch (error) {
        log.warn(`MCP restart xatosi: ${describeError(error)}`);
      }
    });
  }

  return {
    /** @param {string} serverId */
    async start(serverId) {
      const client = await start(serverId);
      return client;
    },

    /** @param {string} serverId */
    async stop(serverId) {
      return stop(serverId);
    },

    /** @param {string} serverId */
    async restart(serverId) {
      const client = await restart(serverId);
      return client;
    },

    /** Start every enabled auto-start server. */
    async startAuto() {
      const servers = await resolveServers();
      const results = [];
      for (const server of servers) {
        if (!server || server.enabled === false || server.autoStart === false) continue;
        if (!server.command) continue;
        try {
          entryFor(server.id).server = rememberServer(server);
          await start(server.id);
          results.push({ id: server.id, ok: true });
        } catch (error) {
          results.push({ id: server.id, ok: false, error: describeError(error) });
        }
      }
      return results;
    },

    /** Stop every server this manager owns. */
    async stopAll() {
      const results = [];
      for (const id of Array.from(entries.keys())) {
        try {
          await stop(id);
          results.push({ id, ok: true });
        } catch (error) {
          results.push({ id, ok: false, error: describeError(error) });
        }
      }
      return results;
    },

    /** @param {any} server */
    async registerTools(server) {
      if (server && server.id !== undefined) entryFor(server.id).server = server;
      return registerTools(server);
    },

    /** @returns {{id: string, name: string, status: string, tools: number, lastError?: string}[]} */
    list() {
      const rows = [];
      const seen = new Set();
      for (const synced of readStoreSync() || []) rememberServer(synced);
      for (const entry of entries.values()) {
        seen.add(entry.id);
        rows.push({
          id: entry.id,
          name: entry.server?.name || knownServers.get(entry.id)?.name || entry.id,
          status: statusOf(entry),
          tools: entry.registered.length,
          lastError: errorOf(entry)
        });
      }
      // Configured servers that were never started still belong in the list.
      for (const [id, server] of knownServers) {
        if (seen.has(id)) continue;
        rows.push({
          id,
          name: server.name || id,
          status: server.lastStatus || 'stopped',
          tools: 0,
          lastError: server.lastError
        });
      }
      return rows;
    },

    /** @param {string} serverId */
    tools(serverId) {
      const entry = entries.get(String(serverId));
      return entry ? entry.tools.slice() : [];
    },

    /** Stop disabled servers, (re)start enabled auto-start ones after store edits. */
    async reload() {
      const servers = await resolveServers();
      const known = new Set(servers.map((server) => String(server?.id)));
      for (const id of Array.from(entries.keys())) {
        if (!known.has(id)) {
          await stop(id);
          entries.delete(id);
        }
      }
      for (const server of servers) {
        if (!server?.id) continue;
        const entry = entryFor(server.id);
        entry.server = rememberServer(server);
        if (server.enabled === false) {
          if (entry.client || entry.started) await stop(server.id);
          continue;
        }
        // `autoStart` only gates startAuto(); an enabled server is (re)started here.
        if (entry.client && entry.client.status === 'ready') {
          await registerTools(server); // pick up edited tool metadata
          continue;
        }
        try {
          await start(server.id);
        } catch (error) {
          log.warn(`MCP "${server.name}" reload paytida ishga tushmadi: ${describeError(error)}`);
        }
      }
      return this.list();
    }
  };
}

/**
 * Build the registry tool descriptor for one MCP tool (§7 + §11).
 * @param {{
 *   server: any, tool: any, name: string, entry: any,
 *   log: Record<string, Function>, safeEmit: Function
 * }} context
 */
export function makeTool({ server, tool, name, entry, log, safeEmit }) {
  const title = typeof tool.title === 'string' && tool.title ? tool.title : `${server.name}: ${tool.name}`;
  const description = typeof tool.description === 'string' && tool.description
    ? tool.description
    : `MCP tool "${tool.name}" provided by the "${server.name}" server.`;
  const inputSchema = tool.inputSchema && typeof tool.inputSchema === 'object'
    ? tool.inputSchema
    : { type: 'object', properties: {}, additionalProperties: true };

  return {
    name,
    title,
    description,
    category: 'mcp',
    parameters: inputSchema,
    // Every MCP tool is user-decided: read-only-looking names stay 'ask' too.
    defaultPolicy: 'ask',
    source: 'mcp',
    dangerous: false,
    /**
     * @param {object} args
     * @param {object} _ctx
     * @returns {Promise<import('../agent/registry.js').ToolResult>}
     */
    async run(args = {}, _ctx = {}) {
      const client = entry.client;
      if (!client || client.status !== 'ready') {
        const reason = client?.lastError || `server status: ${client?.status || 'stopped'}`;
        return { ok: false, error: `MCP "${server.name}" ishlamayapti (${reason}).` };
      }
      try {
        const result = await client.callTool(tool.name, args || {});
        const text = truncate(flattenContent(result.content), MAX_TOOL_TEXT);
        const data = result.structuredContent !== undefined
          ? result.structuredContent
          : (Array.isArray(result.content) ? result.content : []);
        if (result.isError) {
          const message = text || 'MCP tool xatosi';
          return { ok: false, error: message, content: text };
        }
        safeEmit({
          type: 'mcp_tool',
          serverId: entry.id,
          server: server.name,
          tool: tool.name,
          ok: true,
          chars: text.length
        });
        return { ok: true, summary: summarize(server, tool, text), content: text, data };
      } catch (error) {
        const message = describeError(error);
        log.warn(`MCP "${server.name}.${tool.name}" xatosi: ${message}`);
        safeEmit({
          type: 'mcp_tool',
          serverId: entry.id,
          server: server.name,
          tool: tool.name,
          ok: false,
          error: message
        });
        return { ok: false, error: message };
      }
    }
  };
}

/** @param {any} server @param {any} tool @param {string} text */
function summarize(server, tool, text) {
  const head = text.replace(/\s+/g, ' ').trim().slice(0, 160);
  return `${server.name}.${tool.name} → ${head || `${text.length} belgi`}`.slice(0, 240);
}

/** @param {any} logger */
function makeLogger(logger) {
  const fallback = () => {};
  const levels = ['debug', 'info', 'warn', 'error'];
  const result = {};
  for (const level of levels) {
    const fn = logger && typeof logger[level] === 'function' ? logger[level] : null;
    result[level] = fn
      ? (...args) => {
        try {
          fn.apply(logger, args);
        } catch {
          // Logging must never break the manager.
        }
      }
      : fallback;
  }
  return result;
}

/** @param {any} emit */
function makeEmitter(emit) {
  if (typeof emit !== 'function') return () => {};
  return (event) => {
    try {
      emit(event);
    } catch {
      // Event listeners must never break the manager.
    }
  };
}

export default createMcpManager;
