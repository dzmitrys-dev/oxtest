# Phase 6: Optional Bonuses & Documentation - Context

**Gathered:** 2026-07-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver the optional bonuses **as upside on an already-submission-ready backend** (Phases 1–5 shipped the required, memory-proof, Dockerized scan engine + REST API + acceptance gate), plus the two **required** documentation deliverables. Concretely, this phase ships:

1. **Bonus B — GraphQL (API-01/02):** a code-first GraphQL surface (MercuriusDriver) exposing a `scan(id)` query and an enqueue mutation, both delegating to the *existing* `ScanService` — no reimplementation.
2. **Bonus A — React frontend (FE-01/02/03):** a Vite React app that accepts a GitHub repo URL, starts a scan, polls every 2s, and renders Finished/Failed states with the CRITICAL vulnerabilities.
3. **README.md (DOC-01):** copy-paste run instructions, the memory self-test command, the acceptance command, an architecture overview, a real NodeGoat scan demo, and the honest `index.js`-vs-`worker.js` self-test mapping.
4. **ONBOARDING.md (DOC-02):** an interview-prep doc explaining every implemented solution in What/Why/How form with anticipated reviewer questions.

**This phase does NOT add:** Bonus C (docker-compose + `mem_limit: 200m` + in-container OOM proof) — **already delivered in Phase 5** (prior D-04). It does NOT change engine/parser/worker/REST behavior; GraphQL and the frontend are additive surfaces over the unchanged Phase 1–5 contracts (`ScanService`, `ScanRepository`, the two-entrypoint topology, `/health`).

**Requirements:** API-01, API-02, FE-01, FE-02, FE-03, DOC-01, DOC-02. *(OPS-01/OPS-02 were moved to Phase 5 per prior CONTEXT D-04.)*

</domain>

<decisions>
## Implementation Decisions

