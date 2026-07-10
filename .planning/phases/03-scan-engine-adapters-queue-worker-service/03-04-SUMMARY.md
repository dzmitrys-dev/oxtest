---
phase: 03-scan-engine-adapters-queue-worker-service
plan: 04
subsystem: engine
tags: [integration, docker, trivy, bullmq, redis, worker, ci, fixture, fault-injection, process-contract]

# Dependency graph
requires:
  - phase: 03-scan-engine-adapters-queue-worker-service
    plan: 01
    provides: Redis ScanRepository (hash+list, 7-day TTL, terminal guards), typed ScanJob/SCAN_QUEUE, shared ScanModule, Phase 3 npm scripts
  - phase: 03-scan-engine-adapters-queue-worker-service
    plan: 02
    provides: RepoCloner/ScanPathAllocator/TrivyRunner adapters, pinned ghcr.io/aquasecurity/trivy:0.69.3 Docker fallback + mount contract, TempArtifactCleaner, classifyScanError, env fault/marker allowlists
  - phase: 03-scan-engine-adapters-queue-worker-service
    plan: 03
    provides: concurrency-one ScanEngine, thin ScanWorker WorkerHost, adapter-factory SCAN_ENGINE_TEST_FAULT seam + REPORT_READY producer, compiled dist/worker.js with SCAN_WORKER_READY sentinel
  - phase: 02-streaming-parse-pipeline-memory-proof
    provides: streaming ReportParser (consumed unchanged over the real Trivy report)
provides:
  - Committed reproducible sample-repo.bundle fixture (lodash@4.17.11 + minimist@1.2.0 → two ordered CRITICAL CVEs) + deterministic generator
  - End-to-end integration harness proving the real compiled worker over disposable Redis + Docker Trivy (success + clone/trivy/disk-full/parse faults + terminal guard)
  - Docker-free static process/command-safety contract (always-run)
  - Machine-readable Docker/Redis/Trivy feasibility probe (feasible=true|false, fail-closed on probe error)
  - Node 22 CI workflow with always-run scan-engine-contract + conditional scan-engine-integration, plus checked-in CI-CONTRACT.md
affects: [phase-04-api-transport]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Committed Git bundle as the SOLE offline repository source; git clone --depth 1 <bundle> <dest>"
    - "Tight-loop Redis status observer reliably captures the brief Scanning window even on instantaneous fault paths"
    - "Synchronous statSync at REPORT_READY line-receipt proves report-file existence before parser/cleanup"
    - "Disposable Docker Redis on an ephemeral loopback port with status-preserving finally teardown"
    - "Fault injection through the env-locked SCAN_ENGINE_TEST_FAULT seam across the real worker/BullMQ/Redis boundary"
    - "Always-run static process contract + conditional Docker gate driven by a machine-readable feasibility probe"

key-files:
  created:
    - apps/api/test-fixtures/create-sample-repo-bundle.mjs
    - apps/api/test-fixtures/sample-repo.bundle
    - apps/api/test-fixtures/tsconfig.json
    - apps/api/scripts/scan-engine-integration.mjs
    - apps/api/scripts/scan-engine-process-contract.test.mjs
    - apps/api/scripts/scan-engine-feasibility.mjs
    - .github/workflows/scan-engine.yml
    - .github/CI-CONTRACT.md
  modified:
    - .gitignore

key-decisions:
  - "Fixture pins lodash@4.17.11 (CVE-2019-10744) + minimist@1.2.0 (CVE-2021-44906) in a package-lock.json: two deterministic ordered CRITICALs that Trivy 0.69.3 flags offline; every vulnerability leaf carries Title+PrimaryURL so the strict ReportParser never rejects"
  - "Docker Trivy is exercised via the adapter's launch-failure fallback (no local trivy binary in this env or CI), not a force-docker flag (the adapter is single-owner and has no such option)"
  - "Scanning-transition capture uses a hot tight-poll loop on a dedicated Redis connection (proven 6/6 non-flaky) rather than keyspace notifications"
  - "No-artifacts assertion checks absence of the cloneDir (repo/) and reportPath (report.json) under SCAN_TMP_DIR — the exact Plan 02 cleaner contract; empty allocator base/out shells are out of the cleaner's ownership and permitted to remain"
  - "Added apps/api/test-fixtures/tsconfig.json (checkJs:false) so eslint's typed projectService can lint the .mjs generator without editing the protected eslint.config.mjs; inert for tsc/nest builds"

requirements-completed: [ENGINE-01, ENGINE-02, ENGINE-03, ENGINE-04, ENGINE-06, ENGINE-07, ERR-01, ERR-02, ERR-03, ERR-04]

