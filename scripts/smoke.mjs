/**
 * CodeBase Agent — live end-to-end smoke test.
 *
 * Boots the built backend bundle together with a mock Ollama server, then drives the
 * real HTTP API: health, tools, skills, projects, SSE agent chat with a tool call,
 * terminal execution, MCP server lifecycle, plugin loading and token auth.
 *
 * Usage: node scripts/smoke.mjs  (run from the project root, after `npm run build`)
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
let failures = 0;

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  results.push({ ok, name, detail });
  const mark = ok ? '\u2714' : '\u2716';
  console.log(`${mark} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

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

// ── mock Ollama ──────────────────────────────────────────────────────────────
function startMockOllama() {
  const state = { chats: 0, seenTools: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b', size: 123 }] }));
        return;
      }
      if (req.url === '/api/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: 'mock' }));
        return;
      }
      if (req.url !== '/api/chat') {
        res.writeHead(404).end('{}');
        return;
      }

      const payload = JSON.parse(body || '{}');
      state.chats += 1;
      if (payload.tools) state.seenTools = payload.tools.map((tool) => tool.function.name);

      const line = (message, extra = {}) =>
        res.write(`${JSON.stringify({ model: payload.model, message, done: false, ...extra })}\n`);

      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      if (state.chats === 1) {
        line({ role: 'assistant', content: 'Faylni o‘qiyapman. ' });
        line({
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'fs.read', arguments: { path: 'hello.js' } } }]
        });
      } else {
        line({ role: 'assistant', content: 'hello.js ichida ' });
        line({ role: 'assistant', content: '`export const salom = 1` bor.' });
      }
      res.write(`${JSON.stringify({ model: payload.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 4, prompt_eval_count: 8 })}\n`);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

// ── SSE chat client ──────────────────────────────────────────────────────────
async function streamChat(api, token, body) {
  const events = [];
  const response = await fetch(`${api}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CodeBase-Token': token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000)
  });
  console.log(`   [sse] HTTP ${response.status} ${response.headers.get('content-type')} chunked=${response.headers.get('transfer-encoding')}`);
  if (!response.ok) throw new Error(`chat HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const chunk = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 2);
      if (chunk.startsWith('data:')) {
        try {
          const event = JSON.parse(chunk.slice(5).trim());
          if (event.type !== 'ping') {
            events.push(event);
            console.log(`   [sse] ${event.type}${event.type === 'tool_end' ? ` ${event.name} ok=${event.ok}` : ''}`);
          }
        } catch {
          /* ignore keep-alive noise */
        }
      }
      index = buffer.indexOf('\n\n');
    }
  }
  return events;
}

// ── main ─────────────────────────────────────────────────────────────────────
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-smoke-'));
const dataDir = path.join(tempDir, 'data');
const projectRoot = path.join(tempDir, 'project');
await fs.mkdir(projectRoot, { recursive: true });
await fs.writeFile(path.join(projectRoot, 'hello.js'), 'export const salom = 1;\n', 'utf8');

const mock = await startMockOllama();
const port = await freePort();
const token = 'smoke-token-123';
const entry = path.join(root, 'backend', 'dist', 'server.mjs');

const backend = spawn(process.execPath, [entry], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    CODEBASE_PORT: String(port),
    CODEBASE_HOST: '127.0.0.1',
    CODEBASE_TOKEN: token,
    CODEBASE_DATA_DIR: dataDir,
    CODEBASE_WEB_DIR: path.join(root, 'frontend', 'dist'),
    CODEBASE_PLUGINS_DIR: path.join(root, 'backend', 'examples'),
    CODEBASE_LOG: 'debug',
    OLLAMA_URL: `http://127.0.0.1:${mock.port}`
  }
});

const backendLog = [];
backend.stdout.on('data', (chunk) => backendLog.push(chunk.toString('utf8')));
backend.stderr.on('data', (chunk) => backendLog.push(chunk.toString('utf8')));
backend.on('exit', (code, signal) => backendLog.push(`\n[backend exited code=${code} signal=${signal}]\n`));

