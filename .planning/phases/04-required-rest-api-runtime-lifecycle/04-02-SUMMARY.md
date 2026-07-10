---
phase: 04-required-rest-api-runtime-lifecycle
plan: 02
subsystem: infra
tags: [nestjs, bullmq, ioredis, graceful-shutdown, lifecycle, joi]

# Dependency graph
requires:
  - phase: 03-scan-engine-adapters-queue-worker-service
    provides: ScanWorker (WorkerHost), ScanRepositoryAdapter + REDIS_CLIENT, WorkerModule
  - phase: 04-required-rest-api-runtime-lifecycle (plan 01)
    provides: REST surface + enableShutdownHooks() on both entrypoints
provides:
  - "raceDrain(worker, graceMs): pure, Jest-safe bounded-drain primitive ('drained'|'forced')"
  - "WorkerShutdown OnModuleDestroy provider: bounded worker drain + Redis quit on SIGTERM/SIGINT"
  - "ScanRepositoryAdapter OnModuleDestroy -> redis.quit() on BOTH API and worker processes"
  - "SHUTDOWN_GRACE_MS Joi env key (integer 0..60000, default 8000)"
affects: [phase-05-packaging, docker-compose, container-stop-grace, phase-03-integration-harness]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Bounded graceful drain: race worker.close() vs SHUTDOWN_GRACE_MS, force-close via close(true) on timeout"
    - "Pure lifecycle LOGIC (raceDrain) unit-tested with a structural fake; @nestjs/bullmq-adjacent WIRING isolated from Jest"
    - "Nest lifecycle hooks (OnModuleDestroy) for all shutdown; no hand-rolled process.on() handlers"
    - "Guarded idempotent quit() on a shared ioredis client closed by multiple hooks"

key-files:
  created:
    - apps/api/src/lifecycle/drain.ts
    - apps/api/src/lifecycle/drain.spec.ts
    - apps/api/src/lifecycle/worker-shutdown.provider.ts
  modified:
    - apps/api/src/config/env.validation.ts
    - apps/api/src/scan/scan.repository.ts
    - apps/api/src/worker.module.ts

key-decisions:
  - "raceDrain is a pure function typed against { close(force?): Promise<void> } — zero bullmq/@nestjs/bullmq import, so it is unit-tested without triggering the @swc/core miette panic"
  - "Both WorkerShutdown and ScanRepositoryAdapter close the SAME shared REDIS_CLIENT; both quit() calls are guarded (status !== 'end' + catch) to prevent a double-quit crash on worker shutdown"
  - "Added an unref'ed process.exit(0) backstop at graceMs + 500ms (Assumption A1) so a pathological teardown hang can never outlast Docker's SIGKILL window"
  - "Nest tears down WorkerModule before the shared ScanModule, so WorkerShutdown drains-then-quits first and the repository's guarded quit no-ops on the worker"

patterns-established:
  - "Bounded drain primitive: race close() against a grace timer, clearTimeout on both paths, force-close on elapse"
  - "Lifecycle logic/wiring split to dodge the Jest @nestjs/bullmq panic (mirrors engine/scan-worker.ts convention)"

requirements-completed: [ERR-05]

coverage:
  - id: D1
    description: "raceDrain returns 'drained' on a fast close (no force) and 'forced' on timeout (close(true) called exactly once), clearing the grace timer"
    requirement: "ERR-05"
    verification:
      - kind: unit
        ref: "apps/api/src/lifecycle/drain.spec.ts#raceDrain"
        status: pass
    human_judgment: false
  - id: D2
    description: "raceDrain imports neither bullmq nor @nestjs/bullmq (Jest-safe); full unit suite runs without the @swc/core miette panic"
    requirement: "ERR-05"
    verification:
      - kind: unit
        ref: "apps/api/src/lifecycle/drain.spec.ts#imports neither bullmq nor @nestjs/bullmq"
        status: pass
      - kind: unit
        ref: "cd apps/api && npx jest (131 passed, no native panic)"
        status: pass
    human_judgment: false
  - id: D3
    description: "SHUTDOWN_GRACE_MS validated by Joi (integer, min 0, max 60000, default 8000), fail-closed"
    requirement: "ERR-05"
    verification:
      - kind: unit
        ref: "apps/api/src/config/env.validation.ts (compiled + typecheck); npm run typecheck"
        status: pass
    human_judgment: false
  - id: D4
    description: "WorkerShutdown drives the bounded drain then quits Redis; ScanRepositoryAdapter quits Redis on both processes; wired via Nest hooks and registered in WorkerModule"
    requirement: "ERR-05"
    verification:
      - kind: unit
        ref: "cd apps/api && npm run build (dist/worker.js registers WorkerShutdown; dist/scan/scan.repository.js has onModuleDestroy->quit)"
        status: pass
    human_judgment: true
    rationale: "Runtime SIGTERM-mid-scan drain/force + clean exit-within-grace is proven end-to-end only by the Plan 03 compiled-process harness (Assumptions A1/A2); this plan proves compilation + wiring + no-panic, not runtime signal behavior."

