---
phase: 01-foundations-domain-types-strict-config
plan: 01
subsystem: infra
tags: [nestjs, fastify, typescript, npm-workspaces, tsconfig, jest, swc, monorepo]

# Dependency graph
requires: []
provides:
  - "npm-workspaces monorepo root (workspaces:[apps/api]) installable via one `npm install`"
  - "apps/api NestJS 11 package on the Fastify adapter (no Express traces)"
  - "strict TypeScript baseline (strict:true + noUncheckedIndexedAccess, TS pinned 6.0.3) — tsc --noEmit clean"
  - "two-entrypoint npm scripts (start:api/start:worker/dev:api/dev:worker) ready for Plan 02 index.ts/worker.ts"
  - "@swc/jest test transform configured (ts-jest removed)"
affects: [01-02, domain-types, scan-module, worker-bootstrap, docker-packaging]

# Tech tracking
tech-stack:
  added:
    - "@nestjs/core@11.1.28, @nestjs/common@11.1.28, @nestjs/platform-fastify@11.1.28, @nestjs/config@4.0.4"
    - "joi@18.2.3, reflect-metadata@0.2.2, rxjs@7.8.2"
    - "typescript@6.0.3 (exact), tsx@4.23.0, jest@30.4.2, @swc/jest@0.2.39"
    - "eslint@10.6.0, typescript-eslint@8.63.0, prettier@3.9.4, @types/node@26.1.1"
  patterns:
    - "npm workspaces with explicit member list (no apps/* glob until apps/web has a package.json in Phase 6)"
    - "root package.json delegates all 8 lifecycle scripts into apps/api"
    - "strict tsconfig overwritten wholesale, NestJS CommonJS emit preserved (verbatimModuleSyntax deliberately omitted)"
    - "tsc --noEmit is the authoritative TYPE-01 gate; @swc/jest transform skips type-checking"

key-files:
  created:
    - "package.json (root workspace)"
    - ".nvmrc (Node 22)"
    - "package-lock.json"
    - "apps/api/package.json"
    - "apps/api/tsconfig.json"
    - "apps/api/nest-cli.json"
    - "apps/api/eslint.config.mjs"
    - "apps/api/src/main.ts"
    - "apps/api/src/app.module.ts / app.controller.ts / app.service.ts / app.controller.spec.ts"
  modified:
    - "apps/api/package.json (pinned deps, engines, two-entrypoint scripts, @swc/jest transform)"
    - "apps/api/tsconfig.json (strict block, overwritten not patched)"

key-decisions:
  - "Pinned TypeScript exactly to 6.0.3 (NOT npm latest 7.0.2, NOT 5.9.x) — RESEARCH.md supersedes CLAUDE.md/STACK.md; 7.x breaks typescript-eslint (<6.1.0) and ts-jest (<7) peers"
  - "Omitted verbatimModuleSyntax this phase — it fights NestJS emitDecoratorMetadata + CommonJS DI-metadata model; TYPE-01 satisfied by strict + noUncheckedIndexedAccess alone"
  - "workspaces listed as explicit [apps/api], not apps/* glob (apps/web has no package.json until Phase 6)"
  - "Added ignoreDeprecations:'6.0' — TS 6.0.3 promotes moduleResolution:node and baseUrl to hard errors; official migration flag preserves the plan-mandated CommonJS flags"
  - "Added explicit types:[node,jest] so the strict typecheck resolves the boilerplate spec's Jest globals across the workspace hoist"
  - "Removed the CLI e2e test/ dir (supertest) — would violate rootDir:./src and is unused by the src-scoped jest config"

patterns-established:
  - "Monorepo: run everything from repo root via delegating scripts"
  - "Fastify adapter bootstrap: NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())"
  - "Two-entrypoint topology reserved (index.ts/worker.ts arrive in Plan 02)"

requirements-completed: [TYPE-01]

coverage:
  - id: D1
    description: "Root npm-workspaces monorepo installs apps/api via one `npm install`; TS pinned 6.0.3; platform-express absent, platform-fastify@11.1.28 present"
    requirement: "TYPE-01"
    verification:
      - kind: automated
        ref: "npm ls typescript --workspace apps/api == 6.0.3; npm ls @nestjs/platform-fastify == 11.1.28; ! npm ls @nestjs/platform-express (Task 2 verify => PASS)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Strict tsconfig (strict:true + noUncheckedIndexedAccess) compiles the scaffold with zero errors; no `any` in src; jest transform on @swc/jest with ts-jest removed"
    requirement: "TYPE-01"
    verification:
      - kind: automated
        ref: "npm run typecheck --workspace apps/api (tsc --noEmit) exits 0; no-any grep clean; @swc/jest transform present; ts-jest absent (Task 3 verify => PASS)"
        status: pass
    human_judgment: false
  - id: D3
    description: "`npm test` runs the jest suite via @swc/jest"
    verification:
      - kind: unit
        ref: "npm test --workspace apps/api"
        status: fail
    human_judgment: true
    rationale: "Deferred toolchain crash: @swc/core@1.15.43 + miette@7.6.0 native panic under the jest runtime on Node 24. The @swc/jest config is proven correct (every src file transforms cleanly via direct transformSync using jest's exact options). Not a Task 3 acceptance criterion (tsc is the authoritative type gate); no real tests exist yet. Needs human/next-phase decision on an @swc/core override before real tests land."

