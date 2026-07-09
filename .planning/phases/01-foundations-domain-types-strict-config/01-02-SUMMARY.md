---
phase: 01-foundations-domain-types-strict-config
plan: 02
subsystem: infra
tags: [nestjs, fastify, typescript, joi, config, domain-types, worker, scan-module]

# Dependency graph
requires:
  - phase: 01-01
    provides: "npm-workspaces monorepo, apps/api NestJS 11 Fastify scaffold, strict tsconfig, pinned deps (typescript@6.0.3)"
provides:
  - "Framework-free domain type layer: Scan/ScanStatus/Vulnerability/TrivyReport/TrivyResult/TrivyVulnerability"
  - "Joi env schema (envValidationSchema) validating NODE_ENV/PORT/REDIS_HOST/REDIS_PORT/SCAN_TMP_DIR/TRIVY_MODE"
  - "Shared ScanModule (ScanStore in-memory stub) consumed by both AppModule and WorkerModule"
  - "Two entrypoints: src/index.ts (Fastify HTTP API -> dist/index.js) and src/worker.ts (listener-less application context -> dist/worker.js)"
  - ".env.example with safe local-dev defaults for all six env keys"
affects: [01-03, phase-2-parser, phase-3-worker-queue, phase-4-rest-graphql, phase-5-docker, phase-6-readme]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Domain types in apps/api/src/domain/ are plain TS interfaces/enums with zero @nestjs imports (D-03) — GraphQL @ObjectType() classes in Phase 4 will map onto these, not replace them"
    - "Shared ScanModule as the DI seam: providers/exports ScanStore, imported identically by AppModule (HTTP) and WorkerModule (no HTTP/GraphQL)"
    - "Both entrypoints wrap bootstrap().catch((err) => { console.error(err); process.exit(1); }) for a deterministic non-zero exit on Joi validation failure (Pitfall 5)"
    - "ConfigModule.forRoot({ isGlobal: true, validationSchema }) wired identically in both root modules so both tiers fail-fast on the same schema"

key-files:
  created:
    - "apps/api/src/domain/scan.types.ts"
    - "apps/api/src/domain/vulnerability.types.ts"
    - "apps/api/src/domain/trivy-report.types.ts"
    - "apps/api/src/config/env.validation.ts"
    - "apps/api/src/scan/scan.store.ts"
    - "apps/api/src/scan/scan.module.ts"
    - "apps/api/src/worker.module.ts"
    - "apps/api/src/index.ts"
    - "apps/api/src/worker.ts"
    - "apps/api/.env.example"
  modified:
    - "apps/api/src/app.module.ts (overwritten: ConfigModule.forRoot + ScanModule, controllers/AppService dropped)"
  deleted:
    - "apps/api/src/main.ts (superseded by src/index.ts)"
    - "apps/api/src/app.controller.ts"
    - "apps/api/src/app.service.ts"
    - "apps/api/src/app.controller.spec.ts"

key-decisions:
  - "Env schema keys: NODE_ENV/PORT/TRIVY_MODE have safe defaults; REDIS_HOST/REDIS_PORT/SCAN_TMP_DIR are .required() with no default (ASVS V14.1 fail-closed, threat T-01-02)"
  - "Reworded a code comment in worker.ts that originally contained the literal substring '.listen()' — it false-triggered this plan's own verify grep (`! grep -q '\\.listen('`) despite the file having no actual .listen() call"

patterns-established:
  - "Two-entrypoint topology: src/index.ts / src/worker.ts, both importing the shared ScanModule via their own root module"
  - "Domain types layer as the single source of truth Phases 2-4 build on (parser output, repository records, GraphQL object types)"

requirements-completed: [TYPE-02, ARCH-04, OPS-03]

coverage:
  - id: D1
    description: "Domain types (Scan, Vulnerability, ScanStatus, Trivy report shape) exist as explicit framework-free TS interfaces/enums with zero @nestjs/GraphQL imports"
    requirement: "TYPE-02"
    verification:
      - kind: automated
        ref: "grep 'enum ScanStatus' + interface greps across domain/*.ts; ! grep -rn '@nestjs' apps/api/src/domain; npm run typecheck --workspace apps/api (Task 1 verify => PASS)"
        status: pass
    human_judgment: false
  - id: D2
    description: "ScanModule provides+exports ScanStore (typed over Map<string, Scan>); AppModule and WorkerModule both import ConfigModule.forRoot({validationSchema}) + ScanModule; WorkerModule carries no HTTP/GraphQL import"
    requirement: "ARCH-04"
    verification:
      - kind: automated
        ref: "grep checks across app.module.ts/worker.module.ts/scan.module.ts/scan.store.ts + cross-layer domain-import grep (path-prefix filtered); npm run typecheck --workspace apps/api (Task 2 verify => PASS)"
        status: pass
    human_judgment: false
  - id: D3
    description: "dist/index.js boots a Fastify HTTP listener (answers HTTP 404 on /); dist/worker.js boots a listener-less application context (no bound socket on the worker's own PID); both entrypoints exit non-zero with a Joi message naming REDIS_HOST when required env is missing"
    requirement: "OPS-03"
    verification:
      - kind: integration
        ref: "manual boot verification: env -u REDIS_HOST -u REDIS_PORT -u SCAN_TMP_DIR node dist/worker.js -> exit 1, stderr contains 'REDIS_HOST' (FAILFAST_OK); valid-env node dist/worker.js -> 'Worker application context started', ss -ltnp shows no LISTEN socket for that PID (WORKER_BOOT_OK); valid-env node dist/index.js -> curl http://localhost:PORT/ returns HTTP 404 (API_BOOT_OK)"
        status: pass
    human_judgment: false

