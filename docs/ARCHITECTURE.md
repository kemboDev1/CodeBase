# CodeBase Agent — Architecture & Interface Contracts (v1.0.0)

This document is the single source of truth for every module interface. All code MUST follow it
exactly; other modules are written against these signatures.

## 0. Runtime shape

```
CodeBase.exe (Electron main, CommonJS)
  ├─ supervisor.cjs  → spawns + watches: Ollama, backend child process, (MCP children are owned by backend)
  ├─ BrowserWindow   → http://127.0.0.1:<dynamicPort>/  (renderer, contextIsolation, sandbox, no node)
  └─ preload.cjs     → window.codebase = { port, token, apiBase, pickFolder, ... }
backend (node child process, ESM) → Express API + SSE + agent loop + MCP clients + plugins
Ollama (http://127.0.0.1:11434)   → models, chat w/ tools
```

No new npm packages. Backend deps: `express`, `cors`, `dotenv`. Frontend: `react`, `react-dom`,
`lucide-react`, `vite`. Everything else is Node built-ins.

## 1. Config (`backend/src/config.js`)

```js
export const config = {
  version, port, host, token, dataDir, webDir, allowAnon,
  ollamaUrl, defaultModel, fastModel, numCtx, maxSteps, requestTimeoutMs,
  shellTimeoutMs, maxOutputBytes, workspaceRoots: [abs, ...],
  pluginsDir, skillsDir, logLevel
};
export function setRuntimeSettings(partial) // merges settings from the store over config
```

Env vars: `CODEBASE_PORT(0=auto) CODEBASE_HOST CODEBASE_TOKEN CODEBASE_DATA_DIR CODEBASE_WEB_DIR
CODEBASE_ALLOW_ANON OLLAMA_URL DEFAULT_MODEL FAST_MODEL NUM_CTX MAX_STEPS WORKSPACE_ROOTS(;-sep)`

## 2. Logger (`backend/src/lib/logger.js`)

```js
export const logger = { debug, info, warn, error }   // (msg, meta?) → stdout, JSON-free, prefixed [CodeBase]
export function setLogLevel(level)
export function ringBuffer() -> Array<{at,level,msg}>  // last 300 entries, for /api/system/logs
```

## 3. Store (`backend/src/store.js`)

`getStore()` returns the live object (already migrated). `saveStore()` is atomic + debounced-safe.

```js
export async function getStore(): Promise<Store>
export async function saveStore(): Promise<void>
export function makeId(prefix): string
export function recordAudit(entry: {tool,argsDigest,decision,ok,ms,error?}) // ring, max 500
export const SCHEMA_VERSION = 2
```

```ts
type Store = {
  version: 2,
  projects: Project[],
  memories: Memory[],
  skills: Skill[],
  mcpServers: McpServer[],
  plugins: PluginRecord[],
  toolPolicies: Record<string, 'allow'|'ask'|'deny'>,
  pathRules: { pattern: string, policy: Policy }[],
  audit: AuditEntry[],
  settings: Settings
}
type Project = {
  id, name, description, instructions, root: string|null,
  sessions: Session[], activeSessionId: string,
  createdAt, updatedAt
}
type Session = { id, name, createdAt, updatedAt, messages: Message[], summary?: string }
type Message = {
  id, role: 'user'|'assistant'|'tool'|'system', content: string,
  createdAt, model?, toolName?, toolCalls?, error?, steps?, durationMs?
}
type Memory = { id, content, createdAt, tags?: string[] }
type Skill = { id, name, description, content, enabled, source: 'inline'|'file'|'builtin',
               path?, whenToUse?, createdAt }
type McpServer = { id, name, command, args: string[], env: Record<string,string>, cwd?: string,
                   enabled: boolean, autoStart: boolean, transport: 'stdio', createdAt,
                   lastStatus?: string, trust: 'untrusted'|'trusted' }
type PluginRecord = { id, dir, name, version, description, main, enabled, trusted, createdAt, error? }
type Settings = { model, fastModel, numCtx, temperature, maxSteps, ollamaUrl,
                  workspaceRoots: string[], theme: 'dark'|'light', autostartOllama: boolean,
                  autoApproveReads: boolean, mode: 'auto'|'fast'|'deep', summarize: boolean }
```

