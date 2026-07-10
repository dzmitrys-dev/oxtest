---
phase: 03-scan-engine-adapters-queue-worker-service
plan: 01
subsystem: api
tags: [nestjs, bullmq, ioredis, redis, execa, queue, repository, tdd]

# Dependency graph
requires:
  - phase: 01-foundations-domain-types-strict-config
    provides: shared ScanModule DI seam, Scan/Vulnerability domain types, two-entrypoint topology, env validation
  - phase: 02-streaming-parse-pipeline-memory-proof
    provides: framework-free ReportParser async-generator contract (reused, not replaced)
provides:
  - Exact locked dependency pins (@nestjs/bullmq 11.0.4, bullmq 5.79.3, ioredis 5.11.1, execa 9.6.1)
  - Framework-free ScanRepository port + typed ScanJob queue contract + DI tokens
  - Redis-backed ScanRepositoryAdapter with atomic WATCH/MULTI/EXEC guarded transitions and seven-day TTL
  - ScanService (enqueue + full read orchestration) with no fs/child_process/engine imports
  - Shared ScanModule wiring one BullMQ producer queue consumed by both entrypoints
  - Phase 3 npm script entries (fixture/contract/integration/feasibility) for Plans 02-04
affects: [03-02, 03-03, 03-04, phase-04-api-transport]

# Tech tracking
tech-stack:
  added: ["@nestjs/bullmq@11.0.4", "bullmq@5.79.3", "ioredis@5.11.1", "execa@9.6.1"]
  patterns:
    - "Framework-free port + injectable adapter behind a Symbol DI token"
    - "Optimistic-locking (WATCH/read/guard/MULTI-EXEC/retry) for terminal-state-safe Redis writes"
    - "List sentinel at index 0 so an ordered Redis list's TTL is observable from create"
    - "Bridge library-specific DI tokens to domain-owned Symbol tokens via useExisting"

key-files:
  created:
    - apps/api/src/scan/scan.repository.port.ts
    - apps/api/src/scan/scan.repository.ts
    - apps/api/src/scan/scan.types.ts
    - apps/api/src/scan/scan.service.ts
    - apps/api/src/scan/scan.repository.spec.ts
    - apps/api/src/scan/scan.repository.redis.spec.ts
    - apps/api/src/scan/scan.service.spec.ts
  modified:
    - apps/api/package.json
    - package-lock.json
    - apps/api/src/domain/scan.types.ts
    - apps/api/src/scan/scan.module.ts

key-decisions:
  - "Structured ScanFailureReason {category, detail} in the domain; repository caps detail at 500 chars (D-20)"
  - "List sentinel element makes scan:<id>:critical TTL observable from create; get reads from index 1"
  - "ScanService injects the queue via a framework-neutral SCAN_QUEUE Symbol (bridged with getQueueToken/useExisting) instead of @InjectQueue"
  - "Deleted the Phase 1 in-memory ScanStore stub (fully replaced by the Redis repository)"

patterns-established:
  - "Port/adapter/token: framework-free interface + @Injectable adapter bound to a Symbol"
  - "Guarded Redis transition helper: WATCH hash, reject terminal, MULTI mutate + EXPIRE both keys, retry on conflict"
  - "Unit tests use an in-memory ioredis fake with real optimistic-locking + one-shot conflict injection; a real-Redis spec self-skips without REDIS_TEST_URL"

requirements-completed: [ENGINE-01, ENGINE-06, ARCH-02, ARCH-03]

coverage:
  - id: D1
    description: "Exact reviewed dependency pins locked in manifest + lockfile (@nestjs/bullmq 11.0.4, bullmq 5.79.3, ioredis 5.11.1, execa 9.6.1)"
    verification:
      - kind: automated
        ref: "node manifest+lockfile assertion + npm view (plan Task 1 verify)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Redis ScanRepository: hash/list reconstruction, ordered results, null missing read, seven-day TTL refresh on both keys, atomic terminal-guard with WATCH/MULTI/EXEC retry"
    requirement: ENGINE-06
    verification:
      - kind: unit
        ref: "apps/api/src/scan/scan.repository.spec.ts (10 tests)"
        status: pass
      - kind: integration
        ref: "apps/api/src/scan/scan.repository.redis.spec.ts (3 tests, run against disposable Redis via Docker)"
        status: pass
    human_judgment: false
  - id: D3
    description: "ScanService enqueue persists Queued then adds exactly {scanId, repoUrl}; get is a single full read preserving null; no fs/child_process/engine imports"
    requirement: ARCH-02
    verification:
      - kind: unit
        ref: "apps/api/src/scan/scan.service.spec.ts#ScanService (5 tests)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Shared ScanModule seam: one BullMQ scan queue, imported by AppModule and WorkerModule, worker root transport-free, no WorkerHost registered here"
    requirement: ARCH-03
    verification:
      - kind: unit
        ref: "apps/api/src/scan/scan.service.spec.ts#Shared module topology (3 tests)"
        status: pass
    human_judgment: false

