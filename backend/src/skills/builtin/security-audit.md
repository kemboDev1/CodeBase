---
name: "security-audit"
description: "Audit code for exploitable weaknesses and report each with attack path, impact and a concrete fix."
whenToUse: "the user asks about security, secrets, authentication, injection, or reviews code that takes untrusted input"
---

# Security audit

Goal: find weaknesses that are actually reachable, prove the attack path, and give
a fix that does not depend on the attacker behaving nicely.

## 0. Ground rules

- Only audit code you have read with `fs.read`. Reading a file name is not auditing it.
- Every finding needs: entry point → data flow → sink → impact → fix.
  Without a reachable path it is a hardening note, not a vulnerability.
- Do not test against systems you do not own. Local code inspection and local runs only.
- Never print a discovered secret's value; report the location and the fact it leaked.

## 1. Map the attack surface

1. `search.tree` for the layout; identify the boundaries: HTTP handlers, CLI args,
   IPC handlers, file paths, plugin/skill loaders, queue consumers, webhooks.
2. `search.files` for route/controller/handler files — these take untrusted input.
3. `search.text` for the risky sinks:
   - execution: `exec(`, `spawn(`, `eval(`, `Function(`, `child_process`, `shell=True`
   - data: `query(`, `raw(`, string-built SQL, `$where`
   - paths: `readFile(`, `writeFile(`, `path.join(`, `unlink(`, archive extraction
   - web: `fetch(`, `http.get(`, redirects, `innerHTML`, `dangerouslySetInnerHTML`
   - auth: `verify`, `decode`, `jwt`, `bcrypt`, `random`, `token`, `session`
   - secrets: `password`, `api_key`, `secret`, `token`, `.env`

## 2. Check each class, in order

1. **Injection** — is user input concatenated into a command, SQL, path or template?
   Fix: parameterised queries, argument arrays (no shell string), allow-list validation.
2. **Path traversal** — does a user-supplied path get joined to a base directory and
   used without a containment check after resolution? Watch `..`, absolute paths,
   symlinks, Windows drive letters and UNC paths. Fix: resolve, then assert the
   result is inside the base (`path.relative` must not start with `..`).
3. **Authentication / authorisation** — is every sensitive endpoint authenticated,
   and does it check that *this* user owns the object (IDOR)? Is the check on the
   server, not only in the UI? Fix: deny by default, authorise on the resource.
4. **Secrets** — hardcoded keys, tokens in logs, secrets in error messages, `.env`
   committed. Fix: environment/secret store, redact in logs, rotate anything exposed.
5. **Cryptography** — home-made token formats, `md5`/`sha1` for passwords, `Math.random`
   for tokens, missing signature verification, `rejectUnauthorized: false`.
   Fix: vetted libraries, constant-time comparison, strong randomness.
6. **SSRF / outbound requests** — can a user choose the URL? Block loopback,
   link-local, private ranges and cloud metadata addresses; no redirects into them.
7. **Deserialisation / uploads** — parsing untrusted JSON/YAML/archives; zip-slip,
   prototype pollution (`__proto__`, `constructor`), unbounded decompression.
8. **Resource exhaustion** — unbounded body size, page size, recursion, regex
   backtracking (ReDoS), missing timeouts on network calls.
9. **Dependencies and config** — `fs.read` the lockfile briefly for obviously stale
   or typo-squatted packages; check CORS, debug mode, bind address and default credentials.

## 3. Confirm reachability

1. Trace from the entry point to the sink and name every function on the path.
2. Note the required preconditions (authenticated? admin? a specific config?).
3. Where it is safe and local, demonstrate with a minimal input (a crafted path or
   body) and record the observed result. Do not use real credentials or live targets.

## 4. Rate and report

Severity = impact × reachability:

- **critical** — remote code execution, auth bypass, secret exposure to an attacker.
- **high** — injection or traversal reachable by a normal authenticated user.
- **medium** — requires unusual preconditions, or leaks limited data.
- **low / note** — hardening, defence in depth, missing headers.

## Output format

```
## Findings

### [high] Path traversal in project file reader
- Location: `backend/src/agent/tools/fs.js:42`
- Entry point: `GET /api/files/read?path=...` (authenticated user)
- Data flow: `req.query.path` → `path.join(roots[0], p)` → `fs.readFile`
- Attack: `?path=../../../../Users/<user>/.ssh/id_rsa` reads outside the root
- Impact: read of arbitrary files with the server's privileges
- Fix: resolve, then `assertInside(root)`; reject `..` after normalisation
- Verified: <how, or "not executed — reasoning only">

### [note] Missing rate limit on /api/chat

## Not tested
- <areas: e.g. Electron IPC, frontend XSS, dependency CVEs>
```

## Pitfalls

- Reporting a sink without checking whether untrusted input can reach it.
- Trusting client-side validation, or a check performed only in the UI.
- Assuming `path.join` sanitises input — it does not.
- Fixing the symptom (escaping the one bad character) instead of the class.
- Printing or copying real secrets into the report or a log.
- Listing every outdated dependency as a vulnerability without a reachable path.
