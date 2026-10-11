import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-loop-data-'));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-loop-root-'));

await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }), 'utf8');
await fs.writeFile(path.join(root, 'src.js'), 'export const value = 41;\n', 'utf8');

/**
 * Mock Ollama. Scripted turns let us drive the agent loop deterministically:
 * turn 1 asks for a tool, turn 2 answers in plain text.
 */
let script = [];
const calls = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b', size: 100 }] }));
      return;
    }
    if (req.url === '/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.0.0-mock' }));
      return;
    }
    if (req.url !== '/api/chat') {
      res.writeHead(404).end('{}');
      return;
    }

    const payload = JSON.parse(body || '{}');
    calls.push({ messages: payload.messages, tools: payload.tools, model: payload.model });

    const turn = script.shift() || { content: 'Yakuniy javob: hammasi joyida.' };
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

    if (turn.toolCalls?.length) {
      for (const chunk of turn.content || []) {
        res.write(`${JSON.stringify({ model: payload.model, message: { role: 'assistant', content: chunk }, done: false })}\n`);
      }
      res.write(
        `${JSON.stringify({
          model: payload.model,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: turn.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } }))
          },
          done: false
        })}\n`
      );
      res.write(`${JSON.stringify({ model: payload.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 7, prompt_eval_count: 11 })}\n`);
      res.end();
      return;
    }

    for (const chunk of turn.content || []) {
      res.write(`${JSON.stringify({ model: payload.model, message: { role: 'assistant', content: chunk }, done: false })}\n`);
    }
    res.write(`${JSON.stringify({ model: payload.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 5, prompt_eval_count: 9 })}\n`);
    res.end();
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ollamaPort = server.address().port;

process.env.CODEBASE_DATA_DIR = dataDir;
process.env.CODEBASE_LOG = 'error';
process.env.OLLAMA_URL = `http://127.0.0.1:${ollamaPort}`;
process.env.CODEBASE_PORT = '0';

const paths = await import('../src/lib/paths.js');
paths.setRoots([root]);

const { createRegistry } = await import('../src/agent/registry.js');
const { createPermissions } = await import('../src/agent/permissions.js');
const { registerCoreTools } = await import('../src/agent/tools/index.js');
const { runAgent, parseTextToolCalls, stripToolCalls } = await import('../src/agent/loop.js');
const { getStore } = await import('../src/store.js');
const { config } = await import('../src/config.js');

const store = await getStore();
store.settings.autoApproveReads = true;
store.settings.summarize = false;
store.toolPolicies = {};

const registry = createRegistry({});
registerCoreTools(registry);
const permissions = createPermissions({ store, emit: (event) => events.push(event) });
const events = [];

function makeProject() {
  const now = new Date().toISOString();
  const session = { id: 's1', name: 'test', createdAt: now, updatedAt: now, messages: [] };
  return {
    project: {
      id: 'p1', name: 'Test', description: '', instructions: '', root, sessions: [session],
      activeSessionId: 's1', createdAt: now, updatedAt: now
    },
    session
  };
}

function resetEvents() {
  events.length = 0;
}

test('native tool calling: tool ishlaydi va natija javobga qo‘shiladi', async () => {
  script = [
    { content: ['Faylni o‘qiyapman.'], toolCalls: [{ name: 'fs.read', arguments: { path: 'src.js' } }] },
    { content: ['Kodda `value = 41` ', 'bor.'] }
  ];
  calls.length = 0;
  resetEvents();

  const { project, session } = makeProject();
  const result = await runAgent({
    prompt: 'src.js ni o‘qib ber',
    project,
    session,
    model: 'qwen2.5-coder:7b',
    mode: 'auto',
    emit: (event) => events.push(event),
    registry,
    permissions,
    store,
    skills: [],
    config,
    workspaceRoot: root
  });

  assert.equal(result.stopped, false);
  assert.equal(result.steps, 2);
  assert.match(result.content, /value = 41/);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'fs.read');
  assert.equal(result.toolCalls[0].ok, true);

  // the tool result was fed back to the model on the second turn
  const secondTurn = calls[1].messages;
  const toolMessage = secondTurn.find((message) => message.role === 'tool');
  assert.ok(toolMessage, 'tool natijasi modelga qaytarilishi kerak');
  assert.match(toolMessage.content, /value = 41/);

  // events: streaming tokens, tool lifecycle, done
  const types = events.map((event) => event.type);
  assert.ok(types.includes('token'));
  assert.ok(types.includes('tool_start'));
  assert.ok(types.includes('tool_end'));
  assert.ok(types.includes('done'));
  assert.equal(types[types.length - 1], 'done');

  // persistence
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[0].role, 'user');
  assert.equal(session.messages[1].role, 'assistant');
  assert.equal(session.messages[1].steps, 2);
  assert.equal(session.messages[1].toolCalls.length, 1);
});

