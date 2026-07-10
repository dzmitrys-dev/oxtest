# Phase 3: Scan Engine - Adapters, Queue, Worker & Service - Context

**Gathered:** 2026-07-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver the required background scan engine behind the existing shared `ScanModule`: enqueue a typed scan job, run a worker with concurrency 1 through clone -> Trivy -> stream parser -> Redis persistence, isolate infrastructure behind injectable ports/adapters, preserve specific failure reasons, and remove temporary clone/report artifacts on every path.

This phase does not add REST/GraphQL transport, URL validation, health endpoints, graceful API lifecycle, Docker Compose packaging, or frontend work. The Phase 2 `ReportParser` remains the streaming parser contract and must be reused rather than replaced.

</domain>

<decisions>
## Implementation Decisions

### Carry-forward architecture and boundaries
- **D-01:** Keep NestJS 11 on Fastify with the existing two-entrypoint topology. `src/worker.ts` must remain worker-only and must not load HTTP or GraphQL modules.
- **D-02:** `ScanService` only orchestrates queue submission and full scan reads. It must not import `fs`, `child_process`, Docker, or Trivy implementation details.
- **D-03:** Infrastructure is accessed through injectable ports/adapters for `RepoCloner`, `TrivyRunner`, `ReportParser`, `ScanRepository`, and cleanup. Port interfaces remain framework- and infrastructure-free.
- **D-04:** Reuse `apps/api/src/parser/report-parser.ts` and its async-generator API. The worker consumes one yielded CRITICAL vulnerability at a time and never buffers the report.
- **D-05:** The worker uses one typed BullMQ job payload containing `scanId` and `repoUrl`, with `@Processor`/`WorkerHost` concurrency set to 1. The domain status in Redis is authoritative and independent of BullMQ job state.
- **D-06:** Use Node 22-compatible CommonJS dependencies and preserve the existing strict TypeScript/no-`any` conventions.

### Redis retention and repository contract
- **D-07:** Store scan metadata in a Redis hash and CRITICAL vulnerabilities in an ordered Redis list. Repository reads reconstruct one complete `Scan` and preserve parser/discovery order.
- **D-08:** A completed, failed, or active scan record has a seven-day TTL. Refresh the TTL on every status or vulnerability write rather than setting it only at enqueue time.
- **D-09:** Status transitions and their TTL refresh must use an atomic Redis transaction or script. Do not leave a transition and its expiry update as unrelated best-effort commands.
- **D-10:** Repository methods guard terminal states so a late or duplicate worker cannot overwrite `Finished` or `Failed`; the single worker concurrency setting is not the only correctness protection.
- **D-11:** A missing `scan:<id>` hash returns `null` from the domain repository. It is not synthesized as `Failed` and is not treated as an internal exception; Phase 4 can map `null` to HTTP 404.
- **D-12:** Expose one full `get(id)` read contract for this phase. Do not split metadata and vulnerability reads prematurely for a future optimization.

### Trivy execution and Docker fallback
- **D-13:** The Trivy Docker fallback uses a reviewed, explicitly pinned image tag selected during research/planning. Do not use `latest`.
- **D-14:** Prefer a local `trivy` binary. If it is present but cannot launch due to an infrastructure/launch error, fall back to Docker; do not rerun Docker after a genuine scan execution failure that produced a meaningful Trivy error.
- **D-15:** Local and Docker commands use discrete argv values with `shell: false`; never construct a shell command string or use a shell-buffering `exec` path.
- **D-16:** The Docker command mounts the unique host clone directory read-only at a container path such as `/src`, mounts the host report parent writable at a path such as `/out`, and tells Trivy to write `/out/<report-file>` using `--output`. The exact path mapping must be tested.
- **D-17:** Docker fallback uses an ephemeral per-scan Trivy cache. Do not introduce a persistent cache volume in this phase.
- **D-18:** Trivy receives JSON format, file output, no-progress behavior, and `--exit-code 0`. Vulnerability findings are a successful scan; only genuine command/launch/report failures fail the scan.

### Failure semantics
- **D-19:** Do not configure automatic BullMQ retries/backoff for Phase 3. On the first engine failure, persist `Failed`, rethrow so BullMQ records the failure, and leave retry policy for a future phase.
- **D-20:** Persist a bounded, sanitized category plus detail, capped at 500 characters. Categories must distinguish at least clone failure, Trivy failure, disk full (`ENOSPC`), and report parse failure.
- **D-21:** Keep more detailed subprocess stderr and cleanup diagnostics in worker logs, but do not expose raw stderr, credentials, or uncontrolled filesystem details through Redis scan state.
- **D-22:** If cleanup fails after an original scan failure, preserve the original failure category/detail as the persisted reason and log cleanup as a secondary diagnostic.
- **D-23:** Mark `Scanning` before engine work, append and await each CRITICAL result, mark `Finished` only after parser completion and all appends, and route every clone/Trivy/disk/parser failure through `Failed` plus cleanup.

