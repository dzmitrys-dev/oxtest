---
phase: 02-streaming-parse-pipeline-memory-proof
fixed_at: 2026-07-10T08:20:00-04:00
review_path: .planning/phases/02-streaming-parse-pipeline-memory-proof/02-REVIEW.md
iteration: 2
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 02: Code Review Fix Report

**Fixed at:** 2026-07-10T08:20:00-04:00
**Source review:** .planning/phases/02-streaming-parse-pipeline-memory-proof/02-REVIEW.md
**Iteration:** 2

**Summary:**
- Findings in scope: 3
- Fixed: 3
- Skipped: 0

## Fixed Issues

### WR-01: Sweep flat-RSS gate still compares rounded measurements

**Files modified:** `apps/api/scripts/memtest.ts`, `apps/api/scripts/memtest-sweep.ts`, `apps/api/scripts/memory-process-contract.test.mjs`
**Commit:** 85bc256
**Applied fix:** Added raw RSS bytes to the memtest JSON contract, made the sweep return and compare raw bytes, and added a boundary regression proving a one-byte overage is rejected even when display values round to the same MiB values.

### WR-02: Source-mode sweep can execute stale compiled scripts

**Files modified:** `apps/api/scripts/memtest-sweep.ts`, `apps/api/scripts/memory-process-contract.test.mjs`
**Commit:** 85bc256
**Applied fix:** Made child script selection depend explicitly on whether the sweep entrypoint is the compiled `dist/scripts/memtest-sweep.js`; source mode always launches the current TypeScript children through `tsx`.

### WR-03: Contract test uses a process-global fixed fixture path

**Files modified:** `apps/api/scripts/memory-process-contract.test.mjs`
**Commit:** 85bc256
**Applied fix:** Changed the pre-existing-fixture regression to use an `mkdtemp`-owned directory and recursive cleanup in `finally`, isolating concurrent test processes.

## Verification

- `npm run typecheck --workspace apps/api` — passed.
- `npm run lint --workspace apps/api` — passed.
- `npm run build --workspace apps/api` — passed.
- `npm test --workspace apps/api -- --runInBand` — passed (6 tests).
- `npm run test:memory-contract --workspace apps/api` — passed (14 tests).
- `npm run memtest:sweep --workspace apps/api -- --dry-run` — passed (50MB, 200MB, 500MB cases).
- `node apps/api/dist/scripts/memtest-sweep.js --dry-run` — passed (compiled mode cases).
- `npm run memtest:sweep --workspace apps/api` — passed (50MB, 200MB, and 500MB cases).
- `git diff --check` — passed.

---

_Fixed: 2026-07-10T08:20:00-04:00_
_Fixer: the agent (gsd-code-fixer)_
_Iteration: 2

STATUS: all_fixed
COMMIT: 85bc256
VERIFICATION: typecheck, lint, build, Jest, memory-contract, source dry-run, compiled dry-run, full sweep, and diff-check all passed.

Files intentionally not modified: `.planning/STATE.md`, `.planning/ROADMAP.md`.

_FIXER_NOTE: Logic changes were verified with targeted contract regressions and full requested commands; human review of RSS policy remains appropriate._
