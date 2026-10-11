/**
 * Plugin loader tests (architecture contract §18).
 *
 * Run with: `node --test backend/test/plugins.test.mjs`
 *
 * The fake registry, store, logger and emitter live inside this file so the test
 * imports nothing that is not written yet — only Node built-ins, the loader, and
 * the shipped example plugin.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPlugin, loadPlugins, unloadPlugin } from '../src/plugins/loader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_PLUGIN_DIR = path.resolve(here, '..', 'examples', 'plugin-example');
const EXAMPLE_PLUGIN_NAME = 'example-tools';
const EXAMPLE_TOOL = `plugin.${EXAMPLE_PLUGIN_NAME}.project_stats`;

/**
 * Minimal stand-in for the host tool registry (contract §7).
 *
 * @returns {object} Fake registry with `register`, `unregister`, `get`, `list`.
 */
function createFakeRegistry() {
  const tools = new Map();
  return {
    tools,
    register(tool) {
      assert.ok(tool && typeof tool.name === 'string' && tool.name, 'registered tool needs a name');
      if (tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
      tools.set(tool.name, tool);
      return tool;
    },
    unregister(name) {
      return tools.delete(name);
    },
    get(name) {
      return tools.get(name);
    },
    list() {
      return [...tools.values()];
    },
  };
}

/**
 * Minimal store whose `plugins` array can seed a trust record.
 *
 * @param {object[]} [plugins] Plugin records.
 * @returns {{store: object, saves: number}} Store handle.
 */
function createFakeStore(plugins = []) {
  return {
    saves: 0,
    store: { version: 2, plugins, skills: [], settings: {} },
  };
}

/**
 * Trusted plugin record for the shipped example plugin.
 *
 * @param {object} [overrides] Record overrides.
 * @returns {object} Store record.
 */
function exampleRecord(overrides = {}) {
  return {
    id: EXAMPLE_PLUGIN_NAME,
    dir: EXAMPLE_PLUGIN_DIR,
    name: EXAMPLE_PLUGIN_NAME,
    version: '1.0.0',
    main: 'index.mjs',
    enabled: true,
    trusted: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a temp plugin directory with a manifest and entry module.
 *
 * @param {import('node:test').TestContext} t Test context.
 * @param {object} options Options.
 * @param {string} [options.name] Manifest name.
 * @param {string} [options.main] Manifest main.
 * @param {string} [options.code] Entry module source.
 * @param {boolean} [options.manifest] Write plugin.json at all.
 * @returns {Promise<string>} Plugin directory.
 */
async function makePluginDir(t, { name = 'temp-plugin', main = 'index.mjs', code = 'export function activate() {}', manifest = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-plugin-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  if (manifest) {
    await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: 'temp', main }, null, 2), 'utf8');
  }
  if (code !== null) await fs.writeFile(path.join(dir, main), code, 'utf8');
  return dir;
}

test('example plugin manifest and entry file exist', async () => {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(EXAMPLE_PLUGIN_DIR, 'plugin.json'), 'utf8'));
  } catch (error) {
    assert.fail(`backend/examples/plugin-example/plugin.json is not valid JSON: ${error.message}`);
  }
  assert.equal(manifest.name, EXAMPLE_PLUGIN_NAME);
  assert.equal(manifest.main, 'index.mjs');
  const entry = await fs.readFile(path.join(EXAMPLE_PLUGIN_DIR, manifest.main), 'utf8');
  assert.match(entry, /export async function activate/);
  assert.match(entry, /export function deactivate/);
});

