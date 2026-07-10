# Roadmap: Code Guardian — Supply Chain Scanner

## Overview

Code Guardian is built in horizontal layers, bottom-up. We first lay strict-typed foundations (domain types, strict tsconfig, boot-time config validation, and the two-entrypoint NestJS skeleton), then prove the single pass/fail component — the stream-json parse pipeline — in isolation against a 500MB+ fixture under a 150MB heap, before any queue or HTTP exists around it. With the memory core proven, we assemble the backend scan engine (clone/Trivy adapters, BullMQ worker, ScanRepository, ScanService) with full error handling and guaranteed cleanup, then expose it over REST and GraphQL sharing one service. Finally we package the stack for docker-compose within the 200MB container budget with correlated logging and CI-gated tests, and add the React polling frontend plus the README and ONBOARDING interview-prep documentation.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundations, Domain Types & Strict Config** - Strict-typed NestJS skeleton with two entrypoints and boot-time env validation (completed 2026-07-09)
- [ ] **Phase 2: Streaming Parse Pipeline & Memory Proof** - The pass/fail core: CRITICAL-only stream parse of a 500MB+ report under a 150MB heap, gated in CI
- [ ] **Phase 3: Scan Engine — Adapters, Queue, Worker & Service** - Async clone → Trivy → parse → store pipeline with clean adapters, error handling, and guaranteed cleanup
- [ ] **Phase 4: REST + GraphQL API Surface** - Submit and poll scans over REST and GraphQL through one shared service, with health and graceful shutdown
- [ ] **Phase 5: Packaging, Ops & Test/CI Hardening** - Full stack via docker-compose within the 200MB budget, correlated logging, CI-gated tests
- [ ] **Phase 6: React Frontend & Documentation** - Browser-driven scan UI plus README and ONBOARDING interview-prep docs

## Phase Details

### Phase 1: Foundations, Domain Types & Strict Config

**Goal**: A strictly-typed NestJS 11 (Fastify adapter) skeleton exists that boots both entrypoints and refuses to run on invalid config.
**Depends on**: Nothing (first phase)
**Requirements**: TYPE-01, TYPE-02, ARCH-04, OPS-03
**Success Criteria** (what must be TRUE):

  1. `tsc --noEmit` passes under `strict: true` + `noUncheckedIndexedAccess` with zero errors, and a grep of the scan-result handling paths finds no `any`
  2. `dist/index.js` boots an HTTP API and `dist/worker.js` boots a worker-only application context with no HTTP listener, both importing the shared `ScanModule`
  3. Booting with a missing/invalid required env var exits non-zero with a clear Joi validation message; booting with valid config starts cleanly
  4. Domain models (`Scan`, `Vulnerability`, `ScanStatus` enum) and the Trivy report shape exist as explicit TypeScript interfaces used across layers

**Plans**: 2/2 plans complete
**Wave 1**

- [x] 01-01-PLAN.md — Monorepo scaffold, NestJS 11 + Fastify adapter, strict TypeScript (TS 6.0.3 pin) [TYPE-01]

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-02-PLAN.md — Domain types, two-entrypoint topology (shared ScanModule), fail-fast Joi env validation [TYPE-02, ARCH-04, OPS-03]

### Phase 2: Streaming Parse Pipeline & Memory Proof

**Goal**: The stream-json parse pipeline extracts CRITICAL-only vulnerabilities from a 500MB+ Trivy report under a 150MB heap — proven in isolation and gated in CI — before any queue/HTTP plumbing exists.
**Depends on**: Phase 1
**Requirements**: ENGINE-05, MEM-01, MEM-02, MEM-03, MEM-04
**Success Criteria** (what must be TRUE):

  1. The memory self-test runs the `ReportParser` against a 500MB+ synthetic fixture under `node --max-old-space-size=150` and exits 0 without OOM, logging peak RSS and heapUsed
  2. Peak RSS stays flat (within a small constant) across 50MB / 200MB / 500MB / 1GB fixtures — memory does not scale with input size
  3. Against a hand-crafted fixture with known mixed severities, the parser emits exactly the CRITICAL vulnerabilities and zero non-CRITICAL, using neither `fs.readFile`/`readFileSync` nor `JSON.parse` on the report
  4. The fixture generator produces a 500MB+ Trivy-shaped JSON on demand while itself staying memory-bounded (streamed to disk)
  5. A GitHub Actions CI job runs the memory self-test and fails the build on OOM

**Plans**: 2/2 plans complete

**Wave 1**

- [x] 02-01-PLAN.md — Streaming ReportParser, correctness fixture, and parser safety gate [ENGINE-05, MEM-01, MEM-04]

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 02-02-PLAN.md — Memory self-test, flat-RSS sweep, fixture tooling, and Node 22 CI gate [MEM-01, MEM-02, MEM-03, MEM-04]

### Phase 3: Scan Engine — Adapters, Queue, Worker & Service

