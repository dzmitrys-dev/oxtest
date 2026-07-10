---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 04
current_phase_name: required-rest-api-runtime-lifecycle
status: verifying
stopped_at: Phase 4 context gathered
last_updated: "2026-07-10T18:26:14.792Z"
last_activity: 2026-07-10
last_activity_desc: Phase 04 execution started
progress:
  total_phases: 6
  completed_phases: 4
  total_plans: 11
  completed_plans: 11
  percent: 67
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-09)

**Core value:** Process a 500MB+ Trivy JSON report without OOM under `node --max-old-space-size=150` — memory efficiency is the explicit pass/fail criterion.
**Current focus:** Phase 04 — required-rest-api-runtime-lifecycle

## Current Position

Phase: 04 (required-rest-api-runtime-lifecycle) — EXECUTING
Plan: 3 of 3
Status: Phase complete — ready for verification
Last activity: 2026-07-10 — Phase 04 execution started

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**

- Total plans completed: 8
- Average duration: — min
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 2 | - | - |
| 02 | 2 | - | - |
| 03 | 4 | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*
| Phase 01 P01 | 35min | 3 tasks | 15 files |
| Phase 01 P02 | 13 | 3 tasks | 14 files |
| Phase 03 P01 | 40min | 3 tasks | 11 files |
| Phase 03 P02 | 25min | 2 tasks | 13 files |
| Phase 03 P03 | 42min | 2 tasks | 7 files |
| Phase 03 P04 | 90min | 3 tasks | 9 files |
| Phase 04 P01 | 9min | 3 tasks | 11 files |
| Phase 04 P02 | 8min | 2 tasks | 6 files |
| Phase 04 P03 | 15min | 3 tasks | 2 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Framework: NestJS 11 on the Fastify adapter — Module/Controller/Provider IS the graded Controller/Service/Worker separation; one shared `ScanService` across REST + GraphQL + worker
- Topology: two entrypoints sharing `ScanModule` — `src/index.ts` (API → `dist/index.js`, matches the self-test command) and `src/worker.ts` (worker-only, no HTTP listener); worker `CMD` passes `--max-old-space-size=150` explicitly
- Memory pass/fail is won in the stream-json deep leaf `Pick` plus object-by-object strategy, NOT the framework — prove the parser standalone before any queue/HTTP plumbing (Phase 2)
- [Phase 01]: Pinned TypeScript exactly to 6.0.3 (not latest 7.0.2, not 5.9.x) for typescript-eslint/ts-jest peer compatibility
- [Phase 01]: Omitted verbatimModuleSyntax to preserve NestJS CommonJS emitDecoratorMetadata DI model; TYPE-01 met by strict + noUncheckedIndexedAccess
- [Phase 01]: Env schema keys: NODE_ENV/PORT/TRIVY_MODE have safe defaults; REDIS_HOST/REDIS_PORT/SCAN_TMP_DIR are .required() with no default (ASVS V14.1 fail-closed, threat T-01-02)
- [Phase 01]: ScanModule (providing/exporting ScanStore) is the shared DI seam consumed identically by AppModule and WorkerModule -- Phase 3 plugs a real ScanRepository into this seam without re-architecting
- [Phase ?]: [Phase 03-01]: Redis ScanRepository uses WATCH/MULTI/EXEC with conflict retry to guard terminal states and refresh a seven-day TTL on both keys atomically per write; missing hash returns null (D-07..D-12)
- [Phase ?]: [Phase 03-01]: ScanService injects the BullMQ queue via a framework-neutral SCAN_QUEUE Symbol token (bridged with getQueueToken/useExisting) instead of @InjectQueue, keeping @nestjs/bullmq out of the jest unit path
- [Phase ?]: [Phase 03-01]: Structured ScanFailureReason {category, detail} added to domain; repository caps detail at 500 chars at persistence (D-20)
- [Phase ?]: [Phase 03-02]: Engine adapters framework-free plain classes with spawn-based SubprocessRunner seam (shell:false, stdout ignored); Plan 03 wires via useFactory to keep @nestjs/bullmq out of jest graph
- [Phase ?]: [Phase 03-02]: Used node:child_process.spawn instead of ESM-only execa (D-15 permits execFile/spawn); Trivy Docker fallback pinned aquasecurity/trivy:0.69.3 with /src:ro + /out mounts and tmpfs ephemeral cache
- [Phase 03-03]: Worker split — thin @Processor WorkerHost shell delegates to a plain framework-free ScanEngine; all lifecycle logic + unit tests target the engine to avoid the @swc/core+@nestjs/bullmq jest panic (shell/wiring validated only by compiled worker-process-contract.mjs)
- [Phase 03-03]: Redis role-split needs no ScanModule edit — plain-options forRootAsync lets BullMQ auto-null the blocking worker connection while the producer queue keeps finite retries; worker.ts uses logger:false+abortOnError:false for marker-first stdout + fail-closed diagnostics
- [Phase ?]: Zero-dep GitHub-URL validator (parseGithubUrl) + GithubUrlPipe; class-validator/class-transformer not installed (04-01)
- [Phase ?]: REST responses use a state-shaped ScanResponse union via toScanResponse; controllers thin + import-guarded per ARCH-01 (04-01)
- [Phase ?]: /health uses a bounded active Redis PING over the existing REDIS_CLIENT — no new connection (D-08, 04-01)
- [Phase ?]: 04-02: raceDrain is a pure Jest-safe fn (no @nestjs/bullmq import) that bounds BullMQ worker.close() and force-closes on SHUTDOWN_GRACE_MS timeout (D-12)
- [Phase ?]: 04-02: Both WorkerShutdown and ScanRepositoryAdapter close the shared REDIS_CLIENT; both quit() calls are guarded (status!=='end' + catch) to prevent a double-quit crash on worker shutdown
- [Phase ?]: 04-03: Integration proof runs under node:test against COMPILED dist over disposable Redis — never @nestjs/bullmq in Jest (miette landmine honored); criterion #5 met
- [Phase ?]: 04-03: Nest 11 enableShutdownHooks re-raises the signal after shutdown hooks (useProcessExit=false) so a clean SIGTERM exits {code:null,signal:SIGTERM}, not code 0; A1/A2 validated empirically

