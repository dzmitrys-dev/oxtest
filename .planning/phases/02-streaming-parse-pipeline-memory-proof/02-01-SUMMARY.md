---
phase: 02-streaming-parse-pipeline-memory-proof
plan: 01
subsystem: api
tags: [stream-json, stream-chain, streaming, parser, eslint, jest]
requires:
  - phase: 01-foundation
    provides: Frozen Trivy input and CRITICAL vulnerability domain types plus CommonJS TypeScript configuration
provides:
  - Framework-free ReportParser async generator using deep leaf Pick and streamValues
  - Deterministic mixed-severity parser fixture and Jest regression test
  - Exact CommonJS stream dependency pins, fixture generator command, and parser materialization guard
affects: [phase-02-plan-02, phase-03-worker]
tech-stack:
  added: [stream-json@2.1.0, stream-chain@3.6.3]
  patterns: [deep Results.<index>.Vulnerabilities.<index> Pick, one-value async generator, parser-scoped ESLint restrictions]
key-files:
  created: [apps/api/src/parser/report-parser.ts, apps/api/src/parser/report-parser.spec.ts, apps/api/src/stream-json.d.ts, apps/api/fixtures/known-severity-mix.json, apps/api/scripts/gen-fixture.ts]
  modified: [apps/api/package.json, package-lock.json, apps/api/eslint.config.mjs, .gitignore]
key-decisions:
  - "Use stream-json 2.1.0 and stream-chain 3.6.3 to preserve the locked CommonJS build and Node >=22 <23 engine range."
  - "Use a deep leaf Pick plus streamValues instead of assembling Results entries, and allow streamValues in the static guard."
requirements-completed: [ENGINE-05, MEM-01, MEM-04]
coverage:
  - id: D1
    description: "ReportParser yields mapped CRITICAL vulnerabilities one at a time from nested Trivy Results."
    requirement: ENGINE-05
    verification:
      - kind: unit
        ref: "apps/api/src/parser/report-parser.spec.ts#emits the exact mapped CRITICAL vulnerabilities from nested results"
        status: pass
    human_judgment: false
  - id: D2
    description: "Committed skewed mixed-severity fixture proves exact CRITICAL-only output."
    requirement: MEM-04
    verification:
      - kind: unit
        ref: "npm test --workspace apps/api -- --runInBand src/parser/report-parser.spec.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Parser has independent deep-path, streamValues, forbidden-API, and runtime-boundary checks."
    requirement: ENGINE-05
    verification:
      - kind: other
        ref: "npm run lint --workspace apps/api plus independent node/grep guard commands"
        status: pass
    human_judgment: false
metrics:
  duration: 12min
  completed: 2026-07-09
status: complete
---

# Phase 2 Plan 1: Streaming Parser Contract Summary

**Leaf-level Trivy parsing with exact CRITICAL filtering, deterministic correctness proof, and mechanical anti-materialization enforcement.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-09T20:17:00Z (approximate)
- **Completed:** 2026-07-09
- **Tasks:** 3 (Task 1 approval checkpoint accepted; Tasks 2-3 executed)
- **Files modified:** 9 committed files plus this summary

## Accomplishments

- Implemented exported framework-free `ReportParser.parse()` as an async generator over `createReadStream` → parser → deep `Pick` → `streamValues` → CRITICAL filter.
- Added a deliberately skewed multi-Result fixture and exact mapped-output Jest regression test; no HIGH, MEDIUM, or LOW values are emitted.
- Added exact dependency pins, a backpressure-aware `gen:fixture` command, narrow generated-fixture ignore rule, and parser-scoped ESLint restrictions for full-report materialization APIs.
- Confirmed ReportParser remains unwired into `index.ts`, `worker.ts`, and `scan.module.ts`.

## Task Commits

1. **Task 1: Approve pinned stream package legitimacy** - checkpoint approved by user; no code commit
2. **Task 2: Implement leaf-streaming parser and correctness fixture** - `6853b6e` (feat)
3. **Task 3: Verify parser guard and runtime boundary** - no additional changes; verification passed

