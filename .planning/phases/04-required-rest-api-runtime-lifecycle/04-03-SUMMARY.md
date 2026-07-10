---
phase: 04-required-rest-api-runtime-lifecycle
plan: 03
subsystem: api
tags: [integration, node-test, compiled-process, disposable-redis, rest, graceful-shutdown, criterion-5]

# Dependency graph
requires:
  - phase: 04-required-rest-api-runtime-lifecycle (plan 01)
    provides: REST surface (POST /api/scan 202, GET /api/scan/:id 200/404, GET /health 200/503), toScanResponse state-shaped DTO
  - phase: 04-required-rest-api-runtime-lifecycle (plan 02)
    provides: raceDrain bounded drain, WorkerShutdown OnModuleDestroy, ScanRepositoryAdapter redis.quit, SHUTDOWN_GRACE_MS
  - phase: 03-scan-engine-adapters-queue-worker-service
    provides: compiled dist/worker.js, SCAN_ENGINE_TEST_FAULT seam, sample-repo.bundle fixture, scan-engine-integration.mjs harness shapes
provides:
  - "apps/api/scripts/api-integration.mjs — compiled-process + disposable-Redis integration harness (node:test)"
  - "spawnApi() helper (allocated loopback port, waitReady/waitExit/kill, baseUrl)"
  - "withHarness ctx extended with spawnApi + killRedis; spawnWorker extended with waitExit"
  - "assertCleanShutdown() — Nest-11-aware clean-SIGTERM exit assertion"
  - "test:api:integration npm script"
  - "ROADMAP Phase 4 success criterion #5 proven end-to-end over the compiled app"
affects: [phase-05-docker-compose, phase-06-graphql]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Compiled-process integration harness: spawn dist/index.js + dist/worker.js over a disposable redis:7-alpine (loopback, ephemeral port) under node:test — never Jest, never @nestjs/bullmq in-graph"
    - "Free loopback port allocation via a throwaway net server (index.ts does not echo its chosen PORT)"
    - "Observe-while-Queued ordering: POST first (no worker), start status observer, then spawn the worker so the full Queued→Scanning→Failed lifecycle is captured"
    - "Nest-11-aware clean-shutdown assertion: enableShutdownHooks re-raises the signal (useProcessExit=false) → clean exit is {code:null,signal:SIGTERM}, not {code:0}"

key-files:
  created:
    - apps/api/scripts/api-integration.mjs
  modified:
    - apps/api/package.json

key-decisions:
  - "Self-contained harness: lifted the proven Phase 3 helper shapes rather than importing from scan-engine-integration.mjs, honoring the codebase convention that each harness .mjs stands alone (Phase 3 file left untouched)"
  - "Docker Finished path seeds the Queued job directly (bundle is not an https://github.com URL and cannot pass parseGithubUrl); the REST GET boundary is what that test proves, while the API enqueue path is proven by the separate 202 test"
  - "assertCleanShutdown accepts either the Nest re-raised SIGTERM ({code:null,signal:SIGTERM}) or the Plan 02 backstop exit-0, and rejects SIGKILL (hung drain) and code:1 (a shutdown hook threw) — the correct empirical validation of A1/A2 without modifying source"

requirements-completed: [SCAN-01, SCAN-02, SCAN-03, SCAN-04, SCAN-05, API-03, ERR-05]

# Metrics
duration: 15min
completed: 2026-07-10
status: complete
---

# Phase 4 Plan 03: End-to-End REST + Runtime-Lifecycle Integration Proof Summary

**A self-contained `node:test` harness that spawns the COMPILED `dist/index.js` API and `dist/worker.js` worker over a disposable `redis:7-alpine` container and proves ROADMAP success criterion #5 end-to-end — POST→202→Queued→Scanning→Failed(clone) offline via the fault seam plus a Docker-backed Finished path, alongside 400-before-enqueue, 404, health 200/503, and empirically-validated graceful SIGTERM shutdown of both processes — never importing `@nestjs/bullmq` into Jest.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-07-10T18:08:10Z
- **Completed:** 2026-07-10T18:23:53Z
- **Tasks:** 3
- **Files modified:** 2 (1 created, 1 modified)