### Integration-test contract
- **D-24:** The integration harness uses a committed small local repository fixture rather than cloning a live GitHub repository, avoiding network/rate-limit/mutable-content flakiness.
- **D-25:** The required end-to-end path exercises the Docker Trivy fallback, not only a host-installed Trivy binary. Tests must verify the host/container mount contract and report-file visibility.
- **D-26:** Provision Redis as a disposable service container for the integration command. The compiled `dist/worker.js` process communicates through BullMQ/Redis rather than being replaced by an in-process worker in the primary integration path.
- **D-27:** Failure-path tests inject clone, disk, Trivy, and parser failures through adapter seams while still exercising the real worker lifecycle and Redis state transitions. Fault injection must be deterministic, not dependent only on broken external containers.
- **D-28:** Assert the full lifecycle: `Queued -> Scanning -> Finished` or `Queued -> Scanning -> Failed`, the bounded category/detail reason, and absence of clone/report artifacts after every success and failure path.
- **D-29:** Make the Docker-backed integration suite a required GitHub Actions gate if it is feasible within free GitHub-hosted runner limits. If not feasible, retain a named explicit integration command, invoke it when possible, and document the runner limitation without weakening the assertions.

### the agent's Discretion
- Exact injection token names, directory/file names within `apps/api/src/engine`, queue name, and BullMQ prefix.
- Exact Redis hash/list field names and whether atomic writes use `MULTI/EXEC` or a Lua script, provided the D-07 through D-12 contract is met.
- The reviewed Trivy image tag, after checking current official Trivy release documentation and compatibility with the selected command.
- The exact normalized category vocabulary and redaction implementation, provided reasons are bounded, sanitized, specific, and preserve the original failure over cleanup errors.
- Whether adapter tests use Execa or Node `execFile`, provided argv arrays, `shell: false`, bounded diagnostics, and no report stdout buffering are preserved.
- The disposable Redis container command and test runner wiring, provided the compiled worker boundary remains covered.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and requirements
- `.planning/ROADMAP.md` §"Phase 3: Scan Engine - Adapters, Queue, Worker & Service" - phase goal, dependencies, requirements, and success criteria
- `.planning/REQUIREMENTS.md` §ENGINE - ENGINE-01, ENGINE-02, ENGINE-03, ENGINE-04, ENGINE-06, ENGINE-07
- `.planning/REQUIREMENTS.md` §ARCH - ARCH-02 and ARCH-03
- `.planning/REQUIREMENTS.md` §ERR - ERR-01, ERR-02, ERR-03, and ERR-04
- `.planning/PROJECT.md` - memory, subprocess, Redis, NestJS, and scope constraints
- `.planning/STATE.md` - Phase 1/2 decisions and known constraints carried into Phase 3

### Phase research and prior contracts
- `.planning/phases/03-scan-engine-adapters-queue-worker-service/03-RESEARCH.md` - researched architecture, package guidance, failure/cleanup pitfalls, and official source URLs
- `.planning/phases/02-streaming-parse-pipeline-memory-proof/02-CONTEXT.md` - async-generator parser contract and forbidden report APIs
- `.planning/phases/02-streaming-parse-pipeline-memory-proof/02-RESEARCH.md` - verified stream-json deep-leaf pipeline and memory constraints
- `.planning/phases/02-streaming-parse-pipeline-memory-proof/02-PATTERNS.md` - parser and test patterns to reuse
- `.planning/phases/02-streaming-parse-pipeline-memory-proof/02-VERIFICATION.md` - evidence for the existing parser/memory gate
- `.planning/phases/01-foundations-domain-types-strict-config/01-CONTEXT.md` - shared ScanModule, domain types, strict TypeScript, and two-entrypoint decisions

