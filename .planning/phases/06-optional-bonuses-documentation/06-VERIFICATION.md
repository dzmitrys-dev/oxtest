---
phase: 06-optional-bonuses-documentation
verified: 2026-07-11T00:02:44Z
status: human_needed
score: 12/14 must-haves verified
behavior_unverified: 2
overrides_applied: 0
behavior_unverified_items:
  - truth: "SPA polls scan(id) every 2s via urql and STOPS polling on Finished/Failed (FE-02)"
    test: "Serve the built SPA (docker compose up or `npm run dev --workspace apps/web` against a running API), enqueue a scan, and watch the network tab: requests fire ~every 2000ms while Queued/Scanning, then STOP the moment status becomes Finished or Failed."
    expected: "A GetScan request every 2s during non-terminal states; zero further requests after the first terminal response (no leaked interval)."
    why_human: "The 2s cadence and the interval-clear-on-terminal invariant are runtime timer behavior. useScanPolling.ts is present and correctly wired (setInterval 2000ms + network-only reexecute; effect early-returns and clears on terminal), but no automated test exercises the live timer loop or proves it halts."
  - truth: "docker compose up serves the built UI on :3000 alongside REST + GraphQL (D-12); runtime image carries the real Vite bundle and no web deps"
    test: "Run `docker compose up --build`, then open http://localhost:3000 (SPA), http://localhost:3000/graphiql (playground), and curl http://localhost:3000/health and /api/scan/x."
    expected: "SPA loads at /, GraphiQL at /graphiql, REST/health reachable — all on :3000 from one image; worker service unchanged."
    why_human: "The Dockerfile web-build fold-in and compose wiring are present and correct on inspection, but the docker build + compose e2e (image contains the real bundle, lean runtime) was not executed in this verification (no Docker run); the SUMMARY claims it passed. Requires a host with Docker."
human_verification:
  - test: "Live SPA end-to-end: serve the UI, submit a GitHub repo URL, and observe the full flow through all four ScanStatus states."
    expected: "Client validation blocks a non-github/non-https URL; Start scan enqueues via the GraphQL mutation; Queued and Scanning render (indigo spinner), Finished shows the count summary + 5-column CRITICAL table (or emerald all-clear), Failed shows the red error card. Matches 06-UI-SPEC.md."
    why_human: "Interactive form UX, the 2s poll cadence/stop, and per-state visual fidelity are only observable at runtime against a live API; the static build proves structure and wiring, not runtime rendering."
  - test: "docker compose up runnable-from-the-README-alone against a live Docker stack."
    expected: "A reviewer following README's `docker compose up --build` reaches the SPA/GraphiQL/REST/health on :3000 with no host-side Trivy/Redis install."
    why_human: "End-to-end 'runnable from the README alone' depends on the reviewer's Docker environment; the automated checks prove the required commands/sections exist and every cited script is real, not that the stack comes up in an arbitrary environment."
  - test: "GraphiQL interactive playground renders in a browser."
    expected: "/graphiql loads the interactive GraphiQL UI; the enqueueScan mutation and scan(id) query can be run by hand."
    why_human: "The serve-static smoke already proves /graphiql serves GraphiQL HTML (not the SPA) and POST /graphql reaches Mercurius; the remaining check — that the playground renders and is usable interactively — is visual."
  - test: "ONBOARDING.md persuasive quality — a senior reviewer reads a topic and judges the What/Why/How + 'A reviewer might ask…' Q&A actually answers the sharp question."
    expected: "Each of the 13 topics + both bonuses reads as accurate interview-prep; the NestJS-vs-Fastify tension and the GraphiQL/socket-mount trade-offs are convincingly owned."
    why_human: "Structural presence (14 Q&A blocks, 42 What/Why/How headers, all tensions named) is verified automatically; persuasive/accurate completeness is a judgment call."
---

# Phase 6: Optional Bonuses & Documentation — Verification Report