const api = `http://127.0.0.1:${port}/api`;
const call = async (pathname, { method = 'GET', body, auth = true } = {}) => {
  const response = await fetch(`${api}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-CodeBase-Token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: response.status, data };
};

try {
  // wait for the backend to come up
  let health = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${api}/health`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {
      /* still booting */
    }
    await delay(500);
  }

  check('backend ishga tushdi (/api/health)', health?.ok === true, JSON.stringify(health));
  check('health versiya va port qaytaradi', health?.version === '1.0.0' && health?.port === port, JSON.stringify(health));
  check('mock Ollama ulandi', health?.ollama?.connected === true, JSON.stringify(health?.ollama));

  const unauth = await call('/settings', { auth: false });
  check('token bo‘lmasa 401', unauth.status === 401, `status=${unauth.status}`);

  const models = await call('/models');
  check('/api/models modellarni qaytaradi', models.data.models?.length === 1, JSON.stringify(models.data));

  const tools = await call('/tools');
  const toolNames = (tools.data.tools || []).map((tool) => tool.name);
  check('/api/tools 30+ tool ro‘yxatlaydi', toolNames.length >= 30, `count=${toolNames.length}`);
  for (const expected of ['fs.read', 'fs.write', 'fs.patch', 'search.text', 'shell.exec', 'git.status', 'tests.run', 'web.fetch', 'skill.load', 'memory.save', 'system.info']) {
    check(`tool mavjud: ${expected}`, toolNames.includes(expected));
  }
  check('xavfli tool’lar "ask" siyosatida', tools.data.tools.find((tool) => tool.name === 'shell.exec')?.policy === 'ask');

  const skills = await call('/skills');
  check('builtin skillar yuklandi (>= 11)', (skills.data.skills || []).length >= 11, `count=${(skills.data.skills || []).length}`);
  const skillIds = (skills.data.skills || []).map((skill) => skill.id);
  for (const expected of ['code-review', 'debugging', 'git-workflow', 'security-audit', 'uzbek-style', 'write-tests']) {
    check(`skill mavjud: ${expected}`, skillIds.some((id) => id.includes(expected)), skillIds.join(','));
  }

  const project = await call('/projects', { method: 'POST', body: { name: 'Smoke test', description: 'live test', root: projectRoot } });
  const projectId = project.data.project?.id;
  check('project yaratildi (root bilan)', Boolean(projectId) && project.data.project.root === projectRoot, JSON.stringify(project.data));

  const tree = await call(`/files/tree?depth=2&root=${encodeURIComponent(projectRoot)}`);
  check('/api/files/tree fayllarni ko‘rsatadi', JSON.stringify(tree.data.tree || []).includes('hello.js'));

  const read = await call(`/files/read?path=${encodeURIComponent('hello.js')}`);
  check('/api/files/read faylni o‘qiydi', read.data.content?.includes('export const salom'), JSON.stringify(read.data).slice(0, 120));

  const jail = await call(`/files/read?path=${encodeURIComponent(path.join(os.tmpdir(), 'codebase-smoke-outside.txt'))}`);
  check('path jail tashqi faylni bloklaydi', jail.status === 403, `status=${jail.status}`);

  const write = await call('/files/write', { method: 'POST', body: { path: 'yangi/papka/file.txt', content: 'salom dunyo\n' } });
  check('/api/files/write fayl yozadi', write.data.ok === true, JSON.stringify(write.data));

  const search = await call(`/files/search?q=${encodeURIComponent('salom')}`);
  check('/api/files/search moslik topadi', (search.data.matches || []).length >= 1, JSON.stringify(search.data).slice(0, 140));

  // ── the real thing: SSE agent chat with a tool call ────────────────────────
  const events = await streamChat(api, token, { projectId, message: 'hello.js ni o‘qib tushuntir', model: 'qwen2.5-coder:7b', mode: 'auto' });
  const types = events.map((event) => event.type);
  check('SSE: run_start keldi', types.includes('run_start'));
  check('SSE: token oqimi keldi', types.filter((type) => type === 'token').length >= 2, `tokens=${types.filter((t) => t === 'token').length}`);
  check('SSE: tool_start keldi', types.includes('tool_start'));
  check('SSE: tool_end muvaffaqiyatli', events.find((event) => event.type === 'tool_end')?.ok === true, JSON.stringify(events.find((e) => e.type === 'tool_end')));
  const done = events.find((event) => event.type === 'done');
  check('SSE: done yakuniy javob bilan', Boolean(done?.content?.includes('salom')), JSON.stringify(done)?.slice(0, 200));
  check('SSE: javob model tomonidan yozildi', mock.state.chats === 2, `chats=${mock.state.chats}`);
  check('model tool ta’riflarini oldi', Array.isArray(mock.state.seenTools) && mock.state.seenTools.includes('fs.read'), `tools=${mock.state.seenTools?.length}`);

  const messages = await call(`/projects/${projectId}/messages`);
  check('suhbat tarixi saqlandi (user + assistant)', messages.data.messages?.length === 2, `count=${messages.data.messages?.length}`);
  check('assistant xabarida tool izi bor', (messages.data.messages?.[1]?.toolCalls || []).length === 1, JSON.stringify(messages.data.messages?.[1]?.toolCalls)?.slice(0, 160));

  const sessions = await call(`/projects/${projectId}/sessions`);
  const newSession = await call(`/projects/${projectId}/sessions`, { method: 'POST', body: { name: 'Ikkinchi suhbat' } });
  check('suhbat (session) yaratiladi', sessions.data.sessions?.length === 1 && Boolean(newSession.data.session?.id), JSON.stringify(newSession.data));

  // ── terminal ───────────────────────────────────────────────────────────────
  const term = await call('/terminal/exec', { method: 'POST', body: { command: 'echo smoke-ok' } });
  check('/api/terminal/exec buyruq bajaradi', term.data.code === 0 && String(term.data.stdout).includes('smoke-ok'), JSON.stringify(term.data).slice(0, 200));

  const denied = await call('/terminal/exec', { method: 'POST', body: { command: 'rm -rf /' } });
  check('terminal deny-list ishlaydi', denied.status === 403, `status=${denied.status}`);

  // ── MCP ────────────────────────────────────────────────────────────────────
  const echoServer = path.join(root, 'backend', 'examples', 'mcp-echo-server.mjs');
  const created = await call('/mcp/servers', {
    method: 'POST',
    body: {
      name: 'Echo',
      command: process.execPath,
      args: [echoServer],
      enabled: true,
      trusted: true,
      autoStart: true
    }
  });
  const serverId = created.data.server?.id;
  check('MCP server qo‘shildi', Boolean(serverId), JSON.stringify(created.data).slice(0, 200));

  const started = await call(`/mcp/servers/${serverId}/start`, { method: 'POST' });
  check('MCP server ishga tushdi (stdio)', started.data.ok === true, JSON.stringify(started.data).slice(0, 200));

  const mcpTools = await call(`/mcp/servers/${serverId}/tools`);
  const names = (mcpTools.data.tools || []).map((tool) => tool.name);
  check(
    'MCP tool’lari topildi (echo, add)',
    names.some((name) => /echo/i.test(name)) && names.some((name) => /add/i.test(name)),
    names.join(',')
  );

  const roots = await call('/files/roots');
  check('workspace root har doim mavjud (standart papka)', (roots.data.roots || []).length >= 1, JSON.stringify(roots.data.roots));

  const toolsAfterMcp = await call('/tools');
  const mcpRegistered = (toolsAfterMcp.data.tools || []).filter((tool) => tool.source === 'mcp').map((tool) => tool.name);
  check('MCP tool’lari agent registry’sida', mcpRegistered.includes('mcp__echo__echo'), mcpRegistered.join(','));

  const servers = await call('/mcp/servers');
  check('MCP holati "ready"', (servers.data.servers || []).some((server) => server.status === 'ready'), JSON.stringify(servers.data.servers).slice(0, 200));

  // ── plugins ────────────────────────────────────────────────────────────────
  const plugins = await call('/plugins');
  const example = (plugins.data.plugins || []).find((plugin) => plugin.name === 'example-tools') || (plugins.data.plugins || [])[0];
  check('plugin topildi (discovery)', Boolean(example), JSON.stringify(plugins.data.plugins).slice(0, 200));
  check('plugin default holatda o‘chirilgan (trust)', example?.enabled === false, JSON.stringify(example));

  if (example) {
    const toggled = await call(`/plugins/${example.id}/toggle`, { method: 'POST', body: { enabled: true, trusted: true } });
    const active = toggled.data.plugins?.find((plugin) => plugin.id === example.id);
    check('plugin yoqildi va faollashdi', active?.status === 'active', JSON.stringify(active));
    const toolsNow = await call('/tools');
    check('plugin tool’i registry’da', (toolsNow.data.tools || []).some((tool) => tool.name.startsWith('plugin.')), 'plugin tool topilmadi');
  }

  // ── audit + settings ───────────────────────────────────────────────────────
  const audit = await call('/audit?limit=20');
  check('audit jurnali yozilyapti', (audit.data.audit || []).length > 0, `entries=${(audit.data.audit || []).length}`);

  const settings = await call('/settings');
  check('/api/settings javob beradi', settings.data.settings?.model === 'qwen2.5-coder:7b', JSON.stringify(settings.data.settings)?.slice(0, 160));

  const patched = await call('/settings', { method: 'PATCH', body: { mode: 'deep', numCtx: 16384 } });
  check('sozlamalar saqlanadi', patched.data.settings?.mode === 'deep' && patched.data.settings?.numCtx === 16384, JSON.stringify(patched.data.settings));

  // ── static web app (packaged mode) ─────────────────────────────────────────
  const page = await fetch(`http://127.0.0.1:${port}/`);
  const html = await page.text();
  check('frontend statik fayllari xizmat qilinadi', page.ok && html.includes('<div id="root">'), `status=${page.status}`);

  const spa = await fetch(`http://127.0.0.1:${port}/files`);
  check('SPA fallback index.html qaytaradi', spa.ok && (await spa.text()).includes('<div id="root">'));
} catch (error) {
  check('smoke test xatosiz tugadi', false, error.message);
} finally {
  try {
    backend.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  await delay(800);
  try {
    backend.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  mock.server.close();
  await delay(200);
}

const passed = results.filter((result) => result.ok).length;
console.log(`\n${'─'.repeat(60)}`);
console.log(`SMOKE: ${passed}/${results.length} tekshiruv o‘tdi, ${failures} xato.`);
if (failures) {
  console.log('\nMuvaffaqiyatsiz tekshiruvlar:');
  for (const result of results.filter((item) => !item.ok)) {
    console.log(` - ${result.name}${result.detail ? ` :: ${result.detail}` : ''}`);
  }
  console.log('\nBackend loglari (oxirgi 40 qator):');
  const lines = backendLog.join('').split(/\r?\n/);
  for (const line of lines.slice(-40)) console.log(`   ${line}`);
}
process.exit(failures ? 1 : 0);
