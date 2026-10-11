import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInside, toRel } from '../../lib/paths.js';
import { humanBytes, normalizeNewlines, truncate } from '../../lib/text.js';

const MAX_READ_BYTES = 400_000;
const MAX_WRITE_BYTES = 2_000_000;

const def = (name, title, description, defaultPolicy, parameters, run, extra = {}) => ({
  name,
  title,
  description,
  category: 'filesystem',
  defaultPolicy,
  parameters,
  run,
  source: 'core',
  ...extra
});

const resolve = (ctx, value) => resolveInside(ctx.projectRoot, value);

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export const fsRead = def(
  'fs.read',
  'Read file',
  'Read a text file from the workspace. Returns content with 1-based line numbers. Use offset/limit for large files.',
  'allow',
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the project root (or absolute inside the workspace).' },
      offset: { type: 'integer', description: 'First line to return (1-based). Optional.' },
      limit: { type: 'integer', description: 'Maximum number of lines to return. Optional, default 400.' }
    },
    required: ['path']
  },
  async (args, ctx) => {
    const target = resolve(ctx, args.path);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) return { ok: false, error: `Fayl topilmadi: ${toRel(target)}` };
    if (stat.isDirectory()) return { ok: false, error: `${toRel(target)} papka — fs.list dan foydalaning.` };
    if (stat.size > MAX_READ_BYTES) {
      return { ok: false, error: `Fayl juda katta (${humanBytes(stat.size)}). search.text yoki terminal (head/tail) ishlatib ko‘ring.` };
    }
    const raw = await fs.readFile(target, 'utf8');
    const lines = normalizeNewlines(raw).split('\n');
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.min(4_000, Math.max(1, Number(args.limit) || 400));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((line, index) => `${offset + index}\t${line}`).join('\n');
    const truncated = offset - 1 + limit < lines.length;
    return {
      ok: true,
      summary: `${toRel(target)} o‘qildi (${slice.length}/${lines.length} qator, ${humanBytes(stat.size)})`,
      content: [
        `FILE ${toRel(target)} (${lines.length} lines, ${humanBytes(stat.size)})`,
        numbered,
        truncated ? `… [davomi bor: offset=${offset + slice.length} bilan davom eting]` : ''
      ].filter(Boolean).join('\n'),
      data: { path: toRel(target), lines: lines.length, returned: slice.length, truncated, size: stat.size }
    };
  }
);

