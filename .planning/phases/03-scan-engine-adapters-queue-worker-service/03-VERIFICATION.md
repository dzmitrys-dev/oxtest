---
phase: 03-scan-engine-adapters-queue-worker-service
verified: 2026-07-10T18:10:00Z
status: passed
score: 6/6 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: none
  note: "Initial verification — no prior VERIFICATION.md existed."
---

# Phase 3: Scan Engine — Adapters, Queue, Worker & Service Verification Report

**Phase Goal:** The assignment's required async scan engine runs end-to-end in the background — clone → Trivy → stream-parse → store — with clean ports-and-adapters separation, correct error handling, and guaranteed cleanup on every path.
**Verified:** 2026-07-10T18:10:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

The clone → Trivy → stream-parse → store pipeline is real, wired, and behaviorally proven. Lifecycle logic lives in a framework-free `ScanEngine` (unit-tested for state transitions, ordering, and every failure/cleanup path), wrapped in a thin `@Processor(concurrency:1)` `WorkerHost`, wired through a transport-free `WorkerModule`, and persisted to Redis through a WATCH/MULTI/EXEC-guarded `ScanRepository`. I independently ran typecheck, lint, build, the jest suite (59 passed / 3 skipped), the Docker-free static process/command-safety contract (10/10), and the compiled-worker process contract that boots the real `dist/worker.js` against a Redis stub (4/4). The full real Docker Trivy end-to-end is verified-by-executor (see note below), not re-run here.

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Enqueue → worker (`concurrency:1`) shallow-clones (argv, no shell), runs Trivy to a report file via `--output`, stream-parses a real Trivy report, persists CRITICAL, `Queued→Scanning→Finished` in Redis | ✓ VERIFIED | `scan-engine.spec.ts` Test 1 asserts exact event order `markScanning → clone → trivy.run → parse → append×3 (in order) → markFinished → cleanup`; `scan-worker.ts` `@Processor(SCAN_QUEUE_NAME,{concurrency:1})` delegates to `ScanEngine.run`; compiled `dist/worker.js` boots transport-free (worker-process-contract 4/4, run by verifier); real Docker e2e stored 2 ordered CRITICALs (verified-by-executor) |
| 2 | Trivy runs with or without a local binary (auto-detect + Docker fallback); "vulnerabilities found" is a success | ✓ VERIFIED | `trivy-runner.adapter.ts` prefers local `trivy`, falls back to pinned `ghcr.io/aquasecurity/trivy:0.69.3` ONLY on `launchFailed` (never after a genuine non-zero exit); local + Docker argv both use `--exit-code 0`; `scan-engine.spec.ts` Test 3 proves findings-as-success and single-run genuine-failure rethrow |
| 3 | Clone failure, ENOSPC, and mid-stream parse errors each mark `Failed` with a specific reason | ✓ VERIFIED | Tests 4a (clone→`clone`), 4b (ENOSPC→`disk-full`), 4c/2b (parse→`parse`) assert category + rethrow of the ORIGINAL error; `classifyScanError` promotes any ENOSPC to `disk-full`, redacts creds/paths, caps detail at 500 chars |
| 4 | Temp clone + report file deleted on both success and failure; forced faults leave no artifacts | ✓ VERIFIED | `scan-engine.ts` awaits `cleaner.remove` in `finally`; `TempArtifactCleanerAdapter` removes both paths, ENOENT-tolerant, never rethrows; every unit failure test asserts `cleaner.calls === 1`; integration `assertNoScanArtifacts` on every path (verified-by-executor) |
| 5 | `ScanService` has no `fs`/`child_process`; all I/O flows through injectable adapters (`RepoCloner`, `TrivyRunner`, `ReportParser`, `ScanRepository`) | ✓ VERIFIED | `scan.service.ts` imports only crypto/nest/bullmq-type + repository/queue tokens; static contract test asserts no `node:fs`/`node:child_process`/`execa`/`docker`; all four adapters exist behind ports and are constructed in `adapter-factory.ts` / bound in `scan.module.ts` |
| 6 | Integration tests prove findings=success, genuine failures=failed, and cleanup/error reasons are preserved | ✓ VERIFIED | `scan-engine-integration.mjs` (success + clone/trivy/disk-full/parse faults + terminal-guard, 6/6 verified-by-executor over real BullMQ/Redis + Docker Trivy); static `scan-engine-process-contract.test.mjs` 10/10 run by verifier; jest engine suite covers the same invariants deterministically |

