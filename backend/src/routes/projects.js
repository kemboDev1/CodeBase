import fs from 'node:fs/promises';
import { Router } from 'express';
import {
  makeId, saveStore, findProject, findSession, createSession, projectSummary, assertProjectRoot
} from '../store.js';
import { str, optionalStr } from '../lib/validate.js';
import { computeRoots } from '../lib/workspace.js';
import { badRequest } from '../lib/errors.js';

export function createProjectRoutes({ store, onRootsChanged }) {
  const router = Router();

  /** Recompute the workspace jail after any project change (never leaves it empty). */
  function refreshRoots() {
    return computeRoots({ store }).then((roots) => {
      if (typeof onRootsChanged === 'function') onRootsChanged(roots);
      return roots;
    });
  }

  router.get('/projects', (_req, res) => {
    res.json({ projects: store.projects.map(projectSummary) });
  });

  router.post('/projects', async (req, res, next) => {
    try {
      const name = str(req.body?.name, 'name', { max: 80 });
      const description = optionalStr(req.body?.description, 'description', { max: 500 });
      const instructions = optionalStr(req.body?.instructions, 'instructions', { max: 8_000 });
      const root = assertProjectRoot(optionalStr(req.body?.root, 'root', { max: 500 }));
      if (root) {
        const stat = await fs.stat(root).catch(() => null);
        if (!stat?.isDirectory()) throw badRequest(`Papka topilmadi: ${root}`);
      }
      const now = new Date().toISOString();
      const session = { id: makeId('session'), name: 'Asosiy suhbat', createdAt: now, updatedAt: now, messages: [] };
      const project = {
        id: makeId('project'),
        name,
        description,
        instructions,
        root: root || null,
        sessions: [session],
        activeSessionId: session.id,
        createdAt: now,
        updatedAt: now
      };
      store.projects.unshift(project);
      await saveStore();
      await refreshRoots();
      res.status(201).json({ project: projectSummary(project) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/projects/:id', (req, res, next) => {
    try {
      const project = findProject(store, req.params.id);
      res.json({ project: { ...projectSummary(project), sessions: project.sessions.map(({ messages, ...rest }) => ({ ...rest, messageCount: messages.length })) } });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/projects/:id', async (req, res, next) => {
    try {
      const project = findProject(store, req.params.id);
      if (req.body?.name !== undefined) project.name = str(req.body.name, 'name', { max: 80 });
      if (req.body?.description !== undefined) project.description = String(req.body.description).slice(0, 500);
      if (req.body?.instructions !== undefined) project.instructions = String(req.body.instructions).slice(0, 8_000);
      if (req.body?.root !== undefined) {
        const root = assertProjectRoot(optionalStr(req.body.root, 'root', { max: 500 }));
        if (root) {
          const stat = await fs.stat(root).catch(() => null);
          if (!stat?.isDirectory()) throw badRequest(`Papka topilmadi: ${root}`);
        }
        project.root = root || null;
      }
      if (req.body?.activeSessionId) findSession(project, req.body.activeSessionId);
      project.updatedAt = new Date().toISOString();
      await saveStore();
      await refreshRoots();
      res.json({ project: projectSummary(project) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/projects/:id', async (req, res, next) => {
    try {
      if (req.params.id === 'general') throw badRequest('General projectni o‘chirib bo‘lmaydi.');
      const index = store.projects.findIndex((project) => project.id === req.params.id);
      if (index < 0) throw badRequest('Project topilmadi.');
      store.projects.splice(index, 1);
      await saveStore();
      await refreshRoots();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get('/projects/:id/sessions', (req, res, next) => {
    try {
      const project = findProject(store, req.params.id);
      res.json({
        activeSessionId: project.activeSessionId,
        sessions: project.sessions.map(({ messages, ...rest }) => ({ ...rest, messageCount: messages.length }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/projects/:id/sessions', async (req, res, next) => {
    try {
      const project = findProject(store, req.params.id);
      const session = createSession(project, optionalStr(req.body?.name, 'name', { max: 80 }) || 'Yangi suhbat');
      await saveStore();
      res.status(201).json({ session: { id: session.id, name: session.name, createdAt: session.createdAt, messageCount: 0 } });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/sessions/:id', async (req, res, next) => {
    try {
      const sessionId = req.params.id;
      for (const project of store.projects) {
        const session = project.sessions.find((item) => item.id === sessionId);
        if (session) {
          if (req.body?.name !== undefined) session.name = str(req.body.name, 'name', { max: 80 });
          if (req.body?.clear === true) {
            session.messages = [];
            session.summary = '';
          }
          session.updatedAt = new Date().toISOString();
          await saveStore();
          return res.json({ session: { id: session.id, name: session.name, messageCount: session.messages.length } });
        }
      }
      res.status(404).json({ error: 'Session topilmadi.' });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/sessions/:id', async (req, res, next) => {
    try {
      for (const project of store.projects) {
        const index = project.sessions.findIndex((item) => item.id === req.params.id);
        if (index >= 0) {
          if (project.sessions.length === 1) throw badRequest('Oxirgi suhbatni o‘chirib bo‘lmaydi.');
          project.sessions.splice(index, 1);
          if (project.activeSessionId === req.params.id) project.activeSessionId = project.sessions[0].id;
          await saveStore();
          return res.json({ ok: true, activeSessionId: project.activeSessionId });
        }
      }
      res.status(404).json({ error: 'Session topilmadi.' });
    } catch (error) {
      next(error);
    }
  });

  router.get('/projects/:id/messages', (req, res, next) => {
    try {
      const project = findProject(store, req.params.id);
      const session = findSession(project, req.query.sessionId);
      res.json({
        session: { id: session.id, name: session.name, summary: session.summary || '' },
        sessions: project.sessions.map(({ messages, ...rest }) => ({ ...rest, messageCount: messages.length })),
        messages: session.messages
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/projects/:id/messages', async (req, res, next) => {
    try {
      const project = findProject(store, req.params.id);
      const session = findSession(project, req.query.sessionId);
      session.messages = [];
      session.summary = '';
      await saveStore();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  refreshRoots().catch(() => {});
  return router;
}

export default createProjectRoutes;