export const fsWrite = def(
  'fs.write',
  'Write file',
  'Create or completely replace a text file. Parent directories are created automatically. Prefer fs.patch for small changes to existing files.',
  'ask',
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path inside the workspace.' },
      content: { type: 'string', description: 'Full new file content.' }
    },
    required: ['path', 'content']
  },
  async (args, ctx) => {
    const target = resolve(ctx, args.path);
    const content = String(args.content ?? '');
    if (content.length > MAX_WRITE_BYTES) return { ok: false, error: `Kontent juda katta (${humanBytes(content.length)}).` };
    const before = await fs.readFile(target, 'utf8').catch(() => null);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.codebase-tmp`;
    await fs.writeFile(temp, content, 'utf8');
    await fs.rename(temp, target);
    const lines = content.split('\n').length;
    return {
      ok: true,
      summary: before === null
        ? `${toRel(target)} yaratildi (${lines} qator)`
        : `${toRel(target)} yangilandi (${lines} qator)`,
      content: `OK: ${toRel(target)} ${before === null ? 'yaratildi' : 'yozildi'} — ${lines} qator, ${humanBytes(content.length)}.`,
      data: { path: toRel(target), created: before === null, lines, bytes: content.length }
    };
  },
  { timeoutMs: 30_000 }
);

export const fsAppend = def(
  'fs.append',
  'Append to file',
  'Append text to the end of a file, creating it when missing.',
  'ask',
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path inside the workspace.' },
      content: { type: 'string', description: 'Text to append.' }
    },
    required: ['path', 'content']
  },
  async (args, ctx) => {
    const target = resolve(ctx, args.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.appendFile(target, String(args.content ?? ''), 'utf8');
    return {
      ok: true,
      summary: `${toRel(target)} ga qo‘shildi`,
      content: `OK: ${toRel(target)} oxiriga yozildi.`
    };
  }
);

function applyEdits(source, edits) {
  let result = source;
  const applied = [];
  for (const edit of edits) {
    const find = String(edit.find ?? '');
    const replace = String(edit.replace ?? '');
    if (!find) {
      applied.push({ ok: false, reason: 'find bo‘sh' });
      continue;
    }
    const index = result.indexOf(find);
    if (index < 0) {
      applied.push({ ok: false, reason: `topilmadi: ${truncate(find, 60)}` });
      continue;
    }
    const count = edit.all ? result.split(find).length - 1 : 1;
    result = edit.all ? result.split(find).join(replace) : result.replace(find, replace);
    applied.push({ ok: true, replaced: count });
  }
  return { result, applied };
}

export const fsPatch = def(
  'fs.patch',
  'Patch file',
  'Replace exact snippets in a file. Provide either find/replace or an edits array of {find, replace, all}. Fails when the snippet is not found, so it never silently corrupts a file.',
  'ask',
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to patch.' },
      find: { type: 'string', description: 'Exact text to find (single edit mode).' },
      replace: { type: 'string', description: 'Replacement text (single edit mode).' },
      all: { type: 'boolean', description: 'Replace every occurrence in single edit mode.' },
      edits: {
        type: 'array',
        description: 'Multiple edits: [{find, replace, all}]',
        items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' }, all: { type: 'boolean' } }, required: ['find'] }
      }
    },
    required: ['path']
  },
  async (args, ctx) => {
    const target = resolve(ctx, args.path);
    const source = await fs.readFile(target, 'utf8').catch(() => null);
    if (source === null) return { ok: false, error: `Fayl topilmadi: ${toRel(target)}` };
    const edits = Array.isArray(args.edits) && args.edits.length
      ? args.edits
      : (args.find !== undefined ? [{ find: args.find, replace: args.replace ?? '', all: args.all }] : []);
    if (!edits.length) return { ok: false, error: 'find yoki edits berilishi kerak.' };

    const { result, applied } = applyEdits(source, edits);
    const failed = applied.filter((item) => !item.ok);
    if (failed.length === applied.length) {
      return { ok: false, error: `Hech bir o‘zgarish qo‘llanmadi: ${failed.map((f) => f.reason).join('; ')}` };
    }
    await fs.writeFile(target, result, 'utf8');
    return {
      ok: true,
      summary: `${toRel(target)}: ${applied.filter((a) => a.ok).length}/${edits.length} o‘zgarish qo‘llandi`,
      content: [
        `OK: ${toRel(target)} yangilandi.`,
        ...applied.map((item, index) => `${index + 1}. ${item.ok ? `qo‘llandi (${item.replaced}x)` : `O‘TKAZIB YUBORILDI — ${item.reason}`}`)
      ].join('\n'),
      data: { path: toRel(target), applied }
    };
  },
  { timeoutMs: 30_000 }
);

export const fsList = def(
  'fs.list',
  'List directory',
  'List files and folders in a directory (one level, or deeper with depth).',
  'allow',
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path (default: project root). Optional.' },
      depth: { type: 'integer', description: 'How many levels to list (1-5). Optional, default 1.' }
    },
    required: []
  },
  async (args, ctx) => {
    const target = resolve(ctx, args.path || '.');
    const depth = Math.min(5, Math.max(1, Number(args.depth) || 1));
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) return { ok: false, error: `Papka topilmadi: ${toRel(target)}` };
    if (!stat.isDirectory()) return { ok: false, error: `${toRel(target)} papka emas.` };

    const rows = [];
    const walk = async (dir, level) => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of entries.slice(0, 300)) {
        const full = path.join(dir, entry.name);
        const rel = toRel(full);
        if (entry.isDirectory()) {
          rows.push(`${'  '.repeat(level)}${entry.name}/`);
          if (level + 1 < depth) await walk(full, level + 1);
        } else {
          const info = await fs.stat(full).catch(() => null);
          rows.push(`${'  '.repeat(level)}${entry.name}  (${humanBytes(info?.size || 0)})${rel ? '' : ''}`);
        }
      }
    };
    await walk(target, 0);
    return {
      ok: true,
      summary: `${toRel(target)}: ${rows.length} yozuv`,
      content: [`DIR ${toRel(target)}`, ...rows].join('\n').slice(0, 12_000),
      data: { path: toRel(target), count: rows.length }
    };
  }
);

export const fsStat = def(
  'fs.stat',
  'File info',
  'Check whether a path exists and get its type, size and modification time.',
  'allow',
  {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path to inspect.' } },
    required: ['path']
  },
  async (args, ctx) => {
    const target = resolve(ctx, args.path);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) return { ok: true, summary: `${toRel(target)} mavjud emas`, content: `NOT FOUND: ${toRel(target)}`, data: { exists: false } };
    return {
      ok: true,
      summary: `${toRel(target)} — ${stat.isDirectory() ? 'papka' : humanBytes(stat.size)}`,
      content: `EXISTS: ${toRel(target)}\ntype: ${stat.isDirectory() ? 'directory' : 'file'}\nsize: ${stat.size} bytes\nmodified: ${stat.mtime.toISOString()}`,
      data: { exists: true, directory: stat.isDirectory(), size: stat.size, mtime: stat.mtime.toISOString() }
    };
  }
);

export const fsMkdir = def(
  'fs.mkdir',
  'Create directory',
  'Create a directory (recursively).',
  'ask',
  {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory to create.' } },
    required: ['path']
  },
  async (args, ctx) => {
    const target = resolve(ctx, args.path);
    await fs.mkdir(target, { recursive: true });
    return { ok: true, summary: `${toRel(target)} papkasi yaratildi`, content: `OK: ${toRel(target)} tayyor.` };
  }
);

export const fsMove = def(
  'fs.move',
  'Move or rename',
  'Move or rename a file or directory inside the workspace.',
  'ask',
  {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Source path.' },
      to: { type: 'string', description: 'Destination path.' }
    },
    required: ['from', 'to']
  },
  async (args, ctx) => {
    const source = resolve(ctx, args.from);
    const destination = resolve(ctx, args.to);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
    return { ok: true, summary: `${toRel(source)} → ${toRel(destination)}`, content: `OK: ko‘chirildi.` };
  }
);

export const fsDelete = def(
  'fs.delete',
  'Delete path',
  'Delete a file or (with recursive=true) a directory. This is irreversible.',
  'ask',
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to delete.' },
      recursive: { type: 'boolean', description: 'Allow deleting a non-empty directory.' }
    },
    required: ['path']
  },
  async (args, ctx) => {
    const target = resolve(ctx, args.path);
    if (ctx.roots.some((root) => path.resolve(root) === target)) {
      return { ok: false, error: 'Workspace root papkasini o‘chirib bo‘lmaydi.' };
    }
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) return { ok: false, error: `Topilmadi: ${toRel(target)}` };
    if (stat.isDirectory() && !args.recursive) {
      const entries = await fs.readdir(target).catch(() => []);
      if (entries.length) return { ok: false, error: `${toRel(target)} bo‘sh emas — recursive=true kerak.` };
    }
    await fs.rm(target, { recursive: Boolean(args.recursive), force: true });
    return { ok: true, summary: `${toRel(target)} o‘chirildi`, content: `OK: ${toRel(target)} o‘chirildi.` };
  },
  { dangerous: true }
);

export const fsTools = [
  fsRead, fsWrite, fsAppend, fsPatch, fsList, fsStat, fsMkdir, fsMove, fsDelete
];

export default fsTools;
