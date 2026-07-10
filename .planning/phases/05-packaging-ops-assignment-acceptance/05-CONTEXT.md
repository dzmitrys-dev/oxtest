# Phase 5: Packaging, Ops & Assignment Acceptance - Context

**Gathered:** 2026-07-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Make the already-built required backend (Phases 1–4) demonstrably submission-ready. This phase delivers four things:

1. **scanId-correlated structured logging (OPS-04)** — log lines from both the API and the worker carry the `scanId` so a single scan's lifecycle is traceable across the two processes.
2. **CI-gated test suite (OPS-05)** — lint + type-check + parser/adapter/worker unit tests + the REST contract test all run in CI and fail the build on any failure; the existing Node 22 memory proof stays a required gate.
3. **The assignment-level end-to-end acceptance gate** — a runnable command proving `POST /api/scan → Queued → worker scan → poll → CRITICAL results`, with clone/report cleanup verified after both success and forced failure, plus the two-part reconciliation of the PDF's verbatim `node --max-old-space-size=150 dist/index.js` self-test with the fact that the 500MB+ parse actually runs in `dist/worker.js`.
4. **Docker packaging (scope pulled forward — see D-04)** — `docker-compose.yml` (redis + api + worker) with `mem_limit: 200m` + `--max-old-space-size=150`, lean multi-stage Dockerfiles, and an in-container `OOMKilled: false` proof against the largest fixture.

**This phase does NOT add:** GraphQL (Bonus B, Phase 6), the React frontend (Bonus A, Phase 6), or README/ONBOARDING documentation (DOC-01/02, Phase 6). It reuses the Phase 1–4 contracts unchanged (`ScanService`, `ScanRepository`, the `EngineLogger` port, the two-entrypoint topology, `/health`, graceful shutdown) and must not alter engine/parser/worker behavior beyond adding the logging seam and the three folded Phase-4 hardening fixes.

**Requirements:** OPS-04, OPS-05 (phase-assigned) + OPS-01, OPS-02 pulled forward from Phase 6 Bonus C (see D-04).

</domain>

<decisions>
## Implementation Decisions

### Logging correlation (OPS-04)
- **D-01:** Structured logging is implemented as a **pino adapter that satisfies the existing `EngineLogger` port** (`apps/api/src/engine/scan-engine.ts:26`). pino stays out of the domain engine — the adapter is injected via the DI seam already in place. No `nestjs-pino`/`nestjs-cls`/ALS library: `AsyncLocalStorage` cannot cross the Redis queue boundary anyway, and the engine already receives an injected logger, so a per-job child logger is the leanest, most explainable route.
- **D-02:** The **`scanId` correlation propagates via the job payload** (already `ScanJob = { scanId, repoUrl }`), NOT via ALS. At the very top of the worker's `process(job)`, construct a **`pino.child({ scanId })`** and pass it as the engine's `deps.logger`; every downstream `EngineLogger` call then resolves the same `scanId`. On the API side, the enqueue log line carries the `scanId` too.
- **D-03:** **Widen the `EngineLogger` port** to add `info` (and optionally `debug`) alongside `warn`/`error`, updating the noop default and every adapter in one deliberate change. This lets each lifecycle transition (`Queued → Scanning → Finished`, clone/Trivy/parse steps) emit a `scanId`'d line — required for criterion #3 (trace a scan across both processes).
- **D-04b (format):** **Newline-delimited JSON always** in container/CI/prod; `pino-pretty` is dev-only behind a flag/`NODE_ENV`. Include pino defaults `pid`/`hostname` plus `scanId` so lines from the two processes are distinguishable yet joinable. **Never ship a pino transport (pretty-print) into the container** — transports spawn a worker thread and add RSS under the very limit being proven.
- **D-Fastify:** Configure pino **once** via `LoggerModule.forRoot(...)`; do NOT also set `useExisting: true` + a logger on the FastifyAdapter (documented silent-fallback trap — Fastify ships its own pino).

