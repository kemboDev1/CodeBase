/**
 * Renderer smoke test.
 *
 * A blank Electron window almost always means the renderer threw during render, and that
 * error is invisible from the main process. This script renders the React tree in Node —
 * the app shell and every page — so a crash on first paint fails a fast, headless check
 * instead of shipping as a black window.
 *
 * Usage: node scripts/ssr-check.mjs
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = process.cwd();
// The bundle lives inside frontend/ so Node resolves react/react-dom from its node_modules.
const workDir = path.join(root, 'frontend', '.ssr-check');
await fs.mkdir(workDir, { recursive: true });
const outFile = path.join(workDir, 'bundle.mjs');

const PAGES = [
  ['Chat', './src/pages/Chat.jsx'],
  ['Files', './src/pages/Files.jsx'],
  ['Terminal', './src/pages/Terminal.jsx'],
  ['Mcp', './src/pages/Mcp.jsx'],
  ['Plugins', './src/pages/Plugins.jsx'],
  ['Skills', './src/pages/Skills.jsx'],
  ['Memory', './src/pages/Memory.jsx'],
  ['Projects', './src/pages/Projects.jsx'],
  ['Settings', './src/pages/Settings.jsx']
];

await fs.writeFile(
  path.join(root, 'frontend', '.ssr-entry.jsx'),
  [
    "import React from 'react';",
    "import { renderToString } from 'react-dom/server';",
    "import { AppProvider } from './src/state/AppContext.jsx';",
    "import App from './src/App.jsx';",
    PAGES.map(([, file], index) => `import Page${index} from '${file}';`).join('\n'),
    '',
    `const pages = ${JSON.stringify(PAGES.map(([name]) => name))};`,
    'const components = [' + PAGES.map((_, index) => `Page${index}`).join(', ') + '];',
    'let failures = 0;',
    '',
    'function attempt(label, element) {',
    '  try {',
    '    const html = renderToString(element);',
    '    if (!html) throw new Error("bo‘sh HTML");',
    '    console.log(`OK   ${label} (${html.length} belgi)`);',
    '  } catch (error) {',
    '    failures += 1;',
    '    console.error(`FAIL ${label}: ${error && error.message}`);',
    '    const frame = String((error && error.stack) || "").split("\\n").find((line) => line.includes("frontend") && line.includes(".jsx"));',
    '    if (frame) console.error(`     ${frame.trim()}`);',
    '  }',
    '}',
    '',
    'attempt("App shell", React.createElement(AppProvider, null, React.createElement(App)));',
    'for (let i = 0; i < pages.length; i += 1) {',
    '  attempt(`sahifa: ${pages[i]}`, React.createElement(AppProvider, null, React.createElement(components[i])));',
    '}',
    '',
    'if (failures) {',
    '  console.error(`\\n${failures} ta render xatosi — ilova oq ekran/qora ekran beradi.`);',
    '  process.exit(1);',
    '}',
    'console.log("\\nBarcha sahifalar render bo‘ldi.");'
  ].join('\n'),
  'utf8'
);

await build({
  entryPoints: [path.join(root, 'frontend', '.ssr-entry.jsx')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: outFile,
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  // Keep React and the icon library external: their CommonJS builds cannot be bundled
  // into ESM (they `require('react')` at runtime).
  external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime', 'lucide-react'],
  logLevel: 'warning'
});

// Minimal browser globals: the API client resolves its base URL/token defensively.
globalThis.window = {
  location: { search: '', origin: 'http://127.0.0.1:1', href: 'http://127.0.0.1:1/' },
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
};
globalThis.document = { addEventListener() {}, removeEventListener() {}, documentElement: { style: {} }, body: { style: {} } };
globalThis.localStorage = globalThis.window.localStorage;
// Node 24 already provides a read-only `navigator`, so it is not stubbed here.
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });

await import(pathToFileURL(outFile).href);
await fs.rm(workDir, { recursive: true, force: true });
await fs.rm(path.join(root, 'frontend', '.ssr-entry.jsx'), { force: true });
