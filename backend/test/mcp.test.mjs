/**
 * MCP subsystem tests (ARCHITECTURE.md §11 + §18).
 *
 * Preferred path: spawn the real example server
 * (`backend/examples/mcp-echo-server.mjs`) through the real `McpClient`, so the
 * whole stdio JSON-RPC pipeline is covered end to end.
 *
 * Some sandboxes (DSH's Windows file sandbox, locked-down CI containers) deny
 * `spawn()` with non-inherited stdio: every child-process test then fails with
 * `EPERM`. When that is detected, the spawn-based tests are reported as skipped
 * and the identical assertions are re-run in-process through
 * `test/helpers/fake-stdio-child.mjs` (real streams, real EventEmitter child).
 *
 * Run with:  node --test backend/test/mcp.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { McpClient } from '../src/mcp/client.js';
import { flattenContent, slugify, toolNameFor } from '../src/mcp/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_SERVER = path.resolve(here, '../examples/mcp-echo-server.mjs');
const CLIENT_TIMEOUT_MS = 15_000;

/** Cached verdict: probing twice is wasteful and spawn is all-or-nothing. */
let spawnAvailability = null;

/** @returns {boolean} true when this host lets Node spawn with piped stdio. */
function detectSpawn() {
  if (spawnAvailability !== null) return spawnAvailability;
  try {
    const probe = spawnSync(process.execPath, ['--version'], { stdio: ['pipe', 'pipe', 'pipe'] });
    // A blocked pipe syscall surfaces as `error` (EPERM) and a null exit status.
    spawnAvailability = !probe.error && probe.status === 0;
  } catch {
    spawnAvailability = false;
  }
  if (!spawnAvailability) {
    // Keep this loud: it explains why the real-process tests were skipped.
    process.stderr.write(
      '\n[mcp.test] spawn() with piped stdio is blocked on this host — ' +
      'real-process tests are skipped and the same assertions run through the in-process stream harness.\n\n'
    );
  }
  return spawnAvailability;
}

/** @param {import('node:test').TestContext} t */
function skipIfNoSpawn(t) {
  if (detectSpawn()) return false;
  t.skip('spawn() with piped stdio is blocked on this host (EPERM)');
  return true;
}

/** Connect a real client, or skip the test when the host blocks spawning. */
async function connectReal(t) {
  if (skipIfNoSpawn(t)) return null;
  const client = new McpClient(echoServer(), { logger: silentLogger, timeoutMs: CLIENT_TIMEOUT_MS });
  await client.start();
  return client;
}