### Docker packaging scope & sequencing (OPS-01/02, criterion #2)
- **D-04:** **Build the full Docker stack in Phase 5** — `docker-compose.yml` with `redis` + `api` + `worker`, lean multi-stage Dockerfiles, `mem_limit: 200m`, worker `CMD` = `node --max-old-space-size=150 dist/worker.js`, API `CMD` = `dist/index.js` (matches the self-test command), and the in-container `OOMKilled: false` proof. This satisfies criterion #2 directly and matches the phase name "Packaging." **OPS-01 and OPS-02 are pulled forward from Phase 6 Bonus C into Phase 5** — ROADMAP.md and REQUIREMENTS.md traceability must be re-mapped to reflect this (Phase 6 becomes docs + GraphQL + React only).
- **D-05:** **Base image `node:22-slim`, multi-stage, non-root `node` user.** Builder stage installs full deps + runs `tsc`; runtime stage copies `dist/` + `npm ci --omit=dev`. Rationale over alpine (musl can inflate RSS — bad when RSS is graded) and distroless (no shell — breaks the acceptance shell-out and Trivy fallback).
- **D-06:** **Trivy is NOT baked into the image.** The worker invokes the pinned `ghcr.io/aquasecurity/trivy:0.69.3` via the **existing local-detect + Docker-fallback adapter**, using a **host Docker socket mount** (`/var/run/docker.sock`) so the worker runs Trivy as a sibling container. The socket-mount trade-off (grants the container Docker control) must be documented in ONBOARDING (Phase 6). Keeps the app image lean.
- **D-07 (memory margin):** Keep `--max-old-space-size=150` (75% of the 200m limit — nodebestpractices' safe low end; the flag deliberately overrides Node 22's ~100MB container-aware default). **Empirically verify peak RSS in-container** against the largest fixture (STATE.md's standing Phase-5 tuning flag — bare-node self-test is insufficient). If in-container RSS creeps toward ~190m, **lower to `--max-old-space-size=128`** rather than raising `mem_limit`, to keep proving the constraint. The `concurrency:1` invariant and bounded stream buffers are load-bearing, not incidental.

### Acceptance gate shape (criteria #1 & #5)
- **D-08:** The acceptance command is a **`node:test` `.mjs` harness fronted by an npm script** (e.g. `test:acceptance`), consistent with the established compiled-`dist` + `node:test` pattern (`scan-engine-integration.mjs`, `api-integration.mjs`) that dodges the `@swc/core` + `@nestjs/bullmq` Jest landmine.
- **D-09:** It runs against **compiled `dist/index.js` + `dist/worker.js`, a disposable Redis, and the pinned Docker Trivy** — proving `POST → Queued → worker scan → poll → CRITICAL results` end-to-end AND verifying **clone/report cleanup after both success and forced failure** (criterion #1). It is **feasibility-gated** where Docker is unavailable (record a skip-reason, don't fail closed on an infeasible runner).
- **D-10 (criterion #5, two-part proof):**
  - (a) Assert **`dist/index.js` boots cleanly** under `node --max-old-space-size=150` — the PDF's literal command.
  - (b) Prove the **500MB+ parse under the same 150MB ceiling in the worker path** — reuse the Phase 2 `memtest` against the parser as it runs in `dist/worker.js`.
  - README (Phase 6) documents this mapping honestly: the literal self-test names `index.js`, but the memory-critical work lives in `worker.js`.

### CI gating strategy (OPS-05, criterion #4)
- **D-11:** **Extend `scan-engine.yml`** to add the REST-contract and acceptance jobs (reusing its always-required-contract + feasibility-gated-integration structure), and **update `.github/CI-CONTRACT.md`** accordingly. **Keep `memory.yml`** as the separate, always-required Node-22 memory proof. Wire the currently-ungated `test:api:integration` harness into CI (it exists but runs nowhere today).
- **D-12 (tiered required-status):** Docker-free checks (lint, typecheck, unit parser/adapter tests, process-safety contract) = **always-required**. Redis/Docker/Trivy-backed jobs (`api-integration`, acceptance, in-container OOM proof) = **feasibility-gated: required-when-they-run, skipped-with-recorded-reason otherwise** — mirroring the proven `scan-engine-contract` / `scan-engine-integration` split. Never treat an unknown/infeasible state as success (fail the probe closed on unexpected errors).
- **D-13 (fold Phase-4 review warnings):** Address the **3 non-blocking `04-REVIEW.md` warnings** as a small Phase-5 hardening task — they are packaging/ops-adjacent:
  1. URL pipe raw-string forwarding,
  2. `SHUTDOWN_GRACE_MS` max vs Docker's 10s stop window (matters directly for the compose shutdown story),
  3. missing `REDIS_CLIENT` error listener (matters for compose/reconnect resilience).

### Claude's Discretion
- Exact file names/layout for the pino adapter, the acceptance harness, and the Dockerfiles.
- Whether the in-container OOM proof lives inside the acceptance harness or a dedicated compose-driven CI step, provided it asserts **both** `OOMKilled == false` **and** exit code 0 (guard the "137 with OOMKilled:false" false-negative) and surfaces peak RSS/heapUsed.
- Log level defaults, the precise `scanId`-bound field set beyond `scanId`/`pid`, and whether `debug` is added now or later.
- Compose healthcheck wiring against `/health` (which already returns 503-on-Redis-down by design), `.dockerignore` contents, and image-size targets.
- Whether the acceptance gate reuses `memtest.js` as-is for the worker-side 500MB proof or runs it through a booted `dist/worker.js`.
- Exact CI job names/topology within the extend-`scan-engine.yml` decision, provided CI-CONTRACT.md stays the reviewable source of truth.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and requirements
- `.planning/ROADMAP.md` §"Phase 5: Packaging, Ops & Assignment Acceptance" — phase goal, dependencies, and the 5 success criteria (note the OPS-01/02 pull-forward in D-04)
- `.planning/REQUIREMENTS.md` §OPS — OPS-04 (scanId log correlation), OPS-05 (test suite + CI), and OPS-01/OPS-02 (docker-compose + end-to-end via `docker compose up`, pulled forward per D-04)
- `.planning/PROJECT.md` — memory constraint (256MB / 150MB heap / 200m container), two-entrypoint design, Trivy local-detect+Docker-fallback decision, Node 22 pin, "runnable from README alone"
- `.planning/STATE.md` — the `@nestjs/bullmq`+`@swc` Jest landmine, the standing Phase-5 in-container RSS tuning flag, and the 04-REVIEW warnings

### Prior phase contracts (the seams Phase 5 packages/instruments)
- `.planning/phases/04-required-rest-api-runtime-lifecycle/04-CONTEXT.md` — `/health` 503-on-Redis-down (D-09) for the compose healthcheck, `SHUTDOWN_GRACE_MS` under the 10s Docker window (D-12), the compiled-dist + `node:test` integration pattern (code_context), response DTO shapes
- `.planning/phases/03-scan-engine-adapters-queue-worker-service/03-CONTEXT.md` — `EngineLogger` port, `ScanJob = { scanId, repoUrl }` payload, `try/finally` cleanup (D-23), bounded `{category, detail}` failure reason, worker `concurrency:1`, Trivy adapter local-detect+fallback
- `.planning/phases/02-streaming-parse-pipeline-memory-proof/02-CONTEXT.md` — the `memtest` and fixture generator reused for the criterion #5 worker-side 500MB proof

### Existing implementation seams (read before writing code)
- `apps/api/src/engine/scan-engine.ts` — `EngineLogger` port (lines 26–38, 55, 84–94) to widen (D-03) and back with a pino adapter (D-01)
- `apps/api/src/engine/scan-worker.ts` — per-job `process(job)` entry point where `pino.child({ scanId })` is established (D-02)
- `apps/api/src/worker.ts` / `apps/api/src/worker.module.ts` — worker-only `createApplicationContext` topology (no HTTP lifecycle — pino context is manual, D-02)
- `apps/api/src/engine/adapter-factory.ts` — where the pino-backed `EngineLogger` adapter is wired in
- `apps/api/package.json` — scripts (`build`, `start:api`, `start:worker`, existing `test:*:integration`); add `test:acceptance` (D-08)
- `.github/workflows/scan-engine.yml` — extend with REST-contract + acceptance jobs (D-11)
- `.github/workflows/memory.yml` — keep as the always-required Node-22 memory gate (D-11)
- `.github/CI-CONTRACT.md` — the reviewable required-status source of truth to update (D-11/D-12)
- `scripts/api-integration.mjs`, `scripts/scan-engine-integration.mjs`, `scripts/scan-engine-feasibility.mjs`, `scripts/memtest.ts` — harness/probe patterns the acceptance gate and CI extension reuse
- `.planning/phases/04-required-rest-api-runtime-lifecycle/04-REVIEW.md` — the 3 warnings folded in D-13

### Official external documentation
- `https://github.com/iamolegga/nestjs-pino` — pino + Nest integration and the Fastify double-pino trap (D-Fastify)
- `https://getpino.io/` — pino child loggers, JSON output, transport-in-worker-thread caveat (D-04b)
- `https://developers.redhat.com/articles/2025/10/10/nodejs-20-memory-management-containers` — Node 20+ cgroup heap auto-derivation and how `--max-old-space-size` overrides it (D-07)
- `https://github.com/goldbergyoni/nodebestpractices/blob/master/sections/docker/memory-limit.md` — heap-to-container-limit ratio guidance (D-07)
- `https://docs.docker.com/reference/cli/docker/container/inspect/` — `State.OOMKilled` assertion for the container memory proof (D-09)
- `https://docs.bullmq.io/guide/workers` — worker `process(job)` lifecycle (D-02)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`EngineLogger` port** is the ready-made injection seam for structured logging — a pino adapter satisfies it with zero pino imports in the domain engine (D-01).
- **`ScanJob = { scanId, repoUrl }`** already carries the correlation id across the Redis hop — no payload change needed for OPS-04 (D-02).
- **Trivy adapter** already does local-detect + pinned-Docker-fallback — the compose socket-mount (D-06) reuses this code path unchanged.
- **`node:test` compiled-dist harnesses** (`api-integration.mjs`, `scan-engine-integration.mjs`) and the **feasibility probe** are the templates for the acceptance gate and CI extension.
- **`memtest` + fixture generator** (Phase 2) are reused verbatim for the criterion #5 worker-side 500MB proof (D-10).
- **`/health` returns 503-on-Redis-down** by design — the compose healthcheck keys off it directly.

### Established Patterns
- Hexagonal ports (`EngineLogger`, `RepoCloner`, `TrivyRunner`, `ReportParser`, `ScanRepository`) — add the pino adapter as another adapter, don't touch the engine's core logic.
- Compiled-`dist` + `node:test` for anything touching `@nestjs/bullmq` (Jest landmine); never import the BullMQ-wired module into Jest.
- Tiered CI: Docker-free = always-required; Docker/Redis-backed = feasibility-gated, required-when-run, fail-closed-on-unknown. CI-CONTRACT.md is the in-repo source of truth.
- Joi-validated fail-closed env config — extend if a logging/level env var is added.

### Integration Points / Constraints
- **Jest landmine (STATE.md):** `@nestjs/bullmq` in the Jest module graph triggers an `@swc/core` miette panic on Node 22 AND 24. All BullMQ-touching tests run against compiled `dist` under `node:test`.
- **Memory margin is tight (150/200 = 75%):** any RSS-increasing change (larger highWaterMark, concurrency > 1, extra native deps, a shipped pino transport) risks a real OOM-kill that would read as a memory-proof regression. Verify in-container, not just bare-node.
- **`SHUTDOWN_GRACE_MS` must stay under Docker's 10s SIGTERM→SIGKILL window** — the compose story inherits Phase 4's bounded drain; D-13 folds the review warning about its max bound.
- **`OOMKilled` alone is a false-negative risk:** assert exit code 0 too (137-with-OOMKilled:false).

</code_context>

<specifics>
## Specific Ideas

- pino logs must be **greppable by scanId** across both processes: `... | jq 'select(.scanId=="<id>")'` should reconstruct one scan's full lifecycle from interleaved API + worker output.
- Docker CMDs are deliberate: worker = `node --max-old-space-size=150 dist/worker.js` (the memory-critical process), API = `dist/index.js` (matches the PDF's verbatim self-test command).
- The acceptance gate must exercise a **forced-failure path** (not just the happy path) to prove cleanup on failure — reuse Phase 3's forced clone/Trivy/disk/parser failure hooks.
- Traceability honesty: because OPS-01/02 are pulled forward (D-04), update ROADMAP.md + REQUIREMENTS.md so Phase 6 no longer claims them and the coverage map stays accurate.

</specifics>

<deferred>
## Deferred Ideas

- **GraphQL `scan` query + enqueue mutation** (API-01/API-02) — Phase 6 / Bonus B; must reuse this same `ScanService` and the `criticalVulnerabilities` field name.
- **React (Vite) polling frontend** (FE-01..03) — Phase 6 / Bonus A.
- **README.md + ONBOARDING.md** (DOC-01/02) — Phase 6; README documents the D-10 self-test mapping, the D-06 socket-mount trade-off, and the copy-paste acceptance command.
- **CORS for the frontend** — Phase 6, only if served from a different origin.
- **`--max-semi-space-size` / young-gen tuning** — unnecessary now; only if in-container RSS profiling shows young-gen pressure (D-07).
- **Rate limiting / auth / request-dedup** — out of scope (v2 / Out-of-Scope in REQUIREMENTS.md).

None — discussion stayed within phase scope (Docker pull-forward is a resequencing of already-planned capability, not new scope).

</deferred>

---

*Phase: 5-Packaging, Ops & Assignment Acceptance*
*Context gathered: 2026-07-10*
