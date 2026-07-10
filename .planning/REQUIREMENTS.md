# Requirements: Code Guardian — Supply Chain Scanner

**Defined:** 2026-07-09
**Core Value:** The service must process a 500MB+ Trivy JSON report without OOM under `node --max-old-space-size=150` — memory efficiency is the explicit pass/fail criterion.

## v1 Requirements

Requirements for the submission. Each maps to exactly one roadmap phase.

### Scan API (SCAN)

- [x] **SCAN-01**: Client can `POST /api/scan` with a GitHub repository URL and receive `{ scanId, status: "Queued" }` immediately, without waiting for the scan to run (non-blocking)
- [x] **SCAN-02**: `POST /api/scan` validates the body — rejects missing/malformed URLs and non-GitHub hosts with a 400 before any work is enqueued (SSRF/command-injection guard)
- [x] **SCAN-03**: Client can `GET /api/scan/:scanId` and receive the current status (`Queued` | `Scanning` | `Finished` | `Failed`)
- [x] **SCAN-04**: When status is `Finished`, `GET /api/scan/:scanId` returns the list of CRITICAL vulnerabilities; when `Failed`, it returns an error reason
- [x] **SCAN-05**: `GET /api/scan/:scanId` for an unknown scanId returns 404

### Scan Engine / Worker (ENGINE)

- [x] **ENGINE-01**: A background worker consumes queued scan jobs via BullMQ (`@Processor`/`WorkerHost`) with `concurrency: 1`, decoupled from the API process
- [x] **ENGINE-02**: The worker clones the target repository into a unique temp directory (shallow clone) using a subprocess invoked with an argv array (no shell interpolation)
- [x] **ENGINE-03**: The worker runs Trivy against the cloned repo, writing the JSON report to a file via Trivy's `--output` flag (never buffering scan stdout in memory)
- [x] **ENGINE-04**: The worker auto-detects a local `trivy` binary and falls back to the Docker image when absent
- [x] **ENGINE-05**: The worker stream-parses the report with stream-json using a memory-flat deep leaf `Pick` plus object-by-object filtering, storing ONLY `Severity === "CRITICAL"` vulnerabilities — never using `fs.readFile` or `JSON.parse` on the report
- [x] **ENGINE-06**: Scan status transitions (`Queued → Scanning → Finished/Failed`) are persisted in Redis via a `ScanRepository`, independent of BullMQ's internal job state
- [x] **ENGINE-07**: The cloned repo and JSON report file are deleted after processing on BOTH success and failure paths (`try/finally`, idempotent)

### Memory Efficiency (MEM)

- [x] **MEM-01**: A fixture generator produces a synthetic Trivy-shaped JSON report of 500MB+ on demand (streamed to disk, itself memory-bounded)
- [x] **MEM-02**: A self-test script runs the parse pipeline against the 500MB fixture under `node --max-old-space-size=150` and exits 0 without OOM, logging peak RSS and heapUsed
- [x] **MEM-03**: The memory self-test runs as a GitHub Actions CI job, failing the build on OOM (turns the pass/fail claim into a reproducible gate)
- [x] **MEM-04**: The parse pipeline holds at most one vulnerability object in memory at a time (verified by flat RSS across increasing fixture sizes), and accumulates only CRITICAL results

### Architecture (ARCH)

- [x] **ARCH-01**: REST controllers and GraphQL resolvers are thin transport adapters containing no business logic — both delegate to a single shared `ScanService`
- [x] **ARCH-02**: `ScanService` only orchestrates (enqueue jobs, read status) and never touches `fs` or `child_process` directly
- [x] **ARCH-03**: Infrastructure concerns are isolated behind injectable adapters (`RepoCloner`, `TrivyRunner`, `ReportParser`, `ScanRepository`)
- [x] **ARCH-04**: The app has two entrypoints sharing one `ScanModule`: `src/index.ts` (API, HTTP listener → `dist/index.js`) and `src/worker.ts` (worker-only via `createApplicationContext`, no HTTP listener)

### Error Handling (ERR)

- [x] **ERR-01**: A Trivy non-zero exit is interpreted correctly — "vulnerabilities found" is a success path, a genuine tool failure marks the job `Failed` with a captured reason
- [x] **ERR-02**: Clone failure (invalid/private/nonexistent repo) marks the job `Failed` with a clear reason and still cleans up
- [x] **ERR-03**: Disk-full (`ENOSPC`) during clone/scan is caught, marks the job `Failed`, and cleanup runs
- [x] **ERR-04**: A mid-stream parse error propagates through `stream/promises` `pipeline()` (no swallowed errors), marks `Failed`, and cleans up
- [x] **ERR-05**: The service shuts down gracefully on SIGTERM/SIGINT — draining/closing the worker and Redis connections

### Type Safety (TYPE)

- [x] **TYPE-01**: `tsconfig` is strict (`strict: true`, `noUncheckedIndexedAccess`) and the codebase contains no `any` on scan-result handling paths
- [x] **TYPE-02**: Trivy report shapes and domain models (`Scan`, `Vulnerability`, status enum) are expressed as explicit TypeScript types/interfaces; GraphQL `@ObjectType()` classes double as typed domain models

### API Surface (API)

- [ ] **API-01**: A GraphQL endpoint exposes `scan(id)` query returning `type Scan { id: ID!, status: String!, criticalVulnerabilities: [Vulnerability] }` (code-first, MercuriusDriver)
- [ ] **API-02**: A GraphQL mutation enqueues a scan (parity with `POST /api/scan`), delegating to the same `ScanService`
- [x] **API-03**: A health endpoint (`GET /health`) reports service + Redis connectivity

### Frontend (FE)

