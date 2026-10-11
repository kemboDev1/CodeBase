---
name: "explain-code"
description: "Explain unfamiliar code accurately, from a quick orientation to a line-by-line walkthrough."
whenToUse: "the user asks what some code does, how a module works, why it is written that way, or to onboard onto a repository"
---

# Explain code

Goal: an accurate explanation grounded in the files you actually read, at the depth
the user asked for, in the user's language.

## 0. Ground rules

- Read the code before explaining it. `fs.read` every file you describe.
- Never invent behaviour. If a function's purpose is unclear, say so and list what
  you verified and what remains uncertain.
- Match the requested depth. "What does this do?" gets 5 lines, not 500.
- Answer in the user's language; keep identifiers, file paths and commands verbatim.

## 1. Scope the question

1. Which file, function, module, or flow? If the user pasted code, explain that code
   and find its home with `search.text` if it looks excerpted.
2. Which depth: one-line purpose, contract-level, or line-by-line?
3. If the request is ambiguous ("explain the backend"), ask one short clarifying
   question OR pick the entry point and state your choice in one line.

## 2. Read the real thing

1. `fs.read` the target file in full. Skimming produces confident nonsense.
2. `search.text` for the exports and main symbols to find callers and callees;
   `fs.read` the two or three most relevant ones.
3. `search.files` for related modules (types, config, tests). Tests often state the
   intended contract more clearly than the implementation.
4. Note the runtime facts that change the explanation: version-specific APIs,
   framework conventions, environment variables read, feature flags.

## 3. Build the explanation in layers

1. **Purpose** — one sentence: what problem this solves and where it sits in the flow.
2. **Contract** — inputs, outputs, side effects, errors thrown, invariants.
3. **Flow** — the ordered steps of the happy path, naming the functions involved.
4. **Details** — the non-obvious lines: why this order, why this data structure,
   why this error handling, what the guard protects against.
5. **Edges** — failure paths, empty input, concurrency, limits, what is not handled.

## 4. Make it verifiable

1. Point at exact locations: `path/to/file.js:42` for each claim worth checking.
2. Include a minimal usage example (real call with real argument shapes), taken from
   an existing caller or test when one exists.
3. If something is a bug or a smell, say it in a separate "Observations" line; do not
   smuggle an opinion into the description of what the code does.
4. Do not claim the code runs, or that a branch is dead, without evidence from the code.

## 5. Close with orientation (only if useful)

Offer a reading order for the surrounding module: which file to open first, which
second, and which files are leaf utilities that can be skipped.

## Output format

```
## What it is
<one or two sentences>.

## Where it lives
- `path/to/file.js` — <role>
- called from `path/to/caller.js:31`

## Contract
- input: <shape>
- returns: <shape>
- side effects: <files, network, state>
- errors: <when it throws/returns an error>

## How it works
1. <step> (`path/to/file.js:12`)
2. <step> (`path/to/file.js:30`)

## Non-obvious details
- `path/to/file.js:57` — <why this is written this way>.

## Example
```<language>
<minimal real usage>
```

## Observations
- <optional: bug, smell, unclear intent — clearly marked as opinion>.
```

## Pitfalls

- Describing what the name suggests instead of what the code does.
- Restating every line for a high-level question, burying the answer.
- Inventing library behaviour you did not verify; say "not verified" instead.
- Mixing explanation with criticism so the user cannot tell fact from opinion.
- Translating identifiers or file paths into the user's language, making them unusable.
- Explaining an older copy: confirm the file you read is the one in use.
