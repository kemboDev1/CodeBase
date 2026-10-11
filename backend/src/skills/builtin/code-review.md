---
name: "code-review"
description: "Review a diff or changed files and report prioritised, actionable findings with file:line references."
whenToUse: "the user asks for a code review, a pre-commit/pre-PR check, or a second pass over changes you just wrote"
---

# Code review

Goal: find real defects in the change set, ranked by severity, with exact
`file:line` locations and a concrete fix for each. Review the code that changed,
not the whole repository.

## 0. Ground rules

- Read the real files with `fs.read`. Never review from memory or from the diff alone.
- Never claim a check passed unless you ran the command and saw the output.
- One finding = one problem + one location + one suggested fix. No vague advice.
- If the change set is larger than ~30 files, review the highest-risk ones first
  (auth, money, data writes, concurrency, migrations) and say which you skipped.

## 1. Establish the change set

1. `git.status` — is the tree clean, and which files are modified/untracked?
2. `git.diff` — the unstaged diff. Then `git.diff` with `{ staged: true }` if needed.
3. `git.log` — if reviewing a commit, or to see how the change fits the recent history.
4. List the changed files and classify each one: source, test, config, docs, generated.

## 2. Read each changed file

1. `fs.read` every changed source file in full. Diff context hides invariants.
2. For each changed function, find its callers before judging it:
   `search.text` with the function name, `search.files` for the module path.
3. Note the project conventions from a neighbouring file of the same kind
   (error style, logging, naming, async style) so findings match house style.

## 3. Review dimensions, in priority order

1. **Correctness** — off-by-one, wrong operator, inverted condition, wrong default,
   mutation of a shared object, unawaited promise, swallowed error, incorrect timezone/encoding.
2. **Error handling** — every I/O, network, parse and DB call has a failure path;
   errors carry context; no empty `catch {}`; no partial writes left behind.
3. **Security** — untrusted input validated at the boundary, parameterised queries,
   no secrets in code or logs, path traversal blocked, authz checked on the server.
4. **Data safety** — destructive operations are reversible or guarded; migrations
   have a rollback; writes are atomic; concurrent writers cannot corrupt state.
5. **Tests** — new behaviour is covered, including one failure case; existing tests
   still describe the new behaviour (not just "still pass").
6. **Performance** — no query/loop in a loop, no unbounded growth, no
   re-computation inside a hot path, streaming where the input is large.
7. **Clarity and consistency** — names match the domain, dead code removed,
   no leftover debug output, comments explain *why* and are not stale.

## 4. Verify instead of guessing

1. `tests.detect` to learn the test command, then `tests.run` on the affected suite.
   Report the real result, including failures you did not cause.
2. When you suspect a bug but cannot prove it, say "unverified" and give the exact
   command or input that would prove it. Do not inflate suspicion into a finding.

## 5. Severity scale

- **blocker** — data loss, security hole, crash, or broken build. Must fix before merge.
- **major** — wrong behaviour in a realistic case, missing error path, race.
- **minor** — maintainability, naming, duplication, missing test for edge cases.
- **nit** — style only. Cap nits at three; do not flood the report.

## Output format

```
## Verdict
<approve | approve with changes | request changes> — one sentence why.

## Blockers
1. `path/to/file.js:42` — <problem>. Fix: <concrete change>.

## Major
2. `path/to/file.js:88` — <problem>. Fix: <concrete change>.

## Minor / Nits
3. `path/to/file.js:12` — <problem>. Fix: <concrete change>.

## Verified
- `git.diff`, `fs.read` on <files>
- `tests.run` → <pass/fail summary>

## Not reviewed
- <files or areas skipped, and why>
```

## Pitfalls

- Do not restate the diff back to the user as "changes".
- Do not request stylistic rewrites of untouched code.
- Do not mark something a blocker without naming the concrete failing input.
- Do not review generated files, lockfiles or `dist/` output; note them and move on.
- Do not approve a change you could not read in full.