# Metrics
duration: 40min
completed: 2026-07-10
status: complete
---

# Phase 3 Plan 01: Contracts & Durable Queue/State Seam Summary

**Redis-backed ScanRepository with atomic WATCH/MULTI/EXEC terminal guards and seven-day TTL, a queue-only ScanService, and a shared BullMQ ScanModule seam — replacing the Phase 1 in-memory ScanStore behind framework-free ports.**

## Performance

- **Duration:** ~40 min
- **Started:** 2026-07-10T12:35:00+03:00
- **Completed:** 2026-07-10T13:08:00+03:00
- **Tasks:** 3
- **Files modified/created:** 11

## Accomplishments
- Installed and locked the four approved exact dependency pins (no floating BullMQ range); added Phase 3 npm scripts for Plans 02-04.
- Implemented a Redis repository storing metadata in a hash and CRITICAL findings in an ordered list, reconstructing one complete `Scan`, returning `null` for a missing hash, refreshing a seven-day TTL on both keys atomically with every write, and guarding terminal state via WATCH/MULTI/EXEC with conflict retry (verified against a real disposable Redis).
- Implemented `ScanService.enqueue` (create Queued → add one typed `{scanId, repoUrl}` job) and `ScanService.get` (single full read), with zero filesystem/subprocess/engine coupling.
- Rewired the shared `ScanModule` to bind repository, service, parser, dedicated Redis client, and exactly one BullMQ producer queue; deleted the replaced `ScanStore`.

## Task Commits

1. **Task 1: Install reviewed dependency pins** - `120ca65` (chore)
2. **Task 2: Repository contracts + Redis persistence (TDD)** - `b36bb1e` (test, RED) → `a63ddf8` (feat, GREEN)
3. **Task 3: ScanService + shared module wiring (TDD)** - `823c1c1` (test, RED) → `fe4e138` (feat, GREEN)

