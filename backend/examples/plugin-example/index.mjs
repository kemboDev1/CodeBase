/**
 * Example CodeBase Agent plugin: `example-tools`.
 *
 * Demonstrates the whole plugin surface with no dependencies beyond Node built-ins:
 * - one tool  → `project_stats` (registered by the host as `plugin.example-tools.project_stats`)
 * - one command → `/hello`
 * - lifecycle logging on activate/deactivate
 *
 * Copy this directory to `<dataDir>/plugins/`, mark it trusted in the Plugins page,
 * and reload the backend.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** Directories that never contribute to the statistics. */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'release', 'out', 'coverage',
  '.next', '.cache', '.venv', 'venv', '__pycache__', '.idea', '.vscode',
]);

/** Files that are counted but whose lines are not read. */
const BINARY_LIKE = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tar|7z|rar|exe|dll|so|dylib|bin|woff2?|ttf|eot|mp[34]|wav|ogg|mp4|mov|sqlite|db|pack)$/i;

/** Guard against pathological trees. */
const LIMITS = { maxFiles: 20_000, maxDepth: 12, maxMs: 10_000 };

/**
 * Recursively collect file statistics under `root`.
 *
 * @param {object} options Options.
 * @param {string} options.root Absolute directory to scan.
 * @param {string[]} options.extensions Lowercase extensions to include (empty = all).
 * @param {number} options.maxDepth Maximum recursion depth.
 * @returns {Promise<{files: number, lines: number, bytes: number, byExtension: Map<string, {files: number, lines: number}>, truncated: boolean, elapsedMs: number}>} Statistics.
 */
