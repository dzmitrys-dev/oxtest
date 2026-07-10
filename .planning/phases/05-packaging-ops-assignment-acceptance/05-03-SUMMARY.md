---
phase: 05-packaging-ops-assignment-acceptance
plan: 03
subsystem: acceptance-ci
tags: [acceptance, ci, memory-proof, oom, integration, ops, node-test, feasibility-gated]

# Dependency graph
requires:
  - phase: 05-packaging-ops-assignment-acceptance
    provides: "05-01 scanId-correlated pino ndjson seam (API enqueue line + worker lifecycle lines); WR-03 non-throwing REDIS_CLIENT error listener that lets index.js boot with unreachable Redis"
  - phase: 05-packaging-ops-assignment-acceptance
    provides: "05-02 multi-stage node:22-slim image (code-guardian-app:latest), docker-compose.yml worker service (mem_limit:200m, --max-old-space-size=150), dist/scripts/memtest.js in the runtime image"
  - phase: 04-required-rest-api-runtime-lifecycle
    provides: "api-integration.mjs helper shapes, dist/index.js + dist/worker.js two-entrypoint topology, GET /health, bounded SIGTERM drain"
  - phase: 02-streaming-parse-pipeline-memory-proof
    provides: "memtest.ts + gen-fixture.ts reused for the 500MB parse proof"
provides:
  - "Docker-FREE authoritative criterion-#5a self-test (selftest-index-boot.mjs) — always-required in CI"
  - "assignment-level acceptance harness (acceptance.mjs) — criteria #1/#3/#5 over compiled dist + disposable Redis"
  - "compose-driven in-container OOM proof (docker-oom-proof.mjs) — OOMKilled==false AND exit 0 (criterion #2)"
  - "extended scan-engine.yml (always-required selftest step + 3 feasibility-gated jobs) and updated CI-CONTRACT.md"
  - "npm scripts test:selftest, test:acceptance, test:oom:container"
affects: [phase-06-docs-onboarding]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Docker-free self-test: verbatim `node --max-old-space-size=150 dist/index.js` against a CLOSED loopback Redis port (allocate-then-release) — always-required, needs no infra"
    - "OOM false-negative guard: assert BOTH `{{.State.OOMKilled}}` == false AND `{{.State.ExitCode}}` == 0 (never OOMKilled alone)"
    - "Tiered CI: Docker-free selftest in the always-required contract job; Docker/Redis/Trivy jobs feasibility-gated (required-when-run, skipped-with-reason, fail-closed-on-unknown)"
    - "scanId cross-process correlation asserted by parsing ndjson stdout of BOTH the API and worker processes for a shared scanId field"

key-files:
  created:
    - apps/api/scripts/selftest-index-boot.mjs
    - apps/api/scripts/acceptance.mjs
    - apps/api/scripts/docker-oom-proof.mjs
  modified:
    - apps/api/package.json
    - .github/workflows/scan-engine.yml
    - .github/CI-CONTRACT.md

key-decisions:
  - "selftest-index-boot.mjs is a standalone node:test .mjs (no tsx, no Docker, no Redis) so criterion #5a is provable on a Docker-less runner and wired as a NON-gated step in the always-required scan-engine-contract job"
  - "The Docker-FREE selftest is the AUTHORITATIVE #5a proof; the acceptance harness's criterion-#5 case is a richer Docker-path SUPERSET (boots both entrypoints under the heap flag over disposable infra)"
  - "Every acceptance case needs a disposable Redis (a container), so all are gated with isDockerAvailable()+t.skip(reason) rather than throwing — never fail closed on an infeasible runner (D-12)"
  - "The in-container OOM proof lives in a dedicated compose-driven script (docker-oom-proof.mjs), not inside the acceptance harness, and asserts `false 0` from docker inspect; it passes MEMTEST_EXPECTED_CRITICAL_COUNT so survival also proves a FULL stream parse"
  - "Three feasibility-gated CI jobs (scan-engine-api-integration, scan-engine-acceptance, scan-engine-oom) mirror the scan-engine-integration template; memory.yml is left byte-identical"

