import { Router } from 'express';
import { config } from '../config.js';
import { findProject, findSession } from '../store.js';
import { str, oneOf, bool } from '../lib/validate.js';
import { openSse } from '../lib/sse.js';
import { runAgent } from '../agent/loop.js';
import { logger } from '../lib/logger.js';

const log = logger.make('routes:agent');

/**
 * Agent routes: the SSE chat endpoint, tool registry control, permission answers,
 * run cancellation and plugin slash commands.
 */
export function createAgentRoutes({ store, registry, permissions, mcp, plugins, skills, runs }) {
  const router = Router();

  router.get('/tools', (_req, res) => {
    res.json({
      tools: registry.list((tool) => permissions.policyFor(tool, {})),
      pending: permissions.pending(),
      policies: store.toolPolicies,
      pathRules: store.pathRules
    });
  });

  router.patch('/tools/:name', async (req, res, next) => {
    try {
      const name = str(req.params.name, 'name', { max: 120 });
      const policy = oneOf(req.body?.policy, ['allow', 'ask', 'deny'], 'policy');
      await permissions.setPolicy(name, policy);
      res.json({ ok: true, name, policy });
    } catch (error) {
      next(error);
    }
  });

  router.post('/tools/path-rules', async (req, res, next) => {
    try {
      const pattern = str(req.body?.pattern, 'pattern', { max: 300 });
      const policy = oneOf(req.body?.policy, ['allow', 'ask', 'deny'], 'policy');
      res.json({ ok: true, pathRules: await permissions.setPathRule(pattern, policy) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/tools/path-rules', async (req, res, next) => {
    try {
      const pattern = str(req.query?.pattern || req.body?.pattern, 'pattern', { max: 300 });
      res.json({ ok: true, pathRules: await permissions.removePathRule(pattern) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/commands', (_req, res) => {
    res.json({ commands: plugins?.commands?.() || [] });
  });

  router.get('/agent/pending', (_req, res) => {
    res.json({ pending: permissions.pending() });
  });

  router.post('/agent/permission/:id', async (req, res, next) => {
    try {
      const id = str(req.params.id, 'id', { max: 120 });
      const approved = bool(req.body?.approved, false);
      const remember = oneOf(req.body?.remember, ['once', 'session', 'always'], 'remember', 'once');
      const pendingEntry = permissions.pending().find((item) => item.id === id);

      const resolved = permissions.resolve(id, { approved, remember });
      if (!resolved) return res.status(404).json({ error: 'Bunday ruxsat so‘rovi yo‘q (muddati o‘tgan bo‘lishi mumkin).' });

      if (approved && remember === 'always' && pendingEntry) await permissions.setPolicy(pendingEntry.tool, 'allow');
      if (approved && remember === 'session' && pendingEntry) {
        permissions.grantSession(pendingEntry.sessionId, pendingEntry.tool);
      }
      res.json({ ok: true, id, approved, remember });
    } catch (error) {
      next(error);
    }
  });

  router.post('/agent/stop', (req, res, next) => {
    try {
      const runId = String(req.body?.runId || '').trim();
      if (!runId) {
        const stopped = runs?.stopAll?.() || 0;
        return res.json({ ok: true, stopped });
      }
      const stopped = runs?.stop?.(runId) ? 1 : 0;
      res.json({ ok: true, stopped, runId });
    } catch (error) {
      next(error);
    }
  });

  /** The main agentic endpoint — streams Server-Sent Events. */
  router.post('/chat', async (req, res, next) => {
    const sse = openSse(req, res);
    try {
      const prompt = str(req.body?.message, 'message', { max: 40_000 });
      const projectId = str(req.body?.projectId || 'general', 'projectId', { max: 120 });
      const project = findProject(store, projectId);
      const session = findSession(project, req.body?.sessionId);
      const requestedModel = typeof req.body?.model === 'string' && req.body.model.trim()
        ? req.body.model.trim().slice(0, 150)
        : store.settings.model || config.defaultModel;
      const mode = oneOf(req.body?.mode ?? store.settings.mode, ['auto', 'fast', 'deep'], 'mode', 'auto');

      const workspaceRoot = project.root || null;
      const controller = new AbortController();
      const runId = runs.start({ sessionId: session.id, projectId: project.id, model: requestedModel, controller });
      const abortRun = (source) => {
        if (controller.signal.aborted) return;
        log.debug(`Run ${runId}: uzildi (${source}) — abort qilinyapti.`);
        controller.abort();
        runs.forget(runId);
      };
      // `res.close` means the client went away; `req.close` only means the request
      // body was fully received, so it must NOT abort a streaming run.
      res.on('close', () => abortRun('res.close'));

      const result = await runAgent({
        prompt,
        project,
        session,
        model: requestedModel,
        mode,
        signal: controller.signal,
        emit: (payload) => sse.send(payload),
        registry,
        permissions,
        store,
        skills: skills?.list?.() || [],
        config,
        workspaceRoot,
        runId
      });

      runs.forget(runId);
      sse.close();
    } catch (error) {
      log.warn(`Chat xatosi: ${error.message}`);
      sse.send({ type: 'error', message: error.message, code: error.code || 'agent_error' });
      sse.close();
      if (!res.headersSent) next(error);
    }
  });

  return router;
}

export default createAgentRoutes;