**Score:** 6/6 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `apps/api/src/scan/scan.repository.port.ts` | Framework-free `ScanRepository` contract | ✓ VERIFIED | No Nest/BullMQ/ioredis/fs imports; 6 async methods + `SCAN_REPOSITORY` token |
| `apps/api/src/scan/scan.repository.ts` | Redis hash/list persistence, atomic transitions, 7-day TTL | ✓ VERIFIED | `ScanRepositoryAdapter`; WATCH/read-guard/MULTI-EXEC with retry; terminal-state guard; `EXPIRE` on both keys every write; list sentinel makes TTL observable |
| `apps/api/src/scan/scan.service.ts` | Queue submission + full read orchestration | ✓ VERIFIED | `enqueue` creates Queued + adds one `{scanId,repoUrl}` job; `get` single read; no fs/child_process |
| `apps/api/src/scan/scan.types.ts` | Single typed `ScanJob` payload | ✓ VERIFIED | `ScanJob {scanId,repoUrl}`, `SCAN_QUEUE_NAME`, `SCAN_JOB_NAME`, `SCAN_QUEUE` token |
| `apps/api/src/scan/scan.module.ts` | Shared DI seam for API + worker | ✓ VERIFIED | `BullModule.registerQueue`, repository/service/parser/queue bound + exported; imported identically by AppModule + WorkerModule |
| `apps/api/src/engine/repo-cloner.adapter.ts` | Shallow argv-safe clone consuming allocator cloneDir | ✓ VERIFIED | `['clone','--depth','1','--',repoUrl,cloneDir]`, `shell:false`; generates no paths |
| `apps/api/src/engine/scan-path-allocator.adapter.ts` | Exclusive cloneDir+reportPath allocator under SCAN_TMP_DIR | ✓ VERIFIED | Unique `<root>/<scanId>-<uuid>/{repo,out/report.json}`; sanitizes scanId; removes base on partial-allocation failure |
| `apps/api/src/engine/trivy-runner.adapter.ts` | Local Trivy + pinned Docker fallback | ✓ VERIFIED | Contains `ghcr.io/aquasecurity/trivy:0.69.3` (contains the `aquasecurity/trivy:0.69.3` substring the plan asserts); `--output`, `/src:ro`, `/out`, tmpfs cache; launch-error-only fallback |
| `apps/api/src/engine/temp-artifact-cleaner.ts` | Idempotent clone/report cleanup | ✓ VERIFIED | Removes both, ENOENT=success, logs-not-throws secondary errors |
| `apps/api/src/engine/scan-error.ts` | Bounded/redacted category classifier | ✓ VERIFIED | `clone|trivy|parse` + ENOSPC→`disk-full`; credential + absolute-path redaction; 500-char cap |
| `apps/api/src/engine/scan-engine.ts` | Concurrency-one lifecycle (see worker-split note) | ✓ VERIFIED | Full allocate→Scanning→clone→Trivy(onReportReady)→for-await ordered appends→Finished; Failed+rethrow+finally cleanup |
| `apps/api/src/engine/scan-worker.ts` | Thin `@Processor(concurrency:1)` WorkerHost | ✓ VERIFIED | Contains `concurrency: 1`; delegates to `ScanEngine`; `@OnWorkerEvent('error')` guard; only file importing `@nestjs/bullmq` |
| `apps/api/src/engine/adapter-factory.ts` | Production-real / test-fault construction | ✓ VERIFIED | Contains `SCAN_ENGINE_TEST_FAULT` resolution; `fault:'none'`→real adapters only; `reportReadyStdoutProducer` distinct from bootstrap sentinel |
| `apps/api/src/worker.ts` / `worker.module.ts` | Transport-free worker root + `SCAN_WORKER_READY` bootstrap | ✓ VERIFIED | No HTTP/GraphQL imports; `process.stdout.write('SCAN_WORKER_READY\n')` after `app.get(ScanWorker)`; boots cleanly (contract 4/4) |
| `apps/api/scripts/worker-process-contract.mjs` | Fail-closed compiled worker contract | ✓ VERIFIED | Contains `SCAN_WORKER_READY`; ran by verifier → 4/4 pass |
| `apps/api/test-fixtures/sample-repo.bundle` | Committed Git bundle | ✓ VERIFIED | Tracked in git; `file` reports "Git bundle"; generated by `create-sample-repo-bundle.mjs` |
| `apps/api/scripts/scan-engine-integration.mjs` | Disposable Redis + compiled-worker harness | ✓ VERIFIED | Contains `dist/worker.js`; success + 4 faults + terminal-guard (verified-by-executor) |
| `apps/api/scripts/scan-engine-feasibility.mjs` | Machine-readable feasibility probe | ✓ VERIFIED | Emits `feasible=true|false`; fail-closed on probe error |
| `.github/workflows/scan-engine.yml` | Node 22 build + conditional Docker gate | ✓ VERIFIED | `scan-engine-contract` (always) + `scan-engine-integration` (gated on `feasible=='true'`); Node 22 asserted |
| `.github/CI-CONTRACT.md` | Branch-protection status contract | ✓ VERIFIED | Contains `scan-engine-contract`; documents the non-dynamic requiredness policy + probe-error fail-closed table |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `scan.service.ts` | `scan.repository.port.ts` | injected `SCAN_REPOSITORY` token | ✓ WIRED | `repository.create` / `repository.get` used |
| `scan.service.ts` | BullMQ queue | typed `queue.add(SCAN_JOB_NAME,{scanId,repoUrl})` | ✓ WIRED | injected via `SCAN_QUEUE` symbol bridged with `useExisting getQueueToken` |
| `scan.repository.ts` | Redis | `watch`/`multi`/`exec` guarded mutation | ✓ WIRED | Optimistic-lock retry loop, terminal guard, TTL refresh |
| `scan-engine.ts` | `scan.repository.port.ts` | `markScanning`/`appendVulnerability`/`markFinished`/`markFailed` | ✓ WIRED | Legitimately in `scan-engine.ts` (sanctioned worker-split); all four called |
| `scan-engine.ts` | `report-parser.ts` | `for await` over `parser.parse(reportPath)` | ✓ WIRED | Async-iteration consumption, one append per yield |
| `worker.ts` | `scan-worker.ts` | context-resolved WorkerHost before `SCAN_WORKER_READY` | ✓ WIRED | `app.get(ScanWorker)` precedes marker; proven by process contract |
| `trivy-runner.adapter.ts` | host report path | `--output` + Docker `/out` mount | ✓ WIRED | exact reportPath preserved through stat + `onReportReady` |
| `scan-engine.yml` | `scan-engine-integration.mjs` | Node 22 build then `test:scan-engine:integration` | ✓ WIRED | job step invokes the named script |

