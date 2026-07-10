# Phase 5: Packaging, Ops & Assignment Acceptance - Research

**Researched:** 2026-07-10
**Domain:** Node/NestJS containerization, structured logging correlation, CI gating, end-to-end acceptance proof — packaging an already-built service
**Confidence:** HIGH (codebase is the primary source; all seams read directly; external facts verified or cited)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Logging correlation (OPS-04)**
- **D-01:** Structured logging is a **pino adapter satisfying the existing `EngineLogger` port** (`apps/api/src/engine/scan-engine.ts:26`). pino stays out of the domain engine; injected via the existing DI seam. No `nestjs-pino`/`nestjs-cls`/ALS library — ALS cannot cross the Redis queue boundary and the engine already receives an injected logger.
- **D-02:** `scanId` correlation **propagates via the job payload** (`ScanJob = { scanId, repoUrl }`), NOT via ALS. At the top of the worker's `process(job)`, construct a **`pino.child({ scanId })`** and pass it as `deps.logger`. On the API side, the enqueue log line also carries the `scanId`.
- **D-03:** **Widen the `EngineLogger` port** to add `info` (and optionally `debug`) alongside `warn`/`error`; update the noop default and every adapter in one change. Each lifecycle transition emits a `scanId`'d line.
- **D-04b (format):** **Newline-delimited JSON always** in container/CI/prod; `pino-pretty` is dev-only behind a flag/`NODE_ENV`. Include pino defaults `pid`/`hostname` plus `scanId`. **Never ship a pino transport (pretty-print) into the container** — transports spawn a worker thread and add RSS under the very limit being proven.
- **D-Fastify:** Configure pino **once**; do NOT also set `useExisting: true` + a logger on the FastifyAdapter (documented silent-fallback trap — Fastify ships its own pino).

