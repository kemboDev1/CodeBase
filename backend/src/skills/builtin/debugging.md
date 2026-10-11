---
name: "debugging"
description: "Find and fix the root cause of a failing program, test or runtime error instead of guessing."
whenToUse: "there is an error, stack trace, failing test, crash or wrong output to diagnose"
---

# Debugging

Goal: reproduce the failure, prove the root cause with evidence, fix that cause,
and leave a regression test behind.

## 0. Ground rules

- Reproduce before theorising. An error message you have not read is a guess.
- Change one thing at a time. Two changes at once destroy the experiment.
- Read the real code path with `fs.read`; do not reason about a file you have not opened.
- If you cannot reproduce and have no logs, ask the user for the exact command and
  the full output. Do not invent a stack trace.

## 1. Capture the failure

1. Ask for or locate the exact failing command. Then run it yourself with
   `shell.exec` (or `tests.run` for a test) and keep the full output.
2. Record: the error type, the message, the topmost frame in *your* code, the input
   that triggered it, and whether it is deterministic.
3. If the failure is intermittent, note the timing/ordering conditions and run the
   reproducer in a loop to measure how often it fails.

## 2. Locate the real code

1. `search.text` for the exact error string (strip variable parts first). Many
   messages are thrown verbatim.
2. `fs.read` the file and function from the first relevant stack frame, plus
   everything it calls on the failing path.
3. Check the inputs at that point: log the actual values with a temporary
   `shell.exec` run or a one-line debug print, then remove the print.

## 3. Form and falsify hypotheses

1. Write down 2-3 candidate causes, ordered by likelihood.
2. For the most likely one, design the *smallest* experiment that would disprove it.
   Example: hardcode the suspected bad value — if the bug disappears, the hypothesis holds.
3. Eliminate in order. When a hypothesis survives two independent experiments,
   treat it as the cause and move on.
4. Prefer evidence over intuition: a value you printed beats a pattern you recognised.

## 4. Bisect when the cause is historical

1. `git.log` to see recent commits touching the failing area.
2. Suspect the newest change first. Inspect it with `git.diff` or `git.checkout`.
3. If the regression point is unknown, test the midpoint commit (`git.checkout`)
   and halve the range until one commit remains.

## 5. Fix the root cause

1. Fix the cause, not the symptom: no `try/catch` that hides the error, no widened
   types, no sleep added to dodge a race.
2. Keep the fix minimal and local. Note anything you noticed but did not change.
3. Re-run the original reproducer and confirm the exact failure is gone.
4. Run the wider test suite with `tests.run` to check for regressions.

## 6. Lock it in

1. Add a test that fails without the fix and passes with it (`write-tests` skill).
2. Include the input that used to break, not just the happy path.
3. `memory.save` a one-line note if the root cause is a trap likely to recur.

## Common root causes to check early

- Missing `await` / unhandled promise rejection.
- Wrong value: `null` vs `undefined`, string vs number, 0-based vs 1-based index.
- Async ordering: shared state mutated by two concurrent requests.
- Environment drift: relative path resolved from the wrong cwd, missing env var,
  different Node/Python version, case-insensitive filesystem hiding a case bug.
- Stale cache or stale build output masking the edited source.
- Encoding: file written as UTF-8 read as Latin-1, CRLF vs LF in a parser.

## Output format

```
## Symptom
<command> → <exact error, first frames>.

## Reproduction
Steps and how deterministic it is.

## Root cause
`path/to/file.js:57` — <what is wrong and why it produces this symptom>.

## Fix
<diff or description of the change>.

## Verification
- reproducer now: <result>
- `tests.run`: <result>
- regression test added: `path/to/test.test.mjs` — <name>
```

## Pitfalls

- Do not "fix" by widening a type, catching everything, or retrying blindly.
- Do not delete or skip the failing test to make the suite green.
- Do not stop at the first plausible cause; confirm it with an experiment.
- Do not leave debug output, commented-out code, or temporary logging in the fix.
