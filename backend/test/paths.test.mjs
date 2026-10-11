import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-paths-data-'));
const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-root-a-'));
const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-root-b-'));

process.env.CODEBASE_DATA_DIR = dataDir;
process.env.CODEBASE_LOG = 'error';

const paths = await import('../src/lib/paths.js');
paths.setRoots([rootA, rootB]);

await fs.mkdir(path.join(rootA, 'src'), { recursive: true });
await fs.writeFile(path.join(rootA, 'src', 'index.js'), 'console.log(1)', 'utf8');

test('roots ro‘yxati saqlanadi', () => {
  assert.equal(paths.getRoots().length, 2);
  paths.setRoots([rootA, rootA, rootB]);
  assert.equal(paths.getRoots().length, 2, 'takroriy root tushib qolishi kerak');
});

test('root ichidagi yo‘l ruxsat etiladi', () => {
  const target = paths.resolveInside(rootA, 'src/index.js');
  assert.equal(target, path.join(rootA, 'src', 'index.js'));
  assert.ok(paths.isInsideAny(target));
});

test('nisbiy yo‘l root bo‘yicha yechiladi', () => {
  const target = paths.resolveInside(rootB, 'a/b/c.txt');
  assert.equal(target, path.join(rootB, 'a', 'b', 'c.txt'));
});

test('root ichida qoladigan .. ruxsat etiladi', () => {
  const target = paths.resolveInside(rootA, 'src/../src/index.js');
  assert.equal(target, path.join(rootA, 'src', 'index.js'));
});

test('root tashqarisiga chiqish bloklanadi', () => {
  assert.throws(() => paths.resolveInside(rootA, '../escape.txt'), /Ruxsat etilmagan/);
  assert.throws(() => paths.resolveInside(rootA, '..\\..\\escape.txt'), /Ruxsat etilmagan/);
});

test('absolyut yo‘l root tashqarisida bo‘lsa bloklanadi', () => {
  const outside = path.join(os.tmpdir(), 'codebase-outside-file.txt');
  assert.throws(() => paths.resolveInside(rootA, outside), /Ruxsat etilmagan/);
  assert.throws(() => paths.assertInside(outside), /Ruxsat etilmagan/);
});

test('Windows tizim papkalari bloklanadi', { skip: process.platform !== 'win32' }, () => {
  assert.throws(() => paths.resolveInside(rootA, 'C:\\Windows\\System32\\drivers\\etc\\hosts'), /Ruxsat etilmagan/);
});

test('nuqta va bo‘sh yo‘l', () => {
  assert.equal(paths.resolveInside(rootA, '.'), path.resolve(rootA));
  assert.throws(() => paths.resolveInside(rootA, '   '), /bo‘sh yo‘l|Bo‘sh/i);
});

test('NUL belgisi rad etiladi', () => {
  assert.throws(() => paths.resolveInside(rootA, 'src/\0evil.js'), /noto‘g‘ri belgi/);
});

test('toRel rootga nisbatan nisbiy yo‘l qaytaradi', () => {
  assert.equal(paths.toRel(path.join(rootA, 'src', 'index.js')), 'src/index.js');
  assert.equal(paths.toRel(rootA), '.');
});

test('roots bo‘sh bo‘lsa hamma yo‘l bloklanadi', () => {
  paths.setRoots([]);
  assert.throws(() => paths.resolveInside(null, 'x.txt'), /Workspace papka/);
  paths.setRoots([rootA, rootB]);
});

test('ignored papkalar ro‘yxati mavjud', () => {
  assert.ok(paths.ignoredDir('node_modules'));
  assert.ok(paths.ignoredDir('.git'));
  assert.ok(!paths.ignoredDir('src'));
});
