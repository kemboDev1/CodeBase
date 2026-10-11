---
name: "git-workflow"
description: "Inspect history, stage and commit changes, branch and recover safely with git."
whenToUse: "the user asks to commit, branch, inspect history, undo a change or prepare a pull request"
---

# Git workflow

Goal: move the repository forward with small, reviewable commits and never destroy
the user's work.

## 0. Ground rules

- Never run a history-rewriting or destructive command without explicit approval:
  `reset --hard`, `push --force`, `clean -fd`, `rebase` on a shared branch,
  `branch -D`, `checkout` that discards uncommitted work.
- Never commit or push anything the user did not ask you to commit or push.
- Always inspect before acting: `git.status` and `git.diff` first, every time.
- Staging is explicit. Do not use `git.add -A` unless the user asked for everything.

## 1. Orient

1. `git.status` — current branch, staged, unstaged, untracked.
2. `git.log` — recent commit style: message format, length, language, scope prefixes.
3. `git.diff` — read what is actually changing. This is the file you are about to
   describe in the commit message.
4. If the tree contains changes unrelated to the task, ask the user before including them.

## 2. Write a good commit

1. Group changes into one logical unit: one reason to change, one commit.
2. Stage only those paths with `git.add` (`{ paths: [...] }`).
3. Verify the staged set with `git.diff` (staged) before committing.
4. Message format:
   - subject: imperative, <= 72 chars, no trailing period — `fix: reject paths outside the workspace root`
   - optional body: what changed and **why**, wrapped at 72 chars; note behaviour changes and migrations.
   - reference the issue/PR number when the user provided one.
5. `git.commit` with the message. Then `git.status` to confirm the tree state.

## 3. Branching

1. Branch from an up-to-date base. `git.branch` to create/switch:
   `feat/<short-topic>`, `fix/<short-topic>`, `chore/<short-topic>`.
2. Keep branches short-lived; one topic per branch.
3. Before a PR: `git.diff` against the base branch, re-run `tests.run`, confirm no
   debug code or unrelated files are included.

## 4. Recover without losing work

1. **Uncommitted change to discard** (single file): `git.checkout` that path —
   confirm with the user first, it is unrecoverable.
2. **Committed too early, not pushed**: prefer `git.reset --soft HEAD~1` to keep the
   changes staged, rather than a hard reset. Requires approval.
3. **Need to inspect an old version**: `git.checkout` the path at a commit into a
   temporary view, or use `git.diff <commit>..HEAD -- <path>`.
4. **Committed to the wrong branch**: create a branch at the current commit
   (`git.branch`), reset the original branch back one commit, then switch. Approval required.
5. **Lost work**: `git.log` first; reflog recovery is a last resort and needs approval.

## 5. Conflicts

1. Reproduce the conflict in a scratch state; never resolve inside the user's
   in-progress operation without telling them.
2. Read both sides in full with `fs.read`. Never accept "ours" or "theirs" wholesale.
3. Keep both intentions when they are compatible; when they are not, ask which
   behaviour wins and record the decision in the commit body.
4. After resolving: `tests.run` before continuing.

## Output format

```
## Repository state
branch: <name>; staged: <n>; unstaged: <n>; untracked: <n>.

## Action taken
- staged: <paths>
- commit: `<subject>` (<sha>)
- verification: `git.status` → <result>, `tests.run` → <result>

## Not done
- <anything deliberately left, e.g. "did not push", "did not include unrelated edits in x.js">.
```

## Pitfalls

- Committing generated files, `.env`, secrets or lockfile churn.
- Mixing a refactor and a behaviour change in one commit, making rollback impossible.
- Writing the commit message from the file names instead of from the diff.
- Force-pushing a branch others may have based work on.
- Resolving a conflict by deleting one side, silently dropping a feature.
- Running `git.add -A` in a repository with untracked work-in-progress.