coverage:
  - id: D-25
    description: "Compiled dist/worker.js consumes a BullMQ job from disposable Redis, clones the committed bundle, runs Docker Trivy honoring the mount/report-visibility contract, stream-parses real Trivy JSON, stores ordered CRITICALs"
    requirement: ENGINE-01
    verification:
      - kind: integration
        ref: "apps/api/scripts/scan-engine-integration.mjs#success: compiled worker clones the bundle, runs Docker Trivy, and stores ordered CRITICALs"
        status: pass
    human_judgment: false
  - id: D-26
    description: "Harness provisions disposable Redis and exercises the real compiled worker process through BullMQ/Redis (never an in-process worker)"
    requirement: ENGINE-02
    verification:
      - kind: integration
        ref: "apps/api/scripts/scan-engine-integration.mjs#spawnWorker/dist/worker.js + startDisposableRedis"
        status: pass
    human_judgment: false
  - id: D-27
    description: "Deterministic clone/Trivy/ENOSPC/parser fault injection through the adapter seam retaining the real worker/Redis lifecycle"
    requirement: ERR-02
    verification:
      - kind: integration
        ref: "apps/api/scripts/scan-engine-integration.mjs#failure: injected {clone,trivy,disk-full,parse} fault"
        status: pass
    human_judgment: false
  - id: D-28
    description: "Asserts Queued→Scanning→Finished or →Failed, bounded status/reason/detail, and absence of clone/report artifacts on every path"
    requirement: ERR-03
    verification:
      - kind: integration
        ref: "apps/api/scripts/scan-engine-integration.mjs#observer.observed deepEqual + assertNoScanArtifacts + readFailureReason bounds"
        status: pass
    human_judgment: false
  - id: D-29
    description: "Docker-backed command is explicitly named and conditionally executed; always-required contract fails closed on probe error; feasibility skip is recorded without weakening local assertions"
    requirement: ENGINE-04
    verification:
      - kind: integration
        ref: ".github/workflows/scan-engine.yml + apps/api/scripts/scan-engine-feasibility.mjs + .github/CI-CONTRACT.md"
        status: pass
      - kind: unit
        ref: "apps/api/scripts/scan-engine-process-contract.test.mjs (10 static assertions)"
        status: pass
    human_judgment: false
  - id: D-guard
    description: "Terminal states protected against duplicate jobs; original-error precedence; BullMQ job failure rethrow (no retry)"
    requirement: ERR-04
    verification:
      - kind: integration
        ref: "apps/api/scripts/scan-engine-integration.mjs#terminal guard + job.getState()==='failed' per fault"
        status: pass
    human_judgment: false

# Metrics
duration: 90min
completed: 2026-07-10
status: complete
---

# Phase 3 Plan 04: End-to-End Scan-Engine Integration Proof Summary

**A committed, reproducible `sample-repo.bundle` (two ordered CRITICAL CVEs) drives the REAL compiled `dist/worker.js` across a disposable Redis + pinned Docker Trivy boundary — proving Queued→Scanning→Finished with ordered CRITICAL storage, seven-day TTL, and full artifact cleanup on success, plus deterministic Queued→Scanning→Failed for clone/trivy/disk-full/parse faults and terminal-state protection — behind an always-run Docker-free process contract and a machine-readable feasibility-gated Node 22 CI workflow.**

## Performance
- **Duration:** ~90 min (includes de-risking spikes against real Docker Trivy + Redis)
- **Started:** 2026-07-10T17:23Z (approx; first task commit)
- **Completed:** 2026-07-10
- **Tasks:** 3
- **Files created/modified:** 9 (8 created, 1 modified)
- **Tests:** integration harness 6/6 pass (1 Docker success + 4 fault + 1 terminal guard); process contract 10/10; Jest unit suite 59 passed / 3 skipped