**Goal**: An async scan runs end-to-end in the background — clone → Trivy → stream-parse → store — with clean ports-and-adapters separation, correct error handling, and guaranteed cleanup on every path.
**Depends on**: Phase 2
**Requirements**: ENGINE-01, ENGINE-02, ENGINE-03, ENGINE-04, ENGINE-06, ENGINE-07, ARCH-02, ARCH-03, ERR-01, ERR-02, ERR-03, ERR-04
**Success Criteria** (what must be TRUE):

  1. Enqueuing a job causes the worker (`concurrency: 1`) to shallow-clone the repo (argv array, no shell), run Trivy to a report file via `--output`, stream-parse it, and persist CRITICAL results — with status transitioning `Queued → Scanning → Finished` in Redis via `ScanRepository`
  2. Trivy runs whether or not a local binary is present (auto-detect with Docker fallback), and a Trivy run that merely found vulnerabilities is treated as success, not failure
  3. Clone failure, disk-full (`ENOSPC`), and mid-stream parse errors each mark the scan `Failed` with a specific reason
  4. The temp clone and report file are deleted on both success and failure paths — a forced-failure run leaves no artifacts behind
  5. `ScanService` contains no `fs`/`child_process` imports, and all I/O flows through injectable adapters (`RepoCloner`, `TrivyRunner`, `ReportParser`, `ScanRepository`)

**Plans**: TBD

### Phase 4: REST + GraphQL API Surface

**Goal**: Clients can submit and poll scans over both REST and GraphQL through one shared `ScanService`, with a health check and graceful shutdown.
**Depends on**: Phase 3
**Requirements**: SCAN-01, SCAN-02, SCAN-03, SCAN-04, SCAN-05, API-01, API-02, API-03, ARCH-01, ERR-05
**Success Criteria** (what must be TRUE):

  1. `POST /api/scan` with a valid GitHub URL returns `{ scanId, status: "Queued" }` immediately without waiting for the scan, and rejects missing/malformed/non-GitHub URLs with a 400 before anything is enqueued
  2. `GET /api/scan/:scanId` returns the current status; when `Finished` it returns the CRITICAL vulnerabilities, when `Failed` it returns an error reason, and for an unknown id it returns 404
  3. A GraphQL `scan(id)` query and an enqueue mutation return the same results as REST by delegating to the same `ScanService` (thin resolvers, no duplicated business logic)
  4. `GET /health` reports service status and Redis connectivity
  5. On SIGTERM/SIGINT the API and worker shut down gracefully, draining the worker and closing Redis connections

**Plans**: TBD

### Phase 5: Packaging, Ops & Test/CI Hardening

**Goal**: The whole stack runs from `docker compose up` within the 200MB container budget, with logging correlated by `scanId` and a CI-gated automated test suite.
**Depends on**: Phase 4
**Requirements**: OPS-01, OPS-02, OPS-04, OPS-05
**Success Criteria** (what must be TRUE):

  1. `docker compose up` starts `redis` + `api` + `worker` with no host-side Trivy/Redis install, and a submitted scan runs end-to-end (submit → poll → CRITICAL results)
  2. The worker container survives the largest fixture scan under `mem_limit: 200m` with `--max-old-space-size=150` — no OOM-kill (`docker inspect` shows `OOMKilled: false`)
  3. Log lines from both the API and the worker carry the `scanId`, so a single scan's lifecycle can be traced across the two processes
  4. CI runs lint + type-check + the test suite (ReportParser CRITICAL-filter unit test and scan API contract integration test) and fails the build on any failure

**Plans**: TBD

### Phase 6: React Frontend & Documentation

**Goal**: A reviewer can drive a scan from a browser and understand every design decision from the written documentation.
**Depends on**: Phase 5
**Requirements**: FE-01, FE-02, FE-03, DOC-01, DOC-02
**Success Criteria** (what must be TRUE):

  1. The React (Vite) app accepts a GitHub repo URL and a Start button that submits a scan + tailwind+daisyui
  2. While a scan is in progress the app polls the status endpoint every 2 seconds and shows the current state
  3. On `Finished` the app displays the CRITICAL vulnerabilities; on `Failed` it shows an error state
  4. `README.md` gives copy-paste run instructions (local dev + docker-compose), the memory self-test command, and an architecture overview
  5. `ONBOARDING.md` explains every implemented solution in What / Why / How form — memory strategy, architecture layering, queue design, error handling, and type safety

**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundations, Domain Types & Strict Config | 2/2 | Complete    | 2026-07-09 |
| 2. Streaming Parse Pipeline & Memory Proof | 2/2 | Verifying  |  |
| 3. Scan Engine — Adapters, Queue, Worker & Service | 0/TBD | Not started | - |
| 4. REST + GraphQL API Surface | 0/TBD | Not started | - |
| 5. Packaging, Ops & Test/CI Hardening | 0/TBD | Not started | - |
| 6. React Frontend & Documentation | 0/TBD | Not started | - |
