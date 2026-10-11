---
name: "performance-optimization"
description: "Measure before optimising, find the real bottleneck, and verify the improvement with numbers."
whenToUse: "the user reports slowness, high memory or long startup, or asks to optimise a hot path"
---

# Performance optimization

Goal: make a measured slow path faster, with before/after numbers, without
trading away correctness or readability.

## 0. Ground rules

- Measure first. An unmeasured optimisation is a guess and usually makes things worse.
- Optimise the biggest cost on the hot path, not the code that looks expensive.
- Correctness first: a faster wrong answer is a regression.
- Report numbers: the input size, the command, and before → after.

## 1. Define the problem in numbers

1. Ask for or find the concrete symptom: which operation, which input size,
   how slow is "slow" (milliseconds, seconds), and what is acceptable.
2. Find the invocation path: `search.files` for the entry point, `fs.read` the call
   chain from the command/endpoint down to the work.
3. Classify the workload: CPU-bound (parsing, hashing, loops), I/O-bound
   (files, network, DB), memory-bound (large buffers, leaks), or startup-bound.

## 2. Measure a baseline

1. Reproduce with a realistic input size, not with 10 rows.
2. Wall-clock with a shell loop or a short script through `shell.exec`, e.g. time
   the command three times and take the median, or `node --cpu-prof` for CPU hotspots.
3. For I/O-bound paths, count the operations: how many files opened, queries issued,
   HTTP round trips. N+1 patterns show up as counts, not as slow single calls.
4. Record the baseline and the exact command used. This is the only honest comparison.

## 3. Find the bottleneck

1. Read the hot path with `fs.read` and look for, in order:
   - work inside a loop that could be computed once (queries, `fs.stat`, regex compile, JSON parse)
   - repeated full-file or full-array scans where an index or map would do
   - synchronous I/O on a request path
   - unbounded concurrency (thousands of parallel promises) or none at all (serial awaits)
   - string concatenation in a loop over large data; `split`/`join` chains creating copies
   - copying large structures when a view or an iterator would do
   - O(n²) joins, nested filters, `Array.includes` inside a loop
2. Confirm with a measurement, not by eye: profile, or add temporary counters and
   run the baseline command again, then remove the counters.

## 4. Apply the smallest effective fix

Preferred techniques, roughly in order of payoff:

1. **Remove work** — cache a computed value, skip files that cannot match, early-return.
2. **Batch I/O** — one query instead of N, `Promise.all` for independent awaits,
   bounded concurrency (e.g. 8-16 in flight) for bulk file/network work.
3. **Change the data structure** — `Map`/`Set` for lookups, index by key instead of scanning.
4. **Stream** — process line by line or in chunks instead of loading everything.
5. **Algorithmic change** — replace O(n²) with a single pass or a sort+merge.
6. **Micro-optimisation** — only with a profile proving the line matters.

After each change: re-run the same measurement. Keep the change only if it helps.

## 5. Verify no regression

1. `tests.run` — the full suite, not just the touched files.
2. Measure the worst case, not just the happy path: largest input, empty input,
   error path (a cache must not change results when it is cold).
3. Check memory if the fix caches: is the cache bounded, and does it ever evict?
4. `git.diff` — read the final change. If it is unreadable, find a simpler form.

## Output format

```
## Problem
<operation> takes <before> on <input size> (command: `<exact command>`).

## Bottleneck
`path/to/file.js:88` — <cause, with the measurement that proves it>.

## Change
<what was changed and why it removes the cost>.

## Result
before <x ms> → after <y ms> (<z>% faster) on <same input>.
`tests.run`: <X passed, Y failed>.

## Not done
- <optimisations considered and rejected, with the reason>.
```

## Pitfalls

- Optimising without a baseline, then claiming a win you cannot measure.
- Adding a cache with no invalidation, bounding, or memory limit.
- Swapping a clear loop for clever micro-optimised code with no measured gain.
- Fixing the wrong layer: the slow part is often the DB query or the network call.
- Unbounded `Promise.all` over thousands of items, causing socket or fd exhaustion.
- Making the code concurrent and introducing a race that the tests do not catch.
- Reporting a speedup from a smaller input than the baseline used.