## Accomplishments
- **Task 1 — fixture + success proof:** Authored a deterministic `create-sample-repo-bundle.mjs` (fixed bytes, author, and commit dates → byte-reproducible bundle, verified by double-run sha256) that pins `lodash@4.17.11` (CVE-2019-10744) and `minimist@1.2.0` (CVE-2021-44906) in a `package-lock.json`. Committed the resulting `sample-repo.bundle` as the only repository source. Built `scan-engine-integration.mjs`: starts a disposable Redis container on an ephemeral loopback port, builds and spawns the compiled `dist/worker.js` with a validated argv array (`shell:false`), waits for the independent `SCAN_WORKER_READY` sentinel, enqueues a typed BullMQ job, consumes the distinct `REPORT_READY <path>` marker (synchronous host `stat` proving the file exists at event time, before any terminal state or cleanup), and asserts Queued→Scanning→Finished, exactly two ordered CRITICALs, seven-day TTL on both keys, and no surviving clone/report artifacts.
- **Task 2 — full-lifecycle failure coverage:** Extended the harness with clone/trivy/disk-full/parse fault cases driven through the compiled worker's env-locked `SCAN_ENGINE_TEST_FAULT` seam over the real BullMQ/Redis boundary. Each asserts the exact Queued→Scanning→Failed progression, the correct original-stage category, a bounded (≤500) redacted reason with no uncontrolled path, the BullMQ job failure rethrow (`state==='failed'`, no retry), empty results, cleanup, and refreshed TTL. Added a terminal-guard case: a duplicate job for a Finished scan is still rethrown but never flips the terminal state to Scanning or mutates stored CRITICALs.
- **Task 3 — contract, probe, CI:** Added a Docker-free static `scan-engine-process-contract.test.mjs` (10 assertions locking argv/shell:false spawn, compiled `dist/worker.js`, distinct readiness markers, pinned GHCR image + mount contract, concurrency:1 with no retry/backoff, transport-free ScanService/worker root, opt-in fail-closed fault seam, out-of-scope boundary). Added `scan-engine-feasibility.mjs` (machine-readable docker/redis/trivy/memory probe: clean infeasible exits 0 and skips integration; unexpected probe error exits 1 and fails the contract closed). Added `.github/workflows/scan-engine.yml` with an always-run `scan-engine-contract` job and a conditional `scan-engine-integration` job gated on `feasible=='true'`, and a checked-in `.github/CI-CONTRACT.md` documenting the non-dynamic branch-protection policy.

## Task Commits
1. **Task 1: fixture bundle + Docker-backed success harness** — `1e4b915`
2. **Task 2: deterministic full-lifecycle failure coverage** — `4631411`
3. **Task 3: process contract, feasibility probe, conditional CI gate** — `86aadb0`

## Files Created/Modified
- `apps/api/test-fixtures/create-sample-repo-bundle.mjs` — deterministic reproducible bundle generator (argv-safe git, fixed identity/dates)
- `apps/api/test-fixtures/sample-repo.bundle` — committed offline repository source (two ordered CRITICAL CVEs)
- `apps/api/test-fixtures/tsconfig.json` — scopes the .mjs generator into a TS project for eslint's typed projectService (inert for builds)
- `apps/api/scripts/scan-engine-integration.mjs` — disposable Redis + compiled-worker + Docker Trivy end-to-end harness (success, faults, terminal guard)
- `apps/api/scripts/scan-engine-process-contract.test.mjs` — always-run Docker-free static process/command-safety contract
- `apps/api/scripts/scan-engine-feasibility.mjs` — machine-readable Docker/Redis/Trivy feasibility probe
- `.github/workflows/scan-engine.yml` — Node 22 always-run contract + conditional Docker integration gate
- `.github/CI-CONTRACT.md` — checked-in branch-protection/status contract
- `.gitignore` — ignore the generated `scan-engine-feasibility.json` artifact

## Decisions Made
- **Fixture selection was empirically de-risked, not assumed.** Before finalizing, real Docker Trivy 0.69.3 was run against candidate lockfiles: `lodash@4.17.11` yields exactly one CRITICAL (CVE-2019-10744); adding `minimist@1.2.0` gives a second (CVE-2021-44906) in stable report order. All 9 vulnerability leaves carry `Title`+`PrimaryURL`, so the strict Phase 2 `ReportParser` (which validates every leaf and throws on a missing field) never rejects — a genuine integration risk that only surfaces against real Trivy output.
- **Scanning-transition observation** uses a hot tight-poll loop on a dedicated Redis connection; a spike proved it captures the brief Scanning window 6/6 even on the instantaneous clone-fault path (each worker transition is a Redis round-trip that widens the window enough).
- **Docker mode is reached via the adapter's launch-failure fallback** (no local `trivy` on PATH in this environment or on GitHub-hosted runners), because the single-owner `TrivyRunnerAdapter` exposes no force-docker flag and must not be edited here.
- **Cleanup assertion** matches the exact Plan 02 contract (absence of `repo/` and `report.json`); the allocator's empty base/`out` directory shells remain and are outside the cleaner's ownership.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added `apps/api/test-fixtures/tsconfig.json` so eslint can lint the generator**
- **Found during:** Task 1 (lint gate)
- **Issue:** `eslint .` uses `projectService: true`; the new `test-fixtures/*.mjs` file is in no TS project, producing a fatal parsing error. `scripts/**` avoids this only because it is eslint-ignored, but `eslint.config.mjs` is guarded by a config-protection hook and cannot be edited to add `test-fixtures/**`.
- **Fix:** Added a nested `test-fixtures/tsconfig.json` (`allowJs`, `checkJs:false`) that scopes the `.mjs` into a project for the typed projectService. It is inert for builds (`tsc --noEmit`/`nest build` use `../tsconfig.json` and `../tsconfig.build.json`, which only include `src/**`). Then added JSDoc types to the generator's `git()` helper to satisfy `no-unsafe-*`.
- **Files:** apps/api/test-fixtures/tsconfig.json, apps/api/test-fixtures/create-sample-repo-bundle.mjs
- **Verification:** `npm run lint` and `npm run typecheck` both clean.
- **Committed in:** `1e4b915`