**Phase Goal:** Optional bonuses are delivered only after the required backend is submission-ready, and a reviewer can run and understand every implemented design decision from the documentation.
**Verified:** 2026-07-11T00:02:44Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | (API-01) GraphQL `scan(id)` delegates to `ScanService.get`, returns `null` on unknown id (REST 404 parity, D-06) | ✓ VERIFIED | `scan.resolver.ts:33-39` awaits `this.scans.get(id)`, returns `null`/`toScanModel`. Resolver spec asserts both paths; full Jest suite 159 pass incl. this suite. |
| 2 | (API-02) `enqueueScan` delegates to `ScanService.enqueue` with the SAME `parseGithubUrl` allowlist as REST, enqueuing ONLY the canonical URL, rejecting before enqueue (T-06-01) | ✓ VERIFIED | `scan.resolver.ts:48-57` calls `parseGithubUrl`, throws before `enqueue` on null, enqueues `https://github.com/{owner}/{repo}`. Spec: 7 SSRF-negative + 2 canonicalization cases pass. |
| 3 | Code-first MercuriusDriver registered in AppModule ONLY (not WorkerModule); schema builds at bootstrap; `node dist/index.js` boots | ✓ VERIFIED | `app.module.ts:57-61` GraphQLModule.forRoot; `worker.module.ts` has zero GraphQL imports; `test:selftest` boots to listener marker. |
| 4 | GraphiQL reachable at `/graphiql` in all environments (D-05) | ✓ VERIFIED | `graphiql: true` in app.module; serve-static smoke asserts GET `/graphiql` returns 200 GraphiQL HTML (not SPA). |
| 5 | `graphql` pinned to 16.14.2 across the monorepo; no 17.x (Pitfall 1) | ✓ VERIFIED | Root `overrides.graphql=16.14.2`; `npm ls graphql` all 16.14.2 deduped; explicit 17.x grep found none. |
| 6 | No raw-Scan leak; `criticalVulnerabilities` populated only when Finished (D-06) | ✓ VERIFIED | `scan-graphql.mapper.ts` sets only id/status/(Finished→vulns); spec asserts no repoUrl/createdAt/updatedAt on the model. |
| 7 | (FE-01) Vite/React/urql/Tailwind SPA accepts a repo URL, client-validates, enqueues via GraphQL mutation | ✓ VERIFIED | `App.tsx` onSubmit → `useMutation(EnqueueScan)`; validation regex + disabled button; `vite build` emits dist/index.html. (Live UX → human) |
| 8 | (FE-02) SPA polls `scan(id)` every 2s via urql and STOPS on terminal state | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `useScanPolling.ts` 2000ms setInterval + network-only, effect early-returns + clears on terminal — present + wired, but the live timer/halt invariant is exercised by no test. |
| 9 | (FE-03) All four ScanStatus states render; 5-column table (Package/CVE/Installed/Severity/Title), CVE→primaryUrl, NO fix-version (D-08); 6-field query | ✓ VERIFIED | `App.tsx` StatusBody four branches + emerald all-clear; ResultsTable 5 cols, CVE `rel=noopener`; `graphql.ts` GetScan selects exactly the 6 stored fields. (Visual fidelity → human) |
| 10 | urql client targets RELATIVE `/graphql` (same origin, no CORS, D-04); `vite build` produces the static bundle | ✓ VERIFIED | `main.tsx` `url: '/graphql'`; build:all emits `apps/web/dist/index.html` + hashed assets. |
| 11 | API serves the SPA at `/` with `/api/*`,`/health`,`/graphql`,`/graphiql` excluded; boot-safe dist/web; static-only in AppModule | ✓ VERIFIED | `app.module.ts:62-65` ServeStaticModule+exclude; serve-static smoke asserts GET / serves SPA while all four backend routes bypass; `ensure-dist-web.mjs` postbuild; worker clean. |
| 12 | `docker compose up` serves the UI on :3000 alongside REST+GraphQL; lean runtime image (D-12) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Dockerfile builds web then api (postbuild copies to dist/web), runtime `npm ci` scoped to apps/api; compose = 3 services, worker unchanged. Docker build/run not executed here. |
| 13 | (DOC-01) README: compose-first run, memory self-test, acceptance cmd, ASCII architecture, NodeGoat demo, honest index.js-vs-worker.js mapping — all real commands | ✓ VERIFIED | All checklist items present; 14 cited `npm run` scripts all exist in package.json; ASCII diagram (§Architecture); dedicated honest-mapping section; NodeGoat REST demo. |
| 14 | (DOC-02) ONBOARDING: every solution as What/Why/How + reviewer Q&A + rejected alternatives; owns NestJS-vs-Fastify + GraphiQL trade-offs | ✓ VERIFIED | 14 "A reviewer might ask" blocks, 42 What/Why/How headers, Fastify tension, GraphiQL, Jest landmine, socket-mount, backpressure, type-safety all present. (Persuasiveness → human) |

