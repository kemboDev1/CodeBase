import fs from 'node:fs/promises';
import path from 'node:path';
import { ignoredDir, ignoredFile, resolveInside, toRel } from '../../lib/paths.js';
import { humanBytes, truncate } from '../../lib/text.js';

const MAX_FILES = 6_000;
const MAX_FILE_BYTES = 1_500_000;
const MAX_DEPTH = 14;

const def = (name, title, description, parameters, run) => ({
  name, title, description, category: 'search', defaultPolicy: 'allow', parameters, run, source: 'core'
});

/** Walk a directory tree with hard limits so a huge repo cannot hang the agent. */
async function* walk(root, { maxFiles = MAX_FILES, maxDepth = MAX_DEPTH } = {}) {
  let seen = 0;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDir(entry.name)) continue;
        if (depth + 1 <= maxDepth) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (ignoredFile(entry.name)) continue;
      seen += 1;
      yield full;
    }
  }
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|svgz|pdf|zip|gz|7z|rar|tar|exe|dll|node|so|dylib|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|mkv|wav|sqlite|db|bin|pyc|class|jar|wasm)$/i;

export const searchText = def(
  'search.text',
  'Search file contents',
  'Search for text or a regular expression across the workspace and return matching lines with file paths and line numbers.',
  {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text or regular expression to search for.' },
      root: { type: 'string', description: 'Directory to search in (default: project root). Optional.' },
      glob: { type: 'string', description: 'Only search files whose relative path contains this substring, e.g. ".jsx" or "src/". Optional.' },
      regex: { type: 'boolean', description: 'Treat query as a regular expression. Optional.' },
      ignoreCase: { type: 'boolean', description: 'Case-insensitive search. Optional, default true.' },
      max: { type: 'integer', description: 'Maximum matches to return (default 60).' }
    },
    required: ['query']
  },
  async (args, ctx) => {
    const start = resolveInside(ctx.projectRoot, args.root || '.');
    const max = Math.min(400, Math.max(1, Number(args.max) || 60));
    const ignoreCase = args.ignoreCase !== false;
    let matcher;
    if (args.regex) {
      matcher = new RegExp(String(args.query), ignoreCase ? 'i' : '');
    } else {
      const needle = String(args.query).toLowerCase();
      matcher = { test: (line) => (ignoreCase ? line.toLowerCase() : line).includes(ignoreCase ? needle : String(args.query)) };
    }

    const matches = [];
    let scanned = 0;
    for await (const file of walk(start)) {
      if (matches.length >= max) break;
      const rel = toRel(file);
      if (args.glob && !rel.toLowerCase().includes(String(args.glob).toLowerCase())) continue;
      if (BINARY_EXT.test(file)) continue;
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || stat.size > MAX_FILE_BYTES) continue;
      scanned += 1;
      let text;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < max; i += 1) {
        if (matcher.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${truncate(lines[i].trim(), 220)}`);
        }
      }
    }

    return {
      ok: true,
      summary: matches.length ? `${matches.length} moslik topildi (${scanned} fayl skanerlandi)` : `Moslik topilmadi (${scanned} fayl skanerlandi)`,
      content: matches.length
        ? [`MATCHES (${matches.length}):`, ...matches].join('\n').slice(0, 15_000)
        : `NO MATCHES for "${args.query}" (${scanned} files scanned).`,
      data: { matches: matches.length, scanned }
    };
  },
  { timeoutMs: 60_000 }
);

export const searchFiles = def(
  'search.files',
  'Find files by name',
  'Find files whose name or relative path matches a substring or glob-like pattern (* and ? supported).',
  {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Name pattern, e.g. "store" or "*.test.mjs".' },
      root: { type: 'string', description: 'Directory to search in. Optional.' },
      max: { type: 'integer', description: 'Maximum results (default 80).' }
    },
    required: ['pattern']
  },
  async (args, ctx) => {
    const start = resolveInside(ctx.projectRoot, args.root || '.');
    const max = Math.min(500, Math.max(1, Number(args.max) || 80));
    const pattern = String(args.pattern);
    const regex = new RegExp(
      pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'),
      'i'
    );
    const found = [];
    for await (const file of walk(start)) {
      const rel = toRel(file);
      if (regex.test(path.basename(file)) || regex.test(rel)) {
        const stat = await fs.stat(file).catch(() => null);
        found.push(`${rel}  (${humanBytes(stat?.size || 0)})`);
      }
      if (found.length >= max) break;
    }
    return {
      ok: true,
      summary: found.length ? `${found.length} fayl topildi` : 'Fayl topilmadi',
      content: found.length ? [`FILES (${found.length}):`, ...found].join('\n') : `NO FILES matching "${pattern}".`,
      data: { count: found.length }
    };
  },
  { timeoutMs: 60_000 }
);

export const searchTree = def(
  'search.tree',
  'Project tree',
  'Print a compact directory tree of the project (ignores node_modules, .git, dist and similar).',
  {
    type: 'object',
    properties: {
      root: { type: 'string', description: 'Directory to print. Optional.' },
      depth: { type: 'integer', description: 'Maximum depth (1-6, default 3).' }
    },
    required: []
  },
  async (args, ctx) => {
    const start = resolveInside(ctx.projectRoot, args.root || '.');
    const depth = Math.min(6, Math.max(1, Number(args.depth) || 3));
    const lines = [`${toRel(start)}/`];
    const render = async (dir, level) => {
      if (level >= depth) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (ignoredDir(entry.name)) continue;
          lines.push(`${'  '.repeat(level + 1)}${entry.name}/`);
          await render(path.join(dir, entry.name), level + 1);
        } else if (!ignoredFile(entry.name)) {
          lines.push(`${'  '.repeat(level + 1)}${entry.name}`);
        }
        if (lines.length > 800) return;
      }
    };
    await render(start, 0);
    return {
      ok: true,
      summary: `${toRel(start)} daraxti (${lines.length} qator)`,
      content: lines.join('\n').slice(0, 15_000),
      data: { lines: lines.length }
    };
  },
  { timeoutMs: 45_000 }
);

export const searchTools = [searchText, searchFiles, searchTree];
export default searchTools;
