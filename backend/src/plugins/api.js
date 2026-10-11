/**
 * Plugin API factory (architecture contract §12).
 *
 * `createPluginApi` builds the `api` object that is handed to a plugin's
 * `activate(api)` function. The api is intentionally narrow: a plugin can only
 * touch the host through the registries, the store, the event bus, its own data
 * directory, its own settings namespace and a namespaced logger.
 *
 * This module never imports project modules; every host dependency is injected
 * so the plugin system stays decoupled and testable.
 */

/** Events a plugin is allowed to subscribe to (contract §12). */
const PLUGIN_EVENTS = ['chat.before', 'chat.after', 'tool.before', 'tool.after'];

/** Longest plugin name accepted for a tool/namespace prefix. */
const MAX_SLUG_LENGTH = 40;

/**
 * Lowercase, separators collapsed, safe for store keys and directory names.
 *
 * @param {unknown} value Raw value.
 * @param {number} [max] Maximum slug length.
 * @returns {string} Slug, possibly empty when the input has no usable characters.
 */
export function slugify(value, max = MAX_SLUG_LENGTH) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'plugin';
}

/**
 * Slug for the local part of a **tool** name. Tool names follow the MCP
 * convention in the contract (§11): non-alphanumerics become `_`, so
 * `project_stats` survives as `project_stats` instead of `project-stats`.
 *
 * @param {unknown} value Raw value.
 * @param {number} [max] Maximum length.
 * @returns {string} Tool-safe slug.
 */
export function toolSlug(value, max = MAX_SLUG_LENGTH) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
    .replace(/_+$/g, '');
  return slug || 'tool';
}

/**
 * Normalise an Error-ish value into a short, loggable message.
 *
 * @param {unknown} error Thrown value.
 * @returns {string} Human readable message.
 */
export function errorMessage(error) {
  if (!error) return 'Unknown plugin error';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message) return error.message;
  try {
    const text = String(error);
    return text && text !== '[object Object]' ? text : 'Unknown plugin error';
  } catch {
    return 'Unknown plugin error';
  }
}

/**
 * Make sure the store has the collections the plugin API writes to.
 *
 * @param {object} store Live store object.
 * @returns {object} The same store, minimally repaired.
 */
function ensureStoreShape(store) {
  if (!store || typeof store !== 'object') return store;
  if (!store.plugins || typeof store.plugins !== 'object' || Array.isArray(store.plugins)) store.plugins = {};
  if (!store.plugins.settings || typeof store.plugins.settings !== 'object') store.plugins.settings = {};
  if (!store.settings || typeof store.settings !== 'object') store.settings = {};
  return store;
}

/**
 * Read the settings bag of one plugin from the live store.
 *
 * @param {object} store Live store object.
 * @param {string} pluginName Plugin name (already slugified by the loader).
 * @returns {Record<string, unknown>} Settings bag (never null).
 */
function pluginSettingsBag(store, pluginName) {
  if (!store || typeof store !== 'object') return {};
  if (!store.plugins || typeof store.plugins !== 'object') return {};
  const bag = store.plugins.settings?.[pluginName];
  return bag && typeof bag === 'object' ? bag : {};
}

/**
 * Build the `api` object for a single plugin.
 *
 * @param {object} options Options.
 * @param {string} options.name Plugin name (used as the namespace prefix).
 * @param {string} [options.version] Plugin version.
 * @param {string} [options.dir] Absolute plugin directory.
 * @param {string} [options.dataDir] Absolute data directory for the plugin.
 * @param {object} options.registry Host tool registry (`register`/`unregister`).
 * @param {(name: string, tool: object) => void} [options.onToolRegistered] Observer called after a successful tool registration.
 * @param {(command: object) => void} [options.onCommandRegistered] Observer called after a command registration.
 * @param {() => object|Promise<object>} options.getStore Accessor for the live store.
 * @param {() => Promise<void>} [options.saveStore] Persists the store.
 * @param {(type: string, payload?: any) => void} [options.emit] Host event emitter.
 * @param {object} [options.logger] Host logger (`debug`/`info`/`warn`/`error`).
 * @param {Record<string, unknown>} [options.manifest] Raw manifest, exposed for convenience.
 * @returns {object} The sandboxed plugin api.
 */