test('salomlashish modelni chaqirmasdan javob beradi', async () => {
  calls.length = 0;
  resetEvents();
  const { project, session } = makeProject();
  const result = await runAgent({
    prompt: 'Salom',
    project,
    session,
    model: 'qwen2.5-coder:7b',
    emit: (event) => events.push(event),
    registry,
    permissions,
    store,
    skills: [],
    config,
    workspaceRoot: root
  });
  assert.match(result.content, /CodeBase/);
  assert.equal(calls.length, 0, 'salomlashishda Ollama chaqirilmasligi kerak');
  assert.equal(result.steps, 0);
});

test('ruxsat rad etilsa tool ishlamaydi va model xato oladi', async () => {
  store.toolPolicies = { 'fs.write': 'ask' };
  script = [
    { toolCalls: [{ name: 'fs.write', arguments: { path: 'yangi.txt', content: 'salom' } }] },
    { content: ['Yozib bo‘lmadi.'] }
  ];
  resetEvents();
  const { project, session } = makeProject();

  const run = runAgent({
    prompt: 'yangi.txt yarat',
    project,
    session,
    model: 'qwen2.5-coder:7b',
    emit: (event) => events.push(event),
    registry,
    permissions,
    store,
    skills: [],
    config,
    workspaceRoot: root
  });

  await new Promise((resolve) => setTimeout(resolve, 60));
  const request = events.find((event) => event.type === 'permission_request');
  assert.ok(request, 'permission_request yuborilishi kerak');
  permissions.resolve(request.id, { approved: false });

  const result = await run;
  assert.equal(result.toolCalls[0].ok, false);
  assert.match(result.toolCalls[0].summary, /ruxsat/i);
  const exists = await fs.access(path.join(root, 'yangi.txt')).then(() => true).catch(() => false);
  assert.equal(exists, false, 'rad etilgandan keyin fayl yozilmasligi kerak');
  store.toolPolicies = {};
});

test('matnli tool protokoli (toolsiz model) ishlaydi', async () => {
  script = [
    { content: ['```tool_call\n{"name":"fs.read","arguments":{"path":"package.json"}}\n```'] },
    { content: ['Loyiha nomi: demo.'] }
  ];
  calls.length = 0;
  resetEvents();
  const { project, session } = makeProject();

  const result = await runAgent({
    prompt: 'package.json dagi nom nima?',
    project,
    session,
    model: 'kichik-model:1b', // supportsTools() false → matnli protokol
    mode: 'auto',
    emit: (event) => events.push(event),
    registry,
    permissions,
    store,
    skills: [],
    config,
    workspaceRoot: root
  });

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'fs.read');
  assert.match(result.content, /demo/);
  assert.equal(calls[0].tools, undefined, 'matnli protokolda tools yuborilmasligi kerak');
});

test('matnli tool parser va tozalash', () => {
  const parsed = parseTextToolCalls('oldin\n```tool_call\n{"name":"fs.list","arguments":{"path":"."}}\n```\nkeyin');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'fs.list');
  assert.deepEqual(parsed[0].arguments, { path: '.' });

  assert.equal(parseTextToolCalls('```tool_call\n{ bu json emas }\n```').length, 0);
  assert.equal(stripToolCalls('javob\n```tool_call\n{"name":"x"}\n```\ntext').includes('tool_call'), false);
});

test('abort qilinganda loop to‘xtaydi va xabar saqlanadi', async () => {
  const controller = new AbortController();
  script = [{ content: ['a'.repeat(50)], toolCalls: [{ name: 'fs.list', arguments: { path: '.' } }] }];
  const { project, session } = makeProject();
  controller.abort();

  const result = await runAgent({
    prompt: 'papkani ko‘rsat',
    project,
    session,
    model: 'qwen2.5-coder:7b',
    signal: controller.signal,
    emit: () => {},
    registry,
    permissions,
    store,
    skills: [],
    config,
    workspaceRoot: root
  });

  assert.equal(result.stopped, true);
  assert.equal(session.messages.length, 2);
});

test('kontekst byudjeti: juda uzun tarix qisqartiriladi', async () => {
  script = [{ content: ['qisqa javob'] }];
  calls.length = 0;
  const { project, session } = makeProject();
  for (let i = 0; i < 40; i += 1) {
    session.messages.push({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(4_000), createdAt: new Date().toISOString() });
  }

  await runAgent({
    prompt: 'davom et',
    project,
    session,
    model: 'qwen2.5-coder:7b',
    emit: () => {},
    registry,
    permissions,
    store,
    skills: [],
    config,
    workspaceRoot: root
  });

  const sent = calls[0].messages;
  const historyChars = sent.reduce((sum, message) => sum + String(message.content || '').length, 0);
  assert.ok(historyChars < 400_000, `tarix juda katta yuborildi: ${historyChars}`);
  assert.ok(sent.length < 40, `juda ko‘p xabar yuborildi: ${sent.length}`);
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});