## Files Created/Modified

- `apps/api/src/parser/report-parser.ts` - Deep leaf-streaming parser and domain mapping.
- `apps/api/src/parser/report-parser.spec.ts` - Exact fixture-driven async-generator regression test.
- `apps/api/src/stream-json.d.ts` - CJS/module-resolution declarations for pinned stream-json subpaths.
- `apps/api/fixtures/known-severity-mix.json` - Mixed and skewed Trivy-shaped correctness fixture.
- `apps/api/scripts/gen-fixture.ts` - Incremental, backpressure-aware large-fixture generator.
- `apps/api/package.json`, `package-lock.json` - Exact stream dependency pins and `gen:fixture` script.
- `apps/api/eslint.config.mjs` - Parser-path forbidden API rules; scripts are intentionally outside the src type-aware lint project.
- `.gitignore` - Narrow generated large-fixture ignore rule.

## Decisions Made

- Accepted the user-approved package checkpoint and pinned exactly `stream-json@2.1.0`, `stream-chain@3.6.3`.
- Preserved CommonJS and Node `>=22 <23`; used a local declaration shim rather than changing module resolution.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Resolved TypeScript module-resolution failure for stream-json subpath declarations**
- **Found during:** Task 2
- **Issue:** TypeScript `moduleResolution: node` could not resolve the package's `.js` subpath declarations.
- **Fix:** Added focused declarations for the two imported stream-json subpaths without changing the locked CommonJS configuration.
- **Files modified:** `apps/api/src/stream-json.d.ts`
- **Verification:** Typecheck, Jest, and lint pass.
- **Committed in:** `6853b6e`

**2. [Rule 3 - Blocking] Kept the requested fixture command lintable without expanding the application tsconfig root**
- **Found during:** Task 2
- **Issue:** The requested `scripts/gen-fixture.ts` is intentionally outside `tsconfig.json`'s `src` root and caused type-aware ESLint to fail.
- **Fix:** Narrowly excluded only `scripts/**` from the existing application ESLint config; the script remains executable through `tsx`.
- **Files modified:** `apps/api/eslint.config.mjs`
- **Verification:** `npm run lint --workspace apps/api` and a 1 MB generator smoke run pass.
- **Committed in:** `6853b6e`

**Total deviations:** 2 auto-fixed (Rule 3 blocking issues). No architectural changes.

## Issues Encountered

- Local runtime is Node 24.10.0, producing expected engine warnings; all required typecheck, focused Jest, lint, dependency, generator, and static-boundary checks passed. Node 22 remains the authoritative project runtime for later memory proof.

## Known Stubs

None in the files created or modified by this plan.

## Threat Flags

None. The parser handles the planned report-file trust boundary and introduces no network, authentication, or schema surface.

## Verification

- `npm run typecheck --workspace apps/api` — passed.
- `npm test --workspace apps/api -- --runInBand src/parser/report-parser.spec.ts` — passed (1 test).
- `npm run lint --workspace apps/api` — passed.
- Exact dependency and Node engine assertions — passed.
- Independent forbidden-API, runtime-boundary, deep Pick path, and `streamValues` checks — passed.
- `npm run gen:fixture --workspace apps/api -- /tmp/oxtest-generated-fixture.json 1` plus JSON validity check — passed.

## Next Phase Readiness

The standalone parser contract and static memory guard are ready for Phase 2 Plan 2 memory instrumentation. Parser remains intentionally outside runtime wiring for Phase 3.

---
*Phase: 02-streaming-parse-pipeline-memory-proof*
*Completed: 2026-07-09*

## Self-Check: PASSED

- FOUND: `.planning/phases/02-streaming-parse-pipeline-memory-proof/02-01-SUMMARY.md`
- FOUND: commit `6853b6e`
- STATE.md and ROADMAP.md were intentionally not modified by this executor.
