import { Router } from 'express';
import { runCommand, isDangerousCommand } from '../lib/shell.js';
import { resolveInside, toRel, getRoots } from '../lib/paths.js';
import { str, num } from '../lib/validate.js';
import { recordAudit, saveStore } from '../store.js';
import { tail } from '../lib/text.js';

/**
 * Terminal page backend. The user typing a command IS the approval step, so this
 * route executes directly — but the deny-list and the workspace jail still apply.
 */
export function createTerminalRoutes({ store, config }) {
  const router = Router();

  router.post('/terminal/exec', async (req, res, next) => {
    try {
      const command = str(req.body?.command, 'command', { max: 4_000 });
      const cwd = req.body?.cwd ? resolveInside(null, String(req.body.cwd)) : getRoots()[0];
      const timeoutMs = Math.min(900_000, Math.max(1_000, num(req.body?.timeoutMs, 'timeoutMs', { fallback: config.shellTimeoutMs, min: 1_000, max: 900_000 })));

      if (isDangerousCommand(command)) {
        recordAudit({ tool: 'terminal.exec', decision: 'deny', ok: false, error: 'deny-list', projectId: req.body?.projectId });
        await saveStore();
        return res.status(403).json({ error: 'Bu buyruq xavfli deb bloklandi (CodeBase deny-list).' });
      }
      if (!cwd) return res.status(400).json({ error: 'Workspace papka tanlanmagan.' });

      const started = Date.now();
      const result = await runCommand(command, {
        cwd,
        timeoutMs,
        maxBytes: config.maxOutputBytes
      });
      recordAudit({
        tool: 'terminal.exec',
        argsDigest: command.slice(0, 60),
        decision: 'allow',
        ok: result.code === 0,
        ms: result.ms,
        error: result.code === 0 ? undefined : `exit ${result.code}`
      });
      await saveStore();

      res.json({
        command,
        cwd: toRel(cwd),
        code: result.code,
        stdout: tail(result.stdout, 60_000),
        stderr: tail(result.stderr, 30_000),
        ms: result.ms || Date.now() - started,
        truncated: result.truncated,
        timedOut: result.timedOut
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/terminal/info', (_req, res) => {
    res.json({
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      platform: process.platform,
      cwd: getRoots()[0] || '',
      timeoutMs: config.shellTimeoutMs,
      maxOutputBytes: config.maxOutputBytes
    });
  });

  return router;
}

export default createTerminalRoutes;
