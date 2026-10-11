import 'dotenv/config';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import express from 'express';
import cors from 'cors';

import { config, setRuntimeSettings } from './config.js';
import { logger, setLogLevel } from './lib/logger.js';
import { toHttpError } from './lib/errors.js';
import { setRoots, getRoots } from './lib/paths.js';
import { computeRoots } from './lib/workspace.js';
import { openSse } from './lib/sse.js';
import { getStore, saveStore } from './store.js';
import { setOllamaUrl } from './ollama/client.js';
import { createRegistry } from './agent/registry.js';
import { createPermissions } from './agent/permissions.js';
import { createRunRegistry } from './agent/runs.js';
import { registerCoreTools } from './agent/tools/index.js';
import { createOllamaSupervisor } from './system/ollama.js';
import { loadSkills, importSkill, parseSkillMarkdown } from './skills/registry.js';
import { loadPlugins, unloadPlugin } from './plugins/loader.js';
import { createMcpManager } from './mcp/manager.js';
import { createApiRouter } from './routes/index.js';

const log = logger.make('server');
const bus = new EventEmitter();
bus.setMaxListeners(50);

const emit = (payload) => {
  try {
    bus.emit('event', { at: new Date().toISOString(), ...payload });
  } catch (error) {
    log.debug(`Event yuborilmadi: ${error.message}`);
  }
};

// ── bootstrap ────────────────────────────────────────────────────────────────
const store = await getStore();
setLogLevel(process.env.CODEBASE_LOG || 'info');
setRuntimeSettings(store.settings);
setOllamaUrl(store.settings.ollamaUrl || config.ollamaUrl);

/** Workspace roots = user folders + every project root. Defaults to data/workspace. */
async function refreshRoots() {
  return computeRoots({ store, dataDir: config.dataDir });
}
await refreshRoots();

const registry = createRegistry({ logger: logger.make('registry') });
registerCoreTools(registry, { logger: logger.make('tools') });
const permissions = createPermissions({ store, emit, logger: logger.make('permissions') });
const runs = createRunRegistry({ logger: logger.make('runs') });
const supervisor = createOllamaSupervisor();

// ── skills service ───────────────────────────────────────────────────────────
function skillDirs() {
  const dirs = [config.skillsDir];
  for (const project of store.projects) {
    if (project.root) dirs.push(path.join(project.root, '.codebase', 'skills'));
  }
  return [...new Set(dirs)];
}

/** Merge builtin/file skills from disk into the store (keeps the user's enabled flag). */
function syncSkillsIntoStore(loaded) {
  const byId = new Map(store.skills.map((skill) => [skill.id, skill]));
  for (const skill of loaded || []) {
    const existing = byId.get(skill.id);
    if (existing) {
      existing.name = skill.name || existing.name;
      existing.description = skill.description ?? existing.description;
      existing.whenToUse = skill.whenToUse ?? existing.whenToUse;
      if (skill.content && skill.content !== existing.content) existing.content = skill.content;
      existing.source = skill.source || existing.source;
      existing.path = skill.path || existing.path;
    } else {
      store.skills.push({ ...skill, enabled: skill.enabled !== false });
    }
  }
}

const skills = {
  list: () => store.skills,
  dirs: () => skillDirs(),
  parse: (text, file) => parseSkillMarkdown(text, file),
  reload: async () => {
    const loaded = await loadSkills({ dirs: skillDirs(), store, logger: logger.make('skills') });
    syncSkillsIntoStore(loaded);
    await saveStore();
    log.info(`${store.skills.length} skill yuklandi (${store.skills.filter((s) => s.enabled).length} yoqilgan).`);
    return store.skills;
  },
  importSkill: async (from) => {
    const skill = await importSkill({ from, store, logger: logger.make('skills') });
    const existing = store.skills.find((item) => item.id === skill.id);
    if (existing) Object.assign(existing, skill);
    else store.skills.unshift(skill);
    await saveStore();
    return skill;
  }
};
await skills.reload();

// ── plugins service ──────────────────────────────────────────────────────────
let pluginRuntimes = [];

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Plugin container directories: the user's plugin folder plus the examples that
 * ship with the app (they are discovered as untrusted and stay disabled until the
 * user enables them from the Plugins page).
 */
