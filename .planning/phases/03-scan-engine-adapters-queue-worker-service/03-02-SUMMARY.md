---
phase: 03-scan-engine-adapters-queue-worker-service
plan: 02
subsystem: engine
tags: [engine, execa, subprocess, trivy, docker, cleanup, error-normalization, tdd, security]

# Dependency graph
requires:
  - phase: 03-scan-engine-adapters-queue-worker-service
    plan: 01
    provides: shared ScanModule seam, ScanFailureReason/ScanFailureCategory domain type, ScanRepository/ScanService/typed queue contracts
  - phase: 02-streaming-parse-pipeline-memory-proof
    provides: framework-free ReportParser async-generator contract (consumed downstream by the worker, not here)
provides:
  - Framework-free ports RepoCloner, ScanPathAllocator, TrivyRunner (+ Symbol DI tokens)
  - ScanPathAllocatorAdapter — exclusive per-scan cloneDir/reportPath allocation under SCAN_TMP_DIR with partial-allocation cleanup ownership
  - RepoClonerAdapter — shallow argv-safe git clone consuming the supplied cloneDir unchanged
  - TrivyRunnerAdapter — local Trivy preference, launch-error-only Docker fallback (pinned aquasecurity/trivy:0.69.3), disk-backed report + readiness seam
  - SubprocessRunner seam (spawn, shell:false, stdout ignored, bounded stderr, launch-vs-exit error typing)
  - TempArtifactCleanerAdapter — idempotent recursive clone/report cleanup that never masks the primary scan error
  - classifyScanError — bounded, redacted, stage-based clone/trivy/disk-full/parse classifier (500-char cap)
  - env.validation fail-closed SCAN_ENGINE_TEST_FAULT and SCAN_ENGINE_READY_MARKER allowlists
affects: [03-03, 03-04, phase-04-api-transport]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Injectable adapter constructed via explicit options/seams (not Nest DI) so it is framework-free and unit-testable without bootstrapping a module"
    - "SubprocessRunner seam enforcing shell:false + argv arrays structurally; stdout never collected (report goes to --output file)"
    - "Launch-failure vs non-zero-exit discrimination drives local→Docker fallback (never re-run after a genuine scan failure)"
    - "Report-readiness contract: stat-validate the exact host reportPath, then onReportReady as the final adapter action"
    - "Stage-based error classification with ENOSPC promotion + credential/absolute-path redaction and a 500-char cap"

key-files:
  created:
    - apps/api/src/engine/repo-cloner.port.ts
    - apps/api/src/engine/repo-cloner.adapter.ts
    - apps/api/src/engine/scan-path-allocator.port.ts
    - apps/api/src/engine/scan-path-allocator.adapter.ts
    - apps/api/src/engine/trivy-runner.port.ts
    - apps/api/src/engine/trivy-runner.adapter.ts
    - apps/api/src/engine/subprocess-runner.ts
    - apps/api/src/engine/temp-artifact-cleaner.ts
    - apps/api/src/engine/scan-error.ts
    - apps/api/src/engine/repo-cloner.adapter.spec.ts
    - apps/api/src/engine/trivy-runner.adapter.spec.ts
    - apps/api/src/engine/scan-error.spec.ts
  modified:
    - apps/api/src/config/env.validation.ts

key-decisions:
  - "Used node:child_process.spawn behind an injectable SubprocessRunner seam instead of execa: execa 9 is ESM-only and unsafe to require() from this CommonJS/swc build; the plan explicitly permits execFile/spawn provided argv arrays + shell:false + no report-stdout buffering (D-15). spawn with stdout:'ignore' also structurally guarantees the report is never buffered."
  - "Added a shared apps/api/src/engine/subprocess-runner.ts (not in the plan file list) so RepoCloner and TrivyRunner share one hardened, testable subprocess boundary instead of duplicating spawn logic."
  - "Adapters are plain classes constructed with explicit options/seams (no @Injectable / no ConfigService injection); Plan 03 wires them via useFactory reading validated config. This keeps every engine file free of NestJS imports, honoring the recorded @nestjs/bullmq+swc jest blocker."
  - "Per-scan layout <SCAN_TMP_DIR>/<scanId>-<uuid>/{repo,out/report.json}: clone dir and report parent are SEPARATE directories so Docker mounts /src:ro and /out without overlap (D-16)."
  - "Docker ephemeral cache implemented as a tmpfs mount at /root/.cache/trivy — truly per-scan, discarded with --rm, no persistent volume and no host artifact to clean (D-17)."
  - "Trivy image pinned as an exported constant TRIVY_DOCKER_IMAGE='aquasecurity/trivy:0.69.3' (D-13); a test asserts it is not a :latest tag."

# Metrics
duration: 25min
completed: 2026-07-10
status: complete
---

# Phase 3 Plan 02: Clone, Trivy, Cleanup & Error-Normalization Adapters Summary

