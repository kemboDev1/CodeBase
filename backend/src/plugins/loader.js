/**
 * Plugin loader (architecture contract §12).
 *
 * A plugin is a directory containing `plugin.json`:
 * ```json
 * { "name": "example-tools", "version": "1.0.0", "description": "...",
 *   "main": "index.mjs", "permissions": ["filesystem:read"], "author": "..." }
 * ```
 * The entry module default-exports `activate(api)` and may export `deactivate()`.
 *
 * Trust model: a plugin only loads when the store contains a record whose
 * `trusted === true` (and `enabled !== false`). Everything else is reported as
 * `status: 'disabled'`. Failures never throw: the runtime comes back with
 * `status: 'error'` and an `error` message.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPluginApi, errorMessage, slugify } from './api.js';

/** Runtime statuses reported to the API/UI. */
export const PLUGIN_STATUS = {
  active: 'active',
  disabled: 'disabled',
  error: 'error',
};

/** Default entry file when `plugin.json` omits `main`. */
export const DEFAULT_MAIN = 'index.mjs';

/** Host events a plugin may subscribe to (mirrors contract §12). */
export const PLUGIN_EVENTS = ['chat.before', 'chat.after', 'tool.before', 'tool.after'];

/** Files that are never plugin directories. */
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build', 'release']);

/**
 * Normalise a path for comparison (case-insensitive on Windows).
 *
 * @param {string} value Path.
 * @returns {string} Comparison key.
 */
function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Read and validate `plugin.json`.
 *
 * @param {string} dir Absolute plugin directory.
 * @returns {Promise<{manifest: object, main: string}>} Parsed manifest and resolved entry file.
 */
async function readManifest(dir) {
  const manifestPath = path.join(dir, 'plugin.json');
  let raw;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`plugin.json not found in ${dir}`);
    throw new Error(`Cannot read plugin.json: ${errorMessage(error)}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`plugin.json is not valid JSON: ${errorMessage(error)}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('plugin.json must contain a JSON object');
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    throw new Error('plugin.json is missing a "name"');
  }
  const main = typeof manifest.main === 'string' && manifest.main.trim() ? manifest.main.trim() : DEFAULT_MAIN;
  if (path.isAbsolute(main)) throw new Error('plugin.json "main" must be a relative path inside the plugin directory');
  const mainPath = path.resolve(dir, main);
  if (pathKey(mainPath) !== pathKey(dir) && !pathKey(mainPath).startsWith(`${pathKey(dir)}${path.sep}`)) {
    throw new Error('plugin.json "main" escapes the plugin directory');
  }
  return { manifest, main };
}

/**
 * Find the store record for a plugin: by id, then by directory path.
 *
 * @param {object} store Live store object.
 * @param {string} id Plugin id (`<name>@<version>`, plus the bare name).
 * @param {string} dir Absolute plugin directory.
 * @param {string} pluginName Plugin name from the manifest.
 * @returns {object|null} Matching record or null.
 */
function findRecord(store, id, dir, pluginName) {
  const records = Array.isArray(store?.plugins) ? store.plugins : [];
  if (!records.length) return null;
  const keys = new Set([slugify(id), slugify(pluginName)]);
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    if (typeof record.id === 'string' && keys.has(slugify(record.id))) return record;
  }
  const dirKey = pathKey(dir);
  for (const record of records) {
    if (record && typeof record.dir === 'string' && pathKey(record.dir) === dirKey) return record;
  }
  return null;
}

/**
 * A record is loadable only when the user explicitly trusted it.
 *
 * @param {object|null} record Store record.
 * @returns {boolean} True when the plugin may activate.
 */
function isTrusted(record) {
  return Boolean(record) && record.trusted === true && record.enabled !== false;
}

/**
 * Build the runtime shell shared by every outcome (active/disabled/error).
 *
 * @param {object} options Options.
 * @returns {object} Runtime object without `activate`/`deactivate` attached.
 */
function makeRuntime({ id, dir, manifest, status, error, api }) {
  const name = slugify(manifest.name);
  return {
    id,
    dir,
    name: manifest.name,
    version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
    description: typeof manifest.description === 'string' ? manifest.description : '',
    // Hosts can drop every tool of this plugin at once with
    // `registry.unregisterByPrefix(runtime.prefix)`; `id` contains `@version`,
    // so it is NOT a valid prefix for the registered tool names.
    prefix: `plugin.${name}.`,
    status,
    error,
    api,
    activate: undefined,
    deactivate: undefined,
    tools: [],
    commands: [],
    handlers: 0,
  };
}

