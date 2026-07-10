# Phase 4: Required REST API & Runtime Lifecycle - Context

**Gathered:** 2026-07-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Expose the already-built async scan engine over the REQUIRED REST API through the single shared `ScanService`, and add runtime lifecycle: a `/health` endpoint reporting Redis connectivity and graceful shutdown on SIGTERM/SIGINT for both processes.

Controllers are thin transport adapters containing no business logic (ARCH-01) — they delegate to `ScanService.enqueue(repoUrl)` and `ScanService.get(id)`, which already exist. The REST surface is: `POST /api/scan`, `GET /api/scan/:scanId`, `GET /health`.

This phase does NOT add GraphQL (explicitly deferred to Phase 6 / Bonus B), Docker Compose packaging, `scanId` log correlation (Phase 5, OPS-04), the React frontend, or any new engine/parser/worker behavior. It must reuse the Phase 3 `ScanService`/`ScanRepository` contracts unchanged and must not push transport concerns (URL validation, HTTP status mapping) into the service layer.

**Requirements:** SCAN-01, SCAN-02, SCAN-03, SCAN-04, SCAN-05, API-03, ARCH-01, ERR-05.

</domain>

<decisions>
## Implementation Decisions

### URL validation policy (SCAN-02)
- **D-01:** Accept **HTTPS `github.com` URLs only**: `https://github.com/{owner}/{repo}` with an optional `.git` suffix. Reject SSH (`git@github.com:...`), `git://`, `file://`, plain `http://`, and every non-GitHub host. This matches the assignment's "GitHub repository URL" wording and neutralizes non-HTTP `git clone` transports in one move.
- **D-02:** Validation is **parse-then-allowlist with path-shape enforcement** (defense-in-depth): URL-parse the input; require `protocol === 'https:'`; require `hostname` to be exactly in `{github.com, www.github.com}`; reject embedded credentials (`user:pass@`); reject non-standard ports; and require a `/{owner}/{repo}` path matching GitHub's owner/repo naming rules. Explicitly rejects look-alike hosts (`github.com.evil.com`), userinfo, odd ports, and single-segment paths.
- **D-03:** Validation lives at the **controller boundary as a DTO + `ValidationPipe`** (custom validator/refinement on the DTO), so a malformed/non-GitHub URL returns **400 before `ScanService.enqueue` is ever called**. Keeps the controller thin and `ScanService` free of transport concerns (ARCH-01, D-02 from Phase 3). The rationale (SSRF/command-injection guard) is defense-in-depth on top of the Phase 3 `shell: false` argv-array clone, which already closes shell injection.

### Response contracts (SCAN-01, SCAN-03, SCAN-04, SCAN-05)
- **D-04:** `POST /api/scan` returns **HTTP 202 Accepted** with body exactly `{ scanId, status: "Queued" }` — 202 is the precise semantic for SCAN-01's non-blocking "queued, not yet processed" contract. The response DTO maps the domain `id` field to the transport field name `scanId`; no engine work is awaited.
- **D-05:** `GET /api/scan/:scanId` returns a **state-shaped DTO at HTTP 200**: `Queued`/`Scanning` → `{ scanId, status }`; `Finished` → adds `criticalVulnerabilities: [...]`; `Failed` → adds `error: { category, detail }`. An **unknown scanId returns 404** (mapping the `null` from `ScanService.get`, per Phase 3 D-11). State-shaped (not uniform) keeps the payload lean and poll-friendly and avoids over-exposing the raw domain object.
- **D-06:** The Finished vulnerabilities field is named **`criticalVulnerabilities`** — deliberately matching the future GraphQL `type Scan { criticalVulnerabilities }` (API-01) for REST/GraphQL consistency in Phase 6.
- **D-07:** The Failed error body exposes **both `category` and `detail`**: `category` is the bounded domain enum (`clone`/`trivy`/`disk-full`/`timeout`/`parse`/`unknown`), `detail` is the ≤500-char sanitized message already produced by Phase 3 (D-20/D-21). Machine-readable + human-readable; no raw stderr/credentials/paths (already guaranteed upstream).

### Health check (API-03)
- **D-08:** `/health` performs an **active Redis `PING`** (with a short timeout, ~1s) over an **existing** connection — the BullMQ producer queue's ioredis connection or the `ScanRepository`'s client. Do NOT open a third Redis connection just for health. Active PING (not a passive `.status === 'ready'` read) catches a wedged-but-not-closed socket.
- **D-09:** `/health` returns **503 Service Unavailable when Redis is unreachable, 200 when healthy** (both with a JSON body). Keying health on the HTTP status code lets the Phase 5 docker-compose healthcheck and any load balancer act automatically.
- **D-10:** Health body includes **`{ status, redis, uptime }`** (e.g., `{ status:'ok', redis:'up', uptime:1423 }`). It does NOT probe Trivy/Docker — that is a per-scan concern, not process liveness.

