---
name: "write-tests"
description: "Add meaningful automated tests that match the project framework and actually run green."
whenToUse: "the user asks for tests, coverage of new or fixed code, or a regression test"
---

# Write tests

Goal: tests that fail when the behaviour breaks, written in the framework already
used by the project, and verified by running them.

## 0. Ground rules

- Never claim a test passes without running it and reading the output.
- Test observable behaviour, not private internals. Renaming an internal variable
  must not break a test.
- One behaviour per test. A test that asserts five things hides which one broke.
- No real network, no real clock, no `Math.random` in assertions, no dependencies
  on files outside the repo or the temp directory.

## 1. Detect the framework

1. `tests.detect` — the fastest signal for the test command.
2. `fs.read` `package.json` / `pyproject.toml` / `Cargo.toml` to confirm the runner
   and the scripts.
3. `search.files` for `*.test.*`, `*.spec.*`, `test_*.py`; `fs.read` one existing
   test to copy its style, imports and helpers.
4. If there is no framework: use Node's built-in runner, `node --test` with
   `node:assert/strict` — zero new dependencies. Name files `*.test.mjs` under
   `backend/test/` next to the code they cover.

## 2. Define the cases before writing code

For the unit under test, list:

1. **Happy path** — the normal call, asserted on the returned value.
2. **Boundaries** — empty input, single item, maximum size, zero, negative, off-by-one.
3. **Invalid input** — wrong type, missing field, malformed string. Assert the exact error.
4. **Failure paths** — missing file, rejected promise, timeout, permission denied.
5. **Regression** — one case per bug fixed, using the exact input that used to break.

Skip what the code cannot do; do not pad with trivial assertions.

## 3. Write the test

1. Arrange / Act / Assert, visually separated by blank lines.
2. Give the test a name that states the behaviour:
   `rejects a path outside the workspace root`, not `test path 2`.
3. Filesystem tests: create a temp directory with `fs.mkdtemp(path.join(os.tmpdir(), 'prefix-'))`
   and remove it in a `t.after(...)` hook. Never write into the user's project.
4. Time and randomness: inject them, or assert on shape (`typeof`, range) instead of value.
5. Async: always `await` the promise under test. Use `assert.rejects` for expected failures.
6. Keep fixtures inline and small. A shared fixture that needs decoding defeats the test.

## 4. Run and iterate

1. `tests.run` and read the real output.
2. If a test fails, decide which is wrong — the test or the code — before editing.
   A test that fails "because the code is buggy" is a finding, not a test to weaken.
3. If the whole test does not fail when you break the code, the test is worthless:
   temporarily break the behaviour, watch it fail, restore the code.
4. Confirm the new tests run alongside the existing suite without leaks
   (open handles, temp files, shared global state).

## 5. Report

State the file added, the command run, and the real result. Never write
"all tests pass" without the counts.

## Output format

```
## Added
- `path/to/thing.test.mjs` — <n> tests covering <list>.

## Command
`<exact command>`

## Result
<X passed, Y failed> — <notable output>.

## Not covered
- <behaviour left untested and why>.
```

## Pitfalls

- Asserting implementation details (call counts on internals) instead of outcomes.
- Copying the implementation into the test, so both share the same bug.
- Snapshot tests as a substitute for assertions about behaviour.
- `assert.ok(result)` where a precise value or error message is available.
- Forgetting cleanup, leaving temp files or open server handles that hang the runner.
- Adding a dependency for a runner the project does not already use.
