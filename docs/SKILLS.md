# Writing CodeBase Agent skills

A skill is a markdown procedure document the agent loads **only when it is relevant**.
The system prompt carries one line per skill (name, description, when to use); the full
body is disclosed when the model calls `skill.load`. That keeps the context window
small and the instructions sharp.

Skills answer the question *"how does this project want this kind of work done?"* —
reviewing a diff, debugging, writing tests, answering in Uzbek. They are prose for a
small local model, so: short sentences, imperative steps, exact tool names, explicit
output format.

---

## 1. Where skills live

| Source | Location | Id |
|---|---|---|
| Builtin | `backend/src/skills/builtin/<slug>.md` | `builtin:<slug>` |
| User | `<dataDir>/skills/<slug>/SKILL.md` | `file:<slug>` |
| User (loose) | `<dataDir>/skills/<slug>.md` | `file:<slug>` |
| Project | `<project>/.codebase/skills/<slug>/SKILL.md` | `file:<slug>` |
| Imported | wherever the user pointed `importSkill` | `file:<slug>` |
| Inline | created in the UI, stored in `store.skills` | its store id |

`loadSkills({ dirs, store, logger })` reads the builtin directory first, then each
extra directory in order, then inline skills from the store. Duplicate ids keep the
first occurrence, so a builtin cannot be shadowed by a file with the same id prefix —
use your own slug. Builtin skills are seeded into the store on first run so they can
be edited and disabled; re-seeding happens when the store has none.

## 2. File format

`SKILL.md` is markdown with an optional YAML frontmatter block:

```markdown
---
name: "code-review"
description: "Review a diff or changed files and report prioritised, actionable findings with file:line references."
whenToUse: "the user asks for a code review, a pre-commit/pre-PR check, or a second pass over changes you just wrote"
---

# Code review

Goal: find real defects in the change set …
```

| Field | Required | Purpose |
|---|---|---|
| `name` | recommended | Shown in the UI and in the prompt line. Falls back to the first `# Heading`, then to the file name. |
| `description` | recommended | One sentence, ≤ 140 characters. This is what the model sees when deciding to load the skill. Falls back to the first paragraph. |
| `whenToUse` | recommended | The trigger condition, phrased from the agent's point of view. Falls back to empty. |

Another ten fields are ignored — keep it to these three. Values may be quoted or
unquoted, contain colons, or be written as `[a, b]`; CRLF, a UTF-8 BOM and
`when-to-use` / `whenToUse` / `when_to_use` spellings are all handled.

## 3. What a good skill contains

1. **Goal** — one sentence: what the finished work looks like.
2. **Ground rules** — non-negotiables (measure first, never claim an unverified result,
   never run destructive commands). Small models obey explicit rules and ignore implicit ones.
3. **Numbered procedure** — steps the agent can literally execute, each naming the
   tool: `git.status`, `git.diff`, `fs.read`, `search.text`, `tests.run`, `shell.exec`.
4. **Pitfalls** — the failure modes you have actually seen, stated as "do not …".
5. **Output format** — a fenced template the final answer must follow. This is the
   single highest-leverage section: it makes answers consistent and reviewable.

Write 40–120 lines. Use `##` sections, `-` bullets and numbered steps. No emoji,
no motivational filler, no invented tools.

### The tools the agent actually has

`fs.read` `fs.write` `fs.patch` `fs.list` · `search.text` `search.files` `search.tree` ·
`shell.exec` · `git.status` `git.diff` `git.log` `git.add` `git.commit` `git.branch`
`git.checkout` · `tests.detect` `tests.run` · `web.fetch` · `skill.load` `memory.save`.
Referencing anything else produces instructions the agent cannot follow.

Also: the model may be small (qwen2.5-coder, qwen3). Prefer explicit steps over
judgement calls, and one idea per sentence.

## 4. Complete worked example

`backend/src/skills/builtin/refactor-safely.md` (abridged) shows the shape:

