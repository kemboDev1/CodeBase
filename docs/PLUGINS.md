# Writing CodeBase Agent plugins

A plugin is a directory with a `plugin.json` manifest and an ESM entry module that
exports `activate(api)`. Plugins add tools the model can call and slash commands the
user can run. They live in `<dataDir>/plugins/<name>/`.

> **Security model.** A plugin runs in the backend process with full Node.js
> privileges. `trusted: true` means "this code may run", not "this code is safe".
> Only mark plugins you wrote or have read in full. See [Security](#security).

---

## 1. Directory layout

```
<dataDir>/plugins/my-plugin/
  plugin.json      manifest (required)
  index.mjs        entry module (required, name from manifest.main)
  lib/…            anything else the plugin needs
```

The shipped example lives at `backend/examples/plugin-example/`. Copy it into the
plugins directory (printed as `dataDir` by `GET /api/system/info`):

```powershell
Copy-Item -Recurse backend\examples\plugin-example "<dataDir>\plugins\my-plugin"
```

## 2. Manifest: `plugin.json`

```json
{
  "name": "example-tools",
  "version": "1.0.0",
  "description": "Reference plugin: project statistics tool and a /hello command.",
  "author": "CodeBase Agent",
  "main": "index.mjs",
  "permissions": ["filesystem:read"]
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Non-empty string. Becomes the tool namespace `plugin.<slug>.<tool>`. |
| `version` | no | String, defaults to `0.0.0`. Part of the runtime id `<name>@<version>`. |
| `description` | no | Shown in the Plugins page. |
| `main` | no | Relative entry file, defaults to `index.mjs`. Absolute paths and paths escaping the plugin directory are rejected. |
| `permissions` | no | **Declarative only** — informational labels such as `filesystem:read`, `shell:exec`, `network`. They are shown to the user, not enforced. |
| `author`, `homepage` | no | Informational. |

## 3. Entry module

```js
// index.mjs — no side effects at import time
export async function activate(api) {
  api.logger.info('my-plugin activated');
  api.registerTool({ /* … */ });
  api.registerCommand({ /* … */ });
  api.on('tool.before', (payload) => { /* observe, never block */ });
}

export async function deactivate() {
  // optional: clear timers, close handles. Must not throw.
}
```

- `activate(api)` is required and may be async. It runs exactly once at load.
- `deactivate()` is optional, called on reload, shutdown, or when the plugin is
  switched off. Errors thrown here are logged and swallowed.
- `module.exports = { activate }` (CommonJS) and `export default { activate }` are also
  accepted, but named ESM exports are the documented form.
- A throw inside `activate()` marks the runtime `status: 'error'`. Any tool the
  plugin registered *before* the throw is rolled back with `registry.unregister()`.

## 4. The `api` object

```js
{
  name, version, manifest, logger,
  registerTool(tool),
  registerCommand({ name, description, run(args, ctx) }),
  on(event, handler),
  emit(event, payload),
  getStore(), saveStore(),
  paths: { dataDir, pluginDir },
  settings: { get(key, fallback), set(key, value), all() }
}
```

### `registerTool(tool)`

`tool` uses the core `Tool` shape (contract §7). The returned value is the final
registered name.

```js
const name = api.registerTool({
  name: 'project_stats',            // → plugin.my-plugin.project_stats
  title: 'Project statistics',
  description: 'Count files and lines under a directory. Written for the model.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
  defaultPolicy: 'allow',           // 'allow' | 'ask' | 'deny' (default 'ask')
  async run(args, ctx) {
    // ctx: { runId, sessionId, projectRoot, roots, permissions, registry, store, logger, signal, emit, config }
    return { ok: true, summary: 'short one-liner', content: 'text the model reads', data: { /* optional */ } };
  },
});
```

Rules enforced by the host:

- The name is always rewritten to `plugin.<plugin-name>.<tool-name>`, lowercased,
  non-alphanumerics turned into `_` (so `project_stats` stays `project_stats`).
- `category` is forced to `plugin` and `source` to `plugin`; `title` defaults to the tool name.
- `run()` must return the `ToolResult` shape. Never throw for an expected failure —
  return `{ ok: false, error: 'message' }`. Throwing is caught by the registry, but
  the error text is what the model sees.
- A duplicate name throws inside `registerTool`, which marks the plugin `error`.

### `registerCommand({ name, description, run })`

Registers a slash command, listed by `GET /api/commands`.

```js
api.registerCommand({
  name: 'hello',
  description: 'Greet the user',
  async run(args, ctx) {
    const who = args.join(' ') || 'there';
    return { ok: true, summary: `said hello to ${who}`, content: `Hello, ${who}!` };
  },
});
```

`args` is the array of whitespace-separated words after the command name; `ctx`
carries the current project/session when the command runs from the chat box.

### `on(event, handler)`

Subscribe to `chat.before`, `chat.after`, `tool.before`, `tool.after`. Handlers may
be async; they are dispatched in registration order and a throwing handler is logged
and ignored. Return value of `on()` is an unsubscribe function. Handlers should
observe, not mutate agent state.

### `emit(event, payload)`

Emits a host event, tagged with `{ plugin: '<name>' }`. Use it for progress that the
UI should show.

### Store access

`getStore()` returns the live store object; `saveStore()` persists it. Direct
mutation is allowed but discouraged — prefer `settings` for plugin state.

### `paths`

- `paths.pluginDir` — the plugin's own directory (read templates/assets from here).
- `paths.dataDir` — `<dataDir>/plugins/<plugin-name>/`, for caches and state files.
  Create it yourself (`await fs.mkdir(api.paths.dataDir, { recursive: true })`)
  before writing into it.

### `settings`

```js
const retries = api.settings.get('retries', 3);
await api.settings.set('retries', 5);       // persists under store.plugins.settings
const all = api.settings.all();
```

## 5. Lifecycle and trust

`loadPlugins({ dir, registry, logger, store, dataDir, emit })` scans `dir`
(recursively one level: `<dir>/<plugin>/plugin.json`) and returns one runtime per plugin:

```js
{ id: 'example-tools@1.0.0', dir, name, version, description,
  prefix: 'plugin.example-tools.',            // tool-name prefix for bulk unregister
  status: 'active' | 'disabled' | 'error',
  error?, api, activate?, deactivate?, tools: [], commands: [], handlers }
```

Use `runtime.prefix` (not `runtime.id`, which carries `@version`) when dropping a
plugin's tools through `registry.unregisterByPrefix(prefix)`.

- **`disabled`** — the store has no record for the plugin, `trusted !== true`, or
  `enabled === false`. Nothing is imported and no tool is registered. Enable and
  trust the plugin in the **Plugins** page first.
- **`active`** — manifest read, module imported, `activate()` completed.
- **`error`** — bad/missing `plugin.json`, missing entry file, a throw at import
  time or inside `activate()`. `error` holds the message; the backend keeps running.

`loadPlugin(dir, deps)` loads one directory. `unloadPlugin(runtime, { registry })`
calls `deactivate()` and unregisters the plugin's tools. Reloads re-import the entry
file with a cache-busting query string, so edits take effect on `/plugins/reload`.

Store record shape:

```json
{ "id": "example-tools", "dir": "C:\\…\\plugins\\example-tools", "name": "example-tools",
  "version": "1.0.0", "main": "index.mjs", "enabled": true, "trusted": true,
  "createdAt": "2025-01-01T00:00:00.000Z" }
```

Records are matched by `id` (name or `name@version`) first, then by `dir`.

## 6. Complete worked example

`backend/examples/plugin-example/` is a working plugin. The important parts:

```js
import fs from 'node:fs/promises';
import path from 'node:path';

export async function activate(api) {
  api.logger.info('example-tools activated');

  api.registerTool({
    name: 'project_stats',
    title: 'Project statistics',
    description: 'Count files, lines of code and total size under a project directory.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to analyse. Defaults to the project root.' },
        extensions: { type: 'array', items: { type: 'string' }, description: 'Only count these extensions.' },
      },
      additionalProperties: false,
    },
    defaultPolicy: 'allow',
    async run(args = {}, ctx = {}) {
      const base = ctx.projectRoot || process.cwd();
      const target = path.resolve(base, args.path || '.');
      const stat = await fs.stat(target).catch(() => null);
      if (!stat?.isDirectory()) return { ok: false, error: `Not a directory: ${target}` };
      // …walk the tree, count files and lines…
      return { ok: true, summary: `42 files, 1200 lines`, content: '…table…' };
    },
  });

  api.registerCommand({
    name: 'hello',
    description: 'Greet the user from the example-tools plugin.',
    async run(args = []) {
      return { ok: true, summary: 'said hello', content: `Hello, ${args.join(' ') || 'there'}!` };
    },
  });
}

