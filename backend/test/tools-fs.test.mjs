import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-tools-data-'));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-tools-root-'));

process.env.CODEBASE_DATA_DIR = dataDir;
process.env.CODEBASE_LOG = 'error';

const paths = await import('../src/lib/paths.js');
paths.setRoots([root]);

const { fsRead, fsWrite, fsPatch, fsList, fsStat, fsMkdir, fsMove, fsDelete } = await import('../src/agent/tools/fs.js');
const { searchText, searchFiles, searchTree } = await import('../src/agent/tools/search.js');

const ctx = {
  projectRoot: root,
  roots: [root],
  emit: () => {},
  signal: undefined,
  config: {},
  store: { memories: [], skills: [] }
};

async function seed() {
  await fs.mkdir(path.join(root, 'src', 'util'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'index.js'), 'export const hello = () => "salom";\nconst unused = 1;\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'util', 'math.js'), 'export const add = (a, b) => a + b;\n', 'utf8');
  await fs.writeFile(path.join(root, 'README.md'), '# Test loyiha\n\nBu test uchun.\n', 'utf8');
}

await seed();

test('fs.read faylni qator raqamlari bilan o‘qiydi', async () => {
  const result = await fsRead.run({ path: 'src/index.js' }, ctx);
  assert.equal(result.ok, true);
  assert.match(result.content, /1\texport const hello/);
  assert.equal(result.data.lines, 3);
});

test('fs.read offset va limit bilan ishlaydi', async () => {
  const result = await fsRead.run({ path: 'src/index.js', offset: 2, limit: 1 }, ctx);
  assert.equal(result.ok, true);
  assert.match(result.content, /2\tconst unused/);
  assert.equal(result.data.truncated, true);
});

test('fs.read yo‘q faylda xato qaytaradi', async () => {
  const result = await fsRead.run({ path: 'yoq.js' }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.error, /topilmadi/i);
});

test('fs.write yangi fayl yaratadi va papkani ochadi', async () => {
  const result = await fsWrite.run({ path: 'src/deep/new/file.js', content: 'export default 42;\n' }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.data.created, true);
  const written = await fs.readFile(path.join(root, 'src', 'deep', 'new', 'file.js'), 'utf8');
  assert.equal(written, 'export default 42;\n');
});

test('fs.write mavjud faylni almashtiradi', async () => {
  const result = await fsWrite.run({ path: 'README.md', content: 'yangi kontent\n' }, ctx);
  assert.equal(result.data.created, false);
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'yangi kontent\n');
});

test('fs.patch aniq qismni almashtiradi', async () => {
  const result = await fsPatch.run({ path: 'src/util/math.js', find: 'a + b', replace: 'a - b' }, ctx);
  assert.equal(result.ok, true);
  assert.match(await fs.readFile(path.join(root, 'src', 'util', 'math.js'), 'utf8'), /a - b/);
});

test('fs.patch topilmasa faylga tegmaydi', async () => {
  const before = await fs.readFile(path.join(root, 'src', 'util', 'math.js'), 'utf8');
  const result = await fsPatch.run({ path: 'src/util/math.js', find: 'bu matn yoq', replace: 'x' }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.error, /qo‘llanmadi/);
  assert.equal(await fs.readFile(path.join(root, 'src', 'util', 'math.js'), 'utf8'), before);
});

test('fs.patch ko‘p tahrirli rejim (all bilan)', async () => {
  await fsWrite.run({ path: 'multi.txt', content: 'a\nb\na\nb\na\n' }, ctx);
  const result = await fsPatch.run({ path: 'multi.txt', edits: [{ find: 'a', replace: 'A', all: true }] }, ctx);
  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(path.join(root, 'multi.txt'), 'utf8'), 'A\nb\nA\nb\nA\n');
});

test('fs.list papka mazmunini ko‘rsatadi', async () => {
  const result = await fsList.run({ path: 'src', depth: 2 }, ctx);
  assert.equal(result.ok, true);
  assert.match(result.content, /index\.js/);
  assert.match(result.content, /util\//);
});

test('fs.stat mavjud va yo‘q yo‘lni ajratadi', async () => {
  const exists = await fsStat.run({ path: 'src/index.js' }, ctx);
  assert.equal(exists.data.exists, true);
  const missing = await fsStat.run({ path: 'yoq.txt' }, ctx);
  assert.equal(missing.data.exists, false);
});

test('fs.mkdir, fs.move va fs.delete', async () => {
  assert.equal((await fsMkdir.run({ path: 'yangi/papka' }, ctx)).ok, true);
  assert.equal((await fsMove.run({ from: 'multi.txt', to: 'yangi/papka/multi.txt' }, ctx)).ok, true);
  assert.equal((await fsStat.run({ path: 'yangi/papka/multi.txt' }, ctx)).data.exists, true);
  assert.equal((await fsDelete.run({ path: 'yangi/papka/multi.txt' }, ctx)).ok, true);
  assert.equal((await fsStat.run({ path: 'yangi/papka/multi.txt' }, ctx)).data.exists, false);
});

test('fs.delete bo‘sh bo‘lmagan papkani recursive bo‘lmasa rad etadi', async () => {
  const result = await fsDelete.run({ path: 'src/util' }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.error, /recursive/);
});

test('fs tool’lari workspace tashqarisiga chiqa olmaydi', async () => {
  await assert.rejects(async () => fsRead.run({ path: '../../etc/passwd' }, ctx));
  await assert.rejects(async () => fsWrite.run({ path: path.join(os.tmpdir(), 'tashqari.txt'), content: 'x' }, ctx));
});

test('search.text mosliklarni qaytaradi', async () => {
  const result = await searchText.run({ query: 'add' }, ctx);
  assert.equal(result.ok, true);
  assert.match(result.content, /src\/util\/math\.js:1/);
});

test('search.text regex rejimi', async () => {
  const result = await searchText.run({ query: 'export\\s+const', regex: true }, ctx);
  assert.equal(result.ok, true);
  assert.ok(result.data.matches >= 2);
});

test('search.text topilmasa NO MATCHES qaytaradi', async () => {
  const result = await searchText.run({ query: 'zzz-bu-yoq-zzz' }, ctx);
  assert.equal(result.data.matches, 0);
  assert.match(result.content, /NO MATCHES/);
});

test('search.files nom bo‘yicha topadi', async () => {
  const result = await searchFiles.run({ pattern: '*.js' }, ctx);
  assert.equal(result.ok, true);
  assert.match(result.content, /index\.js/);
});

test('search.tree daraxt chiqaradi', async () => {
  const result = await searchTree.run({ depth: 3 }, ctx);
  assert.equal(result.ok, true);
  assert.match(result.content, /src\//);
  assert.match(result.content, /README\.md/);
});

test('search node_modules va .git ni o‘tkazib yuboradi', async () => {
  await fs.mkdir(path.join(root, 'node_modules', 'paket'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'paket', 'index.js'), 'export const add = 1;\n', 'utf8');
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.writeFile(path.join(root, '.git', 'config'), 'add = 1\n', 'utf8');

  const result = await searchText.run({ query: 'add' }, ctx);
  assert.ok(!result.content.includes('node_modules'), 'node_modules skanerlanmasligi kerak');
  assert.ok(!result.content.includes('.git/'), '.git skanerlanmasligi kerak');
});
