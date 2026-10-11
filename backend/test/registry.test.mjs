import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-registry-'));
process.env.CODEBASE_DATA_DIR = dataDir;
process.env.CODEBASE_LOG = 'error';

const { createRegistry, validateArgs } = await import('../src/agent/registry.js');
const { createPermissions } = await import('../src/agent/permissions.js');

function makeStore(overrides = {}) {
  return {
    toolPolicies: {},
    pathRules: [],
    settings: { autoApproveReads: true },
    audit: [],
    ...overrides
  };
}

/** Poll until `predicate()` is truthy (fixed sleeps are flaky on loaded CI runners). */
async function waitFor(predicate, timeoutMs = 10_000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

function makeTool(overrides = {}) {
  return {
    name: 'test.read',
    title: 'Test read',
    description: 'reads something',
    category: 'filesystem',
    defaultPolicy: 'allow',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, limit: { type: 'integer' }, flag: { type: 'boolean' } },
      required: ['path']
    },
    run: async (args) => ({ ok: true, summary: `read ${args.path}`, content: `content:${args.path}:${args.limit ?? '-'}` }),
    ...overrides
  };
}

test('validateArgs: majburiy maydon va tur majburlash', () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string' }, limit: { type: 'integer' }, flag: { type: 'boolean' } },
    required: ['path']
  };
  assert.equal(validateArgs(schema, {}).ok, false);
  assert.equal(validateArgs(schema, { path: '' }).ok, false);

  const coerced = validateArgs(schema, { path: 'a.js', limit: '5', flag: 'true', extra: 'drop me' });
  assert.equal(coerced.ok, true);
  assert.equal(coerced.value.limit, 5);
  assert.equal(coerced.value.flag, true);
  assert.equal(coerced.value.extra, undefined, 'noma’lum maydon tashlab yuborilishi kerak');
});

test('registry: register/list/toOllamaTools', () => {
  const registry = createRegistry({});
  registry.register(makeTool());
  assert.equal(registry.size(), 1);
  assert.ok(registry.get('test.read'));

  const list = registry.list();
  assert.equal(list[0].name, 'test.read');
  assert.equal(list[0].policy, 'allow');

  const tools = registry.toOllamaTools();
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].function.name, 'test.read');
  assert.ok(tools[0].function.parameters.properties.path);

  // duplicate registration must not explode
  registry.register(makeTool());
  assert.equal(registry.size(), 1);

  assert.equal(registry.unregister('test.read'), true);
  assert.equal(registry.size(), 0);
});

test('registry: icra natijasi va audit', async () => {
  const store = await (await import('../src/store.js')).getStore();
  const registry = createRegistry({});
  registry.register(makeTool());
  const events = [];
  const permissions = createPermissions({ store, emit: (event) => events.push(event) });

  const result = await registry.execute('test.read', { path: 'a.js' }, {
    permissions, emit: () => {}, sessionId: 's1', projectId: 'p1'
  });
  assert.equal(result.ok, true);
  assert.match(result.content, /content:a\.js/);
  assert.equal(store.audit[0].tool, 'test.read');
  assert.equal(store.audit[0].ok, true);
  assert.equal(events.length, 0, 'allow siyosatida ruxsat so‘ralmasligi kerak');
});