patterns-established:
  - "Allocate-then-release an ephemeral loopback port and reuse it as a guaranteed-CLOSED REDIS_PORT to prove clean boot without any broker"
  - "Feasibility-gated proof script: cleanly-infeasible -> {feasible:false,reason} exit 0; unexpected error -> exit 1 (fail closed) — mirroring scan-engine-feasibility.mjs"

requirements-completed: [OPS-05, OPS-02]

coverage:
  - id: D1
    description: "criterion #5a (Docker-FREE): verbatim `node --max-old-space-size=150 dist/index.js` boots to `API HTTP listener ready` against a CLOSED Redis port, still alive at the marker, clean SIGTERM exit never 134/137"
    requirement: "OPS-05"
    verification:
      - kind: other
        ref: "node --test scripts/selftest-index-boot.mjs -> 1 pass (641ms), exit 0 on this runner (Docker-free path)"
        status: pass
    human_judgment: false
  - id: D2
    description: "criterion #1 (happy): POST -> 202 {scanId,Queued}; a real Trivy scan of the committed bundle reaches Finished; GET returns the two pinned CRITICAL CVEs; assertNoScanArtifacts (cleanup on success)"
    requirement: "OPS-02"
    verification:
      - kind: integration
        ref: "acceptance.mjs 'criterion #1 (happy)' -> pass (33.0s, real pinned Trivy 0.69.3 over disposable redis:7-alpine)"
        status: pass
    human_judgment: false
  - id: D3
    description: "criterion #1 (forced failure): POST -> 202 -> worker(fault:clone,NODE_ENV=test) -> Failed(clone) via GET, Queued->Scanning->Failed lifecycle, assertNoScanArtifacts (cleanup on failure)"
    requirement: "OPS-02"
    verification:
      - kind: integration
        ref: "acceptance.mjs 'criterion #1 (forced failure)' -> pass (1.9s, deterministic no-network)"
        status: pass
    human_judgment: false
  - id: D4
    description: "criterion #3 (correlation): the API enqueue ndjson line AND a worker lifecycle ndjson line both carry the same scanId (OPS-04 end-to-end)"
    requirement: "OPS-05"
    verification:
      - kind: integration
        ref: "acceptance.mjs 'criterion #3 (correlation)' -> pass (2.1s, streamHasScanId true on both api.state.stdout and worker.state.stdout)"
        status: pass
    human_judgment: false
  - id: D5
    description: "criterion #5 (richer Docker-path superset): dist/index.js + dist/worker.js both boot clean under --max-old-space-size=150; the reused memtest parses a >=500MB fixture @150 and exits 0"
    requirement: "OPS-05"
    verification:
      - kind: integration
        ref: "acceptance.mjs 'criterion #5 (Docker-path superset)' pass (1.7s) + 'criterion #5b' pass (62.3s, 512MB fixture, memtest exit 0)"
        status: pass
    human_judgment: false
  - id: D6
    description: "criterion #2 (in-container OOM): the worker image runs the reused memtest against a >=500MB fixture under --memory=200m + --max-old-space-size=150; docker inspect yields OOMKilled==false AND ExitCode==0"
    requirement: "OPS-02"
    verification:
      - kind: integration
        ref: "docker-oom-proof.mjs -> {survived:true, inspect:'false 0', peakRssMb:101.9, criticalCount:262944} exit 0"
        status: pass
    human_judgment: false
  - id: D7
    description: "criterion #4 (CI gating): scan-engine.yml adds the always-required Docker-free selftest step + 3 feasibility-gated jobs; memory.yml unchanged; CI-CONTRACT.md job identifiers match the workflow"
    requirement: "OPS-05"
    verification:
      - kind: other
        ref: "js-yaml parse -> 5 jobs; test:selftest is a non-gated step in scan-engine-contract (no `if:`); feasible=='true' count 4; git diff --exit-code memory.yml clean; lint+typecheck exit 0"
        status: pass
    human_judgment: false

