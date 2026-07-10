# Code Guardian — Supply Chain Scanner

## What This Is

A high-performance Node.js/TypeScript backend service that wraps the Trivy security scanner: submit a GitHub repository URL, get an async scan that clones the repo, runs Trivy, and stream-parses massive (500MB+) JSON reports to extract CRITICAL vulnerabilities — all inside a 256MB RAM constraint. Built as a senior backend engineer take-home assignment where the deliverable is a best-in-class public GitHub repo plus an interview-prep onboarding document explaining every solution in "What, why, how" form.

## Core Value

The service must process a 500MB+ Trivy JSON report without OOM under `node --max-old-space-size=150` — memory efficiency is the explicit pass/fail criterion; everything else is quality signal on top.

## Requirements

### Validated

Requirements validated through Phase 4 (see `.planning/REQUIREMENTS.md` for per-ID traceability):

- Phase 1 — strict NestJS 11 / Fastify skeleton, two-entrypoint topology (AppModule + WorkerModule sharing ScanModule), fail-fast Joi config, framework-free domain types (TYPE-01, TYPE-02, ARCH-04, OPS-03)
- Phase 2 — streaming deep-leaf CRITICAL parser + memory self-test proof: flat RSS on a 500MB+ fixture under a 150MB heap (no `fs.readFile`/`JSON.parse` on scan results)
- Phase 3 — scan engine: clone → Trivy → stream-parse CRITICAL → guaranteed cleanup, driven by a BullMQ/Redis worker through one shared `ScanService`
- Phase 4 — required REST surface (`POST /api/scan`, `GET /api/scan/:scanId`, `GET /health`) through the shared `ScanService`, thin controllers (ARCH-01), and bounded graceful shutdown + Redis teardown on both entrypoints (SCAN-01..05, API-03, ARCH-01, ERR-05); proven by a compiled-process integration harness

### Active

- [x] `POST /api/scan` — accepts GitHub repo URL, returns `scanId` + `Queued` immediately (non-blocking) — Phase 4
- [x] Background worker: clone repo → run Trivy → JSON report to disk — Phase 3
- [x] Stream-parse report (stream-json/bfj) — extract and store only `Severity: "CRITICAL"` vulnerabilities — Phase 2/3
- [x] Cleanup: cloned repo and JSON file deleted after processing (success AND failure paths) — Phase 3
- [x] `GET /api/scan/:scanId` — returns status (`Queued` | `Scanning` | `Finished` | `Failed`) + critical vulns when finished — Phase 4
- [x] BullMQ + Redis job queue (retries, concurrency control, restart survival) — Phase 3
- [x] Clean Controller / Service / Worker separation — Phase 4 (ARCH-01, import-guard enforced)
- [ ] Robust error handling: Trivy failure, disk full, invalid repo URL, clone failure — core paths (invalid URL, clone failure) done in Phase 3/4; Trivy/disk-full ops hardening in Phase 5
- [x] Strict TypeScript — no `any`, proper interfaces for Trivy report shapes — Phase 1+ (ongoing, enforced)
- [x] Memory self-test proof: runnable script demonstrating the pipeline under `--max-old-space-size=150` with a huge fixture — Phase 2
- [ ] Bonus A (optional after core): React frontend — repo URL input, 2s status polling, results display
- [ ] Bonus B (optional after core): GraphQL API alongside REST (`type Scan { id, status, criticalVulnerabilities }`)
- [ ] Bonus C (optional after core, with acceptance evidence): `docker-compose.yml` with `mem_limit: 200m` on the app container
- [ ] README.md with run instructions
- [ ] ONBOARDING.md — interview-prep doc: every solution explained as What / Why / How

### Out of Scope

- Authentication/authorization — not requested; take-home scope
- Persistent database (Postgres etc.) — Redis suffices for job state + results; keeps the run story simple
- Horizontal scaling / K8s manifests — assignment simulates a small pod via Docker mem_limit; real orchestration is beyond scope
- Scanning non-GitHub sources — assignment specifies GitHub repository URLs
- Full vulnerability severity spectrum storage — assignment explicitly says store ONLY CRITICAL

## Context

