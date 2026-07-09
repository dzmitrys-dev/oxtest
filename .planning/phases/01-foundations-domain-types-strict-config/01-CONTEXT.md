# Phase 1: Foundations, Domain Types & Strict Config - Context

**Gathered:** 2026-07-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver a strictly-typed NestJS 11 (Fastify adapter) skeleton that boots BOTH entrypoints (API + worker) and refuses to run on invalid config. Scope: repo/workspace structure, TypeScript strict config, the two-entrypoint module topology, boot-time env validation, and the framework-free domain type layer. Covers requirements TYPE-01, TYPE-02, ARCH-04, OPS-03.

**In scope:** monorepo scaffold, strict `tsconfig`, `AppModule`/`WorkerModule` sharing `ScanModule`, both entrypoints booting, Joi env validation, domain interfaces (`Scan`, `Vulnerability`, `ScanStatus`) + minimal Trivy report types.
**Out of scope (later phases):** the stream parser (Phase 2), clone/Trivy/queue/worker logic (Phase 3), REST/GraphQL surface (Phase 4), docker/CI (Phase 5), React frontend (Phase 6). Modules/services created now are skeletons/stubs — no business logic.
</domain>

<decisions>
## Implementation Decisions

### Repo / Workspace Structure
- **D-01:** Monorepo via **npm workspaces** with `apps/api` (NestJS backend) and `apps/web` (React frontend, populated in Phase 6). One root `npm install`; each app gets its own Dockerfile in Phase 5.
- **D-02:** The assignment's self-test command `node --max-old-space-size=150 dist/index.js` becomes **`apps/api/dist/index.js`** under the workspace. This path shift MUST be documented prominently in README (DOC-01) so a reviewer's copy-paste works — the entry file is still named `index.ts` (not `main.ts`) to keep the `dist/index.js` basename the assignment expects.

### Domain Type Strategy
- **D-03:** Source-of-truth domain types are **plain framework-free TS interfaces/enums** (`Scan`, `Vulnerability`, `ScanStatus`) in a domain layer. GraphQL `@ObjectType()` classes in Phase 4 will implement/map to these — the domain stays pure and the worker never imports GraphQL decorator metadata (protects the layering grade + worker heap budget).
- **D-04:** Trivy report typing is **minimal — only the path we actually parse and surface**: `Results[].Vulnerabilities[]` with the CRITICAL-relevant fields (e.g. `VulnerabilityID`, `PkgName`, `InstalledVersion`, `Severity`, `Title`, `PrimaryURL`). Do NOT model Trivy's full report schema — unused fields are maintenance surface for zero functional gain since we only read CRITICAL vulns.