test('loadPlugin activates a trusted plugin and prefixes tool names', async () => {
  const registry = createFakeRegistry();
  const { store } = createFakeStore([exampleRecord()]);
  const logs = [];
  const logger = {
    info: (m) => logs.push(`info:${m}`),
    warn: (m) => logs.push(`warn:${m}`),
    error: (m) => logs.push(`error:${m}`),
    debug: () => {},
  };
  const events = [];
  const emit = (type, payload) => events.push({ type, payload });

  const runtime = await loadPlugin(EXAMPLE_PLUGIN_DIR, { registry, store, logger, emit, dataDir: os.tmpdir() });

  assert.equal(runtime.status, 'active');
  assert.equal(runtime.error, undefined);
  assert.equal(runtime.name, EXAMPLE_PLUGIN_NAME);
  assert.equal(runtime.id, `${EXAMPLE_PLUGIN_NAME}@1.0.0`);
  assert.equal(runtime.dir, EXAMPLE_PLUGIN_DIR);
  assert.ok(runtime.api, 'runtime should expose the api handed to the plugin');
  assert.equal(typeof runtime.activate, 'function');
  assert.equal(typeof runtime.deactivate, 'function');

  // Tool registration: forced `plugin.` prefix + source 'plugin'.
  assert.deepEqual(runtime.tools, [EXAMPLE_TOOL]);
  const tool = registry.get(EXAMPLE_TOOL);
  assert.ok(tool, `expected ${EXAMPLE_TOOL} in the registry`);
  assert.equal(tool.source, 'plugin');
  assert.equal(tool.category, 'plugin');
  assert.equal(tool.plugin, EXAMPLE_PLUGIN_NAME);
  assert.equal(tool.defaultPolicy, 'allow');
  assert.equal(tool.parameters.type, 'object');
  assert.equal(registry.list().length, 1);
  assert.equal(runtime.api.paths.pluginDir, EXAMPLE_PLUGIN_DIR);
  assert.ok(runtime.api.paths.dataDir.endsWith(path.join('plugins', EXAMPLE_PLUGIN_NAME)));

  // Slash command is exposed on the runtime (`GET /api/commands` uses this list).
  assert.equal(runtime.commands.length, 1);
  assert.equal(runtime.commands[0].name, 'hello');
  assert.equal(runtime.commands[0].plugin, EXAMPLE_PLUGIN_NAME);
  const result = await runtime.commands[0].run(['CodeBase']);
  assert.equal(result.ok, true);
  assert.match(result.content, /Hello, CodeBase!/);

  // Event bus + namespaced logging.
  assert.equal(runtime.handlers, 1);
  await runtime.api.dispatch('tool.before', { name: EXAMPLE_TOOL, args: {} });
  assert.ok(logs.some(line => line.startsWith('info:[plugin:example-tools]')), `expected namespaced log, got ${JSON.stringify(logs)}`);
  runtime.api.emit('tool.after', { name: EXAMPLE_TOOL });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.plugin, EXAMPLE_PLUGIN_NAME);
});

test('loadPlugin skips plugins that are missing or untrusted in the store', async () => {
  const noStore = createFakeRegistry();
  const disabled = await loadPlugin(EXAMPLE_PLUGIN_DIR, { registry: noStore, store: { plugins: [] } });
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.error, undefined);
  assert.equal(disabled.api, null);
  assert.equal(noStore.list().length, 0, 'a disabled plugin must not register tools');

  const untrusted = createFakeRegistry();
  const untrustedRuntime = await loadPlugin(EXAMPLE_PLUGIN_DIR, {
    registry: untrusted,
    store: { plugins: [exampleRecord({ trusted: false })] },
  });
  assert.equal(untrustedRuntime.status, 'disabled');
  assert.equal(untrusted.list().length, 0);

  const off = createFakeRegistry();
  const offRuntime = await loadPlugin(EXAMPLE_PLUGIN_DIR, {
    registry: off,
    store: { plugins: [exampleRecord({ enabled: false })] },
  });
  assert.equal(offRuntime.status, 'disabled');
  assert.equal(off.list().length, 0);
});

test('loadPlugin reports an error when plugin.json or the entry file is missing', async (t) => {
  const registry = createFakeRegistry();

  const noManifestDir = await makePluginDir(t, { manifest: false });
  const noManifest = await loadPlugin(noManifestDir, { registry, store: { plugins: [] } });
  assert.equal(noManifest.status, 'error');
  assert.match(noManifest.error, /plugin\.json/i);

  const missingMainDir = await makePluginDir(t, { name: 'missing-main', main: 'entry.mjs', code: null });
  const missingMain = await loadPlugin(missingMainDir, {
    registry,
    store: { plugins: [{ id: 'missing-main', dir: missingMainDir, trusted: true, enabled: true }] },
  });
  assert.equal(missingMain.status, 'error');
  assert.match(missingMain.error, /not found/i);
  assert.equal(registry.list().length, 0);

  const badJsonDir = await makePluginDir(t, { code: 'export function activate() {}' });
  await fs.writeFile(path.join(badJsonDir, 'plugin.json'), '{ not json', 'utf8');
  const badJson = await loadPlugin(badJsonDir, { registry, store: { plugins: [] } });
  assert.equal(badJson.status, 'error');
  assert.match(badJson.error, /JSON/i);

  const noJsonButTrusted = await loadPlugin(noManifestDir, { registry, store: { plugins: [{ dir: noManifestDir, trusted: true }] } });
  assert.equal(noJsonButTrusted.status, 'error');
});

test('a module that throws on import yields status error without throwing', async (t) => {
  const dir = await makePluginDir(t, {
    name: 'explodes-on-import',
    code: 'throw new Error("boom at import time");',
  });
  const registry = createFakeRegistry();
  const runtime = await loadPlugin(dir, {
    registry,
    store: { plugins: [{ id: 'explodes-on-import', dir, trusted: true, enabled: true }] },
  });

  assert.equal(runtime.status, 'error');
  assert.match(runtime.error, /boom at import time/);
  assert.equal(registry.list().length, 0);
});

