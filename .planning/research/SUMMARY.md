# Project Research Summary

**Project:** Code Guardian — Supply Chain Scanner
**Domain:** Memory-constrained Node.js/TypeScript async security-scanner wrapper (Trivy wrapper, senior backend take-home)
**Researched:** 2026-07-09
**Confidence:** MEDIUM

> **⚠ STACK DECISION UPDATE (2026-07-09, post-synthesis — supersedes framework choice below):**
> Framework is **NestJS 11 on the Fastify adapter**, not hand-rolled Fastify. Rationale: NestJS's Module/Controller/Provider model *is* the graded Controller/Service/Worker separation, framework-enforced and legible to a reviewer; DI shares one `ScanService` across REST + GraphQL + worker. Verified: lean single-module NestJS idles ~35–60MB RSS (well within the 200MB container / 150MB heap budget — the "170MB" figure is fat TypeORM apps). The memory pass/fail is still won in the stream-json `Pick`+`streamArray` strategy, NOT the framework.
>
> Concrete stack: `@nestjs/core` 11.1.x + `@nestjs/platform-fastify` 11.1.x, code-first GraphQL via `@nestjs/graphql` 13.x + **MercuriusDriver** (`@nestjs/mercurius`) on the same Fastify server, `@nestjs/bullmq` 11.0.x (`@Processor`/`WorkerHost`, `concurrency: 1` — mandatory at 200m), `bullmq` 5.79.x, `ioredis` 5.11.x, `stream-json` 3.4.x (+ `@types/stream-json`), `execa` for git/trivy, `@nestjs/config` + Joi env validation, global `ValidationPipe` + class-validator `CreateScanDto` (`@IsUrl` + GitHub-host guard for SSRF/injection), Jest + `@swc/jest` for tests.
>
> Topology: **two entrypoints sharing `ScanModule`** — `src/index.ts` (API: `NestFactory.create(AppModule)` + `listen`; emits `dist/index.js` to match the assignment's `node --max-old-space-size=150 dist/index.js` self-test verbatim) and `src/worker.ts` (`NestFactory.createApplicationContext(WorkerModule)`, NO HTTP listener, boots the `@Processor`). Separate docker-compose containers; worker never imports GraphQL/Apollo (dead heap). V8 does NOT honor cgroup limits at 200m → pass `--max-old-space-size=150` explicitly in the worker `CMD`.
>
> Everything below about stream-json, BullMQ semantics, Trivy CLI/exit-codes, memory/RSS pitfalls, cleanup, and the 6-phase build order remains valid and framework-agnostic — read "Fastify/Mercurius/ScanService/Worker" as "the NestJS equivalents above."

## Executive Summary

This is a graded take-home assignment, not a shipped product — so "how experts build it" means "what a senior backend reviewer expects to see." The service accepts a GitHub repo URL, clones it, runs Trivy, and must stream-parse a 500MB+ JSON report to extract only CRITICAL vulnerabilities without ever loading the file into memory, all inside a 150MB V8 heap / 200MB container budget. The consensus recommended stack is Fastify + Mercurius (GraphQL, sharing one process/port) + BullMQ/ioredis for the job queue + stream-json/stream-chain for the parsing pipeline + execa for safe subprocess invocation — chosen specifically because each has a lower memory footprint or more surgical fit than the "heavier" alternative (NestJS, Apollo standalone, JSONStream, raw child_process).

The recommended approach is Ports-and-Adapters (hexagonal-ish): thin REST/GraphQL controllers calling one shared `ScanService`, which enqueues work to a BullMQ `Worker` that sequences `RepoCloner -> TrivyRunner -> ReportParser -> ScanRepository` adapters, all state handed off through Redis (never shared memory), packaged as separate API/worker/redis containers via docker-compose. The single highest-value, highest-risk piece is the streaming pipeline itself — it should be built and proven in isolation against a synthetic 500MB+ fixture and `--max-old-space-size=150` before any queue/HTTP plumbing is wired around it, because a subtle full-buffering bug is the single most common way to fail the assignment's #1 grading criterion while looking like it works.

Key risks: (1) accidental full-buffering anywhere in the pipeline (mitigated by nested `pick`/`streamArray` stages, banning `JSON.parse`/`readFileSync` on the report, and testing at multiple fixture sizes to confirm flat RSS); (2) heap-limit vs RSS confusion — passing the bare `node --max-old-space-size=150` self-test while still getting OOM-killed in `docker-compose` (mitigated by testing both gates separately and logging RSS, not just heapUsed); (3) cleanup being skipped on error/throw paths, silently exhausting disk (mitigated by `try/finally` with idempotent cleanup, tested via forced-failure runs). All three are addressed directly in the suggested phase order below.

## Key Findings

### Recommended Stack

Node 20/22 LTS + TypeScript 5.9 (strict, `noUncheckedIndexedAccess`) is the base. Fastify 5.10 is preferred over Express/NestJS purely for memory: 30-40% higher throughput and no DI-container tax under a 200MB ceiling. Mercurius (not Apollo/graphql-yoga) is the GraphQL layer because it registers as a Fastify plugin on the same process/port — zero second-server memory overhead, matters for Bonus B. BullMQ 5.79 + ioredis 5.11 is the job queue (retries, concurrency control, restart survival — explicitly required); ioredis connections passed to a BullMQ `Worker` **must** set `maxRetriesPerRequest: null`. stream-json + stream-chain is the parsing pipeline: `pick`/`streamArray` descends into `Results[].Vulnerabilities` and emits one vulnerability at a time with automatic backpressure, keeping RSS flat regardless of file size. execa wraps `git clone`/`trivy` invocations so URLs are always passed as argv arrays, never string-interpolated shell commands.

**Core technologies:**
- Fastify 5.10 — HTTP framework — highest throughput-per-MB, native Controller/Service/Worker fit without DI overhead
- Mercurius 16.9 — GraphQL — Fastify-native plugin, shares one process with REST (Bonus B)
- BullMQ 5.79 + ioredis 5.11 — background job queue — retries/concurrency/restart-survival required by the assignment
- stream-json 1.9 + stream-chain — streaming JSON parser — the only viable way to satisfy the "no `fs.readFile`/`JSON.parse`" constraint on a 500MB file
- execa 9.x — subprocess invocation — closes the command-injection hole that raw `child_process.exec` string-interpolation opens

### Expected Features

**Must have (table stakes):** input validation + SSRF-aware guard on the repo URL; structured logging (pino) with scanId correlation; `/health` endpoint; idempotent cleanup on success AND failure paths; `.env` validation at boot; graceful shutdown (SIGTERM drains BullMQ jobs); consistent typed API error responses; README with exact run instructions including the memory self-test command.

**Should have (differentiators):** memory self-test/proof script + streaming huge-fixture generator (treat as P0, not polish — it IS the #1 grading criterion made visible); backpressure-aware `stream.pipeline()` composition (not manual `.pipe()`); job retry/timeout policies around Trivy/git child processes; BullMQ concurrency limits tuned to the memory budget; strict TS interfaces modeling Trivy's real JSON schema; a test pyramid targeting graded risk areas; CI that runs the memory-proof script as a build gate (highest-leverage differentiator — rare among candidates).

**Defer (v2+/anti-features):** authentication, multi-tenant isolation, a persistent DB, Kubernetes manifests, full liveness/readiness probe split, rate limiting, storing non-CRITICAL vulnerability data, pluggable multi-scanner abstraction. Pagination and OpenAPI/Swagger docs are real differentiators but P3 — sequence after the core floor and bonuses are solid.

### Architecture Approach

Thin Controller (REST + GraphQL) -> fat-free `ScanService` (orchestration only, no fs/child_process/HTTP imports) -> BullMQ `Worker`/`ScanProcessor` (a separate process/entrypoint sequencing infrastructure adapters) -> Ports-and-Adapters infrastructure layer (`RepoCloner`, `TrivyRunner`, `ReportParser`, `ScanRepository`). State crosses the API/worker process boundary only through Redis — never shared memory — which is what makes the "separate containers" topology real rather than cosmetic, and is the concrete evidence graders check for "clean separation of concerns."

**Major components:**
1. `ScanService` — generates scanId, enqueues BullMQ job, reads scan status/result; shared by both REST controller and GraphQL resolver so the two protocols never diverge in business logic
2. `ScanProcessor` (worker) — sequences clone -> trivy -> parse -> store -> cleanup in a `try/finally`, calling only infrastructure adapters, never inline I/O
3. `ReportParser` adapter — the highest-risk, most-graded component; a `stream-json` pipeline (`parser()` -> `pick('Results')` -> `streamArray()` -> nested pick/filter on `Vulnerabilities`) proven against the 500MB fixture in isolation before being wired into the worker
4. `ScanRepository` — an independent Redis-hash status record (`scan:<id>`) keyed by domain scanId, decoupled from BullMQ's own internal job-state machine, so `GET /api/scan/:id` never reads `job.getState()` directly

### Critical Pitfalls

1. **Accidental full-buffering of the "streamed" pipeline** — the assignment's #1 fail condition; commonly hides in the inner `Vulnerabilities` array once the outer `Results` array is already streamed. Avoid via nested `pick`+`streamArray` stages and a mechanical CI/lint guard against `JSON.parse`/`readFileSync`/`.toArray()` on the report path.
2. **Confusing V8 heap limit with actual RSS** — passing `--max-old-space-size=150` while still getting OOM-killed in `docker-compose` (`mem_limit: 200m`) because Buffers/native memory are invisible to heap-only monitoring. Avoid by logging and asserting on `rss`, not just `heapUsed`, and testing both gates separately.
3. **`child_process.exec()` maxBuffer trap** — invoking Trivy via `exec()` either throws past a few hundred KB of stdout, or "fixing" it via a huge `maxBuffer` just relocates the full-buffering problem into `child_process`. Avoid via `spawn()` + Trivy's own `--output <file>` flag so Node never sees report bytes on a pipe.
4. **Cleanup skipped on throw/crash paths** — happy-path-only cleanup silently exhausts disk under repeated failed scans. Avoid via `try/finally` (plus `unhandledRejection`/`uncaughtException` defense-in-depth), idempotent and collision-safe via per-scan temp paths.
5. **`stream-json` `pick` path mismatch for Trivy's nested shape** — a naive top-level `pick({filter:'Vulnerabilities'})` silently emits zero results because `Vulnerabilities` is nested inside each `Results[]` element. Avoid via a small hand-crafted fixture unit test with known nested counts before scaling to the 500MB fixture.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Foundations & Domain Types
**Rationale:** Everything downstream (parser, adapters, service) depends on strict TS interfaces and project skeleton existing first; zero risk, unblocks type-checking everywhere else.
**Delivers:** Repo skeleton (`src/api`, `services`, `worker`, `infrastructure`, `domain`, `config`), strict `tsconfig.json`, ESLint config, `domain/scan.types.ts` and `domain/trivy-report.types.ts` modeled on Trivy's real JSON schema, env validation at boot.
**Addresses:** Strict TypeScript / no `any` (FEATURES.md table stakes), `.env` validation at boot.
**Avoids:** N/A (no memory-risk surface yet) — sets up the mechanical guard (lint/CI check banning `JSON.parse`/`readFileSync` on report paths) that Pitfall 1 needs later.

### Phase 2: Streaming Pipeline + Memory Proof (highest-risk, build first and in isolation)
**Rationale:** This is the assignment's #1 grading criterion and its highest technical risk; ARCHITECTURE.md's own suggested build order proves this component standalone before any queue/HTTP plumbing exists.
**Delivers:** `ReportParser` adapter (stream-json/stream-chain pipeline: nested `pick`+`streamArray` for `Results[].Vulnerabilities`, CRITICAL-only filter), synthetic streaming fixture generator (50MB/200MB/500MB/1GB), runnable memory self-test script logging both `heapUsed` and `rss`.
**Addresses:** Memory self-test/proof script, backpressure-aware pipeline, strict Trivy interfaces, CRITICAL-only filtering (FEATURES.md P1 items).
**Avoids:** Pitfalls 1 (full-buffering), 2 (heap vs RSS confusion), 4 (string/Buffer concatenation), 5 (CRITICAL-only leakage), 6 (pick path mismatch).

### Phase 3: Trivy & Repo-Clone Adapters
**Rationale:** Independent of the parser and of each other; can be built in parallel with Phase 2 per ARCHITECTURE.md's build order, but sequenced here for solo-build simplicity.
**Delivers:** `RepoCloner` (execa `git clone --depth 1`, URL validation + SSRF guard), `TrivyRunner` (execa `spawn` + `--output <file>`, local-binary-with-Docker-fallback detection, correct exit-code semantics — not naive `code !== 0`).
**Uses:** execa, git, Trivy CLI (STACK.md).
**Implements:** `RepoCloner`/`TrivyRunner` ports-and-adapters (ARCHITECTURE.md Pattern 2).
**Avoids:** Pitfall 3 (maxBuffer trap), Pitfall 7 (`--exit-code` misinterpreted as failure), command injection via unvalidated URL.

### Phase 4: BullMQ Queue, ScanRepository & ScanService
**Rationale:** Depends on Phases 2-3's adapter interfaces (can be stubbed/mocked); this is where the Controller/Service/Worker separation the assignment names explicitly gets wired together.
**Delivers:** `ScanQueue` (BullMQ producer wrapper), `ScanRepository` (Redis hash `scan:<id>`, decoupled from BullMQ's own job-state), `ScanService` (createScan/getScan orchestration only), `ScanProcessor` (worker pipeline sequencing all adapters with `try/finally` cleanup), worker entrypoint with `concurrency: 1` explicitly documented.
**Addresses:** BullMQ + Redis job queue, idempotent cleanup, concurrency control, deduplication design (FEATURES.md P1/P2).
**Avoids:** Pitfall 8 (cleanup skipped on throw), Pitfall 9 (BullMQ job data as dumping ground), Pitfall 10 (worker+API sharing heap without documented concurrency).

### Phase 5: REST + GraphQL API Surface
**Rationale:** Depends only on ScanService (Phase 4); build REST first so GraphQL resolvers can be proven as a thin second adapter over the identical service rather than a divergent implementation.
**Delivers:** Fastify REST controller (`POST /api/scan`, `GET /api/scan/:id`), Mercurius GraphQL schema/resolvers on the same process, `/health` endpoint, structured pino logging with scanId correlation, consistent typed error responses, graceful shutdown.
**Addresses:** All literal assignment endpoint requirements, Bonus B (GraphQL), health check, error handling (FEATURES.md P1).
**Avoids:** GraphQL resolvers re-implementing REST logic; Anti-Pattern 3 (reading BullMQ job state as source of truth).

### Phase 6: Packaging, Bonuses & Documentation
**Rationale:** Depends on Phases 4-5 having real entrypoints to containerize; React frontend and Docker packaging have no bearing on graded backend architecture so sequenced last, after the core floor is verified solid.
**Delivers:** `docker-compose.yml` (api/worker/redis services, `mem_limit: 200m` + matched `NODE_OPTIONS=--max-old-space-size` tuning), Bonus A React polling frontend, CI (lint/typecheck/test/memory-proof gate), README.md, ONBOARDING.md structured to mirror the assignment's own grading priority order.
**Addresses:** Bonus A/C, CI memory-proof gate (FEATURES.md's single highest-leverage differentiator), documentation deliverables.
**Avoids:** Pitfall 11 (Docker `mem_limit` without matching Node tuning) — requires testing the actual `docker-compose up` path against the largest fixture, not just the bare-node self-test.

### Phase Ordering Rationale

- The streaming pipeline (Phase 2) is deliberately proven in isolation before any queue/HTTP plumbing exists — it is simultaneously the highest technical risk and the top-weighted grading criterion; discovering a memory bug after full integration is expensive to isolate.
- Adapters (Phase 3) and the pipeline (Phase 2) are architecturally independent (ARCHITECTURE.md build order steps 3-4), so they could run in parallel, but are sequenced here to keep dependency chains simple for a solo 2-3 day build.
- Service/Worker wiring (Phase 4) comes only after adapters exist because `ScanProcessor` composes all of them; API surface (Phase 5) comes only after `ScanService` exists because both REST and GraphQL are thin adapters over it.
- Packaging/bonuses/docs (Phase 6) come last because they depend on stable entrypoints and have zero bearing on the graded backend architecture if done early.

### Research Flags

Needs research during planning:
- **Phase 2 (Streaming Pipeline):** stream-json's exact nested `pick`/`streamArray` composition for Trivy's real two-level array shape is non-trivial and under-documented for this specific nesting pattern (PITFALLS.md Pitfall 6) — verify against a hand-crafted fixture before scaling.
- **Phase 6 (Packaging):** Node/V8 heap tuning ratio relative to Docker `mem_limit` (PITFALLS.md Pitfall 11) needs empirical verification against the actual largest fixture in the target container, not just documentation guidance.

Phases with standard, well-documented patterns (skip research-phase):
- **Phase 1 (Foundations):** strict tsconfig and project layout are standard, well-documented TypeScript conventions.
- **Phase 3 (Trivy/Clone adapters):** execa + spawn + Trivy CLI flags are documented in STACK.md/PITFALLS.md with concrete flag references already verified.
- **Phase 4 (BullMQ/Service):** BullMQ patterns (concurrency, connections, idempotent jobs) are covered by official docs already cited in STACK.md/ARCHITECTURE.md.
- **Phase 5 (API surface):** Fastify/Mercurius integration is a documented, common pattern (single-process plugin registration).

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM | Web-search cross-checked across 2-3 independent sources per package; Context7 MCP was unavailable this session — recommend `npm view <pkg> version` spot-check before finalizing `package.json` |
| Features | MEDIUM | Web-sourced patterns cross-corroborated across 6+ sources per topic; grading weight is inferred from PROJECT.md, not externally verifiable since there's no real "competitor" data for a take-home |
| Architecture | MEDIUM | Patterns cross-corroborated across many independent sources and align with official BullMQ/Node.js/stream-json docs; individual sources are web-tier (blogs) rather than vendor-curated |
| Pitfalls | MEDIUM | Node.js stream/memory semantics and Trivy CLI flags are well-documented and cross-checked; exact numeric defaults (e.g., maxBuffer sizes) are LOW-confidence and should be verified against installed versions |

**Overall confidence:** MEDIUM

### Gaps to Address

- Context7 MCP was unavailable during STACK.md research — verify exact current versions of Fastify/Mercurius/BullMQ/ioredis/stream-json via `npm view` before locking `package.json`.
- The exact `stream-json` composition for Trivy's nested `Results[].Vulnerabilities` shape should be validated with a small hand-crafted fixture early in Phase 2, before writing the 500MB fixture generator.
- The correct heap-size-to-container-limit ratio (STACK.md/PITFALLS.md suggest 50-70% of `mem_limit`) is a rule of thumb, not a verified number for this specific workload — must be empirically tuned in Phase 6 against the actual largest fixture.
- Trivy's own memory/disk footprint when run as a local binary inside the same container as Node is not independently quantified in research — budget for it explicitly during Phase 6 memory testing rather than assuming it's negligible.

## Sources

### Primary (MEDIUM confidence — official docs, web-search-sourced)
- fastify.dev, docs.bullmq.io, uhop/stream-json GitHub README/Wiki, nodejs.org (child_process, streams/backpressure, memory tuning), trivy.dev official docs, graphql-js.org — cross-checked across STACK.md, ARCHITECTURE.md, PITFALLS.md

### Secondary (LOW-MEDIUM confidence — community/corporate blogs, cross-checked against official docs)
- OneUptime blog series (graceful shutdown, health checks, CI, Docker), nodebestpractices (docker/memory-limit.md), Red Hat Developer (Node 20+ container memory), take-home-assignment review literature (Medium/DEV Community), hexagonal architecture write-ups, PayPal GraphQL resolver best practices

### Tertiary (LOW confidence — single-source, version-sensitive claims requiring validation)
- Exact package version numbers (Fastify 5.10.0, Mercurius 16.9.0, BullMQ 5.79.3, ioredis 5.11.1, stream-json 1.9.1) — pin via `npm view` at install time
- maxBuffer default sizing and exact heap/container ratio guidance — verify against installed Node version and empirical container testing

---
*Research completed: 2026-07-09*
*Ready for roadmap: yes*