# Metrics
duration: 8min
completed: 2026-07-10
status: complete
---

# Phase 4 Plan 02: Runtime Lifecycle — Graceful Shutdown Summary

**Bounded graceful worker drain (`raceDrain` racing BullMQ `worker.close()` against `SHUTDOWN_GRACE_MS`, force-closing on timeout) plus `onModuleDestroy` Redis-quit on both processes, wired entirely through Nest lifecycle hooks.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-07-10T17:54:38Z
- **Completed:** 2026-07-10T18:03:05Z
- **Tasks:** 2
- **Files modified:** 6 (3 created, 3 modified)

## Accomplishments
- Pure, Jest-safe `raceDrain(worker, graceMs)` primitive that bounds BullMQ's untimed `worker.close()` and force-closes via `close(true)` past the grace — unit-tested against a structural fake with zero `@nestjs/bullmq` import (dodges the `@swc/core` miette panic).
- `WorkerShutdown` `OnModuleDestroy` provider: drains the live worker (via `WorkerHost.worker`) bounded by `SHUTDOWN_GRACE_MS`, then quits the raw `REDIS_CLIENT`, with an `unref()`ed hard-exit backstop.
- `ScanRepositoryAdapter` now closes the raw `useFactory` ioredis client Nest does not auto-quit — on BOTH the API and worker processes (Pitfall 3, D-14).
- `SHUTDOWN_GRACE_MS` added to the fail-closed Joi env schema (integer 0..60000, default 8000 < Docker's 10s SIGKILL window).
- Full unit suite (131 passed) and `npm run build`/`typecheck`/`lint` all green; the BullMQ Jest panic stays avoided.

## Task Commits

Each task was committed atomically:

1. **Task 1: SHUTDOWN_GRACE_MS env key + pure raceDrain() (D-12)** - `ec6b997` (feat, TDD)
2. **Task 2: WorkerShutdown provider + repository onModuleDestroy + wire into WorkerModule** - `edd00e4` (feat)

**Plan metadata:** committed separately with this SUMMARY + STATE + ROADMAP.

_Task 1 was TDD (RED verified: spec failed on missing drain.ts; GREEN: implementation, 5 tests pass) but committed as a single atomic feat commit covering the coarse-granularity task._

## Files Created/Modified
- `apps/api/src/lifecycle/drain.ts` - Pure `raceDrain(worker, graceMs)`: races `worker.close()` vs a grace timer, `clearTimeout` on both paths, `close(true)` on timeout. No bullmq import.
- `apps/api/src/lifecycle/drain.spec.ts` - Table tests for 'drained'/'forced', timer-clear, structural-type acceptance, and a source-level no-bullmq-import guard.
- `apps/api/src/lifecycle/worker-shutdown.provider.ts` - `WorkerShutdown` (`OnModuleDestroy`): bounded drain + guarded Redis quit + unref'ed exit backstop. @nestjs/bullmq-adjacent — never imported by a spec.
- `apps/api/src/config/env.validation.ts` - `SHUTDOWN_GRACE_MS` Joi key with fail-closed rationale comment.
- `apps/api/src/scan/scan.repository.ts` - `ScanRepositoryAdapter implements OnModuleDestroy` → guarded `redis.quit()`.
- `apps/api/src/worker.module.ts` - Registered `WorkerShutdown` in providers (no HTTP/GraphQL import added — topology guard stays green).

## Decisions Made
- **Guarded idempotent quit on the shared client:** Both `WorkerShutdown` and `ScanRepositoryAdapter` inject and close the same `REDIS_CLIENT`. A second `quit()` on an already-ended ioredis connection rejects with "Connection is closed." (verified in ioredis source: `sendCommand` rejects when `status === "end"`). Both call sites now guard on `status !== 'end'` and swallow a concurrent-quit rejection. See Deviations (Rule 1).
- **Verified Assumption A2 empirically:** `@nestjs/bullmq@11.0.4` `WorkerHost` exposes `get worker(): T` (checked in `node_modules/@nestjs/bullmq/dist/hosts/worker-host.class.d.ts`), so injecting `ScanWorker` and reading `.worker` is sound; no fallback to a self-owned drain hook was needed. Added a `if (worker)` guard for a never-initialised worker (failed bootstrap) as defense.
- **Hard-exit backstop (Assumption A1):** `setTimeout(() => process.exit(0), graceMs + 500).unref()`, cleared on normal completion — belt-and-suspenders so no teardown hang can outlast the container stop grace.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Guarded the shared-client double-quit**
- **Found during:** Task 2 (WorkerShutdown + repository onModuleDestroy)
- **Issue:** The plan has both `WorkerShutdown.onModuleDestroy` and `ScanRepositoryAdapter.onModuleDestroy` call `redis.quit()` on the SAME shared `REDIS_CLIENT`. On the worker both hooks fire; a second `quit()` on an already-ended ioredis connection rejects with "Connection is closed." (confirmed in `node_modules/ioredis/built/Redis.js`: `sendCommand` rejects when `status === "end"`), which would surface as an unhandled rejection during shutdown.
- **Fix:** Both quit sites now early-return when `redis.status === 'end'` and wrap `quit()` in a `try/catch` that swallows the benign concurrent-quit rejection. Idempotent regardless of hook order.
- **Files modified:** apps/api/src/lifecycle/worker-shutdown.provider.ts, apps/api/src/scan/scan.repository.ts
- **Verification:** `npm run typecheck`, `npm run build`, full `npx jest` (131 passed) green; behavior of hook-order (WorkerModule torn down before ScanModule) documented.
- **Committed in:** `edd00e4` (Task 2 commit)

**2. [Rule 2 - Missing Critical] Guarded a never-initialised worker in the drain hook**
- **Found during:** Task 2
- **Issue:** `raceDrain` requires a live worker; if bootstrap failed before the `WorkerHost` initialised, `this.host.worker` could be undefined and the shutdown hook would throw instead of exiting cleanly.
- **Fix:** `const worker = this.host.worker; if (worker) { ...raceDrain... }` so a degraded process still proceeds to Redis quit + clean exit.
- **Files modified:** apps/api/src/lifecycle/worker-shutdown.provider.ts
- **Verification:** typecheck + build green.
- **Committed in:** `edd00e4` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 missing-critical)
**Impact on plan:** Both are shutdown-correctness hardening directly on the plan's own artifacts (they prevent a crash / unclean exit that would defeat ERR-05). No scope creep; no architectural change.