Migration from v1: `projects[].messages` → `sessions[0]`, seed `mcpServers/plugins/toolPolicies`.

## 4. Path jail (`backend/src/lib/paths.js`)

```js
export function setRoots(roots: string[])
export function getRoots(): string[]
export function assertInside(absPath: string): string  // throws AppError 403 when outside every root
export function resolveInside(root: string|null, relOrAbs: string): string // resolves + asserts
export function isInsideAny(absPath: string): boolean
export function toRel(absPath: string): string
export const IGNORED_DIRS = ['node_modules','.git','dist','build','release','.next','__pycache__','.venv','venv','.cache','coverage']
```

## 5. Errors (`backend/src/lib/errors.js`)

```js
export class AppError extends Error { constructor(message, status = 400, code?) }
export const badRequest(msg), forbidden(msg), notFound(msg), conflict(msg)
```

## 6. Ollama client (`backend/src/ollama/client.js`)

```js
export function setOllamaUrl(url)
export async function listModels(): Promise<{name,size,modifiedAt}[]>
export async function health(): Promise<{connected, models, error}>
export async function chat({ model, messages, tools, options, stream, signal, onToken, onThinking }):
  Promise<{ content: string, toolCalls: {id,name,arguments}[], done, promptTokens, evalTokens, model }>
export async function generate({ model, prompt, options, signal }): Promise<string>   // for summaries/titles
export function supportsTools(model): boolean   // heuristic: /qwen|llama3\.[1-9]|mistral|devstral|granite|cogito/
```

`chat` with `stream: true` parses NDJSON; `onToken(text)` is called per delta (content only, never
`thinking`). `toolCalls` are merged from every chunk (`message.tool_calls[].function.{name,arguments}`),
`arguments` normalised to an object (Ollama may return a JSON string). On HTTP 400 whose body matches
`/does not support tools|tools/i` the caller may retry without `tools`.

## 7. Tool registry (`backend/src/agent/registry.js`)

```js
export function createRegistry({ logger }) -> Registry
Registry.register(tool)                       // throws on duplicate name
Registry.get(name): Tool|undefined
Registry.list(): ToolInfo[]                   // sorted by category,name
Registry.toOllamaTools(names?): OllamaTool[]
Registry.execute(name, args, ctx): Promise<ToolResult>
```

```ts
type Tool = {
  name: string,               // 'fs.read', 'shell.exec', 'mcp__demo__echo'
  title: string,
  description: string,        // written for the model
  category: 'filesystem'|'search'|'shell'|'git'|'tests'|'web'|'skills'|'memory'|'mcp'|'plugin'|'system',
  parameters: object,         // JSON Schema (object root)
  defaultPolicy: 'allow'|'ask'|'deny',
  source?: 'core'|'mcp'|'plugin'|'builtin',
  dangerous?: boolean,
  run(args, ctx): Promise<ToolResult>
}
type ToolInfo = Omit<Tool,'run'> & { policy: Policy, enabled: boolean }
type ToolResult = { ok: true, summary: string, content: string, data?: any } | { ok: false, error: string, content?: string }
```

`Registry.execute` responsibilities (in order): name lookup → enabled/policy resolution via
`ctx.permissions.policyFor(tool, args)` → if `ask` call `ctx.permissions.request(...)` (a denial returns
`{ok:false,error:'User denied permission'}`) → `run(args, ctx)` → timing + `recordAudit` →
`ctx.emit({type:'tool_end', ...})`. It never throws for tool failures; it converts to `{ok:false}`.

## 8. Permissions (`backend/src/agent/permissions.js`)

