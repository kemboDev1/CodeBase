/**
 * CodeBase Agent — environment verifier.
 *
 * Checks that everything the agent needs is present before the user starts a build
 * or opens the desktop app: Node, dependencies, build artifacts, Ollama, models.
 *
 * Usage: npm run verify
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rows = [];
let problems = 0;

function row(label, ok, detail = '', warnOnly = false) {
  if (!ok && !warnOnly) problems += 1;
  rows.push({ label, ok, detail, warnOnly });
}

const exists = (relative) => fs.existsSync(path.join(root, relative));
const readJson = (relative) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
  } catch {
    return null;
  }
};

// Node
const nodeMajor = Number(process.versions.node.split('.')[0]);
row('Node.js >= 20', nodeMajor >= 20, `v${process.versions.node}`);

// Dependencies
row('backend dependencies (express)', exists('backend/node_modules/express'));
row('frontend dependencies (vite)', exists('frontend/node_modules/vite'));
row('esbuild (bundler)', exists('node_modules/esbuild'), exists('node_modules/esbuild') ? '' : 'npm install');
row('electron (desktop shell)', exists('node_modules/electron'), exists('node_modules/electron') ? '' : 'npm install', true);
row(
  'electron binary (dist/electron.exe)',
  exists('node_modules/electron/dist/electron.exe') || process.platform !== 'win32',
  'npm install skriptlari ishlamagan bo‘lsa: node node_modules/electron/install.js',
  true
);

// Build artifacts
row('backend bundle (backend/dist/server.mjs)', exists('backend/dist/server.mjs'), 'npm run build:backend');
row('builtin skills (backend/dist/skills/builtin)', exists('backend/dist/skills/builtin'), 'npm run build:backend');
row('frontend build (frontend/dist/index.html)', exists('frontend/dist/index.html'), 'npm run build');

// Manifests
const rootPkg = readJson('package.json');
const backendPkg = readJson('backend/package.json');
const frontendPkg = readJson('frontend/package.json');
row('package.json manifests', Boolean(rootPkg && backendPkg && frontendPkg));
row(
  'versions aligned',
  Boolean(rootPkg && backendPkg && frontendPkg && rootPkg.version === backendPkg.version && rootPkg.version === frontendPkg.version),
  rootPkg ? `root ${rootPkg.version} / backend ${backendPkg?.version} / frontend ${frontendPkg?.version}` : ''
);

// Ollama
let ollamaExe = '';
const candidates = [
  process.env.OLLAMA_EXE,
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama app.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
  '/usr/local/bin/ollama',
  '/usr/bin/ollama'
].filter(Boolean);
for (const candidate of candidates) {
  if (fs.existsSync(candidate)) {
    ollamaExe = candidate;
    break;
  }
}
row('Ollama o‘rnatilgan', Boolean(ollamaExe), ollamaExe || 'https://ollama.com/download', !ollamaExe);

let models = [];
let connected = false;
try {
  const output = execFileSync(process.env.OLLAMA_EXE || ollamaExe || 'ollama', ['list'], { encoding: 'utf8', timeout: 10_000 });
  models = output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
  connected = true;
} catch {
  connected = false;
}
row('Ollama server ishlayapti', connected, connected ? `${models.length} model` : 'ollama app ni oching (CodeBase ham avtomatik ochadi)', true);
row('Kamida bitta model yuklangan', models.length > 0, models.slice(0, 5).join(', ') || 'ollama pull qwen2.5-coder:7b', true);

// Data dir
const dataDir = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'CodeBase', 'data');
row('Ma’lumot papkasi', true, dataDir, true);

const width = Math.max(...rows.map((item) => item.label.length));
console.log('\nCodeBase Agent — muhit tekshiruvi\n' + '─'.repeat(width + 20));
for (const item of rows) {
  const mark = item.ok ? '\u2714' : item.warnOnly ? '\u26a0' : '\u2716';
  console.log(`${mark} ${item.label.padEnd(width)}  ${item.detail}`);
}
console.log('─'.repeat(width + 20));
console.log(
  problems === 0
    ? 'Hammasi joyida. Ishga tushirish: npm run desktop  (yoki desktop ilovasi: npm run dist:win)'
    : `${problems} ta muammo topildi — yuqoridagi maslahatlarni bajaring.`
);
process.exit(problems === 0 ? 0 : 1);
