---
phase: 06-optional-bonuses-documentation
plan: 01
subsystem: api
tags: [graphql, mercurius, nestjs, resolver, ssrf, code-first, bonus-b, jest]

# Dependency graph
requires:
  - phase: 04-rest-transport
    provides: ScanService (enqueue/get), parseGithubUrl allowlist, toScanResponse status-switched mapper, thin-controller import-guard pattern
  - phase: 03-queue-worker
    provides: domain Scan/Vulnerability/ScanStatus types, ScanModule shared DI seam
provides:
  - Code-first GraphQL surface (MercuriusDriver) on the same Fastify listener as REST
  - GraphQL query scan(id) delegating to ScanService.get (null-parity with REST 404)
  - GraphQL mutation enqueueScan(repoUrl) with REST-identical SSRF allowlist + canonical-URL enqueue
  - GraphiQL at /graphiql in all environments (D-05)
  - Pinned GraphQL quartet (graphql locked to 16.14.2, root override)
  - transformIgnorePatterns hardening so editor instrumentation never breaks @swc/jest
affects: [06-02 frontend apps/web (consumes this GraphQL surface), 06-04 ONBOARDING (GraphiQL trade-off doc)]

# Tech tracking
tech-stack:
  added: ["@nestjs/graphql@13.4.2", "@nestjs/mercurius@13.4.2", "mercurius@16.9.0", "graphql@16.14.2"]
  patterns:
    - "Code-first @ObjectType models as decorated mirrors of framework-free domain types (never decorate domain)"
    - "Thin GraphQL resolver delegating solely to ScanService (ARCH-01), import-guarded"
    - "One fail-closed parseGithubUrl allowlist reused across REST + GraphQL, enqueuing canonical URL only"

key-files:
  created:
    - apps/api/src/graphql/vulnerability.model.ts
    - apps/api/src/graphql/scan.model.ts
    - apps/api/src/graphql/scan-graphql.mapper.ts
    - apps/api/src/graphql/scan.resolver.ts
    - apps/api/src/graphql/scan.resolver.spec.ts
  modified:
    - apps/api/src/app.module.ts
    - apps/api/package.json
    - package.json

key-decisions:
  - "graphql pinned exactly to 16.14.2 (apps/api dep + root overrides) — the NestJS/Mercurius quartet rejects graphql@17 (Pitfall 1)"
  - "GraphQL registered in AppModule ONLY, never WorkerModule — worker heap stays GraphQL-free (two-entrypoint discipline)"
  - "enqueueScan reuses parseGithubUrl and enqueues canonical https://github.com/{owner}/{repo}, rejecting invalid input before ScanService.enqueue (T-06-01 SSRF parity)"
  - "status is String! (not a GraphQL enum) per locked API-01 schema; ScanStatus enum value IS the wire string"
  - "Discovered the STATE '@swc miette panic' true root cause is the Console Ninja Cursor extension buildHook, not @nestjs/bullmq; hardened transformIgnorePatterns to exclude editor instrumentation"

patterns-established:
  - "Decorated GraphQL model + status-switched domain->model mapper (toScanModel), no raw-Scan leak (D-06)"
  - "Mock-only resolver unit spec (never imports ScanModule/@nestjs/bullmq/@nestjs/graphql-heavy module graph under a contaminating editor hook)"

requirements-completed: [API-01, API-02]

