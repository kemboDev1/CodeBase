---
name: "web-research"
description: "Answer questions from the web by fetching, quoting and citing real sources instead of guessing."
whenToUse: "the request needs current facts, an external API's behaviour, a version-specific error, or documentation you cannot read locally"
---

# Web research

Goal: a sourced, current answer with working links, and a clear separation between
what a source says and what you infer.

## 0. Ground rules

- Local code and local docs win over the web. Check `search.text` and `fs.read`
  first when the question is about this repository.
- Every external claim needs a URL you actually fetched successfully.
- Fetch pages, not search summaries, before stating a fact. Titles and snippets
  are not content.
- A failed fetch is reported as failed. Never fill the gap with plausible text.

## 1. Decide whether the web is needed

1. Is the fact time-sensitive (versions, pricing, APIs, defaults, breaking changes)?
2. Is it verifiable locally (the project's own `package.json`, lockfile, `README`,
   installed types)? If yes, read it locally.
3. If neither, say what you cannot determine instead of searching for hours.

## 2. Search precisely

1. One narrow query beats five broad ones. Include the version, the exact error
   text or the exact symbol: `"ERR_MODULE_NOT_FOUND" node 24 esm`.
2. Prefer official sources: the project's docs, its repository, its changelog, the
   standard (RFC/MDN/spec) over blog posts and content farms.
3. Note candidate URLs with the reason each looks authoritative, then fetch them.

## 3. Fetch and read

1. `web.fetch` the most authoritative URL first.
2. Extract the specific passage that answers the question; keep the surrounding
   sentence so the meaning is not distorted.
3. Check the version and the date on the page. A 2019 answer for a 2024 runtime
   is usually wrong.
4. If the page is unreadable (paywall, JS-only), try the repository's raw file or
   the changelog; if it still fails, say so.
5. Cross-check any load-bearing fact against a second independent source.

## 4. Answer from the sources

1. Lead with the answer, then the evidence, then the links.
2. Quote sparingly and exactly, with the URL next to the quote.
3. Mark inference clearly: "The docs do not state this directly; based on §X it
   implies Y."
4. Record the access date when the fact could change.

## 5. Turn it into local action

1. If the research resolves a code question, apply it to the actual files with
   `fs.read`/`fs.patch` and verify with `tests.run`.
2. If the answer is durable and reusable, `memory.save` one line: the fact plus its
   source. Do not save transient details.

## Output format

```
## Answer
<2-4 sentences, direct>.

## Details
- <fact> — [source title](https://url) (accessed <date>, version <x.y>)
- <fact> — [source title](https://url)

## Confidence
<high | medium | low> — <what would raise or lower it>.

## Applied locally
- `path/to/file.js` — <change made, if any>; verified with `<command>`.
```

## Pitfalls

- Stating a fact from a search-result snippet without fetching the page.
- Missing the version: APIs and defaults change between major releases.
- Treating a blog post or an AI-generated page as a primary source.
- Citing a URL you did not open, or one that failed to fetch.
- Copying a licence-restricted block of text instead of summarising it.
- Silently using an outdated answer because it matched the question wording.
- Researching a question that the repository already answers in its own files.