**Score:** 12/14 truths verified (2 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `apps/api/src/graphql/scan.resolver.ts` | Thin @Resolver: scan query + enqueueScan mutation | ✓ VERIFIED | Sole collaborator ScanService; import-guarded; SSRF parity. |
| `apps/api/src/graphql/scan.model.ts` | @ObjectType ScanModel (id/status:String!/vulns) | ✓ VERIFIED | Matches locked API-01 schema. |
| `apps/api/src/graphql/vulnerability.model.ts` | @ObjectType 6 stored fields, no fixedVersion | ✓ VERIFIED | Exactly 6 @Field members. |
| `apps/api/src/graphql/scan-graphql.mapper.ts` | Status-switched domain→model mapper | ✓ VERIFIED | No raw spread; Finished-only vulns. |
| `apps/api/src/graphql/scan.resolver.spec.ts` | Mock-only resolver unit test | ✓ VERIFIED | 12 tests pass (delegation/canonicalization/SSRF/null/import-guard). |
| `apps/api/src/app.module.ts` | GraphQL + ServeStatic registration | ✓ VERIFIED | Both in imports; ScanResolver provider; exclude list. |
| `apps/web/*` (workspace + 5 src files) | Vite/React/urql/Tailwind SPA | ✓ VERIFIED | All files present + substantive; build succeeds. |
| `apps/api/scripts/ensure-dist-web.mjs` | Boot-safe dist/web postbuild | ✓ VERIFIED | Copies real bundle or writes placeholder. |
| `apps/api/scripts/serve-static-routes.smoke.mjs` | Route-exclusion smoke | ✓ VERIFIED | Genuine assertions; passes against real boot. |
| `Dockerfile` / `docker-compose.yml` | Web fold-in, 3 services | ✓ VERIFIED (static) | Builder builds web→api; compose 3 services; e2e run → human. |
| `README.md` | Reviewer run guide (DOC-01) | ✓ VERIFIED | Criterion #3 checklist complete, real commands. |
| `ONBOARDING.md` | Interview-prep What/Why/How (DOC-02) | ✓ VERIFIED | 13 topics + bonuses, Q&A, tensions owned. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| ScanResolver | ScanService.get/enqueue | direct injection | ✓ WIRED | Sole collaborator, confirmed in source + spec. |
| ScanResolver.enqueueScan | parseGithubUrl | import `../http/validation/github-url` | ✓ WIRED | Same allowlist as REST; canonical enqueue. |
| GraphQLModule | Fastify listener | AppModule MercuriusDriver | ✓ WIRED | selftest + smoke boot with /graphql + /graphiql live. |
| App.tsx onSubmit | ScanResolver.enqueueScan | urql useMutation → /graphql | ✓ WIRED | EnqueueScan document matches schema; relative URL. |
| useScanPolling | ScanResolver.scan | urql useQuery(GetScan) 2s | ✓ WIRED (runtime→human) | Correct wiring; live cadence unexercised. |
| ServeStaticModule.rootPath | apps/api/dist/web | join(__dirname,'web') | ✓ WIRED | smoke serves SPA at /; postbuild materializes dir. |
| Dockerfile builder | apps/api/dist/web | web build + api postbuild copy | ✓ WIRED (static) | Single copy mechanism; runtime COPY carries it. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| graphql resolves to 16.14.2 only | `npm ls graphql` + 17.x grep | all 16.14.2, no 17.x | ✓ PASS |
| Full build (web + api + postbuild) | `npm run build:all` | web dist + real Vite bundle → dist/web | ✓ PASS |
| dist/web is real bundle | grep hashed assets in dist/web/index.html | contains `assets/index-` | ✓ PASS |
| API boots with GraphQL+ServeStatic (criterion #5a) | `npm run test:selftest` | 1 pass, boots to listener marker | ✓ PASS |
| SPA served + backend routes bypass | `npm run test:serve-static` | 1 pass (/, /health, /graphql, /graphiql, /api/scan/*) | ✓ PASS |
| Full unit suite (no miette panic) | `npm run test` | 15 passed / 1 skipped, 159 tests pass | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| API-01 | 06-01 | GraphQL scan(id) query, code-first MercuriusDriver | ✓ SATISFIED | Truths 1,3,4,6; resolver + spec + selftest. |
| API-02 | 06-01 | GraphQL enqueue mutation, same ScanService, SSRF parity | ✓ SATISFIED | Truth 2; 7+2 spec cases pass. |
| FE-01 | 06-02, 06-03 | React app accepts URL + Start button | ✓ SATISFIED (live UX → human) | Truth 7; App.tsx + build. |
| FE-02 | 06-02, 06-03 | Polls status every 2s while in progress | ⚠️ NEEDS HUMAN | Truth 8; wired, runtime cadence unexercised. |
| FE-03 | 06-02, 06-03 | Displays CRITICAL on Finished, error on Failed | ✓ SATISFIED (visual → human) | Truth 9; four-state renderer + table. |
| DOC-01 | 06-04 | README run instructions + self-test + architecture | ✓ SATISFIED | Truth 13; checklist complete, real cmds. |
| DOC-02 | 06-04 | ONBOARDING What/Why/How interview-prep | ✓ SATISFIED (quality → human) | Truth 14; structure verified. |

All 7 declared requirement IDs (API-01, API-02, FE-01, FE-02, FE-03, DOC-01, DOC-02) are accounted for and appear in plan frontmatter. REQUIREMENTS.md maps exactly these 7 to Phase 6 — no orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (none) | — | No TODO/FIXME/XXX/HACK in phase source | ℹ️ Info | Clean; no unreferenced debt markers. |
| App.tsx | 230 | `placeholder=` attribute | ℹ️ Info | Legitimate HTML input placeholder — not a stub. |
| App.tsx | 25 | `dangerouslySetInnerHTML` in comment | ℹ️ Info | Comment stating it is NOT used (T-06-06 clean). |

### Human Verification Required

1. **Live SPA end-to-end** — submit a repo URL against a running API; observe validation, enqueue, 2s poll cadence/stop, and all four states render per 06-UI-SPEC.md.
2. **docker compose up e2e** — `docker compose up --build`; confirm SPA/GraphiQL/REST/health on :3000 from one image, worker unchanged.
3. **GraphiQL interactive render** — /graphiql playground loads and runs the mutation/query by hand (smoke already proves it serves GraphiQL HTML).
4. **ONBOARDING persuasive quality** — a senior reviewer judges the What/Why/How + Q&A actually answers the sharp questions.

### Gaps Summary

No gaps. Every automatable must-have is verified against the codebase: the GraphQL surface delegates to the shared ScanService with SSRF parity and boots with the schema built (API-01/02); the SPA is a substantive four-state urql app served same-origin with route exclusions proven by an empirical smoke; graphql is pinned 16.14.2; the full 159-test suite and both boot/smoke harnesses pass; and README/ONBOARDING contain the complete criterion #3 checklist with only real commands plus the D-11 topic set. The two ⚠️ PRESENT_BEHAVIOR_UNVERIFIED truths (2s poll runtime cadence, docker compose e2e) and the visual/quality items are present-and-wired but depend on runtime/Docker/human judgment — routed to human verification, not counted as failures. This matches the SUMMARY coverage, which flagged the same items as human_judgment.

---

_Verified: 2026-07-11T00:02:44Z_
_Verifier: Claude (gsd-verifier)_