coverage:
  - id: D1
    description: "GraphQL scan(id) query delegates to ScanService.get; returns mapped ScanModel when found, null for unknown id (REST 404-parity, D-06)"
    requirement: "API-01"
    verification:
      - kind: unit
        ref: "apps/api/src/graphql/scan.resolver.spec.ts#returns null (not throw) when the service resolves null (D-06)"
        status: pass
      - kind: unit
        ref: "apps/api/src/graphql/scan.resolver.spec.ts#maps a Finished scan through toScanModel incl. criticalVulnerabilities"
        status: pass
    human_judgment: false
  - id: D2
    description: "GraphQL enqueueScan(repoUrl) mutation delegates to ScanService.enqueue with the REST SSRF allowlist, enqueuing only the canonical URL and rejecting invalid input before enqueue"
    requirement: "API-02"
    verification:
      - kind: unit
        ref: "apps/api/src/graphql/scan.resolver.spec.ts#enqueues the CANONICAL url exactly once for a valid github URL (normalizes www. + .git)"
        status: pass
      - kind: unit
        ref: "apps/api/src/graphql/scan.resolver.spec.ts#rejects %s WITHOUT calling enqueue (T-06-01) (7 SSRF-invalid inputs)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Code-first GraphQL schema builds at app bootstrap with MercuriusDriver; node dist/index.js boots to the listener marker with GraphQLModule registered"
    requirement: "API-01"
    verification:
      - kind: integration
        ref: "npm run test:selftest --workspace apps/api (scripts/selftest-index-boot.mjs)"
        status: pass
    human_judgment: false
  - id: D4
    description: "GraphiQL reachable at /graphiql in all environments incl. container (D-05); graphiql:true set on MercuriusDriver config"
    requirement: "API-01"
    verification:
      - kind: manual_procedural
        ref: "Open /graphiql against a running API/container and confirm the interactive playground loads"
        status: unknown
    human_judgment: true
    rationale: "GraphiQL playground reachability in the running container is a visual/interactive check; not covered by the unit/boot gates (server boot proves the schema builds, not that the UI renders)."

# Metrics
duration: 12min
completed: 2026-07-10
status: complete
---

# Phase 6 Plan 01: GraphQL Bonus B (code-first MercuriusDriver) Summary

**Code-first GraphQL surface (NestJS MercuriusDriver) on the same Fastify listener as REST: scan(id) query + enqueueScan mutation, both thin adapters over the shared ScanService, with the REST SSRF allowlist reused to enqueue only canonical URLs.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-07-11T02:04:58+03:00
- **Completed:** 2026-07-11T02:16:25+03:00
- **Tasks:** 3
- **Files modified:** 8 (5 created, 3 modified) + lockfile

