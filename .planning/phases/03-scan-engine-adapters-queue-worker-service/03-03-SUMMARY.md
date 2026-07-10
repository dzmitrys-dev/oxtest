---
phase: 03-scan-engine-adapters-queue-worker-service
plan: 03
subsystem: engine
tags: [nestjs, bullmq, worker, workerhost, scan-lifecycle, adapter-factory, tdd, process-contract]

# Dependency graph
requires:
  - phase: 03-scan-engine-adapters-queue-worker-service
    plan: 01
    provides: shared ScanModule seam, Redis ScanRepository + SCAN_REPOSITORY token, typed ScanJob/SCAN_QUEUE, BullMQ producer queue
  - phase: 03-scan-engine-adapters-queue-worker-service
    plan: 02
    provides: RepoCloner/ScanPathAllocator/TrivyRunner ports+adapters, TempArtifactCleaner, classifyScanError, env fault/marker allowlists
  - phase: 02-streaming-parse-pipeline-memory-proof
    provides: framework-free ReportParser async-generator contract (reused via for-await, not replaced)
provides:
  - ScanEngine — framework-free concurrency-one lifecycle (allocate → Scanning → clone → Trivy(onReportReady) → for-await ordered awaited appends → Finished) with bounded/redacted Failed, original-error precedence, no BullMQ retries, awaited finally cleanup
  - ScanWorker — thin @Processor(scan,{concurrency:1}) WorkerHost delegating to ScanEngine (only file importing @nestjs/bullmq)
  - adapter-factory — fail-closed production/test-fault construction (none|clone|trivy|disk-full|parse|cleanup) + REPORT_READY stdout producer seam
  - WorkerModule — transport-free worker root importing shared ScanModule, worker-only providers, role-split Redis retry policy
  - worker.ts — context-first SCAN_WORKER_READY bootstrap (logger:false, abortOnError:false)
  - worker-process-contract.mjs — fail-closed compiled-worker readiness/lifetime/transport assertion
affects: [03-04, phase-04-api-transport]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Thin @Processor/WorkerHost shell delegating to a plain injectable engine (keeps @nestjs/bullmq out of the jest graph)"
    - "Fail-closed adapter-factory fault seam: real adapters in production, single-port failing double in fault mode"
    - "Compiled-process contract with a silent TCP Redis stub so readiness assertions need no live Redis"
    - "Marker-first bootstrap: logger:false + abortOnError:false so the ONLY pre-marker stdout is the readiness sentinel"

key-files:
  created:
    - apps/api/src/engine/scan-engine.ts
    - apps/api/src/engine/scan-engine.spec.ts
    - apps/api/src/engine/adapter-factory.ts
    - apps/api/src/engine/scan-worker.ts
    - apps/api/scripts/worker-process-contract.mjs
  modified:
    - apps/api/src/worker.module.ts
    - apps/api/src/worker.ts

key-decisions:
  - "Split the worker into a thin WorkerHost shell (scan-worker.ts) + plain ScanEngine (scan-engine.ts): all lifecycle logic + every unit test target the engine so the confirmed @swc/core+@nestjs/bullmq jest panic is never triggered"
  - "Redis role-split is realized through ScanModule's plain-options forRootAsync: BullMQ auto-forces maxRetriesPerRequest:null on the blocking worker connection while the non-blocking producer queue keeps finite retries — no ScanModule edit needed"
  - "worker.ts uses logger:false + abortOnError:false so a clean marker-only stdout is emitted on success and a clear validation diagnostic + non-zero exit on fail-closed"
  - "SCAN_ENGINE_READY_MARKER=log gates the REPORT_READY stdout producer; distinct from the SCAN_WORKER_READY bootstrap sentinel"
  - "Process contract uses a silent local TCP stub for Redis so readiness/lifetime assertions are deterministic without a live Redis or Docker"

patterns-established:
  - "Worker-split: @nestjs/bullmq confined to a delegate-only shell; testable logic in a framework-free class"
  - "adapter-factory as the single fault-injection seam consumed by both the unit suite and the Plan 04 harness"
  - "Compiled process contract: build → spawn dist entrypoint → assert marker-first output + long-lived + fail-closed"