function pluginContainerDirs() {
  const candidates = [
    config.pluginsDir,
    path.join(here, 'examples'), // bundled: backend/dist/examples
    path.join(here, '..', 'examples'), // dev: backend/examples
    process.resourcesPath ? path.join(process.resourcesPath, 'backend', 'dist', 'examples') : ''
  ].filter(Boolean);

  const existing = [];
  for (const dir of candidates) {
    if (isDirectory(dir)) existing.push(dir);
  }
  return [...new Set(existing)];
}

function isDirectory(target) {
  try {
    return fsSync.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Discover plugin folders and make sure each one has a (disabled-by-default) store record. */
async function discoverPlugins() {
  const containers = pluginContainerDirs();
  const found = [];
  for (const container of containers) {
    await fs.mkdir(container, { recursive: true }).catch(() => {});
    const entries = await fs.readdir(container, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(container, entry.name);
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
        found.push({ dir, manifest });
      } catch {
        continue; // not a plugin folder
      }
    }
  }
  for (const { dir, manifest } of found) {
    const id = String(manifest.name || path.basename(dir)).toLowerCase();
    const existing = store.plugins.find((plugin) => plugin.id === id || plugin.dir === dir);
    if (existing) {
      existing.dir = dir;
      existing.name = manifest.name || existing.name;
      existing.version = manifest.version || existing.version;
      existing.description = manifest.description || existing.description;
      existing.main = manifest.main || existing.main || 'index.mjs';
    } else {
      store.plugins.push({
        id,
        dir,
        name: manifest.name || path.basename(dir),
        version: manifest.version || '0.0.0',
        description: manifest.description || '',
        main: manifest.main || 'index.mjs',
        enabled: false,
        trusted: false,
        createdAt: new Date().toISOString()
      });
    }
  }
  await saveStore();
  return found;
}

/** Find the store record that belongs to a plugin runtime (id, slug or directory). */
function pluginRecordFor(runtime) {
  return (
    store.plugins.find((plugin) => plugin.id === runtime.id) ||
    store.plugins.find((plugin) => plugin.id === runtime.name) ||
    store.plugins.find((plugin) => plugin.dir && runtime.dir && path.resolve(plugin.dir) === path.resolve(runtime.dir)) ||
    null
  );
}

const plugins = {
  list: () =>
    pluginRuntimes.map((runtime) => {
      const record = pluginRecordFor(runtime) || {};
      return {
        id: record.id || runtime.id,
        runtimeId: runtime.id,
        dir: runtime.dir,
        name: runtime.name,
        version: runtime.version,
        description: runtime.description || record.description || '',
        status: runtime.status,
        error: runtime.error || '',
        tools: (runtime.tools || []).map((tool) => (typeof tool === 'string' ? tool : tool?.name)).filter(Boolean),
        commands: (runtime.commands || []).map((command) => command.name || command),
        enabled: record.enabled === true,
        trusted: record.trusted === true,
        configured: Boolean(record.id)
      };
    }),
  commands: () =>
    pluginRuntimes.flatMap((runtime) =>
      (runtime.commands || []).map((command) => ({ ...command, plugin: runtime.name }))
    ),
  reload: async () => {
    for (const runtime of pluginRuntimes) {
      const prefix = runtime.prefix || `plugin.${runtime.name}.`;
      try {
        await unloadPlugin(runtime, { registry, logger: logger.make('plugins') });
      } catch (error) {
        log.warn(`Plugin yopilmadi (${runtime.name}): ${error.message}`);
      }
      registry.unregisterByPrefix(prefix);
    }
    pluginRuntimes = [];
    const containers = await discoverPlugins();
    try {
      pluginRuntimes = await loadPlugins({
        dir: containers.map((entry) => entry.dir).length
          ? [...new Set(containers.map((entry) => path.dirname(entry.dir)))]
          : pluginContainerDirs(),
        registry,
        logger: logger.make('plugins'),
        store,
        getStore,
        saveStore,
        emit,
        dataDir: config.dataDir
      });
    } catch (error) {
      log.error(`Pluginlar yuklanmadi: ${error.message}`);
      pluginRuntimes = [];
    }
    const active = pluginRuntimes.filter((runtime) => runtime.status === 'active').length;
    log.info(`${pluginRuntimes.length} plugin topildi, ${active} faol.`);
    return plugins.list();
  }
};
await plugins.reload();

// ── MCP ──────────────────────────────────────────────────────────────────────
const mcp = createMcpManager({ store, registry, logger: logger.make('mcp'), emit });
try {
  if (typeof mcp.reload === 'function') await mcp.reload();
  if (typeof mcp.startAuto === 'function') await mcp.startAuto();
} catch (error) {
  log.error(`MCP ishga tushmadi: ${error.message}`);
}

// ── express app ──────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');

const localOrigin = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || origin === 'null' || localOrigin.test(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: false
  })
);
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/** Token gate: the renderer receives the token through the Electron preload bridge. */
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  if (req.path === '/api/health') return next();
  if (config.allowAnon || !config.token) return next();
  const provided = req.get('x-codebase-token') || req.query?.token || '';
  if (String(provided) === config.token) return next();
  res.status(401).json({ error: 'Token noto‘g‘ri yoki yuborilmagan.', code: 'unauthorized' });
});