## Accomplishments
- GraphQL `scan(id)` query and `enqueueScan(repoUrl)` mutation both delegate to the same `ScanService` as REST (phase criterion #1, API-01/API-02) — no scan logic reimplemented in the resolver.
- SSRF/injection parity closed: `enqueueScan` calls the same `parseGithubUrl` allowlist as REST, rejects every non-github/non-https/ssh/git-scheme/userinfo input before `ScanService.enqueue` runs, and enqueues only the canonical `https://github.com/{owner}/{repo}` URL (T-06-01, asserted by 7 negative + 2 canonicalization test cases).
- GraphQL + GraphiQL mount on the existing Fastify process (`graphiql: true`, `/graphiql` in all envs, D-05); the code-first schema builds at bootstrap — `node dist/index.js` still boots to the listener marker (self-test green).
- GraphQL registered in `AppModule` only; `WorkerModule` untouched — the memory-critical worker heap stays GraphQL-free.
- `graphql` locked to exactly 16.14.2 (apps/api dep + root `overrides`); `npm ls graphql` shows 16.14.2 everywhere, zero 17.x (Pitfall 1).

## Task Commits

Each task was committed atomically:

1. **Task 1: Pin GraphQL quartet + code-first models + mapper** - `51aad67` (feat)
2. **Task 2: Thin ScanResolver with SSRF-parity mutation + AppModule GraphQL registration** - `4370dca` (feat)
3. **Task 3: Jest-landmine-safe resolver unit spec** - `f2d5709` (test)

## Files Created/Modified
- `apps/api/src/graphql/vulnerability.model.ts` (created) - `@ObjectType() VulnerabilityModel`, the 6 stored fields (no fixedVersion, D-08).
- `apps/api/src/graphql/scan.model.ts` (created) - `@ObjectType() ScanModel` (id:ID!, status:String!, criticalVulnerabilities nullable list).
- `apps/api/src/graphql/scan-graphql.mapper.ts` (created) - `toScanModel`, status-switched domain->model mapper; no raw-Scan leak; vulns only when Finished.
- `apps/api/src/graphql/scan.resolver.ts` (created) - `@Resolver ScanResolver`: `@Query scan`, `@Mutation enqueueScan`; sole collaborator ScanService; import-guarded.
- `apps/api/src/graphql/scan.resolver.spec.ts` (created) - mock-only unit spec (12 tests): delegation, canonicalization, SSRF rejection, null-parity, import-guard.
- `apps/api/src/app.module.ts` (modified) - registered `GraphQLModule.forRoot<MercuriusDriverConfig>` (MercuriusDriver, autoSchemaFile, graphiql:true) + `ScanResolver` provider.
- `apps/api/package.json` (modified) - pinned GraphQL quartet; added `transformIgnorePatterns` hardening (see deviation).
- `package.json` (modified) - root `overrides` pinning graphql to 16.14.2.

## Decisions Made
- **Exact version pins (no carets):** the quartet was written verbatim (`13.4.2`/`16.9.0`/`16.14.2`) to match the repo's existing exact-pin convention and satisfy the plan's "pins applied exactly" mandate (T-06-SC); the root override enforces graphql 16.14.2 for all transitive resolvers.
- **`status` as String!, not an enum:** followed locked API-01 schema; the mapper passes the `ScanStatus` enum value straight through (it IS the wire string).
- **null query parity over throwing:** `scan(id)` returns `null` (nullable query) where REST throws `NotFoundException` — the D-06-sanctioned GraphQL equivalent of a 404.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `npm test` aborted with an `@swc/core` miette native panic; true root cause identified and hardened**
- **Found during:** Task 3 (resolver unit spec)
- **Issue:** `npm test` (and even running the resolver spec alone) crashed Jest with `thread panicked ... miette-7.6.0/src/handlers/graphical.rs:1159: Formatting argument out of range` (SIGABRT). STATE attributed this class of panic to `@swc/core` + `@nestjs/bullmq`. Investigation (instrumenting `@swc/core.transformSync` to log the filename it was transforming when it aborted) proved the real trigger: the **Console Ninja Cursor extension** (`~/.cursor/extensions/wallabyjs.console-ninja-*/out/buildHook/index.js`, a 4.3MB instrumentation bundle). When a Nest.js module graph is required (reproduced with `@nestjs/graphql` alone — no bullmq needed), Console Ninja injects its buildHook into the Jest process; because that file lives outside `/node_modules/`, `@swc/jest` tries to transform it and `@swc/core` panics formatting a diagnostic on it. The existing `scan.controller.spec.ts` passes because its lighter graph does not trip Console Ninja's Nest.js injection the same way; transforming the exact spec source standalone with `@swc/core` succeeds, confirming the fault is the out-of-tree editor file, not project code.
- **Fix:** Added `transformIgnorePatterns` to the Jest config: `["/node_modules/", "[/\\\\]\\.(cursor|vscode|vscode-server)[/\\\\]extensions[/\\\\]"]` so `@swc/jest` never transforms editor-extension instrumentation. Editor hooks still load (Console Ninja reports "connected to Nest.js"); they are simply not run through the project's transformer.
- **Files modified:** apps/api/package.json (jest.transformIgnorePatterns)
- **Verification:** `npm test --workspace apps/api` → 15 suites / 159 tests pass, 0 miette panic; resolver spec 12/12. The pattern is editor-general (no per-user path) and has zero effect on project-file transforms.
- **Committed in:** `f2d5709` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking).
**Impact on plan:** The fix was required to satisfy the plan's own acceptance criterion ("`npm test` runs to completion, no Rust/miette panic"). It also corrects the STATE landmine's documented root cause. No scope creep — resolver/model/mapper code matches the plan exactly.

## Issues Encountered
- The Node runtime in this sandbox is v24 while `apps/api` pins `>=22 <23`; `npm install` emitted `EBADENGINE` warnings only (non-blocking, no `engine-strict`). All builds/tests ran clean under v24.

## User Setup Required
None - no external service configuration required. GraphiQL is enabled by default at `/graphiql`.

## Next Phase Readiness
- The GraphQL surface (`/graphql` + `/graphiql`) is live for Plan 06-02's `apps/web` React SPA to consume (same origin, D-04).
- The GraphiQL-in-all-envs introspection trade-off (T-06-02) remains a deliberate, documented choice for Plan 06-04 ONBOARDING to own.
- Static-serving wiring (`ServeStaticModule` for `apps/web/dist`) is intentionally NOT part of this plan — it lands with the frontend plan.

---
*Phase: 06-optional-bonuses-documentation*
*Completed: 2026-07-10*