```js
export function createPermissions({ store, emit, logger }) -> Permissions
Permissions.policyFor(tool: Tool, args): Policy         // pathRules → toolPolicies → defaultPolicy,
                                                        // autoApproveReads upgrades read-only tools to allow
Permissions.setPolicy(toolName, policy)
Permissions.setPathRule(pattern, policy)
Permissions.removePathRule(pattern)
Permissions.request({ tool, args, sessionId, runId }): Promise<{approved:boolean, remember:'once'|'session'|'always'}>
Permissions.pending(): PendingRequest[]
Permissions.resolve(id, { approved, remember }): boolean
```

`request()` emits `{type:'permission_request', id, tool, title, args, summary, reason, expiresAt}` and
waits for `Permissions.resolve` (or 120 s timeout → denied). `remember:'always'` persists the policy,
`'session'` remembers in-memory for the run's session.

## 9. Agent loop (`backend/src/agent/loop.js`)

```js
export async function runAgent({
  prompt, project, session, model, mode, signal, emit, registry, permissions,
  store, skills, mcp, config
}): Promise<{ content, steps, model, stopped, toolCalls }>
```

Flow: build system prompt (stable core + dynamic sections) → build history (context budget) → loop
`maxSteps`:

1. `emit({type:'step', index, model})`
2. `ollama.chat({stream:true, onToken: t => emit({type:'token', text:t})})`
3. Tool calls → for each: `emit({type:'tool_start', id, name, title, args})` →
   `registry.execute()` → `emit({type:'tool_end', id, name, ok, summary, durationMs, contentPreview})` →
   push `{role:'assistant', tool_calls}` + `{role:'tool', content}` into the working message array.
4. No tool calls → final answer.

Fallback protocol when the model cannot use native tools: system prompt gains a
`TOOL PROTOCOL` section describing fenced blocks; loop parses
```tool_call\n{"name":"fs.read","arguments":{...}}\n``` and feeds results back as a user-role
`TOOL RESULT` message. Both paths use the same registry/permissions.

Persistence: after the run, append the user message and the final assistant message (with `steps`,
`durationMs`, `toolCalls`) to `session.messages` and `saveStore()`. Tool messages are stored on the
assistant message's `toolCalls` array, not as separate history entries.

Context budget: `estimateTokens(text) = ceil(chars/4)`; history is trimmed oldest-first to fit
`numCtx*0.5`; when `settings.summarize` and older messages exist, they are folded into
`session.summary` using `fastModel` (max once per run).

## 10. Tool implementations

- `backend/src/agent/tools/fs.js` → `fs.read` (allow), `fs.write` (ask), `fs.append` (ask),
  `fs.patch` (ask, unified-diff-lite: `{path, find, replace, all?}` + `{path, edits:[{find,replace}]}`),
  `fs.list` (allow), `fs.mkdir` (ask), `fs.move` (ask), `fs.delete` (ask),
  `fs.stat` (allow). All paths go through `resolveInside(ctx.projectRoot, p)`.
- `backend/src/agent/tools/search.js` → `search.text` (allow, regex over roots, ignore list, caps),
  `search.files` (allow, glob-ish name match), `search.tree` (allow, depth-limited tree).
- `backend/src/agent/tools/shell.js` → `shell.exec` (ask, `{command, cwd?, timeoutMs?}`, runs through
  `cmd.exe /d /s /c` on win32 and `sh -lc` elsewhere, cwd jailed, output capped, kills on timeout,
  deny-list patterns → hard deny).
- `backend/src/agent/tools/git.js` → `git.status`, `git.diff`, `git.log`, `git.add`, `git.commit`,
  `git.branch`, `git.checkout` (ask except status/diff/log).
- `backend/src/agent/tools/tests.js` → `tests.detect` (allow, finds package.json scripts/pytest/vitest),
  `tests.run` (ask, runs the detected command via shell helper, returns structured pass/fail tail).
