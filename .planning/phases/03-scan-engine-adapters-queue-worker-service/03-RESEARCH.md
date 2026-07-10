# Phase 3: Scan Engine — Adapters, Queue, Worker & Service - Research

**Researched:** 2026-07-10
**Domain:** NestJS/BullMQ background scanning, Redis persistence, argv-safe subprocess adapters, Trivy report execution, and cleanup-safe orchestration
**Confidence:** HIGH for repository integration points and official API semantics; MEDIUM for exact package-version selection because BullMQ 5.80.0 was published on the research date

## User Constraints

- **Architecture:** `ScanService` only orchestrates (enqueue jobs, read status) and never touches `fs` or `child_process` directly. [VERIFIED: .planning/REQUIREMENTS.md]
- **Architecture:** Infrastructure concerns are isolated behind injectable adapters (`RepoCloner`, `TrivyRunner`, `ReportParser`, `ScanRepository`). [VERIFIED: .planning/REQUIREMENTS.md]
- **Worker:** BullMQ `@Processor`/`WorkerHost` consumes jobs with `concurrency: 1`, in a worker-only process. [VERIFIED: .planning/REQUIREMENTS.md]
- **Pipeline:** clone → Trivy JSON report file → stream parse → Redis persistence; store only CRITICAL findings. [VERIFIED: .planning/ROADMAP.md; .planning/REQUIREMENTS.md]
- **Security:** subprocesses receive argv arrays and no shell interpolation; `fs.readFile`/`JSON.parse` remain forbidden on the report path. [VERIFIED: .planning/PROJECT.md; .planning/REQUIREMENTS.md]
- **Cleanup:** unique temporary clone and report paths are removed on success and every failure path. [VERIFIED: .planning/REQUIREMENTS.md]
- **Scope:** persistent SQL/NoSQL is out of scope; Redis is the persistence layer for job state and results. [VERIFIED: .planning/REQUIREMENTS.md]
- **Scope:** BullMQ sandboxed processors are out of scope because an extra Node process duplicates V8 heap under the memory budget. [VERIFIED: .planning/REQUIREMENTS.md]

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ENGINE-01 | BullMQ worker consumes jobs with concurrency 1 | Nest/BullMQ module and processor pattern; worker module integration below |
| ENGINE-02 | Shallow clone with argv array and no shell | `RepoCloner` contract and `execFile`/Execa pattern |
| ENGINE-03 | Trivy writes JSON to file via `--output` | `TrivyRunner` contract and CLI semantics |
| ENGINE-04 | Local Trivy with Docker fallback | Detection and command-builder pattern |
| ENGINE-06 | Redis-backed status independent of BullMQ job state | `ScanRepository` key schema and transition methods |
| ENGINE-07 | Cleanup on success and failure | Worker `try/finally`, idempotent remover |
| ARCH-02 | Service has no fs/child_process I/O | Dependency-injected ports and file-level boundaries |
| ARCH-03 | Injectable adapters isolate infrastructure | Recommended source structure and tokens |
| ERR-01 | Vulnerability findings are not tool failure | Force Trivy `--exit-code 0`; classify genuine nonzero process errors |
| ERR-02 | Clone failures preserve reason and cleanup | Error normalization and integration tests |
| ERR-03 | ENOSPC is failed with specific reason | Error-code normalization and failure tests |
| ERR-04 | Parse errors reject through stream pipeline | Async generator/`pipeline()` propagation and cleanup tests |

## Summary

The live repository is a NestJS 11 CommonJS application with two entrypoints. `ScanModule` currently exports only the in-memory `ScanStore`; Phase 3 should replace that stub with the Redis repository and add queue/worker providers without changing the two-entrypoint topology. `ReportParser.parse(reportPath)` already exposes the correct async-generator boundary and uses the verified deep-leaf `pick` plus `streamValues()` pipeline, so the worker should consume it with `for await` and never introduce a second parser or report buffer. [VERIFIED: codebase grep]

