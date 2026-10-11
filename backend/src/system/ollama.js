import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runCommand } from '../lib/shell.js';
import { logger } from '../lib/logger.js';
import * as ollama from '../ollama/client.js';

const log = logger.make('ollama-sup');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'CodeBaseOllama';

let owned = false; // true when CodeBase started the Ollama process itself

/** Locate a usable Ollama executable on this machine. */
export function findOllamaExecutable() {
  if (process.env.OLLAMA_EXE && fs.existsSync(process.env.OLLAMA_EXE)) return process.env.OLLAMA_EXE;

  const candidates = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    if (local) {
      candidates.push(path.join(local, 'Programs', 'Ollama', 'ollama app.exe'));
      candidates.push(path.join(local, 'Programs', 'Ollama', 'ollama.exe'));
    }
    candidates.push(path.join(programFiles, 'Ollama', 'ollama app.exe'));
    candidates.push(path.join(programFiles, 'Ollama', 'ollama.exe'));
  } else {
    candidates.push('/usr/local/bin/ollama', '/usr/bin/ollama', '/opt/homebrew/bin/ollama');
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return '';
}

async function probe(timeoutMs = 2_500) {
  try {
    const response = await fetch(`${ollama.getOllamaUrl()}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const data = await response.json().catch(() => ({}));
    if (Array.isArray(data.models)) return true;
    return true;
  } catch {
    return false;
  }
}

/**
 * Make sure Ollama is running. This is the fix for "the app only works while a CMD
 * window with the server is open": CodeBase now starts and supervises Ollama itself.
 */
export async function ensureStarted({ waitMs = 45_000, force = false } = {}) {
  if (!force && (await probe())) {
    return { started: false, alreadyRunning: true, ok: true, exe: '' };
  }
  const exe = findOllamaExecutable();
  if (!exe) {
    return {
      started: false,
      alreadyRunning: false,
      ok: false,
      exe: '',
      error: 'Ollama topilmadi. https://ollama.com/download dan o‘rnating (yoki OLLAMA_EXE env bilan ko‘rsating).'
    };
  }

  try {
    if (process.platform === 'win32') {
      // "ollama app.exe" starts the tray app which owns the server; ollama.exe serve is the fallback.
      const args = /ollama app\.exe$/i.test(exe) ? [] : ['serve'];
      const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } else {
      const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    owned = true;
    log.info(`Ollama ishga tushirildi: ${exe}`);
  } catch (error) {
    return { started: false, alreadyRunning: false, ok: false, exe, error: `Ollama ishga tushmadi: ${error.message}` };
  }

  const deadline = Date.now() + Math.max(3_000, waitMs);
  while (Date.now() < deadline) {
    if (await probe(1_500)) {
      return { started: true, alreadyRunning: false, ok: true, exe, models: (await ollama.listModels().catch(() => [])).length };
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return { started: true, alreadyRunning: false, ok: false, exe, error: 'Ollama ishga tushdi, lekin 45 soniyada javob bermadi.' };
}

/** Stop the local Ollama server (used by the Settings page). */
export async function stop() {
  if (process.platform === 'win32') {
    const result = await runCommand('taskkill /IM "ollama app.exe" /T /F & taskkill /IM ollama.exe /T /F', { timeoutMs: 15_000 });
    owned = false;
    return { ok: true, output: `${result.stdout}${result.stderr}`.trim() };
  }
  const result = await runCommand('pkill -f "ollama serve" || true', { timeoutMs: 15_000 });
  owned = false;
  return { ok: true, output: `${result.stdout}${result.stderr}`.trim() };
}

async function regQuery() {
  if (process.platform !== 'win32') return null;
  const result = await runCommand(`reg query "${RUN_KEY}" /v ${RUN_VALUE}`, { timeoutMs: 10_000 });
  if (result.code !== 0) return null;
  const match = /REG_SZ\s+(.+)$/m.exec(result.stdout);
  return match ? match[1].trim() : null;
}

export async function autostartEnabled() {
  if (process.platform !== 'win32') return false;
  return Boolean(await regQuery());
}

/** Add/remove the Ollama tray app from the Windows Run key. */
export async function setAutostart(enabled) {
  if (process.platform !== 'win32') return { ok: false, enabled: false, error: 'Bu funksiya faqat Windows uchun.' };
  if (enabled) {
    const exe = findOllamaExecutable();
    if (!exe) return { ok: false, enabled: false, error: 'Ollama topilmadi — avval uni o‘rnating.' };
    const result = await runCommand(
      `reg add "${RUN_KEY}" /v ${RUN_VALUE} /t REG_SZ /d "\\"${exe}\\"" /f`,
      { timeoutMs: 15_000 }
    );
    if (result.code !== 0) {
      return { ok: false, enabled: false, error: `${result.stdout}${result.stderr}`.trim() };
    }
    return { ok: true, enabled: true, exe };
  }
  const result = await runCommand(`reg delete "${RUN_KEY}" /v ${RUN_VALUE} /f`, { timeoutMs: 15_000 });
  // Deleting a missing value returns a non-zero code; that is still "disabled".
  return { ok: true, enabled: false, output: `${result.stdout}${result.stderr}`.trim() };
}

export async function status() {
  const connected = await probe();
  return {
    connected,
    url: ollama.getOllamaUrl(),
    exe: findOllamaExecutable(),
    owned,
    autostart: await autostartEnabled()
  };
}

export function createOllamaSupervisor() {
  return { ensureStarted, stop, status, autostartEnabled, setAutostart, findOllamaExecutable };
}

export default createOllamaSupervisor;
