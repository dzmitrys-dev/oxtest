---
phase: 04-required-rest-api-runtime-lifecycle
plan: 01
subsystem: api
tags: [nestjs, fastify, rest, http, redis, ioredis, validation, ssrf, health-check]

# Dependency graph
requires:
  - phase: 03-scan-engine-adapters-queue-worker-service
    provides: ScanService (enqueue/get), ScanModule exporting ScanService + REDIS_CLIENT, Scan/ScanStatus/ScanFailureReason domain types, Vulnerability type
provides:
  - parseGithubUrl() parse-then-allowlist validator (SSRF/command-injection defense-in-depth)
  - GithubUrlPipe (400-before-enqueue transport guard)
  - CreateScanDto request contract
  - toScanResponse() state-shaped domain→wire mapper + ScanResponse union
  - ScanController (POST /api/scan 202, GET /api/scan/:scanId 200/404) — thin, import-guarded
  - HealthService.redisUp() bounded active-PING probe
  - HealthController (GET /health 200/503)
  - AppModule wired with both controllers + HealthService
affects: [04-02, 04-03, phase-05-docker-compose, phase-06-graphql]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Parse-then-allowlist URL validation as a pure fail-closed function + NestJS PipeTransform"
    - "State-shaped discriminated-union response DTO with explicit field-by-field mapper (no raw-domain spread)"
    - "Thin controller enforced by a source-reading import-guard Jest spec (ARCH-01)"
    - "Bounded Promise.race active health PING over an injected existing ioredis connection"
    - "Jest-safe unit specs that never import the @nestjs/bullmq module graph (avoids @swc/core miette panic)"

key-files:
  created:
    - apps/api/src/http/validation/github-url.ts
    - apps/api/src/http/validation/github-url.pipe.ts
    - apps/api/src/http/validation/github-url.spec.ts
    - apps/api/src/http/dto/create-scan.dto.ts
    - apps/api/src/http/dto/scan-response.ts
    - apps/api/src/http/scan.controller.ts
    - apps/api/src/http/scan.controller.spec.ts
    - apps/api/src/http/health.service.ts
    - apps/api/src/http/health.service.spec.ts
    - apps/api/src/http/health.controller.ts
  modified:
    - apps/api/src/app.module.ts

key-decisions:
  - "Zero-dependency pure-validator path (RESEARCH A4): class-validator/class-transformer NOT installed"
  - "Per-controller @Body(GithubUrlPipe) binding (no global pipe, no index.ts change) per D-03 discretion"
  - "toScanResponse fills Failed error defaults ({category:'unknown', detail:''}) to keep the mapper total without an `any` cast"

patterns-established:
  - "Pattern: pure fail-closed validator (null sentinel) + thin PipeTransform wrapper mirroring env.validation.ts"
  - "Pattern: discriminated-union ScanResponse mapper mirroring scan.repository.ts serialize/deserialize"
  - "Pattern: import-guard spec reusing importSpecifiers() to mechanically enforce thin controllers"

requirements-completed: [SCAN-01, SCAN-02, SCAN-03, SCAN-04, SCAN-05, API-03, ARCH-01]