test('registry: noma’lum tool xato qaytaradi (throw emas)', async () => {
  const registry = createRegistry({});
  const result = await registry.execute('yoq.tool', {}, { emit: () => {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /Noma’lum tool/);
});

test('registry: majburiy parametr yo‘q bo‘lsa xato', async () => {
  const registry = createRegistry({});
  registry.register(makeTool());
  const result = await registry.execute('test.read', {}, { emit: () => {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /Majburiy parametr/);
});

test('permissions: ask siyosati rad etilsa tool ishlamaydi', async () => {
  const store = await (await import('../src/store.js')).getStore();
  store.toolPolicies = {};
  const events = [];
  const permissions = createPermissions({ store, emit: (event) => events.push(event) });
  const registry = createRegistry({});
  let ran = false;
  registry.register(makeTool({ name: 'test.write', defaultPolicy: 'ask', run: async () => { ran = true; return { ok: true, content: 'x' }; } }));

  const pending = registry.execute('test.write', { path: 'a.js' }, { permissions, emit: () => {}, sessionId: 's1' });
  await waitFor(() => events.find((event) => event.type === 'permission_request'));

  const request = events.find((event) => event.type === 'permission_request');
  assert.ok(request, 'permission_request eventi yuborilishi kerak');
  assert.equal(request.tool, 'test.write');

  permissions.resolve(request.id, { approved: false });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /ruxsat bermadi/i);
  assert.equal(ran, false, 'rad etilgandan keyin tool ishlamasligi kerak');
});

test('permissions: tasdiqlansa tool ishlaydi va session grant saqlanadi', async () => {
  const store = await (await import('../src/store.js')).getStore();
  store.toolPolicies = {};
  const events = [];
  const permissions = createPermissions({ store, emit: (event) => events.push(event) });
  const registry = createRegistry({});
  let calls = 0;
  registry.register(makeTool({ name: 'test.patch', defaultPolicy: 'ask', run: async () => { calls += 1; return { ok: true, content: 'patched' }; } }));

  const first = registry.execute('test.patch', { path: 'a.js' }, { permissions, emit: () => {}, sessionId: 'session-42' });
  await waitFor(() => events.find((event) => event.type === 'permission_request'));
  const request = events.find((event) => event.type === 'permission_request');
  assert.ok(request, 'permission_request eventi yuborilishi kerak');
  permissions.grantSession('session-42', 'test.patch');
  permissions.resolve(request.id, { approved: true, remember: 'session' });
  assert.equal((await first).ok, true);

  const second = await registry.execute('test.patch', { path: 'b.js' }, { permissions, emit: () => {}, sessionId: 'session-42' });
  assert.equal(second.ok, true, 'session grantidan keyin qayta so‘ralmasligi kerak');
  assert.equal(calls, 2);
});

test('permissions: deny siyosati darhol bloklaydi', async () => {
  const store = await (await import('../src/store.js')).getStore();
  store.toolPolicies = { 'test.delete': 'deny' };
  const permissions = createPermissions({ store, emit: () => {} });
  const registry = createRegistry({});
  let ran = false;
  registry.register(makeTool({ name: 'test.delete', defaultPolicy: 'ask', run: async () => { ran = true; return { ok: true, content: 'deleted' }; } }));

  const result = await registry.execute('test.delete', { path: 'a.js' }, { permissions, emit: () => {}, sessionId: 's1' });
  assert.equal(result.ok, false);
  assert.match(result.error, /taqiqlangan/);
  assert.equal(ran, false);
  store.toolPolicies = {};
});

test('permissions: path rule tool siyosatidan ustun', async () => {
  const store = await (await import('../src/store.js')).getStore();
  store.toolPolicies = {};
  store.pathRules = [{ pattern: '**/secrets/*', policy: 'deny' }];
  const permissions = createPermissions({ store, emit: () => {} });
  const tool = makeTool({ name: 'test.secret', defaultPolicy: 'allow' });

  assert.equal(permissions.policyFor(tool, { path: 'config/secrets/token.txt' }), 'deny');
  assert.equal(permissions.policyFor(tool, { path: 'src/index.js' }), 'allow');
  store.pathRules = [];
});

test('permissions: tool run xatosi ushlanadi', async () => {
  const store = await (await import('../src/store.js')).getStore();
  const permissions = createPermissions({ store, emit: () => {} });
  const registry = createRegistry({});
  registry.register(makeTool({ name: 'test.boom', run: async () => { throw new Error('portlash'); } }));
  const result = await registry.execute('test.boom', { path: 'a.js' }, { permissions, emit: () => {}, sessionId: 's1' });
  assert.equal(result.ok, false);
  assert.match(result.error, /portlash/);
});

void fs;
void path;
