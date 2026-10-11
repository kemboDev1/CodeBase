import os from 'node:os';
import { Router } from 'express';
import * as ollama from '../ollama/client.js';
import { config } from '../config.js';
import { logger, ringBuffer, setLogLevel } from '../lib/logger.js';
import { getRoots } from '../lib/paths.js';
import { backupStore } from '../store.js';
import { bool } from '../lib/validate.js';

export function createSystemRoutes({ store, supervisor, mcp, plugins, skills, version = config.version }) {
  const router = Router();
  const startedAt = Date.now();

  // Token-free liveness probe used by the Electron supervisor and the UI pill.
  router.get('/health', async (_req, res) => {
    const ollamaStatus = await ollama.health().catch((error) => ({ connected: false, models: [], error: error.message }));
    res.json({
      ok: true,
      service: 'CodeBase API',
      version,
      uptimeMs: Date.now() - startedAt,
      port: config.port,
      pid: process.pid,
      ollama: ollamaStatus,
      mcp: { servers: typeof mcp?.list === 'function' ? mcp.list() : [] },
      plugins: { count: Array.isArray(plugins) ? plugins.length : 0 },
      skills: { count: Array.isArray(skills?.list?.()) ? skills.list().length : 0 },
      tools: { count: 0 }
    });
  });

  router.get('/system/info', async (_req, res) => {
    res.json({
      version,
      platform: process.platform,
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
      node: process.version,
      electron: process.env.CODEBASE_ELECTRON || '',
      port: config.port,
      pid: process.pid,
      dataDir: config.dataDir,
      webDir: config.webDir,
      roots: getRoots(),
      models: { main: config.defaultModel, fast: config.fastModel },
      ollama: await supervisor.status().catch(() => ({ connected: false })),
      uptimeMs: Date.now() - startedAt,
      startedAt: new Date(config.startedAt).toISOString()
    });
  });

  router.get('/system/logs', (req, res) => {
    res.json({ logs: ringBuffer(Number(req.query.limit) || 200) });
  });

  router.patch('/system/logs', (req, res) => {
    const level = String(req.body?.level || 'info');
    setLogLevel(level);
    res.json({ ok: true, level });
  });

  router.post('/system/backup', async (_req, res, next) => {
    try {
      const file = await backupStore('api');
      res.json({ ok: Boolean(file), file });
    } catch (error) {
      next(error);
    }
  });

  router.get('/system/ollama', async (_req, res) => {
    res.json(await supervisor.status());
  });

  router.post('/system/ollama/start', async (req, res, next) => {
    try {
      const result = await supervisor.ensureStarted({ force: bool(req.body?.force, true) });
      logger.info(`Ollama start: ${result.ok ? 'OK' : 'XATO'} ${result.error || ''}`);
      res.status(result.ok ? 200 : 502).json({ ...result, ollama: await ollama.health() });
    } catch (error) {
      next(error);
    }
  });

  router.post('/system/ollama/stop', async (_req, res, next) => {
    try {
      const result = await supervisor.stop();
      res.json({ ...result, ollama: await ollama.health() });
    } catch (error) {
      next(error);
    }
  });

  router.get('/system/ollama/autostart', async (_req, res) => {
    res.json({ enabled: await supervisor.autostartEnabled() });
  });

  router.post('/system/ollama/autostart', async (req, res, next) => {
    try {
      const enabled = bool(req.body?.enabled, false);
      const result = await supervisor.setAutostart(enabled);
      if (enabled && result.ok) {
        store.settings.autostartOllama = true;
      } else if (!enabled) {
        store.settings.autostartOllama = false;
      }
      res.status(result.ok ? 200 : 500).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/models', async (_req, res, next) => {
    try {
      res.json({ models: await ollama.listModels() });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createSystemRoutes;