# Metrics
duration: ~13min
completed: 2026-07-09
status: complete
---

# Phase 1 Plan 02: Domain Types, Env Validation & Two-Entrypoint Topology Summary

**Framework-free Scan/Vulnerability/ScanStatus/Trivy domain types wired into a shared ScanModule consumed by both a Fastify-HTTP `dist/index.js` entrypoint and a listener-less `dist/worker.js` application-context entrypoint, both fail-fast on a single Joi env schema.**

## Performance

- **Duration:** ~13 min
- **Started:** 2026-07-09T17:28:04Z
- **Completed:** 2026-07-09T17:41:16Z
- **Tasks:** 3/3 (all autonomous, no checkpoints)
- **Files modified:** 14 (10 created, 1 overwritten, 4 deleted)

## Accomplishments
- Framework-free domain type layer under `apps/api/src/domain/`: `ScanStatus` enum (Queued/Scanning/Finished/Failed), `Scan` interface, `Vulnerability` interface (severity narrowed to the literal `'CRITICAL'` per D-04), and the minimal Trivy report shape (`TrivyReport`/`TrivyResult`/`TrivyVulnerability`) — zero `@nestjs`/GraphQL imports anywhere in `domain/` (D-03 purity), confirmed by grep.
- `envValidationSchema` (Joi) validates the full downstream env surface now: `NODE_ENV`/`PORT`/`TRIVY_MODE` have safe defaults, `REDIS_HOST`/`REDIS_PORT`/`SCAN_TMP_DIR` are `.required()` with **no** default (fail-closed, ASVS V14.1, threat T-01-02).
- `ScanModule` provides+exports `ScanStore` — an `@Injectable()` in-memory stub (`Map<string, Scan>`) with typed `get`/`list`/`listByStatus` methods referencing `Scan`/`ScanStatus` from `../domain/scan.types`. This is the concrete cross-layer usage point: `ScanModule` is imported by BOTH `AppModule` and `WorkerModule`, so the domain types are consumed outside `domain/` in both the API and worker tiers (Success Criterion #4).
- `AppModule` and `WorkerModule` both wire `ConfigModule.forRoot({ isGlobal: true, validationSchema: envValidationSchema })` + `ScanModule`. `WorkerModule` imports nothing HTTP/GraphQL-related (D-06 dead-heap/dead-attack-surface guard) — verified via grep for `@nestjs/(platform-fastify|graphql|mercurius|apollo)`.
- Two entrypoints: `src/index.ts` (`NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())` + `app.listen(PORT, '0.0.0.0')`) and `src/worker.ts` (`NestFactory.createApplicationContext(WorkerModule)`, no `.listen()`). Both wrap `bootstrap().catch((err) => { console.error(err); process.exit(1); })` (Pitfall 5) for a deterministic non-zero exit + printed Joi message.
- `apps/api/.env.example` committed with safe local-dev defaults for all six keys (no real `.env` committed).
- Deleted the `nest new` scaffold leftovers superseded by the two-entrypoint layout: `main.ts`, `app.controller.ts`, `app.service.ts`, `app.controller.spec.ts`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Framework-free domain type layer (TYPE-02)** - `018c970` (feat)
2. **Task 2: Joi env schema + shared ScanModule + AppModule/WorkerModule topology (OPS-03, ARCH-04)** - `f3f81b1` (feat)
3. **Task 3: Two entrypoints (index.ts API + worker.ts) with fail-fast boot (ARCH-04, OPS-03)** - `067e09a` (feat)

**Plan metadata:** committed as part of this SUMMARY (see final commit below).

## Files Created/Modified
- `apps/api/src/domain/scan.types.ts` - `ScanStatus` enum + `Scan` interface
- `apps/api/src/domain/vulnerability.types.ts` - `Vulnerability` interface (severity narrowed to `'CRITICAL'`)
- `apps/api/src/domain/trivy-report.types.ts` - minimal Trivy report shape (`Results[].Vulnerabilities[]` path only)
- `apps/api/src/config/env.validation.ts` - `envValidationSchema` (Joi.object)
- `apps/api/src/scan/scan.store.ts` - `ScanStore` in-memory stub (`get`/`list`/`listByStatus`)
- `apps/api/src/scan/scan.module.ts` - `ScanModule` (provides+exports `ScanStore`)
- `apps/api/src/app.module.ts` - overwritten: `ConfigModule.forRoot` + `ScanModule` (controllers/AppService dropped)
- `apps/api/src/worker.module.ts` - `WorkerModule` (identical Config wiring, no HTTP/GraphQL)
- `apps/api/src/index.ts` - API entrypoint (Fastify adapter, `.listen()`)
- `apps/api/src/worker.ts` - worker entrypoint (`createApplicationContext`, no listener)
- `apps/api/.env.example` - safe local-dev defaults for all six env keys
- Deleted: `apps/api/src/main.ts`, `apps/api/src/app.controller.ts`, `apps/api/src/app.service.ts`, `apps/api/src/app.controller.spec.ts`

## Decisions Made
- Full env schema defined now (not deferred to Phase 3/4) per RESEARCH.md Open Question 2 — proves the fail-fast mechanism against the real eventual env surface and avoids a later schema-migration task.
- `.env.example` ships with safe local defaults so docker-compose/local dev isn't blocked before Phase 3's Redis/BullMQ wiring exists.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Reworded a `worker.ts` comment that self-triggered the plan's own verify grep**
- **Found during:** Task 3 (running `! grep -q '\.listen(' apps/api/src/worker.ts`)
- **Issue:** The explanatory comment in `worker.ts` read `// No app.listen(), no app.close() — ...`, which contains the literal substring `.listen(`. The plan's negative-assertion verify (`! grep -q '\.listen('`) matched this comment text and failed even though the file has no actual `.listen()` call.
- **Fix:** Reworded the comment to "Deliberately no HTTP listener and no explicit close call here" — same meaning, no longer contains the `.listen(` substring.
- **Files modified:** apps/api/src/worker.ts
- **Verification:** Rebuilt; `! grep -q '\.listen(' apps/api/src/worker.ts` now passes; `grep -q 'createApplicationContext'` still passes; full Task 3 verify chain PASS.
- **Committed in:** 067e09a (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug in a comment string, not runtime behavior).
**Impact on plan:** Cosmetic-only; no behavior change. No scope creep.

## Issues Encountered

**Port-3000 false positive during worker boot check (environmental, not a bug):** The plan's suggested worker-boot verify script checks `nc -z localhost 3000` to confirm no port is bound. In this dev environment, port 3000 was already occupied by an unrelated pre-existing process (`nuxt dev` from a different project, PID unrelated to this repo). This made the generic "is *any* process listening on 3000" check a false positive. Resolved by checking the worker's own PID specifically (`ss -ltnp | grep "pid=$WPID"`), which confirmed zero listening sockets owned by the worker process itself. `dist/worker.js` genuinely binds no port; the interference was pre-existing and unrelated to this plan's code.

**Known, deferred (carried from 01-01, unaffected by this plan):** `npm test` (jest) still aborts with the `@swc/core`+`miette` native panic under Node 24 — documented in `01-01-SUMMARY.md`. No real tests were added this plan; `tsc --noEmit` and the boot-verification checks (per this plan's own acceptance criteria) were the authoritative gates. Not fixed here per the phase notes — still deferred to before real tests land.

## User Setup Required

None - no external service configuration required this phase. `.env.example` documents the six env keys for local `.env` creation; no committed secrets.

## Next Phase Readiness

- `ScanModule`/`ScanStore` is the shared DI seam Phase 3 (Redis persistence, BullMQ queue/worker processor) plugs directly into — `ScanStore`'s in-memory stub is replaced by a real `ScanRepository`, not re-architected.
- Domain types (`Scan`, `Vulnerability`, `ScanStatus`, `TrivyReport`/`TrivyResult`/`TrivyVulnerability`) are the source of truth Phase 2 (stream parser output), Phase 3 (repository records), and Phase 4 (GraphQL `@ObjectType()` mappings) all consume without modification.
- Both `dist/index.js` and `dist/worker.js` boot cleanly under valid env and fail closed under invalid/missing env — the self-test path for the assignment's grading harness is confirmed as `node --max-old-space-size=150 apps/api/dist/index.js` (D-02); **this exact path must be documented prominently in README in Phase 6 (DOC-01)** since it differs from the assignment's literal `node --max-old-space-size=150 dist/index.js` by the `apps/api/` workspace prefix.
- **Carry-forward blocker (unchanged from 01-01):** resolve the `@swc/core` miette panic (npm `overrides`) before writing real Jest tests in Phase 2+.

## Self-Check: PASSED
- Files verified on disk: apps/api/src/domain/scan.types.ts, apps/api/src/domain/vulnerability.types.ts, apps/api/src/domain/trivy-report.types.ts, apps/api/src/config/env.validation.ts, apps/api/src/scan/scan.store.ts, apps/api/src/scan/scan.module.ts, apps/api/src/worker.module.ts, apps/api/src/index.ts, apps/api/src/worker.ts, apps/api/.env.example
- Commits verified in git log: 018c970 (Task 1), f3f81b1 (Task 2), 067e09a (Task 3)

---
*Phase: 01-foundations-domain-types-strict-config*
*Completed: 2026-07-09*