Use one queue name and one typed job payload containing `scanId` and `repoUrl`. The API-side service should create/persist `Queued`, enqueue, and return; the worker should persist `Scanning`, run the adapters sequentially, append each yielded CRITICAL vulnerability to the repository, then persist `Finished`. Any adapter or parser error should be normalized to a bounded, specific reason, persisted as `Failed`, rethrown to BullMQ, and followed by idempotent cleanup in `finally`. [CITED: https://docs.bullmq.io/guide/nestjs; https://docs.bullmq.io/guide/workers]

**Primary recommendation:** Add four framework-free ports plus concrete adapters under `apps/api/src/engine/`, wire them in `ScanModule`, register BullMQ only in the appropriate root modules, and keep `ScanService` limited to queue submission/status reads while `ScanWorker` owns the sequential scan lifecycle. [VERIFIED: .planning/REQUIREMENTS.md; VERIFIED: codebase grep]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Queue submission/status reads | API application/service tier | Redis/BullMQ | `ScanService` owns orchestration, not filesystem or subprocess I/O. [VERIFIED: .planning/REQUIREMENTS.md] |
| Job consumption and lifecycle | Worker tier | BullMQ/Redis | `WorkerHost.process()` is the background boundary; the worker entrypoint has no HTTP listener. [CITED: https://docs.bullmq.io/guide/nestjs; VERIFIED: codebase grep] |
| Repository clone | Infrastructure adapter | Worker tier | `RepoCloner` isolates subprocess and filesystem policy. [VERIFIED: .planning/REQUIREMENTS.md] |
| Trivy execution | Infrastructure adapter | Worker tier | `TrivyRunner` owns binary/Docker selection and report-file output. [CITED: https://trivy.dev/latest/docs/references/configuration/cli/trivy_filesystem/] |
| Report parsing | Parser adapter | Worker tier | Existing `ReportParser` is a framework-free streaming boundary. [VERIFIED: codebase grep] |
| Scan state/results | Redis/storage tier | Worker and API | Repository state is independent of BullMQ's internal job status. [VERIFIED: .planning/REQUIREMENTS.md] |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@nestjs/bullmq` | **11.0.4** | Nest integration for `BullModule`, `@Processor`, `WorkerHost` | Official Nest integration exposes the exact module/processor pattern required by the project. [CITED: https://docs.bullmq.io/guide/nestjs; VERIFIED: npm registry] |
| `bullmq` | **5.80.0 latest; pin an exact 5.x version after checkpoint** | Queue and worker implementation | Official BullMQ 5 worker supports typed jobs, concurrency, failure events, and `close()`. [CITED: https://docs.bullmq.io/guide/workers; VERIFIED: npm registry] |
| `ioredis` | **5.11.1** | Redis client for repository and BullMQ worker connection | BullMQ documents ioredis options, duplicate blocking connections, and worker retry requirements. [CITED: https://docs.bullmq.io/guide/connections; VERIFIED: npm registry] |
| Node.js | **22.x required** | Runtime, `child_process`, `fs`, `stream/promises` | `apps/api/package.json` enforces `>=22 <23`; Phase 2 CI is Node 22 authoritative. [VERIFIED: codebase grep] |

### Supporting

| Library/API | Version | Purpose | When to Use |
|-------------|---------|---------|-------------|
| `execa` | **9.6.1** | Promise-based direct subprocess execution | Use for `git` and `trivy` argv arrays, file-backed stdout, stderr diagnostics, and cancellation. [CITED: https://github.com/sindresorhus/execa#readme; VERIFIED: npm registry] |
| Node `node:fs/promises` | built-in | `mkdtemp`, `rm`, `access`/binary detection | Use only inside concrete adapters and cleanup infrastructure. [CITED: https://nodejs.org/api/fs.html] |
| Node `node:stream/promises` | built-in | Pipeline error propagation where a stream-to-file/transform pipeline is used | Use `await pipeline(...)`; rejection must reach worker failure handling. [CITED: https://nodejs.org/api/stream.html#streampromisespipeline] |
| Existing `stream-json` + `stream-chain` | **2.1.0 / 3.6.3** | Phase 2 parser | Reuse `ReportParser`; do not replace or buffer it. [VERIFIED: codebase grep; .planning/phases/02-streaming-parse-pipeline-memory-proof/02-RESEARCH.md] |

**Installation:**
```bash
npm install --workspace apps/api @nestjs/bullmq@11.0.4 bullmq@5.80.0 ioredis@5.11.1 execa@9.6.1
```

Pin exact versions in `apps/api/package.json` and update the root lockfile. Do not install unpinned latest packages in the plan. `bullmq@5.80.0` was published on 2026-07-10 and the legitimacy seam flagged the package as `SUS` only because of that recency; it is a real package with 6.5M weekly downloads and the official Taskforce source repository, but the planner must add a human verification checkpoint before install or select a previously reviewed 5.x patch. [VERIFIED: npm registry; VERIFIED: package-legitimacy check]

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `@nestjs/bullmq` | npm | since 2022 | 1.63M/week | github.com/nestjs/bull | OK | Approved |
| `bullmq` | npm | since 2015; selected 5.80.0 published 2026-07-10 | 6.57M/week | github.com/taskforcesh/bullmq | SUS | Flagged — planner must add `checkpoint:human-verify` before installing the exact selected patch |
| `ioredis` | npm | since 2015 | 22.04M/week | github.com/luin/ioredis | OK | Approved |
| `execa` | npm | since 2015 | 135.76M/week | github.com/sindresorhus/execa | OK | Approved |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** `bullmq` exact selected patch, due to same-day publication recency; no postinstall script was reported. [VERIFIED: package-legitimacy check]

## Architecture Patterns

### System Architecture Diagram

```text
ScanService.enqueue(repoUrl)
  ├─ ScanRepository.create({id, repoUrl, status: Queued})
  └─ Queue.add('scan', {scanId, repoUrl})
        │
        ▼
BullMQ Redis queue ── WorkerHost(concurrency: 1)
        │
        ▼
ScanRepository.markScanning(scanId)
        │
        ▼
RepoCloner.clone(repoUrl, uniqueTempDir)
        │
        ▼
TrivyRunner.run(cloneDir, reportPath)
  ├─ local `trivy` argv, or
  └─ `docker run ... aquasecurity/trivy ...` argv
        │  --format json --output reportPath --exit-code 0
        ▼
ReportParser.parse(reportPath)  [async generator, one CRITICAL at a time]
        │
        ├─ ScanRepository.appendVulnerability(scanId, vulnerability)
        └─ on any rejection: normalize reason → Failed
        │
        ▼
ScanRepository.markFinished(scanId)
        │
        ▼
finally: remove clone directory and report file (ignore ENOENT)
```

### Recommended Project Structure

```text
apps/api/src/
├── scan/
│   ├── scan.module.ts              # providers/tokens; shared API + worker seam
│   ├── scan.service.ts             # enqueue + status orchestration only
│   ├── scan.repository.ts          # Redis state/results implementation
│   ├── scan.repository.port.ts     # injectable repository contract
│   └── scan.types.ts               # job payload/state contracts (or domain/)
├── engine/
│   ├── repo-cloner.port.ts
│   ├── repo-cloner.adapter.ts      # git clone argv, unique temp directory
│   ├── trivy-runner.port.ts
│   ├── trivy-runner.adapter.ts     # local binary/Docker argv + exit policy
│   ├── scan-worker.ts               # @Processor, WorkerHost, try/catch/finally
│   ├── scan-error.ts                # bounded error normalization
│   └── temp-artifact-cleaner.ts     # idempotent rm wrapper
├── parser/report-parser.ts          # existing Phase 2 adapter
└── worker.module.ts                 # imports ScanModule + Bull registration
```

Keep port interfaces free of Nest, BullMQ, fs, and child-process imports. Concrete adapters may import infrastructure APIs. Use injection tokens (`Symbol` or exported constants) so unit tests can replace every adapter. The existing `ScanModule` is the only shared DI seam and currently provides/exports `ScanStore`; replace that provider rather than creating a second module or parallel store. [VERIFIED: codebase grep]

### Pattern 1: Typed queue and worker

**What:** Register one queue in the shared module, inject it into `ScanService`, and implement the processor as a worker-only provider extending `WorkerHost`. [CITED: https://docs.bullmq.io/guide/nestjs]

```typescript
export interface ScanJob {
  scanId: string;
  repoUrl: string;
}

@Processor('scan', { concurrency: 1 })
export class ScanWorker extends WorkerHost {
  async process(job: Job<ScanJob, void, 'scan'>): Promise<void> {
    await this.engine.run(job.data);
  }
}
```

Use a typed `Job<ScanJob, void, 'scan'>`, not `Job<any, any>`. Attach a worker `error` listener or `@OnWorkerEvent('error')`; BullMQ documents that an unhandled worker error can stop processing. [CITED: https://docs.bullmq.io/guide/workers]

### Pattern 2: Separate producer and worker Redis settings

Use connection options from validated `REDIS_HOST`/`REDIS_PORT`. A producer queue can retain the default finite `maxRetriesPerRequest` so API enqueue fails promptly; the worker connection must set `maxRetriesPerRequest: null` because it uses blocking commands and is expected to retry indefinitely. BullMQ may duplicate a supplied ioredis connection for blocking internals, so the connection must support `duplicate()`. Never set ioredis `keyPrefix`; use BullMQ's own queue `prefix` option if namespacing is needed. [CITED: https://docs.bullmq.io/guide/connections]

### Pattern 3: argv-safe clone and Trivy commands

```typescript
await execa('git', ['clone', '--depth', '1', repoUrl, cloneDir], {
  shell: false,
  reject: true,
  stdout: 'pipe',
  stderr: 'pipe',
});

await execa(trivyCommand, [
  'filesystem', '--format', 'json', '--output', reportPath,
  '--exit-code', '0', '--no-progress', cloneDir,
], { shell: false, stdout: 'pipe', stderr: 'pipe' });
```

The exact Execa option spelling should be checked against the installed v9 types during implementation; the invariant is discrete argv, `shell: false`, and no report JSON on stdout. Node's `execFile`/`spawn` also accept an argument array and default to no shell for `execFile`; `exec` is forbidden because it creates a shell and buffers output. [CITED: https://nodejs.org/api/child_process.html; CITED: https://github.com/sindresorhus/execa#readme]

### Pattern 4: Worker lifecycle and cleanup

```typescript
await repository.markScanning(scanId);
try {
  const { cloneDir, reportPath } = await cloner.clone(...);
  try {
    await trivy.run(cloneDir, reportPath);
    for await (const vulnerability of parser.parse(reportPath)) {
      await repository.appendVulnerability(scanId, vulnerability);
    }
    await repository.markFinished(scanId);
  } catch (error) {
    const reason = normalizeScanError(error);
    await repository.markFailed(scanId, reason);
    throw error;
  } finally {
    await cleaner.remove(cloneDir, reportPath);
  }
} catch (error) {
  // Clone/setup errors must also mark Failed; preserve the first failure reason.
  await repository.markFailed(scanId, normalizeScanError(error));
  throw error;
}
```

Prefer a single worker engine method with one outer `try/catch/finally` once paths are allocated; the pseudocode illustrates the required behavior, not a mandate for nested catches. Cleanup must be attempted even if failure-state persistence itself errors; log the secondary persistence/cleanup error without replacing the original reason. [VERIFIED: .planning/REQUIREMENTS.md; CITED: https://nodejs.org/api/stream.html#streampromisespipeline]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Durable background queue | In-memory arrays or custom polling | BullMQ 5 + Redis | Handles persistence, worker state, concurrency, and failure transitions. [CITED: https://docs.bullmq.io/guide/workers] |
| Shell escaping | Manual quoted command strings | Execa/`execFile` argv arrays with `shell:false` | Shell metacharacters and spaces make hand-quoting unsafe. [CITED: https://nodejs.org/api/child_process.html] |
| Large report parsing | `readFile` + `JSON.parse` | Existing `ReportParser` async generator | Phase 2 proved the memory-flat leaf pipeline. [VERIFIED: .planning/phases/02-streaming-parse-pipeline-memory-proof/02-VERIFICATION.md] |
| Stream error bridge | EventEmitter-to-promise adapter | `stream/promises.pipeline()` or native async iteration | Node propagates errors by rejecting and destroys pipeline streams. [CITED: https://nodejs.org/api/stream.html#streampromisespipeline] |
| Recursive deletion policy | Ad hoc `rm` calls in each branch | One idempotent `TempArtifactCleaner` | Centralizes ENOENT handling and prevents leaked artifacts. [ASSUMED] |

**Key insight:** the worker is an orchestration boundary, not a place to hide infrastructure. The only custom logic should be explicit policy: status transitions, Trivy exit classification, bounded reason normalization, and cleanup ordering. [VERIFIED: .planning/REQUIREMENTS.md]

## Common Pitfalls

### Pitfall 1: Treating Trivy findings as a process failure
**What goes wrong:** a scan with vulnerabilities becomes `Failed` because the child process exits nonzero. [CITED: https://trivy.dev/latest/docs/references/configuration/cli/trivy_filesystem/]
**Why it happens:** Trivy's `--exit-code` explicitly controls the exit code when security issues are found. [CITED: https://trivy.dev/latest/docs/references/configuration/cli/trivy_filesystem/]
**How to avoid:** pass `--exit-code 0` for this engine; classify nonzero as genuine failure only when the report command itself failed, and verify the report file exists before parsing. [CITED: https://trivy.dev/latest/docs/references/configuration/cli/trivy_filesystem/]
**Warning signs:** integration test sees findings but repository status is `Failed`.

### Pitfall 2: Buffering Trivy stdout
**What goes wrong:** a large JSON report is held in Execa/child-process output. [CITED: https://nodejs.org/api/child_process.html]
**How to avoid:** give Trivy `--format json --output <reportPath>` and keep stdout only for small diagnostics; never use `exec` or an unbounded stdout collector. [CITED: https://trivy.dev/latest/docs/references/configuration/cli/trivy_filesystem/]
**Warning signs:** `maxBuffer` errors or RSS grows with report size.

### Pitfall 3: Docker fallback path changes the filesystem namespace
**What goes wrong:** Docker Trivy cannot see the host clone/report path, or writes the report inside the container. [ASSUMED]
**How to avoid:** build Docker argv with explicit read-only clone mount and writable report destination mapping, and pass the container path to Trivy; test the fallback separately. The Docker CLI itself must also receive discrete argv values. [ASSUMED]
**Warning signs:** process succeeds but host report is absent, or parser gets `ENOENT`.

### Pitfall 4: Redis worker connection uses default ioredis retries
**What goes wrong:** BullMQ rejects a worker connection or blocking commands fail after transient Redis errors. [CITED: https://docs.bullmq.io/guide/connections]
**How to avoid:** `maxRetriesPerRequest: null` on worker ioredis connection; finite retries for API producer; no ioredis `keyPrefix`; close all queue/worker/repository connections on shutdown. [CITED: https://docs.bullmq.io/guide/connections]

### Pitfall 5: Marking Finished before all yielded vulnerabilities are persisted
**What goes wrong:** status says `Finished` while the result list is incomplete. [ASSUMED]
**How to avoid:** await each repository append in the parser loop, then mark Finished only after iterator completion. A parser rejection must prevent the Finished write. [VERIFIED: existing parser async-generator API]

### Pitfall 6: Cleanup only covers the happy path
**What goes wrong:** clone directories or partial report files survive clone, Trivy, ENOSPC, or parse failures. [VERIFIED: .planning/REQUIREMENTS.md]
**How to avoid:** allocate deterministic paths up front, place cleanup in `finally`, make remove idempotent, and test each failure injection point. [VERIFIED: .planning/REQUIREMENTS.md]

### Pitfall 7: Swallowing stream/parser errors
**What goes wrong:** malformed/truncated JSON produces a partial result and a successful job. [CITED: https://nodejs.org/api/stream.html#streampromisespipeline]
**How to avoid:** consume the existing async generator directly and let rejection reach the worker catch; do not attach a terminal listener that ignores `error`. [VERIFIED: existing parser; CITED: Node stream docs]

## Code Examples

### Redis repository key contract

```typescript
const scanKey = (id: string): string => `scan:${id}`;
const vulnerabilitiesKey = (id: string): string => `scan:${id}:critical`;

export interface ScanRepository {
  create(scan: Scan): Promise<void>;
  get(id: string): Promise<Scan | null>;
  markScanning(id: string): Promise<void>;
  appendVulnerability(id: string, vulnerability: Vulnerability): Promise<void>;
  markFinished(id: string): Promise<void>;
  markFailed(id: string, reason: string): Promise<void>;
}
```

Store scalar scan metadata in a Redis hash and CRITICAL vulnerabilities as a Redis list or serialized bounded entries; use one repository method per transition so callers do not know Redis commands. The exact serialization and TTL are unresolved project decisions and must be chosen explicitly before implementation; no retention policy is currently specified. [VERIFIED: .planning/REQUIREMENTS.md; ASSUMED: storage encoding/TTL recommendation]

### Trivy invocation policy

```text
local:  trivy filesystem --format json --output REPORT --exit-code 0 --no-progress CLONE
Docker: docker run --rm
        -v CLONE:/src:ro
        -v REPORT_PARENT:/out
        aquasecurity/trivy:<pinned-tag>
        filesystem --format json --output /out/REPORT --exit-code 0 --no-progress /src
```

The local filesystem command and flags are directly documented by Trivy. The Docker mount layout and image tag are a project integration choice and must be tested against the chosen runtime image. [CITED: https://trivy.dev/latest/docs/references/configuration/cli/trivy_filesystem/; ASSUMED for Docker mount details]

### Error normalization

```typescript
function normalizeScanError(error: unknown): string {
  if (isNodeError(error) && error.code === 'ENOSPC') return 'Disk full (ENOSPC)';
  if (isNodeError(error) && error.code === 'ENOENT') return 'Required executable or file not found';
  if (error instanceof Error && error.message.length <= 500) return error.message;
  return 'Scan failed: unknown error';
}
```

Keep raw stderr out of the public response if it can contain paths or credentials; log bounded diagnostics separately. The 500-character cap and redaction policy are recommendations requiring confirmation in implementation. [ASSUMED]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|-------------|--------|
| `exec('git clone ' + url)` | `execFile`/`spawn`/Execa with argv array and shell disabled | Node API has long distinguished these; current docs explicitly warn against unsanitized `exec` input | Removes shell injection and avoids shell parsing. [CITED: https://nodejs.org/api/child_process.html] |
| Treat any Trivy nonzero as failure | Set `--exit-code 0` when findings are expected | Current Trivy CLI exposes explicit `--exit-code` semantics | Findings become a successful scan result. [CITED: https://trivy.dev/latest/docs/references/configuration/cli/trivy_filesystem/] |
| Buffer report in stdout | `--output` report file plus streaming parser | Current Trivy CLI supports `--output`; Phase 2 proves streaming parser | Keeps report bytes off V8 heap. [CITED: https://trivy.dev/latest/docs/references/configuration/cli/trivy_filesystem/; VERIFIED: Phase 2 artifacts] |
| Queue state as application state | Separate Redis domain state from BullMQ job state | BullMQ docs distinguish worker/job lifecycle from application data | API can report domain status after queue cleanup or restart. [CITED: https://docs.bullmq.io/guide/workers; VERIFIED: .planning/REQUIREMENTS.md] |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `bullmq@5.80.0` is acceptable after human review despite same-day publication flag | Standard Stack | Dependency gate may require an older 5.x patch |
| A2 | Redis result encoding can use a hash plus list without a retention requirement | Code Examples | Unbounded Redis growth or API shape mismatch |
| A3 | Docker fallback can mount a host clone read-only and report parent writable | Common Pitfalls / Code Examples | Fallback integration may need a different path strategy |
| A4 | A 500-character normalized error cap and public stderr redaction fit the assignment | Code Examples | Error contract could require more diagnostic detail |
| A5 | `@nestjs/bullmq@11.0.4` is compatible with the project's NestJS 11.1.28 packages | Standard Stack | Installation peer constraints could require a compatible patch adjustment |

## Open Questions

1. **Which exact BullMQ 5 patch should be locked?** The registry latest is 5.80.0, but the legitimacy tool flagged same-day recency. Resolve via human checkpoint and lock the chosen patch in package.json/lockfile.
2. **What Redis retention policy is desired?** Requirements specify Redis persistence but no TTL or cleanup policy. Choose a bounded TTL or document intentional indefinite retention before implementing repository keys.
3. **How should Docker fallback map paths and pin the Trivy image?** The local command is documented; the Docker mount/image-tag policy is not specified by the repository. Add a focused fallback integration test.
4. **Should a failed BullMQ job be retried?** Requirements mention retries in project context, but v2 explicitly defers retry/backoff policy. For this phase, do not add new retry semantics unless the planner confirms them; domain status must still become Failed on the first terminal engine failure.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Build/worker | ✗ authoritative | v24.10.0; project requires >=22 <23 | Node 22 CI/runner is authoritative, as in Phase 2. [VERIFIED: shell probe; VERIFIED: package.json] |
| npm | Install/build | ✓ | 11.6.1 | — |
| Docker | Trivy fallback | ✓ | 29.1.3 | — |
| Trivy local binary | Local runner path | ✗ | not installed | Docker fallback; test both via injected command resolver |
| Redis server | Queue/repository integration | ✗ detected | not installed/running | Docker Redis or CI service; unit tests use mocked repository/queue |

**Missing dependencies with no fallback:** none for planning; Node 22 and Redis/Docker-backed integration must be supplied by CI or local setup.
**Missing dependencies with fallback:** local Trivy falls back to Docker; local Redis falls back to a containerized Redis service.

## Validation Architecture

Validation is explicitly disabled by `.planning/config.json` (`workflow.nyquist_validation: false`), so the standard Nyquist section is omitted. [VERIFIED: .planning/config.json]

Recommended phase verification remains:
- Unit tests for `ScanService`, `ScanWorker`, repository serialization, error normalization, and command builders with injected fakes.
- Adapter contract tests for argv arrays, shallow clone flags, local/Docker command selection, `--output`, `--format json`, `--exit-code 0`, and no stdout report buffering.
- Worker integration tests with fake adapters proving `Queued → Scanning → Finished`, vulnerability findings succeed, genuine failures fail, ENOSPC fails, parser rejection fails, and every path calls cleanup.
- Redis integration test against a real Redis service proving API-side writes are visible to worker-side reads and results survive queue/job completion.
- Run existing gates: `npm run typecheck --workspace apps/api`, `npm run lint --workspace apps/api`, focused Jest tests, and `npm run build --workspace apps/api`. [VERIFIED: codebase grep; Phase 2 summaries]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | No | Authentication is out of scope. [VERIFIED: .planning/REQUIREMENTS.md] |
| V3 Session Management | No | No session surface in this phase. [VERIFIED: roadmap boundary] |
| V4 Access Control | No | Single-purpose worker; API validation is Phase 4. [VERIFIED: roadmap] |
| V5 Input Validation | Yes | Keep `ScanJob` typed; validate paths, command mode, repo URL before enqueue in Phase 4; never turn untrusted strings into shell syntax. [VERIFIED: .planning/REQUIREMENTS.md; CITED: https://nodejs.org/api/child_process.html] |
| V6 Cryptography | No | No cryptographic operation introduced. [VERIFIED: phase scope] |
| V14 Configuration | Yes | Preserve fail-closed required `REDIS_HOST`, `REDIS_PORT`, and `SCAN_TMP_DIR` validation. [VERIFIED: codebase grep] |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Shell injection through repository URL/path | Tampering / Elevation | argv array, `shell:false`, `execFile`/Execa; no `exec`. [CITED: https://nodejs.org/api/child_process.html] |
| Trivy report stdout buffering | Denial of Service | `--output` file and Phase 2 streaming parser; avoid `maxBuffer`-bounded collectors. [CITED: Trivy docs; VERIFIED: Phase 2] |
| Path traversal or cleanup outside scan root | Tampering | Generate clone/report paths from `SCAN_TMP_DIR` plus generated IDs; do not accept arbitrary output paths from job payload. [ASSUMED] |
| Redis eviction corrupting queue/state | Availability | Configure Redis `maxmemory-policy=noeviction`; do not use ioredis `keyPrefix`. [CITED: https://docs.bullmq.io/guide/connections] |
| Secret leakage in subprocess errors | Information disclosure | Bound/redact stderr before persisting failure reason; log diagnostics separately. [ASSUMED] |

## Sources

### Primary (HIGH confidence)
- [https://docs.bullmq.io/guide/nestjs] — Nest `BullModule`, `registerQueue`, `@Processor`, `WorkerHost`.
- [https://docs.bullmq.io/guide/workers] — asynchronous processor behavior, typed jobs, failed jobs, worker error listener.
- [https://docs.bullmq.io/guide/workers/concurrency] — local concurrency and concurrency 1 semantics.
- [https://docs.bullmq.io/guide/connections] — ioredis options, duplicate blocking connections, `maxRetriesPerRequest`, `keyPrefix`, Redis noeviction.
- [https://nodejs.org/api/child_process.html] — argv arrays, `execFile` no-shell default, `exec` shell/buffering/maxBuffer semantics.
- [https://nodejs.org/api/stream.html#streampromisespipeline] — promise rejection, abort behavior, async-generator support, buffering/backpressure.
- [https://trivy.dev/latest/docs/references/configuration/cli/trivy_filesystem/] — filesystem CLI, `--format`, `--output`, `--exit-code`.
- [https://trivy.dev/latest/docs/references/configuration/cli/trivy_repository/] — repository target command and matching output/exit options.
- [https://github.com/sindresorhus/execa#readme] — direct process execution, no shell injection, file output/streaming, detailed errors.
- Live repository files: `apps/api/src/scan/scan.module.ts`, `scan.store.ts`, `worker.module.ts`, `worker.ts`, `parser/report-parser.ts`, domain types, config, package.json. [VERIFIED: codebase grep]

### Secondary (MEDIUM confidence)
- `.planning/phases/02-streaming-parse-pipeline-memory-proof/02-RESEARCH.md`, `02-PATTERNS.md`, `02-01-SUMMARY.md`, `02-02-SUMMARY.md`, `02-VERIFICATION.md` — existing parser contract, CommonJS pins, memory-proof and verification gates. [VERIFIED: repository artifacts]
- npm registry metadata queried 2026-07-10 for `bullmq`, `@nestjs/bullmq`, `ioredis`, and `execa`; exact versions and publish dates recorded above. [VERIFIED: npm registry]

### Tertiary (LOW confidence)
- Docker fallback mount layout, error-message truncation/redaction, Redis encoding/TTL, and path-root hardening are explicit assumptions pending project decisions or implementation tests. [ASSUMED]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH for library identity/API and registry versions; MEDIUM for exact BullMQ patch because of same-day release flag.
- Architecture: HIGH — directly constrained by requirements and existing `ScanModule`/entrypoints.
- Pitfalls: HIGH for BullMQ/ioredis/Node/Trivy documented semantics; MEDIUM for Docker-specific fallback and retention policy.

**Research date:** 2026-07-10
**Valid until:** 2026-07-17 for BullMQ/Trivy version-sensitive details; 2026-08-09 for stable Node architecture guidance