/**
 * Load one plugin directory.
 *
 * Never throws. Returns a runtime object describing the outcome; `activate()` is
 * called exactly once for trusted plugins and its registrations are rolled back
 * through `registry.unregister` when it throws.
 *
 * @param {string} dir Absolute path of the plugin directory.
 * @param {object} deps Dependencies.
 * @param {object} deps.registry Host tool registry (`register`, optional `unregister`).
 * @param {object} [deps.store] Live store object (used for trust + settings).
 * @param {object} [deps.logger] Host logger.
 * @param {(type: string, payload?: any) => void} [deps.emit] Host event emitter.
 * @param {() => Promise<object>} [deps.getStore] Async store accessor when `store` is not provided.
 * @param {() => Promise<void>} [deps.saveStore] Store persistence.
 * @param {object} [deps.dataDir] Base data directory; the plugin gets `<dataDir>/plugins/<slug>`.
 * @returns {Promise<object>} `PluginRuntime`: `{ id, dir, name, version, description, prefix,
 *   status, error?, api, activate?, deactivate?, tools, commands, handlers }`. `prefix` is the
 *   exact tool-name prefix (`plugin.<name>.`) to pass to `registry.unregisterByPrefix`.
 */
export async function loadPlugin(dir, deps = {}) {
  const { registry, logger, emit, getStore, saveStore, dataDir } = deps;
  const dirAbsolute = path.resolve(String(dir || ''));
  let manifest = { name: path.basename(dirAbsolute) || 'plugin', version: '0.0.0', description: '' };
  let id = slugify(manifest.name);

  if (!registry || typeof registry.register !== 'function') {
    return makeRuntime({ id, dir: dirAbsolute, manifest, status: PLUGIN_STATUS.error, error: 'loadPlugin requires a registry', api: null });
  }

  // 1. Manifest.
  let main = DEFAULT_MAIN;
  try {
    const parsed = await readManifest(dirAbsolute);
    manifest = parsed.manifest;
    main = parsed.main;
  } catch (error) {
    return makeRuntime({
      id,
      dir: dirAbsolute,
      manifest,
      status: PLUGIN_STATUS.error,
      error: errorMessage(error),
      api: null,
    });
  }

  id = `${slugify(manifest.name)}@${typeof manifest.version === 'string' ? manifest.version : '0.0.0'}`;
  const pluginName = slugify(manifest.name);

  // 2. Resolve the store (async accessor is supported for hosts that own the store).
  let store = deps.store;
  if (!store && typeof getStore === 'function') {
    try {
      store = await getStore();
    } catch (error) {
      return makeRuntime({ id, dir: dirAbsolute, manifest, status: PLUGIN_STATUS.error, error: `Cannot read store: ${errorMessage(error)}`, api: null });
    }
  }

  // 3. Trust gate.
  const record = findRecord(store, id, dirAbsolute, pluginName);
  if (!isTrusted(record)) {
    const reason = record
      ? 'Plugin is not trusted in the store; enable it in the Plugins page first.'
      : 'Plugin has no store record; enable it in the Plugins page first.';
    logger?.info?.(`Plugin "${manifest.name}" skipped: ${reason}`);
    return makeRuntime({ id, dir: dirAbsolute, manifest, status: PLUGIN_STATUS.disabled, error: undefined, api: null });
  }

  // 4. Import the entry module (cache-busted so /plugins/reload picks up edits).
  const mainPath = path.resolve(dirAbsolute, main);
  let mod;
  try {
    const stat = await fs.stat(mainPath);
    if (!stat.isFile()) throw new Error(`${main} is not a file`);
    const url = pathToFileURL(mainPath);
    url.searchParams.set('t', String(stat.mtimeMs));
    mod = await import(url.href);
  } catch (error) {
    const code = error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'ENOENT'
      ? `Entry file not found: ${main}`
      : errorMessage(error);
    return makeRuntime({ id, dir: dirAbsolute, manifest, status: PLUGIN_STATUS.error, error: code, api: null });
  }

  const activate = typeof mod?.activate === 'function' ? mod.activate : mod?.default?.activate;
  const deactivate = typeof mod?.deactivate === 'function' ? mod.deactivate : mod?.default?.deactivate;
  if (typeof activate !== 'function') {
    return makeRuntime({
      id,
      dir: dirAbsolute,
      manifest,
      status: PLUGIN_STATUS.error,
      error: `Plugin "${manifest.name}" does not export activate(api)`,
      api: null,
    });
  }

  // 5. Build the api and run activate(), tracking registrations for rollback.
  const pluginDataDir = dataDir ? path.join(dataDir, 'plugins', pluginName) : '';
  const addedTools = [];
  const commands = [];

  const api = createPluginApi({
    name: pluginName,
    version: manifest.version,
    dir: dirAbsolute,
    dataDir: pluginDataDir,
    registry,
    manifest,
    logger,
    emit,
    getStore: () => store ?? deps.store ?? {},
    saveStore,
    onToolRegistered: (name) => { addedTools.push(name); },
    onCommandRegistered: (command) => { commands.push(command); },
  });

  const runtime = makeRuntime({ id, dir: dirAbsolute, manifest, status: PLUGIN_STATUS.active, error: undefined, api });
  runtime.activate = activate;
  runtime.deactivate = deactivate;

  try {
    await activate(api);
  } catch (error) {
    runtime.status = PLUGIN_STATUS.error;
    runtime.error = errorMessage(error);
    await rollback({ registry, names: addedTools, logger, pluginName });
    commands.length = 0;
    runtime.activate = undefined;
    runtime.deactivate = undefined;
    return runtime;
  }

  runtime.tools = [...addedTools];
  runtime.commands = commands;
  runtime.handlers = api.handlerCount();
  logger?.info?.(`Plugin "${manifest.name}" activated (${addedTools.length} tool(s), ${commands.length} command(s))`);
  return runtime;
}

