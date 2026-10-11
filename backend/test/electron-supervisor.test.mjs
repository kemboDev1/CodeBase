import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Supervisor } = require('../../electron/supervisor.cjs');

/**
 * Exercises the Electron supervisor without opening a window: a stub `app` provides
 * the paths, and the real backend is spawned as a child process — exactly what
 * electron/main.cjs does at startup.
 */
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-supervisor-'));
const quiet = { log() {}, warn() {}, error() {}, debug() {} };
const fakeApp = {
  isPackaged: false,
  getPath: () => tempDir,
  getVersion: () => '1.0.0'
};

const supervisor = new Supervisor({ app: fakeApp, isDev: true, logger: quiet });
const statuses = [];
supervisor.on('status', (status) => statuses.push(status));

let started = null;

test('supervisor backendni ishga tushiradi va haqiqiy portni aniqlaydi', async () => {
  started = await supervisor.start();
  assert.ok(started.port > 0, 'port aniqlanmadi');
  assert.match(started.apiBase, /^http:\/\/127\.0\.0\.1:\d+\/api$/);
  assert.equal(supervisor.status.running, true);
  assert.ok(supervisor.token.length >= 24, 'token yaratilmadi');
  assert.ok(statuses.some((status) => status.starting === true), 'starting holati yuborilmadi');
  assert.ok(statuses.some((status) => status.running === true), 'running holati yuborilmadi');
});

test('backend health endpointi javob beradi (token talab qilmaydi)', async () => {
  const response = await fetch(`http://127.0.0.1:${started.port}/api/health`);
  assert.equal(response.ok, true);
  const health = await response.json();
  assert.equal(health.service, 'CodeBase API');
  assert.equal(health.version, '1.0.0');
  assert.ok(Array.isArray(health.ollama.models));
});

test('token bilan API ishlaydi, tokensiz 401', async () => {
  const authed = await fetch(`http://127.0.0.1:${started.port}/api/system/info`, {
    headers: { 'X-CodeBase-Token': supervisor.token }
  });
  assert.equal(authed.ok, true);
  const info = await authed.json();
  assert.equal(info.port, started.port);
  assert.ok(info.roots.length >= 1, 'workspace root standart papkasi yaratilishi kerak');

  const anonymous = await fetch(`http://127.0.0.1:${started.port}/api/system/info`);
  assert.equal(anonymous.status, 401);
});

test('supervisor API yordamchilari backend bilan gaplashadi', async () => {
  const settings = await supervisor.apiFetch('/settings');
  assert.ok(settings.settings.model);

  const tools = await supervisor.apiFetch('/tools');
  assert.ok(tools.tools.length >= 30);

  const ollama = await supervisor.ollamaStatus();
  assert.equal(typeof ollama.connected, 'boolean');

  const autostart = await supervisor.autostartEnabled();
  assert.equal(typeof autostart, 'boolean');
});

test('statik UI (frontend/dist) xizmat qilinadi', async () => {
  const response = await fetch(`http://127.0.0.1:${started.port}/`);
  assert.equal(response.ok, true);
  assert.match(await response.text(), /<div id="root">/);
});

test('stop() backend jarayonini o‘ldiradi', async () => {
  const port = started.port;
  await supervisor.stop();
  assert.equal(supervisor.status.running, false);
  await new Promise((resolve) => setTimeout(resolve, 600));
  await assert.rejects(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
    if (response.ok) throw new Error('backend hali ham javob bermoqda');
  });
});

test('restart() yangi port bilan qayta ishga tushiradi', async () => {
  const info = await supervisor.restart();
  assert.ok(info.port > 0);
  const response = await fetch(`http://127.0.0.1:${info.port}/api/health`);
  assert.equal(response.ok, true);
  await supervisor.stop();
});

test.after(async () => {
  await supervisor.stop().catch(() => {});
});