/** Live status stream for the UI (Ollama state, MCP changes, permission events). */
app.get('/api/events', (req, res) => {
  const sse = openSse(req, res, { pingMs: 20_000 });
  const onEvent = (payload) => sse.send(payload);
  bus.on('event', onEvent);
  req.on('close', () => bus.off('event', onEvent));
  sse.send({ type: 'hello', version: config.version, port: config.port, runs: runs.list().length });
});

app.use(
  '/api',
  createApiRouter({
    store,
    config,
    registry,
    permissions,
    runs,
    skills,
    plugins,
    mcp,
    supervisor,
    emit,
    onRootsChanged: () => {}
  })
);

// ── static web app (packaged desktop mode) ───────────────────────────────────
if (config.webDir) {
  const indexFile = path.join(config.webDir, 'index.html');
  app.use(express.static(config.webDir, { index: false, dotfiles: 'ignore', maxAge: '1h' }));
  app.get(/^\/(?!api(?:\/|$)).*/, (_req, res, next) => {
    if (!fsSync.existsSync(indexFile)) {
      return next(new AppError(`Frontend qurilmagan (${indexFile} topilmadi). "npm --prefix frontend run build" ni ishga tushiring.`, 503, 'web_not_built'));
    }
    // dotfiles:'allow' is required: without it `send` rejects an absolute path that
    // contains a dot-segment (e.g. a checkout in ".ci-repro"), which surfaced as a
    // confusing 404 for "/" while every static asset still worked.
    return res.sendFile(indexFile, { dotfiles: 'allow' }, (error) => {
      if (error && !res.headersSent) {
        log.warn(`index.html yuborilmadi: ${error.message}`);
        next(error);
      }
    });
  });
}

app.use((err, _req, res, _next) => {
  const { status, message, code } = toHttpError(err);
  if (status >= 500) log.error(`${code}: ${message}`);
  else log.debug(`${status} ${code}: ${message}`);
  if (res.headersSent) return;
  res.status(status).json({ error: message, code });
});

// ── lifecycle ────────────────────────────────────────────────────────────────
const server = app.listen(config.port, config.host, () => {
  const address = server.address();
  if (address && typeof address === 'object') config.port = address.port;
  const ready = {
    ok: true,
    service: 'CodeBase API',
    version: config.version,
    host: config.host,
    port: config.port,
    pid: process.pid,
    tools: registry.size(),
    skills: store.skills.length,
    plugins: pluginRuntimes.length,
    roots: getRoots().length,
    dataDir: config.dataDir
  };
  log.info(`CodeBase API tayyor: http://${config.host}:${config.port}`);
  log.info(
    `Ollama: ${config.ollamaUrl} · ${registry.size()} tool · ${store.skills.length} skill · ${pluginRuntimes.length} plugin`
  );
  // The Electron supervisor parses this single line to learn the real port.
  process.stdout.write(`CODEBASE_READY ${JSON.stringify(ready)}\n`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log.error(`Port ${config.port} band. CODEBASE_PORT=0 bilan avtomatik port tanlanadi.`);
  } else {
    log.error(`Server xatosi: ${error.message}`);
  }
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} — to‘xtatilmoqda...`);
  try {
    runs.stopAll();
    if (typeof mcp.stopAll === 'function') await mcp.stopAll();
    for (const runtime of pluginRuntimes) {
      try {
        if (typeof runtime.deactivate === 'function') await runtime.deactivate();
      } catch {
        /* ignore */
      }
    }
    await saveStore();
  } catch (error) {
    log.warn(`To‘xtatishda xato: ${error.message}`);
  } finally {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => log.error(`Unhandled rejection: ${reason?.message || reason}`));
process.on('uncaughtException', (error) => log.error(`Uncaught exception: ${error.message}\n${error.stack || ''}`));

export { app, server, store, registry, permissions, runs, skills, plugins, mcp, supervisor };