coverage:
  - id: D1
    description: "POST /api/scan returns 202 {scanId,status:'Queued'} and awaits only ScanService.enqueue (SCAN-01, D-04)"
    requirement: SCAN-01
    verification:
      - kind: unit
        ref: "apps/api/src/http/scan.controller.spec.ts#POST create → returns {scanId, status:Queued} and calls enqueue once"
        status: pass
      - kind: unit
        ref: "apps/api/src/http/scan.controller.spec.ts#POST create handler is decorated with HTTP 202"
        status: pass
    human_judgment: false
  - id: D2
    description: "Malformed/SSH/git:/file:/http:/non-github/look-alike/userinfo/port/single-segment URLs are rejected 400 before enqueue (SCAN-02, D-01/02/03)"
    requirement: SCAN-02
    verification:
      - kind: unit
        ref: "apps/api/src/http/validation/github-url.spec.ts#rejects invalid input (→ null, never throws)"
        status: pass
      - kind: unit
        ref: "apps/api/src/http/scan.controller.spec.ts#invalid URL is rejected by the pipe BEFORE enqueue runs"
        status: pass
    human_judgment: false
  - id: D3
    description: "GET /api/scan/:scanId returns the state-shaped DTO (Finished→criticalVulnerabilities, Failed→error{category,detail}) (SCAN-03/04, D-05/06/07)"
    requirement: SCAN-03
    verification:
      - kind: unit
        ref: "apps/api/src/http/scan.controller.spec.ts#toScanResponse (state-shaped mapper, D-05/06/07)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Unknown scanId yields 404 (SCAN-05, D-05)"
    requirement: SCAN-05
    verification:
      - kind: unit
        ref: "apps/api/src/http/scan.controller.spec.ts#GET → throws NotFoundException (404) when the service returns null"
        status: pass
    human_judgment: false
  - id: D5
    description: "GET /health returns 200 {status:ok,redis:up,uptime} on PONG and 503 {status:error,redis:down,uptime} on failure/timeout (API-03, D-08/09/10)"
    requirement: API-03
    verification:
      - kind: unit
        ref: "apps/api/src/http/health.service.spec.ts#HealthService.redisUp (API-03, D-08)"
        status: pass
    human_judgment: false
  - id: D6
    description: "ScanController is a thin, import-guarded transport adapter (ARCH-01)"
    requirement: ARCH-01
    verification:
      - kind: unit
        ref: "apps/api/src/http/scan.controller.spec.ts#ScanController import-guard (ARCH-01)"
        status: pass
    human_judgment: false
  - id: D7
    description: "Wired AppModule compiles to dist/index.js with both controllers + HealthService registered and DI resolving"
    requirement: API-03
    verification:
      - kind: integration
        ref: "cd apps/api && npm run build (produces dist/index.js)"
        status: pass
    human_judgment: false

# Metrics
duration: 9min
completed: 2026-07-10
status: complete
---

# Phase 4 Plan 01: Required REST Surface (scan submit/poll + health) Summary

**Thin NestJS/Fastify REST layer over the shared ScanService — POST /api/scan (202), GET /api/scan/:scanId (state-shaped 200/404), and GET /health (active Redis PING 200/503) — with a parse-then-allowlist GitHub-URL guard and an import-guard enforcing controller thinness.**

## Performance

- **Duration:** ~9 min
- **Started:** 2026-07-10T17:40:17Z
- **Completed:** 2026-07-10T17:49:00Z
- **Tasks:** 3
- **Files modified:** 11 (10 created, 1 modified)

## Accomplishments
- `parseGithubUrl()` parse-then-allowlist validator + `GithubUrlPipe` guaranteeing HTTP 400 before `ScanService.enqueue` for the full D-02 reject matrix (SSRF / command-injection defense-in-depth; SCAN-02).
- Thin, import-guarded `ScanController`: `POST /api/scan` → 202 `{scanId,status:'Queued'}` (awaits only `enqueue`); `GET /api/scan/:scanId` → state-shaped DTO or 404 (SCAN-01/03/04/05, ARCH-01).
- `toScanResponse()` discriminated-union mapper: Finished→`criticalVulnerabilities`, Failed→`error{category,detail}`; never leaks `repoUrl`/timestamps (D-05/06/07, T-04-03).
- `HealthService.redisUp()` bounded active-PING race over the existing `REDIS_CLIENT` (no new connection) + `HealthController` 200/503 with a 3-key body (API-03, D-08/09/10).
- `AppModule` wired; `npm run build` compiles the full graph to `dist/index.js`.

## Task Commits

Each task committed atomically (TDD: test → feat):

1. **Task 1: parseGithubUrl + GithubUrlPipe + CreateScanDto** - `8db8e82` (test), `4134227` (feat)
2. **Task 2: ScanResponse mapper + thin ScanController + import-guard** - `d125a97` (feat, test+impl)
3. **Task 3: HealthService/HealthController + AppModule wiring** - `7b8d669` (feat, test+impl)