### Graceful shutdown (ERR-05)
- **D-11:** On SIGTERM/SIGINT the **worker drains**: stop pulling new jobs and let the active scan run to completion via BullMQ `worker.close()`, then close Redis/repository connections and exit 0. Cleanest state — no half-done scans. (Phase 3's `try/finally` cleanup, D-23, still deletes clone/report artifacts even if a scan is force-closed.)
- **D-12:** The drain is **bounded by a configurable `SHUTDOWN_GRACE_MS`** (default ~8s, deliberately under Docker's default 10s SIGTERM→SIGKILL window). If the grace elapses, force-close (`worker.close(true)`) and exit so the process terminates cleanly before an external SIGKILL. Add `SHUTDOWN_GRACE_MS` to the Joi env schema with a safe default.
- **D-13:** Shutdown is wired through **Nest lifecycle hooks on both entrypoints**: `enableShutdownHooks()` (already present in `src/index.ts`; add to `src/worker.ts`) plus `OnApplicationShutdown`/`onModuleDestroy` in the providers that own the BullMQ worker/queue and Redis clients. Nest handles the SIGTERM/SIGINT wiring and calls hooks in order — idiomatic and unit-testable; avoid hand-rolled `process.on` handlers.
- **D-14:** The **API** shutdown path is lighter: stop accepting requests and close its queue/repository Redis handles via the same lifecycle hooks. No job-draining concern (the API is a producer, not a consumer).

### Claude's Discretion
- Exact controller/DTO file names and directory layout under `apps/api/src` (e.g., a `scan.controller.ts` + `health.controller.ts`, or a small `http/` folder), provided controllers stay thin and delegate to `ScanService`.
- The precise GitHub owner/repo naming regex, provided it enforces two path segments and rejects the look-alike/userinfo/port cases in D-02.
- Whether URL validation uses class-validator decorators, a custom `PipeTransform`, or a framework-free `validateGithubUrl()` helper the DTO calls — provided the 400-before-enqueue and thin-controller contracts hold.
- Whether `/health` is a dedicated controller or a route on an existing one; the exact PING timeout value; and which existing ioredis handle it borrows.
- The exact default value and env key casing for the shutdown grace, provided it is configurable, schema-validated, and defaults under the container SIGKILL window.
- Global vs per-controller `ValidationPipe` registration and the 400 error-envelope shape, provided malformed bodies are rejected before `ScanService`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and requirements
- `.planning/ROADMAP.md` §"Phase 4: Required REST API & Runtime Lifecycle" — phase goal, dependencies, and the 5 success criteria
- `.planning/REQUIREMENTS.md` §SCAN — SCAN-01..SCAN-05 (submit, validation, status, results/error, 404)
- `.planning/REQUIREMENTS.md` §API — API-03 (health + Redis connectivity)
- `.planning/REQUIREMENTS.md` §ARCH — ARCH-01 (thin transport adapters, one shared service)
- `.planning/REQUIREMENTS.md` §ERR — ERR-05 (graceful SIGTERM/SIGINT shutdown)
- `.planning/PROJECT.md` — memory, framework (NestJS/Fastify), two-entrypoint, and scope constraints
- `.planning/STATE.md` — carried decisions and the @nestjs/bullmq/@swc Jest landmine (see code_context)

### Prior phase contracts (the seams Phase 4 consumes)
- `.planning/phases/03-scan-engine-adapters-queue-worker-service/03-CONTEXT.md` — `ScanService` enqueue/get contract, `null`-for-unknown (D-11), bounded failure reason `{category,detail}` (D-20/D-21), `try/finally` cleanup (D-23), worker concurrency 1
- `.planning/phases/01-foundations-domain-types-strict-config/01-CONTEXT.md` — shared `ScanModule`, two-entrypoint topology, strict TypeScript, Joi env validation

### Existing implementation seams (read before writing controllers)
- `apps/api/src/scan/scan.service.ts` — `enqueue(repoUrl): Promise<Scan>` and `get(id): Promise<Scan | null>` — the ONLY methods controllers call
- `apps/api/src/scan/scan.module.ts` — shared DI module; controllers/health provider register against this
- `apps/api/src/scan/scan.repository.ts` / `scan.repository.port.ts` — ioredis client source for the `/health` PING
- `apps/api/src/domain/scan.types.ts` — `Scan`, `ScanStatus`, `ScanFailureReason {category, detail}` shapes the response DTOs map from
- `apps/api/src/domain/vulnerability.types.ts` — CRITICAL `Vulnerability` shape for `criticalVulnerabilities`
- `apps/api/src/app.module.ts` — API root module where the HTTP controllers + `ValidationPipe` get wired
- `apps/api/src/index.ts` — API entrypoint; already has `enableShutdownHooks()` + `app.listen(PORT)`
- `apps/api/src/worker.ts` / `apps/api/src/worker.module.ts` — worker entrypoint that needs `enableShutdownHooks()` + drain wiring
- `apps/api/src/config/env.validation.ts` — Joi schema to extend with `SHUTDOWN_GRACE_MS`
- `apps/api/package.json` — Node 22 engine, strict TS, test/build scripts

### Official external documentation
- `https://docs.nestjs.com/fundamentals/lifecycle-events` — `enableShutdownHooks`, `OnApplicationShutdown`, `onModuleDestroy` ordering
- `https://docs.nestjs.com/techniques/validation` — `ValidationPipe` / DTO validation for the 400-before-enqueue contract
- `https://docs.nestjs.com/techniques/performance` (Fastify adapter) — Fastify-specific request handling notes
- `https://docs.bullmq.io/guide/workers/graceful-shutdown` — `worker.close()` drain vs force-close semantics
- `https://docs.bullmq.io/guide/connections` — ioredis connection reuse for the health PING
- `https://redis.github.io/ioredis/` — `.status`, `.ping()` for the health probe

No external ADRs — the implementation decisions are captured above; cited docs define library behavior.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ScanService.enqueue`/`get` are complete and transport-agnostic — Phase 4 adds NO service logic, only controllers + DTOs + a health provider + shutdown wiring.
- `ScanService.get` already returns `null` for unknown ids (Phase 3 D-11), designed precisely for the 404 mapping in D-05.
- The domain `Scan`/`ScanFailureReason` types are the source shapes for the response DTOs — map, don't re-model.
- An ioredis connection already exists (BullMQ queue + `ScanRepository`); the `/health` PING borrows one rather than creating a new client.

### Established Patterns
- Thin transport → single shared `ScanService` (ARCH-01); no `fs`/`child_process`/URL-parsing in the service.
- Strict TypeScript, `noUncheckedIndexedAccess`, no `any` on scan-result paths.
- Joi-validated, fail-closed env config at boot (OPS-03) — the pattern to extend for `SHUTDOWN_GRACE_MS`.

### Integration Points / Constraints
- **Jest landmine (STATE.md):** `@nestjs/bullmq` in the Jest-loaded module graph triggers an `@swc/core` native miette panic on Node 22 AND 24. Phase 3 dodged it by keeping BullMQ out of unit-test source (thin `@Processor` shell + plain injectable logic; wiring validated only via a compiled `.mjs` contract). Phase 4 controller/REST-contract tests MUST plan around this — e.g. test the controller against a mocked `ScanService`, and run the full `POST → poll → Finished/Failed` integration (success criterion #5) against the **compiled** app + disposable Redis (like Phase 3's harness) rather than importing the BullMQ-wired module into Jest.
- Controllers register in `AppModule` (API root only); the worker root must never import HTTP/GraphQL modules (D-01 Phase 3).
- `SHUTDOWN_GRACE_MS` must default under Docker's 10s stop grace so Phase 5 packaging inherits a clean shutdown.

</code_context>

<specifics>
## Specific Ideas

- Response field naming is deliberate: `scanId` (not `id`) on the wire, `criticalVulnerabilities` (matches future GraphQL) — lock these in the DTOs.
- `/health` returns 503 (not 200-with-body) on Redis-down specifically so the Phase 5 docker-compose healthcheck can key off the status code.
- Prefer Nest lifecycle hooks over manual `process.on` handlers for shutdown — the API already uses `enableShutdownHooks()`.

</specifics>

<deferred>
## Deferred Ideas

- **Integration-test strategy details** (compiled-worker + disposable Redis vs in-process fake queue; CI-gating) — noted as a real design point but left to the researcher/planner; success criterion #5 requires it but the mechanism is not locked here.
- **GraphQL `scan` query + enqueue mutation** (API-01/API-02) — Phase 6 / Bonus B; must reuse this same `ScanService` and the `criticalVulnerabilities` field name.
- **`scanId` log correlation across API and worker** (OPS-04) — Phase 5.
- **Docker Compose packaging + container memory gate + healthcheck wiring** (OPS-01/02) — Phase 5.
- **CORS for the React frontend** (FE-01..03) — Phase 6; only if the app is served from a different origin.
- **Rate limiting / auth / request-dedup** — out of scope (v2 SCALE / Out-of-Scope in REQUIREMENTS.md).

</deferred>

---

*Phase: 4-Required REST API & Runtime Lifecycle*
*Context gathered: 2026-07-10*