**2. [Rule 3 - Blocking] `.gitignore` entry for the generated feasibility artifact**
- **Found during:** Task 3
- **Issue:** The probe writes `apps/api/scan-engine-feasibility.json` (uploaded as a CI artifact); leaving it untracked risks accidental commits.
- **Fix:** Added a `.gitignore` rule for `scan-engine-feasibility.json`.
- **Files:** .gitignore
- **Committed in:** `86aadb0`

### Contract nuances kept UNIT-covered (not integration-forced)
Two Task 2 behaviours are intentionally NOT reachable through the env-locked seam and were deliberately **not** forced by editing the single-owner `adapter-factory.ts` / `env.validation.ts` (both prohibited by this plan):
- **"parser yields one vulnerability THEN rejects":** the env `parse` fault rejects immediately (before any yield). Both prove the same invariant — Failed(parse), not Finished, original reason retained, cleanup — and the mid-stream-yield ordering is unit-covered in `scan-engine.spec.ts` (Plan 03 Test 2b/4).
- **"cleanup failure never masks the original reason":** the `cleanup` fault is deliberately excluded from the fail-closed env allowlist (unit-only mode; scan-engine.spec Test 4d). Integration instead proves primary-stage precedence — the persisted category is always the original failing stage, never a cleanup category.

**Total deviations:** 2 auto-fixed (both blocking/tooling). No architectural changes; no edits to the prohibited single-owner files (adapter-factory.ts, worker.module.ts, env.validation.ts, package.json dependency versions). Package scripts were already present from Plan 01.

## Threat Model Coverage
- **T-03-10 (child-process tampering):** every subprocess (git, docker, worker) spawned with a discrete argv array and `shell:false`; generated temp paths confined under a per-test SCAN_TMP_DIR; teardown traps preserve the primary status.
- **T-03-11 (DoS):** disposable containers, bounded finite timeouts, one worker concurrency, deterministic fixed-size fixture, never live GitHub content (offline bundle only).
- **T-03-12 (info disclosure):** integration asserts the persisted reason is bounded ≤500 and contains no uncontrolled filesystem path; only bounded diagnostics/container ids are printed.
- **T-03-13 / T-03-SC (supply chain):** CI uses `npm ci` (committed lockfile), the reviewed pinned `ghcr.io/aquasecurity/trivy:0.69.3` image, and the contract fails if the image tag or mount policy changes; no new dependencies added.

## Known Stubs
None. The terminal-guard test seeds a synthetic Finished record (with realistic CRITICAL entries) purely to exercise the repository's terminal guard against a duplicate job — it is deterministic test setup, not a production stub. The Docker success path uses the real committed fixture, real clone, real Trivy, and the real streaming parser end-to-end.

## User Setup Required
None. Local/CI runs need Docker (for disposable Redis + Trivy); the feasibility probe records a clean skip where Docker is unavailable. No new external service configuration or env keys.

## Next Phase Readiness
- The complete scan engine is now proven across its real process boundary: HTTP/GraphQL transport (Phase 4) can enqueue via the existing `ScanService` and read authoritative Redis state with confidence that the worker lifecycle, Docker Trivy path, ordered CRITICAL storage, failure classification, and cleanup all hold end-to-end.
- CI provides an always-required `scan-engine-contract` plus a feasibility-gated Docker integration proof; branch protection guidance is checked in at `.github/CI-CONTRACT.md`.
- Carried-forward toolchain note (unchanged): keep `@nestjs/bullmq` out of any jest-loaded module; the .mjs/node harnesses and compiled `dist/worker.js` are unaffected.

## Self-Check: PASSED

---
*Phase: 03-scan-engine-adapters-queue-worker-service*
*Completed: 2026-07-10*
