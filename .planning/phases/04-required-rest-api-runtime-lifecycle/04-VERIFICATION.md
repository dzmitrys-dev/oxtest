---
phase: 04-required-rest-api-runtime-lifecycle
verified: 2026-07-10T18:39:12Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 4: Required REST API & Runtime Lifecycle Verification Report

**Phase Goal:** Clients can submit and poll scans over the required REST API through one shared `ScanService`, with a health check and graceful shutdown. GraphQL is explicitly deferred to the optional bonus phase.
**Verified:** 2026-07-10T18:39:12Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | POST /api/scan with valid GitHub URL returns `{scanId, status:"Queued"}` immediately (no scan wait); rejects missing/malformed/non-GitHub URLs with 400 before enqueue | ✓ VERIFIED | `scan.controller.ts:34-41` awaits only `enqueue`, `@HttpCode(202)`; `GithubUrlPipe` bound on `@Body` runs before handler. Integration: "POST valid → 202 {scanId,Queued} + real Queued hash" and "malformed URLs → 400 BEFORE enqueue (zero scan:* keys, empty queue)" both PASS |
| 2 | GET /api/scan/:scanId returns current status; Finished→CRITICAL vulns, Failed→error reason, unknown id→404 | ✓ VERIFIED | `scan-response.ts` state-shaped discriminated union (`criticalVulnerabilities` / `error{category,detail}`); `scan.controller.ts:47-54` maps null→404. Integration: offline Failed(clone) path returns `error{category:'clone'}`, Docker Finished path returns the two pinned CVEs, and unknown-uuid→404 all PASS |
| 3 | GET /health reports service status and Redis connectivity | ✓ VERIFIED | `health.service.ts` bounded active PING over injected `REDIS_CLIENT`; `health.controller.ts` 200/503 with `{status,redis,uptime}`. Integration: health 200 live then 503 after Redis killed both PASS |
| 4 | On SIGTERM/SIGINT the API and worker shut down gracefully, draining the worker and closing Redis | ✓ VERIFIED | `worker-shutdown.provider.ts` (OnModuleDestroy → `raceDrain` bounded by SHUTDOWN_GRACE_MS → `redis.quit`); `scan.repository.ts:71-80` onModuleDestroy→quit on both processes. Integration: worker SIGTERM clean exit within grace (validates A1/A2) and API SIGTERM clean exit both PASS |
| 5 | An integration test proves POST → Queued → poll → Finished/Failed against the worker/service boundary without GraphQL | ✓ VERIFIED | `scripts/api-integration.mjs` runs under node:test against compiled dist/ over disposable Redis; criterion #5 offline (`['Queued','Scanning','Failed']`) and Docker Finished both PASS. No GraphQL wiring or deps present |

**Score:** 5/5 truths verified (0 present, behavior-unverified)