### Behavioral Spot-Checks (run by verifier)

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Typecheck | `npm run typecheck --workspace apps/api` | clean | ✓ PASS |
| Jest unit suite | `npm run test --workspace apps/api` | 59 passed / 3 skipped (Redis integration self-skip) | ✓ PASS |
| Lint | `npm run lint --workspace apps/api` | clean | ✓ PASS |
| Build | `npm run build --workspace apps/api` | `dist/worker.js` + `dist/engine/scan-worker.js` emitted | ✓ PASS |
| Static process/command-safety contract | `npm run test:scan-engine:contract` | 10/10 | ✓ PASS |
| Compiled worker boot contract | `node scripts/worker-process-contract.mjs` | 4/4 (real `dist/worker.js` boots, transport-free, fail-closed) | ✓ PASS |
| Docker end-to-end integration | `npm run test:scan-engine:integration` | 6/6 (real Docker Trivy → 2 ordered CRITICALs, all failure paths) | ✓ verified-by-executor (not re-run) |

### Probe Execution

| Probe | Command | Result | Status |
| --- | --- | --- | --- |
| Static contract | `node --import tsx --test scripts/scan-engine-process-contract.test.mjs` | exit 0, 10/10 | PASS |
| Worker boot contract | `node scripts/worker-process-contract.mjs` | exit 0, 4/4 | PASS |
| Docker integration | `node --import tsx --test scripts/scan-engine-integration.mjs` | requires Docker + GHCR — not re-run by verifier | verified-by-executor |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| ENGINE-01 | 03-01/03/04 | BullMQ WorkerHost `concurrency:1`, decoupled from API | ✓ SATISFIED | `scan-worker.ts` `@Processor(concurrency:1)`; separate `worker.ts` context |
| ENGINE-02 | 03-02 | Shallow clone to unique temp via argv (no shell) | ✓ SATISFIED | `repo-cloner.adapter.ts` + `scan-path-allocator.adapter.ts` |
| ENGINE-03 | 03-02 | Trivy JSON to file via `--output`, no stdout buffering | ✓ SATISFIED | `trivy-runner.adapter.ts` local/Docker `--output`; `subprocess-runner` stdout `ignore` |
| ENGINE-04 | 03-02 | Local binary auto-detect + Docker fallback | ✓ SATISFIED | launch-error-only fallback to pinned GHCR image |
| ENGINE-06 | 03-01 | `Queued→Scanning→Finished/Failed` persisted in Redis via `ScanRepository`, independent of BullMQ | ✓ SATISFIED | `scan.repository.ts` guarded transitions |
| ENGINE-07 | 03-02/03 | Clone + report deleted on success AND failure (try/finally, idempotent) | ✓ SATISFIED | `scan-engine.ts` finally + `temp-artifact-cleaner.ts` |
| ARCH-02 | 03-01 | `ScanService` never touches fs/child_process | ✓ SATISFIED | `scan.service.ts`; static contract assertion |
| ARCH-03 | 03-02/03 | Infra behind injectable adapters | ✓ SATISFIED | RepoCloner/TrivyRunner/ReportParser/ScanRepository ports + factory wiring |
| ERR-01 | 03-02/03 | Trivy non-zero: findings=success, genuine failure=Failed w/ reason | ✓ SATISFIED | `--exit-code 0`; `scan-engine.spec.ts` Test 3 |
| ERR-02 | 03-02/03 | Clone failure Failed + cleanup | ✓ SATISFIED | Test 4a |
| ERR-03 | 03-02/03 | ENOSPC Failed + cleanup | ✓ SATISFIED | Test 4b; `classifyScanError` disk-full promotion |
| ERR-04 | 03-02/03 | Mid-stream parse error propagates, Failed, cleanup | ✓ SATISFIED | Test 2b/4c (parser rejection → Failed(parse), no Finished, cleanup once) |

