---
name: "refactor-safely"
description: "Change code structure without changing behaviour, verified step by step with a rollback path."
whenToUse: "the user asks to refactor, clean up, rename, extract, split or restructure existing working code"
---

# Refactor safely

Goal: improve structure while observable behaviour stays identical, with a
verification step after every atomic change.

## 0. Ground rules

- A refactor must not change behaviour. If behaviour must change, say so and do
  that part as a separate, clearly labelled step.
- One transformation per step, then verify. Never batch rename + extract + move.
- No step is done until you have re-read the diff (`git.diff`) and re-run tests.
- If a step cannot be verified, stop and report instead of continuing.

## 1. Establish a baseline

1. `git.status` — the tree must be clean, or the user's own changes will be mixed
   into your diff. If dirty, ask before touching anything.
2. `tests.detect` to find the test command. Then `tests.run` and record the exact
   pass/fail counts. This baseline is your safety net.
3. If there are no tests: say so explicitly, keep steps tiny, and rely on
   `git.diff` review plus a manual smoke run. Never pretend the baseline was green.
4. Identify the goal in one sentence, e.g. "extract the retry policy from `client.js`
   so `upload.js` can reuse it". Anything outside that sentence is out of scope.

## 2. Map every usage before touching anything

1. `search.text` for the symbol/name across the repository, including string
   literals, configs, tests, docs and dynamic imports.
2. `fs.read` each caller to confirm the exact call signature and assumptions.
3. `search.tree` for the module layout so the new location fits conventions.
4. Write the list of call sites down. Every one must still work afterwards.

## 3. Choose the smallest transformation

Pick exactly one per step, in roughly this order of safety:

1. **Rename** a local variable / private function (no external callers).
2. **Extract** a function or constant, leaving the original call site calling it.
3. **Inline** a trivial wrapper that no longer earns its keep.
4. **Move** code to another module, re-exporting from the old path first.
5. **Change a signature** last, updating every call site found in step 2.
6. **Split** a file only when two clear responsibilities appear.

## 4. Execute one step

1. `fs.read` the exact region, then apply the edit with `fs.patch`
   (`{ path, find, replace }`). Prefer several small patches over one large rewrite.
2. Keep the diff readable: no drive-by reformatting, no reordering of unrelated code.
3. `git.diff` and read your own change as a reviewer would.
4. `tests.run`. If anything fails, revert this step
   (`git.checkout` the file, or patch it back) before continuing.

## 5. Repeat and finish

1. Loop steps 3-4 until the goal sentence from step 1 is satisfied.
2. Final `tests.run` plus one manual run of the affected entry point if feasible.
3. Report the outcome as before/after structure, not as a list of edits.

## Worked example, extract function

Before: `client.js` inlines a 40-line retry loop in `upload()`.
After: `retry(fn, { attempts, baseDelayMs })` in `client.js`, called by `upload()`.

Steps: read `client.js` → `fs.patch` to add `async function retry(...)` above →
`fs.patch` to replace the inline loop with `await retry(doUpload, { attempts: 3, baseDelayMs: 200 })`
→ `git.diff` → `tests.run`. Move `retry` to its own module only in a later step.

## Rollback

- Single file: `git.checkout` that path (or `fs.patch` the change back).
- Whole attempt: `git.checkout` the touched paths, then re-run `tests.run` to
  confirm the baseline is restored before trying a different approach.

## Output format

```
## Goal
<one sentence>.

## Baseline
`tests.run` before: <X passed, Y failed> — <command>.

## Steps taken
1. <transformation> in `path/to/file.js` — verified by <check>.
2. ...

## Call sites updated
- `path/to/other.js:31` — <what changed>.

## Result
`tests.run` after: <X passed, Y failed>. Behaviour unchanged: yes/no — <evidence>.

## Left alone
- <nearby issues noticed but out of scope>.
```

## Pitfalls

- Renaming without searching every caller first — dynamic and string-based uses break silently.
- "While I'm here" cleanups that make the diff unreviewable.
- Treating a failing pre-existing test as your regression.
- Changing public signatures and forgetting re-exports, breaking downstream imports.
- Assuming tests passed because the command did not visibly fail — read the exit output.