## Issues Encountered
- The environment's `grep` is aliased to `ugrep`, whose handling of BRE `\|` alternation and `-c` output initially made it look like the compiled `onModuleDestroy`/`quit` were missing from `dist/`. Confirmed via direct file Read that the build output is correct — a tooling red herring, not a build problem.

## Known Stubs
None — all code paths are wired to real dependencies (injected `ScanWorker`, `ConfigService`, `REDIS_CLIENT`); no placeholder/empty data.

## User Setup Required
None - no external service configuration required. `SHUTDOWN_GRACE_MS` is optional (defaults to 8000ms).

## Next Phase Readiness
- Shutdown correctness (bounded drain + clean Redis close on both processes) is in place, satisfying ROADMAP Phase 4 success criterion #4 (ERR-05) at the compile/wire/no-panic level.
- **Runtime validation deferred to Plan 03:** the end-to-end SIGTERM-mid-scan drain/force and exit-within-grace behavior (Assumptions A1/A2) must be proven by the Plan 03 compiled-process harness before Phase 5 packaging relies on it.
- Phase 5 (Docker packaging) can inherit the sub-10s stop grace: default `SHUTDOWN_GRACE_MS=8000` < Docker's 10s SIGTERM→SIGKILL window.

## Self-Check: PASSED

- Created files verified present: drain.ts, drain.spec.ts, worker-shutdown.provider.ts, 04-02-SUMMARY.md
- Task commits verified in git log: `ec6b997`, `edd00e4`

---
*Phase: 04-required-rest-api-runtime-lifecycle*
*Completed: 2026-07-10*
