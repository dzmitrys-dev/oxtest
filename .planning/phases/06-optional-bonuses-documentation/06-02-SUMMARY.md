---
phase: 06-optional-bonuses-documentation
plan: 02
subsystem: ui
tags: [react, vite, urql, tailwind, graphql, frontend, bonus-a]

# Dependency graph
requires:
  - phase: 06-optional-bonuses-documentation (Plan 01)
    provides: "Code-first GraphQL surface — enqueueScan(repoUrl) mutation + scan(id) query returning Scan { id, status, criticalVulnerabilities { 6 fields } } on the same Fastify origin"
provides:
  - "apps/web — new Vite/React 19/urql/Tailwind v4 npm workspace (Bonus A SPA)"
  - "Single-screen scan UI: client-validated repo URL form → GraphQL enqueue → 2s poll → four-state renderer (Queued/Scanning/Finished/Failed) with a 5-column CRITICAL table"
  - "apps/web/dist Vite static bundle (gitignored build artifact) for Plan 03 to serve static via the API"
affects: [06-03 (static-serve wiring + Docker fold-in), 06-04 (README/ONBOARDING docs)]

# Tech tracking
tech-stack:
  added: [vite@8.1.4, react@19.2.7, react-dom@19.2.7, urql@5.0.3, "@urql/core@6.0.3", "@vitejs/plugin-react@6.0.3", tailwindcss@4.3.2, "@tailwindcss/vite@4.3.2"]
  patterns:
    - "urql manual 2s poll: useQuery + setInterval + reexecute({requestPolicy:'network-only'}), early-return on terminal state (no built-in pollInterval)"
    - "Tailwind v4 zero-config: single @import \"tailwindcss\"; via @tailwindcss/vite (no tailwind.config.js / postcss.config)"
    - "Relative /graphql client URL for same-origin static-served SPA (no CORS, D-04)"
    - "GraphQL selection set locked to exactly the 6 persisted Vulnerability fields (D-08)"

key-files:
  created:
    - apps/web/package.json
    - apps/web/tsconfig.json
    - apps/web/vite.config.ts
    - apps/web/index.html
    - apps/web/src/index.css
    - apps/web/src/vite-env.d.ts
    - apps/web/src/main.tsx
    - apps/web/src/graphql.ts
    - apps/web/src/useScanPolling.ts
    - apps/web/src/App.tsx
  modified:
    - package.json
    - package-lock.json

key-decisions:
  - "Failed-state card renders the humanized generic ('unknown' category) copy because the Wave-1 GraphQL ScanModel exposes only id/status/criticalVulnerabilities — it does NOT surface the domain error reason, and D-08 forbids requesting a field the schema/parser does not provide"
  - "@types/react-dom pinned to 19.2.3 (latest 19.x) — the plan's suggested 19.2.7 does not exist on npm; @types/react to 19.2.17"
  - "Added apps/web/src/vite-env.d.ts (vite/client types) so the './index.css' side-effect import type-checks under strict tsc"
  - "Client URL validation canonicalizes to https://github.com/owner/repo before enqueue, mirroring the server GithubUrlPipe/parseGithubUrl contract"

patterns-established:
  - "Pattern 1: urql poll hook (useScanPolling) that stops re-arming its interval once status is Finished/Failed"
  - "Pattern 2: four-state status renderer keyed on the exact ScanStatus wire strings"
  - "Pattern 3: server data rendered as inert React text nodes only; primaryUrl used solely as an href (rel=noopener noreferrer target=_blank); no dangerouslySetInnerHTML"

requirements-completed: [FE-01, FE-02, FE-03]