No orphaned requirements: all 12 IDs mapped to this phase in REQUIREMENTS.md appear in at least one plan's `requirements` field and trace to concrete code + tests. (ENGINE-05 is correctly a Phase 2 requirement and is not in scope; the Phase 2 `ReportParser` is reused unchanged.)

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| — | — | No debt markers (TBD/FIXME/XXX), no stubs, no forbidden `fs.readFile`/`JSON.parse` on the report path in engine | ℹ️ Info | None. `JSON.parse` in `scan.repository.ts` operates only on small bounded metadata/vulnerability records read from Redis, not the Trivy report; the report path uses the streaming Phase 2 parser exclusively |

### Notes on Sanctioned Design Decisions (verified, not gaps)

1. **Worker test split.** All lifecycle logic lives in the plain injectable `ScanEngine` (18 unit tests, no `@nestjs/bullmq` in the jest graph) because of a confirmed `@swc/core` + `@nestjs/bullmq` jest panic. The thin `ScanWorker` `@Processor(concurrency:1)` shell is validated via the compiled `worker-process-contract.mjs` under plain node (I ran it: 4/4). The declared `key_links` patterns therefore correctly live in `scan-engine.ts`. Confirmed correct.
2. **Trivy image.** Live code uses `ghcr.io/aquasecurity/trivy:0.69.3` (the corrected GHCR reference). The `contains: "aquasecurity/trivy:0.69.3"` assertion still holds as a substring. Stale bare-Docker-Hub prose in the 03-02 SUMMARY/PLAN is historical text, not live code.
3. **Docker end-to-end.** The `scan-engine-integration.mjs` harness requires Docker + GHCR image pull, which the verifier cannot re-run in-sandbox. It is verified-by-executor (6/6 non-flaky; 2 ordered CRITICALs CVE-2019-10744, CVE-2021-44906; full Queued→Scanning→Finished + all failure paths) and independently confirmed by the orchestrator on merged HEAD. The verifier independently ran every non-Docker layer (unit lifecycle ordering, static contract, compiled-worker boot) — so the state-transition and cleanup invariants have passing behavioral tests at the levels available.

### Human Verification Required

None. Every behavior-dependent truth (state transitions Queued→Scanning→Finished/Failed, ordered appends, cleanup on all paths, findings-as-success) has a passing behavioral test the verifier executed at the unit + compiled-worker layers, and the Docker layer is externally confirmed.

### Gaps Summary

No gaps. All 6 roadmap success criteria and all 12 requirement IDs are satisfied and traceable to concrete code plus passing behavioral tests. Typecheck, lint, build, the jest suite (59/3), the static process contract (10/10), and the compiled-worker boot contract (4/4) were re-run by the verifier and pass; the Docker end-to-end is verified-by-executor. The phase goal — an async clone → Trivy → stream-parse → store pipeline with clean adapters, bounded error handling, and guaranteed cleanup — is achieved.

---

_Verified: 2026-07-10T18:10:00Z_
_Verifier: Claude (gsd-verifier)_
