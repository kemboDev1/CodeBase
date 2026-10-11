import { runCommand, isDangerousCommand } from '../../lib/shell.js';
import { resolveInside, toRel } from '../../lib/paths.js';
import { tail, oneLine } from '../../lib/text.js';

const def = (name, title, description, defaultPolicy, parameters, run, extra = {}) => ({
  name, title, description, category: 'shell', defaultPolicy, parameters, run, source: 'core', ...extra
});

export const shellExec = def(
  'shell.exec',
  'Run terminal command',
  'Run a shell command in the project directory and return exit code, stdout and stderr. Use for installing, building, running scripts and tests. Long output is truncated from the top.',
  'ask',
  {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command line to execute, e.g. "npm test" or "git status".' },
      cwd: { type: 'string', description: 'Working directory relative to the project root. Optional.' },
      timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default 120000). Optional.' }
    },
    required: ['command']
  },
  async (args, ctx) => {
    const command = String(args.command || '').trim();
    if (!command) return { ok: false, error: 'Buyruq bo‘sh.' };
    if (command.includes('\0')) return { ok: false, error: 'Buyruqda noto‘g‘ri belgi bor.' };
    if (isDangerousCommand(command)) {
      return {
        ok: false,
        error: `Xavfli buyruq bloklandi: ${oneLine(command, 120)}. Bu amal CodeBase tomonidan taqiqlangan.`
      };
    }
    const cwd = args.cwd ? resolveInside(ctx.projectRoot, args.cwd) : (ctx.projectRoot || ctx.roots[0]);
    if (!cwd) return { ok: false, error: 'Ish papkasi aniqlanmagan.' };

    const timeoutMs = Math.min(600_000, Math.max(2_000, Number(args.timeoutMs) || ctx.config?.shellTimeoutMs || 120_000));
    const result = await runCommand(command, {
      cwd,
      timeoutMs,
      maxBytes: ctx.config?.maxOutputBytes || 200_000,
      signal: ctx.signal
    });

    const stdout = tail(result.stdout, 20_000).trim();
    const stderr = tail(result.stderr, 8_000).trim();
    const okExit = result.code === 0 && !result.timedOut;

    return {
      ok: okExit,
      summary: `${oneLine(command, 80)} → exit ${result.code ?? 'timeout'} (${(result.ms / 1000).toFixed(1)}s)`,
      content: [
        `$ ${command}`,
        `cwd: ${toRel(cwd)}`,
        `exit: ${result.code ?? 'killed'}${result.timedOut ? ' (TIMEOUT)' : ''} in ${result.ms}ms${result.truncated ? ' [output truncated]' : ''}`,
        stdout ? `--- stdout ---\n${stdout}` : '--- stdout --- (bo‘sh)',
        stderr ? `--- stderr ---\n${stderr}` : ''
      ].filter(Boolean).join('\n'),
      data: { code: result.code, ms: result.ms, timedOut: result.timedOut, truncated: result.truncated },
      error: okExit ? undefined : `Buyruq ${result.code ?? 'timeout'} bilan tugadi.`
    };
  },
  { timeoutMs: 620_000 }
);

export const shellWhich = def(
  'shell.which',
  'Check command availability',
  'Check whether a command exists on PATH (e.g. "node", "git", "docker").',
  'allow',
  {
    type: 'object',
    properties: { command: { type: 'string', description: 'Executable name to look for.' } },
    required: ['command']
  },
  async (args, ctx) => {
    const name = String(args.command || '').trim().replace(/[^\w.+-]/g, '');
    if (!name) return { ok: false, error: 'Buyruq nomi bo‘sh.' };
    const probe = process.platform === 'win32' ? `where ${name}` : `command -v ${name}`;
    const result = await runCommand(probe, { cwd: ctx.projectRoot || ctx.roots[0], timeoutMs: 15_000, signal: ctx.signal });
    const found = result.code === 0 && result.stdout.trim();
    return {
      ok: true,
      summary: found ? `${name} topildi` : `${name} topilmadi`,
      content: found ? `FOUND: ${result.stdout.trim().split('\n')[0]}` : `NOT FOUND: ${name}`,
      data: { found: Boolean(found), path: result.stdout.trim().split('\n')[0] || null }
    };
  }
);

export const shellTools = [shellExec, shellWhich];
export default shellTools;
