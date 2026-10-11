import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import child from 'node:child_process';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-store-'));
process.env.CODEBASE_DATA_DIR = dataDir;
process.env.CODEBASE_LOG = 'error';
process.env.CODEBASE_PORT = '0';

// A v1 store, exactly like the one shipped by the old CodeBase build.
const legacy = {
  version: 1,
  projects: [
    {
      id: 'general',
      name: 'General',
      description: 'legacy',
      instructions: 'legacy instructions',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      messages: [
        { id: 'msg1', role: 'user', content: 'Salom', createdAt: '2026-01-01T00:00:01.000Z' },
        { id: 'msg2', role: 'assistant', content: 'Salom!', createdAt: '2026-01-01T00:00:02.000Z' }
      ]
    }
  ],
  memories: [{ id: 'mem1', content: 'Men Luau ishlataman', createdAt: '2026-01-01T00:00:00.000Z' }],
  skills: [{ id: 'skill1', name: 'Roblox', description: 'd', content: 'c', enabled: true, createdAt: '2026-01-01T00:00:00.000Z' }],
  settings: { model: 'qwen2.5-coder:7b' }
};

await fs.writeFile(path.join(dataDir, 'store.json'), JSON.stringify(legacy, null, 2), 'utf8');

const store = await import('../src/store.js');

test('v1 store migratsiya qilinadi (messages → sessions)', async () => {
  const state = await store.getStore();
  assert.equal(state.version, 2);
  assert.equal(state.projects.length, 1);

  const project = state.projects[0];
  assert.equal(project.id, 'general');
  assert.equal(project.messages, undefined, 'eski messages maydoni qolmasligi kerak');
  assert.equal(project.sessions.length, 1);
  assert.equal(project.activeSessionId, project.sessions[0].id);
  assert.equal(project.sessions[0].messages.length, 2);
  assert.equal(project.sessions[0].messages[0].content, 'Salom');
  assert.equal(project.root, null);
});

test('yangi maydonlar seed qilinadi', async () => {
  const state = await store.getStore();
  assert.deepEqual(state.mcpServers, []);
  assert.deepEqual(state.plugins, []);
  assert.deepEqual(state.toolPolicies, {});
  assert.deepEqual(state.pathRules, []);
  assert.deepEqual(state.audit, []);
  assert.equal(state.settings.model, 'qwen2.5-coder:7b');
  assert.equal(state.settings.mode, 'auto');
  assert.equal(state.settings.autoApproveReads, true);
  assert.equal(state.memories.length, 1);
  assert.equal(state.skills.length, 1);
});

test('migratsiyadan oldin backup olinadi', async () => {
  const backups = await fs.readdir(path.join(dataDir, 'backups'));
  assert.ok(backups.some((file) => file.includes('pre-v2')), `backup topilmadi: ${backups.join(', ')}`);
});

test('saveStore atomik yozadi (tmp fayl qolmaydi)', async () => {
  const state = await store.getStore();
  state.settings.temperature = 0.5;
  await store.saveStore();

  const raw = await fs.readFile(path.join(dataDir, 'store.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.settings.temperature, 0.5);

  const files = await fs.readdir(dataDir);
  assert.ok(!files.some((file) => file.endsWith('.tmp')), 'vaqtinchalik fayl qolmasligi kerak');
});

test('recordAudit ring buffer 500 tada to‘xtaydi', async () => {
  const state = await store.getStore();
  for (let i = 0; i < 520; i += 1) {
    store.recordAudit({ tool: 'fs.read', decision: 'allow', ok: true, ms: i });
  }
  assert.equal(state.audit.length, 500);
  assert.equal(state.audit[0].tool, 'fs.read');
});

test('session yordamchilari ishlaydi', async () => {
  const state = await store.getStore();
  const project = state.projects[0];
  const session = store.createSession(project, 'Test suhbat');
  assert.equal(project.activeSessionId, session.id);
  assert.equal(project.sessions.length, 2);

  const found = store.findSession(project, session.id);
  assert.equal(found.id, session.id);
  assert.throws(() => store.findSession(project, 'yoq-session'));

  const summary = store.projectSummary(project);
  assert.equal(summary.messageCount, 2);
  assert.equal(summary.sessionCount, 2);
});

test('buzilgan store.json qayta tiklanadi', async () => {
  const brokenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-broken-'));
  const scriptPath = path.join(brokenDir, 'probe.mjs');
  const outFile = path.join(brokenDir, 'probe-output.json');
  const storeUrl = new URL('../src/store.js', import.meta.url).href;

  await fs.writeFile(
    scriptPath,
    [
      `import fs from 'node:fs/promises';`,
      `import path from 'node:path';`,
      `await fs.writeFile(path.join(${JSON.stringify(brokenDir)}, 'store.json'), '{ this is not json');`,
      `const store = await import(${JSON.stringify(storeUrl)});`,
      `const state = await store.getStore();`,
      `await fs.writeFile(${JSON.stringify(outFile)}, JSON.stringify({ version: state.version, projects: state.projects.length }));`
    ].join('\n'),
    'utf8'
  );

  // stdio:'ignore' is deliberate: some sandboxes reject piped stdio for child processes.
  const result = child.spawnSync(process.execPath, [scriptPath], {
    stdio: 'ignore',
    env: { ...process.env, CODEBASE_DATA_DIR: brokenDir, CODEBASE_LOG: 'error' }
  });
  assert.equal(result.status, 0, `probe jarayoni xato bilan tugadi: ${result.status} ${result.error?.code || ''}`);

  const parsed = JSON.parse(await fs.readFile(outFile, 'utf8'));
  assert.equal(parsed.version, 2);
  assert.equal(parsed.projects, 1);

  const files = await fs.readdir(brokenDir);
  assert.ok(files.some((file) => file.startsWith('store.corrupt-')), 'buzilgan fayl nusxasi saqlanishi kerak');
});