### Runtime (Node vs Bun — evaluated)
- **D-4b:** **Node.js, not Bun.** (Confidence very high.) `--max-old-space-size` is a V8-only flag; Bun runs on JavaScriptCore and treats it as a no-op — running on Bun would silently DISABLE the exact 150MB heap gate the assignment grades on and break the reviewer's copy-paste self-test. Bun's baseline RSS win (~25MB vs ~55MB) shrinks to ~15% under load and is undercut by a JSC/mimalloc page-retention bug (oven-sh/bun#27514) that makes RSS non-deterministic under `mem_limit:200m` (flaky exit-137 risk). BullMQ also lacks `Bun.redis` support (forces flaky ioredis-on-Bun path). Turn this into points: a one-line "considered and rejected" note in README/ONBOARDING (DOC-01/DOC-02) — "Bun has lower baseline RSS but doesn't honor `--max-old-space-size`, so it can't enforce the 150MB heap contract this assignment grades on — Node kept deliberately." Pin Node LTS in `engines` + `.nvmrc`.

### Scaffold Approach
- **D-05:** Scaffold with **`nest new`** (idiomatic structure + Jest/eslint/prettier), then **swap `@nestjs/platform-express` → `@nestjs/platform-fastify`** and remove Express traces. Rationale: reviewer-familiar NestJS conventions. NOTE for planner: `nest new` produces a standalone project; it must be adapted into the `apps/api` workspace package and its single-entrypoint default restructured into the two-entrypoint layout (D-06). Verify no residual Express-only deps/middleware remain after the swap.

### Entrypoint Layout
- **D-06:** **Shared `ScanModule`, separate root modules.** `src/index.ts` → `AppModule` (imports `ScanModule` + HTTP/GraphQL transports) via `NestFactory.create(AppModule, FastifyAdapter)` + `listen()`. `src/worker.ts` → `WorkerModule` (imports `ScanModule` + BullMQ only, **NO GraphQL/HTTP**) via `NestFactory.createApplicationContext(WorkerModule)` — no HTTP listener. Domain/service code shared; transport deps isolated per entrypoint so the worker container carries no dead HTTP/GraphQL heap.

### Claude's Discretion
- Exact `tsconfig` flags beyond the mandated `strict: true` + `noUncheckedIndexedAccess` (e.g. `verbatimModuleSyntax`, `noImplicitOverride`, module resolution) — planner/researcher decides per NestJS 11 conventions.
- Precise set of required env vars in the Joi schema (planner derives from downstream needs; at minimum expect `REDIS_HOST`, `REDIS_PORT`, `PORT`, a workspace/temp dir, and a Trivy-mode toggle) — the mechanism (Joi via `@nestjs/config`, fail-fast non-zero exit) is locked; the exact keys are discretion.
- Test runner: Jest (nest default) retained unless a concrete reason to switch; `@swc/jest` for speed per research.
- Directory naming within `apps/api/src` (e.g. `domain/`, `modules/`, `config/`).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project planning docs
- `.planning/PROJECT.md` — Core value (memory pass/fail), constraints, Key Decisions (NestJS/Fastify, two entrypoints)
- `.planning/REQUIREMENTS.md` §TYPE, §ARCH, §OPS — the four requirements this phase covers (TYPE-01, TYPE-02, ARCH-04, OPS-03)
- `.planning/ROADMAP.md` §"Phase 1" — goal + 4 success criteria

### Research (read the STACK DECISION UPDATE banners — framework is NestJS, not raw Fastify)
- `.planning/research/STACK.md` — NestJS 11 package versions, strict tsconfig recommendation, `@nestjs/config`+Joi, Fastify adapter caveats
- `.planning/research/ARCHITECTURE.md` — layering (Controller/Service/Worker + adapters), two-entrypoint topology, `createApplicationContext` worker pattern
- `.planning/research/PITFALLS.md` — heap-vs-RSS distinction, worker must not load GraphQL, `--max-old-space-size` must be explicit
- `.planning/research/SUMMARY.md` — consolidated; STACK DECISION UPDATE at top pins the NestJS stack + two-entrypoint model

### Assignment source
- `Senior Backend Engineer Assignment_ The Supply Chain Scanner (1) (3).pdf` (repo root) — the graded spec; note the literal `dist/index.js` self-test the D-02 path caveat addresses

No external ADRs — decisions fully captured above.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- None — greenfield. No `package.json`, no `src/` yet. Only `.planning/` and `.claude/` scaffolding exist.

### Established Patterns
- None yet. This phase ESTABLISHES the patterns (layering, module topology, type layer) that Phases 2–6 build on.

### Integration Points
- `ScanModule` is the shared seam every later phase plugs into (parser adapter, worker processor, service, controllers/resolvers). Its skeleton shape decided here constrains all downstream wiring.
</code_context>

<specifics>
## Specific Ideas

- Entry file basename must stay `index.ts` → `dist/index.js` to honor the assignment's self-test verbatim (modulo the `apps/api/` prefix documented in README).
- Worker entrypoint (`worker.ts`) deliberately excludes GraphQL/HTTP to keep its container heap minimal under the 200MB limit — this is an intentional, defensible memory decision to call out in ONBOARDING.md.
</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. (Frontend structure surfaced but is correctly Phase 6; the workspace layout that accommodates it is decided here, the frontend code itself is not.)
</deferred>

---

*Phase: 1-Foundations, Domain Types & Strict Config*
*Context gathered: 2026-07-09*
