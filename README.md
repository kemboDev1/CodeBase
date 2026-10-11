# CodeBase Agent

**Local-first AI coding agent for Windows.** Runs on your own machine with [Ollama](https://ollama.com) —
your code, chats and memory never leave your computer. Unlike the old CodeBase (a chat window that only
worked while a CMD window was open), this is a real agent: it reads and writes files, runs terminal
commands, uses git, runs tests, calls MCP servers, loads skills and executes plugins.

```
CodeBase.exe (Electron)
  ├── backend child process (Node, dynamic port, per-launch token)
  │     ├── agent loop (Ollama tool calling + fallback text protocol)
  │     ├── 31 built-in tools (files, search, shell, git, tests, web, memory, skills, system)
  │     ├── MCP client (stdio JSON-RPC 2.0) + server manager
  │     ├── plugin runtime (manifest based)
  │     └── skill library (SKILL.md + 11 built-in skills)
  └── React UI (chat, files, terminal, MCP, plugins, skills, memory, projects, settings)
```

## What changed from the old version

| Old CodeBase (0.3.x) | CodeBase Agent (1.0.0) |
| --- | --- |
| Chat only, no tools | Agentic loop with 31 tools and per-tool permissions |
| Needed Ollama started manually in CMD | CodeBase starts and supervises Ollama itself (+ optional Windows autostart) |
| Backend ran inside Electron main, port 3030 hardcoded | Backend is its own process, OS-picked free port, per-launch auth token, auto-restart on crash |
| Single JSON store, no migrations | Store v2 with migration, atomic writes, backups, audit log |
| No MCP, no plugins, no skills | MCP servers, plugin runtime, skill library — all managed from the UI |
| `stream: false` (frozen UI) | Server-Sent Events streaming, tool timeline, cancel button |
| 201-line single-file UI | Modular React app: 9 pages, approval modal, file editor, terminal |

## Install (one time)

1. Install [Node.js LTS](https://nodejs.org) (20+) and [Ollama](https://ollama.com/download).
2. Pull a model: `ollama pull qwen2.5-coder:7b` (and optionally `ollama pull qwen3:4b` as the fast model).
3. Double-click **`BUILD-WINDOWS-APP.bat`** — it installs dependencies, runs the tests, builds and creates
   `release\CodeBase-Setup-1.0.0.exe`.
4. Install it, then open **CodeBase** from the Start menu or Desktop. No CMD window is needed ever again.

## Everyday use

- **Chat** — ask for work: *"src/index.js dagi xatoni topib tuzat"*, *"testlarni ishga tushir"*,
  *"yangi komponent yoz"*. The agent reads real files and asks permission before writing or running commands.
- **Files** — browse the workspace, open a file in the editor, save with `Ctrl+S`.
- **Terminal** — run any command in the project folder (dangerous commands are denied outright).
- **MCP** — add any stdio MCP server (command + args + env), start/stop it, inspect its tools. Its tools
  appear to the model as `mcp__<server>__<tool>`.
- **Plugins** — plugins are disabled until you explicitly trust them; the bundled `example-tools` plugin
  shows the format.
- **Skills** — 11 built-in skills (code review, debugging, safe refactor, tests, git workflow, security
  audit, performance, explain code, scaffold, Uzbek style, web research). Create your own or import a
  `SKILL.md` from a folder or an https URL.
- **Settings** — models, context size, temperature, step budget, workspace roots, Ollama autostart, audit log.

## Permissions and safety

- Every tool has a policy: `allow`, `ask` (default for anything that writes) or `deny`.
- `ask` opens an approval dialog: *Allow once / Allow for this session / Always allow / Deny*.
- All file access is jailed to your workspace roots; `..\..` escapes and symlink tricks are rejected.
- Shell commands run through a deny-list (mass delete, disk format, registry wipes, piped remote scripts…).
- The local API requires a per-launch token, so other programs on your machine cannot drive your agent.
- Every tool call is written to an audit log (Settings → Audit log).

## Development

```bash
npm run install:all     # root + backend + frontend dependencies
npm run build           # backend bundle + frontend bundle
npm run desktop         # build and open the Electron app
npm run dev             # backend (3030) + Vite (5173) for UI work
npm test                # 123 backend tests
npm run smoke           # live end-to-end test (real HTTP + SSE + MCP + plugins)
npm run verify          # environment check (Node, deps, builds, Ollama, models)
npm run dist:win        # Windows installer into release/
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module contracts, HTTP API, SSE events, store schema
- [docs/TOOLS.md](docs/TOOLS.md) — every tool, its parameters and policy
- [docs/MCP.md](docs/MCP.md) — connecting MCP servers, transports, troubleshooting
- [docs/PLUGINS.md](docs/PLUGINS.md) — writing a plugin
- [docs/SKILLS.md](docs/SKILLS.md) — writing a skill

## Requirements

Windows 10/11 64-bit, Node.js 20+, Ollama with at least one model.
A 7B coder model needs roughly 8 GB of RAM; `qwen2.5-coder:3b` works on modest hardware.

## Data locations

- App data: `%APPDATA%\CodeBase\data\store.json` (projects, sessions, memory, skills, MCP servers, policies, audit)
- Backups: `%APPDATA%\CodeBase\data\backups\`
- Plugins: `%APPDATA%\CodeBase\data\plugins\`
- Skills: `%APPDATA%\CodeBase\data\skills\` and `<project>\.codebase\skills\`

## Troubleshooting

- **"Ollama offline"** — CodeBase starts it automatically; if it cannot, open the Ollama app once, or set
  `OLLAMA_EXE` to your `ollama.exe`, then use Settings → *Start Ollama*.
- **The model ignores tools** — small models sometimes cannot call functions natively; CodeBase detects this
  and falls back to a text tool protocol. `qwen2.5-coder:7b` or `qwen3:4b` are the best local choices.
- **A tool asks for approval every time** — choose *Always allow* or set its policy in Tools/Settings.
- **Port conflict** — impossible by design: the backend asks the OS for a free port on every launch.

## License

MIT