_Note: Task 1 followed a discrete RED (`8db8e82`) → GREEN (`4134227`) cycle; Tasks 2–3 committed the spec and implementation together within a single green commit each._

## Files Created/Modified
- `apps/api/src/http/validation/github-url.ts` - Pure fail-closed `parseGithubUrl(input): {owner,repo}|null`
- `apps/api/src/http/validation/github-url.pipe.ts` - `GithubUrlPipe` throwing `BadRequestException` (400) on null
- `apps/api/src/http/validation/github-url.spec.ts` - Accept/reject matrix + pipe tests
- `apps/api/src/http/dto/create-scan.dto.ts` - `CreateScanDto {repoUrl}` (zero-dep contract)
- `apps/api/src/http/dto/scan-response.ts` - `ScanResponse` union + `toScanResponse()` mapper
- `apps/api/src/http/scan.controller.ts` - Thin `ScanController` (POST 202 / GET 200|404)
- `apps/api/src/http/scan.controller.spec.ts` - Mapper + controller + import-guard specs
- `apps/api/src/http/health.service.ts` - `HealthService.redisUp()` bounded active PING
- `apps/api/src/http/health.service.spec.ts` - PONG/reject/timeout coverage
- `apps/api/src/http/health.controller.ts` - `HealthController` GET /health 200/503
- `apps/api/src/app.module.ts` - Registered ScanController + HealthController + HealthService

## Decisions Made
- Chose the zero-dependency pure-validator path (RESEARCH A4) — `class-validator`/`class-transformer` NOT installed; no new supply-chain surface (T-04-SC).
- Bound validation at the param level via `@Body(GithubUrlPipe)` rather than a global pipe, so `index.ts` needed no change (D-03 discretion).
- `GithubUrlPipe.transform` declared with a single `value` parameter (the metadata arg is unused); NestJS passes extra args harmlessly at runtime. This avoids an unused-parameter lint error while still satisfying `PipeTransform`.
- `toScanResponse` fills Failed-state defaults (`category:'unknown'`, `detail:''`) so the mapper is total under `noUncheckedIndexedAccess`/strict without any `any` cast (a persisted Failed scan always carries `error`, so defaults are unreachable in practice).

## Deviations from Plan

None - plan executed exactly as written. (One in-spec adjustment during Task 1: the pipe's `transform` was implemented with a single parameter and the spec updated to match, to satisfy the strict `@typescript-eslint` no-unused-vars rule — behavior identical.)

## Issues Encountered
- Initial `GithubUrlPipe.transform(value, metadata)` two-arg signature tripped `@typescript-eslint/no-unused-vars` (no `argsIgnorePattern` configured) and, transitively, a typecheck arity mismatch. Resolved by dropping the unused `metadata` parameter (single-arg `transform`) and calling `pipe.transform(value)` in the spec — verified green across jest/typecheck/lint.

## User Setup Required

None - no external service configuration required. `/health` and the scan endpoints reuse the Redis connection already configured by `ScanModule` (REDIS_HOST/REDIS_PORT).

## Next Phase Readiness
- REST contracts proven at the unit boundary (126 tests pass, no `@nestjs/bullmq` in any Jest graph, no miette panic).
- End-to-end 202/400/404/health proofs against the compiled `dist/index.js` process are owned by Plan 04-03 (integration harness).
- Graceful-shutdown lifecycle (D-11..D-14) is Plan 04-02's scope; this plan did not touch worker/lifecycle files.
- GraphQL (Phase 6) can reuse `toScanResponse`'s `criticalVulnerabilities` field naming (D-06) for REST/GraphQL consistency.

## Self-Check: PASSED

All 12 created/modified files exist on disk; all 4 task commits (`8db8e82`, `4134227`, `d125a97`, `7b8d669`) are present in git history. Full suite: 126 tests pass (3 skipped), typecheck clean, lint clean, `npm run build` produces `dist/index.js`.

---
*Phase: 04-required-rest-api-runtime-lifecycle*
*Completed: 2026-07-10*