- [ ] **FE-01**: A React app (Vite) accepts a repo URL and a "Start" button that calls the scan endpoint
- [ ] **FE-02**: The app polls the status endpoint every 2 seconds while the scan is in progress
- [ ] **FE-03**: The app displays the CRITICAL vulnerabilities when status becomes `Finished`, and an error state on `Failed`

### Operations & Packaging (OPS)

- [x] **OPS-01** *(Bonus C)*: `docker-compose.yml` defines `redis`, `api`, and `worker` services; the worker container sets `mem_limit: 200m` and runs `node --max-old-space-size=150 dist/worker.js`
- [x] **OPS-02** *(Bonus C)*: The full stack (submit scan → poll → results) works end-to-end via `docker compose up` with no host-side Trivy/Redis install required
- [x] **OPS-03**: `.env` configuration is schema-validated at boot (Joi via `@nestjs/config`); the app refuses to start on invalid/missing config
- [x] **OPS-04**: Structured logging correlates log lines to a `scanId` across API and worker
- [x] **OPS-05**: An automated test suite covers the ReportParser CRITICAL-filter (unit) and the scan API contract (integration); CI runs lint + type-check + tests

### Documentation (DOC)

- [ ] **DOC-01**: `README.md` gives copy-paste run instructions (local dev + docker-compose), the memory self-test command, and architecture overview
- [ ] **DOC-02**: `ONBOARDING.md` explains every implemented solution in "What / Why / How" form as interview-prep — memory strategy, architecture layering, queue design, error handling, type safety, each anticipating reviewer questions

## v2 Requirements

Deferred — acknowledged but not in this submission's roadmap.

### Scale & Resilience

- **SCALE-01**: Deduplicate concurrent scan requests for the same repo URL (shared BullMQ `jobId`)
- **SCALE-02**: Per-job timeout and retry/backoff policy with dead-letter handling
- **SCALE-03**: Pagination of vulnerability results for very large CRITICAL sets

### Developer Experience

- **DX-01**: OpenAPI/Swagger documentation for the REST surface
- **DX-02**: End-to-end test driving the React frontend against a live stack

## Out of Scope

| Feature | Reason |
|---------|--------|
| Authentication / authorization | Not requested; adds scope with zero payoff against the stated rubric |
| Persistent SQL/NoSQL database | Redis suffices for job state + CRITICAL results; keeps the run story simple |
| Multi-tenancy | Single-purpose take-home; no payoff against rubric |
| Kubernetes manifests / liveness-readiness probe split | Assignment simulates a small pod via Docker `mem_limit`; real orchestration is beyond scope |
| Storing non-CRITICAL severities | Assignment explicitly says store ONLY CRITICAL |
| Scanning non-GitHub sources | Assignment specifies GitHub repository URLs |
| BullMQ sandboxed (child-process) processors | Per-job process spawn duplicates V8 heap — too risky under the 150–200MB budget |

## Traceability

Every v1 requirement maps to exactly one phase. See `.planning/ROADMAP.md` for phase detail.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SCAN-01 | Phase 4 | Complete |
| SCAN-02 | Phase 4 | Complete |
| SCAN-03 | Phase 4 | Complete |
| SCAN-04 | Phase 4 | Complete |
| SCAN-05 | Phase 4 | Complete |
| ENGINE-01 | Phase 3 | Complete |
| ENGINE-02 | Phase 3 | Complete |
| ENGINE-03 | Phase 3 | Complete |
| ENGINE-04 | Phase 3 | Complete |
| ENGINE-05 | Phase 2 | Complete |
| ENGINE-06 | Phase 3 | Complete |
| ENGINE-07 | Phase 3 | Complete |
| MEM-01 | Phase 2 | Complete |
| MEM-02 | Phase 2 | Complete |
| MEM-03 | Phase 2 | Complete |
| MEM-04 | Phase 2 | Complete |
| ARCH-01 | Phase 4 | Complete |
| ARCH-02 | Phase 3 | Complete |
| ARCH-03 | Phase 3 | Complete |
| ARCH-04 | Phase 1 | Complete |
| ERR-01 | Phase 3 | Complete |
| ERR-02 | Phase 3 | Complete |
| ERR-03 | Phase 3 | Complete |
| ERR-04 | Phase 3 | Complete |
| ERR-05 | Phase 4 | Complete |
| TYPE-01 | Phase 1 | Complete |
| TYPE-02 | Phase 1 | Complete |
| API-01 | Phase 6 (Bonus B) | Pending |
| API-02 | Phase 6 (Bonus B) | Pending |
| API-03 | Phase 4 | Complete |
| FE-01 | Phase 6 | Pending |
| FE-02 | Phase 6 | Pending |
| FE-03 | Phase 6 | Pending |
| OPS-01 | Phase 5 (pulled forward, Bonus C) | Complete |
| OPS-02 | Phase 5 (pulled forward, Bonus C) | Complete |
| OPS-03 | Phase 1 | Complete |
| OPS-04 | Phase 5 | Complete |
| OPS-05 | Phase 5 | Complete |
| DOC-01 | Phase 6 | Pending |
| DOC-02 | Phase 6 | Pending |

**Coverage:**

- v1 requirements: 40 total (the earlier "39" header was a miscount — there are 40 distinct requirement IDs)
- Mapped to phases: 40 (100%)
- Unmapped: 0

**Per-phase counts:** Phase 1 → 4, Phase 2 → 5, Phase 3 → 12, Phase 4 → 8, Phase 5 → 4 (OPS-04, OPS-05 + OPS-01/OPS-02 pulled forward per CONTEXT D-04), Phase 6 → 7 (GraphQL, frontend, and docs requirements).

---
*Requirements defined: 2026-07-09*
*Last updated: 2026-07-09 after roadmap creation (traceability + coverage populated)*