/**
 * Undo the registrations a failed `activate()` managed to make.
 *
 * @param {object} options Options.
 * @param {object} options.registry Host registry.
 * @param {string[]} options.names Registered tool names.
 * @param {object} [options.logger] Host logger.
 * @param {string} [options.pluginName] Plugin name for logging.
 * @returns {Promise<void>} Resolves when every rollback attempt was made.
 */
async function rollback({ registry, names, logger, pluginName }) {
  if (!names.length) return;
  if (typeof registry.unregister !== 'function') {
    logger?.warn?.(`Plugin "${pluginName}" failed and the registry has no unregister(); ${names.length} tool(s) stay registered`);
    return;
  }
  for (const name of names) {
    try {
      await registry.unregister(name);
    } catch (error) {
      logger?.warn?.(`Rollback of "${name}" failed: ${errorMessage(error)}`);
    }
  }
}

/**
 * Load every plugin inside a directory (or list of directories).
 *
 * @param {object} options Options.
 * @param {string|string[]} options.dir Plugins directory, or list of directories.
 * @param {object} options.registry Host tool registry.
 * @param {object} [options.logger] Host logger.
 * @param {object} [options.store] Live store object.
 * @param {() => Promise<object>} [options.getStore] Async store accessor.
 * @param {() => Promise<void>} [options.saveStore] Store persistence.
 * @param {(type: string, payload?: any) => void} [options.emit] Host event emitter.
 * @param {string} [options.dataDir] Base data directory.
 * @returns {Promise<object[]>} Loaded runtimes (sorted by plugin name).
 */
export async function loadPlugins({ dir, registry, logger, store, getStore, saveStore, emit, dataDir } = {}) {
  const roots = (Array.isArray(dir) ? dir : [dir])
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => path.resolve(value));

  if (!roots.length) return [];

  const seen = new Set();
  const candidates = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      logger?.warn?.(`Cannot read plugins directory ${root}: ${errorMessage(error)}`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
      const candidate = path.join(root, entry.name);
      const key = pathKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  }

  const runtimes = [];
  for (const candidate of candidates) {
    // Sequential: plugins are cheap, ordering is deterministic, and a slow
    // plugin cannot starve the others.
    runtimes.push(await loadPlugin(candidate, { registry, logger, store, getStore, saveStore, emit, dataDir }));
  }
  runtimes.sort((a, b) => a.name.localeCompare(b.name));
  return runtimes;
}

/**
 * Call `deactivate()` on a previously loaded plugin runtime and drop its tools.
 *
 * @param {object} runtime Runtime returned by `loadPlugin`/`loadPlugins`.
 * @param {object} [deps] Dependencies.
 * @param {object} [deps.registry] Host registry (used to unregister the plugin tools).
 * @param {object} [deps.logger] Host logger.
 * @returns {Promise<object>} The same runtime, marked as `disabled`.
 */
export async function unloadPlugin(runtime, { registry, logger } = {}) {
  if (!runtime || typeof runtime !== 'object') return runtime;
  if (typeof runtime.deactivate === 'function') {
    try {
      await runtime.deactivate();
    } catch (error) {
      logger?.warn?.(`deactivate() of "${runtime.name}" failed: ${errorMessage(error)}`);
    }
  }
  if (registry && typeof registry.unregister === 'function') {
    await rollback({ registry, names: runtime.tools || [], logger, pluginName: runtime.name });
  }
  runtime.tools = [];
  runtime.commands = [];
  runtime.handlers = 0;
  runtime.status = PLUGIN_STATUS.disabled;
  runtime.activate = undefined;
  runtime.deactivate = undefined;
  return runtime;
}
