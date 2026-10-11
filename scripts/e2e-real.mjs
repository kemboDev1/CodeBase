/**
 * Real-model end-to-end test.
 *
 * Unlike scripts/smoke.mjs (which uses a mock Ollama so it runs anywhere), this
 * script talks to the real Ollama server on your machine and lets a real local model
 * drive the agent loop: it must inspect a file with a tool and fix the bug inside it.
 *
 * Usage: node scripts/e2e-real.mjs [model]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLLAMA = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ── pick a model ─────────────────────────────────────────────────────────────
let models = [];
try {
  const response = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5_000) });
  models = (await response.json()).models?.map((model) => model.name) || [];
} catch {
  console.error(`Ollama javob bermadi (${OLLAMA}). Avval "node scripts/ollama.mjs enable" ni ishga tushiring.`);
  process.exit(2);
}
if (!models.length) {
  console.error('Ollama\'da model yo\'q. Masalan: ollama pull qwen2.5-coder:3b');
  process.exit(2);
}

const requested = process.argv[2];
const model =
  requested ||
  models.find((name) => /qwen2\.5-coder:7b/.test(name)) ||
  models.find((name) => /qwen2\.5-coder/.test(name)) ||
  models.find((name) => /coder/.test(name)) ||
  models[0];

console.log(`Ollama:  ${OLLAMA}`);
console.log(`Modellar: ${models.join(', ')}`);
console.log(`Tanlangan model: ${model}\n`);

// ── workspace with a deliberate bug ──────────────────────────────────────────
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-e2e-'));
const projectRoot = path.join(tempDir, 'project');
await fs.mkdir(projectRoot, { recursive: true });
const buggy = [
  '// Ikki sonning yig\'indisi noto\'g\'ri hisoblanmoqda.',
  'export function add(a, b) {',
  '  return a - b; // BUG: ayirish ishlatilgan',
  '}',
  ''
].join('\n');
await fs.writeFile(path.join(projectRoot, 'math.js'), buggy, 'utf8');
console.log(`Workspace: ${projectRoot}\nhello: math.js faylida ataylab xato bor (a - b)\n`);

// ── start the backend ────────────────────────────────────────────────────────
const port = await freePort();
const token = 'e2e-real-token';
const dataDir = path.join(tempDir, 'data');
const backend = spawn(process.execPath, [path.join(root, 'backend', 'dist', 'server.mjs')], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    CODEBASE_PORT: String(port),
    CODEBASE_HOST: '127.0.0.1',
    CODEBASE_TOKEN: token,
    CODEBASE_DATA_DIR: dataDir,
    CODEBASE_LOG: 'info',
    OLLAMA_URL: OLLAMA
  }
});
const logs = [];
backend.stdout.on('data', (chunk) => logs.push(chunk.toString('utf8')));
backend.stderr.on('data', (chunk) => logs.push(chunk.toString('utf8')));

const api = `http://127.0.0.1:${port}/api`;
const call = async (pathname, { method = 'GET', body } = {}) => {
  const response = await fetch(`${api}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CodeBase-Token': token },
    body: body ? JSON.stringify(body) : undefined
  });
  return response.json();
};

let exitCode = 0;
try {
  for (let i = 0; i < 40; i += 1) {
    try {
      const health = await fetch(`${api}/health`);
      if (health.ok) break;
    } catch {
      /* still booting */
    }
    await delay(500);
  }

  const project = await call('/projects', { method: 'POST', body: { name: 'E2E', root: projectRoot } });
  const projectId = project.project.id;
  await call('/settings', { method: 'PATCH', body: { model, mode: 'auto', maxSteps: 6, numCtx: 8192 } });

  const prompt = 'math.js faylini o‘qib, undagi xatoni top va tuzat. Keyin qisqa qilib nima qilganingni yoz.';
  console.log(`So‘rov: ${prompt}\n${'─'.repeat(70)}`);

  const started = Date.now();
  const response = await fetch(`${api}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CodeBase-Token': token },
    body: JSON.stringify({ projectId, message: prompt, model, mode: 'auto' }),
    signal: AbortSignal.timeout(600_000)
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  const tools = [];
  let steps = 0;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const chunk = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 2);
      if (chunk.startsWith('data:')) {
        let event;
        try {
          event = JSON.parse(chunk.slice(5).trim());
        } catch {
          index = buffer.indexOf('\n\n');
          continue;
        }
        if (event.type === 'step') {
          steps = event.index;
          console.log(`\n[${((Date.now() - started) / 1000).toFixed(1)}s] qadam ${event.index} — ${event.model} (${event.protocol})`);
        } else if (event.type === 'tool_start') {
          console.log(`  → ${event.name} ${JSON.stringify(event.args).slice(0, 120)}`);
        } else if (event.type === 'tool_end') {
          tools.push(event);
          console.log(`  ← ${event.name} ${event.ok ? 'OK' : 'XATO'} — ${String(event.summary).slice(0, 120)} (${event.durationMs}ms)`);
        } else if (event.type === 'permission_request') {
          // Approve file edits (that is what this test is about) but never shell commands.
          const allow = ['fs.write', 'fs.patch', 'fs.append', 'fs.mkdir', 'fs.move'].includes(event.tool);
          console.log(`  ? ruxsat so‘raldi: ${event.tool} → ${allow ? 'ruxsat berildi (session)' : 'rad etildi'}`);
          await fetch(`${api}/agent/permission/${event.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CodeBase-Token': token },
            body: JSON.stringify({ approved: allow, remember: allow ? 'session' : 'once' })
          });
        } else if (event.type === 'token') {
          answer += event.text;
        } else if (event.type === 'done') {
          answer = event.content || answer;
          console.log(`\n${'─'.repeat(70)}`);
          console.log(`Javob (${event.steps} qadam, ${(event.durationMs / 1000).toFixed(1)}s):\n`);
          console.log(answer.trim());
        } else if (event.type === 'error') {
          console.log(`\nXATO: ${event.message}`);
          exitCode = 1;
        }
      }
      index = buffer.indexOf('\n\n');
    }
  }

  console.log(`\n${'─'.repeat(70)}`);
  const fileAfter = await fs.readFile(path.join(projectRoot, 'math.js'), 'utf8');
  const usedTools = tools.map((tool) => tool.name);
  const fixed = /a \+ b/.test(fileAfter);

  console.log(`Ishlatilgan tool’lar : ${usedTools.join(', ') || '(yo‘q)'}`);
  console.log(`Qadamlar             : ${steps}`);
  console.log(`math.js holati       : ${fixed ? 'TUZATILDI (a + b)' : 'o‘zgarmadi'}`);
  console.log(`Javob uzunligi       : ${answer.trim().length} belgi`);

  if (!usedTools.length) {
    console.log('\nOGOHLANTIRISH: model tool ishlatmadi — kichik modellar ba’zan shunday qiladi.');
  }
  if (!answer.trim()) {
    console.log('\nXATO: model bo‘sh javob qaytardi.');
    exitCode = 1;
  }
} catch (error) {
  console.log(`\nXATO: ${error.message}`);
  exitCode = 1;
} finally {
  try {
    backend.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  if (exitCode !== 0) {
    console.log('\nBackend loglari:');
    for (const line of logs.join('').split(/\r?\n/).slice(-25)) console.log(`  ${line}`);
  }
}

process.exit(exitCode);