- `backend/src/agent/tools/web.js` → `web.fetch` (ask, http(s) GET, 200 KB cap, text extraction, no
  redirects to private hosts).
- `backend/src/agent/tools/memory.js` → `memory.save` (allow), `memory.list` (allow).
- `backend/src/agent/tools/skills.js` → `skill.list` (allow), `skill.load` (allow) — progressive
  disclosure: the model loads full skill instructions only when relevant.
- `backend/src/agent/tools/system.js` → `system.info` (allow), `system.ollama_status` (allow).

Tool `ctx` object (created per run):
```js
{ runId, sessionId, projectId, projectRoot, roots, permissions, registry, store, logger, signal,
  emit, config, skills, plugins, mcp, shell }
```

## 11. MCP (`backend/src/mcp/`)

```js
// client.js
export class McpClient extends EventEmitter {
  constructor(server: McpServer, { logger, timeoutMs })
  async start(): Promise<{ serverInfo, capabilities }>   // spawn → initialize → notifications/initialized
  async stop(): Promise<void>
  async call(method, params, timeoutMs?): Promise<any>    // JSON-RPC 2.0 over newline-delimited stdio
  async listTools(): Promise<McpTool[]>                   // [{name, description, inputSchema}]
  async callTool(name, args): Promise<{ content: any[], isError?: boolean }>
  async listResources(): Promise<McpResource[]>
  async readResource(uri): Promise<{ contents: any[] }>
  async listPrompts(): Promise<McpPrompt[]>
  getPrompt(name, args): Promise<{ messages: any[] }>
  status: 'stopped'|'starting'|'ready'|'error'|'crashed'
  lastError?: string
}
// manager.js
export function createMcpManager({ store, registry, logger, emit }): McpManager
McpManager.start(serverId) / stop(serverId) / restart(serverId)
McpManager.startAuto() / stopAll()
McpManager.registerTools(server)       // registers mcp__<slug>__<tool> into the registry
McpManager.list(): [{ id, name, status, tools: number, lastError }]
McpManager.tools(serverId)
McpManager.reload()                    // after store edits
```

Tool names: `mcp__${slug(server.name)}__${slug(tool.name)}` (non-alphanumerics → `_`, max 60 chars).
MCP tool results are flattened to text: every `content[]` entry with `type:'text'` joined by `\n`.
Servers are spawned with `{ stdio: ['pipe','pipe','pipe'], cwd: server.cwd || dataDir, shell: false }`
and killed with `tree-kill`-style `taskkill /pid /T /F` on Windows. Auto-restart max 3 times / 5 min.

## 12. Plugins (`backend/src/plugins/loader.js`)

A plugin is a directory containing `plugin.json`:
```json
{ "name": "example-tools", "version": "1.0.0", "description": "...",
  "main": "index.mjs", "permissions": ["filesystem:read"], "author": "..." }
```
```js
export async function loadPlugins({ dir, registry, logger, store, ctxFactory, emit }): Promise<PluginRuntime[]>
export async function loadPlugin(dir, deps): Promise<PluginRuntime>
PluginRuntime = { id, dir, name, version, description, status, error?, api, activate?, deactivate? }
```
The module default-exports `activate(api)` (and optional `deactivate()`). `api`:
```js
{ name, version, logger,
  registerTool(tool),                 // same Tool shape; source:'plugin'; name auto-prefixed 'plugin.<plugin>.<tool>'
  registerCommand({ name, description, run(args, ctx) }),   // slash commands, exposed at GET /api/commands
  on(event, handler),                 // 'chat.before','chat.after','tool.before','tool.after'
  getStore(), saveStore(), emit(event), paths: { dataDir, pluginDir }, settings: {get,set} }
```
Plugins are disabled unless `trusted === true` in the store; the UI enables them explicitly.
Load failures never crash the backend: status `error` + `error` message.

## 13. Skills (`backend/src/skills/registry.js`)