### Bonus scope & sequencing
- **D-01 [informational]:** **Build BOTH Bonus A (React/Vite) and Bonus B (GraphQL).** Docs (README + ONBOARDING) ship regardless. Bonus C is already done (Phase 5). The two bonus success criteria (#1 GraphQL, #2 React) are therefore satisfied, not deferred. *(Scope-framing meta-decision — realized collectively by the existence of plans 06-01…06-04 and their requirement coverage, API-01/02 + FE-01/02/03 + DOC-01/02; not a single-plan trackable decision.)*
- **D-02:** **GraphQL is code-first via MercuriusDriver, registered on the SAME Fastify process/port as REST** (one process, zero second-listener overhead). Both operations delegate to the existing `ScanService`: the query calls `ScanService.get(id)` (`apps/api/src/scan/scan.service.ts:55`) and the mutation calls `ScanService.enqueue(repoUrl)` (`apps/api/src/scan/scan.service.ts:34`). Schema is **locked by API-01**: `type Scan { id: ID!, status: String!, criticalVulnerabilities: [Vulnerability] }`. Do NOT reimplement scan logic in a resolver.

### React frontend — backend wiring & serving
- **D-03:** **The React app consumes GraphQL (not REST)** — enqueue via the mutation, then poll `scan(id)` every 2s (FE-02) — so both bonuses visibly work together (dogfooding B). This adds a GraphQL client dependency (urql preferred for leanness; Apollo acceptable — Claude discretion). The REST endpoints remain unchanged and are still exercised by the Phase 5 acceptance gate.
- **D-04:** **The React app is built (`vite build`) and served as static assets by the API (Fastify) on the same origin** — no CORS, one URL for the reviewer to open. New monorepo workspace `apps/web`. The `docker compose up` path must serve the built UI alongside the API.

### GraphQL surface
- **D-05:** **GraphiQL (interactive playground) is ENABLED at `/graphiql` in all environments, including the container**, for reviewer explorability (run the enqueue mutation + `scan(id)` query by hand). The minor prod-hygiene trade-off of exposing introspection/playground is a deliberate demo choice — note it in ONBOARDING.
- **D-06 (discretion, must be parity):** GraphQL error/empty semantics **mirror REST**: an unknown id resolves consistently with `ScanService.get` returning `null`; a failed scan surfaces via `status: "Failed"` (and `criticalVulnerabilities` empty). Exact error mapping is Claude's discretion provided it stays consistent with the REST contract.

### React frontend — UX & results
- **D-07:** **Polish via Tailwind (or a component library)**; the bar is "looks finished, not scaffolded," which means **every state is handled**: URL input + client-side validation, `Queued`, `Scanning` (progress/spinner), `Finished` (results), and `Failed` (error state). All four `ScanStatus` states must render.
- **D-08:** **CRITICAL results render as a TABLE with a count summary.** Columns MUST map to the **actually-stored `Vulnerability` shape** (`apps/api/src/domain/vulnerability.types.ts`): `pkgName` (Package), `vulnerabilityId` (CVE), `installedVersion` (Installed), `title`, and `primaryUrl` (link). **HARD CONSTRAINT:** the stored `Vulnerability` type has **no `fixedVersion` field** — do NOT add a "Fixed version" column and do NOT expand the parser to capture new fields (that would touch the memory-critical streaming pipeline). Use only the fields already persisted.

### ONBOARDING.md (DOC-02)
- **D-09:** **Single `ONBOARDING.md`.** Each topic follows **What/Why/How + an explicit "A reviewer might ask…" Q&A block** — directly serving the interview-prep goal and anticipating challenges.
- **D-10:** **Each topic documents rejected alternatives / trade-offs explicitly** (harvest the rationales already recorded across the Phase 1–5 CONTEXT files: `JSON.parse`/`fs.readFile` rejected, `bfj` vs `stream-json`, AsyncLocalStorage rejected for the Redis hop, `node:22-slim` over alpine/distroless, no pino transport in-container, etc.). **Explicitly own the NestJS-vs-Fastify tension** — the repo's own `.claude/CLAUDE.md` recommends Fastify-over-NestJS, yet the build is on NestJS(+Fastify adapter); explain that decision rather than leaving it unexamined.
- **D-11:** **Expanded topic coverage.** The five DOC-02-named topics (memory strategy, architecture layering, queue design, error handling, type safety) PLUS: streaming/backpressure, the Trivy local-detect+Docker-fallback design and the compose **socket-mount trade-off** (Phase 5 D-06), the **two-entrypoint topology + self-test honesty** (Phase 5 D-10), the **guaranteed try/finally cleanup** (Phase 3), and the **testing strategy** (the `@nestjs/bullmq`+`@swc` Jest landmine → compiled-`dist` + `node:test` harnesses).

### README.md (DOC-01)
- **D-12:** **docker-compose-first primary run path** — lead with `docker compose up` (redis + api + worker + served React UI) as the one-command path; local dev is a secondary section. Must be **runnable from the README alone**.
- **D-13:** **Architecture overview as an ASCII diagram + brief prose** (renders everywhere, no mermaid/render dependency).
- **D-14:** **Division of labor — README runs, ONBOARDING explains.** README = run instructions + short architecture overview + a link to ONBOARDING for the deep "why". ONBOARDING holds the full What/Why/How + Q&A. No duplication; single source of truth per concern.
- **D-15 (criterion #3 checklist — MANDATORY in README):** copy-paste run (compose + local dev), the **memory self-test command**, the **assignment-level acceptance command**, the architecture overview, **(a)** a real functional scan demo against the forked **OWASP NodeGoat** repo URL, and **(b)** the honest explanation that the PDF's literal `node --max-old-space-size=150 dist/index.js` boots the API while the 500MB+ parse runs in `dist/worker.js` (standalone parser memtest = the honest 500MB proof), per Phase 5 D-10.

### Claude's Discretion
- GraphQL client library for `apps/web` (urql preferred for leanness vs Apollo).
- Exact GraphQL error mapping (must be REST parity per D-06) and the enqueue mutation's input shape (e.g. `enqueueScan(repoUrl: String!): Scan`).
- `apps/web` internal structure, Vite config, and Tailwind-vs-component-library specifics.
- Static-serving mechanism (`@fastify/static` vs Nest `ServeStaticModule`) and how the `vite build` output is wired into the Dockerfile/compose stage.
- Precise ONBOARDING section ordering and README section ordering.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and requirements
- `.planning/ROADMAP.md` §"Phase 6: Optional Bonuses & Documentation" — goal, dependencies, and the 4 success criteria (note the Bonus-C pull-forward to Phase 5)
- `.planning/REQUIREMENTS.md` — API-01/API-02 (GraphQL query + mutation parity), FE-01/FE-02/FE-03 (React URL input, 2s polling, results/error display), DOC-01/DOC-02 (README + ONBOARDING)
- `.planning/PROJECT.md` — memory constraint (256MB / 150MB heap / 200m container), two-entrypoint design, "runnable from README alone", code-first GraphQL via MercuriusDriver, stream-json, Vite React bonus, evaluation criteria priority order

### Prior phase contracts (the seams the bonuses/docs build on)
- `.planning/phases/05-packaging-ops-assignment-acceptance/05-CONTEXT.md` — Bonus C already delivered here (D-04), docker-compose/Dockerfile design, Trivy socket-mount trade-off (D-06), the self-test honesty story (D-10), the memory-margin tuning (D-07) — all referenced by README/ONBOARDING
- `.planning/phases/04-required-rest-api-runtime-lifecycle/04-CONTEXT.md` — REST contract (`POST /api/scan`, `GET /api/scan/:scanId`, `/health`), response DTO shapes, thin-controller (ARCH-01) pattern the GraphQL resolver mirrors
- `.planning/phases/03-scan-engine-adapters-queue-worker-service/03-CONTEXT.md` — `ScanService` + `ScanRepository` seam, `ScanStatus` transitions, cleanup + bounded error reasons (ONBOARDING error-handling topic)
- `.planning/phases/02-streaming-parse-pipeline-memory-proof/02-CONTEXT.md` — the streaming parser + memtest/fixture (ONBOARDING memory + streaming topics; README 500MB proof)

### Existing implementation seams (read before writing code)
- `apps/api/src/scan/scan.service.ts` — `enqueue(repoUrl): Promise<Scan>` (:34) and `get(id): Promise<Scan|null>` (:55) — the exact methods the GraphQL resolver delegates to (D-02)
- `apps/api/src/domain/vulnerability.types.ts` — the stored `Vulnerability` shape (`vulnerabilityId`, `pkgName`, `installedVersion`, `severity`, `title`, `primaryUrl`) — authoritative field list for the results table; **no `fixedVersion`** (D-08)
- `apps/api/src/domain/scan.types.ts` — `Scan` + `ScanStatus` enum (the four states the UI must render, D-07)
- `apps/api/src/app.module.ts` / `apps/api/src/index.ts` — where the GraphQL module (MercuriusDriver) and static-serving of the built React app are wired (D-02, D-04)
- `apps/api/src/http/scan.controller.ts` — the REST contract the GraphQL surface achieves parity with (D-06)
- `apps/api/package.json` — monorepo scripts; a new `apps/web` workspace + build wiring is added (D-04)
- `Dockerfile`, `docker-compose.yml` — the Phase 5 packaging the README documents and into which the `vite build` output is folded (D-04, D-12)

### Official external documentation
- `https://mercurius.dev/` — Mercurius Fastify plugin, GraphiQL toggle, error handling (D-02, D-05)
- `https://docs.nestjs.com/graphql/quick-start` — NestJS code-first GraphQL with `MercuriusDriver` (D-02)
- `https://vitejs.dev/guide/` — Vite React app scaffold + `vite build` static output (D-03, D-04)
- `https://tailwindcss.com/docs/installation` — Tailwind setup in a Vite React app (D-07)
- `https://github.com/OWASP/NodeGoat` — the forked scan-demo target named in criterion #3 (D-15)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`ScanService.enqueue` / `ScanService.get`** are the ready-made delegation targets — the GraphQL resolver is a thin adapter over them, exactly like `scan.controller.ts` (D-02).
- **`Vulnerability` + `Scan`/`ScanStatus` domain types** already define everything the UI and GraphQL type need — reuse them; do not invent new fields (D-08).
- **The REST contract + response DTOs** (`apps/api/src/http/dto/scan-response.ts`) define the shape the GraphQL surface must reach parity with (D-06).
- **All Phase 1–5 CONTEXT.md files** already record the rejected-alternative rationales the ONBOARDING harvests — this is documentation, not re-derivation (D-10, D-11).

### Established Patterns
- **Thin controller / shared Service (ARCH-01):** the GraphQL resolver follows the same "no logic in the edge, delegate to `ScanService`" pattern as the REST controller.
- **One Fastify process:** REST + GraphQL (+ static UI) share a single listener/port — no second server, protecting the graded RSS budget.
- **Compiled-`dist` + `node:test` for BullMQ-touching tests** (the `@nestjs/bullmq`/@swc Jest landmine) — any new integration coverage for GraphQL-through-the-worker must respect this.

### Integration Points
- `app.module.ts` gains the `GraphQLModule.forRoot(MercuriusDriver, …)` registration and the static-serving of `apps/web/dist` (D-02, D-04).
- `apps/web` is a NEW workspace; its `vite build` output must be produced before/inside the Docker image build and served by the API (D-04, D-12).
- README/ONBOARDING reference Phase 5's docker-compose, socket-mount, and self-test-honesty decisions verbatim — keep them consistent, don't restate differently.

</code_context>

<specifics>
## Specific Ideas

- The React app is the reviewer's first *visual* impression and is served from the API as the live demo — finish quality (all states handled) matters more than styling weight.
- GraphiQL at `/graphiql` doubles as a self-serve demo of Bonus B for a reviewer who prefers the API over the UI.
- ONBOARDING should read like interview prep: each topic ends with the question a skeptical senior reviewer would actually ask, answered.
- README's trust signal is the honest `index.js`-vs-`worker.js` self-test explanation — lead into it rather than hiding it.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 6-Optional Bonuses & Documentation*
*Context gathered: 2026-07-11*
