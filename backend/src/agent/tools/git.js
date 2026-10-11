import { runCommand } from '../../lib/shell.js';
import { oneLine, tail } from '../../lib/text.js';

const def = (name, title, description, defaultPolicy, parameters, run, extra = {}) => ({
  name, title, description, category: 'git', defaultPolicy, parameters, run, source: 'core', ...extra
});

async function git(ctx, args, timeoutMs = 60_000) {
  const cwd = ctx.projectRoot || ctx.roots[0];
  if (!cwd) return { ok: false, error: 'Project papkasi aniqlanmagan.' };
  const result = await runCommand(`git ${args}`, { cwd, timeoutMs, maxBytes: 300_000, signal: ctx.signal });
  return { result, cwd };
}

const repoArgs = 'rev-parse --is-inside-work-tree';

export const gitStatus = def(
  'git.status',
  'Git status',
  'Show the git branch, staged/unstaged changes and untracked files.',
  'allow',
  { type: 'object', properties: { path: { type: 'string', description: 'Limit status to a path. Optional.' } }, required: [] },
  async (args, ctx) => {
    const { result } = await git(ctx, 'status --porcelain=v1 --branch --untracked-files=all');
    if (result.code !== 0) {
      return { ok: false, error: `Git repo emas yoki git topilmadi: ${oneLine(result.stderr || result.stdout, 200)}` };
    }
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    return {
      ok: true,
      summary: lines[0] || 'git status',
      content: [`GIT STATUS`, ...lines, result.stderr.trim()].filter(Boolean).join('\n').slice(0, 12_000),
      data: { lines: lines.length }
    };
  }
);

export const gitDiff = def(
  'git.diff',
  'Git diff',
  'Show the unified diff of unstaged or staged changes.',
  'allow',
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Limit the diff to one file. Optional.' },
      staged: { type: 'boolean', description: 'Show staged changes (git diff --cached). Optional.' }
    },
    required: []
  },
  async (args, ctx) => {
    const parts = ['diff'];
    if (args.staged) parts.push('--cached');
    parts.push('--no-color', '--unified=3');
    if (args.path) parts.push(`-- "${String(args.path).replace(/"/g, '')}"`);
    const { result } = await git(ctx, parts.join(' '), 90_000);
    if (result.code !== 0) return { ok: false, error: oneLine(result.stderr || 'git diff failed', 200) };
    const diff = tail(result.stdout, 20_000).trim();
    return {
      ok: true,
      summary: diff ? `Diff: ${diff.split('\n').filter((l) => l.startsWith('@@')).length} hunk` : 'O‘zgarish yo‘q',
      content: diff ? diff : 'NO CHANGES.',
      data: { empty: !diff }
    };
  }
);

export const gitLog = def(
  'git.log',
  'Git log',
  'Show recent commits.',
  'allow',
  {
    type: 'object',
    properties: { limit: { type: 'integer', description: 'How many commits (default 15). Optional.' } },
    required: []
  },
  async (args, ctx) => {
    const limit = Math.min(100, Math.max(1, Number(args.limit) || 15));
    const { result } = await git(ctx, `log --oneline --decorate -n ${limit}`);
    if (result.code !== 0) return { ok: false, error: oneLine(result.stderr || 'git log failed', 200) };
    return {
      ok: true,
      summary: `Oxirgi ${limit} commit`,
      content: result.stdout.trim() || 'NO COMMITS.',
      data: { count: result.stdout.trim().split('\n').filter(Boolean).length }
    };
  }
);

export const gitAdd = def(
  'git.add',
  'Git stage',
  'Stage files for the next commit (all changes when no paths are given).',
  'ask',
  {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Specific paths to stage. Optional.' }
    },
    required: []
  },
  async (args, ctx) => {
    const check = await git(ctx, repoArgs);
    if (check.result.code !== 0) return { ok: false, error: 'Bu papka git repo emas.' };
    const paths = Array.isArray(args.paths) && args.paths.length
      ? args.paths.map((p) => `"${String(p).replace(/"/g, '')}"`).join(' ')
      : '-A';
    const { result } = await git(ctx, `add ${paths}`);
    if (result.code !== 0) return { ok: false, error: oneLine(result.stderr, 200) };
    const status = await git(ctx, 'status --porcelain=v1');
    return {
      ok: true,
      summary: paths === '-A' ? 'Barcha o‘zgarishlar stage qilindi' : `${args.paths.length} yo‘l stage qilindi`,
      content: `STAGED:\n${status.result.stdout.trim().slice(0, 4_000) || '(bo‘sh)'}`
    };
  }
);