export function createPluginApi({
  name,
  version = '0.0.0',
  dir = '',
  dataDir = '',
  registry,
  onToolRegistered,
  onCommandRegistered,
  getStore,
  saveStore,
  emit,
  logger,
  manifest,
}) {
  if (!registry || typeof registry.register !== 'function') {
    throw new Error('createPluginApi requires a registry with register()');
  }
  if (typeof getStore !== 'function') {
    throw new Error('createPluginApi requires a getStore() accessor');
  }

  const pluginName = slugify(name || 'plugin');
  const handlers = new Map(PLUGIN_EVENTS.map(event => [event, []]));
  const hostLogger = logger || {};
  const hostEmit = typeof emit === 'function' ? emit : () => {};
  const persist = typeof saveStore === 'function' ? saveStore : async () => {};

  /** Namespaced logger so every plugin line is attributable. */
  const scopedLogger = {
    debug: (message, meta) => hostLogger.debug?.(`[plugin:${pluginName}] ${message}`, meta),
    info: (message, meta) => hostLogger.info?.(`[plugin:${pluginName}] ${message}`, meta),
    warn: (message, meta) => hostLogger.warn?.(`[plugin:${pluginName}] ${message}`, meta),
    error: (message, meta) => hostLogger.error?.(`[plugin:${pluginName}] ${message}`, meta),
  };

  /** In-memory fallback settings, merged under the persisted ones. */
  const localSettings = {};

  const settings = {
    /**
     * Read a plugin setting, falling back to the provided default.
     *
     * @param {string} key Setting key.
     * @param {unknown} [fallback] Value returned when the key is absent.
     * @returns {unknown} Stored value or fallback.
     */
    get(key, fallback) {
      const bag = pluginSettingsBag(getStore(), pluginName);
      if (Object.hasOwn(bag, key)) return bag[key];
      if (Object.hasOwn(localSettings, key)) return localSettings[key];
      return fallback;
    },
    /**
     * Write a plugin setting and persist the store.
     *
     * @param {string} key Setting key.
     * @param {unknown} value JSON-serialisable value.
     * @returns {Promise<void>} Resolves once the write is queued.
     */
    async set(key, value) {
      const store = getStore();
      if (store && typeof store === 'object') {
        ensureStoreShape(store);
        store.plugins.settings[pluginName] ||= {};
        store.plugins.settings[pluginName][key] = value;
      } else {
        localSettings[key] = value;
      }
      await persist();
    },
    /**
     * Snapshot of every setting of this plugin.
     *
     * @returns {Record<string, unknown>} Shallow copy of the settings bag.
     */
    all() {
      return { ...pluginSettingsBag(getStore(), pluginName), ...localSettings };
    },
  };

  return {
    name: pluginName,
    version,
    manifest: manifest ? { ...manifest } : undefined,
    logger: scopedLogger,

    /**
     * Register a tool. The name is always rewritten to
     * `plugin.<plugin-name>.<tool-name>` and the source is forced to `plugin`.
     *
     * @param {object} tool Tool definition (contract §7 `Tool` shape).
     * @returns {string} The final, prefixed tool name.
     */
    registerTool(tool) {
      if (!tool || typeof tool !== 'object') throw new Error('registerTool(tool) requires a tool object');
      if (typeof tool.run !== 'function') throw new Error(`Tool "${tool.name || '(unnamed)'}" is missing run()`);
      const localName = toolSlug(tool.name || 'tool');
      const finalName = `plugin.${pluginName}.${localName}`;
      const registered = {
        ...tool,
        name: finalName,
        title: tool.title || localName,
        category: 'plugin',
        source: 'plugin',
        defaultPolicy: tool.defaultPolicy || 'ask',
        parameters: tool.parameters && typeof tool.parameters === 'object'
          ? tool.parameters
          : { type: 'object', properties: {}, additionalProperties: false },
        plugin: pluginName,
      };
      registry.register(registered);
      onToolRegistered?.(finalName, registered);
      return finalName;
    },

    /**
     * Register a slash command, exposed at `GET /api/commands`.
     *
     * @param {{name: string, description?: string, run: (args: string[], ctx?: object) => any}} command Command definition.
     * @returns {string} The normalised command name (without the leading slash).
     */
    registerCommand(command) {
      if (!command || typeof command !== 'object') throw new Error('registerCommand(command) requires an object');
      const commandName = slugify(command.name || 'command');
      if (typeof command.run !== 'function') throw new Error(`Command "/${commandName}" is missing run()`);
      const registered = {
        name: commandName,
        description: command.description || '',
        plugin: pluginName,
        run: command.run,
      };
      onCommandRegistered?.(registered);
      return commandName;
    },

    /**
     * Subscribe to a host lifecycle event.
     *
     * @param {'chat.before'|'chat.after'|'tool.before'|'tool.after'} event Event name.
     * @param {(payload: any) => any} handler Handler function.
     * @returns {() => void} Unsubscribe function.
     */
    on(event, handler) {
      if (!handlers.has(event)) {
        throw new Error(`Unsupported plugin event "${event}". Allowed: ${PLUGIN_EVENTS.join(', ')}`);
      }
      if (typeof handler !== 'function') throw new Error('on(event, handler) requires a function');
      handlers.get(event).push(handler);
      return () => {
        const list = handlers.get(event);
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },

    /**
     * Emit a host event on behalf of the plugin (tagged with the plugin name).
     *
     * @param {string} event Event name.
     * @param {any} [payload] Event payload.
     * @returns {void}
     */
    emit(event, payload) {
      hostEmit(event, { plugin: pluginName, ...(payload && typeof payload === 'object' ? payload : { payload }) });
    },

    /**
     * Read the live store. Mutating it directly is discouraged: call `saveStore()`.
     *
     * @returns {object} Live store object.
     */
    getStore() {
      return getStore();
    },

    /**
     * Persist the store after mutations.
     *
     * @returns {Promise<void>} Resolves once the write is queued.
     */
    async saveStore() {
      await persist();
    },

    paths: {
      dataDir,
      pluginDir: dir,
    },

    settings,

    /**
     * Internal: handlers registered through `on()`, dispatched by the host.
     *
     * @param {'chat.before'|'chat.after'|'tool.before'|'tool.after'} event Event name.
     * @param {any} payload Event payload.
     * @returns {Promise<any[]>} Handler results (errors are isolated per handler).
     */
    async dispatch(event, payload) {
      const list = handlers.get(event) || [];
      const results = [];
      for (const handler of list) {
        try {
          results.push(await handler(payload));
        } catch (error) {
          scopedLogger.warn(`handler for "${event}" failed: ${errorMessage(error)}`);
          results.push(undefined);
        }
      }
      return results;
    },

    /**
     * Internal: how many handlers are attached (used by tests and status views).
     *
     * @returns {number} Total handler count.
     */
    handlerCount() {
      let total = 0;
      for (const list of handlers.values()) total += list.length;
      return total;
    },
  };
}
