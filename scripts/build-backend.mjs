import { build } from 'esbuild';
import { mkdir, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * Bundle the backend into a single ESM file so the packaged app does not need a
 * node_modules folder next to it. Node built-ins stay external on purpose, and a
 * native `require` shim keeps CommonJS dependencies (Express and friends) working
 * inside the ESM bundle.
 */
await mkdir('backend/dist', { recursive: true });

const result = await build({
  entryPoints: ['backend/src/server.js'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'backend/dist/server.mjs',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  banner: {
    js: [
      "import { createRequire } from 'node:module';",
      "import { fileURLToPath as __codebaseFileURLToPath } from 'node:url';",
      "import { dirname as __codebaseDirname } from 'node:path';",
      'const require = createRequire(import.meta.url);',
      'const __filename = __codebaseFileURLToPath(import.meta.url);',
      'const __dirname = __codebaseDirname(__filename);'
    ].join('\n')
  },
  logLevel: 'info',
  metafile: true
});

const outputs = Object.entries(result.metafile.outputs)[0];
console.log(
  `Backend bundle created: ${outputs?.[0] || 'backend/dist/server.mjs'} (${Math.round((outputs?.[1]?.bytes || 0) / 1024)} KB)`
);

// The bundle is a single file, so the builtin skills and the example MCP server /
// plugin have to be copied next to it (they are read from disk at runtime).
await rm('backend/dist/skills', { recursive: true, force: true });
if (existsSync('backend/src/skills/builtin')) {
  await mkdir('backend/dist/skills', { recursive: true });
  await cp('backend/src/skills/builtin', 'backend/dist/skills/builtin', { recursive: true });
  console.log('Builtin skills copied to backend/dist/skills/builtin');
}

if (existsSync('backend/examples')) {
  await rm('backend/dist/examples', { recursive: true, force: true });
  await cp('backend/examples', 'backend/dist/examples', { recursive: true });
  console.log('Examples copied to backend/dist/examples');
}
