import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { ignoredDir, ignoredFile, resolveInside, toRel, getRoots } from '../lib/paths.js';
import { str, num, bool } from '../lib/validate.js';
import { badRequest } from '../lib/errors.js';
import { humanBytes, truncate } from '../lib/text.js';

const MAX_READ = 1_500_000;

/**
 * File explorer API used by the Files page and the terminal page.
 * Every path goes through the workspace jail.
 */
export function createFileRoutes({ store, permissions }) {
  const router = Router();

  router.get('/files/roots', (_req, res) => {
    res.json({
      roots: getRoots(),
      projects: store.projects.map((project) => ({ id: project.id, name: project.name, root: project.root }))
    });
  });

  router.get('/files/tree', async (req, res, next) => {
    try {
      const root = req.query.root ? resolveInside(null, String(req.query.root)) : getRoots()[0];
      if (!root) throw badRequest('Workspace papka tanlanmagan.');
      const depth = Math.min(6, Math.max(1, Number(req.query.depth) || 2));

      const build = async (dir, level) => {
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        const nodes = [];
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const entry of entries.slice(0, 400)) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (ignoredDir(entry.name)) continue;
            nodes.push({
              name: entry.name,
              path: toRel(full),
              type: 'directory',
              children: level + 1 < depth ? await build(full, level + 1) : null
            });
          } else if (entry.isFile()) {
            const stat = await fs.stat(full).catch(() => null);
            nodes.push({ name: entry.name, path: toRel(full), type: 'file', size: stat?.size || 0 });
          }
        }
        return nodes;
      };

      const stat = await fs.stat(root).catch(() => null);
      if (!stat?.isDirectory()) throw badRequest(`Papka topilmadi: ${root}`);
      res.json({ root: toRel(root), tree: await build(root, 0) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/files/read', async (req, res, next) => {
    try {
      const target = resolveInside(null, String(req.query.path || ''));
      const stat = await fs.stat(target).catch(() => null);
      if (!stat) throw badRequest('Fayl topilmadi.');
      if (stat.isDirectory()) throw badRequest('Bu papka — fayl emas.');
      if (stat.size > MAX_READ) throw badRequest(`Fayl juda katta (${humanBytes(stat.size)}).`);
      const content = await fs.readFile(target, 'utf8');
      res.json({ path: toRel(target), content, size: stat.size, modifiedAt: stat.mtime.toISOString() });
    } catch (error) {
      next(error);
    }
  });

  router.post('/files/write', async (req, res, next) => {
    try {
      const target = resolveInside(null, str(req.body?.path, 'path', { max: 1_000 }));
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      if (content.length > 2_000_000) throw badRequest('Kontent juda katta.');
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.codebase-tmp`;
      await fs.writeFile(temp, content, 'utf8');
      await fs.rename(temp, target);
      res.json({ ok: true, path: toRel(target), size: content.length, lines: content.split('\n').length });
    } catch (error) {
      next(error);
    }
  });

  router.post('/files/mkdir', async (req, res, next) => {
    try {
      const target = resolveInside(null, str(req.body?.path, 'path', { max: 1_000 }));
      await fs.mkdir(target, { recursive: true });
      res.json({ ok: true, path: toRel(target) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/files/move', async (req, res, next) => {
    try {
      const from = resolveInside(null, str(req.body?.from, 'from', { max: 1_000 }));
      const to = resolveInside(null, str(req.body?.to, 'to', { max: 1_000 }));
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
      res.json({ ok: true, from: toRel(from), to: toRel(to) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/files/delete', async (req, res, next) => {
    try {
      const target = resolveInside(null, str(req.body?.path, 'path', { max: 1_000 }));
      if (getRoots().some((root) => path.resolve(root) === target)) throw badRequest('Workspace root papkasini o‘chirib bo‘lmaydi.');
      const recursive = bool(req.body?.recursive, false);
      const stat = await fs.stat(target).catch(() => null);
      if (!stat) throw badRequest('Topilmadi.');
      if (stat.isDirectory() && !recursive) {
        const entries = await fs.readdir(target).catch(() => []);
        if (entries.length) throw badRequest('Papka bo‘sh emas — recursive kerak.');
      }
      await fs.rm(target, { recursive, force: true });
      res.json({ ok: true, path: toRel(target) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/files/search', async (req, res, next) => {
    try {
      const query = str(req.query.q, 'q', { max: 200 });
      const max = Math.min(200, Math.max(1, Number(req.query.max) || 60));
      const root = req.query.root ? resolveInside(null, String(req.query.root)) : getRoots()[0];
      if (!root) throw badRequest('Workspace papka tanlanmagan.');
      const regex = new RegExp(query.replace(/[.+^${}()|[\]\\]/g, '\\$&'), 'i');

      const matches = [];
      const stack = [root];
      while (stack.length && matches.length < max) {
        const dir = stack.pop();
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (matches.length >= max) break;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!ignoredDir(entry.name)) stack.push(full);
            continue;
          }
          if (!entry.isFile() || ignoredFile(entry.name)) continue;
          const stat = await fs.stat(full).catch(() => null);
          if (!stat || stat.size > 800_000) continue;
          const text = await fs.readFile(full, 'utf8').catch(() => '');
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length && matches.length < max; i += 1) {
            if (regex.test(lines[i])) {
              matches.push({ path: toRel(full), line: i + 1, text: truncate(lines[i].trim(), 200) });
            }
          }
        }
      }
      res.json({ matches, count: matches.length });
    } catch (error) {
      next(error);
    }
  });

  /** Ask the browser window to reveal a path in Explorer (no shell execution here). */
  router.get('/files/stat', async (req, res, next) => {
    try {
      const target = resolveInside(null, String(req.query.path || ''));
      const stat = await fs.stat(target).catch(() => null);
      if (!stat) throw badRequest('Topilmadi.');
      res.json({
        path: toRel(target),
        directory: stat.isDirectory(),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        mode: num(stat.mode, 'mode', { fallback: 0 })
      });
    } catch (error) {
      next(error);
    }
  });

  void permissions;
  return router;
}

export default createFileRoutes;