/** Always return the absolute path to the example server. */
function echoServer(overrides = {}) {
  return {
    id: 'test-echo',
    name: 'Echo Test',
    command: process.execPath,
    args: [EXAMPLE_SERVER],
    env: {},
    enabled: true,
    autoStart: false,
    transport: 'stdio',
    trust: 'untrusted',
    ...overrides
  };
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Start a client, run `fn`, always stop the client.
 * @param {any} server
 * @param {(client: McpClient) => Promise<any>} fn
 * @param {object} [options]
 */
async function withClient(server, fn, options = {}) {
  const client = new McpClient(server, { logger: silentLogger, timeoutMs: CLIENT_TIMEOUT_MS, ...options });
  try {
    await client.start();
    return await fn(client);
  } finally {
    await client.stop();
  }
}

// ---------------------------------------------------------------------------
// In-process stdio stand-in for a spawned MCP server.
//
// It provides real `stdin`/`stdout`/`stderr` streams and a real EventEmitter
// lifecycle, so `McpClient` exercises its actual line buffering, JSON-RPC
// matching, timeout and exit paths without spawning a process. Suite B uses it
// when the host blocks `spawn()` with non-inherited stdio (EPERM).
// ---------------------------------------------------------------------------

/**
 * @param {{ pid?: number, exitCode?: number|null }} [options]
 * @returns {{ child: any, stdin: any, stdout: any, stderr: any, kill: Function, exit: Function }}
 */
function createFakeChild(options = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const child = new EventEmitter();
  child.pid = options.pid ?? 4242;
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.exitCode = options.exitCode ?? null;
  child.signalCode = null;
  child.killed = false;
  child.kill = (signal = 'SIGTERM') => {
    child.killed = true;
    setImmediate(() => finish(signal === 'SIGKILL' ? null : 0, signal));
    return true;
  };

  let exited = false;
  /** @param {number|null} code @param {NodeJS.Signals|null} signal */
  function finish(code, signal) {
    if (exited) return;
    exited = true;
    child.exitCode = code;
    child.signalCode = signal;
    try {
      stdout.end();
      stderr.end();
    } catch {
      // Streams may already be closed.
    }
    child.emit('exit', code, signal);
  }

  return { child, stdin, stdout, stderr, kill: child.kill, exit: finish };
}

/**
 * A fake `child_process.spawn` whose child behaves like the example MCP server.
 * @param {{ chunkSize?: number, crlf?: boolean, onRequest?: Function, onNotification?: Function, log?: any[] }} [options]
 */
function createEchoServerSpawn(options = {}) {
  const crlf = options.crlf === true;
  const chunkSize = Number.isFinite(options.chunkSize) ? Number(options.chunkSize) : 0;
  const log = options.log || [];
  /** Every message the client sent us (for protocol assertions in tests). */
  const incoming = [];
  /** @type {ReturnType<typeof createFakeChild>|null} */
  let last = null;

  const spawnImpl = () => {
    const fake = createFakeChild();
    last = fake;
    let buffer = '';

    /** @param {object} message */
    const push = (message) => {
      const line = `${JSON.stringify(message)}${crlf ? '\r\n' : '\n'}`;
      if (chunkSize > 0) {
        for (let i = 0; i < line.length; i += chunkSize) {
          const slice = line.slice(i, i + chunkSize);
          setTimeout(() => fake.stdout.write(slice), 1);
        }
      } else {
        setTimeout(() => fake.stdout.write(line), 1);
      }
      log.push(message);
    };

    fake.stdin.on('data', (chunk) => {
      buffer += String(chunk);
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const raw = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (raw.trim()) handleLine(raw);
        index = buffer.indexOf('\n');
      }
    });
    fake.stdin.on('end', () => setTimeout(() => fake.exit(0, null), 5));

    /** @param {string} raw */
    function handleLine(raw) {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      incoming.push(message);
      if (message.id === undefined) {
        if (typeof options.onNotification === 'function') options.onNotification(message, fake);
        return;
      }
      if (typeof options.onRequest === 'function' && options.onRequest(message, fake, push)) return;
      switch (message.method) {
        case 'initialize':
          push({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {}, resources: {}, prompts: {} },
              serverInfo: { name: 'fake-echo', version: '1.0.0' }
            }
          });
          break;
        case 'tools/list':
          push({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: [
                { name: 'echo', title: 'Echo', description: 'Echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
                { name: 'add', title: 'Add', description: 'Add', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }
              ]
            }
          });
          break;
        case 'tools/call': {
          const args = message.params?.arguments || {};
          const name = message.params?.name;
          if (name === 'echo') {
            push({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String(args.message) }, { type: 'text', text: `len=${String(args.message).length}` }] } });
          } else if (name === 'add') {
            push({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `${Number(args.a) + Number(args.b)}` }] } });
          } else {
            push({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true } });
          }
          break;
        }
        case 'resources/list':
          push({ jsonrpc: '2.0', id: message.id, result: { resources: [{ uri: 'echo://greeting', name: 'greeting', mimeType: 'text/plain' }] } });
          break;
        case 'resources/read':
          push({ jsonrpc: '2.0', id: message.id, result: { contents: [{ uri: message.params?.uri, mimeType: 'text/plain', text: 'Hello from the fake echo server' }] } });
          break;
        case 'prompts/list':
          push({ jsonrpc: '2.0', id: message.id, result: { prompts: [{ name: 'greet', description: 'Greeting', arguments: [{ name: 'name' }] }] } });
          break;
        case 'prompts/get':
          push({ jsonrpc: '2.0', id: message.id, result: { messages: [{ role: 'user', content: { type: 'text', text: `Please greet ${message.params?.arguments?.name || 'world'} warmly.` } }] } });
          break;
        case 'ping':
          push({ jsonrpc: '2.0', id: message.id, result: {} });
          break;
        default:
          push({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
      }
    }

    setTimeout(() => fake.stderr.write('[fake-echo] ready\n'), 1);
    return fake.child;
  };

  return {
    spawnImpl,
    log,
    incoming,
    get child() { return last?.child ?? null; },
    get stdin() { return last?.stdin ?? null; }
  };
}

