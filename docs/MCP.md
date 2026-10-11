# MCP (Model Context Protocol) in CodeBase Agent

CodeBase ships a full MCP **client**: it spawns stdio servers, performs the JSON-RPC 2.0 handshake, discovers
their tools, and exposes them to the local model as ordinary agent tools.

```
MCP server process (stdio, newline-delimited JSON-RPC 2.0)
        ▲  initialize → notifications/initialized → tools/list → tools/call
        │
McpClient (backend/src/mcp/client.js)   responds -32601 to server→client requests
        │
McpManager (backend/src/mcp/manager.js)  registers mcp__<server>__<tool> in the tool registry
        │
Agent loop → model can call the tool like any other tool (policy: ask)
```

## Adding a server

UI: **MCP → Add server**. Fields:

| Field | Meaning |
| --- | --- |
| Name | Display name; also the namespace in tool names (`fs-tools` → `mcp__fs_tools__read_file`) |
| Command | Executable to run, e.g. `npx`, `node`, `python`, `uvx` |
| Args | One argument per line |
| Env | `KEY=VALUE` lines, merged over the app environment |
| cwd | Working directory (defaults to the CodeBase data folder) |
| enabled | Whether the server may run at all |
| autoStart | Start it automatically when the backend boots |
| trust | Servers start as **untrusted**; enabling a server in the UI marks it trusted |

API equivalent:

```bash
curl -X POST http://127.0.0.1:<port>/api/mcp/servers \
  -H "X-CodeBase-Token: <token>" -H "Content-Type: application/json" \
  -d '{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","C:\\work"],"enabled":true,"trusted":true,"autoStart":true}'
```

Then `POST /api/mcp/servers/:id/start` and inspect `GET /api/mcp/servers/:id/tools`.

## Built-in example server

`backend/examples/mcp-echo-server.mjs` is a dependency-free MCP server used by the tests and useful for
verifying your setup:

```
Name:    Echo
Command: <absolute path to node.exe>   (or simply: node)
Args:    <absolute path>\backend\examples\mcp-echo-server.mjs
```

It implements `initialize`, `tools/list` (`echo`, `add`), `tools/call`, `resources/list`, `resources/read`
(`echo://greeting`), `prompts/list`, `prompts/get` (`greet`) and `ping`.

In the packaged app the same file is available at
`%LOCALAPPDATA%\Programs\CodeBase\resources\backend\dist\examples\mcp-echo-server.mjs`.

## Behaviour details

- **Transport**: stdio only (this version). Messages are newline-delimited JSON; CRLF, blank lines, stray
  `Content-Length:` headers and chunk splits inside a message are tolerated.
- **Server-initiated requests** (`roots/list`, `sampling/createMessage`, anything with an `id`) are answered
  `{code: -32601, message: 'Method not found'}` so a server never hangs waiting for the client.
- **Timeouts**: 30 s per request (configurable in the client constructor). Timeouts set `lastError` and mark
  the server's status accordingly.
- **Crash handling**: an unexpected exit marks the client `crashed`; the manager restarts it at most
  3 times per rolling 5 minutes, then leaves it as `error` with `lastError` and unregisters its tools.
  An explicit start/restart resets the budget.
- **Shutdown**: `stop()` closes stdin, waits, then kills the process tree (`taskkill /pid <pid> /T /F` on
  Windows). The backend stops every server on `SIGINT`/`SIGTERM`, and Electron kills the backend tree on quit,
  so no orphan processes are left behind.
- **Tool results**: `content[]` entries of type `text` are joined with newlines (capped at 12 000 chars);
  `isError: true` becomes `{ok: false, error: <text>}` so the model sees the failure instead of a crash.
- **Windows commands**: a command that is not found on PATH (e.g. `npx`) is routed through
  `cmd.exe /d /s /c "<command> <args>"`; everything else is spawned directly with `shell: false`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Status `error`, "topilmadi" | The command is not on PATH. Use an absolute path (`C:\Program Files\nodejs\node.exe`) or install the shim. |
| Status `crashed` repeatedly | The server exits on startup. Run its command manually in a terminal to see the real error; check `stderr` in the app log. |
| Tools list is empty | The server does not implement `tools/list`, or it requires `initialize` capabilities you are not offering. Check the server's own docs. |
| The model never calls an MCP tool | MCP tools default to `ask`; approve them once (or *Always allow*) in the approval dialog. Also check that the server is `ready`. |
| Server starts but does nothing | Some servers need an `env` (API keys) or a `cwd`; both are configurable per server. |

## Security notes

MCP servers are arbitrary local programs. CodeBase therefore:

- keeps every server **disabled and untrusted** until you enable it explicitly,
- requires approval for each MCP tool call (`ask` policy by default),
- runs servers with `shell: false` and an explicit `cwd`,
- shows the exact command, args and env in the UI before you start it,
- logs every call (tool name, decision, duration, outcome) to the audit log.

Only add servers you trust; a malicious MCP server is arbitrary code execution on your machine.
