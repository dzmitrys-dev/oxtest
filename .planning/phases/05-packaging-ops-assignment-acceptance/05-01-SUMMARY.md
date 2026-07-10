---
phase: 05-packaging-ops-assignment-acceptance
plan: 01
subsystem: logging
tags: [pino, ndjson, correlation, scanId, hardening, ops, nestjs, ioredis, joi]

# Dependency graph
requires:
  - phase: 03-scan-engine-adapters-queue-worker-service
    provides: EngineLogger port, ScanJob {scanId, repoUrl} payload, ScanEngine.run, worker.module SCAN_ENGINE factory
  - phase: 04-required-rest-api-runtime-lifecycle
    provides: GithubUrlPipe, SHUTDOWN_GRACE_MS env schema, REDIS_CLIENT factory, ScanService.enqueue
provides:
  - pino EngineLogger adapter (createBaseLogger / engineLoggerFor / resolveBaseLoggerOptions) behind the existing port
  - widened EngineLogger port (info/warn/error) with matching noop
  - per-job pino.child({scanId}) threaded through ScanWorker.process into engine.run
  - shared BASE_LOGGER DI token (ndjson base logger) injected into both API and worker
  - API 'scan queued' ndjson enqueue line carrying scanId + repoUrl as structured fields
  - WR-01 canonical GitHub URL pipe, WR-02 SHUTDOWN_GRACE_MS max 9000, WR-03 REDIS_CLIENT error listener
affects: [packaging, docker, acceptance-gate, ci, onboarding-docs]

# Tech tracking
tech-stack:
  added: [pino@10.3.1 (dependency), pino-pretty@13.1.3 (devDependency, dev-only)]
  patterns:
    - "pino adapter behind hexagonal EngineLogger port — no pino imports in the domain engine"
    - "payload-carried scanId correlation via pino.child({scanId}) — never ALS across the Redis hop"
    - "ndjson-only in container/prod; pino-pretty transport gated behind NODE_ENV==='development'"
    - "structured pino fields for untrusted repoUrl (never string-interpolated) — log-injection guard"

key-files:
  created:
    - apps/api/src/engine/pino-logger.adapter.ts
    - apps/api/src/engine/pino-logger.adapter.spec.ts
  modified:
    - apps/api/src/engine/scan-engine.ts
    - apps/api/src/engine/scan-worker.ts
    - apps/api/src/worker.module.ts
    - apps/api/src/scan/scan.service.ts
    - apps/api/src/scan/scan.service.spec.ts
    - apps/api/src/scan/scan.module.ts
    - apps/api/src/scan/scan.types.ts
    - apps/api/src/http/validation/github-url.pipe.ts
    - apps/api/src/http/validation/github-url.spec.ts
    - apps/api/src/config/env.validation.ts
    - apps/api/src/config/env.validation.spec.ts
    - apps/api/package.json

key-decisions:
  - "BASE_LOGGER DI token declared in scan/scan.types.ts (framework-free tokens home), NOT in engine/, so ScanService can inject it without crossing the engine/ import boundary its ARCH-02 spec forbids"
  - "createBaseLogger takes an optional DestinationStream (testability affordance); DI wiring always calls it with no arg (stdout ndjson)"
  - "resolveBaseLoggerOptions extracted as a pure function so the dev-vs-prod transport gate is unit-testable without spawning a pino-pretty worker thread"
  - "worker-side fallback EngineLogger bound to scanId='worker' also serves as the fault-seam WARN sink (structurally a FaultSeamLogger) — no NestJS Logger constructed for engine lifecycle anymore"

patterns-established:
  - "Pattern 1: pino adapter satisfying the widened EngineLogger port (framework-free, Jest-safe)"
  - "Pattern 2: per-job pino.child({scanId}) built at the top of process(job) and passed to engine.run(job, logger)"

requirements-completed: [OPS-04]