requirements-completed: [ENGINE-01, ENGINE-06, ENGINE-07, ARCH-02, ARCH-03, ERR-01, ERR-02, ERR-03, ERR-04]

coverage:
  - id: D1
    description: "Concurrency-one lifecycle: markScanning before engine work, clone, Trivy, for-await ordered awaited appends, Finished only after final append"
    requirement: ENGINE-01
    verification:
      - kind: unit
        ref: "apps/api/src/engine/scan-engine.spec.ts#Test 1 marks Scanning, clones, runs Trivy, appends in order, Finished last"
        status: pass
    human_judgment: false
  - id: D2
    description: "onReportReady(reportPath) callback resolves before ReportParser.parse; parser rejection still reaches Failed + cleanup"
    requirement: ENGINE-06
    verification:
      - kind: unit
        ref: "apps/api/src/engine/scan-engine.spec.ts#Test 2a/2b onReportReady ordering + parser rejection"
        status: pass
    human_judgment: false
  - id: D3
    description: "Findings are success; genuine Trivy rejection is Failed(trivy) and rethrown with no automatic retry/backoff"
    requirement: ERR-01
    verification:
      - kind: unit
        ref: "apps/api/src/engine/scan-engine.spec.ts#Test 3 findings-as-success + Trivy rejection rethrow (run once)"
        status: pass
    human_judgment: false
  - id: D4
    description: "clone/ENOSPC(disk-full)/parser/cleanup failures mark Failed with bounded reasons, rethrow the original error, and clean exactly once; allocator owns partial-allocation cleanup"
    requirement: ERR-03
    verification:
      - kind: unit
        ref: "apps/api/src/engine/scan-engine.spec.ts#Test 4a-4e failure categories + original-error precedence + allocator ownership"
        status: pass
    human_judgment: false
  - id: D5
    description: "adapter-factory: production builds only real adapters; named faults inject clone/trivy/disk-full/parse/cleanup through the port boundary; resolveEngineTestFault is fail-closed"
    requirement: ERR-02
    verification:
      - kind: unit
        ref: "apps/api/src/engine/scan-engine.spec.ts#Test 5a-5c + resolveEngineTestFault fail-closed"
        status: pass
    human_judgment: false
  - id: D6
    description: "Transport-free WorkerModule imports shared ScanModule + worker-only providers; role-split Redis retry policy; no keyPrefix; no HTTP/GraphQL/listener"
    requirement: ARCH-03
    verification:
      - kind: integration
        ref: "apps/api/scripts/worker-process-contract.mjs#worker root is transport-free and wires the shared ScanModule"
        status: pass
    human_judgment: false
  - id: D7
    description: "Compiled worker emits exactly SCAN_WORKER_READY after context + WorkerHost init with no pre-marker stdout/stderr, stays long-lived, and fails closed on invalid fault / missing env"
    requirement: ARCH-02
    verification:
      - kind: integration
        ref: "apps/api/scripts/worker-process-contract.mjs#valid config + fail-closed(invalid fault) + fail-closed(missing SCAN_TMP_DIR)"
        status: pass
    human_judgment: false
  - id: D8
    description: "Awaited finally cleanup never masks the primary result; a failure-persistence error never replaces the original engine error (D-22/D-23)"
    requirement: ERR-04
    verification:
      - kind: unit
        ref: "apps/api/src/engine/scan-engine.spec.ts#Test 4d secondary cleanup failure + failure-persistence error precedence"
        status: pass
    human_judgment: false

# Metrics
duration: 42min
completed: 2026-07-10
status: complete
---

# Phase 3 Plan 03: Concurrency-One Worker Lifecycle & Compiled Worker Contract Summary

**A framework-free `ScanEngine` drives the full allocate → Scanning → clone → Trivy → stream-parse → Finished lifecycle with bounded Failed semantics and original-error precedence, wrapped in a thin BullMQ `@Processor(concurrency:1)` WorkerHost, wired through a transport-free `WorkerModule`, and guarded by a fail-closed compiled `dist/worker.js` process contract — with all lifecycle logic and every unit test kept out of the `@swc/core`+`@nestjs/bullmq` jest panic path.**