# Metrics
duration: ~35min
completed: 2026-07-09
status: complete
---

# Phase 1 Plan 01: Foundations — Workspace + Strict Config Summary

**npm-workspaces monorepo with an Express-free NestJS 11 / Fastify `apps/api` package, TypeScript pinned exactly to 6.0.3, compiling clean under `strict: true` + `noUncheckedIndexedAccess`.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-07-09T17:16:44Z
- **Tasks:** 3 (Task 1 checkpoint approved by coordinator; Tasks 2–3 executed)
- **Files modified:** 15 (root + apps/api scaffold)

## Accomplishments
- Root `package.json` is a private npm workspace listing `apps/api` explicitly, with all 8 lifecycle scripts (`build`, `start:api`, `start:worker`, `dev:api`, `dev:worker`, `typecheck`, `test`, `lint`) delegating into the workspace — reviewer can run everything from repo root.
- `apps/api` scaffolded as NestJS 11 on the **Fastify** adapter; `@nestjs/platform-express` removed, `main.ts` constructs the app via `FastifyAdapter`.
- Every dependency pinned to the RESEARCH.md-verified versions — critically `typescript@6.0.3` (not the npm `latest` 7.0.2, not 5.9.x) so `typescript-eslint`/`ts-jest`-adjacent peers resolve.
- `tsconfig.json` overwritten wholesale with `strict: true` + `noUncheckedIndexedAccess: true` (plus `noImplicitOverride`/`noFallthroughCasesInSwitch`/`noImplicitReturns`); `tsc --noEmit` exits 0 and no `any` appears in `src`.
- `@swc/jest` wired as the Jest transform (with NestJS decorator config) and `ts-jest` removed; `.nvmrc` + `engines` pin Node 22.

## Task Commits

1. **Task 1: Package legitimacy gate** — no commit (checkpoint; approved by coordinator, T-01-SC cleared)
2. **Task 2: Root workspace + scaffold apps/api on Fastify with pinned deps** — `2f7921d` (feat)
3. **Task 3: Overwrite tsconfig strict + swc jest transform + prove tsc clean** — `1707c8c` (feat)

## Files Created/Modified
- `package.json` (root) - private workspace root, `workspaces:[apps/api]`, 8 delegating scripts
- `.nvmrc` - pins Node 22 (V8 `--max-old-space-size` gate; Bun would silently ignore it)
- `package-lock.json` - single lockfile for the workspace
- `apps/api/package.json` - pinned deps, `engines.node >=22 <23`, two-entrypoint scripts, `@swc/jest` transform
- `apps/api/tsconfig.json` - strict block (overwritten), CommonJS/decorator flags, `ignoreDeprecations:6.0`, `types:[node,jest]`, `include:[src/**/*.ts]`
- `apps/api/tsconfig.build.json` - CLI default (extends, excludes specs)
- `apps/api/src/main.ts` - Fastify adapter bootstrap (temporary; replaced by `index.ts`/`worker.ts` in Plan 02)
- `apps/api/src/app.module.ts|app.controller.ts|app.service.ts|app.controller.spec.ts` - CLI boilerplate (temporary)

## Decisions Made
- **TypeScript 6.0.3 exact** — RESEARCH.md (live `npm view` 2026-07-09) supersedes CLAUDE.md/STACK.md's 5.9.x. `latest` (7.0.2, Go-native compiler) is incompatible with the lint/test toolchain peers.
- **No `verbatimModuleSyntax`** — would force `import type` discipline that conflicts with NestJS `emitDecoratorMetadata` + CommonJS DI metadata read at runtime. TYPE-01 is fully satisfied without it.
- **Explicit workspace member, not a glob** — avoids npm's undocumented handling of a package.json-less `apps/web` until Phase 6.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] TypeScript 6.0.3 rejects `moduleResolution:node` + `baseUrl` as errors**
- **Found during:** Task 3 (typecheck)
- **Issue:** TS 6.0.3 promotes the plan-mandated `moduleResolution:node` (node10) and `baseUrl` to hard errors (TS5107/TS5101), blocking `tsc --noEmit`.
- **Fix:** Added `"ignoreDeprecations": "6.0"` (the officially documented migration flag) so the plan's mandated CommonJS flags are preserved rather than swapped to a different module system.
- **Files modified:** apps/api/tsconfig.json
- **Verification:** `npm run typecheck --workspace apps/api` exits 0
- **Committed in:** 1707c8c

