# Phase 3: Scan Engine — Adapters, Queue, Worker & Service - Pattern Map

**Mapped:** 2026-07-10
**Files analyzed:** 20 planned/modified files and 18 existing analogs
**Analogs found:** 16 / 20 (exact or role-match); 4 have no close implementation analog

## Scope and file inventory

The phase context/research imply the following deliverables. Names inside `engine/` are discretionary, but the symbols and boundaries are locked:

- **modify** `apps/api/package.json` — BullMQ/Nest BullMQ, ioredis, and subprocess dependency pins; scripts for engine tests/integration.
- **modify** `package-lock.json` — workspace dependency lock result.
- **modify** `apps/api/src/domain/scan.types.ts` — only if the repository/queue contract needs a concrete failure-reason shape or vulnerability storage field.
- **new** `apps/api/src/scan/scan.repository.port.ts` — framework-free `ScanRepository` port.
- **new** `apps/api/src/scan/scan.repository.ts` — Redis hash/list implementation with atomic status + TTL writes.
- **new** `apps/api/src/scan/scan.service.ts` — enqueue and full `get(id)` orchestration; no filesystem/subprocess imports.
- **new** `apps/api/src/scan/scan.types.ts` or `apps/api/src/engine/scan-job.types.ts` — typed `{ scanId, repoUrl }` BullMQ payload (choose one location, do not duplicate).
- **modify** `apps/api/src/scan/scan.module.ts` — replace `ScanStore` provider/export with repository, service, parser, adapter, and token wiring.
- **new** `apps/api/src/engine/repo-cloner.port.ts` — framework-free clone contract.
- **new** `apps/api/src/engine/repo-cloner.adapter.ts` — shallow argv-safe `git clone` into the supplied cloneDir; it does not generate temp directories or report paths.
- **new** `apps/api/src/engine/scan-path-allocator.port.ts` — framework-free contract for exclusive cloneDir/reportPath allocation under SCAN_TMP_DIR and partial-allocation cleanup ownership.
- **new** `apps/api/src/engine/scan-path-allocator.adapter.ts` — sole allocator of both paths under SCAN_TMP_DIR, including cleanup of partial allocation failures before allocate returns or rejects.
- **new** `apps/api/src/engine/trivy-runner.port.ts` — framework-free Trivy execution contract.
- **new** `apps/api/src/engine/trivy-runner.adapter.ts` — local binary detection and pinned Docker fallback.
- **new** `apps/api/src/engine/temp-artifact-cleaner.ts` — idempotent clone/report cleanup adapter.
- **new** `apps/api/src/engine/scan-error.ts` — bounded category/detail normalization and redaction.
- **new** `apps/api/src/engine/scan-worker.ts` — `@Processor`/`WorkerHost`, typed job, concurrency 1, sequential lifecycle.
- **modify** `apps/api/src/worker.module.ts` — BullMQ queue/worker registration while remaining HTTP/GraphQL-free.
- **modify** `apps/api/src/worker.ts` — retain worker-only `createApplicationContext`; ensure shutdown keeps BullMQ/Redis lifecycle.
- **modify** `apps/api/src/app.module.ts` — likely only through shared `ScanModule`; do not import worker root or transport in this phase.
- **new** `apps/api/src/engine/*.spec.ts` and/or `apps/api/src/scan/*.spec.ts` — adapter, repository, service, and worker lifecycle tests with fakes.
- **new** committed local repository fixture and a Docker/Redis-backed integration harness — exact location/name is discretionary; keep it separate from Phase 2 report fixture.

