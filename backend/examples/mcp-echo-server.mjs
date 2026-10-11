#!/usr/bin/env node
/**
 * CodeBase Agent — example MCP stdio server (zero dependencies).
 *
 * Implements a minimal but real Model Context Protocol server:
 *   initialize, notifications/initialized, ping,
 *   tools/list + tools/call    (echo, add),
 *   resources/list + resources/read (echo://greeting),
 *   prompts/list + prompts/get (greet).
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout.
 * stdout carries protocol data ONLY — every log line goes to stderr.
 * The process exits cleanly when stdin closes.
 */
import process from 'node:process';

const SERVER_INFO = { name: 'mcp-echo-server', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2024-10-07', '2025-03-26', '2025-06-18']);
const MAX_LINE_CHARS = 4 * 1024 * 1024;

/** Write one log line to stderr (never stdout). @param {string} message */
function log(message) {
  try {
    process.stderr.write(`[mcp-echo-server] ${message}\n`);
  } catch {
    // stderr may be closed; never crash on logging.
  }
}

/** Write one JSON-RPC message to stdout. @param {object} message */
function writeMessage(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch (error) {
    log(`stdout yozishda xato: ${error?.message || error}`);
  }
}

/** @param {any} id @param {any} result */
function reply(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

/** @param {any} id @param {number} code @param {string} message @param {any} [data] */
function replyError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  writeMessage({ jsonrpc: '2.0', id, error });
}

const TOOLS = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Return the provided message unchanged.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Text to echo back' } },
      required: ['message'],
      additionalProperties: false
    }
  },
  {
    name: 'add',
    title: 'Add two numbers',
    description: 'Add two numbers and return the sum.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First addend' },
        b: { type: 'number', description: 'Second addend' }
      },
      required: ['a', 'b'],
      additionalProperties: false
    }
  }
];

const RESOURCES = [
  {
    uri: 'echo://greeting',
    name: 'greeting',
    title: 'Greeting',
    description: 'A static greeting from the echo server.',
    mimeType: 'text/plain'
  }
];

const PROMPTS = [
  {
    name: 'greet',
    title: 'Greeting prompt',
    description: 'Produce a short greeting for a named person.',
    arguments: [{ name: 'name', description: 'Person to greet', required: false }]
  }
];

/** @param {any} id @param {object} params */
function handleInitialize(id, params) {
  const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION;
  log(`initialize: client=${params?.clientInfo?.name || 'unknown'} protocol=${protocolVersion}`);
  reply(id, {
    protocolVersion,
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false }
    },
    serverInfo: SERVER_INFO,
    instructions: 'Example echo server: use the "echo" tool to repeat text and "add" to sum two numbers.'
  });
}

/** @param {any} name @param {object} args */
function handleToolCall(name, args) {
  const input = args && typeof args === 'object' ? args : {};
  if (name === 'echo') {
    if (typeof input.message !== 'string') {
      return {
        content: [{ type: 'text', text: 'echo: "message" (string) parametri kerak.' }],
        isError: true
      };
    }
    return {
      content: [
        { type: 'text', text: input.message },
        { type: 'text', text: `len=${input.message.length}` }
      ],
      isError: false
    };
  }
  if (name === 'add') {
    const a = Number(input.a);
    const b = Number(input.b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return {
        content: [{ type: 'text', text: 'add: "a" va "b" son bo‘lishi kerak.' }],
        isError: true
      };
    }
    return {
      content: [{ type: 'text', text: `${a + b}` }],
      structuredContent: { sum: a + b },
      isError: false
    };
  }
  return { content: [{ type: 'text', text: `Noma’lum tool: ${name}` }], isError: true };
}

/** @param {any} id @param {string} method @param {object} params */
function handleRequest(id, method, params) {
  switch (method) {
    case 'initialize':
      return handleInitialize(id, params);
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      if (typeof name !== 'string' || !name) {
        return replyError(id, -32602, 'Invalid params: "name" required');
      }
      const result = handleToolCall(name, params?.arguments);
      return reply(id, result);
    }
    case 'resources/list':
      return reply(id, { resources: RESOURCES });
    case 'resources/templates/list':
      return reply(id, { resourceTemplates: [] });
    case 'resources/read': {
      const uri = params?.uri;
      if (uri !== 'echo://greeting') {
        return replyError(id, -32602, `Resource topilmadi: ${String(uri)}`);
      }
      return reply(id, {
        contents: [{ uri, mimeType: 'text/plain', text: 'Hello from the CodeBase MCP echo server!' }]
      });
    }
    case 'prompts/list':
      return reply(id, { prompts: PROMPTS });
    case 'prompts/get': {
      const name = params?.name;
      if (name !== 'greet') {
        return replyError(id, -32602, `Prompt topilmadi: ${String(name)}`);
      }
      const who = typeof params?.arguments?.name === 'string' && params.arguments.name
        ? params.arguments.name
        : 'world';
      return reply(id, {
        description: 'Short greeting prompt',
        messages: [{ role: 'user', content: { type: 'text', text: `Please greet ${who} warmly in one sentence.` } }]
      });
    }
    case 'completion/complete':
      return replyError(id, -32601, 'Method not found');
    default:
      return replyError(id, -32601, 'Method not found');
  }
}

/** @param {any} message */
function handleMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  if (message.id === undefined || message.id === null) {
    // Notification: no response is allowed.
    if (typeof message.method === 'string') log(`notification: ${message.method}`);
    return;
  }
  if (typeof message.method !== 'string') {
    replyError(message.id, -32600, 'Invalid Request');
    return;
  }
  try {
    handleRequest(message.id, message.method, message.params || {});
  } catch (error) {
    log(`handler xatosi (${message.method}): ${error?.stack || error}`);
    replyError(message.id, -32603, `Internal error: ${error?.message || String(error)}`);
  }
}

/** @param {string} line */
function handleLine(line) {
  const text = line.replace(/\r$/, '').trim();
  if (!text) return; // tolerate CRLF and blank lines
  if (/^content-length:/i.test(text)) return; // tolerate stray LSP framing headers
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    log(`JSON parse xatosi: ${text.slice(0, 120)}`);
    replyError(null, -32700, 'Parse error');
    return;
  }
  handleMessage(message);
}

let buffer = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  if (buffer.length > MAX_LINE_CHARS) {
    log('kirish bufer limiti oshdi, tashlandi');
    buffer = '';
    return;
  }
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handleLine(line);
    index = buffer.indexOf('\n');
  }
});

process.stdin.on('end', () => {
  if (buffer.trim()) {
    handleLine(buffer);
    buffer = '';
  }
  log('stdin yopildi — chiqilmoqda');
  process.exit(0);
});

process.stdin.on('error', (error) => {
  log(`stdin xatosi: ${error?.message || error}`);
  process.exit(0);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

log(`tayyor (pid ${process.pid}) — stdio JSON-RPC 2.0`);