**Framework-free clone/Trivy/path-allocation/cleanup/error adapters behind injectable ports: discrete-argv `shell:false` subprocesses, exclusive `SCAN_TMP_DIR` path ownership with partial-allocation cleanup, pinned `aquasecurity/trivy:0.69.3` launch-error-only Docker fallback with an exact mount/output contract, disk-backed report readiness, idempotent cleanup that never masks the primary failure, and a bounded, redacted scan-error classifier.**

## Performance
- **Duration:** ~25 min
- **Tasks:** 2 (both TDD: RED → GREEN)
- **Files created/modified:** 13 (12 created, 1 modified)
- **Tests added:** 17 (10 clone/Trivy + 7 cleanup/error); full api suite 41 passed / 3 skipped

## Accomplishments
- Defined three framework-free ports (`RepoCloner`, `ScanPathAllocator`, `TrivyRunner`) with the exact plan signatures plus Symbol DI tokens.
- `ScanPathAllocatorAdapter` is the sole allocator of both `cloneDir` and `reportPath` beneath validated `SCAN_TMP_DIR`, with separate report-parent and clone directories, and removes the whole per-scan base if any directory creation fails before returning.
- `RepoClonerAdapter` performs `git clone --depth 1 -- <url> <cloneDir>` via discrete argv with `shell:false`, consuming the supplied `cloneDir` unchanged and generating no temp/report paths (the `--` end-of-options guard blocks `-`-leading URL flag injection).
- `TrivyRunnerAdapter` prefers local `trivy`, falls back to the pinned Docker image ONLY on a launch/infrastructure error, and rethrows genuine non-zero scan failures without re-running Docker; it stat-validates the exact host report path and then calls `onReportReady` as its final action.
- `SubprocessRunner` seam (spawn, `shell:false`, stdout ignored, bounded 8 KB stderr) distinguishes launch failure from non-zero exit, which drives the fallback decision and feeds the error classifier.
- `TempArtifactCleanerAdapter` recursively/forcefully removes both paths, treats ENOENT as success, and logs (never rethrows) secondary errors so the original scan failure is preserved.
- `classifyScanError` produces stage-based `clone`/`trivy`/`parse` categories, promotes any ENOSPC (by error code or stderr) to `disk-full`, redacts URL credentials and absolute filesystem paths, and caps detail at 500 characters.
- Extended `env.validation.ts` with fail-closed `SCAN_ENGINE_TEST_FAULT` (`none|clone|trivy|disk-full|parse`) and `SCAN_ENGINE_READY_MARKER` (`none|log`) allowlists for Plan 03/04 consumption.

## Task Commits
1. **Task 1: argv-safe clone and Trivy adapters (TDD)** — `b119776` (test, RED) → `a6de8a5` (feat, GREEN)
2. **Task 2: idempotent cleanup + bounded scan-error policy (TDD)** — `a9fc772` (test, RED) → `839c735` (feat, GREEN)

## Files Created/Modified
- `apps/api/src/engine/repo-cloner.port.ts` / `repo-cloner.adapter.ts` — clone contract + shallow argv-safe adapter
- `apps/api/src/engine/scan-path-allocator.port.ts` / `scan-path-allocator.adapter.ts` — exclusive path allocation + partial-cleanup ownership
- `apps/api/src/engine/trivy-runner.port.ts` / `trivy-runner.adapter.ts` — Trivy contract + local/Docker selection, pinned image, readiness seam
- `apps/api/src/engine/subprocess-runner.ts` — shared hardened subprocess seam (new file; see Deviations)
- `apps/api/src/engine/temp-artifact-cleaner.ts` — idempotent cleanup port + adapter
- `apps/api/src/engine/scan-error.ts` — bounded/redacted stage-based classifier
- `apps/api/src/engine/*.spec.ts` — clone/Trivy and cleanup/error suites
- `apps/api/src/config/env.validation.ts` — fail-closed engine allowlists

