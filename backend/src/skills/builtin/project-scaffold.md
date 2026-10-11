---
name: "project-scaffold"
description: "Create a new project or module with a runnable structure, minimal dependencies and a first passing test."
whenToUse: "the user asks to start a new project, bootstrap an app, scaffold a module, or set up a repo skeleton"
---

# Project scaffold

Goal: a project that runs, installs nothing unnecessary, and has one passing test
before any feature work starts.

## 0. Ground rules

- Ask at most one round of questions up front, then proceed with sensible defaults
  and state them.
- Prefer the platform's built-in capabilities over frameworks the user did not ask for.
- Do not run `npm install` (or any installer) unless the user explicitly asks.
- Do not create files outside the requested project directory.

## 1. Clarify in one round

1. What is it: CLI, library, HTTP API, desktop app, script?
2. Language and runtime (default: Node.js, ESM, current LTS+).
3. Where should it live, and should it be a git repository?
4. Anything fixed: package name, licence, target platform, existing repo conventions?

If the answer is "just do it", choose: Node ESM, no build step, `node --test`,
`src/` + `test/`, `README.md`, `.gitignore`, MIT licence absent unless asked.

## 2. Inspect before creating

1. `fs.list` or `search.tree` the target directory — never overwrite existing work.
2. If a repo exists, `fs.read` its `package.json`/`pyproject.toml` and copy its
   conventions: script names, folder layout, formatting style.
3. Decide the dependency list and keep it empty or minimal. Every dependency must
   justify itself in one sentence.

## 3. Create the skeleton

1. Entry point with a single clear responsibility:
   - CLI: `bin/<name>.mjs` parsing argv and calling `src/main.js`
   - library: `src/index.js` with explicit named exports
   - API: `src/server.js` exporting a `createServer()` plus a thin `start` script
2. Configuration: read from environment variables with defaults in one `config.js`.
   No secrets in code; add `.env.example` if env vars are required.
3. Errors: one error module or a documented convention; never `throw "string"`.
4. `.gitignore` covering `node_modules/`, build output, logs, `.env`, editor folders.
5. `README.md`: what it is, install, run, test, configuration table, layout.
6. `package.json`: `"type": "module"`, scripts `start`, `dev`, `test`, private flag
   unless it is published.

## 4. Make it runnable and verifiable

1. Write one real test in `test/` using the project's runner (default `node --test`).
2. Run it with `shell.exec` and fix it until it passes. A scaffold with a failing
   test is not a scaffold.
3. Run the entry point once (`node src/server.js` or the CLI with `--help`) and
   confirm the expected output. Kill any server you started.
4. If it is a git repository: one commit — `chore: scaffold <name>` — with the
   structure and the passing test. Do not commit unless the user asked.

## 5. Hand off

Report the tree, the exact run/test commands, the assumptions you made, and the
first three things you would build next. Keep it short.

## Default layout

```
<name>/
  src/            application code
  test/           tests next to the behaviour they cover
  scripts/        build or maintenance scripts (only if needed)
  docs/           design notes (only if needed)
  .gitignore
  .env.example
  README.md
  package.json
```

## Output format

````
## Created
```
<tree of files, one level deep>
```

## Commands
- run: `<command>`
- test: `<command>` → <X passed, Y failed>

## Assumptions
- <language/runtime/layout choices you made without being told>.

## Next steps
1. <first feature>
2. <second>
3. <third>
````

## Pitfalls

- Scaffolding a framework the user did not ask for, then explaining the framework.
- Adding a build step, bundler, linter and test framework before the first feature.
- Creating files in the wrong directory or over an existing project.
- Claiming the app runs without having executed the command.
- Leaving a background server process alive after the smoke test.
- Seeding the scaffold with placeholder business logic instead of a real entry point.
- Committing or pushing without being asked.