coverage:
  - id: D1
    description: "pino EngineLogger adapter: createBaseLogger (ndjson default, pino-pretty only under NODE_ENV=development), engineLoggerFor binds scanId as a structured pino child field for info/warn/error"
    requirement: "OPS-04"
    verification:
      - kind: unit
        ref: "src/engine/pino-logger.adapter.spec.ts (8 cases: transport gating, ndjson validity, scanId child binding)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Widened EngineLogger port (info/warn/error + noop); ScanEngine.run(job, logger?) resolves a per-job logger and emits scanId'd lifecycle info lines at scanning/clone/trivy/parse/finished"
    requirement: "OPS-04"
    verification:
      - kind: unit
        ref: "src/engine/scan-engine.spec.ts (run lifecycle + failure/cleanup swallow with widened port)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Shared BASE_LOGGER token provided/exported by ScanModule; ScanWorker builds engineLoggerFor(base, scanId) per job; ScanService emits one structured 'scan queued' ndjson line with scanId + repoUrl"
    requirement: "OPS-04"
    verification:
      - kind: unit
        ref: "src/scan/scan.service.spec.ts#emits exactly one structured ndjson enqueue line carrying scanId + repoUrl"
        status: pass
      - kind: other
        ref: "npm run build → dist/index.js + dist/worker.js compile; grep scan-worker in specs → none"
        status: pass
  - id: D4
    description: "Cross-process scanId join: worker lifecycle lines + API enqueue line share one scanId in ndjson stdout"
    requirement: "OPS-04"
    verification: []
    human_judgment: true
    rationale: "End-to-end cross-process ndjson join proof is asserted in Plan 03's acceptance harness against booted dist/index.js + dist/worker.js; this plan only ships the seam, verified structurally here."
  - id: D5
    description: "WR-01: GithubUrlPipe returns the canonical https://github.com/{owner}/{repo} (strips .git, normalizes www. host + trailing slash) so the enqueued/cloned URL equals the validated form"
    requirement: "OPS-04"
    verification:
      - kind: unit
        ref: "src/http/validation/github-url.spec.ts (WR-01 .git / www. / trailing-slash canonicalization + round-trip cases)"
        status: pass
    human_judgment: false
  - id: D6
    description: "WR-02: SHUTDOWN_GRACE_MS Joi max lowered 60000 → 9000 (9001 rejected, 9000 accepted, 8000 default) so the drain window closes before Docker's 10s SIGKILL"
    requirement: "OPS-04"
    verification:
      - kind: unit
        ref: "src/config/env.validation.spec.ts (SHUTDOWN_GRACE_MS bound: 9000 accepted, 9001 rejected, 8000 default)"
        status: pass
    human_judgment: false
  - id: D7
    description: "WR-03: REDIS_CLIENT factory attaches a non-throwing 'error' listener so a Redis drop cannot raise an unhandled 'error' and crash the process"
    requirement: "OPS-04"
    verification:
      - kind: other
        ref: "grep client.on('error' apps/api/src/scan/scan.module.ts (grep-gated — scan.module imports @nestjs/bullmq, cannot be Jest-tested without the miette panic)"
        status: pass
    human_judgment: false

# Metrics
duration: 13min
completed: 2026-07-10
status: complete
---

# Phase 5 Plan 01: scanId-correlated pino logging + Phase-4 hardening Summary

**pino adapter behind the existing EngineLogger port with per-job `pino.child({ scanId })` threaded through the worker and a scanId'd API enqueue line — ndjson-only, no shipped transport — plus the WR-01/WR-02/WR-03 review hardening fixes folded in.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-07-10T20:07:36Z
- **Completed:** 2026-07-10T20:20:58Z
- **Tasks:** 3
- **Files modified:** 13 (2 created, 11 modified)

## Accomplishments
- pino adapter (`createBaseLogger`, `engineLoggerFor`, `resolveBaseLoggerOptions`) satisfying a widened `EngineLogger` port — the domain engine imports nothing from pino; ndjson to stdout in prod/container/CI, `pino-pretty` transport ONLY under `NODE_ENV==='development'` (never shipped in the image).
- `EngineLogger` port widened with `info` (+ matching noop); `ScanEngine.run(job, logger?)` resolves a per-job logger and emits scanId'd lifecycle info lines at each transition (scanning → clone → trivy → parse → finished).
- Shared `BASE_LOGGER` DI token provided/exported by `ScanModule` and injected into BOTH `ScanService` (API enqueue line) and `ScanWorker` (per-job `pino.child({ scanId })`), so API and worker lines are joinable by scanId.
- API emits one structured ndjson `scan queued` line carrying `scanId` + `repoUrl` as pino fields (never interpolated — log-injection guard).
- Three Phase-4 review warnings closed (D-13): WR-01 canonical URL pipe, WR-02 SHUTDOWN_GRACE_MS max 9000, WR-03 non-throwing REDIS_CLIENT error listener.
- `pino@10.3.1` pinned as a dependency (already resident transitively via Fastify), `pino-pretty@13.1.3` as a devDependency only.