**Docker packaging scope & sequencing (OPS-01/02, criterion #2)**
- **D-04:** **Build the full Docker stack in Phase 5** — `docker-compose.yml` with `redis` + `api` + `worker`, lean multi-stage Dockerfiles, `mem_limit: 200m`, worker `CMD` = `node --max-old-space-size=150 dist/worker.js`, API `CMD` = `dist/index.js`, and the in-container `OOMKilled: false` proof. **OPS-01 and OPS-02 are pulled forward from Phase 6 Bonus C into Phase 5** — ROADMAP.md and REQUIREMENTS.md traceability must be re-mapped (Phase 6 becomes docs + GraphQL + React only).
- **D-05:** **Base image `node:22-slim`, multi-stage, non-root `node` user.** Builder stage installs full deps + runs `tsc`; runtime stage copies `dist/` + `npm ci --omit=dev`. Rationale over alpine (musl inflates RSS) and distroless (no shell — breaks acceptance shell-out and Trivy fallback).
- **D-06:** **Trivy is NOT baked into the image.** The worker invokes the pinned `ghcr.io/aquasecurity/trivy:0.69.3` via the existing local-detect + Docker-fallback adapter, using a **host Docker socket mount** (`/var/run/docker.sock`) so the worker runs Trivy as a sibling container. Socket-mount trade-off documented in ONBOARDING (Phase 6).
- **D-07 (memory margin):** Keep `--max-old-space-size=150` (75% of 200m). **Empirically verify peak RSS in-container** against the largest fixture. If in-container RSS creeps toward ~190m, **lower to `--max-old-space-size=128`** rather than raising `mem_limit`. The `concurrency:1` invariant and bounded stream buffers are load-bearing.

**Acceptance gate shape (criteria #1 & #5)**
- **D-08:** Acceptance command is a **`node:test` `.mjs` harness fronted by an npm script** (e.g. `test:acceptance`), consistent with the compiled-`dist` + `node:test` pattern.
- **D-09:** Runs against **compiled `dist/index.js` + `dist/worker.js`, a disposable Redis, and the pinned Docker Trivy** — proving `POST → Queued → worker scan → poll → CRITICAL results` AND verifying **clone/report cleanup after both success and forced failure**. **Feasibility-gated** where Docker is unavailable (record a skip-reason, don't fail closed on an infeasible runner).
- **D-10 (criterion #5, two-part proof):** (a) Assert `dist/index.js` **boots cleanly** under `node --max-old-space-size=150` (the PDF's literal command). (b) Prove the **500MB+ parse under the same 150MB ceiling in the worker path** — reuse the Phase 2 `memtest`. README (Phase 6) documents the mapping honestly.

**CI gating strategy (OPS-05, criterion #4)**
- **D-11:** **Extend `scan-engine.yml`** to add REST-contract and acceptance jobs (reusing its always-required-contract + feasibility-gated-integration structure); **update `.github/CI-CONTRACT.md`**. **Keep `memory.yml`** as the separate always-required Node-22 memory proof. Wire the currently-ungated `test:api:integration` harness into CI.
- **D-12 (tiered required-status):** Docker-free checks (lint, typecheck, unit parser/adapter tests, process-safety contract) = **always-required**. Redis/Docker/Trivy-backed jobs = **feasibility-gated: required-when-they-run, skipped-with-recorded-reason otherwise**. Never treat an unknown/infeasible state as success (fail the probe closed on unexpected errors).
- **D-13 (fold Phase-4 review warnings):** Address the 3 non-blocking `04-REVIEW.md` warnings as a small Phase-5 hardening task: (1) URL pipe raw-string forwarding, (2) `SHUTDOWN_GRACE_MS` max vs Docker's 10s stop window, (3) missing `REDIS_CLIENT` error listener.

### Claude's Discretion
- Exact file names/layout for the pino adapter, the acceptance harness, and the Dockerfiles.
- Whether the in-container OOM proof lives inside the acceptance harness or a dedicated compose-driven CI step, provided it asserts **both** `OOMKilled == false` **and** exit code 0 (guard the "137 with OOMKilled:false" false-negative) and surfaces peak RSS/heapUsed.
- Log level defaults, the precise `scanId`-bound field set beyond `scanId`/`pid`, and whether `debug` is added now or later.
- Compose healthcheck wiring against `/health`, `.dockerignore` contents, and image-size targets.
- Whether the acceptance gate reuses `memtest.js` as-is for the worker-side 500MB proof or runs it through a booted `dist/worker.js`.
- Exact CI job names/topology within the extend-`scan-engine.yml` decision, provided CI-CONTRACT.md stays the reviewable source of truth.

### Deferred Ideas (OUT OF SCOPE)
- GraphQL `scan` query + enqueue mutation (API-01/API-02) — Phase 6 / Bonus B.
- React (Vite) polling frontend (FE-01..03) — Phase 6 / Bonus A.
- README.md + ONBOARDING.md (DOC-01/02) — Phase 6.
- CORS for the frontend — Phase 6.
- `--max-semi-space-size` / young-gen tuning — only if in-container RSS profiling shows young-gen pressure.
- Rate limiting / auth / request-dedup — v2 / Out-of-Scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| OPS-04 | Structured logging correlates log lines to a `scanId` across API and worker | pino adapter behind existing `EngineLogger` port (D-01); `pino.child({ scanId })` per job (D-02); port widened to `info` (D-03). Seams identified: `scan-engine.ts`, `scan-worker.ts`, `worker.module.ts`, `adapter-factory.ts`, `app.module.ts`, `scan.service.ts`. pino already resident (transitive of Fastify). |
| OPS-05 | Automated test suite (parser unit + scan API contract integration); CI runs lint + type-check + tests | Existing jest unit suites + 4 `node:test` `.mjs` harnesses map directly. CI extension pattern proven in `scan-engine.yml`; `test:api:integration` exists but runs nowhere today (must be wired). |
| OPS-01 *(pulled forward)* | `docker-compose.yml` (`redis`, `api`, `worker`); worker sets `mem_limit: 200m` + `node --max-old-space-size=150 dist/worker.js` | Multi-stage `node:22-slim` Dockerfile (D-05); compose topology w/ `mem_limit` (verified: correct for `docker compose up`); Docker socket mount for Trivy (D-06). No Docker artifacts exist yet — greenfield. |
| OPS-02 *(pulled forward)* | Full stack works end-to-end via `docker compose up` with no host-side Trivy/Redis | Compose healthcheck off existing `/health` (503-on-Redis-down); acceptance harness proves the flow (D-08/D-09). |
</phase_requirements>

## Summary

Phase 5 is a **packaging and proof** phase, not a feature-invention phase. The scan engine, REST API, worker, streaming parser, memory proof, and graceful shutdown all exist and are complete (Phases 1–4). This phase adds four seams on top of unchanged behavior: (1) a pino adapter behind the existing `EngineLogger` port so every lifecycle line carries `scanId`; (2) a CI extension that gates lint/typecheck/all test suites and keeps the Node-22 memory proof required; (3) a scripted end-to-end acceptance harness proving `POST → Queued → worker scan → poll → CRITICAL` plus cleanup on success and forced failure; and (4) the full Docker stack (`redis` + `api` + `worker`) that survives `mem_limit: 200m` under `--max-old-space-size=150` with `OOMKilled: false`.

The codebase is unusually well-prepared for this: the `EngineLogger` port is a ready-made injection seam (no pino imports in the domain engine), `pino@10.3.1` is **already resident** as a transitive dependency of Fastify (just needs a direct pin), the `ScanJob` payload already carries `scanId` across the Redis hop, the Trivy adapter already does local-detect + pinned-Docker-fallback, and there are four proven compiled-`dist` + `node:test` harnesses plus a feasibility probe to clone the CI/acceptance patterns from. The dominant risk is the memory margin (150/200 = 75%): any RSS-increasing change (a shipped pino transport, larger buffers, concurrency > 1) can turn the memory proof red inside the container even though the bare-node self-test passes — hence D-04b (no transport in-container) and D-07 (verify in-container, lower heap not raise limit).

**Primary recommendation:** Add `pino` as a direct dependency, implement the `EngineLogger` pino adapter and thread `pino.child({ scanId })` through the worker `process()`; author a multi-stage `node:22-slim` Dockerfile + `docker-compose.yml` using the top-level `mem_limit: 200m` key (NOT `deploy.resources`); build the `test:acceptance` `.mjs` harness by cloning `api-integration.mjs`; extend `scan-engine.yml` with the new gated jobs and keep `memory.yml` untouched; fold the three 04-REVIEW warnings as a small hardening task.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| scanId log correlation | Worker process (heavy lifecycle) | API process (enqueue line) | The worker owns the scan lifecycle where `scanId`-bound transitions happen; the API only emits the enqueue line. Both write ndjson to stdout — joinable by `scanId` via `jq`. |
| Structured log emission | Infrastructure adapter (pino behind `EngineLogger`) | — | Logging is an infrastructure concern; the domain engine stays pino-free (hexagonal port). |
| Container memory enforcement | Container runtime (`mem_limit`) + V8 flag (`--max-old-space-size`) | — | The 200m ceiling is a cgroup/OS concern; the 150MB heap flag is a runtime concern layered under it. |
| Trivy execution in-container | Host Docker daemon (sibling container via socket) | Worker process (spawns it) | Keeps the app image lean (D-06); reuses the existing local-detect+fallback adapter unchanged. |
| End-to-end acceptance | CI/test harness (`node:test` driving compiled `dist`) | Docker (disposable Redis + Trivy) | The harness orchestrates real processes; Docker supplies disposable infra. Feasibility-gated. |
| CI required-status policy | CI config (`scan-engine.yml` + `CI-CONTRACT.md`) | — | Tiered: Docker-free always-required, Docker-backed feasibility-gated. |

## Existing vs Required — Gap Map (the load-bearing section for this phase)

| Success Criterion | What EXISTS today | What Phase 5 must ADD | Files |
|---|---|---|---|
| **#1** End-to-end acceptance (POST→Queued→scan→poll→CRITICAL) + cleanup on success AND forced failure | `api-integration.mjs` already spawns real `dist/index.js` + `dist/worker.js` over disposable Redis, has `spawnApi`/`spawnWorker`/status observer/terminal poll/cleanup asserts, and exercises the `SCAN_ENGINE_TEST_FAULT` forced-failure seam. `test:api:integration` script exists. | A dedicated `test:acceptance` harness (or a promotion of `api-integration.mjs`) that asserts the **full REST happy path AND a forced-failure path** with cleanup verified on both, fronted by an npm script, and **wired into CI** (today it runs nowhere). | `scripts/api-integration.mjs`, `apps/api/package.json` |
| **#2** `docker compose up` (redis+api+worker), largest fixture survives `mem_limit:200m` + `--max-old-space-size=150`, `OOMKilled:false` | Nothing. No Dockerfile, no docker-compose.yml, no .dockerignore. Worker/API CMDs and heap flag decided but not encoded. | Multi-stage `Dockerfile` (`node:22-slim`, non-root), `docker-compose.yml` (`mem_limit:200m`, healthcheck off `/health`, socket mount for Trivy), `.dockerignore`, and an in-container OOM proof asserting `OOMKilled==false` AND exit 0. | new: `Dockerfile`, `docker-compose.yml`, `.dockerignore` |
| **#3** Log lines from API + worker carry `scanId`, traceable across processes | `EngineLogger` port exists (warn/error only). `worker.module.ts` injects a NestJS `Logger`-backed adapter (no scanId, not ndjson). `ScanJob` carries `scanId`. `worker.ts` uses `logger:false` (marker-first stdout). | pino adapter satisfying a **widened** `EngineLogger` (add `info`); `pino.child({ scanId })` established in `scan-worker.process()` and passed as `deps.logger`; enqueue line on API side; ndjson output; NO transport in-container. | `scan-engine.ts`, `scan-worker.ts`, `worker.module.ts`, `adapter-factory.ts`, `scan.service.ts`, `app.module.ts` |
| **#4** CI runs lint+typecheck+parser+adapter+worker+REST-contract tests, fails on any; Node-22 memory proof stays required | `scan-engine.yml` runs typecheck/lint/build/jest-unit/`scan-engine:contract`/feasibility-probe (always-required) + `scan-engine-integration` (feasibility-gated). `memory.yml` runs the Node-22 512MiB proof + flat-RSS sweep. `CI-CONTRACT.md` documents the two statuses. | Add REST-contract + acceptance jobs to `scan-engine.yml` (reuse the gated pattern); wire `test:api:integration`; update `CI-CONTRACT.md`. Keep `memory.yml` unchanged. | `.github/workflows/scan-engine.yml`, `.github/CI-CONTRACT.md` |
| **#5** `dist/index.js` boots clean under `--max-old-space-size=150` AND 500MB+ parse proven under 150MB in `dist/worker.js` path | `memtest.ts` + `gen-fixture.ts` + `memtest-sweep.ts` prove the parser standalone under 150MB. `memory.yml` runs the 512MiB proof. `api-integration.mjs` boots real `dist/index.js`. | (a) an explicit assertion that `dist/index.js` boots clean under the heap flag; (b) reuse the Phase 2 `memtest` as the honest worker-path 500MB proof. README (Phase 6) documents the index-vs-worker mapping. | `scripts/memtest.ts` (reuse), acceptance harness |

**Folded hardening (D-13):** WR-01 (URL pipe returns raw string, not canonical — `github-url.pipe.ts:31`); WR-02 (`SHUTDOWN_GRACE_MS` max 60000 > Docker 10s window — `env.validation.ts:51`, lower to ≤9000); WR-03 (no `error` listener on `REDIS_CLIENT` — `scan.module.ts:42-47`).

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| pino | 10.3.1 | Structured ndjson logging + `child({scanId})` correlation | `[VERIFIED: npm registry]` latest; 36.4M weekly downloads; official `pinojs/pino`. **Already resident** as Fastify's own logger dep (`fastify` requires `^9.14.0 \|\| ^10.1.0`) — adding a direct pin at `10.3.1` aligns with what NestJS/Fastify already loads, adding zero new RSS. |
| node:22-slim | (Docker tag) | Container base image | `[CITED: hub.docker.com/_/node]` Debian-slim, has a shell (needed for the acceptance shell-out and Trivy Docker fallback), avoids musl RSS inflation (D-05). Matches the pinned Node 22 runtime (`engines: >=22 <23`, `.nvmrc=22`). |
| GitHub Actions | (`actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`) | CI | `[VERIFIED: codebase]` already in use in `scan-engine.yml`/`memory.yml`; reuse verbatim. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| pino-pretty | 11.x / 13.x | Human-readable dev logs | **Dev-only, behind `NODE_ENV`/flag** (D-04b). `[VERIFIED: npm registry]` OK verdict, official pinojs repo. **NEVER shipped into the container** — a pino transport spawns a worker thread and adds RSS under the proven limit. Add as `devDependency` only. |
| redis:7-alpine | (Docker tag) | Compose Redis service | `[VERIFIED: codebase]` already the image used by the feasibility probe and integration harnesses; reuse for the compose `redis` service. |
| ghcr.io/aquasecurity/trivy:0.69.3 | pinned | Trivy sibling container | `[VERIFIED: codebase]` pinned across the codebase (feasibility probe, Trivy adapter). Reused unchanged via socket mount (D-06). |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| pino adapter behind `EngineLogger` | `nestjs-pino` + `nestjs-cls` (ALS) | Rejected in CONTEXT (D-01): ALS cannot cross the Redis queue boundary between API and worker; the engine already receives an injected logger, so a per-job child logger is leaner and more explainable. |
| `node:22-slim` | `node:22-alpine` | musl can inflate RSS — bad when RSS is graded (D-05). |
| `node:22-slim` | distroless | No shell — breaks the acceptance shell-out and the Trivy Docker fallback (D-05). |
| `mem_limit:` (top-level) | `deploy.resources.limits.memory` | **`deploy.resources` is IGNORED by `docker compose up` (non-swarm) without `--compatibility`** — `mem_limit` is the correct choice (see Pitfall 1). |
| Trivy baked into image | Trivy binary in the app image | Bloats the image; D-06 keeps the app lean by running Trivy as a sibling container via socket mount. |

**Installation:**
```bash
# Direct-pin pino (already resident transitively via Fastify) + dev-only pretty printer
npm install pino@10.3.1 --workspace apps/api
npm install --save-dev pino-pretty --workspace apps/api
```

**Version verification (run at plan/execute time):**
```bash
npm view pino version          # confirm 10.3.1 still latest
npm view pino-pretty version
docker manifest inspect node:22-slim >/dev/null && echo "node:22-slim OK"
```

## Package Legitimacy Audit

| Package | Registry | Age (published) | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----------------|-----------|-------------|---------|-------------|
| pino | npm | 2026-02-09 | 36.4M/wk | github.com/pinojs/pino | **OK** | Approved (direct pin; already transitive via Fastify) |
| pino-pretty | npm | 2025-12-01 | 17.3M/wk | github.com/pinojs/pino-pretty | **OK** | Approved (devDependency only; never shipped in container) |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

Both packages returned `OK` from `gsd-tools query package-legitimacy check --ecosystem npm` (no postinstall scripts, not deprecated, official pinojs source repos) and are `[VERIFIED: npm registry]` — discovered from the pinojs org, the authoritative maintainer. No new Docker base image or GH Action introduces a package-legitimacy concern (all are already in-repo or official Docker Library / GitHub-owned actions).

## Architecture Patterns

### System Architecture Diagram

```
                          docker compose up
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                         │
   ┌────▼─────┐            ┌──────▼──────┐          ┌───────▼────────┐
   │  redis   │◄──────────►│  api        │          │  worker         │
   │ :7-alpine│  BullMQ    │ dist/index  │          │ dist/worker.js  │
   │          │  queue +   │ .js         │          │ --max-old-space │
   │          │  ScanRepo  │ (Fastify)   │          │ -size=150       │
   │          │            │             │          │ mem_limit:200m  │
   └────┬─────┘            └──────┬──────┘          └───────┬─────────┘
        │                         │                         │
        │  healthcheck            │ POST /api/scan          │ process(job):
        │  GET /health ───────────┘  → enqueue              │  pino.child({scanId})
        │  (503 on Redis down)       (pino log w/ scanId)   │  clone → trivy → parse
        │                                                    │  → append CRITICAL
        │                                                    │
        │                                          ┌─────────▼──────────┐
        │                                          │ /var/run/docker.sock│ (D-06 mount)
        │                                          │  → sibling container│
        │                                          │  ghcr.io/.../trivy  │
        │                                          └────────────────────┘
        │
   ndjson stdout (both processes) ──► `... | jq 'select(.scanId=="<id>")'`
                                       reconstructs one scan's full lifecycle
```

Data flow for the acceptance proof: `test:acceptance` (node:test) → spawns disposable Redis + `dist/index.js` + `dist/worker.js` → `POST /api/scan` → poll `GET /api/scan/:id` → assert `Finished` + CRITICAL results → assert clone/report cleanup; then a `SCAN_ENGINE_TEST_FAULT` forced-failure run → assert `Failed` + cleanup.

### Component Responsibilities

| File | Responsibility in Phase 5 | Change type |
|------|---------------------------|-------------|
| `src/engine/scan-engine.ts` | Widen `EngineLogger` port (+`info`), update `noopLogger` | Edit (port widening, D-03) |
| `src/engine/scan-worker.ts` | Build `pino.child({ scanId })` in `process(job)`, pass to engine | Edit (D-02) — ⚠️ `@nestjs/bullmq` file, never imported by Jest |
| `src/worker.module.ts` | Replace NestJS-`Logger`-backed adapter with pino adapter | Edit (D-01) |
| `src/engine/adapter-factory.ts` | `FaultSeamLogger`/`EngineLogger` shape may gain `info` | Edit (align with widened port) |
| `src/scan/scan.service.ts` | Emit enqueue line carrying `scanId` (API side) | Edit (D-02) |
| new pino adapter file | `EngineLogger`→pino translation; base logger config (ndjson, no transport in prod) | New (D-01) |
| `Dockerfile` | Multi-stage `node:22-slim`, non-root, builder+runtime | New (D-05) |
| `docker-compose.yml` | redis + api + worker, `mem_limit:200m`, healthcheck, socket mount | New (D-04/D-06) |
| `.dockerignore` | Exclude `node_modules`, `dist`, `.git`, fixtures, planning | New |
| `scripts/api-integration.mjs` or new | Acceptance harness (happy + forced-failure + cleanup) | Edit/New (D-08/D-09) |
| `.github/workflows/scan-engine.yml` | Add REST-contract + acceptance jobs (gated) | Edit (D-11) |
| `.github/CI-CONTRACT.md` | Document new statuses | Edit (D-11/D-12) |
| `src/http/validation/github-url.pipe.ts` | Return canonical URL, not raw (WR-01) | Edit (D-13) |
| `src/config/env.validation.ts` | Lower `SHUTDOWN_GRACE_MS` max to ≤9000 (WR-02) | Edit (D-13) |
| `src/scan/scan.module.ts` | Add `error` listener to `REDIS_CLIENT` factory (WR-03) | Edit (D-13) |

### Pattern 1: pino adapter behind the existing `EngineLogger` port (D-01, D-03)
**What:** A thin adapter maps the widened `EngineLogger` (`info`/`warn`/`error`) onto a pino instance. The domain engine imports NOTHING from pino.
**When to use:** Everywhere the engine emits lifecycle diagnostics.
**Example:**
```typescript
// Source: getpino.io — child loggers + base logger config [CITED]
import pino, { type Logger as PinoLogger } from 'pino';
import type { EngineLogger } from '../engine/scan-engine';

// Base logger: ndjson only, NO transport in container/prod (D-04b) — a transport
// spawns a worker thread that adds RSS under the 200m limit being proven.
export function createBaseLogger(): PinoLogger {
  const isDev = process.env.NODE_ENV === 'development';
  return pino(
    isDev
      ? { transport: { target: 'pino-pretty' } } // dev ONLY, behind NODE_ENV
      : {}, // prod/container/CI: default ndjson to stdout, includes pid+hostname
  );
}

// scanId-bound adapter satisfying the widened EngineLogger port.
export function engineLoggerFor(base: PinoLogger, scanId: string): EngineLogger {
  const child = base.child({ scanId }); // D-02 correlation field
  return {
    info: (message) => child.info(message),
    warn: (message) => child.warn(message),
    error: (message) => child.error(message),
  };
}
```

### Pattern 2: Thread `pino.child({ scanId })` through the worker (D-02)
**What:** At the top of `ScanWorker.process(job)`, build the child logger from `job.data.scanId` and inject it into the engine call. The `ScanEngine` is currently constructed once in `worker.module.ts`; because the logger must be per-job, either (a) pass the logger into `engine.run(job.data, logger)` (preferred — engine stays a singleton) or (b) construct a per-job engine. Prefer (a): a minimal signature change to `ScanEngine.run`.
**Example:**
```typescript
// scan-worker.ts — the ONLY worker-path @nestjs/bullmq file (never in Jest)
async process(job: Job<ScanJob, void, typeof SCAN_JOB_NAME>): Promise<void> {
  const logger = engineLoggerFor(this.baseLogger, job.data.scanId);
  await this.engine.run(job.data, logger); // per-job scanId-bound logger
}
```
**Anti-pattern:** Do NOT try to propagate `scanId` via `AsyncLocalStorage` — it cannot cross the Redis queue boundary (D-01). The payload IS the correlation carrier.

### Pattern 3: Multi-stage `node:22-slim` Dockerfile (D-05)
```dockerfile
# Source: hub.docker.com/_/node + Docker multi-stage docs [CITED]
# ---- builder ----
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci
COPY . .
RUN npm run build --workspace apps/api    # nest build + tsc scripts → dist/

# ---- runtime ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/apps/api/dist ./apps/api/dist
USER node                                  # non-root (D-05)
# CMD is set per-service in docker-compose.yml (api vs worker)
```

### Pattern 4: `docker-compose.yml` topology (D-04, D-06) — `mem_limit` is correct
```yaml
# Source: docs.docker.com/compose + verified mem_limit-vs-deploy behavior [CITED/VERIFIED]
services:
  redis:
    image: redis:7-alpine
    # no host-side install needed (OPS-02)
  api:
    build: { context: ., target: runtime }
    command: node dist/index.js            # matches PDF self-test entrypoint
    environment: [ REDIS_HOST=redis, REDIS_PORT=6379, SCAN_TMP_DIR=/tmp/scans ]
    depends_on:
      redis: { condition: service_started }
    healthcheck:                           # keys off existing /health (503 on Redis down)
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 3s
      retries: 5
  worker:
    build: { context: ., target: runtime }
    command: node --max-old-space-size=150 dist/worker.js   # the memory-critical process
    mem_limit: 200m                        # TOP-LEVEL key — honored by `docker compose up`
    environment: [ REDIS_HOST=redis, REDIS_PORT=6379, SCAN_TMP_DIR=/tmp/scans, TRIVY_MODE=docker ]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock   # D-06 sibling-container Trivy
    depends_on:
      redis: { condition: service_started }
```
**Note:** `SHUTDOWN_GRACE_MS` default 8000 must stay under Docker's default 10s stop grace (D-13/WR-02). Consider `stop_grace_period: 10s` explicitly on the worker to make the drain window auditable.

### Pattern 5: In-container OOM proof (criterion #2, false-negative guard)
Assert BOTH conditions — an OOM-kill can surface as exit 137 while `docker inspect` still reads `OOMKilled:false` in some kernels:
```bash
# Source: docs.docker.com/reference/cli/docker/container/inspect [CITED]
docker inspect --format '{{.State.OOMKilled}} {{.State.ExitCode}}' <worker-container>
# require: "false 0"  — NOT just OOMKilled==false
```

### Anti-Patterns to Avoid
- **Shipping a pino transport (pretty-print) into the container** — spawns a worker thread, adds RSS under the exact 200m limit being proven (D-04b).
- **Using `deploy.resources.limits.memory` for the memory cap** — silently ignored by `docker compose up` (Pitfall 1).
- **Importing any `@nestjs/bullmq`-touching file (`scan-worker.ts`, `worker-shutdown.provider.ts`) into a Jest spec** — the confirmed `@swc/core` miette panic aborts the whole Jest run (STATE.md). All BullMQ-touching tests run against compiled `dist` under `node:test`.
- **Raising `mem_limit` above 200m to fix an OOM** — defeats the graded constraint; lower `--max-old-space-size` to 128 instead (D-07).
- **`AsyncLocalStorage` for scanId** — cannot cross the Redis queue boundary (D-01).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Structured ndjson logging + correlation fields | A custom `JSON.stringify` logger | pino `child({ scanId })` | pino handles serialization, levels, redaction, and low-overhead ndjson; a hand-rolled logger reinvents level filtering and risks blocking stdout writes |
| Disposable Redis + real-process orchestration in tests | New spawn/teardown scaffolding | Clone `api-integration.mjs` helpers (`spawnApi`, `spawnWorker`, disposable-Redis lifecycle, terminal poll, cleanup asserts) | Proven, status-preserving, bounded-timeout harness already exists |
| Docker/Redis/Trivy CI gating | Ad-hoc `if docker` shell checks | Clone `scan-engine-feasibility.mjs` + the gated-job pattern in `scan-engine.yml` | Fail-closed-on-unknown semantics are already designed and documented in `CI-CONTRACT.md` |
| Trivy install in the image | apt/curl Trivy into the Dockerfile | Existing local-detect + pinned-Docker-fallback adapter + socket mount (D-06) | Keeps the app image lean; adapter code is unchanged |
| 500MB memory proof | New profiling harness | Reuse `scripts/memtest.ts` + `gen-fixture.ts` (Phase 2) | Verbatim reuse is D-10's explicit instruction |

**Key insight:** Almost every capability this phase needs already exists as a proven seam. The work is composition and packaging, not construction — resist re-authoring harnesses or loggers from scratch.

## Common Pitfalls

### Pitfall 1: `deploy.resources.limits.memory` is silently ignored by `docker compose up`
**What goes wrong:** The memory cap appears set in YAML but the container has no limit; the OOM proof is meaningless.
**Why it happens:** `deploy.resources` is a Swarm-mode construct. The standalone `docker compose` v2 CLI ignores it in non-swarm mode unless `--compatibility` is passed. `mem_limit` (top-level service key) IS honored. `[VERIFIED: web search — multiple corroborating sources]`
**How to avoid:** Use the top-level `mem_limit: 200m` key (as D-04 locked). Do NOT use `deploy.resources`.
**Warning signs:** `docker inspect --format '{{.HostConfig.Memory}}' <c>` returns `0`.

### Pitfall 2: OOM-kill reads as `OOMKilled:false` with exit 137
**What goes wrong:** The proof passes on `OOMKilled==false` alone while the container was actually killed.
**Why it happens:** Depending on kernel/cgroup version, an OOM can surface as a SIGKILL (exit 137) without the `OOMKilled` flag being set.
**How to avoid:** Assert BOTH `OOMKilled == false` AND exit code `0` (Claude's Discretion in CONTEXT explicitly calls this out).
**Warning signs:** Exit code 137 with `OOMKilled:false`.

### Pitfall 3: A shipped pino transport blows the memory budget
**What goes wrong:** In-container RSS creeps up and the memory proof OOMs even though bare-node passes.
**Why it happens:** pino transports (`pino-pretty`, file transports) run in a **separate worker thread**, adding a second V8 isolate's RSS under the 200m ceiling.
**How to avoid:** ndjson to stdout in prod/container/CI; `pino-pretty` only in dev behind `NODE_ENV` (D-04b). Verify peak RSS in-container, not just bare-node (D-07).
**Warning signs:** `docker stats` shows worker RSS climbing toward 190m during a scan.

### Pitfall 4: Fastify double-pino silent fallback
**What goes wrong:** Logs disappear or use the wrong logger config.
**Why it happens:** Fastify ships its own pino. Configuring pino once AND setting `useExisting:true` + a logger on the FastifyAdapter creates a documented conflict.
**How to avoid:** Configure pino once; do not double-wire the adapter (D-Fastify).

### Pitfall 5: `@nestjs/bullmq` in the Jest graph aborts the whole run
**What goes wrong:** Adding a spec that imports `scan-worker.ts` (or the new pino wiring if placed there) triggers an `@swc/core` miette native panic that aborts Jest on both Node 22 and Node 24.
**Why it happens:** Documented toolchain landmine (STATE.md, 03-01).
**How to avoid:** Keep pino wiring that touches `@nestjs/bullmq` inside `scan-worker.ts`/`worker.module.ts` (never Jest-imported); test the pino adapter's pure logic in isolation, and the wired behavior via the compiled `node:test` harness.
**Warning signs:** Jest crashes with a Rust/miette panic stack rather than a test failure.

### Pitfall 6: SHUTDOWN_GRACE_MS can exceed the container stop window
**What goes wrong:** In-flight scans are hard-killed instead of drained; the "always exit before SIGKILL" guarantee breaks.
**Why it happens:** `env.validation.ts:51` caps `SHUTDOWN_GRACE_MS` at 60000, but Docker's default stop grace is 10s (WR-02).
**How to avoid:** Lower the schema `max` to ≤9000 (D-13); optionally set `stop_grace_period: 10s` on the worker service.

## Code Examples

### Enqueue log line on the API side (D-02, OPS-04)
```typescript
// scan.service.ts — emit the scanId-bound enqueue line so a scan's lifecycle
// starts in the API logs and continues in the worker logs, joinable by scanId.
async enqueue(repoUrl: string): Promise<Scan> {
  const id = randomUUID();
  // ... create scan, add job ...
  this.logger.info({ scanId: id, repoUrl }, 'scan queued'); // ndjson w/ scanId
  return scan;
}
```

### WR-01 fix — return the canonical URL, not the raw request string
```typescript
// github-url.pipe.ts — makes the enqueued/cloned string provably equal to what was validated
const parsed = parseGithubUrl(repoUrl);
if (parsed === null) {
  throw new BadRequestException('repoUrl must be an https://github.com/{owner}/{repo} URL');
}
return { repoUrl: `https://github.com/${parsed.owner}/${parsed.repo}` };
```

### WR-03 fix — non-throwing error listener on the shared Redis client
```typescript
// scan.module.ts REDIS_CLIENT factory — prevents an unhandled 'error' crash on Redis drop
useFactory: (config: ConfigService): Redis => {
  const client = new Redis({
    host: config.getOrThrow<string>('REDIS_HOST'),
    port: config.getOrThrow<number>('REDIS_PORT'),
  });
  const logger = new Logger('RedisClient');
  client.on('error', (err) => logger.warn(`Redis connection error: ${err.message}`));
  return client;
},
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `deploy.resources` for compose limits | `mem_limit` top-level key (non-swarm) | docker-compose → `docker compose` v2 CLI | Using `deploy.resources` silently disables the cap; `mem_limit` is required for `docker compose up` |
| Manual `--max-old-space-size` as the only heap control | Node 20+ derives a container-aware heap ceiling from cgroup limits | Node 20 | The flag still overrides the auto-default; D-07 sets 150 explicitly (75% of 200m) rather than relying on Node's ~100MB auto-derivation |
| ALS/request-context for correlation | Payload-carried correlation id + `child()` logger | (design choice) | ALS cannot cross a queue/process boundary; the job payload is the durable carrier |

**Deprecated/outdated:**
- `docker-compose` (hyphenated v1 binary): superseded by `docker compose` (v2 plugin) — the repo already assumes v2 (`docker compose version` present).

## Runtime State Inventory

> Not a rename/refactor/migration phase — greenfield packaging plus additive logging seam. No stored data, live-service config, OS-registered state, secrets, or build artifacts carry a string that this phase renames. `dist/` is a build artifact regenerated by `npm run build` (gitignored); no migration needed.

- **Stored data:** None — no keys/collections renamed; `ScanJob`/Redis schema unchanged.
- **Live service config:** None — no external UI/DB-resident config touched (Trivy image already pinned).
- **OS-registered state:** None.
- **Secrets/env vars:** New optional log-level env var may be added (Claude's Discretion) — additive, fail-closed via Joi; no existing key renamed.
- **Build artifacts:** `dist/` regenerates from source; Docker images are new artifacts (no stale old-name artifacts exist).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `node:22-slim` (Debian slim) yields lower/comparable RSS vs alpine for this workload | Standard Stack (D-05) | If RSS is higher than expected in-container, may need `--max-old-space-size=128` (already the D-07 fallback) — low risk, mitigated |
| A2 | pino default ndjson output (no transport) adds negligible RSS vs the current NestJS `Logger` | Pattern 1 | If pino base cost is non-trivial under 200m, tune log level / fields; low risk given pino is already loaded via Fastify |
| A3 | The Docker socket mount (D-06) works on the CI runner and the reviewer's machine for sibling-container Trivy | Pattern 4 | If socket mount is unavailable, the compose worker cannot run Trivy — feasibility-gated per D-09/D-12, so it degrades to a recorded skip rather than a false failure |
| A4 | Passing a per-job logger into `ScanEngine.run(job, logger)` is the cleanest way to keep the engine a singleton while binding `scanId` | Pattern 2 | If a signature change is undesirable, construct a per-job engine instead — internal design choice, no external impact |

**Note:** Node here is v24.10.0 (sandbox) but the project pins Node 22 (`.nvmrc`, `engines`, CI). All memory/behavior claims must be validated on Node 22 in-container, consistent with the standing STATE.md Phase-5 tuning flag.

## Open Questions

1. **Where does the base pino logger live so it is available to both `scan.service.ts` (API) and `scan-worker.ts` (worker) without pulling `@nestjs/bullmq` into Jest?**
   - What we know: the pino adapter must satisfy `EngineLogger`; the worker file is Jest-forbidden.
   - What's unclear: whether to provide the base logger via a small DI provider in `ScanModule` (shared) or construct it locally in each entrypoint.
   - Recommendation: a tiny framework-free `createBaseLogger()` factory (no `@nestjs/bullmq`), injected in both modules; unit-test the adapter's pure mapping, validate wiring via the compiled harness.

2. **Does the in-container OOM proof live inside `test:acceptance` or a dedicated compose-driven CI step?**
   - What we know: CONTEXT leaves this to Claude's Discretion, requiring both `OOMKilled==false` AND exit 0.
   - Recommendation: a dedicated compose-driven CI step (feasibility-gated) keeps the acceptance harness fast and Docker-optional; the OOM proof is inherently Docker-bound.

3. **Should `SHUTDOWN_GRACE_MS` max be lowered to 9000 exactly, or leave headroom for `BACKSTOP_MARGIN_MS` (500)?**
   - Recommendation: max `9000` (backstop fires at 9500, still < 10000 SIGKILL) — matches WR-02's suggested fix.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js (pinned 22) | Build/run/CI | ✓ (sandbox v24.10.0; project pins 22 via `.nvmrc`/engines/CI) | 24.10.0 present; **22 is the contract** | CI enforces Node 22 (`setup-node@v4`); validate in-container on 22 |
| npm | Install/build | ✓ | 11.6.1 | — |
| Docker daemon | Compose, acceptance, Trivy sibling, disposable Redis | ✓ RUNNING | 29.1.3 | Feasibility-gated (D-09/D-12): recorded skip when absent |
| docker compose (v2) | OPS-01/02 stack | ✓ | 2.40.3 | — |
| Trivy (local binary) | Scan | ✗ NOT FOUND | — | Pinned Docker image `ghcr.io/aquasecurity/trivy:0.69.3` (existing adapter fallback, D-06) |
| redis-server (host) | Redis | ✗ NOT FOUND (by design — no host install) | — | `redis:7-alpine` container (compose + harnesses) |
| pino | OPS-04 logging | ✓ (resident 10.3.1 via Fastify) | 10.3.1 | Direct-pin to formalize |

**Missing dependencies with no fallback:** none — every gap has a container-based fallback already used elsewhere in the repo.
**Missing dependencies with fallback:** Trivy binary → pinned Docker image; host Redis → `redis:7-alpine` container. Both are the intended production paths (D-06, OPS-02 "no host-side install").

## Security Domain

### Applicable ASVS Categories (Level 1, security_enforcement enabled)

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Unauthenticated take-home service; auth explicitly out of scope |
| V3 Session Management | no | Stateless REST + queue |
| V4 Access Control | no | No multi-tenancy / roles (out of scope) |
| V5 Input Validation | yes | GitHub-URL allowlist pipe; **WR-01 fix** makes the validated form == the used form (canonical URL, closing the parser differential) |
| V6 Cryptography | no | No secrets/crypto introduced this phase |
| V7 Error Handling & Logging | yes | pino ndjson with bounded fields; failure `detail` capped at 500 chars (existing); **do not log raw repo content or full Trivy output** — only `scanId`/status/bounded reason |
| V12 Files & Resources | yes | Docker socket mount (D-06) grants the container Docker control — documented trade-off; `SCAN_TMP_DIR` isolation + guaranteed cleanup unchanged |
| V14 Configuration | yes | Joi fail-closed env schema; **WR-02 fix** caps `SHUTDOWN_GRACE_MS`; non-root `node` user in the image (D-05) |

### Known Threat Patterns for {Node container + queue worker + Docker socket}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Command injection via repo URL | Tampering | execa/spawn argv arrays `shell:false` (existing) + WR-01 canonical URL |
| SSRF via crafted URL | Info disclosure | GitHub-host allowlist + `GIT_ALLOW_PROTOCOL=https` fail-closed (existing) |
| Docker socket = host root-equivalent | Elevation of Privilege | Mount is the locked D-06 trade-off; document in ONBOARDING; worker runs as non-root `node` inside its own container; only the pinned Trivy image is invoked |
| Log injection / PII in logs | Info disclosure | pino structured fields (not string interpolation of untrusted content); bounded reason detail; log only `scanId`/status, never report bodies |
| Sensitive data in image layers | Info disclosure | `.dockerignore` excludes `.env`, `.git`, planning; `npm ci --omit=dev`; multi-stage drops build deps |
| Unhandled Redis `error` crash | Denial of Service | WR-03 error listener on `REDIS_CLIENT` |

## Sources

### Primary (HIGH confidence)
- Codebase (read directly this session): `scan-engine.ts`, `scan-worker.ts`, `worker.module.ts`, `adapter-factory.ts`, `worker.ts`, `index.ts`, `scan.module.ts`, `scan.service.ts`, `scan.repository.ts`, `health.service.ts`, `health.controller.ts`, `env.validation.ts`, `worker-shutdown.provider.ts`, `github-url.pipe.ts`, `app.module.ts`, `memtest.ts`, `api-integration.mjs`, `scan-engine-feasibility.mjs`, `package.json` (root + api), `scan-engine.yml`, `memory.yml`, `CI-CONTRACT.md`, `.gitignore`, `04-REVIEW.md`
- `gsd-tools query package-legitimacy check --ecosystem npm pino pino-pretty` → both `OK`
- Environment probe (this session): Docker 29.1.3 running, compose 2.40.3, trivy absent, redis-server absent, pino 10.3.1 resident, Node v24.10.0 (project pins 22)

### Secondary (MEDIUM confidence)
- WebSearch (verified across multiple corroborating sources): `docker compose` v2 ignores `deploy.resources.limits.memory` in non-swarm without `--compatibility`; `mem_limit` is honored — [lours.me compose-tip-016](https://lours.me/posts/compose-tip-016-resource-limits/), [GeeksforGeeks](https://www.geeksforgeeks.org/devops/configure-docker-compose-memory-limits/), [compose-cli issue #1523](https://github.com/docker-archive/compose-cli/issues/1523)
- CONTEXT-curated official docs (cited, to re-verify at write time): getpino.io (child loggers, transport-in-worker-thread caveat), github.com/iamolegga/nestjs-pino (Fastify double-pino trap), developers.redhat.com Node 20 cgroup heap article, goldbergyoni/nodebestpractices docker/memory-limit.md, docs.docker.com container inspect (`State.OOMKilled`), docs.bullmq.io worker lifecycle, hub.docker.com/_/node (node:22-slim)

### Tertiary (LOW confidence)
- None relied upon for load-bearing decisions.

## Project Constraints (from CLAUDE.md)

- **Framework:** NestJS 11 on the Fastify adapter (do not swap for raw Fastify — the global-CLAUDE stack doc suggested Fastify, but the project locked NestJS 11 per project `.claude/CLAUDE.md` and STATE.md; honor the project decision).
- **Forbidden APIs:** `fs.readFile` / `JSON.parse` on the Trivy scan report — must stream (unchanged this phase; do not regress). Small per-item Redis reads using `JSON.parse` are permitted (not the report).
- **Memory constraint:** 256MB assumption; self-test at 150MB heap; Docker `mem_limit: 200m` — the defining pass/fail criterion.
- **Two entrypoints:** `src/index.ts`→`dist/index.js` (API), `src/worker.ts`→`dist/worker.js` (worker) — API CMD matches the PDF self-test verbatim.
- **Runnability:** Reviewer must run everything from README alone; the docker-compose path must work end-to-end.
- **Trivy:** local-detect + pinned Docker fallback (`ghcr.io/aquasecurity/trivy:0.69.3`).
- **GSD workflow:** File-changing work must go through a GSD command (this is research only — no source edits).
- **Research-first (global CLAUDE.md):** verify library/tool versions and exact config syntax via docs where touched (Dockerfile base tags, compose schema, GH Actions, pino API, Trivy install) — reflected in the version-verification commands above.

## Metadata

**Confidence breakdown:**
- Existing-vs-required gap map: HIGH — every seam read directly from source this session.
- Standard stack (pino, node:22-slim, GH Actions): HIGH — pino resident + legitimacy-verified; base image and actions already in repo.
- Docker memory-limit behavior (`mem_limit` vs `deploy.resources`): MEDIUM-HIGH — verified via multiple corroborating web sources; confirm on the actual runner.
- Pitfalls: HIGH — most are recorded in STATE.md / 04-REVIEW.md or verified this session.

**Research date:** 2026-07-10
**Valid until:** ~2026-08-09 (30 days — stable tooling; re-`npm view pino` and re-check `node:22-slim` at execute time)
</content>
</invoke>
