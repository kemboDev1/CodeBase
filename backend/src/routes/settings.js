import fs from 'node:fs/promises';
import { Router } from 'express';
import { config, setRuntimeSettings } from '../config.js';
import { saveStore, backupStore } from '../store.js';
import { getRoots } from '../lib/paths.js';
import { computeRoots } from '../lib/workspace.js';
import { optionalStr, num, bool, oneOf, stringList } from '../lib/validate.js';
import { setOllamaUrl } from '../ollama/client.js';
import { badRequest } from '../lib/errors.js';

export function createSettingsRoutes({ store, onRootsChanged }) {
  const router = Router();

  async function apply() {
    setRuntimeSettings(store.settings);
    setOllamaUrl(store.settings.ollamaUrl);
    const roots = await computeRoots({ store });
    if (typeof onRootsChanged === 'function') onRootsChanged(roots);
    return roots;
  }

  router.get('/settings', (_req, res) => {
    res.json({
      settings: store.settings,
      ollamaUrl: store.settings.ollamaUrl || config.ollamaUrl,
      version: config.version,
      port: config.port,
      dataDir: config.dataDir,
      roots: getRoots(),
      audit: store.audit.slice(0, 50)
    });
  });

  router.patch('/settings', async (req, res, next) => {
    try {
      const body = req.body || {};
      if (body.model !== undefined) store.settings.model = optionalStr(body.model, 'model', { max: 150 });
      if (body.fastModel !== undefined) store.settings.fastModel = optionalStr(body.fastModel, 'fastModel', { max: 150 });
      if (body.numCtx !== undefined) store.settings.numCtx = num(body.numCtx, 'numCtx', { min: 1024, max: 131_072 });
      if (body.temperature !== undefined) store.settings.temperature = num(body.temperature, 'temperature', { min: 0, max: 2 });
      if (body.maxSteps !== undefined) store.settings.maxSteps = num(body.maxSteps, 'maxSteps', { min: 1, max: 40 });
      if (body.mode !== undefined) store.settings.mode = oneOf(body.mode, ['auto', 'fast', 'deep'], 'mode');
      if (body.summarize !== undefined) store.settings.summarize = bool(body.summarize, store.settings.summarize);
      if (body.stream !== undefined) store.settings.stream = bool(body.stream, store.settings.stream);
      if (body.autoApproveReads !== undefined) store.settings.autoApproveReads = bool(body.autoApproveReads, store.settings.autoApproveReads);
      if (body.theme !== undefined) store.settings.theme = oneOf(body.theme, ['dark', 'light'], 'theme');
      if (body.autostartOllama !== undefined) store.settings.autostartOllama = bool(body.autostartOllama, store.settings.autostartOllama);
      if (body.ollamaUrl !== undefined) {
        const url = optionalStr(body.ollamaUrl, 'ollamaUrl', { max: 300 });
        if (url && !/^https?:\/\//i.test(url)) throw badRequest('ollamaUrl http(s) bilan boshlanishi kerak.');
        if (url) store.settings.ollamaUrl = url.replace(/\/+$/, '');
      }
      if (body.workspaceRoots !== undefined) {
        const roots = stringList(body.workspaceRoots, 'workspaceRoots', { max: 50, itemMax: 500 });
        const checked = [];
        for (const root of roots) {
          const stat = await fs.stat(root).catch(() => null);
          if (!stat?.isDirectory()) throw badRequest(`Papka topilmadi: ${root}`);
          checked.push(root);
        }
        store.settings.workspaceRoots = checked;
      }

      await saveStore();
      await apply();
      res.json({ settings: store.settings, roots: getRoots() });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings/backup', async (_req, res, next) => {
    try {
      res.json({ ok: true, file: await backupStore('settings') });
    } catch (error) {
      next(error);
    }
  });

  apply().catch(() => {});
  return router;
}

export default createSettingsRoutes;