**2. [Rule 3 - Blocking] Strict typecheck could not resolve Jest globals in the boilerplate spec**
- **Found during:** Task 3 (typecheck)
- **Issue:** `app.controller.spec.ts` (in `src/`) uses `describe/it/expect`; `@types/jest` is hoisted to root `node_modules/@types` and TS auto-discovery did not resolve it across the workspace boundary → TS2593/TS2304.
- **Fix:** Added `"types": ["node", "jest"]` to compilerOptions (also kept `@types/jest` in devDependencies) and scoped `include` to `src/**/*.ts`.
- **Files modified:** apps/api/tsconfig.json, apps/api/package.json
- **Verification:** `tsc --noEmit` exits 0
- **Committed in:** 1707c8c

**3. [Rule 3 - Blocking] Removed CLI e2e `test/` dir to keep `rootDir:./src` valid**
- **Found during:** Task 2/3
- **Issue:** `nest new` generates `test/*.e2e-spec.ts` (supertest) that would violate `rootDir:./src` under `tsc` and is unused by the src-scoped Jest config.
- **Fix:** Removed `apps/api/test/`; dropped `supertest`/`@types/supertest`/`ts-loader`/`ts-node`/`tsconfig-paths`/`source-map-support` CLI leftovers.
- **Files modified:** apps/api/test/ (deleted), apps/api/package.json
- **Verification:** `tsc --noEmit` clean; `nest build` emits `dist/`
- **Committed in:** 2f7921d / 1707c8c

**4. [Rule 3 - Blocking] `@swc/jest` needed decorator config for NestJS**
- **Found during:** Task 3 (test toolchain validation)
- **Issue:** Default `@swc/jest` cannot parse `@Controller()` decorators ("Expression expected").
- **Fix:** Added inline swc config to the jest transform (`parser.decorators`, `transform.legacyDecorator`, `transform.decoratorMetadata`).
- **Files modified:** apps/api/package.json
- **Verification:** Direct `swc.transformSync` of every `src` file (incl. spec) succeeds with this config using jest's exact option set.
- **Committed in:** 1707c8c

---

**Total deviations:** 4 auto-fixed (all Rule 3 – blocking). All necessary to satisfy the plan's `tsc --noEmit`-clean gate on TS 6.0.3 + the pinned toolchain. No scope creep.

## Issues Encountered

**`npm test` native crash (DEFERRED — see coverage D3):** After the decorator config, `npm test` aborts with a core dump — `thread panicked ... miette-7.6.0/graphical.rs:1159: Formatting argument out of range` from `@swc/core@1.15.43` under the jest runtime on Node 24.
- **Root cause:** Native `@swc/core`/`miette` panic, NOT a config error. Proven by direct `swc.transformSync` of every `src` file (including the spec) succeeding with the *exact* option set jest builds (`sourceMaps:'inline'`, `jsc.transform.hidden.jest`, absolute filename, both `commonjs`/`es6` module types). Reproduces with `--runInBand`, cleared cache, and `NO_COLOR/COLUMNS` env overrides.
- **Why not fixed here:** (a) Exceeded the 3-attempt fix limit for this sub-issue; (b) not a Task 3 acceptance criterion — the plan designates `tsc --noEmit` as the authoritative TYPE-01 gate and notes `@swc/jest` skips type-checking; (c) no real tests exist this phase; (d) switching to `ts-jest` would violate the plan's own verify (requires `ts-jest` absent + `@swc/jest` present); (e) blindly pinning `@swc/core` risks breaking `nest build` (which also uses swc).
- **Resolution path (next phase, before real tests land):** add an npm `overrides` entry pinning `@swc/core` to a version without the miette panic, then re-run `npm test`. The transform config itself is correct and needs no change.

## Known Stubs
The `apps/api/src/app.*` files and `main.ts` are CLI boilerplate, intentionally temporary — Plan 02 replaces `main.ts` with `src/index.ts` + `src/worker.ts` and adds the real `ScanModule`/`AppModule`/`WorkerModule`/`domain/` per RESEARCH.md. No stubbed data flows to any UI.

## User Setup Required
None - no external service configuration required this phase.

## Next Phase Readiness
- Strict, `any`-free TypeScript baseline on NestJS 11 + Fastify is in place; one root `npm install` works; `tsc --noEmit` is green.
- Two-entrypoint scripts already point at `dist/index.js`/`dist/worker.js` and `src/index.ts`/`src/worker.ts` — Plan 02 just needs to author those files.
- **Carry-forward blocker:** resolve the `@swc/core` miette panic (npm `overrides`) before writing real Jest tests.

## Self-Check: PASSED
- Files verified on disk: package.json, .nvmrc, apps/api/package.json, apps/api/tsconfig.json, apps/api/src/main.ts, 01-01-SUMMARY.md
- Commits verified in git: 2f7921d (Task 2), 1707c8c (Task 3)

---
*Phase: 01-foundations-domain-types-strict-config*
*Completed: 2026-07-09*