## Task Commits

1. **Task 1: pino adapter + widened EngineLogger port + pino pin** (TDD)
   - `3da3812` test — failing adapter spec + widened port + RED stub
   - `2c33fac` feat — adapter implementation + per-job logger threading in run()
2. **Task 2: thread pino.child({scanId}) through worker + API enqueue line**
   - `362eb18` feat
3. **Task 3: fold WR-01/WR-02/WR-03 hardening fixes** (TDD)
   - `0348b8c` test — failing WR-01 canonicalization + WR-02 grace-bound cases
   - `da3422e` fix — canonical URL, grace cap 9000, Redis error listener

_TDD tasks (1, 3) have test → feat/fix commit pairs._

## Files Created/Modified
- `apps/api/src/engine/pino-logger.adapter.ts` (new) - pino base logger + scanId-bound EngineLogger adapter
- `apps/api/src/engine/pino-logger.adapter.spec.ts` (new) - Jest-safe unit spec of the pure mapping
- `apps/api/src/engine/scan-engine.ts` - widened EngineLogger port + `run(job, logger?)` + lifecycle info lines
- `apps/api/src/engine/scan-worker.ts` - inject BASE_LOGGER, build per-job child logger in `process(job)`
- `apps/api/src/worker.module.ts` - SCAN_ENGINE factory draws fallback + fault-seam logger from injected base pino logger; inline NestJS Logger block removed
- `apps/api/src/scan/scan.service.ts` - inject BASE_LOGGER, emit structured enqueue line
- `apps/api/src/scan/scan.service.spec.ts` - fake pino logger + enqueue-line assertion
- `apps/api/src/scan/scan.module.ts` - provide/export BASE_LOGGER; WR-03 Redis error listener
- `apps/api/src/scan/scan.types.ts` - framework-free BASE_LOGGER DI token
- `apps/api/src/http/validation/github-url.pipe.ts` - WR-01 canonical URL return
- `apps/api/src/http/validation/github-url.spec.ts` - WR-01 canonicalization cases
- `apps/api/src/config/env.validation.ts` - WR-02 SHUTDOWN_GRACE_MS max 9000
- `apps/api/src/config/env.validation.spec.ts` - WR-02 bound cases
- `apps/api/package.json` - pin pino + pino-pretty