coverage:
  - id: D1
    description: "Vite/React SPA accepts a GitHub repo URL, client-validates it, and a Start scan button enqueues via the GraphQL enqueueScan mutation (FE-01)"
    requirement: FE-01
    verification:
      - kind: integration
        ref: "npm run build --workspace apps/web (tsc --noEmit + vite build) — App.tsx onSubmit→useMutation(EnqueueScan) compiles and bundles"
        status: pass
    human_judgment: true
    rationale: "Live enqueue against a running GraphQL API + interactive form validation UX is not exercised by the build; needs a human to run the app against the API (Plan 03 static-serve or dev proxy) and submit a URL"
  - id: D2
    description: "SPA polls scan(id) every 2s via urql and stops polling on Finished/Failed (FE-02)"
    requirement: FE-02
    verification:
      - kind: integration
        ref: "apps/web/src/useScanPolling.ts — 2000ms setInterval + reexecute network-only, effect early-returns on terminal; type-checks via build"
        status: pass
    human_judgment: true
    rationale: "The 2s cadence and terminal-stop behavior are only observable at runtime against a live scan; static build cannot prove the timer loop halts"
  - id: D3
    description: "All four ScanStatus states render (Queued/Scanning/Finished/Failed); Finished shows a count summary + 5-column CRITICAL table (or emerald all-clear on 0); Failed shows a red error card (FE-03, D-07, D-08)"
    requirement: FE-03
    verification:
      - kind: integration
        ref: "apps/web/src/App.tsx StatusBody — four exact-string branches + ResultsTable (Package/CVE/Installed/Severity/Title); vite build succeeds"
        status: pass
    human_judgment: true
    rationale: "Visual fidelity to 06-UI-SPEC.md (spacing/type/color) and correct per-state rendering are judgment calls requiring a human to view each state in a browser"

# Metrics
duration: 8min
completed: 2026-07-11
status: complete
---

# Phase 6 Plan 02: Bonus A React SPA Summary

**Vite/React 19 + urql + Tailwind v4 single-screen SPA that enqueues a scan over GraphQL, polls scan(id) every 2s until terminal, and renders all four ScanStatus states with a 5-column CRITICAL vulnerabilities table.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-07-11T02:19:00+03:00
- **Completed:** 2026-07-11T02:27:17+03:00
- **Tasks:** 3
- **Files modified:** 12 (10 created, 2 modified)

## Accomplishments
- New `apps/web` npm workspace registered in root workspaces, with the RESEARCH Standard Stack pinned verbatim (Vite 8 / React 19 / urql 5 / Tailwind v4); `graphql` resolves to 16.14.2 via the root override (one graphql major across the monorepo, Pitfall 1).
- urql client against the RELATIVE `/graphql` URL (same origin, no CORS, D-04); `GetScan` selects exactly the six persisted Vulnerability fields (D-08); `useScanPolling` polls at 2000ms and stops on Finished/Failed (FE-02).
- `App.tsx` implements the full 06-UI-SPEC.md contract: client-validated repo URL form, four-state renderer (Queued / Scanning indigo spinner / Finished count summary + table or emerald all-clear / Failed red card), and the CRITICAL table with exactly five columns (Package/CVE/Installed/Severity/Title) — CVE hyperlinks `primaryUrl` with `rel="noopener noreferrer"`, no fix-version column.
- `vite build` produces `apps/web/dist/index.html` + hashed assets (12kB CSS confirms Tailwind detected utilities) — the static bundle Plan 03 will serve.

## Task Commits

Each task was committed atomically:

1. **Task 1: Scaffold apps/web workspace (Vite + React + Tailwind v4 + pinned deps)** - `d66ef19` (feat)
2. **Task 2: urql client, GraphQL documents, 2s poll hook** - `1aa665e` (feat)
3. **Task 3: App.tsx four-state renderer + CRITICAL table** - `32eae7b` (feat)

## Files Created/Modified
- `apps/web/package.json` - Workspace manifest; pinned Vite/React/urql/Tailwind stack + build/dev/preview/lint scripts
- `apps/web/tsconfig.json` - Strict React tsconfig (noUncheckedIndexedAccess, react-jsx, bundler resolution, no `any`)
- `apps/web/vite.config.ts` - `react()` + `tailwindcss()` plugins; dev-only `/graphql` proxy to :3000; `base: '/'`
- `apps/web/index.html` - `#root` div + `/src/main.tsx` module entry
- `apps/web/src/index.css` - Single Tailwind v4 `@import "tailwindcss";`
- `apps/web/src/vite-env.d.ts` - `vite/client` ambient types for the `*.css` side-effect import
- `apps/web/src/main.tsx` - urql `Client` (relative `/graphql`) + `<Provider>` bootstrapping `<App/>` in StrictMode
- `apps/web/src/graphql.ts` - `EnqueueScan` mutation + `GetScan` query (6-field selection) + typed result shapes
- `apps/web/src/useScanPolling.ts` - 2s poll hook, stops on terminal state
- `apps/web/src/App.tsx` - Form + four-state renderer + CRITICAL results table (06-UI-SPEC.md)
- `package.json` - Added `apps/web` to `workspaces`
- `package-lock.json` - New workspace + dependency graph

