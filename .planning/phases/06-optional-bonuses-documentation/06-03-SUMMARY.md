---
phase: 06-optional-bonuses-documentation
plan: 03
subsystem: infra
tags: [serve-static, fastify, nestjs, docker, compose, vite, spa, bonus-a]

# Dependency graph
requires:
  - phase: 06-01
    provides: GraphQLModule (MercuriusDriver) + /graphiql in AppModule on the shared Fastify listener
  - phase: 06-02
    provides: apps/web Vite/React/urql SPA workspace (apps/web/dist build artifact)
  - phase: 05
    provides: multi-stage Dockerfile + three-service docker-compose (redis/api/worker)
provides:
  - ServeStaticModule serving the built React SPA at origin root GET / from apps/api/dist/web (D-04, same origin, no CORS)
  - Route-exclusion of /api/*, /health, /graphql, /graphiql so the SPA catch-all never shadows backend handlers (T-06-03)
  - Boot-safe api build — dist/web/index.html always materialized (real bundle or placeholder) so criterion #5a self-test never regresses (T-06-08)
  - serve-static-routes.smoke.mjs empirical route-exclusion + SPA-served harness (+ test:serve-static)
  - Multi-stage Dockerfile web-build fold-in (docker compose up serves the UI on :3000, D-12) with a lean web-dep-free runtime image
  - Root build:all producing the served-UI bundle for local node dist/index.js
affects: [06-04, documentation, README, ONBOARDING]

# Tech tracking
tech-stack:
  added: ["@nestjs/serve-static@5.0.5 (verbatim pin)"]
  patterns:
    - "ServeStaticModule registered in AppModule ONLY (worker heap stays lean — two-entrypoint discipline)"
    - "postbuild step (ensure-dist-web.mjs) re-materializes dist/web AFTER nest build's deleteOutDir — single mechanism reused by the Dockerfile"
    - "path-to-regexp v8 exclude token /api/{*path} confirmed EMPIRICALLY via a real node dist/index.js boot smoke"
    - "runtime-stage npm ci scoped to --workspace apps/api --include-workspace-root keeps web deps entirely out of the lean image"

key-files:
  created:
    - apps/api/scripts/ensure-dist-web.mjs
    - apps/api/scripts/serve-static-routes.smoke.mjs
  modified:
    - apps/api/src/app.module.ts
    - apps/api/package.json
    - package.json
    - Dockerfile
    - docker-compose.yml

key-decisions:
  - "Reuse the api postbuild (ensure-dist-web.mjs) as the SINGLE copy mechanism for apps/web/dist -> dist/web; the Dockerfile builds apps/web first and lets the api build do the copy (no duplicate Dockerfile cp)."
  - "Scope the runtime-stage npm ci to apps/api so NEITHER web devDeps (vite/tailwind/tsc) NOR web runtime deps (react/urql) enter the runtime image — the SPA ships pre-bundled as static files, so the runtime never needs them."
  - "Keep root `build` api-only (existing CI calls `npm run build --workspace apps/api`); add a separate `build:all` for the local served-UI path."
  - "Exclude token /api/{*path} (path-to-regexp v8) confirmed by the smoke harness against a live boot rather than assumed (RESEARCH Open Question 1)."

patterns-established:
  - "Boot-safe static rootPath: always create the ServeStaticModule rootPath after a deleteOutDir build so the self-test cannot regress."
  - "Empirical route-exclusion smoke: boot the real dist/index.js against a CLOSED Redis port and assert each backend route bypasses the SPA."

requirements-completed: [FE-01, FE-02, FE-03]

coverage:
  - id: D1
    description: "ServeStaticModule serves the built React SPA at GET / from apps/api/dist/web (same origin, D-04)"
    requirement: "FE-01"
    verification:
      - kind: integration
        ref: "apps/api/scripts/serve-static-routes.smoke.mjs#ServeStaticModule serves the SPA at / while backend routes bypass it"
        status: pass
    human_judgment: false
  - id: D2
    description: "SPA catch-all does NOT shadow /api/*, /health, /graphql, /graphiql (exclude token confirmed empirically)"
    requirement: "FE-03"
    verification:
      - kind: integration
        ref: "apps/api/scripts/serve-static-routes.smoke.mjs#ServeStaticModule serves the SPA at / while backend routes bypass it"
        status: pass
    human_judgment: false
  - id: D3
    description: "node dist/index.js still boots (criterion #5a) even when the SPA is unbuilt — boot-safe dist/web (T-06-08)"
    verification:
      - kind: integration
        ref: "apps/api/scripts/selftest-index-boot.mjs#criterion #5a (Docker-FREE) boots to the listener marker"
        status: pass
      - kind: manual_procedural
        ref: "mv apps/web/dist aside -> node ensure-dist-web.mjs writes placeholder -> test:selftest passes (proven during execution)"
        status: pass
    human_judgment: false
  - id: D4
    description: "docker build --target runtime yields an image serving the REAL Vite bundle at /app/apps/api/dist/web/index.html; runtime carries no web deps (D-12, lean image)"
    requirement: "FE-02"
    verification:
      - kind: e2e
        ref: "docker build --target runtime -t code-guardian-app:phase6-web . && docker run --rm --entrypoint sh ... 'test -f /app/apps/api/dist/web/index.html'"
        status: pass
      - kind: e2e
        ref: "docker run ... assert absent: vite/tailwindcss/react/react-dom/urql; present: @nestjs/serve-static"
        status: pass
    human_judgment: false
  - id: D5
    description: "docker-compose keeps exactly three services (redis, api, worker); worker unchanged (heap discipline); api documents the served UI"
    verification:
      - kind: automated
        ref: "docker compose config --services => redis, api, worker (3)"
        status: pass
      - kind: unit
        ref: "grep worker.module.ts => no GraphQL/ServeStatic imports"
        status: pass
    human_judgment: false

# Metrics
duration: 32min
completed: 2026-07-11
status: complete
---

# Phase 6 Plan 03: Serve the Bonus A SPA + Docker Fold-in Summary

**Fastify (NestJS ServeStaticModule) serves the built React SPA at origin root from apps/api/dist/web with /api, /health, /graphql, /graphiql excluded (token confirmed empirically), a boot-safe dist/web that keeps the criterion #5a self-test green, and the web build folded into the multi-stage Dockerfile so `docker compose up` serves the UI on :3000 from a lean, web-dep-free runtime image.**

## Performance

- **Duration:** ~32 min
- **Started:** 2026-07-11T02:33Z (approx)
- **Completed:** 2026-07-11
- **Tasks:** 2
- **Files modified:** 6 (2 created, 4 modified) + package-lock.json

## Accomplishments
- `ServeStaticModule.forRoot({ rootPath: join(__dirname, 'web'), exclude: ['/api/{*path}', '/health', '/graphql', '/graphiql'] })` registered in **AppModule only** — the SPA is reachable at `GET /` on the same Fastify listener as REST + GraphQL (D-04), and the worker heap never loads it.
- Boot-safety guard (`scripts/ensure-dist-web.mjs`, wired as the api `postbuild`): after `nest build`'s `deleteOutDir` wipes `dist/`, it re-copies `apps/web/dist` into `dist/web` when present, else writes a one-line placeholder `index.html`. `ServeStaticModule`'s `rootPath` therefore ALWAYS exists — the always-required `node dist/index.js` self-test (criterion #5a) cannot regress even in the Docker-free CI jobs that never build the web app.
- Empirical route-exclusion smoke (`serve-static-routes.smoke.mjs`, `test:serve-static`): boots the real `dist/index.js` against a CLOSED Redis port and proves `GET /` serves the SPA while `/health`, `POST /graphql`, `/graphiql`, and `/api/scan/*` all reach their handlers — this is what CONFIRMS the path-to-regexp v8 `/api/{*path}` token rather than assuming it (RESEARCH Open Question 1).
- Multi-stage Dockerfile folds the web build into the builder stage (build `apps/web` first, the api build's postbuild copies it into `dist/web`), and scopes the runtime `npm ci` to `apps/api` so the runtime image carries the real Vite bundle but **none** of apps/web's dev or runtime deps.

## Task Commits

Each task was committed atomically:

1. **Task 1: Register ServeStaticModule + boot-safe dist/web + route smoke** - `eb5e4fe` (feat)
2. **Task 2: Fold the web build into the Dockerfile + compose served-UI note** - `a8fac79` (feat)

**Plan metadata:** (docs commit — this SUMMARY + STATE/ROADMAP)

## Files Created/Modified
- `apps/api/scripts/ensure-dist-web.mjs` (created) - api postbuild; materializes a boot-safe `dist/web/index.html` (real bundle or placeholder) after `deleteOutDir`.
- `apps/api/scripts/serve-static-routes.smoke.mjs` (created) - route-exclusion + SPA-served boot smoke over a real `dist/index.js`.
- `apps/api/src/app.module.ts` (modified) - added `ServeStaticModule.forRoot` with the exclude list; documented rootPath/exclude/traversal rationale.
- `apps/api/package.json` (modified) - `@nestjs/serve-static@5.0.5` (verbatim pin), `postbuild` hook, `test:serve-static` script.
- `package.json` (root, modified) - added `build:all` (web + api) while keeping api-only `build` for CI.
- `Dockerfile` (modified) - copy `apps/web/package.json` for builder `npm ci`; build web before api (single copy mechanism); runtime `npm ci` scoped to apps/api (no web deps).
- `docker-compose.yml` (modified) - api service comment documenting the served SPA at `/`; still exactly three services, worker unchanged.

## Decisions Made
- **Single copy mechanism:** the Dockerfile builds `apps/web` then relies on the api `postbuild` to copy `apps/web/dist` → `dist/web` (no duplicate Dockerfile `cp`), keeping one auditable path from bundle to served location.
- **Lean runtime via scoped install:** `npm ci --omit=dev --workspace apps/api --include-workspace-root` was verified (in a scratch tree) to succeed WITHOUT `apps/web/package.json` and to leave react/urql/vite/tailwind out of the image — the leanest correct option.
- **Exclude token confirmed, not assumed:** `/api/{*path}` (path-to-regexp v8) proven live by the smoke harness.

## Deviations from Plan

None - plan executed exactly as written. (Both tasks implemented as specified; the plan's Open Question 1 exclude token and Open Question 2 dist/web location were resolved exactly per the plan's recommendations and confirmed empirically.)

## Issues Encountered
- `@nestjs/serve-static` initially installed with a caret range (`^5.0.5`); corrected to the verbatim pin `5.0.5` (T-06-SC) and reconciled the lockfile.
- The runtime-stage `npm ci` needed care: because `apps/web` is a registered workspace, an unscoped `npm ci` would require `apps/web/package.json`. Scoping to `--workspace apps/api --include-workspace-root` both satisfies the lockfile and keeps web deps out of the runtime image (verified in a scratch install and in the built image).

## User Setup Required
None - no external service configuration required. `docker compose up` serves REST + GraphQL + the SPA on `:3000` with no host-side build.

## Next Phase Readiness
- Bonus A (FE-01/FE-02/FE-03) is now reviewer-accessible at one URL via `docker compose up` — ready for the documentation plan (06-04) to reference `docker compose up` as the primary served-UI run path.
- `build:all` is available for the local `node dist/index.js` served-UI path; README/ONBOARDING can cite it.
- No blockers. Worker heap discipline preserved (worker.module.ts unchanged; no GraphQL/static imports).

## Self-Check: PASSED
- Created files exist: apps/api/scripts/ensure-dist-web.mjs, apps/api/scripts/serve-static-routes.smoke.mjs.
- Task commits exist in git: eb5e4fe (Task 1), a8fac79 (Task 2).
- Plan `<verify>` chain re-run green: build -> dist/web/index.html present; test:selftest pass 1/fail 0; serve-static smoke pass 1/fail 0; docker build runtime -> WEB_OK (real bundle); runtime image carries no web deps; compose = 3 services; worker.module.ts has no GraphQL/static imports.

---
*Phase: 06-optional-bonuses-documentation*
*Completed: 2026-07-11*