export const gitCommit = def(
  'git.commit',
  'Git commit',
  'Stage all changes and create a commit with the given message.',
  'ask',
  {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Commit message.' },
      all: { type: 'boolean', description: 'Stage all changes first (default true).' }
    },
    required: ['message']
  },
  async (args, ctx) => {
    const message = String(args.message || '').trim().replace(/"/g, "'").slice(0, 500);
    if (!message) return { ok: false, error: 'Commit xabari bo‘sh.' };
    const check = await git(ctx, repoArgs);
    if (check.result.code !== 0) return { ok: false, error: 'Bu papka git repo emas.' };
    if (args.all !== false) await git(ctx, 'add -A');
    const { result } = await git(ctx, `commit -m "${message}"`, 120_000);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.code !== 0 && !/nothing to commit/i.test(output)) {
      return { ok: false, error: oneLine(output, 300) };
    }
    const head = await git(ctx, 'log --oneline -n 1');
    return {
      ok: true,
      summary: /nothing to commit/i.test(output)
        ? 'Commit qilinadigan o‘zgarish yo‘q'
        : oneLine(head.result.stdout, 100),
      content: `COMMIT:\n${output.slice(0, 4_000)}\nHEAD: ${head.result.stdout.trim()}`
    };
  },
  { dangerous: true }
);

export const gitBranch = def(
  'git.branch',
  'Git branches',
  'List branches, or create a new one when a name is given.',
  'ask',
  {
    type: 'object',
    properties: { name: { type: 'string', description: 'New branch name (optional).' } },
    required: []
  },
  async (args, ctx) => {
    if (args.name) {
      const safe = String(args.name).replace(/[^\w./-]/g, '');
      if (!safe) return { ok: false, error: 'Branch nomi noto‘g‘ri.' };
      const { result } = await git(ctx, `checkout -b ${safe}`);
      if (result.code !== 0) return { ok: false, error: oneLine(result.stderr || result.stdout, 200) };
      return { ok: true, summary: `${safe} branch yaratildi`, content: `${result.stdout}${result.stderr}`.trim() };
    }
    const { result } = await git(ctx, 'branch -vv');
    if (result.code !== 0) return { ok: false, error: oneLine(result.stderr, 200) };
    return { ok: true, summary: 'Branch ro‘yxati', content: result.stdout.trim() };
  }
);

export const gitCheckout = def(
  'git.checkout',
  'Git checkout',
  'Switch to an existing branch or restore a file.',
  'ask',
  {
    type: 'object',
    properties: { ref: { type: 'string', description: 'Branch, tag or commit to check out.' } },
    required: ['ref']
  },
  async (args, ctx) => {
    const ref = String(args.ref || '').replace(/[^\w./-]/g, '');
    if (!ref) return { ok: false, error: 'ref noto‘g‘ri.' };
    const { result } = await git(ctx, `checkout ${ref}`, 90_000);
    if (result.code !== 0) return { ok: false, error: oneLine(result.stderr || result.stdout, 300) };
    return { ok: true, summary: `${ref} ga o‘tildi`, content: `${result.stdout}${result.stderr}`.trim() };
  },
  { dangerous: true }
);

export const gitInit = def(
  'git.init',
  'Initialise repository',
  'Create a new git repository in the project root (git init) and report the status.',
  'ask',
  { type: 'object', properties: {}, required: [] },
  async (_args, ctx) => {
    const { result, cwd } = await git(ctx, 'init');
    if (result.code !== 0) return { ok: false, error: oneLine(result.stderr || result.stdout, 200) };
    return { ok: true, summary: `git init — ${cwd}`, content: `${result.stdout}${result.stderr}`.trim() };
  }
);

export const gitTools = [gitStatus, gitDiff, gitLog, gitAdd, gitCommit, gitBranch, gitCheckout, gitInit];
export default gitTools;