## Decisions Made
- **Failed-state copy is generic (unknown category):** the Wave-1 GraphQL `ScanModel` exposes only `id`/`status`/`criticalVulnerabilities` — no `error` field. D-08 forbids requesting a field the schema/parser doesn't provide, so the Failed card renders the humanized "The scan failed unexpectedly. Check the repository URL and try again." rather than a per-category message or `error.detail`. The full category map is retained in code for if/when the schema exposes `error`.
- **`@types/react-dom@19.2.7` does not exist** on npm; pinned the actual latest 19.x (`19.2.3`; `@types/react` → `19.2.17`). The plan specified "(19.x)" for the types, so this stays within the intended range.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Corrected non-existent `@types/react-dom` pin**
- **Found during:** Task 1 (workspace scaffold / install)
- **Issue:** `npm install` failed with `ETARGET No matching version found for @types/react-dom@19.2.7`
- **Fix:** Resolved the actual latest 19.x types (`@types/react-dom@19.2.3`, `@types/react@19.2.17`) — within the plan's "(19.x)" spec
- **Files modified:** apps/web/package.json, package-lock.json
- **Verification:** `npm install` succeeds; `tsc --noEmit` passes
- **Committed in:** d66ef19 (Task 1 commit)

**2. [Rule 3 - Blocking] Added `apps/web/src/vite-env.d.ts`**
- **Found during:** Task 2 (urql client / main.tsx)
- **Issue:** `tsc --noEmit` errored TS2882 — no type declaration for the `./index.css` side-effect import
- **Fix:** Added the standard `/// <reference types="vite/client" />` declaration file (provides Vite's `*.css` ambient module types)
- **Files modified:** apps/web/src/vite-env.d.ts
- **Verification:** `tsc --noEmit` passes
- **Committed in:** 1aa665e (Task 2 commit)

**3. [Rule 3 - Blocking] Minimal `App.tsx` stub in Task 2**
- **Found during:** Task 2 (main.tsx imports `./App`, which is a Task 3 file)
- **Issue:** Task 2's `tsc --noEmit` verify could not pass because `main.tsx` imports `App` before Task 3 creates it
- **Fix:** Committed a minimal valid `App` placeholder in Task 2, then replaced it with the full four-state SPA in Task 3
- **Files modified:** apps/web/src/App.tsx
- **Verification:** `tsc --noEmit` passes in Task 2; full `vite build` passes in Task 3
- **Committed in:** 1aa665e (stub, Task 2) → 32eae7b (full, Task 3)

---

**Total deviations:** 3 auto-fixed (all Rule 3 - blocking dependency/config resolution)
**Impact on plan:** All three are mechanical unblockers (a wrong version pin, a standard Vite type-decl file, and a task-ordering stub for atomic commits). No scope creep; the delivered surface matches the plan and 06-UI-SPEC.md.

## Issues Encountered
- Backend `npm audit` reports 7 high-severity advisories in `graphql-jit` / `mercurius` / `@nestjs/graphql` — these are pre-existing Wave-1 `apps/api` transitive deps with "No fix available"; out of scope for this frontend plan (not introduced by `apps/web`), left untouched.

## User Setup Required
None - no external service configuration required. (Local dev uses the Vite `/graphql` proxy to a running API on :3000; the production bundle is same-origin.)

## Next Phase Readiness
- `apps/web/dist` builds cleanly and is ready for Plan 03 to serve static via the API (`ServeStaticModule` / `@fastify/static`) and fold into the Dockerfile/compose.
- Runtime behavior (live enqueue, 2s poll cadence, per-state visuals) is not exercised by the static build — verify against a running GraphQL API during Plan 03 or UAT.
- No `error` field on the GraphQL `ScanModel`: if richer Failed-state messaging (per-category + detail) is desired, a future plan must extend the schema; this plan honored D-08 and did not expand the query.

---
*Phase: 06-optional-bonuses-documentation*
*Completed: 2026-07-11*