```markdown
---
name: "refactor-safely"
description: "Change code structure without changing behaviour, verified step by step with a rollback path."
whenToUse: "the user asks to refactor, clean up, rename, extract, split or restructure existing working code"
---

# Refactor safely

Goal: improve structure while observable behaviour stays identical.

## 0. Ground rules

- One transformation per step, then verify. Never batch rename + extract + move.
- No step is done until you re-read `git.diff` and re-run tests.

## 1. Establish a baseline

1. `git.status` — the tree must be clean.
2. `tests.detect`, then `tests.run`; record the exact pass/fail counts.
3. If there are no tests, say so and keep steps tiny.

## 2. Map every usage before touching anything

1. `search.text` for the symbol, including tests, configs and dynamic imports.
2. `fs.read` each caller to confirm the signature.

## 4. Execute one step

1. `fs.read` the region, then `fs.patch` (`{ path, find, replace }`).
2. `git.diff` and read your own change as a reviewer would.
3. `tests.run`. If anything fails, revert this step before continuing.

## Output format

\`\`\`
## Goal
<one sentence>.
## Baseline
`tests.run` before: <X passed, Y failed>.
## Result
`tests.run` after: <X passed, Y failed>. Behaviour unchanged: yes/no — <evidence>.
\`\`\`

## Pitfalls

- Renaming without searching every caller first.
- "While I'm here" cleanups that make the diff unreviewable.
```

## 5. Importing a skill

`importSkill({ from, store, logger })` accepts:

- a local directory containing `SKILL.md`,
- a local `.md` file,
- an `https://` URL returning raw markdown.

```js
const skill = await importSkill({ from: 'C:/skills/sql-safety' });
// → { id: 'file:sql-safety', source: 'file', enabled: true, path: '…/SKILL.md', … }
```

Rejected, with a clear error: missing paths, directories without `SKILL.md`,
non-markdown files, non-`https` URLs, and URLs whose host is loopback, link-local,
private (`10/8`, `172.16/12`, `192.168/16`), `.local`, `.internal` or IPv6 ULA — the
fetch runs on the user's machine, so a remote URL must not be able to reach it.
Documents over **200 KB** (local or remote) are refused, and remote fetches time out
after 20 seconds.

Imported skills return `source: 'file'` and `enabled: true`; persist them by pushing
the object into `store.skills` and calling `saveStore()`.

## 6. The two rendering functions

```js
skillSummaryPrompt(skills)  // system-prompt block: one line per enabled skill
renderSkill(skill)          // full body for skill.load, with an id/source header
```

`skillSummaryPrompt` produces:

```
Available skills (call skill.load with the id to read the full procedure before doing the work):
- builtin:code-review — code-review: Review a diff or changed files …
  use when: the user asks for a code review …
```

Only enabled skills are advertised; `renderSkill` prepends `# name`, `id:`, `source:`,
`description:`, `use when:` and `path:` before the body, so the model can cite what it
loaded.

## 7. Security

- A skill is **instruction text, not executable code**. Nothing in a skill runs; the
  risk is prompt injection — a malicious skill telling the agent to exfiltrate files,
  disable permission prompts, or run destructive commands.
- Treat imported skills (especially remote ones) as untrusted content. Read them
  before enabling, and keep the shipped builtins as the reference style.
- Never put secrets, tokens or credentials in a skill; they are stored in plain text
  and rendered into prompts.
- A skill must not weaken the agent's safety rules. Instructions such as "skip the
  permission prompt" or "always use `--force`" are a red flag — delete the skill.
- Skills are capped at 200 KB, but a large skill still costs context on every load.
  Keep them focused; split unrelated procedures into separate skills.

## 8. Testing a skill

```powershell
node --test backend/test/skills.test.mjs
```

The suite covers frontmatter parsing (missing, CRLF, quoted, colons), builtin loading
with metadata assertions, directory loading, duplicate ids, `importSkill` success and
failure paths, and both rendering functions.