## Accomplishments
- `apps/api/scripts/api-integration.mjs` — a self-contained compiled-process integration harness (`node:test`, `shell:false` argv arrays, finite bounded timeouts, status-preserving `finally` teardown) that lifts the Phase 3 helper shapes and adds the API dimension.
- `spawnApi()` — allocates a free loopback port (throwaway `net` server), spawns `dist/index.js` with the boot env contract, waits for the `API HTTP listener ready` sentinel, and exposes `baseUrl`/`waitReady`/`waitExit`/`kill`. `withHarness` ctx extended with `spawnApi`/`killRedis`; `spawnWorker` extended with a bounded `waitExit` for the shutdown assertions.
- **REST contract proofs (compiled boundary):** POST valid URL → 202 `{scanId,status:'Queued'}` + a real Queued `scan:<id>` hash in Redis; the full D-02 reject matrix → 400 with **zero `scan:*` keys and an empty BullMQ queue afterward** (400-before-enqueue proven at the process boundary); GET unknown uuid → 404; `/health` 200 live then 503 `{status:'error',redis:'down',uptime}` within a bounded deadline after the disposable Redis is killed.
- **Success criterion #5 (offline, deterministic):** POST → 202 → poll `GET /api/scan/:id` → 200 `{scanId,status:'Failed',error:{category:'clone',detail}}` via the `SCAN_ENGINE_TEST_FAULT=clone` seam (worker under `NODE_ENV=test`), with the exact `Queued → Scanning → Failed` lifecycle captured — no network, no Trivy.
- **Success criterion #5 (Docker Finished):** real Docker Trivy scan of the committed `sample-repo.bundle` reaches Finished; `GET /api/scan/:id` → 200 with `criticalVulnerabilities` = the two pinned CVEs (`CVE-2019-10744`, `CVE-2021-44906`) in report order. Docker-gated: skips cleanly (never fails) if Docker is unavailable.
- **Graceful SIGTERM (ERR-05, A1/A2):** both compiled processes shut down cleanly within `SHUTDOWN_GRACE_MS` on SIGTERM — no SIGKILL, no error exit — empirically validating RESEARCH Assumptions A1 (bounded `raceDrain` coexists with `@nestjs/bullmq`'s own teardown) and A2 (`WorkerHost.worker` getter reachable at destroy).
- `test:api:integration` npm script registered next to `test:scan-engine:integration`. Full suite green (9 tests); the Phase 3 harness is untouched and still green (6 tests, no cross-file regression).

## Task Commits

Each task committed atomically:

1. **Task 1: scaffold harness + spawnApi + /health smoke; register test:api:integration** — `9b43cf2`
2. **Task 2: REST proofs — POST 202, 400-before-enqueue matrix, 404, health 503** — `2c4648a`
3. **Task 3: e2e criterion #5 (Failed + Docker Finished) + graceful SIGTERM shutdown** — `56ea40a`

**Plan metadata** (this SUMMARY + STATE + ROADMAP) committed separately.

## Files Created/Modified
- `apps/api/scripts/api-integration.mjs` (NEW) — the compiled-process + disposable-Redis integration harness: lifted helpers (`ensureBuilt`/`ensureFixture`/`assertDockerAvailable`/`startDisposableRedis`/`connectRedis`/`seedQueued`/`startStatusObserver`/`spawnWorker`/`waitTerminal`/`readCriticals`/`walkEntries`/`assertNoScanArtifacts`/`withHarness`) plus new `allocatePort`/`spawnApi`/`fetchJson`/`assertCleanShutdown` and 9 `node:test` cases.
- `apps/api/package.json` — added `"test:api:integration": "node --import tsx --test scripts/api-integration.mjs"`.

## Decisions Made
- **Self-contained harness (no cross-import).** Copied the Phase 3 helper implementations rather than importing them, matching the established convention that each `scripts/*.mjs` harness is standalone — which is precisely why `scan-engine-integration.mjs` stays untouched and un-regressed.
- **Docker Finished path seeds directly.** The `sample-repo.bundle` is a `file:`-transport path, not an `https://github.com/...` URL, so it cannot pass `parseGithubUrl` at the POST boundary. That test therefore seeds the Queued job directly and proves the **GET** boundary returns the Finished results; the API's enqueue path is proven separately by the 202 test.
- **Nest-11 clean-shutdown signature.** `assertCleanShutdown` encodes the empirically-confirmed Nest 11.1.28 behavior (re-raise the signal after hooks) and rejects the two failure signatures (SIGKILL = hung drain; `code:1` = a shutdown hook threw), giving a defensible A1/A2 validation without touching source.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected the graceful-shutdown exit assertion to Nest's real re-raise behavior**
- **Found during:** Task 3 (worker + API SIGTERM tests)
- **Issue:** The plan specified asserting `{code:0, signal:null}` for a clean SIGTERM shutdown. Empirically, both compiled processes exited with `{code:null, signal:'SIGTERM'}` (status 143). Root cause (verified in source): `@nestjs/core@11.1.28` `nest-application-context.js:197-232` runs ALL shutdown hooks (`callDestroyHook` → `WorkerShutdown` bounded drain + `redis.quit()`) and then **re-raises the received signal** via `process.kill(process.pid, signal)` because `enableShutdownHooks()` defaults to `useProcessExit:false`. A cleanly shut-down Nest app therefore exits by signal, not code 0. The prohibition forbids modifying `index.ts`/`worker.ts` to force `{code:0}`, so the assertion — not the source — was wrong.
- **Fix:** Added `assertCleanShutdown(exit,label)` accepting either the Nest re-raised SIGTERM (`{code:null,signal:'SIGTERM'}`) or the Plan 02 unref'ed backstop exit-0, and rejecting `signal:'SIGKILL'` (drain hung past grace) and `code:1` (a shutdown hook threw — i.e. A2 broken). Boundedness (A1) is enforced by `waitExit`'s timeout, which rejects if the process does not exit within `SHUTDOWN_GRACE_MS + margin`.
- **Files modified:** apps/api/scripts/api-integration.mjs
- **Commit:** `56ea40a`

**2. [Rule 1 - Bug] Fixed the offline lifecycle observer to capture Queued→Scanning→Failed**
- **Found during:** Task 3 (offline criterion #5 test)
- **Issue:** Initially the API and the fault worker were both spawned before the POST, so by the time the observer started (after the POST returned) the worker had already driven the scan past Queued/Scanning — the observer only recorded `['Failed']`.
- **Fix:** Reordered — POST first with NO worker running (scan stays Queued), start the status observer while Queued, THEN spawn the fault worker so it consumes the job and transitions Scanning→Failed. The observer now reliably records the full `['Queued','Scanning','Failed']` progression.
- **Files modified:** apps/api/scripts/api-integration.mjs
- **Commit:** `56ea40a`

**3. [Rule 1 - Bug] Silenced benign ioredis reconnect noise on the deliberate kill-Redis path**
- **Found during:** Task 2 (/health 503 test)
- **Issue:** Killing the disposable Redis while the harness's `ctx.redis` client was connected produced `[ioredis] Unhandled error event` reconnect logs (cosmetic, but noisy and potentially confusing in CI output).
- **Fix:** Attached a no-op `redis.on('error', () => {})` handler in the lifted `connectRedis()` (this harness's copy only), since the 503 case is unique to this harness.
- **Files modified:** apps/api/scripts/api-integration.mjs
- **Commit:** `2c4648a`

---

**Total deviations:** 3 auto-fixed (all Rule 1). All are corrections within this plan's own test artifact; no source files were modified and no scope creep. Deviation #1 additionally confirms the shutdown wiring from Plan 02 works correctly at runtime (hooks fire, no throw, no SIGKILL) — the exact runtime validation Plan 02 delegated here.

## Issues Encountered
- The sandbox runtime is Node v24.10.0 (the project pins `>=22 <23`). The harness runs against the COMPILED `dist/` under plain `node` (no Jest, no `@nestjs/bullmq` in a Jest graph), so the `@swc/core` miette panic is not in play; the full suite (including the real Docker Trivy scan) is green on Node 24. The pinned-Node-22 behavior is expected to be identical for these compiled-process semantics.

## Known Stubs
None — every assertion runs against the real compiled processes, real Redis, real BullMQ, and (for the Docker path) real Trivy. No placeholder/mock data.

## Threat Flags
None — no new network endpoints, auth paths, or trust boundaries introduced. The harness binds Redis to `127.0.0.1` on an ephemeral port and force-removes the container in `finally`; the NodeGoat GitHub URL is submitted only as a validation input and is never actually cloned (the offline path uses the `clone` fault; the Docker path clones only the committed local bundle over the `file` transport).

## User Setup Required
None — `npm run test:api:integration` requires only Docker (for the disposable Redis and the optional real-Trivy Finished path). The Docker Finished test skips cleanly when Docker is unavailable.

## Next Phase Readiness
- ROADMAP Phase 4 success criterion #5 is proven end-to-end against the compiled app; the compiled-process proofs delegated by Plans 01/02 (202, 400-before-enqueue, 404, health 200/503, SIGTERM clean exit) are all green.
- RESEARCH Assumptions A1 and A2 are empirically validated at runtime.
- Phase 5 (Docker packaging) can rely on the sub-10s clean stop grace (default `SHUTDOWN_GRACE_MS=8000` < Docker's 10s SIGTERM→SIGKILL window); note that a cleanly-shut-down container will report a SIGTERM (143) exit, which is the expected clean-shutdown signature, not a failure.

## Self-Check: PASSED

- Created/modified files verified present: `apps/api/scripts/api-integration.mjs`, `apps/api/package.json` (`test:api:integration` script), `04-03-SUMMARY.md`.
- Task commits verified in git history: `9b43cf2`, `2c4648a`, `56ea40a`.
- `npm run test:api:integration` → 9/9 pass; `npm run test:scan-engine:integration` → 6/6 pass (no regression); no leaked disposable Redis containers.

---
*Phase: 04-required-rest-api-runtime-lifecycle*
*Completed: 2026-07-10*