All behavior-dependent truths (state transitions #1/#2/#5, SIGTERM cancellation/cleanup #4) are backed by passing behavioral tests in the compiled-process integration harness — not presence checks alone.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `src/http/validation/github-url.ts` | parse-then-allowlist validator | ✓ VERIFIED | Fail-closed `parseGithubUrl` with ordered gate chain; wired into pipe |
| `src/http/validation/github-url.pipe.ts` | 400-before-enqueue guard | ✓ VERIFIED | Throws BadRequestException on null; bound on `@Body(GithubUrlPipe)` |
| `src/http/dto/scan-response.ts` | state-shaped mapper | ✓ VERIFIED | Discriminated union, explicit field mapping, no raw-domain leak |
| `src/http/scan.controller.ts` | thin import-guarded controller | ✓ VERIFIED | Imports only `@nestjs/common`+ScanService+DTOs; import-guard spec green |
| `src/http/health.service.ts` + `health.controller.ts` | active PING probe + 200/503 | ✓ VERIFIED | Injects existing REDIS_CLIENT (no new conn); bounded race |
| `src/app.module.ts` | registers controllers + HealthService | ✓ VERIFIED | Compiled dist/app.module.js registers ScanController, HealthController, HealthService |
| `src/lifecycle/drain.ts` | pure bounded raceDrain | ✓ VERIFIED | 'drained'/'forced', no bullmq import; unit-tested |
| `src/lifecycle/worker-shutdown.provider.ts` | OnModuleDestroy drain+quit | ✓ VERIFIED | Wired in WorkerModule providers; runtime-proven by harness |
| `src/config/env.validation.ts` | SHUTDOWN_GRACE_MS Joi key | ✓ VERIFIED | integer min 0 max 60000 default 8000 |
| `scripts/api-integration.mjs` | compiled-process harness | ✓ VERIFIED | 9/9 node:test cases pass over disposable Redis |

### Key Link Verification

| From | To | Status | Details |
| ---- | -- | ------ | ------- |
| ScanController → ScanService.enqueue/get | (only collaborator) | ✓ WIRED | Sole injected dependency; import-guard enforces ARCH-01 |
| GithubUrlPipe → parseGithubUrl → 400 before handler | | ✓ WIRED | Pipe on `@Body` runs pre-handler; integration proves zero enqueue on reject matrix |
| HealthService → @Inject(REDIS_CLIENT) | existing ioredis client | ✓ WIRED | No third connection; reuses ScanModule export |
| WorkerShutdown → ScanWorker.worker + ConfigService + REDIS_CLIENT | | ✓ WIRED | Registered in WorkerModule; SIGTERM harness confirms drain+quit at runtime |
| ScanRepositoryAdapter.onModuleDestroy → redis.quit (both processes) | | ✓ WIRED | Confirmed in compiled dist; API + worker SIGTERM exit cleanly |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Typecheck (strict, no any) | `npm run typecheck` | clean | ✓ PASS |
| Build → dist/index.js + dist/worker.js | `npm run build` | exit 0, both artifacts present | ✓ PASS |
| Unit suite, no @swc/core miette panic | `npx jest` | 131 passed, 3 skipped, no panic | ✓ PASS |
| Full compiled-process integration (criteria #1–#5) | `npm run test:api:integration` | 9/9 pass (30s incl. real Docker Trivy) | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| SCAN-01 | 04-01, 04-03 | POST returns Queued non-blocking | ✓ SATISFIED | 202 test + unit enqueue-once |
| SCAN-02 | 04-01, 04-03 | 400 before enqueue for invalid URLs | ✓ SATISFIED | reject matrix + zero scan:* keys |
| SCAN-03 | 04-01, 04-03 | GET current status | ✓ SATISFIED | offline + Docker poll paths |
| SCAN-04 | 04-01, 04-03 | Finished→vulns, Failed→error | ✓ SATISFIED | 2 CVEs (Finished); error{clone} (Failed) |
| SCAN-05 | 04-01, 04-03 | Unknown id → 404 | ✓ SATISFIED | 404 integration + unit |
| API-03 | 04-01, 04-03 | /health + Redis connectivity | ✓ SATISFIED | 200/503 integration |
| ARCH-01 | 04-01 | Thin controllers, one shared service | ✓ SATISFIED | import-guard spec green; single collaborator |
| ERR-05 | 04-02, 04-03 | Graceful SIGTERM/SIGINT shutdown | ✓ SATISFIED | both processes clean SIGTERM within grace |

All 8 requirement IDs from PLAN frontmatter are mapped to Phase 4 in REQUIREMENTS.md and all are marked Complete there. No orphaned requirements.

### Anti-Patterns Found

None blocking. No unreferenced TBD/FIXME/XXX debt markers in phase files. No stubs — all data paths flow through real dependencies (integration harness runs against real compiled processes, real Redis, real BullMQ, and real Trivy). Advisory code-review warnings (WR-01 parser-differential on raw string forwarding, WR-02 SHUTDOWN_GRACE_MS max exceeds Docker window, WR-03 no error listener on production REDIS_CLIENT) are non-blocking robustness improvements; the default configuration honors every phase contract and the /health 503 path was empirically proven not to crash the process.

### Gaps Summary

No gaps. All five ROADMAP success criteria are verified with behavioral evidence from the compiled-process integration harness (9/9 green, including the real-Docker Trivy Finished path and both SIGTERM shutdown proofs). GraphQL is correctly deferred — no wiring or dependencies present. The unit suite (131 passing) runs without the @swc/core miette panic, honoring the STATE.md landmine.

Note (informational, not a gap): the three advisory code-review WARNINGs are candidates for a follow-up hardening pass but do not affect Phase 4 goal achievement.

---

_Verified: 2026-07-10T18:39:12Z_
_Verifier: Claude (gsd-verifier)_