/**
 * A fake spawn whose child exits on its own after answering `initialize`
 * (exercises the crash / auto-restart path without a real process).
 * @param {{ code?: number, delayMs?: number }} [options]
 */
function createCrashingSpawn(options = {}) {
  const code = Number.isFinite(options.code) ? Number(options.code) : 9;
  const delayMs = Number.isFinite(options.delayMs) ? Number(options.delayMs) : 20;
  const spawnImpl = () => {
    const fake = createFakeChild();
    let buffer = '';
    fake.stdin.on('data', (chunk) => {
      buffer += String(chunk);
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const raw = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          message = null;
        }
        if (message && message.id !== undefined) {
          setTimeout(() => {
            fake.stdout.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'crasher', version: '1' } }
            })}\n`);
            setTimeout(() => fake.exit(code, null), delayMs);
          }, 1);
        }
        index = buffer.indexOf('\n');
      }
    });
    return fake.child;
  };
  return { spawnImpl };
}

// ---------------------------------------------------------------------------
// Shared assertions — run against the real server AND against the harness.
// ---------------------------------------------------------------------------

/**
 * @param {() => Promise<McpClient>} connect Connects a ready client.
 */
function defineClientContract(connect) {
  test('the handshake reports serverInfo and capabilities', async () => {
    const client = await connect();
    try {
      assert.equal(client.status, 'ready');
      assert.equal(typeof client.serverInfo?.name, 'string');
      assert.equal(typeof client.serverInfo?.version, 'string');
      assert.ok(client.capabilities && typeof client.capabilities === 'object');
      assert.ok('tools' in client.capabilities);
    } finally {
      await client.stop();
    }
  });

  test('tools/list exposes echo and add with JSON schemas', async () => {
    const client = await connect();
    try {
      const tools = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, ['add', 'echo']);

      const echo = tools.find((tool) => tool.name === 'echo');
      assert.equal(echo.inputSchema?.type, 'object');
      assert.deepEqual(echo.inputSchema?.required, ['message']);
      assert.equal(echo.inputSchema?.properties?.message?.type, 'string');

      const add = tools.find((tool) => tool.name === 'add');
      assert.equal(add.inputSchema?.properties?.a?.type, 'number');
      assert.equal(add.inputSchema?.properties?.b?.type, 'number');
    } finally {
      await client.stop();
    }
  });

  test('tools/call returns text content for echo and add', async () => {
    const client = await connect();
    try {
      const echoed = await client.callTool('echo', { message: 'salom mcp' });
      assert.ok(Array.isArray(echoed.content));
      assert.equal(flattenContent(echoed.content), 'salom mcp\nlen=9');
      assert.notEqual(echoed.isError, true);

      const sum = await client.callTool('add', { a: 2, b: 40 });
      assert.equal(flattenContent(sum.content), '42');

      // A tool-level failure is reported, not thrown.
      const unknown = await client.callTool('nope', {});
      assert.equal(unknown.isError, true);
      assert.match(flattenContent(unknown.content), /nope/);

      // The transport survives tool-level errors.
      assert.equal(flattenContent((await client.callTool('echo', { message: 'ok' })).content), 'ok\nlen=2');
    } finally {
      await client.stop();
    }
  });

  test('resources: list and read echo://greeting', async () => {
    const client = await connect();
    try {
      const resources = await client.listResources();
      assert.equal(resources.length, 1);
      assert.equal(resources[0].uri, 'echo://greeting');

      const read = await client.readResource('echo://greeting');
      assert.ok(Array.isArray(read.contents));
      assert.equal(read.contents[0].uri, 'echo://greeting');
      assert.match(String(read.contents[0].text), /hello/i);
    } finally {
      await client.stop();
    }
  });

  test('prompts: list and get greet', async () => {
    const client = await connect();
    try {
      const prompts = await client.listPrompts();
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0].name, 'greet');

      const prompt = await client.getPrompt('greet', { name: 'Aziz' });
      assert.ok(Array.isArray(prompt.messages));
      assert.equal(prompt.messages[0].role, 'user');
      assert.match(String(prompt.messages[0].content.text), /Aziz/);
    } finally {
      await client.stop();
    }
  });

  test('ping resolves and unknown methods reject with a JSON-RPC error', async () => {
    const client = await connect();
    try {
      assert.deepEqual(await client.call('ping', {}), {});
      await assert.rejects(() => client.call('totally/unknown', {}), /Method not found/);
      assert.match(String(client.lastError), /Method not found/);
      assert.equal(client.status, 'ready');
      assert.equal((await client.call('tools/list', {})).tools.length, 2);
    } finally {
      await client.stop();
    }
  });

  test('a per-request timeout rejects clearly and sets lastError', async () => {
    const client = await connect();
    try {
      await assert.rejects(() => client.call('ping', {}, 1), /timeout/);
      assert.match(String(client.lastError), /timeout/);
      assert.deepEqual(await client.call('ping', {}, 5_000), {});
    } finally {
      await client.stop();
    }
  });

  test('stop() is idempotent and leaves the client stopped', async () => {
    const client = await connect();
    await client.stop();
    await client.stop();
    assert.equal(client.status, 'stopped');
    assert.equal(client.child, null);
    await assert.rejects(() => client.call('ping', {}), /ishlamayapti/);
  });
}

// ---------------------------------------------------------------------------
// Suite A — real process (skipped when the host blocks piped spawn).
// ---------------------------------------------------------------------------

{

  test('example server: handshake reports serverInfo and capabilities', async (t) => {
    const client = await connectReal(t);
    if (!client) return;
    try {
      assert.equal(client.status, 'ready');
      assert.equal(client.serverInfo?.name, 'mcp-echo-server');
      assert.ok('tools' in client.capabilities);
    } finally {
      await client.stop();
    }
  });

  test('example server: tools/list, tools/call, resources, prompts via McpClient', async (t) => {
    if (skipIfNoSpawn(t)) return;
    await withClient(echoServer(), async (client) => {
      const tools = (await client.listTools()).map((tool) => tool.name).sort();
      assert.deepEqual(tools, ['add', 'echo']);

      assert.equal(flattenContent((await client.callTool('echo', { message: 'salom mcp' })).content), 'salom mcp\nlen=9');
      assert.equal(flattenContent((await client.callTool('add', { a: 2, b: 40 })).content), '42');

      const resources = await client.listResources();
      assert.equal(resources[0].uri, 'echo://greeting');
      const read = await client.readResource('echo://greeting');
      assert.match(String(read.contents[0].text), /echo server/);

      const prompts = await client.listPrompts();
      assert.equal(prompts[0].name, 'greet');
      const prompt = await client.getPrompt('greet', { name: 'Aziz' });
      assert.match(String(prompt.messages[0].content.text), /Aziz/);
    });
  });

  test('example server: server-initiated requests get -32601 so it never hangs', async (t) => {
    if (skipIfNoSpawn(t)) return;
    // The server asks the client for `roots/list` during the handshake. The client
    // must answer it (with -32601) instead of leaving the server waiting forever.
    const script = [
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "let rejected = false;",
      'const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");',
      "rl.on('line', (line) => {",
      '  if (!line.trim()) return;',
      '  let message;',
      '  try { message = JSON.parse(line); } catch { return; }',
      '  if (message.id === 999) {',
      '    rejected = message.error?.code === -32601;',
      '    return;',
      '  }',
      '  if (message.method === "initialize") {',
      '    setTimeout(() => send({ jsonrpc: "2.0", id: 999, method: "roots/list" }), 20);',
      '    setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "roots-probe", version: "1.0.0" } } }), 90);',
      '    return;',
      '  }',
      '  if (message.method === "tools/list") {',
      '    send({ jsonrpc: "2.0", id: message.id, result: { tools: rejected ? [{ name: "ok", description: "d", inputSchema: { type: "object" } }] : [] } });',
      '  }',
      '});'
    ].join('\n');

    await withClient(echoServer({ command: process.execPath, args: ['-e', script] }), async (client) => {
      const tools = await client.listTools();
      assert.equal(tools.length, 1, 'client server-so‘roviga -32601 bilan javob berishi kerak');
      assert.equal(tools[0].name, 'ok');
    });
  });

  test('example server: tolerates CRLF, blank lines and partial chunks', async (t) => {
    if (skipIfNoSpawn(t)) return;
    // CRLF line endings, a stray blank line, and one JSON message delivered in two
    // chunks with a delay in between (no line break inside the payload).
    const script = [
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      'const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\r\\n");',
      "rl.on('line', (line) => {",
      '  if (!line.trim()) return;',
      '  let message;',
      '  try { message = JSON.parse(line); } catch { return; }',
      '  if (message.method === "initialize") {',
      '    process.stdout.write("\\r\\n");',
      '    setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "crlf", version: "1" } } }), 20);',
      '    return;',
      '  }',
      '  if (message.method === "tools/list") {',
      '    const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "crlf-tool", description: "d", inputSchema: { type: "object" } }] } }) + "\\r\\n";',
      '    process.stdout.write(payload.slice(0, 12));',
      '    setTimeout(() => process.stdout.write(payload.slice(12)), 30);',
      '  }',
      '});'
    ].join('\n');

    await withClient(echoServer({ command: process.execPath, args: ['-e', script] }), async (client) => {
      const tools = await client.listTools();
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, 'crlf-tool');
    });
  });

  test('example server: notifications are ignored without breaking request ids', async (t) => {
    if (skipIfNoSpawn(t)) return;
    const script = [
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      'const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");',
      "rl.on('line', (line) => {",
      '  if (!line.trim()) return;',
      '  let message;',
      '  try { message = JSON.parse(line); } catch { return; }',
      '  send({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } });',
      '  if (message.id === undefined) return;',
      '  send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hi" } });',
      '  send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "noisy", version: "1" } } });',
      '});'
    ].join('\n');

    await withClient(echoServer({ command: process.execPath, args: ['-e', script] }), async (client) => {
      assert.equal(client.serverInfo?.name, 'noisy');
      assert.equal((await client.call('ping', {})).serverInfo.name, 'noisy');
    });
  });

  test('example server: stderr never enters the protocol stream', async (t) => {
    if (skipIfNoSpawn(t)) return;
    const client = new McpClient(echoServer(), { logger: silentLogger, timeoutMs: CLIENT_TIMEOUT_MS });
    try {
      await client.start();
      const chunks = [];
      client.on('stderr', (text) => chunks.push(text));
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(chunks.join('').includes('mcp-echo-server'));
      assert.equal(client.status, 'ready');
    } finally {
      await client.stop();
    }
  });

  test('example server: exit emits "exit", marks crashed, and keeps lastError', async (t) => {
    if (skipIfNoSpawn(t)) return;
    const client = new McpClient(echoServer(), { logger: silentLogger, timeoutMs: CLIENT_TIMEOUT_MS });
    try {
      await client.start();
      const exited = new Promise((resolve) => client.once('exit', resolve));
      client.child.kill();
      const info = await exited;
      assert.ok('code' in info && 'signal' in info);
      assert.equal(client.status, 'crashed');
      assert.ok(client.lastError);
      await assert.rejects(() => client.call('ping', {}), /ishlamayapti/);
    } finally {
      await client.stop();
    }
  });

  test('example server: stop() kills the process tree', async (t) => {
    if (skipIfNoSpawn(t)) return;
    const client = new McpClient(echoServer(), { logger: silentLogger, timeoutMs: CLIENT_TIMEOUT_MS });
    let pid = null;
    try {
      await client.start();
      pid = client.child?.pid;
      assert.ok(pid);
    } finally {
      await client.stop();
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(isProcessAlive(pid), false, `pid ${pid} hali ham tirik`);
  });

  test('start() rejects for a missing executable', async (t) => {
    if (skipIfNoSpawn(t)) return;
    const client = new McpClient(
      echoServer({ name: 'Broken', command: path.join(os.tmpdir(), 'codebase-mcp-does-not-exist.exe') }),
      { logger: silentLogger, timeoutMs: 5_000 }
    );
    await assert.rejects(() => client.start());
    assert.ok(client.lastError);
    await client.stop();
  });

  test('start() rejects when the process exits during initialize', async (t) => {
    if (skipIfNoSpawn(t)) return;
    const client = new McpClient(
      echoServer({ name: 'EarlyExit', command: process.execPath, args: ['-e', 'process.exit(7)'] }),
      { logger: silentLogger, timeoutMs: 5_000 }
    );
    await assert.rejects(() => client.start(), /initialize/);
    await client.stop();
    await client.stop();
    assert.equal(client.status, 'stopped');
  });

  test('the example server exits cleanly when stdin closes', async (t) => {
    if (skipIfNoSpawn(t)) return;
    const child = spawn(process.execPath, [EXAMPLE_SERVER], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.stdin.end();
    const { code, signal } = await exited;
    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.ok(stderr.join('').includes('mcp-echo-server'));
  });

  test('the example server file exists', () => {
    assert.ok(fs.existsSync(EXAMPLE_SERVER), `${EXAMPLE_SERVER} topilmadi`);
  });
}

// ---------------------------------------------------------------------------
// Suite B — in-process stdio harness (runs everywhere, including this sandbox).
// ---------------------------------------------------------------------------

{

  /** @param {object} [spawnOptions] */
  function connectViaHarness(spawnOptions = {}) {
    const fake = createEchoServerSpawn({ chunkSize: 7, ...spawnOptions });
    const client = new McpClient(echoServer(), {
      logger: silentLogger,
      timeoutMs: CLIENT_TIMEOUT_MS,
      spawnImpl: fake.spawnImpl
    });
    return client;
  }

  defineClientContract(async () => {
    const client = connectViaHarness();
    await client.start();
    return client;
  });

  test('harness: server→client sampling/createMessage is answered with -32601', async () => {
    const fake = createEchoServerSpawn({
      onRequest(message, _child, push) {
        if (message.method !== 'ping') return false;
        push({ jsonrpc: '2.0', id: 'srv-1', method: 'sampling/createMessage', params: { messages: [] } });
        return true; // never answer the ping itself
      }
    });
    const client = new McpClient(echoServer(), {
      logger: silentLogger,
      timeoutMs: 3_000,
      spawnImpl: fake.spawnImpl
    });
    try {
      await client.start();
      await assert.rejects(() => client.call('ping', {}, 150), /timeout/);
      const answer = fake.incoming.find((entry) => entry.id === 'srv-1');
      assert.ok(answer, 'client server-so‘roviga javob berishi kerak');
      assert.equal(answer.error?.code, -32601);
      assert.equal(answer.result, undefined);
    } finally {
      await client.stop();
    }
  });

  test('harness: unexpected child exit marks the client crashed', async () => {
    const fake = createEchoServerSpawn();
    const client = new McpClient(echoServer(), { logger: silentLogger, timeoutMs: 3_000, spawnImpl: fake.spawnImpl });
    try {
      await client.start();
      const exited = new Promise((resolve) => client.once('exit', resolve));
      fake.child.kill();
      const info = await exited;
      assert.equal(info.code, 0);
      assert.equal(client.status, 'crashed');
      assert.ok(client.lastError);
    } finally {
      await client.stop();
    }
  });

  test('harness: stop() ends the child and never throws twice', async () => {
    const fake = createEchoServerSpawn();
    const client = new McpClient(echoServer(), { logger: silentLogger, timeoutMs: 3_000, spawnImpl: fake.spawnImpl });
    await client.start();
    const pid = client.child?.pid;
    assert.ok(pid);
    await client.stop();
    await client.stop();
    assert.equal(client.status, 'stopped');
    assert.equal(fake.child.exitCode !== null || fake.child.signalCode !== null, true);
  });
}

// ---------------------------------------------------------------------------
// Manager — minimal registry/store doubles around the real McpClient.
// ---------------------------------------------------------------------------

/** Minimal §7-compatible registry double. @param {{names?: string[]}} [options] */
function createFakeRegistry(options = {}) {
  const tools = new Map((options.names || []).map((name) => [name, { name }]));
  const unregistered = [];
  return {
    unregistered,
    register(tool) {
      if (tools.has(tool.name)) {
        // §7: the registry throws on duplicates; the manager must catch it.
        throw new Error(`Tool "${tool.name}" allaqachon mavjud.`);
      }
      tools.set(tool.name, tool);
    },
    unregister(name) {
      unregistered.push(name);
      tools.delete(name);
    },
    get(name) {
      return tools.get(name);
    },
    list() {
      return Array.from(tools.values());
    }
  };
}

/** @param {object} [spawnOptions] */
function harnessServer(spawnOptions = {}) {
  const fake = createEchoServerSpawn({ chunkSize: 11, ...spawnOptions });
  return { server: echoServer({ autoStart: true }), spawnImpl: fake.spawnImpl, fake };
}

function defineManagerContract() {
  test('startAuto registers mcp tools and runs them through McpClient', async () => {
    const { createMcpManager } = await import('../src/mcp/manager.js');
    const harness = harnessServer();
    const registry = createFakeRegistry();
    const store = { mcpServers: [harness.server], saveStore() {} };
    const manager = createMcpManager({ store, registry, logger: silentLogger, spawnImpl: harness.spawnImpl });
    try {
      const started = await manager.startAuto();
      assert.deepEqual(started, [{ id: 'test-echo', ok: true }]);

      const echoTool = registry.get('mcp__echo_test__echo');
      assert.ok(echoTool, 'mcp__echo_test__echo ro‘yxatga olinishi kerak');
      assert.equal(echoTool.source, 'mcp');
      assert.equal(echoTool.category, 'mcp');
      assert.equal(echoTool.defaultPolicy, 'ask');
      assert.equal(echoTool.parameters?.type, 'object');
      assert.equal(echoTool.parameters?.properties?.message?.type, 'string');

      const result = await echoTool.run({ message: 'hi mcp' }, {});
      assert.equal(result.ok, true);
      assert.equal(result.content, 'hi mcp\nlen=6');
      assert.equal(typeof result.summary, 'string');
      assert.ok(result.summary.length > 0);
      assert.ok(Array.isArray(result.data));

      const sum = await registry.get('mcp__echo_test__add').run({ a: 40, b: 2 }, {});
      assert.equal(sum.ok, true);
      assert.equal(sum.content, '42');

      const row = manager.list().find((item) => item.id === 'test-echo');
      assert.equal(row.status, 'ready');
      assert.equal(row.tools, 2);
      assert.equal(manager.tools('test-echo').length, 2);
    } finally {
      await manager.stopAll();
    }
    assert.deepEqual(registry.list(), [], 'stopAll dan keyin MCP tool nomlari ro‘yxatdan chiqadi');
  });

  test('a server-reported tool error becomes { ok: false, error }', async () => {
    const { createMcpManager } = await import('../src/mcp/manager.js');
    // tools/call answers with isError — the manager must map it to ok:false.
    const harness = harnessServer({
      onRequest(message, _child, push) {
        if (message.method !== 'tools/call') return false;
        push({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: 'echo: message kerak' }], isError: true }
        });
        return true;
      }
    });
    const registry = createFakeRegistry();
    const store = { mcpServers: [harness.server], saveStore() {} };
    const manager = createMcpManager({ store, registry, logger: silentLogger, spawnImpl: harness.spawnImpl });
    try {
      await manager.startAuto();
      const result = await registry.get('mcp__echo_test__echo').run({ message: 1 }, {});
      assert.equal(result.ok, false);
      assert.match(result.error, /message kerak/);
      assert.match(result.content, /message kerak/);
    } finally {
      await manager.stopAll();
    }
  });

  test('restart replaces the previously registered tools', async () => {
    const { createMcpManager } = await import('../src/mcp/manager.js');
    const harness = harnessServer();
    const registry = createFakeRegistry();
    const store = { mcpServers: [harness.server], saveStore() {} };
    const manager = createMcpManager({ store, registry, logger: silentLogger, spawnImpl: harness.spawnImpl });
    try {
      await manager.startAuto();
      await manager.restart('test-echo');
      assert.ok(registry.get('mcp__echo_test__echo'));
      assert.equal(manager.list().find((item) => item.id === 'test-echo').tools, 2);
      const result = await registry.get('mcp__echo_test__echo').run({ message: 'qayta' }, {});
      assert.equal(result.content, 'qayta\nlen=5');
    } finally {
      await manager.stopAll();
    }
  });

  test('duplicate tool names keep the existing registry entry', async () => {
    const { createMcpManager } = await import('../src/mcp/manager.js');
    const harness = harnessServer();
    const registry = createFakeRegistry({ names: ['mcp__echo_test__echo'] });
    const existing = registry.get('mcp__echo_test__echo');
    const store = { mcpServers: [harness.server], saveStore() {} };
    const manager = createMcpManager({ store, registry, logger: silentLogger, spawnImpl: harness.spawnImpl });
    try {
      await manager.startAuto();
      assert.equal(registry.get('mcp__echo_test__echo'), existing, 'mavjud tool almashtirilmaydi');
      assert.ok(registry.get('mcp__echo_test__add'), 'boshqa tool baribir ro‘yxatga olinadi');
      assert.equal(manager.list().find((item) => item.id === 'test-echo').tools, 1);
    } finally {
      await manager.stopAll();
    }
  });

  test('start/stop/restart/list/reload are idempotent and never throw for unknown ids', async () => {
    const { createMcpManager } = await import('../src/mcp/manager.js');
    const harness = harnessServer();
    const registry = createFakeRegistry();
    const store = { mcpServers: [{ ...harness.server, autoStart: false }], saveStore() {} };
    const manager = createMcpManager({ store, registry, logger: silentLogger, spawnImpl: harness.spawnImpl });
    try {
      const servers = manager.list();
      assert.equal(servers.length, 1, 'A1');
      assert.equal(servers[0].status, 'stopped', 'A2');

      await manager.start('test-echo');
      await manager.start('test-echo');
      assert.equal(manager.list()[0].status, 'ready', 'B');

      await manager.stop('test-echo');
      await manager.stop('test-echo');
      assert.equal(manager.list()[0].status, 'stopped', 'C');

      // reload() starts enabled servers again (autoStart gates startAuto only).
      const reloaded = await manager.reload();
      assert.equal(reloaded[0].status, 'ready', 'D');
      assert.equal(reloaded[0].tools, 2, 'D2');

      await manager.stop('nope'); // unknown id: never throws
      await assert.rejects(() => manager.start('nope'), /topilmadi/);
      await assert.rejects(() => manager.restart('nope'), /topilmadi/);
    } finally {
      await manager.stopAll();
    }
  });

  test('a crashing server hits the restart budget and ends as status error', async () => {
    const { createMcpManager } = await import('../src/mcp/manager.js');
    const crashing = createCrashingSpawn({ code: 9, delayMs: 30 });
    const registry = createFakeRegistry();
    const store = {
      mcpServers: [echoServer({
        name: 'Crasher',
        command: process.execPath,
        args: [EXAMPLE_SERVER],
        autoStart: true
      })],
      saveStore() {}
    };
    const spawnImpl = crashing.spawnImpl;
    const manager = createMcpManager({ store, registry, logger: silentLogger, spawnImpl });
    try {
      await manager.startAuto();
      const deadline = Date.now() + 20_000;
      let row = manager.list().find((item) => item.id === 'test-echo');
      while (row.status !== 'error' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        row = manager.list().find((item) => item.id === 'test-echo');
      }
      assert.equal(row.status, 'error', 'E');
      assert.match(String(row.lastError), /3 marta/, 'F');
      // An explicit restart clears the spent budget and connects again.
      await manager.restart('test-echo');
      const restarted = manager.list().find((item) => item.id === 'test-echo');
      assert.equal(restarted.status, 'ready', 'G');
      assert.equal(restarted.tools, 0, 'G2');
    } finally {
      await manager.stopAll();
    }
  });

  test('a registry without unregister() does not break stopAll()', async () => {
    const { createMcpManager } = await import('../src/mcp/manager.js');
    const harness = harnessServer();
    const registry = createFakeRegistry();
    delete registry.unregister;
    const store = { mcpServers: [harness.server], saveStore() {} };
    const manager = createMcpManager({ store, registry, logger: silentLogger, spawnImpl: harness.spawnImpl });
    await manager.startAuto();
    assert.ok(registry.get('mcp__echo_test__echo'));
    await manager.stopAll(); // must not throw even though tools stay registered
    assert.equal(manager.list()[0].status, 'stopped');
  });
}

defineManagerContract();

test('types helpers: slugify, toolNameFor, flattenContent', () => {
  assert.equal(slugify('Echo Test'), 'echo_test');
  assert.equal(slugify('my  server!!'), 'my_server');
  assert.equal(slugify('__weird__'), 'weird');
  assert.ok(slugify('x'.repeat(200)).length <= 60);

  assert.equal(toolNameFor({ name: 'Echo Test' }, { name: 'add' }), 'mcp__echo_test__add');
  assert.equal(toolNameFor('Demo Server', 'read_file'), 'mcp__demo_server__read_file');

  assert.equal(flattenContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(flattenContent([{ type: 'image', mimeType: 'image/png' }]), '[image: image/png]');
  assert.equal(flattenContent([{ type: 'weird' }]), '[weird]');
  assert.equal(flattenContent([null, undefined, '']), '');
  assert.equal(flattenContent('nope'), '');
  assert.equal(flattenContent([]), '');
  assert.match(flattenContent([{ type: 'text', text: 'x'.repeat(50) }], { maxLength: 10 }), /truncated/);
});

/** @param {number} pid */
function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