async function collectStats({ root, extensions, maxDepth }) {
  const startedAt = Date.now();
  const byExtension = new Map();
  const queue = [{ dir: root, depth: 0 }];
  let files = 0;
  let lines = 0;
  let bytes = 0;
  let truncated = false;

  while (queue.length) {
    if (files >= LIMITS.maxFiles || Date.now() - startedAt > LIMITS.maxMs) {
      truncated = true;
      break;
    }
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          queue.push({ dir: absolute, depth: depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase() || '(none)';
      if (extensions.length && !extensions.includes(extension)) continue;
      let stat;
      try {
        stat = await fs.stat(absolute);
      } catch {
        continue;
      }
      let fileLines = 0;
      if (!BINARY_LIKE.test(entry.name) && stat.size <= 4 * 1024 * 1024) {
        try {
          const text = await fs.readFile(absolute, 'utf8');
          fileLines = text.length ? text.split('\n').length : 0;
        } catch {
          fileLines = 0;
        }
      }
      files += 1;
      lines += fileLines;
      bytes += stat.size;
      const bucket = byExtension.get(extension) || { files: 0, lines: 0 };
      bucket.files += 1;
      bucket.lines += fileLines;
      byExtension.set(extension, bucket);
    }
  }

  return { files, lines, bytes, byExtension, truncated, elapsedMs: Date.now() - startedAt };
}

/**
 * Render a human readable size.
 *
 * @param {number} bytes Byte count.
 * @returns {string} e.g. `18.4 KB`.
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Scoped logger kept between activate/deactivate so lifecycle lines stay
 * namespaced. Module state only; there are no side effects at import time.
 */
let lifecycleLogger = null;

/**
 * Activate the plugin: register the tool, the slash command and the logger lines.
 *
 * @param {object} api Plugin api provided by the host (contract §12).
 * @returns {Promise<void>} Resolves once everything is registered.
 */
export async function activate(api) {
  lifecycleLogger = api.logger;
  api.logger.info('example-tools activated');

  api.registerTool({
    name: 'project_stats',
    title: 'Project statistics',
    description:
      'Count files, lines of code and total size under a project directory. ' +
      'Skips dependency and build directories (node_modules, .git, dist, build, ...). ' +
      'Use it to size up an unfamiliar repository before reading files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory to analyse, absolute or relative to the project root. Defaults to the project root.',
        },
        extensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only count these extensions, e.g. [".js", ".ts"]. Defaults to every file.',
        },
        maxDepth: {
          type: 'integer',
          description: 'Maximum directory depth to walk (1-12). Defaults to 8.',
        },
      },
      additionalProperties: false,
    },
    defaultPolicy: 'allow',
    async run(args = {}, ctx = {}) {
      const base = ctx.projectRoot || ctx.roots?.[0] || process.cwd();
      const target = path.resolve(base, typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.');
      const extensions = Array.isArray(args.extensions)
        ? args.extensions
          .filter(value => typeof value === 'string' && value.trim())
          .map(value => (value.trim().startsWith('.') ? value.trim().toLowerCase() : `.${value.trim().toLowerCase()}`))
        : [];
      const requestedDepth = Number.isFinite(args.maxDepth) ? Math.trunc(args.maxDepth) : 8;
      const maxDepth = Math.min(LIMITS.maxDepth, Math.max(1, requestedDepth));

      let stat;
      try {
        stat = await fs.stat(target);
      } catch {
        return { ok: false, error: `Directory not found: ${target}` };
      }
      if (!stat.isDirectory()) return { ok: false, error: `Not a directory: ${target}` };

      const stats = await collectStats({ root: target, extensions, maxDepth });
      const top = [...stats.byExtension.entries()]
        .sort((a, b) => b[1].lines - a[1].lines || b[1].files - a[1].files)
        .slice(0, 15);

      const header = [
        `Directory: ${target}`,
        `Files: ${stats.files}${stats.truncated ? ' (limit reached)' : ''}`,
        `Lines: ${stats.lines}`,
        `Size: ${formatBytes(stats.bytes)}`,
        `Scan time: ${stats.elapsedMs} ms`,
        extensions.length ? `Filter: ${extensions.join(', ')}` : 'Filter: all files',
      ].join('\n');

      const table = top.length
        ? ['', 'Top extensions:', 'extension | files | lines', '--------- | ----- | -----',
          ...top.map(([extension, bucket]) => `${extension} | ${bucket.files} | ${bucket.lines}`)].join('\n')
        : '';

      const summary = `${stats.files} files, ${stats.lines} lines, ${formatBytes(stats.bytes)} under ${path.basename(target)}`;
      return {
        ok: true,
        summary,
        content: `${header}${table}`,
        data: {
          target,
          files: stats.files,
          lines: stats.lines,
          bytes: stats.bytes,
          truncated: stats.truncated,
          byExtension: Object.fromEntries(stats.byExtension),
        },
      };
    },
  });

  api.registerCommand({
    name: 'hello',
    description: 'Greet the user from the example-tools plugin.',
    /**
     * @param {string[]} args Raw arguments after the command name.
     * @param {object} [ctx] Host context (project, session, ...).
     * @returns {{ok: boolean, content: string, summary: string}} Command result.
     */
    async run(args = [], ctx = {}) {
      const who = args.filter(Boolean).join(' ').trim() || 'there';
      const project = ctx?.project?.name ? ` Project: ${ctx.project.name}.` : '';
      return {
        ok: true,
        summary: `example-tools said hello to ${who}`,
        content: [
          `Hello, ${who}!`,
          '',
          `This line comes from the "${api.name}" plugin (v${api.version}).${project}`,
          'Try the tool `plugin.example-tools.project_stats` to measure this repository.',
        ].join('\n'),
      };
    },
  });

  // Observe (but never block) the agent loop. Handlers run in registration order.
  api.on('tool.before', (payload) => {
    if (payload?.name === 'plugin.example-tools.project_stats') {
      api.logger.debug(`project_stats on ${payload?.args?.path || '.'}`);
    }
  });
}

/**
 * Deactivate the plugin. Called by the host on reload/shutdown or when the plugin
 * is switched off; keep it fast and side-effect free.
 *
 * @returns {void}
 */
export function deactivate() {
  lifecycleLogger?.info('example-tools deactivated');
  lifecycleLogger = null;
}