No Phase 3 REST controller, GraphQL resolver, URL validator, health endpoint, Compose file, or frontend file should be created. `ReportParser` remains `apps/api/src/parser/report-parser.ts` and is reused, not replaced.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps/api/src/scan/scan.repository.port.ts` | port/model | CRUD, request-response | `apps/api/src/domain/*.types.ts` | role-match |
| `apps/api/src/scan/scan.repository.ts` | service/adapter | CRUD, request-response | `apps/api/src/scan/scan.store.ts` | role-match; Redis new |
| `apps/api/src/scan/scan.service.ts` | service | request-response, enqueue | `apps/api/src/scan/scan.store.ts` + `index.ts` | role/data-flow partial |
| `apps/api/src/scan/scan.types.ts` or `engine/scan-job.types.ts` | model | request-response/event-driven | domain types | role-match |
| `apps/api/src/engine/repo-cloner.port.ts` | port | file-I/O/request-response | `ReportParser` type boundary | role-match |
| `apps/api/src/engine/repo-cloner.adapter.ts` | adapter/service | file-I/O | `apps/api/scripts/gen-fixture.ts` | role-match |
| `apps/api/src/engine/trivy-runner.port.ts` | port | file-I/O/request-response | parser boundary | role-match |
| `apps/api/src/engine/trivy-runner.adapter.ts` | adapter/service | file-I/O/request-response | `gen-fixture.ts` subprocess-adjacent style | partial |
| `apps/api/src/engine/temp-artifact-cleaner.ts` | utility/adapter | file-I/O | `gen-fixture.ts` cleanup | role-match |
| `apps/api/src/engine/scan-error.ts` | utility | transform | parser validation helpers | role-match |
| `apps/api/src/engine/scan-worker.ts` | worker | event-driven/streaming | `worker.ts` + `ReportParser` | exact topology, new queue |
| `apps/api/src/scan/scan.module.ts` | module/config | request-response/event-driven | itself | exact seam |
| `apps/api/src/worker.module.ts` | module/config | event-driven | current `WorkerModule` | exact topology |
| `apps/api/src/worker.ts` | entrypoint | event-driven | current `worker.ts` | exact topology |
| `apps/api/src/engine/*.spec.ts` | test | request-response/event-driven/file-I/O | `report-parser.spec.ts`, memory contract | strong test match |
| `apps/api` integration harness | test/config | batch/event-driven/file-I/O | Phase 2 process contract | partial |
| `apps/api/package.json` | config | batch/process | existing scripts | exact config |
| `package-lock.json` | config | dependency resolution | existing lockfile | exact config |
| `apps/api/src/domain/scan.types.ts` | model | CRUD | itself | exact if modified |

## Pattern Assignments

### `apps/api/src/scan/scan.repository.port.ts` (port, CRUD/request-response)

**Analog:** `apps/api/src/domain/scan.types.ts` lines 1-21 and `apps/api/src/domain/vulnerability.types.ts` lines 1-13.

Keep the port framework-free: no `@Injectable`, Nest `InjectionToken`, ioredis, BullMQ, or Redis types. Use `import type` for `Scan` and `Vulnerability`, and return `Promise` values because the concrete store is Redis. The required shape is equivalent to:

```typescript
export interface ScanRepository {
  create(scan: Scan): Promise<void>;
  get(id: string): Promise<Scan | null>;
  markScanning(id: string): Promise<void>;
  appendVulnerability(id: string, vulnerability: Vulnerability): Promise<void>;
  markFinished(id: string): Promise<void>;
  markFailed(id: string, reason: ScanFailureReason): Promise<void>;
}
```

`get` must return `null` for a missing hash (D-11). Repository methods, rather than the worker, own terminal-state guards. If the failure reason becomes structured, keep the domain type explicit and bounded rather than adding `any` or leaking an ioredis error.

### `apps/api/src/scan/scan.repository.ts` (Redis adapter, CRUD)

**Analog:** `apps/api/src/scan/scan.store.ts` lines 1-24 for the current injectable store seam; `apps/api/src/domain/scan.types.ts` lines 6-20 for status/data shape; `apps/api/src/scan/scan.module.ts` lines 1-13 for provider/export wiring.

Copy the current class convention (`@Injectable()`, named exported class, private state hidden behind methods), but replace the `Map` with an injected Redis client. Store metadata in a hash and CRITICAL findings in an ordered list (`RPUSH`-style append). Reconstruct one complete `Scan` in `get`; preserve parser order. `create`, status transitions, and vulnerability writes refresh the seven-day TTL. Status + expiry must be one Redis `MULTI/EXEC` or Lua operation, never unrelated best-effort calls.

Important mismatch: `ScanStore.get` is synchronous and has no mutation methods; it is only a naming/DI analog, not a persistence implementation. Do not retain `list()`/`listByStatus()` as the Phase 3 public contract unless tests prove they are needed. The existing `Scan.vulnerabilities?` and `error?` fields are the serialization target.

### `apps/api/src/scan/scan.service.ts` (service, request-response + queue submission)

**Analog:** `apps/api/src/index.ts` lines 9-23 for Nest bootstrap/config access and `apps/api/src/scan/scan.store.ts` lines 9-24 for a small injectable application provider.

The service should inject a typed BullMQ queue and `ScanRepository` using exported tokens. Its enqueue method generates an ID, creates `Queued`, calls `repository.create`, then `queue.add` with exactly `{ scanId, repoUrl }`; it returns the queued identity/status without waiting for engine work. Its read method delegates to the single full repository `get(id)` contract. Use `async`/`Promise` and explicit domain types.

**Hard boundary:** this file must not import `node:fs`, `node:child_process`, Docker, Trivy, parser implementation details, or adapter classes. It must not perform scan lifecycle work, normalize subprocess errors, or map missing records to HTTP 404 (Phase 4).

### `apps/api/src/scan/scan.types.ts` or `apps/api/src/engine/scan-job.types.ts` (model, event-driven)

**Analog:** `apps/api/src/domain/scan.types.ts` lines 6-20 and `apps/api/src/domain/trivy-report.types.ts` lines 6-22.

Define one exported interface, not an untyped BullMQ payload:

```typescript
export interface ScanJob {
  scanId: string;
  repoUrl: string;
}
```

Use the same queue name and job name in producer and worker. Keep the payload small; do not put status, paths, credentials, or report contents in it. If it is placed under `scan/`, avoid creating a second `Scan` model; if under `engine/`, import the domain status only where needed.

### `apps/api/src/engine/repo-cloner.port.ts` (port, file-I/O/request-response)

**Analog:** `apps/api/src/parser/report-parser.ts` lines 50-69: framework-free class/contract and path-in/path-out async boundary.

Port should describe clone policy without exposing Execa or Node process types: `clone(repoUrl: string, cloneDir: string): Promise<void>`. `RepoClonerAdapter` consumes the supplied cloneDir unchanged and performs shallow clone there; it does not generate temp directories or report paths. `ScanPathAllocator` is the exclusive owner of both cloneDir and reportPath allocation beneath SCAN_TMP_DIR, and owns cleanup of any partial allocation failure before its allocation operation returns or rejects.

### `apps/api/src/engine/repo-cloner.adapter.ts` (adapter, file-I/O)

**Analog:** `apps/api/scripts/gen-fixture.ts` lines 1-6, 32-79, and 73-78 for Node filesystem imports, unique temporary path handling, and cleanup on failure; `apps/api/src/parser/report-parser.ts` lines 1-12 for Node-specific imports isolated at the infrastructure boundary.

Use `node:fs/promises`/`mkdtemp` (or equivalent) in ScanPathAllocatorAdapter and direct Execa v9 / `execFile` invocation in RepoClonerAdapter. ScanPathAllocatorAdapter exclusively generates both unique paths under validated SCAN_TMP_DIR and removes any path already created when partial allocation fails before returning or rejecting. RepoClonerAdapter only consumes the supplied cloneDir unchanged and performs argv-based, `shell: false`, shallow `git clone --depth 1 repoUrl cloneDir`; it never generates temp directories or report paths. Never use `exec`, string concatenation, or shell interpolation. Preserve bounded diagnostics for logs while allowing the worker to classify clone failures.

**Mismatch warning:** Phase 2 `gen-fixture.ts` writes streamed files and has atomic temp-file cleanup, but it is not a subprocess adapter. Copy its explicit `try/catch` cleanup and `unknown` error style, not its fixture-specific CLI parser.

### `apps/api/src/engine/trivy-runner.port.ts` (port, file-I/O/request-response)

**Analog:** `ReportParser.parse(reportPath)` at `apps/api/src/parser/report-parser.ts:50-69`; the port should be framework-free and pass paths, not report bytes.

Expose an async `run(cloneDir: string, reportPath: string): Promise<void>` contract (or equivalent explicit result). The report is written to disk; no report JSON string or unbounded stdout is returned. Keep command selection and exit semantics behind the adapter. Worker code should not know whether local or Docker Trivy ran.

### `apps/api/src/engine/trivy-runner.adapter.ts` (adapter, file-I/O/request-response)

**Analog:** `apps/api/scripts/gen-fixture.ts` lines 44-79 for bounded file lifecycle and failure cleanup, plus `apps/api/src/config/env.validation.ts` lines 9-18 for validated `TRIVY_MODE`/environment configuration.

Detect/prefer local `trivy`; if it is present but launch fails due to infrastructure, fall back to Docker. Do not fall back after a genuine scan execution failure with meaningful Trivy diagnostics. Use discrete argv and `shell: false` for both commands. Required local flags include `filesystem`, `--format json`, `--output reportPath`, `--exit-code 0`, `--no-progress`, and cloneDir. Docker must use `--rm`, a unique ephemeral cache, read-only clone mount (`cloneDir:/src:ro`), writable report parent (`reportParent:/out`), pinned official `aquasecurity/trivy:0.69.3`, and `/out/<report-file>` output.

Findings are success: `--exit-code 0` prevents vulnerabilities from being classified as tool failure. Verify report visibility on the host before parser invocation. Never buffer report stdout; retain only bounded stderr diagnostics for logs. Exact Execa v9 option names must be checked against installed types during implementation.

### `apps/api/src/engine/temp-artifact-cleaner.ts` (utility/adapter, file-I/O)

**Analog:** `apps/api/scripts/gen-fixture.ts` lines 73-78 and `apps/api/src/parser/report-parser.spec.ts` lines 8-16.

Centralize an injectable `remove(cloneDir, reportPath)` operation. It must be idempotent, recursively remove clone directories and report files, ignore `ENOENT`, and log/return secondary failures without masking the original scan failure. Call from `finally` for clone, Trivy, disk, and parser failures. Do not scatter `rm` branches through worker code.

### `apps/api/src/engine/scan-error.ts` (utility, transform)

**Analog:** `apps/api/src/parser/report-parser.ts` lines 25-48 for narrowing `unknown` with explicit type guards and precise messages; `apps/api/src/worker.ts` lines 13-16 for top-level error logging/exit boundary.

Export a normalizer/classifier that distinguishes at least clone, Trivy, disk-full (`ENOSPC`), and parser failures. Persist a sanitized category plus detail capped at 500 characters. Redact credentials, raw uncontrolled paths, and unbounded stderr; keep detailed stderr only in worker logs. Preserve the first/original reason when cleanup or failure persistence also errors. Avoid returning raw `Error.message` without category/redaction.

### `apps/api/src/engine/scan-worker.ts` (worker, event-driven + streaming)

**Analogs:** `apps/api/src/worker.ts` lines 1-16 for worker-only topology and `apps/api/src/parser/report-parser.ts` lines 50-69 for async-generator consumption. Research Pattern 1/4 in `03-RESEARCH.md` lines 153-221 supplies the BullMQ/lifecycle skeleton.

Use Nest BullMQ’s typed processor shape:

```typescript
@Processor('scan', { concurrency: 1 })
export class ScanWorker extends WorkerHost {
  async process(job: Job<ScanJob, void, 'scan'>): Promise<void> {
    // mark Scanning; clone; run Trivy; for-await parser; append; Finished
  }
}
```

The lifecycle is sequential: `markScanning`; allocate paths; `clone`; `trivy.run`; `for await (const vulnerability of parser.parse(reportPath)) await appendVulnerability`; `markFinished` only after iterator completion; `finally` cleanup. On every engine rejection, normalize/persist `Failed`, rethrow the original error so BullMQ records the failure, and do not add automatic retries/backoff. Attach an `@OnWorkerEvent('error')`/worker error listener so an unhandled worker error cannot stop processing.

**Mismatch warning:** `worker.ts` currently only starts a context and logs; it is not a processor analog. Do not put HTTP or GraphQL imports in this file/class. Do not use BullMQ job state as authoritative scan state; Redis domain status is authoritative and late workers cannot overwrite terminal states.

### `apps/api/src/scan/scan.module.ts` (shared DI/module seam)

**Analog:** current file lines 1-13. Preserve the single shared module imported by both roots. Replace `ScanStore` in `providers`/`exports` with the service, repository, parser, worker-independent adapter providers, and explicit injection-token bindings. Keep ports free of Nest; bind concrete classes at module level.

Queue registration belongs at the appropriate root/module boundary per BullMQ’s Nest pattern. If `ScanModule` registers the producer queue for API and worker, do not register a second queue with a different name. If worker-only processor registration is needed, make `WorkerModule` import the shared queue registration and add only `ScanWorker`. Avoid a parallel `EngineModule` that bypasses `ScanModule`.

### `apps/api/src/worker.module.ts` (worker root, event-driven config)

**Analog:** current file lines 1-22. Retain `ConfigModule.forRoot({ isGlobal: true, validationSchema: envValidationSchema })` and `ScanModule`; add BullMQ worker/queue registration and processor provider. It must have no Fastify, HTTP, GraphQL, controller, or API transport imports. Use separate ioredis settings: finite producer retries; `maxRetriesPerRequest: null` for blocking worker connection; no ioredis `keyPrefix`; namespace with BullMQ prefix only if needed.

### `apps/api/src/worker.ts` (entrypoint, event-driven)

**Analog:** current file lines 1-16. Keep `NestFactory.createApplicationContext(WorkerModule)`, `enableShutdownHooks()`, top-level `bootstrap().catch(...)`, and no `listen()`. BullMQ/Nest providers should keep the process alive and close through shutdown hooks. Do not convert it into the API bootstrap from `index.ts` lines 9-23.

### `apps/api/src/app.module.ts` (API root, module config)

**Analog:** current file lines 1-19. It should continue importing the same shared `ScanModule` and global validated `ConfigModule`. Phase 3 should not add REST/GraphQL transport. Any producer queue visibility should arrive through `ScanModule`; do not import `WorkerModule` into `AppModule`.

### `apps/api/src/domain/scan.types.ts` (model, CRUD)

**Analog:** itself, lines 6-20. Prefer no modification: existing `ScanStatus` values exactly match `Queued`, `Scanning`, `Finished`, `Failed`, and `Scan` already carries repo URL, vulnerability list, timestamps, and error. If Redis serialization requires a structured bounded reason, extend this type explicitly and update all consumers; do not put Redis-specific fields in the domain model.

## Test Pattern Assignments

### `apps/api/src/parser/report-parser.spec.ts` (reuse, not modify unless contract requires)

**Analog for all new tests:** lines 1-24 and 26-111. Tests use Jest beside source, temporary directories with `mkdtemp`/`rm` in `try/finally`, async-generator `for await`, exact object assertions, `it.each` malformed cases, and `rejects.toThrow`/`rejects.toMatchObject`. Reuse this structure for adapter and worker unit tests.

### Adapter tests (`engine/*.spec.ts`)

Use injected runner/command seams or mocked Execa. Assert exact argv arrays, `shell: false`, `--depth 1`, no `exec`, local-vs-Docker selection, pinned image tag, `--format json`, `--output`, `--exit-code 0`, `--no-progress`, read-only clone mount, writable report mount, and no report stdout buffering. Inject deterministic `ENOSPC`, missing binary, launch, and genuine Trivy failures. These are role-match tests; there is no existing subprocess adapter spec.

### Repository/service tests (`scan/*.spec.ts`)

Use Nest testing only if DI wiring is under test; otherwise use simple fakes matching the framework-free port, as Phase 2 parser tests instantiate `ReportParser` directly. Assert hash/list reconstruction, parser order, null for missing hash, seven-day TTL refresh on every write, atomic transition+expiry, terminal-state guards, exact typed queue payload, and service absence of fs/child_process imports. Redis behavior needs a disposable real Redis test for transaction semantics; do not make all tests depend on a live network.

### Worker lifecycle tests (`engine/scan-worker.spec.ts`)

Construct the worker with fake repository, cloner, Trivy runner, parser, and cleaner. Parser fake should be an async iterable yielding multiple CRITICAL vulnerabilities and can reject midway. Assert `Queued → Scanning → Finished`, append awaited in order, findings are success, `Finished` occurs after final append, failure categories/details are bounded, original error wins over cleanup error, rethrow reaches BullMQ, and cleanup is called on success, clone, disk, Trivy, and parser failures.

### Primary integration test / fixture (new, role partial)

Follow Phase 2’s `apps/api/scripts/memory-process-contract.test.mjs` conventions: Node `node:test`/assert for process-level contracts, discrete argv, subprocess timeout, `try/finally` cleanup, and deterministic temporary directories. Phase 3’s primary path must use a committed small local repository fixture, disposable Redis, compiled `dist/worker.js`, BullMQ/Redis communication, and Docker Trivy fallback. Assert host/container mount visibility, full status lifecycle, ordered CRITICAL results, bounded failure reason, and no clone/report artifacts on all injected failure paths. Do not clone live GitHub content in tests.

## Shared Patterns

### Strict CommonJS TypeScript
**Sources:** `apps/api/tsconfig.json` lines 2-25 and `apps/api/package.json` lines 8-24, 56-90.
**Apply to:** every new `.ts` file. Preserve `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, CommonJS, Node 22 engine, explicit types, no `any`, and existing Jest/SWC setup. Use `import type` for pure domain/port types.

### Nest DI and two roots
**Sources:** `apps/api/src/scan/scan.module.ts` lines 1-13, `apps/api/src/app.module.ts` lines 1-19, `apps/api/src/worker.module.ts` lines 1-22.
**Apply to:** module/provider changes. One `ScanModule` is the seam; `AppModule` and `WorkerModule` share it. Worker root stays transport-free.

### Config boundary
**Source:** `apps/api/src/config/env.validation.ts` lines 9-18.
**Apply to:** Redis/temp/Trivy adapter construction. Preserve required `REDIS_HOST`, `REDIS_PORT`, `SCAN_TMP_DIR`; use `TRIVY_MODE` only as a selection policy, not as a reason to bypass local detection unless explicitly decided.

### Failure boundary
**Sources:** `apps/api/src/worker.ts` lines 13-16 and `apps/api/scripts/gen-fixture.ts` lines 73-79, 128-131.
**Apply to:** worker/adapter entrypoints. Catch `unknown`, log diagnostics, exit/rethrow deliberately; cleanup in `finally`; never silently turn a rejected parser or child process into success.

### Streaming parser boundary
**Source:** `apps/api/src/parser/report-parser.ts` lines 50-69 and `report-parser.spec.ts` lines 19-24.
**Apply to:** worker and parser port. Consume via `for await`, one yielded `Vulnerability` at a time. Never add `readFile`, `readFileSync`, `JSON.parse`, `.toArray()`, or a report buffer on the report path.

## No Analog Found / Mismatch Warnings

| File/Concern | Reason and planner guidance |
|---|---|
| `trivy-runner.adapter.ts` | No existing child-process or Docker adapter. Use researched argv-safe policy and verify Execa v9 types. |
| `scan.repository.ts` | Existing `ScanStore` is synchronous in-memory only. Treat it as DI/class naming analog, not Redis behavior. |
| `scan-worker.ts` | Existing `worker.ts` is only an application-context bootstrap; BullMQ processor lifecycle is new. |
| Docker/Redis integration harness | No existing workflow/service integration analog. Keep local fixture and disposable services deterministic; retain an explicit command if hosted runner limits make the gate infeasible. |
| `apps/api/src/scan/scan.types.ts` naming | Research suggests either `scan/scan.types.ts` or `engine/scan-job.types.ts`; choose one canonical source to avoid duplicate `ScanJob` definitions. |
| Queue registration location | Current roots have no BullMQ. Registration must be designed once and shared; do not create independent API and worker queue names/connections. |
| `package.json` build | Current `build` explicitly compiles `scripts/*.ts` with a second `tsc` invocation (line 12). Adding source files under `src` is automatic; integration scripts outside `src` need explicit build/script wiring. |

## Metadata

**Analog search scope:** `apps/api/src/**`, `apps/api/scripts/**`, `apps/api/package.json`, root `package.json`, `tsconfig.json`, `.gitignore`, Phase 1/2 planning artifacts, requirements, roadmap, and state.
**Existing source files scanned:** 14 source/config files plus 5 Phase 2 scripts/tests and planning artifacts.
**Key locked patterns:** one shared `ScanModule`; worker-only `createApplicationContext`; typed BullMQ payload; concurrency 1; Redis domain state independent of BullMQ state; clone → Trivy file → async-generator parser → ordered Redis append; cleanup in `finally`; bounded categorized errors.
**Known environment warning:** repository research records Node 24 locally while `apps/api/package.json` requires Node 22; authoritative engine/integration verification must run on Node 22. Docker exists, but local Redis and host Trivy are absent, so use disposable Redis and Docker fallback in integration tests.
