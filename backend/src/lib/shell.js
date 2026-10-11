import { spawn } from 'node:child_process';

/** Commands that are never executed, even with approval. */
export const COMMAND_DENYLIST = [
  /rm\s+-rf\s+[\\/](\s|$)/i,
  /remove-item\s+.*-recurse\s+.*-force\s+[a-z]:\\?(\s|$)/i,
  /format\s+[a-z]:/i,
  /(diskpart|bcdedit|bootrec)\b/i,
  /(shutdown|logoff|restart-computer|stop-computer)\b/i,
  /vssadmin\s+delete\s+shadows/i,
  /cipher\s+\/w/i,
  /reg\s+delete\s+(hklm|hkcu|hkey_local_machine|hkey_current_user|hkey_classes_root|hkey_users|hkey_current_config)/i,
  /takeown\s+\/f\s+[a-z]:\\windows/i,
  /icacls\s+[a-z]:\\windows/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /(curl|wget|iwr|invoke-webrequest)[^|]*\|\s*(sh|bash|iex|powershell)/i,
  /(npm|npx|pnpm|yarn)\s+publish/i,
  /git\s+push\s+.*--force(?!-with-lease)/i,
  /(del|erase)\s+\/[sq]\s+[a-z]:\\?(\s|$)/i
];

export function isDangerousCommand(command) {
  const text = String(command || '');
  return COMMAND_DENYLIST.some((pattern) => pattern.test(text));
}

/**
 * Run a shell command with a jailed cwd, timeout, output caps and no shell injection
 * beyond the platform shell used to interpret the user's own command string.
 *
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, ms:number, truncated:boolean, timedOut:boolean, command:string, cwd:string}>}
 */
export function runCommand(command, {
  cwd = process.cwd(),
  timeoutMs = 120_000,
  maxBytes = 200_000,
  env = {},
  signal
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const isWindows = process.platform === 'win32';
    const shellCommand = isWindows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows ? ['/d', '/s', '/c', command] : ['-lc', command];

    let child;
    try {
      child = spawn(shellCommand, shellArgs, {
        cwd,
        env: { ...process.env, ...env, CODEBASE: '1' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !isWindows
      });
    } catch (error) {
      resolve({
        code: -1, stdout: '', stderr: `Buyruqni ishga tushirib bo‘lmadi: ${error.message}`,
        ms: Date.now() - started, truncated: false, timedOut: false, command, cwd
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (target, chunk) => {
      const text = chunk.toString('utf8');
      const next = target + text;
      if (next.length > maxBytes) {
        truncated = true;
        return next.slice(next.length - maxBytes);
      }
      return next;
    };

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });

    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        if (isWindows) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, Math.max(1000, Number(timeoutMs) || 120_000));

    const onAbort = () => {
      timedOut = true;
      killTree();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        code: timedOut && code === 0 ? null : code,
        stdout, stderr, ms: Date.now() - started, truncated, timedOut, command, cwd
      });
    };

    child.on('error', (error) => {
      stderr = `${stderr}\n${error.message}`.trim();
      finish(-1);
    });
    child.on('close', (code) => finish(code));
  });
}

export default runCommand;