test('a plugin that throws inside activate is rolled back', async (t) => {
  const dir = await makePluginDir(t, {
    name: 'half-way',
    code: [
      'export async function activate(api) {',
      '  api.registerTool({ name: "first", title: "First", description: "d", parameters: { type: "object" }, run: async () => ({ ok: true, summary: "s", content: "c" }) });',
      '  api.registerTool({ name: "second", title: "Second", description: "d", parameters: { type: "object" }, run: async () => ({ ok: true, summary: "s", content: "c" }) });',
      '  throw new Error("activate failed");',
      '}',
    ].join('\n'),
  });
  const registry = createFakeRegistry();
  const warnings = [];

  const runtime = await loadPlugin(dir, {
    registry,
    store: { plugins: [{ id: 'half-way', dir, trusted: true, enabled: true }] },
    logger: { warn: (m) => warnings.push(m), info: () => {}, error: () => {}, debug: () => {} },
  });

  assert.equal(runtime.status, 'error');
  assert.match(runtime.error, /activate failed/);
  assert.equal(registry.get('plugin.half-way.first'), undefined, 'tool registered before the throw must be rolled back');
  assert.equal(registry.get('plugin.half-way.second'), undefined);
  assert.equal(registry.list().length, 0);
  assert.deepEqual(runtime.tools, []);
  assert.equal(runtime.activate, undefined);
  assert.equal(runtime.deactivate, undefined);
});

test('loadPlugin requires an exported activate()', async (t) => {
  const dir = await makePluginDir(t, { name: 'no-activate', code: 'export const nothing = 1;' });
  const runtime = await loadPlugin(dir, {
    registry: createFakeRegistry(),
    store: { plugins: [{ id: 'no-activate', dir, trusted: true }] },
  });
  assert.equal(runtime.status, 'error');
  assert.match(runtime.error, /activate/i);
});

test('loadPlugins scans a directory and never throws for broken entries', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-plugins-root-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const good = path.join(root, 'aaa-plugin');
  await fs.mkdir(good, { recursive: true });
  await fs.writeFile(path.join(good, 'plugin.json'), JSON.stringify({ name: 'aaa-plugin', version: '2.0.0', main: 'index.mjs' }), 'utf8');
  await fs.writeFile(path.join(good, 'index.mjs'), [
    'export function activate(api) {',
    '  api.registerTool({ name: "ping", title: "Ping", description: "d", parameters: { type: "object" }, run: async () => ({ ok: true, summary: "pong", content: "pong" }) });',
    '}',
  ].join('\n'), 'utf8');

  const broken = path.join(root, 'zzz-broken');
  await fs.mkdir(broken, { recursive: true });
  await fs.writeFile(path.join(broken, 'plugin.json'), JSON.stringify({ name: 'zzz-broken', main: 'missing.mjs' }), 'utf8');

  await fs.mkdir(path.join(root, '.hidden-plugin'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(root, 'loose-file.txt'), 'ignored', 'utf8');

  const registry = createFakeRegistry();
  const store = {
    plugins: [
      { id: 'aaa-plugin', dir: good, trusted: true, enabled: true },
      { id: 'zzz-broken', dir: broken, trusted: true, enabled: true },
      { id: 'example-tools', dir: EXAMPLE_PLUGIN_DIR, trusted: true, enabled: true },
    ],
  };

  const runtimes = await loadPlugins({ dir: [root, path.dirname(EXAMPLE_PLUGIN_DIR), path.join(root, 'does-not-exist')], registry, store });

  assert.equal(runtimes.length, 3);
  assert.deepEqual(runtimes.map(runtime => runtime.name), ['aaa-plugin', 'example-tools', 'zzz-broken']);
  assert.equal(runtimes.filter(runtime => runtime.status === 'active').length, 2);
  assert.equal(runtimes.find(runtime => runtime.name === 'zzz-broken').status, 'error');
  assert.ok(registry.get('plugin.aaa-plugin.ping'));
  assert.ok(registry.get(EXAMPLE_TOOL));

  const again = await loadPlugins({ dir: root, registry: createFakeRegistry(), store });
  assert.equal(again.length, 2, 'hidden, node_modules and non-directories are ignored');
  assert.ok(again.every(runtime => ['active', 'error', 'disabled'].includes(runtime.status)));
});

test('loadPlugins accepts a single plugin directory or an array of roots', async () => {
  const registry = createFakeRegistry();
  const store = { plugins: [exampleRecord()] };

  const single = await loadPlugins({ dir: EXAMPLE_PLUGIN_DIR, registry, store });
  assert.equal(single.length, 0, 'a plugin directory is not a container of plugins');

  const root = await loadPlugins({ dir: path.dirname(EXAMPLE_PLUGIN_DIR), registry, store });
  assert.equal(root.length, 1);
  assert.equal(root[0].name, EXAMPLE_PLUGIN_NAME);
});

