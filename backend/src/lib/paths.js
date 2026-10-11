import fs from 'node:fs';
import path from 'node:path';
import { forbidden } from './errors.js';

/** Directories that are never walked by search/tree tools. */
export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'release', '.next', '.nuxt',
  '.cache', 'coverage', '__pycache__', '.venv', 'venv', 'env', '.idea', '.vs', 'target',
  'obj', 'bin', '.gradle', '.terraform', '.ollama', '.dsh'
]);

const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

let roots = [];

/** Replace the set of directories tools are allowed to touch. */
export function setRoots(next) {
  roots = [...new Set((next || []).filter(Boolean).map((p) => path.resolve(String(p))))];
  return roots;
}

export function getRoots() {
  return [...roots];
}

export function ignoredDir(name) {
  return IGNORED_DIRS.has(String(name).toLowerCase());
}

export function ignoredFile(name) {
  return IGNORED_FILES.has(name);
}

const norm = (value) => {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

function sameOrInside(target, root) {
  const a = norm(target);
  const b = norm(root);
  if (a === b) return true;
  const withSep = b.endsWith(path.sep) ? b : b + path.sep;
  return a.startsWith(withSep);
}

/** Realpath of the closest existing ancestor, so symlinks cannot escape the jail. */
function realAncestor(target) {
  let current = path.resolve(target);
  for (let i = 0; i < 40; i += 1) {
    try {
      const real = fs.realpathSync.native(current);
      return path.resolve(real, path.relative(current, path.resolve(target)));
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      current = parent;
    }
  }
  return path.resolve(target);
}

export function isInsideAny(target) {
  const resolved = realAncestor(target);
  return roots.some((root) => sameOrInside(resolved, realAncestor(root)));
}

/**
 * Ensure a path is inside one of the allowed workspace roots.
 * @throws {AppError} 403 when the path escapes every root.
 */
export function assertInside(target) {
  if (!roots.length) {
    throw forbidden('Hech qanday workspace papka tanlanmagan. Settings → Workspace roots bo‘limida papka qo‘shing.');
  }
  if (!isInsideAny(target)) {
    throw forbidden(`Ruxsat etilmagan yo‘l (workspace tashqarisida): ${target}`);
  }
  return path.resolve(target);
}

/** Resolve `relOrAbs` against a root (or the first root) and validate it. */
export function resolveInside(root, relOrAbs) {
  const base = root ? path.resolve(root) : roots[0];
  if (!base) throw forbidden('Workspace papka tanlanmagan.');
  const value = String(relOrAbs || '').trim();
  if (!value) throw forbidden('Bo‘sh yo‘l.');
  if (value.includes('\0')) throw forbidden('Yo‘lda noto‘g‘ri belgi bor.');
  const target = path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value);
  return assertInside(target);
}

/** Path relative to the best matching root, for display. */
export function toRel(target) {
  const resolved = path.resolve(target);
  const match = roots
    .filter((root) => sameOrInside(resolved, root))
    .sort((a, b) => b.length - a.length)[0];
  if (!match) return resolved;
  const rel = path.relative(match, resolved);
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}