- Take-home assignment for a Senior Backend Engineer role; focus areas graded: Memory Management (OOM), Streams, System Architecture
- Evaluation criteria (in priority order): 1) Memory efficiency — pass/fail (stream pipeline vs loading file), 2) Architecture — Controller/Service/Worker separation, 3) Error handling — Trivy fails? disk full?, 4) Type safety — no `any`, 5) forbidden `fs.readFile`/`JSON.parse` on scan results, 6) Node.js Streams line-by-line/object-by-object parsing
- Suggested test target: OWASP NodeGoat fork; real Trivy output on it is small, so a fixture generator producing a 500MB+ synthetic Trivy-shaped JSON is needed to honestly demonstrate the memory claim
- Reviewer self-test documented in the assignment: `node --max-old-space-size=150 dist/index.js` — must run smoothly
- Submission: public GitHub repository + README with run instructions

## Constraints

- **Memory**: 256MB RAM assumption; self-test at 150MB heap; Docker `mem_limit: 200m` — the defining constraint of the whole design
- **Forbidden APIs**: `fs.readFile` and `JSON.parse` on scan results — must use Node.js streams (stream-json or bfj)
- **Tech stack**: NestJS 11 (TypeScript) on the Fastify adapter — Module/Controller/Provider model directly demonstrates the graded Controller/Service/Worker separation; `@nestjs/bullmq` for the queue, code-first GraphQL via MercuriusDriver, stream-json for parsing. API entry named `src/index.ts` → `dist/index.js` to match the assignment's self-test command verbatim.
- **Timeline**: 2–3 days to submission
- **Runnability**: Reviewer must be able to run everything from README alone — docker-compose path must work end-to-end

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| NestJS 11 on Fastify adapter as the framework | Its Module/Controller/Provider model IS the graded Controller/Service/Worker separation — framework-enforced clean architecture legible to a reviewer at a glance; DI shares one ScanService across REST + GraphQL + worker. Fastify adapter keeps per-request memory lean and pairs with the Mercurius GraphQL driver | — Pending |
| Two NestJS entrypoints sharing ScanModule | `src/index.ts` (API: `NestFactory.create`+`listen`) and `src/worker.ts` (`createApplicationContext`, no HTTP listener, `@Processor concurrency:1`) — separate docker-compose containers, each memory-sized independently; worker never loads GraphQL/Apollo (dead heap) | — Pending |
| BullMQ + Redis for background jobs | Production-grade queue shows senior-level design: retries, concurrency, restart survival; Redis rides along in docker-compose. `@nestjs/bullmq` v11 `@Processor`/`WorkerHost` | — Pending |
| Ship REST first; add GraphQL only after the required path is complete | REST is required by the assignment; GraphQL earns Bonus B and must reuse the same service layer without delaying the core flow | — Pending |
| Trivy invocation: auto-detect local binary, fall back to Docker image | Most reviewer-friendly — works whether or not they installed Trivy | — Pending |
| Bonus scope is gated after the required backend | React, GraphQL, and Docker are valuable quality signals but must not displace the required REST/worker/cleanup/error-handling path | — Pending |
| Synthetic 500MB fixture generator for memory proof | Real NodeGoat scan output is far below 500MB; honest demonstration requires a huge Trivy-shaped fixture | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-07-10 — Phase 4 (Required REST API & Runtime Lifecycle) complete: clients submit and poll scans over `POST /api/scan` / `GET /api/scan/:scanId` through one shared `ScanService` with thin controllers (ARCH-01), `GET /health` Redis liveness, and bounded graceful shutdown + Redis teardown on both entrypoints — proven end-to-end by a compiled-process integration harness (success criterion #5, 9/9 green incl. a real Docker Trivy scan of the pinned CVEs). Phases 1–4 (the entire required backend) are validated; SCAN-01..05, API-03, ARCH-01, ERR-05 complete. Next priority: Phase 5 (Packaging, Ops & Assignment Acceptance) — docker compose within the 200MB budget, scanId-correlated logs, and CI gating the assignment self-test. GraphQL, React, and Docker-bonus polish remain optional scope after the required path. An advisory Phase 4 code review (04-REVIEW.md) logged 3 non-blocking robustness warnings (URL pipe raw-string forwarding, SHUTDOWN_GRACE_MS max vs Docker window, missing REDIS_CLIENT error listener) — address via `/gsd-code-review 4 --fix` or fold into Phase 5.*