### Pending Todos

None yet.

### Blockers/Concerns

- Coverage count corrected: REQUIREMENTS.md header said 39 v1 requirements but there are 40 distinct IDs — all 40 are mapped; count updated to 40 in the traceability section
- Phase 2 research flag: stream-json's exact nested `pick`/`streamArray` composition for Trivy's `Results[].Vulnerabilities` shape is under-documented — validate against a small hand-crafted fixture before scaling to 500MB
- Phase 5 research flag: Node/V8 heap-size vs Docker `mem_limit` ratio must be empirically tuned against the largest fixture in-container, not just the bare-node self-test
- [Updated 01-REVIEW-FIX, iteration 1] `npm test` no longer fails trivially: `--passWithNoTests` added to the jest script (WR-04) since Plan 02 Task 3 deleted the only spec file and replaced it, so the previously-documented "no tests found" exit-1 is resolved. The underlying `@swc/core@1.15.43` + `miette@7.6.0` native panic under jest is CONFIRMED STILL REPRODUCIBLE (re-verified with a throwaway smoke spec in the review-fix session) but only on Node 24 (the available sandbox runtime) — it remains UNVERIFIED against the project's actually-pinned Node 22 runtime (`engines: ">=22 <23"` in apps/api/package.json), since no Node 22 install was available to test against. Must be re-verified on Node 22 and resolved via an `@swc/core` npm `overrides` pin (or reproduced/re-diagnosed on the pinned runtime) before Phase 2 adds any real `.spec.ts` file.
- [Phase 03-01] @swc/core@1.15.43 native miette panic aborts jest whenever @nestjs/bullmq is in the module graph — reproduces on BOTH Node 22 and Node 24 (not Node-24-only as prior STATE assumed). bullmq/ioredis alone are fine. Plans 02-04/Phase 4 must keep @nestjs/bullmq out of jest-loaded source (thin @Processor shell + plain injectable engine logic) OR fix the toolchain; compiled dist/worker.js under plain node is unaffected.

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none)* | | | |

## Session Continuity

Last session: 2026-07-10T18:25:54.739Z
Stopped at: Phase 4 context gathered
Resume file: .planning/phases/04-required-rest-api-runtime-lifecycle/04-CONTEXT.md
