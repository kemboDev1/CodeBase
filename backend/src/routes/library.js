import { Router } from 'express';
import { makeId, saveStore } from '../store.js';
import { str, optionalStr, bool, envMap, stringList, oneOf } from '../lib/validate.js';
import { badRequest } from '../lib/errors.js';

/**
 * Library routes: memories, skills, MCP servers and plugins.
 * Every subsystem is injected, so a failing subsystem degrades instead of crashing.
 */
export function createLibraryRoutes({ store, skills, mcp, plugins }) {
  const router = Router();

  // ── memories ───────────────────────────────────────────────────────────────
  router.get('/memories', (_req, res) => {
    res.json({ memories: store.memories });
  });

  router.post('/memories', async (req, res, next) => {
    try {
      const content = str(req.body?.content, 'content', { max: 3_000 });
      const memory = {
        id: makeId('memory'),
        content,
        tags: stringList(req.body?.tags, 'tags', { max: 8, itemMax: 40 }),
        createdAt: new Date().toISOString()
      };
      store.memories.unshift(memory);
      await saveStore();
      res.status(201).json({ memory });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/memories/:id', async (req, res, next) => {
    try {
      const before = store.memories.length;
      store.memories = store.memories.filter((memory) => memory.id !== req.params.id);
      if (before === store.memories.length) throw badRequest('Memory topilmadi.');
      await saveStore();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // ── skills ─────────────────────────────────────────────────────────────────
  router.get('/skills', (_req, res) => {
    res.json({ skills: store.skills, dirs: skills?.dirs?.() || [] });
  });

  router.post('/skills', async (req, res, next) => {
    try {
      const name = str(req.body?.name, 'name', { max: 80 });
      const content = str(req.body?.content, 'content', { max: 100_000 });
      const skill = {
        id: makeId('skill'),
        name,
        description: optionalStr(req.body?.description, 'description', { max: 400 }),
        whenToUse: optionalStr(req.body?.whenToUse, 'whenToUse', { max: 400 }),
        content,
        enabled: req.body?.enabled === undefined ? true : bool(req.body.enabled, true),
        source: 'inline',
        createdAt: new Date().toISOString()
      };
      store.skills.unshift(skill);
      await saveStore();
      res.status(201).json({ skill });
    } catch (error) {
      next(error);
    }
  });

  router.post('/skills/import', async (req, res, next) => {
    try {
      const from = str(req.body?.from, 'from', { max: 1_000 });
      if (typeof skills?.importSkill !== 'function') throw badRequest('Skill import hozir mavjud emas.');
      const skill = await skills.importSkill(from);
      res.status(201).json({ skill });
    } catch (error) {
      next(error);
    }
  });

  router.post('/skills/reload', async (_req, res, next) => {
    try {
      if (typeof skills?.reload === 'function') await skills.reload();
      res.json({ ok: true, skills: store.skills });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/skills/:id', async (req, res, next) => {
    try {
      const skill = store.skills.find((item) => item.id === req.params.id);
      if (!skill) throw badRequest('Skill topilmadi.');
      if (req.body?.enabled !== undefined) skill.enabled = bool(req.body.enabled, skill.enabled);
      if (req.body?.name !== undefined) skill.name = str(req.body.name, 'name', { max: 80 });
      if (req.body?.description !== undefined) skill.description = String(req.body.description).slice(0, 400);
      if (req.body?.whenToUse !== undefined) skill.whenToUse = String(req.body.whenToUse).slice(0, 400);
      if (req.body?.content !== undefined) skill.content = String(req.body.content).slice(0, 100_000);
      await saveStore();
      res.json({ skill });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/skills/:id', async (req, res, next) => {
    try {
      store.skills = store.skills.filter((skill) => skill.id !== req.params.id);
      await saveStore();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // ── MCP servers ────────────────────────────────────────────────────────────
  router.get('/mcp/servers', (_req, res) => {
    res.json({ servers: typeof mcp?.list === 'function' ? mcp.list() : store.mcpServers });
  });

  router.post('/mcp/servers', async (req, res, next) => {
    try {
      const name = str(req.body?.name, 'name', { max: 60 });
      const command = str(req.body?.command, 'command', { max: 400 });
      const server = {
        id: makeId('mcp'),
        name,
        command,
        args: stringList(req.body?.args, 'args', { max: 60, itemMax: 400 }),
        env: envMap(req.body?.env, 'env'),
        cwd: optionalStr(req.body?.cwd, 'cwd', { max: 500 }) || '',
        transport: 'stdio',
        enabled: req.body?.enabled === undefined ? true : bool(req.body.enabled, true),
        autoStart: bool(req.body?.autoStart, false),
        trust: req.body?.trust === 'trusted' ? 'trusted' : 'untrusted',
        createdAt: new Date().toISOString(),
        lastStatus: 'stopped'
      };
      store.mcpServers.push(server);
      await saveStore();
      if (typeof mcp?.reload === 'function') await mcp.reload();
      if (server.enabled && server.autoStart && typeof mcp?.start === 'function') {
        await mcp.start(server.id).catch(() => {});
      }
      res.status(201).json({ server: typeof mcp?.list === 'function' ? mcp.list().find((item) => item.id === server.id) || server : server });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/mcp/servers/:id', async (req, res, next) => {
    try {
      const server = store.mcpServers.find((item) => item.id === req.params.id);
      if (!server) throw badRequest('MCP server topilmadi.');
      if (req.body?.name !== undefined) server.name = str(req.body.name, 'name', { max: 60 });
      if (req.body?.command !== undefined) server.command = str(req.body.command, 'command', { max: 400 });
      if (req.body?.args !== undefined) server.args = stringList(req.body.args, 'args', { max: 60, itemMax: 400 });
      if (req.body?.env !== undefined) server.env = envMap(req.body.env, 'env');
      if (req.body?.cwd !== undefined) server.cwd = String(req.body.cwd || '').slice(0, 500);
      if (req.body?.enabled !== undefined) server.enabled = bool(req.body.enabled, server.enabled);
      if (req.body?.autoStart !== undefined) server.autoStart = bool(req.body.autoStart, server.autoStart);
      if (req.body?.trust !== undefined) server.trust = req.body.trust === 'trusted' ? 'trusted' : 'untrusted';
      await saveStore();
      if (typeof mcp?.reload === 'function') await mcp.reload();
      res.json({ server: typeof mcp?.list === 'function' ? mcp.list().find((item) => item.id === server.id) || server : server });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/mcp/servers/:id', async (req, res, next) => {
    try {
      if (typeof mcp?.stop === 'function') await mcp.stop(req.params.id).catch(() => {});
      store.mcpServers = store.mcpServers.filter((server) => server.id !== req.params.id);
      await saveStore();
      if (typeof mcp?.reload === 'function') await mcp.reload();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  const action = (method) => async (req, res, next) => {
    try {
      if (typeof mcp?.[method] !== 'function') throw badRequest(`MCP ${method} mavjud emas.`);
      const result = await mcp[method](req.params.id);
      res.json({ ok: true, result, servers: typeof mcp.list === 'function' ? mcp.list() : [] });
    } catch (error) {
      next(error);
    }
  };

  router.post('/mcp/servers/:id/start', action('start'));
  router.post('/mcp/servers/:id/stop', action('stop'));
  router.post('/mcp/servers/:id/restart', action('restart'));

  router.get('/mcp/servers/:id/tools', async (req, res, next) => {
    try {
      if (typeof mcp?.tools !== 'function') throw badRequest('MCP tools mavjud emas.');
      res.json({ tools: await mcp.tools(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  // ── plugins ────────────────────────────────────────────────────────────────
  router.get('/plugins', (_req, res) => {
    res.json({ plugins: typeof plugins?.list === 'function' ? plugins.list() : store.plugins });
  });

  router.post('/plugins/reload', async (_req, res, next) => {
    try {
      if (typeof plugins?.reload === 'function') await plugins.reload();
      res.json({ ok: true, plugins: typeof plugins?.list === 'function' ? plugins.list() : [] });
    } catch (error) {
      next(error);
    }
  });

  router.post('/plugins/:id/toggle', async (req, res, next) => {
    try {
      const enabled = bool(req.body?.enabled, false);
      const trusted = req.body?.trusted === undefined ? enabled : bool(req.body.trusted, enabled);
      const record = store.plugins.find((plugin) => plugin.id === req.params.id);
      if (!record) throw badRequest('Plugin topilmadi.');
      record.enabled = enabled;
      record.trusted = trusted;
      await saveStore();
      if (typeof plugins?.reload === 'function') await plugins.reload();
      res.json({ ok: true, plugin: { ...record }, plugins: typeof plugins?.list === 'function' ? plugins.list() : [] });
    } catch (error) {
      next(error);
    }
  });

  router.get('/audit', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query?.limit) || 100));
    const filter = req.query?.tool ? String(req.query.tool) : '';
    const entries = filter ? store.audit.filter((entry) => entry.tool === filter) : store.audit;
    res.json({ audit: entries.slice(0, limit) });
  });

  router.get('/policies', (_req, res) => {
    res.json({ policies: store.toolPolicies, pathRules: store.pathRules, tools: oneOf(store.settings.mode, ['auto', 'fast', 'deep'], 'mode', 'auto') });
  });

  return router;
}

export default createLibraryRoutes;