## Performance

- **Duration:** ~42 min
- **Started:** 2026-07-10T13:16:12Z
- **Completed:** 2026-07-10T13:58:00Z
- **Tasks:** 2 (Task 1 TDD: RED → GREEN)
- **Files created/modified:** 7 (5 created, 2 modified)
- **Tests:** 18 new engine/factory specs; full api suite 59 passed / 3 skipped; 4 process-contract assertions pass

## Accomplishments
- Implemented `ScanEngine`, a plain injectable that owns the entire concurrency-one lifecycle: allocate (before the engine try/finally), `markScanning`, clone, `trivy.run({ onReportReady })`, `for await` over `ReportParser.parse(reportPath)` with each `appendVulnerability` awaited in discovery order, and `markFinished` only after the final append.
- Enforced the exact failure contract: every clone/Trivy/ENOSPC(disk-full)/parser rejection persists a bounded, redacted `Failed` reason via `classifyScanError`, rethrows the ORIGINAL error (no BullMQ retry/backoff, D-19), and always awaits `TempArtifactCleaner.remove` in `finally` — a secondary cleanup or failure-persistence error never masks the primary result (D-22/D-23).
- Kept the allocator authoritative: allocation runs before the try/finally so the allocator owns partial-allocation cleanup on its own rejection, while both returned paths remain available to `finally` cleanup on every later failure.
- Built the thin `ScanWorker` `@Processor(scan, { concurrency: 1 })` WorkerHost that only delegates to the engine, plus an `@OnWorkerEvent('error')` guard so a transient worker error cannot crash the process.
- Built `adapter-factory` as the fail-closed fault seam: production constructs only the real adapters; each named fault (`clone|trivy|disk-full|parse|cleanup`) injects a single failing port double; and it exposes the `REPORT_READY <path>` stdout producer distinct from the `SCAN_WORKER_READY` sentinel.
- Wired a transport-free `WorkerModule` (shared ScanModule + worker-only providers) and a marker-first `worker.ts`, then proved the compiled `dist/worker.js` emits exactly `SCAN_WORKER_READY` after init, stays long-lived, and fails closed on invalid fault / missing env via `worker-process-contract.mjs`.

## Task Commits

1. **Task 1: Concurrency-one worker lifecycle (TDD)** — `71ee136` (test, RED) → `ed648f9` (feat, GREEN)
2. **Task 2: Shared modules + fail-closed compiled worker contract** — `d368fb7` (feat)

## Files Created/Modified
- `apps/api/src/engine/scan-engine.ts` — plain `ScanEngine` lifecycle (no `@nestjs/bullmq`); structural `ReportParserLike` reuse of the Phase 2 parser
- `apps/api/src/engine/scan-engine.spec.ts` — 18 behavioral specs (lifecycle, ordering, findings-as-success, failure categories, original-error precedence, cleanup, adapter-factory modes)
- `apps/api/src/engine/adapter-factory.ts` — production/test-fault construction, `resolveEngineTestFault` (fail-closed), `reportReadyStdoutProducer`
- `apps/api/src/engine/scan-worker.ts` — thin `@Processor(scan,{concurrency:1})` WorkerHost + `SCAN_ENGINE` token + `@OnWorkerEvent('error')`
- `apps/api/src/worker.module.ts` — transport-free worker root; `SCAN_ENGINE` `useFactory` (repository from DI + factory adapters + logger + gated onReportReady); adds only `ScanWorker`
- `apps/api/src/worker.ts` — `logger:false` + `abortOnError:false` bootstrap; `app.get(ScanWorker)` then `process.stdout.write('SCAN_WORKER_READY\n')`
- `apps/api/scripts/worker-process-contract.mjs` — build → spawn `dist/worker.js` against a silent TCP Redis stub; asserts marker-first output, long-lived process, fail-closed boots, and transport-free source wiring