## Decisions Made
- **spawn over execa:** execa 9.6.1 is ESM-only (`"type": "module"`) and cannot be safely `require()`d from this CommonJS/`@swc/jest` build; the plan (D-15) and CONTEXT explicitly allow Node `execFile`/`spawn` provided argv arrays, `shell:false`, and no report-stdout buffering are preserved. `spawn` with `stdio: ['ignore','ignore','pipe']` additionally guarantees the large Trivy report (written via `--output`) is never buffered into Node memory.
- **Shared subprocess-runner.ts:** introduced one hardened subprocess boundary shared by both subprocess adapters rather than duplicating spawn/`shell:false`/error-typing logic (see Deviations).
- **Framework-free adapters:** constructed via explicit options/seams instead of NestJS DI, so no engine file imports `@nestjs/*`. This is deliberate given the recorded `@nestjs/bullmq`+`@swc/core` jest panic — the engine suites stay green because nothing pulls `@nestjs/bullmq` into the jest graph. Plan 03 performs the Nest `useFactory` wiring.
- **Docker cache as tmpfs:** an ephemeral `type=tmpfs` mount at `/root/.cache/trivy` satisfies "ephemeral per-scan cache, no persistent volume" (D-17) with no host artifact to clean up.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added shared `apps/api/src/engine/subprocess-runner.ts` (not in the plan's file list)**
- **Found during:** Task 1 (GREEN)
- **Issue:** Both `RepoClonerAdapter` and `TrivyRunnerAdapter` need the same hardened subprocess primitive (spawn, `shell:false`, stdout ignored, bounded stderr, launch-vs-exit error typing). Inlining it in one adapter and importing across adapters, or duplicating it, is worse than one shared seam.
- **Fix:** Created `subprocess-runner.ts` exporting `SubprocessRunner`, `SubprocessRunOptions`, `SubprocessRunError`, and `createSpawnSubprocessRunner()`.
- **Files added:** apps/api/src/engine/subprocess-runner.ts
- **Committed in:** `a6de8a5`

**2. [Rule 3 - Blocking] Used node:child_process.spawn instead of execa for the runner default**
- **Found during:** Task 1 (GREEN)
- **Issue:** execa 9.6.1 is ESM-only; `require()`ing it from the CommonJS/swc build is unreliable and risks a runtime `ERR_REQUIRE_ESM`. The plan/CONTEXT grant discretion between execa and Node `execFile`/`spawn` (D-15).
- **Fix:** Default runner uses `spawn` with `shell:false` and ignored stdout. `execa` remains an installed dependency (locked by Plan 01) but is not imported.
- **Files:** apps/api/src/engine/subprocess-runner.ts
- **Committed in:** `a6de8a5`

**3. [Rule 2 - Missing Critical] `--` end-of-options separator in the git clone argv**
- **Found during:** Task 1 (GREEN)
- **Issue:** A repository URL beginning with `-` could be reinterpreted as a git flag even with `shell:false`.
- **Fix:** argv is `['clone','--depth','1','--',repoUrl,cloneDir]`; a test asserts the destination stays the exact supplied `cloneDir`.
- **Files:** apps/api/src/engine/repo-cloner.adapter.ts
- **Committed in:** `a6de8a5`

**4. [Rule 1 - Lint] Replaced unnecessary type assertions with destructuring in error-narrowing helpers**
- **Found during:** Task 2 (GREEN, lint pass)
- **Issue:** `@typescript-eslint/no-unnecessary-type-assertion` flagged the `(error as {code:string}).code` casts after `'code' in error` narrowing.
- **Fix:** Destructure `{ code }` / `{ stderr }` from the narrowed object and check `typeof`.
- **Files:** apps/api/src/engine/scan-error.ts, apps/api/src/engine/temp-artifact-cleaner.ts
- **Committed in:** `839c735`

**Total deviations:** 4 auto-fixed (2 blocking/structural, 1 missing-critical security, 1 lint). No architectural changes; no scope creep beyond the shared runner seam.

## Threat Model Coverage
- **T-03-05 (subprocess tampering):** argv arrays + `shell:false` everywhere, `--` guard, paths confined under `SCAN_TMP_DIR` (scanId sanitized), read-only clone mount, explicit `/out` mapping. No `exec`/shell strings.
- **T-03-06 (report DoS):** `--output` to disk, `spawn` stdout ignored (report never buffered), host report stat-validated before readiness.
- **T-03-07 (info disclosure):** `classifyScanError` redacts credentials + absolute paths and caps detail at 500 chars; raw stderr bounded and kept for logs only.
- **T-03-09 (temp artifacts):** idempotent recursive cleanup of both paths, ENOENT-tolerant, tested against success/EBUSY.
- **T-03-SC (supply chain):** no new dependencies added; only the Plan 01-approved pins are used, and the Trivy image is the pinned `0.69.3` tag.

## Known Stubs
None. All adapters are fully implemented and unit-tested. The `SCAN_ENGINE_TEST_FAULT` / `SCAN_ENGINE_READY_MARKER` env keys are validated here and consumed by Plan 03 (worker) / Plan 04 (integration harness) as designed.

## Next Phase Readiness
- Plan 03 (`ScanWorker`) can inject these adapters via `useFactory` (reading `SCAN_TMP_DIR` for the allocator) and sequence: `markScanning → allocate → clone → trivy.run(onReportReady) → for-await parser → markFinished`, with `classifyScanError` + `TempArtifactCleaner.remove` in the failure/`finally` paths.
- `TrivyRunOptions.onReportReady` is the seam for the worker to begin `ReportParser.parse(reportPath)` only after the host report is confirmed present.
- Keep `@nestjs/bullmq` out of any jest-loaded module (recorded blocker); the `@Processor` shell should stay thin and delegate to a plain injectable engine class.

## Self-Check: PASSED
All 12 created files + the modified `env.validation.ts` exist on disk. All four task commits (`b119776`, `a6de8a5`, `a9fc772`, `839c735`) are present in history. Pinned image `aquasecurity/trivy:0.69.3` confirmed present in `trivy-runner.adapter.ts`. Gates: focused suites 17/17 pass, full api suite 41 passed / 3 skipped, `tsc --noEmit` clean, `eslint .` clean, `npm run build` compiles engine adapters to `dist/engine/`.