# Metrics
duration: 10min
completed: 2026-07-10
status: complete
---

# Phase 5 Plan 03: Assignment Acceptance Gate, In-Container OOM Proof & CI Wiring Summary

**A Docker-FREE always-required self-test proves the verbatim `node --max-old-space-size=150 dist/index.js` boots clean (criterion #5a), a single `test:acceptance` command proves POST->Finished+CRITICAL with cleanup on success AND forced failure plus cross-process scanId correlation and the richer Docker-path #5 superset, a compose-driven step proves the worker survives a 512MB fixture in-container with `OOMKilled==false AND exit 0` (criterion #2), and scan-engine.yml now gates all of it (criterion #4) with memory.yml left untouched.**

## Performance
- **Duration:** ~10 min
- **Started:** 2026-07-10T20:36:49Z
- **Completed:** 2026-07-10T20:47:34Z
- **Tasks:** 3
- **Files modified:** 6 (3 created, 3 modified)

## Accomplishments
- **`selftest-index-boot.mjs` (criterion #5a, Docker-FREE, authoritative):** spawns the verbatim graded command with `REDIS_PORT` pointed at a CLOSED loopback port (allocate-then-release), asserts the exact `API HTTP listener ready` marker while the child is still alive (`exitCode===null`), SIGTERM-drains it, and asserts a clean exit that is NEVER `134`/`137` (abort/OOM-kill guard). Needs neither Docker nor Redis nor tsx. `node --test` -> 1 pass, exit 0.
- **`acceptance.mjs` (criteria #1, #3, richer #5):** node:test harness cloning the proven `api-integration.mjs` helper shapes (self-contained). Five cases, all green on this runner: happy `POST->202 Queued` + real pinned-Trivy scan of the committed bundle to `Finished` with the two pinned CRITICAL CVEs + cleanup-on-success; forced-failure `clone` fault to `Failed(clone)` + cleanup-on-failure; cross-process `scanId` correlation (API line + worker line share the id in ndjson stdout); Docker-path criterion-#5 superset (both entrypoints boot under `--max-old-space-size=150`); and the 512MB memtest parse @150.
- **`docker-oom-proof.mjs` (criterion #2):** builds the Plan-02 worker image via `docker compose build worker`, runs the reused `dist/scripts/memtest.js` against a 512MB fixture inside a one-shot `--memory=200m` container under `--max-old-space-size=150`, and asserts `docker inspect --format '{{.State.OOMKilled}} {{.State.ExitCode}}'` equals `false 0`. Observed peak RSS 101.9MB (well under 200m), 262,944 CRITICALs fully parsed. Feasibility-gated and self-cleaning.
- **CI wiring (criterion #4, OPS-05):** the always-required `scan-engine-contract` job now runs `test:selftest` as a NON-gated step (criterion #5a holds on Docker-less runners); three new feasibility-gated jobs (`scan-engine-api-integration`, `scan-engine-acceptance`, `scan-engine-oom`) mirror the `scan-engine-integration` template; `.github/CI-CONTRACT.md` documents every new identifier and keeps fail-closed-on-unknown semantics; `memory.yml` is byte-identical.

## Task Commits
1. **Task 1: Docker-free #5a selftest + acceptance harness** — `2483602` (feat)
2. **Task 2: compose-driven in-container OOM proof** — `3fab66e` (feat)
3. **Task 3: wire selftest + acceptance + api-integration + OOM CI jobs** — `db87833` (ci)

## Files Created/Modified
- `apps/api/scripts/selftest-index-boot.mjs` (new) — Docker-FREE always-required criterion-#5a boot proof.
- `apps/api/scripts/acceptance.mjs` (new) — end-to-end acceptance + correlation + criterion-#5 harness.
- `apps/api/scripts/docker-oom-proof.mjs` (new) — compose-driven in-container `OOMKilled:false AND exit 0` proof.
- `apps/api/package.json` — added `test:selftest`, `test:acceptance`, `test:oom:container` scripts.
- `.github/workflows/scan-engine.yml` — non-gated selftest step in the contract job + 3 feasibility-gated jobs; header comment updated.
- `.github/CI-CONTRACT.md` — new status rows + per-status prose + updated feasibility/policy notes.

## Decisions Made
- **Docker-free selftest is the authoritative #5a proof; the acceptance harness case is a richer Docker-path superset.** This lets criterion #5a (the single-most-graded artifact) be an always-required contract-job gate that holds even without Docker, while the acceptance harness still boots both entrypoints under the heap flag over real infrastructure.
- **All acceptance cases gated with `isDockerAvailable()+t.skip`.** Because every case needs a disposable Redis container, guarding before `withHarness` (which throws via `assertDockerAvailable`) keeps the infeasible-runner behavior a clean skip-with-reason, never a fail-closed (D-12).
- **OOM proof passes `MEMTEST_EXPECTED_CRITICAL_COUNT` from the generator output.** Survival then also proves a FULL stream parse (262,944 CRITICALs) rather than an early bail-out — strengthening the memory claim beyond mere non-OOM.
- **Feasibility semantics reused verbatim** from `scan-engine-feasibility.mjs`: cleanly-infeasible -> `{feasible:false,reason}` exit 0; unexpected error -> exit 1 (fail closed).

## Deviations from Plan
None — the plan executed exactly as written. All three tasks' `<verify>` commands and `<acceptance_criteria>` passed on the first run; Docker was available so every Docker-bound gate ran live (not skipped).

## Threat Model Adherence
- **T-05-03-01 / T-05-03-05 (tampering / DoS):** feasibility probe fails closed on unknown state; every subprocess uses discrete argv + `shell:false` + finite bounded timeouts; the one-shot OOM container and fixture are removed in teardown regardless of outcome.
- **T-05-03-03 (OOM false-negative):** asserted BOTH `OOMKilled==false` AND `ExitCode==0` (`false 0`).
- **T-05-03-04 (fault seam in prod):** the forced-failure/correlation cases run the worker under `NODE_ENV=test` ONLY; the happy path runs `production` with real adapters.
- **T-05-03-02 / T-05-03-SC:** loopback/disposable infra, pinned `redis:7-alpine` + `ghcr.io/aquasecurity/trivy:0.69.3`, `npm ci` lockfile install; OOM-proof output limited to inspect state + RSS metrics.

## User Setup Required
None — `test:selftest` needs no infrastructure; `test:acceptance` and `test:oom:container` require Docker (present on this runner) and are otherwise feasibility-gated.

## Next Phase Readiness
- The submission is now a single CI-gated set of runnable commands. Phase 6 (docs/ONBOARDING + GraphQL + React) can document the copy-paste acceptance command, the D-10 self-test mapping (literal `index.js` vs the memory-critical `worker.js`), and the D-06 socket-mount trade-off.
- All five ROADMAP success criteria are proven or feasibility-gated with recorded reasons. No blockers.

## Self-Check: PASSED
- Created files verified on disk: `selftest-index-boot.mjs`, `acceptance.mjs`, `docker-oom-proof.mjs` — all FOUND.
- Task commits verified in git log: `2483602`, `3fab66e`, `db87833` — all FOUND.
- Verifications green: selftest 1 pass; acceptance 5 pass; OOM proof `false 0` exit 0; scan-engine.yml parses to 5 jobs with the non-gated selftest step and 4 feasibility gates; memory.yml byte-identical; lint + typecheck exit 0.

---
*Phase: 05-packaging-ops-assignment-acceptance*
*Completed: 2026-07-10*