## Decisions Made
- **Worker split (structural, deviation — see below):** All lifecycle logic lives in the plain `ScanEngine`; `ScanWorker` is a delegate-only WorkerHost shell. Reason: the confirmed `@swc/core@1.15.43` miette panic aborts jest whenever `@nestjs/bullmq` enters the module graph. Every unit test targets `scan-engine.ts`/`adapter-factory.ts` (which import no `@nestjs/bullmq`); the shell + real wiring is validated only by the compiled `worker-process-contract.mjs` under plain node, where the panic never applies.
- **Redis role-split without editing ScanModule:** ScanModule (Plan 01-owned, not editable here) passes a PLAIN connection options object to `BullModule.forRootAsync`. BullMQ's `RedisConnection` auto-forces `maxRetriesPerRequest: null` for the blocking worker connection built from those options, while the non-blocking producer queue keeps ioredis's finite default — so the split is correct and idiomatic with no ScanModule change and no `keyPrefix`.
- **Marker-first bootstrap:** `NestFactory.createApplicationContext(WorkerModule, { logger: false, abortOnError: false })` suppresses Nest bootstrap chatter (clean pre-marker stdout) while routing validation/bootstrap failures to our own `console.error` + non-zero exit (clear fail-closed diagnostic).
- **REPORT_READY vs SCAN_WORKER_READY:** the report-readiness marker (gated by `SCAN_ENGINE_READY_MARKER=log`, emitted by the Trivy `onReportReady` seam) is deliberately separate from the process bootstrap sentinel.
- **Contract self-sufficiency:** a silent local TCP stub stands in for Redis, so the contract asserts readiness/lifetime deterministically without a live Redis or Docker.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Split the worker into a thin WorkerHost shell + plain ScanEngine (and named the spec `scan-engine.spec.ts`)**
- **Found during:** Task 1 (both RED and GREEN)
- **Issue:** The plan literally places all lifecycle logic in `scan-worker.ts` (which extends `WorkerHost` from `@nestjs/bullmq`) and names the test `scan-worker.spec.ts`. A spec importing that file pulls `@nestjs/bullmq` into the jest module graph and triggers the confirmed native `@swc/core`/miette panic (recorded in STATE.md and both prior 03 summaries; reproduces on Node 22 and 24), making Task 1's verify impossible as literally written.
- **Fix:** Introduced `apps/api/src/engine/scan-engine.ts` (`ScanEngine`, a framework-free plain class holding ALL lifecycle logic — the `markScanning|appendVulnerability|markFinished|markFailed` transitions and the `for await` parser consumption) and kept `scan-worker.ts` as a thin `@Processor(scan, { concurrency: 1 })` shell whose `process()` only calls `engine.run(job.data)`. All 18 behavioral tests live in `scan-engine.spec.ts` (imports no `@nestjs/bullmq`). This is the sanctioned mitigation carried forward from Plan 01/02, analogous to Plan 02's added `subprocess-runner.ts`.
- **key_links note:** because of this split, the plan's declared `key_links` patterns (`markScanning|appendVulnerability|markFinished|markFailed` and `for await`) now live in `scan-engine.ts` rather than `scan-worker.ts`. `scan-worker.ts` still satisfies its `SCAN_WORKER_READY`/`concurrency: 1` artifact contract; `worker.ts` still owns the `SCAN_WORKER_READY` key_link.
- **Files:** apps/api/src/engine/scan-engine.ts (new), apps/api/src/engine/scan-worker.ts, apps/api/src/engine/scan-engine.spec.ts
- **Verification:** 18 specs pass under jest without a panic; full suite 59 passed / 3 skipped on Node 24.
- **Committed in:** `71ee136`, `ed648f9`

**2. [Rule 2 - Missing Critical] `abortOnError: false` on the worker context**
- **Found during:** Task 2 (process-contract design)
- **Issue:** With `logger: false`, NestFactory's default `abortOnError: true` swallows bootstrap/validation failures (Nest logs then exits), producing exit 1 with ZERO stderr — a fail-closed boot with no diagnostic, indistinguishable from an opaque crash.
- **Fix:** Pass `abortOnError: false` so failures reach `bootstrap().catch` → `console.error` (clear message, e.g. `Config validation error: "SCAN_ENGINE_TEST_FAULT" must be one of [...]`) → non-zero exit; success path still emits only the clean marker.
- **Files:** apps/api/src/worker.ts
- **Verification:** contract's two fail-closed tests observe a non-zero exit, no marker, and (for the fault case) the validation message on stderr.
- **Committed in:** `d368fb7`