```js
export async function loadSkills({ dirs, store, logger }): Promise<Skill[]>   // merges builtin + files + inline
export function parseSkillMarkdown(text, filePath): { name, description, whenToUse, content }
export async function importSkill({ from, store, logger }): Promise<Skill>     // folder path, .md file, or https URL
export function skillSummaryPrompt(skills): string       // one line per skill for the system prompt
export function renderSkill(skill): string               // full body for skill.load
```
On-disk layout: `<skillsDir>/<slug>/SKILL.md` with YAML frontmatter
(`name`, `description`, `whenToUse`). Builtin skills live in `backend/src/skills/builtin/<slug>.md`
and are seeded into the store on first run (editable, but re-seeded if the store has none).

## 14. HTTP API (all JSON, `/api` prefix, `X-CodeBase-Token` header required unless `allowAnon`)

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/health` | — | `{ ok, service, version, ollama, mcp, plugins, skills, port, uptimeMs }` (token-free, no secrets) |
| GET | `/system/info` | — | `{ version, platform, node, port, dataDir, roots, logs? }` |
| GET | `/system/logs` | `?limit` | `{ logs }` |
| POST | `/system/ollama/start` \| `/stop` | — | `{ ok, ollama }` |
| GET/POST | `/system/ollama/autostart` | `{ enabled }` | `{ enabled }` |
| GET | `/models` | — | `{ models }` |
| GET | `/tools` | — | `{ tools: ToolInfo[] }` |
| PATCH | `/tools/:name` | `{ policy }` | `{ tool }` |
| GET/POST/PATCH/DELETE | `/projects`, `/projects/:id` | project fields | `{ project(s) }` |
| GET | `/projects/:id/messages` | `?sessionId` | `{ messages, session, sessions }` |
| POST | `/projects/:id/sessions` | `{ name }` | `{ session }` |
| DELETE | `/sessions/:id` | — | `{ ok }` |
| POST | `/chat` | `{ projectId, sessionId?, message, model?, mode? }` | **SSE stream** |
| POST | `/agent/stop` | `{ runId }` | `{ ok }` |
| POST | `/agent/permission/:id` | `{ approved, remember }` | `{ ok }` |
| GET/BATCH | `/memories`, `/memories/:id` | — | `{ memories }` |
| GET/POST/PATCH/DELETE | `/skills`, `/skills/:id` | skill fields, `{ from }` for import | `{ skills }` |
| GET/POST/PATCH/DELETE | `/mcp/servers`, `/mcp/servers/:id` | server fields | `{ servers }` |
| POST | `/mcp/servers/:id/start` \| `/stop` \| `/restart` | — | `{ server, tools }` |
| GET | `/mcp/servers/:id/tools` | — | `{ tools }` |
| GET/POST | `/plugins`, `/plugins/:id/toggle` \| `/plugins/reload` | `{ enabled }` | `{ plugins }` |
| GET | `/files/tree` | `?root&depth` | `{ tree }` |
| GET | `/files/read` | `?path` | `{ path, content, size, truncated }` |
| POST | `/files/write` | `{ path, content }` | `{ ok, size }` |
| POST | `/files/mkdir` \| `/files/delete` \| `/files/move` | `{ path, ... }` | `{ ok }` |
| GET | `/files/search` | `?q&root&max` | `{ matches }` |
| POST | `/terminal/exec` | `{ command, cwd?, timeoutMs? }` | `{ code, stdout, stderr, ms, truncated }` |
| GET/PATCH | `/settings` | settings subset | `{ settings }` |
| GET | `/commands` | — | `{ commands }` (plugin slash commands) |

### SSE event envelope (`POST /api/chat`)

Every event is one `data:` line containing JSON with a `type` discriminator:
`run_start`, `step`, `token`, `tool_start`, `tool_end`, `permission_request`, `permission_resolved`,
`summary`, `done`, `error`, `ping`. `done` = `{type, messageId, sessionId, content, steps, model,
durationMs, stopped}`. The client may abort by closing the connection (`req.on('close')` → abort signal).

## 15. Electron (`electron/`)

- `main.cjs` — app lifecycle, single instance, dynamic free port, spawns backend as a Node child
  (`ELECTRON_RUN_AS_NODE=1` + `process.execPath`), waits for health, creates the window, injects
  `--codebase-port/token` via `additionalArguments`, restarts the backend on crash (max 3, backoff),
  kills children on quit.
- `supervisor.cjs` — `{ ensureOllama(), ollamaStatus(), startOllama(), stopOllama(), autostartEnabled(),
  setAutostart(bool), startBackend(), stopBackend(), status() }`; emits `status` events.
- `preload.cjs` — exposes `window.codebase` (see §16).
- IPC channels: `codebase:pick-folder`, `codebase:open-path`, `codebase:show-in-folder`,
  `codebase:system-info`, `codebase:ollama-autostart` (get/set), `codebase:ollama-start`,
  `codebase:restart-backend`, `codebase:status` (push), `codebase:log`.

## 16. Renderer contract (`window.codebase`)

```ts
{
  ready: true, version: string, port: number, token: string, apiBase: string,  // http://127.0.0.1:<port>/api
  platform: string,
  pickFolder(): Promise<string|null>,
  openPath(p: string): Promise<void>,
  showInFolder(p: string): Promise<void>,
  systemInfo(): Promise<any>,
  getOllamaAutostart(): Promise<boolean>,
  setOllamaAutostart(enabled: boolean): Promise<boolean>,
  startOllama(): Promise<any>,
  restartBackend(): Promise<{ok:boolean}>,
  onStatus(cb): () => void,   // { ollama: {connected, starting, error}, backend: {running, port} }
}
```
When `window.codebase` is missing (plain browser dev), the API client falls back to
`${location.origin}/api` and the token from `?token=` / `localStorage.codebase_token` / empty.

## 17. Frontend structure

```
frontend/src/
  main.jsx App.jsx
  api/client.js          // api(), streamChat(), token resolution, error normalisation
  state/AppContext.jsx   // provider: projects, sessions, messages, models, health, tools, mcp, plugins, skills, settings
  components/…           // Sidebar, Topbar, MarkdownLite, IconButton, Modal, ApprovalModal, ToolTimeline, Toasts
  pages/…                // Chat, Files, Terminal, Mcp, Plugins, Skills, Memory, Projects, Settings
  styles/*.css           // existing styles.css (base, keep class names) + new pages.css
```
Existing class names from `styles.css` (`.app-shell`, `.sidebar`, `.main-area`, `.topbar`,
`.content-page`, `.primary-btn`, `.modal-backdrop`, `.modal-card`, …) MUST be reused so the current
visual language is preserved. New CSS goes to `frontend/src/styles/pages.css` (imported by
`styles.css` or `main.jsx`).

## 18. Tests (`backend/test/*.test.mjs`, `node --test`)

Required suites: `store.test.mjs` (migration v1→v2, atomic save, audit ring), `paths.test.mjs`
(jail escape attempts), `registry.test.mjs` (policy resolution, permission denial, audit),
`agent-loop.test.mjs` (mock Ollama: tool call then final answer, fallback text protocol, abort),
`tools-fs.test.mjs` (read/write/patch/list/search inside temp root), `tools-shell.test.mjs`
(deny-list, timeout, output cap), `mcp.test.mjs` (real stdio client against
`backend/examples/mcp-echo-server.mjs`), `skills.test.mjs` (frontmatter parse, import from dir),
`plugins.test.mjs` (load example plugin, tool registration, failure isolation).

## 19. Delivery

`npm run build` → `scripts/build-backend.mjs` (esbuild bundle to `backend/dist/server.mjs`) +
`npm --prefix frontend run build`. `npm run dist:win` → NSIS installer. `npm test` → backend tests.
`.github/workflows/ci.yml` → install, test, build on windows-latest + ubuntu-latest.
