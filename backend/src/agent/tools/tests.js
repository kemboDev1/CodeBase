import fs from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from '../../lib/shell.js';
import { oneLine, tail } from '../../lib/text.js';

const def = (name, title, description, defaultPolicy, parameters, run, extra = {}) => ({
  name, title, description, category: 'tests', defaultPolicy, parameters, run, source: 'core', ...extra
});

const TEST_SCRIPTS = ['test', 'test:unit', 'test:ci', 'vitest', 'jest'];

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function detect(cwd) {
  const found = [];
  const pkg = await readJson(path.join(cwd, 'package.json'));
  if (pkg?.scripts) {
    for (const name of TEST_SCRIPTS) {
      if (pkg.scripts[name]) {
        found.push({ runner: 'npm', command: `npm run ${name}`, label: `package.json → ${name}` });
        break;
      }
    }
    if (pkg.devDependencies?.vitest || pkg.dependencies?.vitest) found.push({ runner: 'vitest', command: 'npx vitest run', label: 'vitest' });
    if (pkg.devDependencies?.jest || pkg.dependencies?.jest) found.push({ runner: 'jest', command: 'npx jest', label: 'jest' });
  }
  const checks = [
    ['pytest.ini', 'pytest', 'python -m pytest -q'],
    ['pyproject.toml', 'pytest', 'python -m pytest -q'],
    ['go.mod', 'go', 'go test ./...'],
    ['Cargo.toml', 'cargo', 'cargo test'],
    ['pom.xml', 'maven', 'mvn -q test'],
    ['build.gradle', 'gradle', 'gradle test']
  ];
  for (const [file, runner, command] of checks) {
    try {
      await fs.access(path.join(cwd, file));
      if (file === 'pyproject.toml') {
        const text = await fs.readFile(path.join(cwd, file), 'utf8');
        if (!/pytest|tool\.pytest/.test(text)) continue;
      }
      found.push({ runner, command, label: file });
    } catch {
      /* not present */
    }
  }
  return found;
}

export const testsDetect = def(
  'tests.detect',
  'Detect test setup',
  'Inspect the project and report which test command should be used.',
  'allow',
  { type: 'object', properties: {}, required: [] },
  async (_args, ctx) => {
    const cwd = ctx.projectRoot || ctx.roots[0];
    const candidates = await detect(cwd);
    return {
      ok: true,
      summary: candidates.length ? `Test runner: ${candidates[0].label}` : 'Test konfiguratsiyasi topilmadi',
      content: candidates.length
        ? [`TEST SETUP in ${cwd}:`, ...candidates.map((c) => `- ${c.label}: ${c.command}`)].join('\n')
        : 'Hech qanday test konfiguratsiyasi topilmadi (package.json test script, pytest, go test, cargo test yo‘q).',
      data: { candidates }
    };
  }
);

export const testsRun = def(
  'tests.run',
  'Run tests',
  'Run the project test suite (auto-detected when no command is given) and report pass/fail with the relevant output tail.',
  'ask',
  {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Explicit test command. Optional — auto-detected when omitted.' },
      timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default 300000). Optional.' }
    },
    required: []
  },
  async (args, ctx) => {
    const cwd = ctx.projectRoot || ctx.roots[0];
    let command = String(args.command || '').trim();
    let label = 'custom';
    if (!command) {
      const candidates = await detect(cwd);
      if (!candidates.length) {
        return { ok: false, error: 'Test buyrug‘i topilmadi. tests.detect bilan tekshiring yoki command bering.' };
      }
      command = candidates[0].command;
      label = candidates[0].label;
    }
    const timeoutMs = Math.min(900_000, Math.max(5_000, Number(args.timeoutMs) || 300_000));
    const result = await runCommand(command, { cwd, timeoutMs, maxBytes: 400_000, signal: ctx.signal });
    const output = `${result.stdout}\n${result.stderr}`;
    const summaryLine = output
      .split('\n')
      .reverse()
      .find((line) => /(passed|failed|failing|passing|ok\b|error|tests?)/i.test(line));
    const failed = /(failed|failing|error)/i.test(output) || result.code !== 0;

    return {
      ok: !failed && !result.timedOut,
      summary: `${label}: ${oneLine(summaryLine || `exit ${result.code}`, 120)}`,
      content: [
        `$ ${command}  (${label})`,
        `exit: ${result.code ?? 'timeout'} in ${(result.ms / 1000).toFixed(1)}s${result.timedOut ? ' TIMEOUT' : ''}`,
        tail(output, 12_000).trim()
      ].join('\n'),
      data: { code: result.code, failed, timedOut: result.timedOut },
      error: failed ? `Testlar muvaffaqiyatsiz (exit ${result.code ?? 'timeout'}).` : undefined
    };
  },
  { timeoutMs: 920_000 }
);

export const testTools = [testsDetect, testsRun];
export default testTools;
