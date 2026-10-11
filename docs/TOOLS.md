# Tools reference

Every tool is declared in `backend/src/agent/tools/*.js` and registered in the tool registry
(`backend/src/agent/registry.js`). The registry converts them to Ollama function definitions, resolves the
permission policy, validates the arguments against the JSON schema, executes them and writes an audit entry.

**Policies:** `allow` runs immediately, `ask` opens an approval dialog in the UI, `deny` is refused.
The table shows the default policy; the user can override any of them (Settings → Tools, or *Always allow*
in the approval dialog). Path rules like `**/secrets/*` override the tool policy for matching paths.

## Filesystem (`allow` for reads, `ask` for writes)

| Tool | Parameters | Policy | Notes |
| --- | --- | --- | --- |
| `fs.read` | `path`, `offset?`, `limit?` | allow | Returns numbered lines; caps at 400 KB and 4000 lines per call |
| `fs.write` | `path`, `content` | ask | Creates parent folders, atomic write, reports created/replaced |
| `fs.append` | `path`, `content` | ask | Appends, creating the file when missing |
| `fs.patch` | `path`, `find`, `replace`, `all?` **or** `edits[]` | ask | Exact-snippet replacement; fails loudly when the snippet is missing so it never corrupts a file |
| `fs.list` | `path?`, `depth?` | allow | One level by default, up to 5 |
| `fs.stat` | `path` | allow | Existence, type, size, mtime |
| `fs.mkdir` | `path` | ask | Recursive |
| `fs.move` | `from`, `to` | ask | Move or rename |
| `fs.delete` | `path`, `recursive?` | ask | Refuses workspace roots and non-empty folders without `recursive` |

Every path is resolved against the project root and must stay inside a workspace root (`lib/paths.js`).

## Search

| Tool | Parameters | Policy | Notes |
| --- | --- | --- | --- |
| `search.text` | `query`, `root?`, `glob?`, `regex?`, `ignoreCase?`, `max?` | allow | Line matches with `file:line:` prefix; skips `node_modules`, `.git`, `dist`, binaries and files > 1.5 MB |
| `search.files` | `pattern`, `root?`, `max?` | allow | `*` and `?` wildcards over names and relative paths |
| `search.tree` | `root?`, `depth?` | allow | Compact project tree, ignored folders pruned |

## Shell

| Tool | Parameters | Policy | Notes |
| --- | --- | --- | --- |
| `shell.exec` | `command`, `cwd?`, `timeoutMs?` | ask | `cmd.exe /d /s /c` on Windows, `sh -lc` elsewhere; jailed cwd, kill-tree on timeout, output capped and tail-preserved |
| `shell.which` | `command` | allow | PATH probe |

A deny-list refuses destructive commands (mass delete, `format`, `diskpart`, `shutdown`, `reg delete HKCU/HKLM`,
shadow copies, `curl | sh`, `npm publish`, hard `git push --force`) even with approval.

## Git

| Tool | Parameters | Policy |
| --- | --- | --- |
| `git.status` | — | allow |
| `git.diff` | `path?`, `staged?` | allow |
| `git.log` | `limit?` | allow |
| `git.add` | `paths?` | ask |
| `git.commit` | `message`, `all?` | ask (destructive class) |
| `git.branch` | `name?` | ask |
| `git.checkout` | `ref` | ask |
| `git.init` | — | ask |

## Tests

| Tool | Parameters | Policy | Notes |
| --- | --- | --- | --- |
| `tests.detect` | — | allow | Detects npm script, vitest, jest, pytest, go, cargo, maven, gradle |
| `tests.run` | `command?`, `timeoutMs?` | ask | Runs the detected or explicit command, reports exit code, pass/fail line and output tail |

## Web

| Tool | Parameters | Policy | Notes |
| --- | --- | --- | --- |
| `web.fetch` | `url`, `maxBytes?` | ask | http(s) only; loopback/private hosts blocked; HTML converted to text; 200 KB cap |

## Memory and skills

| Tool | Parameters | Policy | Notes |
| --- | --- | --- | --- |
| `memory.save` | `content`, `tags?` | allow | Durable user/project facts, injected into later prompts |
| `memory.list` | — | allow | |
| `skill.list` | — | allow | Names + purposes only (progressive disclosure) |
| `skill.load` | `name` | allow | Loads the full instructions of a skill into the conversation |

## System

| Tool | Parameters | Policy | Notes |
| --- | --- | --- | --- |
| `system.info` | — | allow | OS, shell, roots, models, tool count |
| `system.ollama_status` | — | allow | Ollama reachability + model list |

## MCP and plugins

MCP tools are registered dynamically as `mcp__<server>__<tool>` with `source: 'mcp'`, `category: 'mcp'` and
default policy `ask`. Plugin tools are registered as `plugin.<plugin>.<tool>` with `source: 'plugin'`.
Both appear in `GET /api/tools` and in the Tools list in the UI.

## Adding a tool

```js
// backend/src/agent/tools/my-tool.js
export const myTool = {
  name: 'my.tool',
  title: 'My tool',
  description: 'What the model should expect from this tool (be specific).',
  category: 'system',
  defaultPolicy: 'ask',
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  async run(args, ctx) {
    // ctx: { projectRoot, roots, store, permissions, emit, signal, config, logger, skills }
    return { ok: true, summary: 'short line for the UI', content: 'text fed back to the model' };
  }
};
```

Then add it to `backend/src/agent/tools/index.js` (`coreTools`). Tools that only read should use
`defaultPolicy: 'allow'`; anything that writes, executes or reaches the network must use `'ask'`.