_Note: pre-existing `f0074e5` (orchestrator's Task 1 verify-separator fix) preceded this plan's work._

## Files Created/Modified
- `apps/api/src/scan/scan.repository.port.ts` - Framework-free `ScanRepository` contract + `SCAN_REPOSITORY` token
- `apps/api/src/scan/scan.repository.ts` - `ScanRepositoryAdapter` (Redis hash/list, TTL, guarded transitions) + `REDIS_CLIENT` token
- `apps/api/src/scan/scan.types.ts` - `ScanJob` payload, queue/job name constants, `SCAN_QUEUE` DI token
- `apps/api/src/scan/scan.service.ts` - Enqueue + full-read orchestration
- `apps/api/src/scan/scan.module.ts` - Shared DI + BullMQ producer wiring (replaces ScanStore)
- `apps/api/src/domain/scan.types.ts` - Added structured `ScanFailureReason`; `Scan.error` now typed
- `apps/api/src/scan/*.spec.ts` - Repository unit + real-Redis integration + service/topology specs
- `apps/api/package.json`, `package-lock.json` - Locked pins + Phase 3 scripts
- `apps/api/src/scan/scan.store.ts` - **Deleted** (replaced by Redis repository)

## Decisions Made
- **Structured failure reason:** `ScanFailureReason {category, detail}` lives in the framework-free domain (D-20); the repository defensively caps `detail` at 500 chars at the persistence boundary. Category vocabulary is defined here; the normalizer that produces it (`engine/scan-error.ts`) is a later Phase 3 plan.
- **List TTL observability:** an ordered Redis list cannot be empty, so `create` seeds a sentinel at index 0 and `get` reads from index 1 — making `scan:<id>:critical` TTL observable from creation while preserving discovery order.
- **Queue injection via Symbol token:** `ScanService` injects the queue through a domain-owned `SCAN_QUEUE` Symbol bridged to BullMQ's token with `useExisting`, instead of `@InjectQueue`. This decouples the service from `@nestjs/bullmq` and — critically — keeps that library out of the jest unit path (see Issues Encountered).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Cap persisted failure detail at 500 characters in the repository**
- **Found during:** Task 2 (repository implementation)
- **Issue:** The plan/domain mandate a bounded 500-char failure detail (D-20), but the normalizer that would enforce it is owned by a later plan; an unbounded caller could persist oversized/leaky detail.
- **Fix:** `markFailed` and `serialize` slice `detail` to 500 chars before persisting.
- **Files modified:** apps/api/src/scan/scan.repository.ts
- **Verification:** `caps a persisted failure detail at 500 characters` unit test passes.
- **Committed in:** `a63ddf8`

**2. [Rule 3 - Blocking] Decouple ScanService queue injection from @nestjs/bullmq**
- **Found during:** Task 3 (service + module wiring)
- **Issue:** Any jest spec whose module graph loads `@nestjs/bullmq` aborts the process with a native `@swc/core@1.15.43`/miette panic ("Formatting argument out of range"), which would make the ScanService unit spec unrunnable.
- **Fix:** Inject the queue via a framework-neutral `SCAN_QUEUE` Symbol bridged in the module with `getQueueToken(...)` + `useExisting`, so `scan.service.ts` never imports `@nestjs/bullmq`. Idiomatic behavior and DI resolution are unchanged; the real app/build (`node dist/*.js`) uses BullMQ normally.
- **Files modified:** apps/api/src/scan/scan.service.ts, apps/api/src/scan/scan.types.ts, apps/api/src/scan/scan.module.ts
- **Verification:** service spec + full suite pass on Node 22 and Node 24; `npm run build` compiles.
- **Committed in:** `fe4e138`

**3. [Rule 1 - Bug] Tighten structural import assertions to ignore comments**
- **Found during:** Task 3 (GREEN)
- **Issue:** Initial forbidden-substring assertions matched module names appearing in explanatory comments (e.g. "must not touch node:fs"), producing false failures.
- **Fix:** Parse actual `import ... from '<spec>'` specifiers and assert on those.
- **Files modified:** apps/api/src/scan/scan.service.spec.ts
- **Verification:** all 8 service/topology tests pass.
- **Committed in:** `fe4e138`

**4. [Rule 1 - Bug] Avoid `no-unsafe-enum-comparison` on Redis status reads**
- **Found during:** Task 2 (GREEN, lint pass)
- **Issue:** Comparing a `string` read from Redis directly to `ScanStatus` enum members triggers `@typescript-eslint/no-unsafe-enum-comparison`.
- **Fix:** Compare against a `string[]` of terminal statuses.
- **Files modified:** apps/api/src/scan/scan.repository.ts
- **Verification:** `npm run lint` clean.
- **Committed in:** `a63ddf8`

---

**Total deviations:** 4 auto-fixed (2 bug, 1 missing-critical, 1 blocking). No architectural changes; no scope creep.
**Impact on plan:** All auto-fixes were necessary for correctness, security-bounding, or to make the tests runnable on the available toolchain.

## Issues Encountered

**`@swc/core@1.15.43` native panic under jest when `@nestjs/bullmq` is in the module graph.**
- Root cause: transforming/loading the `@nestjs/bullmq` graph under `@swc/jest` aborts the jest process with a native miette panic (`graphical.rs:1159 "Formatting argument out of range"`). It reproduces on **both Node 22 and Node 24** — so the STATE.md assumption that it is Node-24-only is incorrect. `bullmq` and `ioredis` imported directly do **not** trip it; only `@nestjs/bullmq` does. The code is type-correct (`tsc` passes) and the real runtime (`node dist/*.js`) is unaffected — it is purely a jest+swc tooling defect.
- Attempted `@swc/core` `overrides` pin (STATE.md's suggested remedy): npm would not honor the override for this native package without risking the freshly-locked Task 1 lockfile, so it was reverted.
- Resolution for this plan: keep `@nestjs/bullmq` out of every jest-loaded source file (Deviation 2). Verified: full suite green on Node 22 and Node 24.
- **Carried-forward blocker for Plans 02-04 / Phase 4:** the `ScanWorker` (`@Processor`/`WorkerHost` from `@nestjs/bullmq`) and any Nest `Test`-module spec that imports `ScanModule` will hit this panic under jest. Downstream plans must either (a) unit-test the worker's lifecycle logic through a plain injectable class that does not import `@nestjs/bullmq` (keeping the `@Processor` shell thin), and/or (b) resolve the `@swc/core` toolchain defect (dedicated pin/upgrade). The Plan 04 process-level integration harness runs compiled `dist/worker.js` under plain node and is unaffected.

## Known Stubs
None. The Redis repository is fully wired; `ReportParser` is the real Phase 2 implementation. No placeholder data paths introduced.

## User Setup Required
None - no new external service configuration. Redis connectivity uses the existing required `REDIS_HOST`/`REDIS_PORT` env keys; the disposable-Redis integration spec is opt-in via `REDIS_TEST_URL`.

## Next Phase Readiness
- Typed queue/repository contracts and the shared `ScanModule` seam are stable for Plans 02-04 to consume.
- Redis is the authoritative Scan state store with atomic guarded transitions and refreshed seven-day retention.
- `ScanService` is a pure queue/read orchestrator ready for the Phase 4 transport.
- **Blocker to address downstream:** the jest+`@nestjs/bullmq`+`@swc/core` panic (see Issues Encountered) constrains how the worker and module can be unit-tested.

## Self-Check: PASSED

All created files exist on disk (8 source/spec files + SUMMARY); `scan.store.ts` confirmed removed; all 5 task commits (`120ca65`, `b36bb1e`, `a63ddf8`, `823c1c1`, `fe4e138`) present in history. Full test suite: 24 passed / 3 skipped on Node 22 and Node 24; lint clean; typecheck clean; build compiles.

---
*Phase: 03-scan-engine-adapters-queue-worker-service*
*Completed: 2026-07-10*