export function deactivate() {
  // nothing to clean up in this example
}
```

Verified behaviour (see `backend/test/plugins.test.mjs`): the tool is registered as
`plugin.example-tools.project_stats` with `source: 'plugin'`, `/hello` appears in
`runtime.commands`, and a plugin that throws inside `activate()` is reported as
`status: 'error'` with its partial registrations rolled back.

## 7. Testing a plugin

`backend/test/plugins.test.mjs` shows the pattern: build a fake registry in the test
(`register`/`unregister`/`get`/`list`), a plain store object with a trusted record,
and call `loadPlugin(dir, { registry, store })`. No backend services are needed.

```powershell
node --test backend/test/plugins.test.mjs
```

## 8. Troubleshooting

| Symptom | Cause |
|---|---|
| `status: 'disabled'`, no error | No store record, `trusted !== true`, or `enabled: false`. Enable it in the Plugins page. |
| `plugin.json not found in <dir>` | The manifest is missing or named differently. |
| `Entry file not found: index.mjs` | `main` does not match a file in the plugin directory. |
| `does not export activate(api)` | The module has no named `activate` export (a default export object also works). |
| Tool missing from `/api/tools` | `activate()` threw, or the name collided with an existing tool. |
| `Unsupported plugin event "…"` | Only `chat.before`, `chat.after`, `tool.before`, `tool.after` are allowed. |

## 9. Security

- **Trust is a decision.** `trusted: true` runs third-party code inside the backend
  process, with access to the filesystem, environment variables and the network.
  Review the source before trusting a plugin; never trust one you cannot read.
- **Read the manifest.** `permissions` is a declaration the UI can show, not a
  sandbox. Assume a plugin can do anything the backend can.
- **Least privilege in code.** Read only what you need, never write into the user's
  project without an explicit user request, and never send project contents off the
  machine without consent.
- **Paths.** Plugin tools receive `ctx.projectRoot` and `ctx.roots`. Resolve paths
  against them and reject anything that escapes — the plugin is responsible for its
  own containment; the core path jail does not wrap plugin code.
- **Secrets.** Keep tokens in plugin settings or the environment, never in the
  manifest or source, and never log them.
- **Dangerous tools.** Prefer `defaultPolicy: 'ask'` for anything that writes,
  deletes, executes or spends money. Reserve `'allow'` for read-only tools.
- **Rollback.** Register tools in a single pass so a failure rolls back cleanly, and
  keep `deactivate()` free of throws so unload always completes.