### Existing implementation seams
- `apps/api/src/scan/scan.module.ts` - shared DI module to replace the in-memory stub without creating a parallel module
- `apps/api/src/scan/scan.store.ts` - Phase 1 in-memory persistence stub to replace with the Redis repository contract
- `apps/api/src/worker.module.ts` - worker-only root module and configuration boundary
- `apps/api/src/worker.ts` - worker-only application-context entrypoint
- `apps/api/src/parser/report-parser.ts` - existing CRITICAL-only async-generator parser
- `apps/api/src/domain/scan.types.ts` - `Scan` and `ScanStatus` domain types
- `apps/api/src/domain/vulnerability.types.ts` - CRITICAL-only `Vulnerability` output type
- `apps/api/src/domain/trivy-report.types.ts` - minimal Trivy input shape
- `apps/api/src/config/env.validation.ts` - required Redis/temp configuration keys
- `apps/api/package.json` - Node 22 engine, scripts, dependency pins, and test/build conventions

### Official external documentation
- `https://docs.bullmq.io/guide/nestjs` - Nest BullMQ registration and `@Processor`/`WorkerHost`
- `https://docs.bullmq.io/guide/workers` - worker processing, failure behavior, and error listeners
- `https://docs.bullmq.io/guide/workers/concurrency` - concurrency semantics
- `https://docs.bullmq.io/guide/connections` - ioredis retry options, duplicate blocking connections, and key-prefix constraints
- `https://nodejs.org/api/child_process.html` - argv-safe subprocess APIs, shell behavior, and buffering risks
- `https://nodejs.org/api/stream.html#streampromisespipeline` - promise rejection and stream error propagation
- `https://trivy.dev/latest/docs/references/configuration/cli/trivy_filesystem/` - JSON output, `--output`, and `--exit-code`
- `https://github.com/sindresorhus/execa#readme` - direct subprocess invocation and diagnostic handling

No external ADRs - the implementation decisions are captured above and the cited official docs define library behavior.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/api/src/parser/report-parser.ts`: framework-free async generator yielding one mapped CRITICAL `Vulnerability` at a time; consume directly in the worker.
- `apps/api/src/domain/*.types.ts`: existing framework-free `Scan`, `ScanStatus`, `Vulnerability`, and Trivy report types; extend only when the queue/repository contract requires a concrete field.
- `apps/api/src/scan/scan.module.ts`: existing shared DI seam imported by both `AppModule` and `WorkerModule`; replace `ScanStore` wiring here.
- Existing strict TypeScript, Jest/SWC, lint, and build scripts in `apps/api/package.json`.

### Established Patterns
- NestJS module/provider DI with no HTTP/GraphQL dependencies in worker code.
- Node 22/CommonJS build and strict typing with `noUncheckedIndexedAccess`.
- Phase 2 mechanical prohibition against `fs.readFile`, `readFileSync`, `JSON.parse`, and `.toArray(` on the report parser path.
- Explicit memory discipline: report output goes to disk, parsing is streamed, and only CRITICAL results accumulate in Redis.

### Integration Points
- `ScanModule` must expose repository, service, parser, adapter, and token providers to the API and worker roots without loading transport-only modules in the worker.
- `WorkerModule` must register the BullMQ worker and Redis worker connection while the API root later consumes the same service/queue seam.
- `apps/api/src/worker.ts` must bootstrap the compiled worker process and allow Nest/BullMQ shutdown hooks to close connections.
- Phase 4 will consume the `ScanService` enqueue/get contract, so Phase 3 should avoid transport-specific DTOs and HTTP status decisions.

</code_context>

<specifics>
## Specific Ideas

- Keep the primary integration test reproducible: committed local fixture repository, disposable Redis, Docker Trivy fallback, and compiled `dist/worker.js`.
- Use ordered Redis list append semantics so vulnerability output matches parser discovery order.
- Treat Trivy findings as a successful scan by forcing `--exit-code 0`; do not let the presence of vulnerabilities masquerade as an execution failure.
- Treat cleanup as a `finally` obligation and preserve the first meaningful failure reason if cleanup also fails.

</specifics>

<deferred>
## Deferred Ideas

- REST URL validation, HTTP response DTOs, 404 mapping, health endpoint, and API/worker graceful lifecycle polish - Phase 4.
- BullMQ automatic retry/backoff, deduplication, timeouts, and dead-letter policy - deferred beyond this phase (retry policy is explicitly not added here).
- Docker Compose packaging and container memory gate - later packaging/bonus scope.
- GraphQL, React frontend, README, and ONBOARDING documentation - later phases.
- Persistent Trivy cache volume and long-term Redis retention management beyond the locked seven-day TTL - future operational work.

</deferred>

---

*Phase: 3-Scan Engine - Adapters, Queue, Worker & Service*
*Context gathered: 2026-07-10*