## Decisions Made
- **BASE_LOGGER token lives in `scan/scan.types.ts`, not `engine/`.** `ScanService`'s ARCH-02 spec asserts its imports never touch `engine/`; declaring the token in the existing framework-free tokens file (alongside `SCAN_QUEUE`) keeps the service compliant while both API and worker share one base logger. (See Deviations.)
- **`createBaseLogger(destination?)` optional param + extracted `resolveBaseLoggerOptions`.** Lets the unit spec capture ndjson output via an in-memory sink and assert the transport gate without spawning a pino-pretty worker thread. DI wiring always calls `createBaseLogger()` with no arg.
- **Fallback engine logger bound to `scanId='worker'` doubles as the fault-seam WARN sink.** Since the worker always injects a per-job logger, this only backs the singleton default; no NestJS `Logger` is constructed for engine lifecycle anymore, honoring D-Fastify (no double-pino).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] BASE_LOGGER token relocated out of `engine/` to satisfy ScanService's import ban**
- **Found during:** Task 2 (threading the shared logger)
- **Issue:** The plan says to add the `BASE_LOGGER` token but does not name its file. Placing it in `engine/pino-logger.adapter.ts` (the natural home) would force `ScanService` to import from `engine/`, which `scan.service.spec.ts`'s ARCH-02 test explicitly forbids (`specifiers ... engine/` must be false).
- **Fix:** Declared `export const BASE_LOGGER = Symbol('BASE_LOGGER')` in `apps/api/src/scan/scan.types.ts` (the existing framework-free DI-token home, alongside `SCAN_QUEUE`). `scan.module.ts` imports the factory `createBaseLogger` from the adapter and the token from `scan.types`.
- **Files modified:** apps/api/src/scan/scan.types.ts (not in the plan's `files_modified` list)
- **Verification:** `scan.service.spec.ts` ARCH-02 import test passes; typecheck + full lint + full Jest suite green.
- **Committed in:** 362eb18 (Task 2 commit)

**2. [Rule 2 - Missing Critical] Added `info` to the worker.module inline EngineLogger during Task 1**
- **Found during:** Task 1 (port widening)
- **Issue:** Widening the port broke `npm run typecheck` because `worker.module.ts`'s inline `EngineLogger` implementer lacked `info` — but that inline block belongs to Task 2. Task 1's acceptance criterion requires typecheck to exit 0.
- **Fix:** Added a minimal `info: (m) => nestLogger.log(m)` to the inline logger so all implementers compile in Task 1; the entire inline block was then replaced by the pino-backed logger in Task 2.
- **Files modified:** apps/api/src/worker.module.ts
- **Verification:** `npm run typecheck` exits 0 after the change.
- **Committed in:** 2c33fac (Task 1 GREEN commit)

**3. [Rule 3 - Blocking] Reworded an adapter-spec comment to keep the WR-2/scan-worker grep gate clean**
- **Found during:** Task 2 (verification)
- **Issue:** A doc comment in `pino-logger.adapter.spec.ts` contained the literal string `scan-worker.ts`, tripping the acceptance grep `grep -rn "scan-worker" src --include=*.spec.ts` (which must return nothing) even though it was a comment, not an import.
- **Fix:** Reworded the comment to "the BullMQ WorkerHost file" so the grep gate is genuinely clean.
- **Files modified:** apps/api/src/engine/pino-logger.adapter.spec.ts
- **Verification:** grep returns nothing; spec still passes.
- **Committed in:** 362eb18 (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (2 blocking, 1 missing-critical)
**Impact on plan:** All auto-fixes necessary to satisfy the plan's own acceptance criteria (import boundary, typecheck-0, grep gate). No scope creep — no behavior beyond the specified logging seam and the three folded hardening fixes.

## Issues Encountered
- **First GREEN commit for Task 1 initially captured only `package-lock.json`.** A `git add` invocation included an out-of-repo relative pathspec (`../../package-lock.json`) which caused git to abort staging the whole set. Detected immediately via `git show --stat`; corrected with `git commit --amend` (the commit was still HEAD, no history rewrite of pushed work). Final commit `2c33fac` contains all five intended files.

## User Setup Required
None - no external service configuration required. (`pino`/`pino-pretty` install via `npm ci`; both `OK` in the RESEARCH Package Legitimacy Audit.)

## Next Phase Readiness
- The logging seam is in place: worker threads a per-job `pino.child({ scanId })` and the API emits a scanId enqueue line — both ndjson, joinable by scanId. The end-to-end cross-process join proof (D4) is owned by Plan 03's acceptance harness.
- D-13 hardening closed, unblocking the compose/ops story (Plan 02) and the acceptance gate (Plan 03): WR-02's 9000 cap makes the compose shutdown drain auditable, WR-03 makes the shared Redis client compose/reconnect-resilient, WR-01 makes the enqueued/cloned URL provably canonical.
- No transport ships in the container image, protecting the graded RSS budget verified in Plan 02/03.

## Self-Check: PASSED

- Created files verified on disk: `pino-logger.adapter.ts`, `pino-logger.adapter.spec.ts`, `scan.types.ts` (BASE_LOGGER token) — all FOUND.
- Task commits verified in git log: `3da3812`, `2c33fac`, `362eb18`, `0348b8c`, `da3422e` — all FOUND.
- Overall verification green: typecheck 0, lint 0, build emits `dist/index.js` + `dist/worker.js`, Jest 147 passed / 3 skipped with NO `@swc/core` miette panic; transport only in the dev branch; no FastifyAdapter double-pino; `scan-worker` in zero specs.

---
*Phase: 05-packaging-ops-assignment-acceptance*
*Completed: 2026-07-10*