test('unloadPlugin calls deactivate and drops the plugin tools', async (t) => {
  const deactivateFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-deactivate-')), 'deactivated.txt');
  t.after(async () => { await fs.rm(path.dirname(deactivateFile), { recursive: true, force: true }); });

  const dir = await makePluginDir(t, {
    name: 'with-teardown',
    code: [
      `import fs from 'node:fs/promises';`,
      `export function activate(api) {`,
      `  api.registerTool({ name: "touch", title: "Touch", description: "d", parameters: { type: "object" }, run: async () => ({ ok: true, summary: "s", content: "c" }) });`,
      `}`,
      `export async function deactivate() {`,
      `  await fs.writeFile(${JSON.stringify(deactivateFile)}, 'bye', 'utf8');`,
      `}`,
    ].join('\n'),
  });

  const registry = createFakeRegistry();
  const runtime = await loadPlugin(dir, {
    registry,
    store: { plugins: [{ id: 'with-teardown', dir, trusted: true, enabled: true }] },
  });
  assert.equal(runtime.status, 'active');
  assert.ok(registry.get('plugin.with-teardown.touch'));

  const unloaded = await unloadPlugin(runtime, { registry });
  assert.equal(unloaded.status, 'disabled');
  assert.equal(await fs.readFile(deactivateFile, 'utf8'), 'bye');
  assert.equal(registry.get('plugin.with-teardown.touch'), undefined);
  assert.deepEqual(unloaded.tools, []);
});

test('a throwing deactivate() is swallowed and still unregisters tools', async (t) => {
  const dir = await makePluginDir(t, {
    name: 'bad-teardown',
    code: [
      'export function activate(api) {',
      '  api.registerTool({ name: "t", title: "T", description: "d", parameters: { type: "object" }, run: async () => ({ ok: true, summary: "s", content: "c" }) });',
      '}',
      'export function deactivate() { throw new Error("teardown failed"); }',
    ].join('\n'),
  });
  const registry = createFakeRegistry();
  const warnings = [];
  const runtime = await loadPlugin(dir, {
    registry,
    store: { plugins: [{ id: 'bad-teardown', dir, trusted: true, enabled: true }] },
    logger: { warn: (m) => warnings.push(m), info: () => {}, error: () => {}, debug: () => {} },
  });

  const unloaded = await unloadPlugin(runtime, { registry, logger: { warn: (m) => warnings.push(m) } });
  assert.equal(unloaded.status, 'disabled');
  assert.equal(registry.get('plugin.bad-teardown.t'), undefined);
  assert.ok(warnings.some(line => /teardown failed/.test(line)));
});

test('runtime.prefix matches the host registry unregisterByPrefix contract', async () => {
  const registered = new Map();
  const registry = {
    register(tool) {
      registered.set(tool.name, tool);
      return tool;
    },
    unregister(name) {
      return registered.delete(name);
    },
    unregisterByPrefix(prefix) {
      let count = 0;
      for (const name of [...registered.keys()]) {
        if (name.startsWith(prefix)) {
          registered.delete(name);
          count += 1;
        }
      }
      return count;
    },
  };

  const runtime = await loadPlugin(EXAMPLE_PLUGIN_DIR, { registry, store: { plugins: [exampleRecord()] } });
  assert.equal(runtime.status, 'active');
  assert.equal(runtime.prefix, `plugin.${EXAMPLE_PLUGIN_NAME}.`);
  assert.equal(runtime.prefix, EXAMPLE_TOOL.slice(0, EXAMPLE_TOOL.lastIndexOf('.') + 1));
  assert.equal(registered.size, 1);

  // The runtime id contains @version and must NOT be used as a prefix.
  assert.equal(registry.unregisterByPrefix(`plugin.${runtime.id}.`), 0);
  assert.equal(registered.size, 1);
  assert.equal(registry.unregisterByPrefix(runtime.prefix), 1);
  assert.equal(registered.size, 0);
});

test('reloading a plugin from the same directory works twice', async () => {
  const url = pathToFileURL(path.join(EXAMPLE_PLUGIN_DIR, 'index.mjs'));
  assert.match(url.href, /^file:\/\/\//);

  const store = { plugins: [exampleRecord()] };
  // Two independent registries, as `/plugins/reload` would use.
  const first = await loadPlugin(EXAMPLE_PLUGIN_DIR, { registry: createFakeRegistry(), store });
  const reloaded = await loadPlugin(EXAMPLE_PLUGIN_DIR, { registry: createFakeRegistry(), store });

  assert.equal(first.status, 'active');
  assert.equal(reloaded.status, 'active');
  assert.deepEqual(reloaded.tools, [EXAMPLE_TOOL]);
  assert.equal(reloaded.commands[0].name, 'hello');
});