**3. [Rule 2 - Missing Critical] `@OnWorkerEvent('error')` guard on the WorkerHost**
- **Found during:** Task 2 (worker resilience)
- **Issue:** A BullMQ worker that emits an `error` event with no listener crashes the Node process (`Unhandled 'error' event`), which would let a transient Redis blip kill the worker.
- **Fix:** Added an `@OnWorkerEvent('error')` handler that logs a bounded diagnostic (D-21, logs only) so processing continues.
- **Files:** apps/api/src/engine/scan-worker.ts
- **Verification:** contract's valid run stays long-lived; unreachable-Redis smoke shows the process survives and keeps the connection retrying.
- **Committed in:** `ed648f9`

---

**Total deviations:** 3 auto-fixed (1 blocking/structural, 2 missing-critical). No architectural changes; no scope creep. The `cleanup` fault mode in the adapter-factory extends the env-validated allowlist (`none|clone|trivy|disk-full|parse`) with one unit-only mode reachable solely via direct factory calls — the fail-closed env schema is unchanged.

## Threat Model Coverage
- **T-03-08 (late/duplicate job):** `concurrency: 1` on the WorkerHost plus the repository's authoritative terminal-state guards (Plan 01) — the worker never overwrites terminal Redis state.
- **T-03-09 (lifecycle/cleanup availability):** sequential processing, awaited appends, awaited `finally` cleanup, original-error precedence, and bounded diagnostics; no report buffering.
- **T-03-07 (info disclosure):** `classifyScanError` bounds/redacts the persisted reason; raw stderr/paths stay in worker logs only; readiness output carries no diagnostics.
- **T-03-SC (supply chain):** no new dependencies; only Plan 01-approved pins used.

## Known Stubs
None in the production path. The adapter-factory's fault-mode doubles (benign no-op adapters + one failing port, plus a `SAMPLE_FINDING` fixture) are DETERMINISTIC fault-injection for the unit suite and the Plan 04 harness, not production stubs — production (`fault: 'none'`) constructs only the real adapters, verified by Test 5a.

## User Setup Required
None — no new external service configuration. The worker uses the existing required `REDIS_HOST`/`REDIS_PORT`/`SCAN_TMP_DIR` env keys and the Plan 02 `SCAN_ENGINE_TEST_FAULT`/`SCAN_ENGINE_READY_MARKER` allowlists.

## Next Phase Readiness
- The compiled worker is a typed concurrency-one BullMQ processor executing the complete sequential lifecycle through injectable adapters, persisting authoritative Redis status, distinguishing findings from failures, and remaining listener-free with fail-closed readiness.
- Plan 04 consumes the exact bootstrap symbols (`SCAN_WORKER_READY`, `REPORT_READY <path>`), the `adapter-factory` fault seam, and `worker-process-contract.mjs` conventions to build the Docker/Redis end-to-end integration harness (no further edits to these owned files needed).
- **Carried-forward blocker (unchanged):** the `@swc/core`+`@nestjs/bullmq` jest panic remains; keep `@nestjs/bullmq` confined to the `scan-worker.ts` shell (never imported by a spec). Compiled `dist/worker.js` under plain node is unaffected.

## Self-Check: PASSED

All 7 source/script files + the SUMMARY exist on disk. All three task commits (`71ee136`, `ed648f9`, `d368fb7`) are present in history. Gates re-verified: `scan-engine.spec.ts` 18/18 pass; full api suite 59 passed / 3 skipped; `tsc --noEmit` clean; `eslint .` clean; `nest build` compiles `dist/worker.js` + `dist/engine/scan-worker.js`; `worker-process-contract.mjs` 4/4 assertions pass.

---
*Phase: 03-scan-engine-adapters-queue-worker-service*
*Completed: 2026-07-10*
