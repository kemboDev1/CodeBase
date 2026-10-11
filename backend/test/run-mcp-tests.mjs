/**
 * Sandbox / CI helper for the MCP test suite.
 *
 * `node --test backend/test/mcp.test.mjs` runs each test file in a child
 * process whose stdio is captured through pipes. Hosts that block pipe
 * creation (the DSH Windows file sandbox reports `spawn EPERM`) cannot run the
 * test runner that way, so this wrapper adds
 * `--experimental-test-isolation=none`, which runs the suite in-process and
 * still uses the standard `node:test` reporter and exit code.
 *
 * Usage:  node backend/test/run-mcp-tests.mjs
 * Plain (unsandboxed) runs should preferably use:
 *         node --test backend/test/mcp.test.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, 'mcp.test.mjs');

const result = spawnSync(
  process.execPath,
  ['--test', '--experimental-test-isolation=none', target],
  { stdio: 'inherit', cwd: path.resolve(here, '../..') }
);

if (result.error) {
  process.stderr.write(`[run-mcp-tests] failed to start the test runner: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
