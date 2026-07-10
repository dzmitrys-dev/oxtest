# Architecture Research

**Domain:** Memory-constrained async security-scanner wrapper (Node.js/TypeScript, BullMQ+Redis, stream-json parsing of 500MB+ Trivy reports under 150MB heap)
**Researched:** 2026-07-09
**Confidence:** MEDIUM (patterns cross-corroborated across many independent sources; individual sources are web-tier, not vendor-curated, so tag as LOW per-source but treat the consensus as reliable — see Sources)

## Standard Architecture

### System Overview

```
┌───────────────────────────────────────────────────────────────────────┐
│                         DRIVING ADAPTERS (inbound)                     │
├───────────────────────────────────┬─────────────────────────────────────┤
│   REST Controller (Express)       │   GraphQL Resolvers (Apollo)        │
│   POST /api/scan  GET /api/scan/: │   Scan.status  Scan.criticalVulns   │
│   id                              │                                     │
└────────────────┬───────────────────┴────────────────┬────────────────────┘
                 │ calls                              │ calls
                 ▼                                     ▼
┌───────────────────────────────────────────────────────────────────────┐
│                     ScanService (orchestration only)                   │
│  createScan() -> enqueue job, write initial Redis record, return id    │
│  getScan(id)  -> read Redis record, shape response DTO                 │
├───────────────────────────────────────────────────────────────────────┤
│         (no HTTP/GraphQL types here, no fs/child_process here)         │
└───────────────────┬─────────────────────────────────────┬───────────────┘
                     │ enqueue (BullMQ Queue.add)          │ read/write
                     ▼                                     ▼
        ┌────────────────────────┐            ┌─────────────────────────┐
        │   BullMQ Queue (Redis) │            │  ScanRepository (Redis) │
        └───────────┬─────────────┘            │  hash: scan:<id>        │
                     │ picked up by             └─────────────────────────┘
                     ▼                                     ▲
┌───────────────────────────────────────────────────────────┼────────────┐
│              Worker process (BullMQ Processor)             │            │
│  ScanProcessor.process(job):                                │           │
│   1. mkdtemp()               -> RepoCloner adapter          │           │
│   2. RepoCloner.clone(url)   -> TrivyRunner adapter          │           │
│   3. TrivyRunner.scan(dir)   -> writes report.json           │           │
│   4. ReportParser.stream(report.json, onCritical) ───────────┘ updates  │
│   5. ScanRepository.save(id, {status, criticals})               status  │
│   6. finally: rm(tmpDir, {recursive:true, force:true})                   │
└───────────────────────────────────────────────┬─────────────────────────┘
                                                 │ uses (infrastructure adapters)
                                                 ▼
┌───────────────────────────────────────────────────────────────────────┐
│                       INFRASTRUCTURE ADAPTERS                           │
│  RepoCloner (simple-git/execa git clone --depth 1)                      │
│  TrivyRunner (spawn trivy binary or docker run aquasecurity/trivy:0.69.3) │
│  ReportParser (stream-json: parser -> pick('Results') -> streamArray)  │
│  ScanRepository (ioredis: HSET/HGETALL scan:<id>)                       │
└───────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| REST Controller | Parse HTTP request, validate `repoUrl`, call `ScanService`, map result to HTTP status/JSON | Express route handler, thin — no business logic |
| GraphQL Resolver | Parse GraphQL args, call the **same** `ScanService` methods, map result to GraphQL type | Apollo Server resolver map, thin — no business logic |
| ScanService | Orchestration: generate `scanId`, enqueue BullMQ job, read scan status/result for `GET` | Plain TS class/module, framework-agnostic, injected with `Queue` + `ScanRepository` |
| BullMQ Queue/Worker | Durable job queue: retries, concurrency=1 (memory safety), restart survival | `bullmq` `Queue` (producer side, used by Service) + `Worker` (consumer side, separate process) |
| ScanProcessor | The actual job body: clone → trivy → parse → store → cleanup, always in that order, always cleaning up | BullMQ processor function, calls infrastructure adapters only — never touches HTTP/GraphQL types |
| RepoCloner | Clone a GitHub URL into a given temp dir; validate/sanitize URL (SSRF/arg-injection guard) | Wraps `simple-git` or `execa('git', ['clone','--depth','1', url, dir])` |
| TrivyRunner | Run Trivy against the cloned dir, write JSON report to a known path; detect local binary vs Docker fallback | `execa('trivy', [...])` or `execa('docker', ['run', ...])`; captures exit code + stderr for error mapping |
| ReportParser | Stream-parse the Trivy JSON report, emit only `Severity === "CRITICAL"` items, never load the file into memory | `stream-json` pipeline: `parser()` → `pick({filter:'Results'})` → `streamArray()` → per-item filter |
| ScanRepository | Single source of truth for scan state exposed to callers; independent of BullMQ's internal job keys | Redis hash `scan:<scanId>` with fields `status`, `error`, `vulnerabilities` (JSON string), `updatedAt` |

## Recommended Project Structure

```
src/
├── api/
│   ├── rest/
│   │   ├── scan.controller.ts     # POST /api/scan, GET /api/scan/:id — thin, calls ScanService
│   │   └── routes.ts              # Express router wiring
│   ├── graphql/
│   │   ├── schema.ts              # type Scan { id, status, criticalVulnerabilities }
│   │   └── scan.resolvers.ts      # thin — calls the SAME ScanService methods as REST
│   └── server.ts                  # Express + Apollo bootstrap (API process entrypoint)
├── services/
│   └── scan.service.ts            # ScanService: createScan(), getScan() — orchestration only
├── worker/
│   ├── worker.ts                  # BullMQ Worker bootstrap (worker process entrypoint)
│   └── scan.processor.ts          # ScanProcessor: the clone->trivy->parse->store->cleanup pipeline
├── infrastructure/
│   ├── queue/
│   │   └── scan.queue.ts          # BullMQ Queue instance + job name/type contracts
│   ├── repo-cloner/
│   │   └── git-repo-cloner.ts     # RepoCloner adapter (git clone, URL validation)
│   ├── trivy/
│   │   └── trivy-runner.ts        # TrivyRunner adapter (binary or Docker fallback)
│   ├── report-parser/
│   │   └── stream-json-parser.ts  # ReportParser adapter (stream-json pipeline)
│   └── redis/
│       └── scan.repository.ts     # ScanRepository adapter (Redis hash per scanId)
├── domain/
│   ├── scan.types.ts              # ScanStatus, ScanRecord, CriticalVulnerability interfaces
│   └── trivy-report.types.ts      # Strict TS interfaces for Trivy report shape (no `any`)
└── config/
    └── env.ts                     # Redis URL, concurrency, tmp dir base, trivy mode, etc.
```

### Structure Rationale

- **api/**: Two thin transport adapters (REST, GraphQL) that never diverge in business logic — they exist to prove the "same service, two protocols" pattern the grading rubric rewards.
- **services/**: The one place orchestration logic lives. `ScanService` never imports `express`, `apollo-server`, `fs`, or `child_process` — it only knows about the Queue and the Repository interfaces. This is the seam graders check for "Service" separation.
- **worker/**: A separate entrypoint (`worker.ts`) so the worker can run as its own process/container. `ScanProcessor` is the only place the multi-step pipeline (clone → trivy → parse → store → cleanup) is sequenced — this is the "Worker" the rubric names explicitly.
- **infrastructure/**: All I/O with the outside world (git, trivy binary, filesystem, Redis) is isolated behind small adapter classes/functions with narrow interfaces. This is what lets `ScanService` and `ScanProcessor` stay testable and framework-agnostic, and is the detail that separates a "clean separation" submission from a merely-organized-by-folder one.
- **domain/**: Pure types/interfaces, zero runtime dependencies — satisfies the "strict TypeScript, proper interfaces for Trivy report shapes" requirement independently of any layer.

## Architectural Patterns

### Pattern 1: Thin Controller / Fat-Free Service / Adapter-Isolated Worker

**What:** Controllers (REST + GraphQL) only translate transport ↔ domain calls. `ScanService` holds orchestration logic (generate id, enqueue, read status) but delegates all actual I/O to adapters. The BullMQ `Worker`/processor is a separate runtime entrypoint that sequences adapter calls; it is not "part of" the service, it is a distinct process that happens to call into shared adapters.
**When to use:** Any system where the API's job is to accept work fast and a background process does the heavy lifting — exactly this assignment's shape.
**Trade-offs:** Slightly more files/interfaces than a monolithic router-does-everything script; pays off immediately once GraphQL is added, because GraphQL resolvers reuse `ScanService` with zero duplication.

**Example:**
```typescript
// services/scan.service.ts — no fs, no express, no child_process imports
export class ScanService {
  constructor(private queue: ScanQueue, private repo: ScanRepository) {}

  async createScan(repoUrl: string): Promise<{ scanId: string }> {
    const scanId = randomUUID();
    await this.repo.create(scanId, { status: 'Queued' });
    await this.queue.add('scan', { scanId, repoUrl });
    return { scanId };
  }

  async getScan(scanId: string): Promise<ScanRecord | null> {
    return this.repo.get(scanId);
  }
}
```

### Pattern 2: Ports-and-Adapters for Infrastructure

**What:** Define narrow TypeScript interfaces (`RepoCloner`, `TrivyRunner`, `ReportParser`, `ScanRepository`) that the worker's processor depends on; concrete implementations (git/execa, trivy binary/Docker, stream-json, ioredis) live behind those interfaces.
**When to use:** Whenever a component talks to the filesystem, a subprocess, or an external store — i.e., exactly the four infrastructure adapters this project needs.
**Trade-offs:** Adds an interface per adapter (small overhead) in exchange for: (a) the processor becomes unit-testable with fakes, (b) swapping "local trivy binary" for "Docker trivy" is a one-file change, (c) it is the concrete evidence graders look for under "clean separation of concerns" beyond just folder names.

**Example:**
```typescript
// domain/ports.ts
export interface ReportParser {
  streamCriticals(reportPath: string): AsyncIterable<CriticalVulnerability>;
}

// infrastructure/report-parser/stream-json-parser.ts
export class StreamJsonReportParser implements ReportParser {
  async *streamCriticals(reportPath: string) {
    const pipeline = chain([
      fs.createReadStream(reportPath),
      parser(),
      pick({ filter: 'Results' }),
      streamArray(),
    ]);
    for await (const { value } of pipeline) {
      for (const vuln of value.Vulnerabilities ?? []) {
        if (vuln.Severity === 'CRITICAL') yield vuln;
      }
    }
  }
}
```

### Pattern 3: Independent Status Record, Not BullMQ Internals

**What:** The worker writes scan status/results into a dedicated `ScanRepository` (Redis hash `scan:<scanId>`) that is keyed by the domain `scanId`, not by BullMQ's internal job id/keys. `GET /api/scan/:scanId` reads only from this repository.
**When to use:** Any time an API needs to expose job status to external clients under a domain-specific contract (`Queued|Scanning|Finished|Failed`) rather than BullMQ's own state machine (`waiting|active|completed|failed`), and needs that state to survive BullMQ's job cleanup/TTL settings.
**Trade-offs:** One extra write per phase transition vs. reading `job.getState()` directly; in exchange the API contract is decoupled from queue-library internals, survives `removeOnComplete`/`removeOnFail` eviction, and the mapping from BullMQ states to product-facing states (`Scanning` has no BullMQ equivalent) is explicit rather than inferred.

## Data Flow

### Request Flow (submit scan)

```
Client → POST /api/scan {repoUrl}
    ↓
REST Controller: validate body
    ↓
ScanService.createScan(repoUrl)
    ↓                              ↓
ScanRepository.create(id,          BullMQ Queue.add('scan', {id, repoUrl})
  {status:'Queued'})                    ↓
    ↓                              (persisted in Redis, picked up later
Controller returns 202             by whichever worker process is free)
  {scanId, status:'Queued'}
```

### Request Flow (poll status)

```
Client → GET /api/scan/:scanId
    ↓
REST Controller (or GraphQL resolver `Scan.status`)
    ↓
ScanService.getScan(scanId)
    ↓
ScanRepository.get(scanId)   ← reads Redis hash scan:<id>
    ↓
Controller/Resolver maps record → response DTO
    ↓
Client ← {status, criticalVulnerabilities?, error?}
```

### Worker Flow (background processing — the memory-critical path)

```
BullMQ Worker picks up job {scanId, repoUrl}
    ↓
ScanRepository.update(scanId, {status:'Scanning'})
    ↓
tmpDir = fs.mkdtemp(os.tmpdir()/scan-<id>-)
    ↓                                    (try block starts here)
RepoCloner.clone(repoUrl, tmpDir)   -- git clone --depth 1
    ↓
TrivyRunner.scan(tmpDir) → tmpDir/report.json   (500MB+ file, on disk, not in memory)
    ↓
ReportParser.streamCriticals(tmpDir/report.json)
    stream.pipeline([
      fs.createReadStream(report.json),   ← bounded read buffer (highWaterMark)
      parser(),                            ← tokenizer, one token at a time
      pick({filter:'Results'}),            ← ignores everything outside Results
      streamArray(),                       ← one array element materialized at a time
    ])
    → for each element, filter Severity==='CRITICAL' → push into a small accumulator array
    ↓
ScanRepository.update(scanId, {status:'Finished', vulnerabilities: criticals})
    ↓                                    (finally block, always runs)
fs.rm(tmpDir, {recursive:true, force:true})
```

### Key Data Flows

1. **Enqueue-then-poll:** The only synchronous work on the API path is a Redis write + BullMQ enqueue (both O(1), sub-millisecond) — this is what makes `POST /api/scan` non-blocking regardless of repo size or Trivy runtime.
2. **Bounded-memory extraction:** Memory stays flat because at no point does any component hold more than: (a) one stream `highWaterMark` chunk of raw JSON text, (b) one parsed array element, (c) the (small, filtered) list of CRITICAL vulnerabilities found so far. The 500MB report file only ever exists on disk and in the OS page cache, never as a JS heap object.
3. **State handoff via Redis, not via memory:** The API process and worker process never share memory or call each other directly — every piece of scan state crosses the process boundary through Redis (BullMQ queue for "do this job", `ScanRepository` for "here's the current status"). This is what makes running them as separate containers safe and is the load-bearing reason the architecture satisfies the Controller/Service/Worker rubric line rather than just organizing files that way.

## Suggested Build Order

Dependencies flow bottom-up; each step should be independently testable before the next depends on it:

1. **Domain types** (`domain/scan.types.ts`, `domain/trivy-report.types.ts`) — no dependencies, unblocks everything else's type-checking.
2. **ScanRepository** (Redis adapter) — needed by both ScanService and ScanProcessor; test with a real/local Redis or `ioredis-mock`.
3. **ReportParser** (stream-json adapter) — the highest-risk, most-graded component; build and prove it in isolation against the synthetic 500MB fixture and `--max-old-space-size=150` *before* wiring it into the worker.
4. **RepoCloner** and **TrivyRunner** adapters — independent of each other and of ReportParser; can be built in parallel.
5. **ScanQueue** (BullMQ Queue producer wrapper) — thin, depends only on `bullmq` + Redis connection config.
6. **ScanProcessor** (worker pipeline) — depends on 2, 3, 4, 5 all existing; this is where clone→trivy→parse→store→cleanup gets sequenced with try/finally.
7. **Worker entrypoint** (`worker/worker.ts`) — wires `ScanProcessor` into a BullMQ `Worker`, sets concurrency, starts listening.
8. **ScanService** — depends on ScanQueue (2/5) and ScanRepository (2); can actually be built in parallel with 3–7 since it only needs their interfaces, not their implementations (mock/stub them).
9. **REST Controller + routes** — depends on ScanService only.
10. **API entrypoint** (`api/server.ts`) — wires REST controller + Express, starts listening.
11. **GraphQL schema + resolvers** — depends on ScanService only (same as step 9); build after REST is proven so the resolver is demonstrably a thin second adapter over the identical service, not a divergent implementation.
12. **docker-compose.yml** (api, worker, redis services + mem_limit) — depends on 7 and 10 having real entrypoints to containerize.
13. **React frontend** — depends only on the REST (or GraphQL) contract being stable; build last, it has no bearing on the graded backend architecture.

Rationale for this order: the memory-proof pipeline (step 3) is both the hardest technical risk and the top-weighted grading criterion, so it is proven standalone before any queue/HTTP plumbing is built around it — avoids discovering a memory bug after the whole system is wired together.

## Process Topology Under the 256MB Constraint

| Topology | Memory implication | Recommendation |
|----------|--------------------|-----------------|
| Single process (API + worker in one `node` process, e.g. `Worker` created inline in the Express app) | Simplest to run, but a stuck/slow Trivy scan or a parser bug shares the same heap and event loop as the HTTP server — a memory spike or event-loop block in scanning degrades `GET /api/scan/:id` polling for *other* in-flight scans. | Acceptable for the "reviewer self-test" script (`node --max-old-space-size=150 dist/index.js`) if that script is explicitly the worker path, but not the recommended default for the real service. |
| Two processes, one container (API and worker both started by a supervisor/PM2 in the same container) | Each gets its own heap, but they compete for the same container-level `mem_limit` (e.g. 200MB total) — need to size `--max-old-space-size` for each so their sum stays under the cap. | Workable middle ground for a small take-home if only one docker image is desired, but harder to reason about headroom. |
| Two containers via docker-compose (api, worker, redis as separate services) | Each container gets its own memory limit and its own `--max-old-space-size`, sized independently (e.g. api: 64–96MB, worker: 150–200MB since it does the heavy streaming work). Matches the assignment's own reviewer test (`--max-old-space-size=150` for the pipeline) and its bonus requirement (`mem_limit: 200m` on "the app container"). | **Recommended.** Cleanly maps "Controller/Service" (API container) vs "Worker" (worker container) onto actual OS process/container boundaries — this is the strongest, most literal demonstration of the graded separation, and it is the natural reading of the assignment's own `docker-compose.yml` bonus. |
| BullMQ sandboxed processors (child process per job inside the worker container) | Adds isolation (crash containment, avoids event-loop-blocking "stalled" job errors) but each spawned child process gets its own V8 heap — duplicate baseline memory overhead on top of an already tight 150–200MB budget. | **Avoid for this assignment.** One job type, one job at a time (or low concurrency) in-process is more memory-predictable; sandboxing solves a multi-tenant/many-job-types problem this project doesn't have. Note the trade-off explicitly in ONBOARDING.md as a "considered and rejected" decision — it reads as senior-level judgment. |

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| Take-home / reviewer run (1 scan at a time) | Exactly the topology above: 1 api container, 1 worker container (concurrency 1–2), 1 redis container. No changes needed. |
| Light real usage (a handful of concurrent scans) | Increase worker `concurrency` cautiously (each concurrent job needs its own tmp dir + its own bounded parser memory — budget accordingly under the container's `mem_limit`), or scale worker *replicas* (multiple worker containers) rather than raising concurrency per container, since BullMQ workers coordinate safely over shared Redis. |
| Heavier usage (many concurrent large repos) | Move to per-worker-replica horizontal scaling (already supported by BullMQ's Redis-coordinated design, no code change), add a disk-space watchdog before clone (repos + reports can exhaust container disk before RAM), and consider capping report size or Trivy scan flags rather than raising memory limits. |

### Scaling Priorities

1. **First bottleneck: disk, not RAM.** Because the design keeps everything off the JS heap, a slow disk or full disk during clone/Trivy-write is the more likely real-world failure than an OOM — the architecture must treat "disk full" as a first-class error path (see PITFALLS.md), not an afterthought.
2. **Second bottleneck: worker concurrency vs. container memory.** Once concurrency > 1, each concurrent job's tmp dir + in-flight parse state adds up; the fix is horizontal (more worker containers) rather than vertical (raising `--max-old-space-size`), because raising heap size per container undermines the whole memory-efficiency thesis of the project.

## Anti-Patterns

### Anti-Pattern 1: Business logic in the BullMQ processor callback directly

**What people do:** Write `new Worker('scan', async (job) => { /* git clone here, trivy exec here, fs.readFile here */ })` with all logic inline in the processor function, no adapters.
**Why it's wrong:** Makes the pipeline untestable without a real Redis+git+trivy environment, and — critically for this project's grading — collapses "Worker" and "infrastructure adapters" into one undifferentiated blob, which is exactly what the "clean separation of concerns" criterion is checking for.
**Do this instead:** Keep the processor function as a short sequence of calls into `RepoCloner`, `TrivyRunner`, `ReportParser`, `ScanRepository` — the processor orchestrates, the adapters execute.

### Anti-Pattern 2: GraphQL resolvers re-implementing REST controller logic

**What people do:** Duplicate the enqueue/status-read logic inside GraphQL resolvers instead of calling `ScanService`, because "GraphQL needs it shaped differently."
**Why it's wrong:** Two independent implementations of "how a scan is created/read" will drift, double the surface area for bugs, and directly contradicts the "same service layer serves both" decision already logged in PROJECT.md.
**Do this instead:** Resolvers call `ScanService.createScan`/`getScan` and only handle GraphQL-specific shaping (e.g., renaming fields, wrapping in `Scan` type).

### Anti-Pattern 3: Reading BullMQ job state as the API's source of truth

**What people do:** Implement `GET /api/scan/:id` by calling `queue.getJob(id)` and mapping `job.getState()` directly to the response.
**Why it's wrong:** Couples the public API contract to a queue library's internal lifecycle and job-retention settings (`removeOnComplete`, `removeOnFail`); a completed job can vanish from BullMQ before a client polls for the last time, and BullMQ's states (`waiting/active/completed/failed`) don't map 1:1 onto the assignment's required states (`Queued/Scanning/Finished/Failed` — note "Scanning" has no BullMQ equivalent).
**Do this instead:** Maintain the independent `ScanRepository` record described in Pattern 3; the worker updates it explicitly at each phase, and the API only ever reads from it.

### Anti-Pattern 4: Skipping `stream.pipeline`/backpressure-aware composition

**What people do:** Chain streams manually with `.pipe()` calls and separate `.on('error', ...)` listeners on each stream, or worse, buffer chunks into an array before parsing.
**Why it's wrong:** `.pipe()` does not propagate errors between stages or guarantee cleanup on failure, which under this project's grading is doubly bad: it risks both a silent hang on Trivy/parse failure and a memory leak from undestroyed streams.
**Do this instead:** Use `stream/promises`' `pipeline([...])`, awaited inside a try/catch, so any stage's error surfaces once and all streams are destroyed automatically — pairs naturally with the per-scan temp-dir `finally` cleanup.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Redis | `ioredis` client, shared by BullMQ (`Queue`/`Worker`) and `ScanRepository` — can be the same connection or separate connections per concern | Use distinct key prefixes/namespaces (`bull:scan:*` vs `scan:*`) so BullMQ's own keys and the domain status hash never collide |
| Trivy | Either a local `trivy` binary on PATH or `docker run aquasecurity/trivy` as fallback, invoked via `execa`/`child_process.spawn` (never `exec` with string interpolation of the repo path — argument-array form avoids shell injection) | Detect availability at worker startup, not per-job, to fail fast with a clear error rather than per-scan |
| GitHub (clone target) | `git clone --depth 1 <url> <tmpDir>` via `simple-git` or `execa('git', [...])`, argument-array form | Validate/allowlist the URL shape before ever passing it to a subprocess (see PITFALLS.md for SSRF/argument-injection concerns) |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| REST Controller ↔ ScanService | Direct in-process function call | No DTO translation needed beyond basic validation; keep controller free of business rules |
| GraphQL Resolver ↔ ScanService | Direct in-process function call | Same instance/module as REST uses — enforce via DI container or simple module singleton, not two separately constructed services |
| ScanService ↔ BullMQ Queue | `queue.add(name, data)` — async, fire-and-forget from the Service's perspective | Service never awaits job completion; that would reintroduce blocking behavior the design explicitly avoids |
| ScanService / ScanProcessor ↔ ScanRepository | Redis reads/writes through the same adapter interface, from two different processes | Both processes need their own Redis connection instance (do not share a connection object across process boundaries — they're already separate processes) |
| API process ↔ Worker process | No direct communication — only via Redis (queue + repository) | This is the load-bearing boundary for the "separate containers" topology; if any code path calls between them directly, the container split is fake |

## Sources

- [BullMQ official architecture docs](https://docs.bullmq.io/guide/architecture) — MEDIUM (official docs, web-search-sourced)
- [BullMQ sandboxed processors docs](https://docs.bullmq.io/guide/workers/sandboxed-processors) — MEDIUM (official docs)
- [BullMQ concurrency docs](https://docs.bullmq.io/guide/workers/concurrency) — MEDIUM (official docs)
- [stream-json GitHub README/wiki](https://github.com/uhop/stream-json) — MEDIUM (official project docs, fetched directly)
- [Node.js backpressuring-in-streams docs](https://nodejs.org/learn/modules/backpressuring-in-streams) — MEDIUM (official Node.js docs)
- [How to Run BullMQ Workers in Docker](https://oneuptime.com/blog/post/2026-01-21-bullmq-workers-docker/view) — LOW (community blog, cross-checked against official docs)
- [How to Scale BullMQ Workers Horizontally](https://oneuptime.com/blog/post/2026-01-21-bullmq-horizontal-scaling/view) — LOW (community blog)
- [Background Job Processing in Node.js: BullMQ, Queues, and Worker Patterns](https://dev.to/young_gao/background-job-processing-in-nodejs-bullmq-queues-and-worker-patterns-31d4) — LOW (community blog)
- [Mastering Clean Code with Hexagonal (Ports & Adapters) Architecture in Node.js](https://alwaysdeveloper.com/mastering-clean-code-with-hexagonal-ports-adapters-architecture-in-node-js-4cf66800d04d) — LOW (community blog)
- [Hexagonal Architecture in Node.js Microservices: A Practical Guide](https://medium.com/@shreevedhas/hexagonal-architecture-in-node-js-microservices-a-practical-guide-e3419f2c94b3) — LOW (community blog)
- [GraphQL Resolvers: Best Practices — PayPal Tech Blog](https://medium.com/paypal-tech/graphql-resolvers-best-practices-cd36fdbcef55) — LOW (community/corporate blog)
- [GraphQL.js resolver anatomy](https://www.graphql-js.org/docs/resolver-anatomy/) — MEDIUM (official docs)
- [Secure tempfiles in NodeJS without dependencies](https://advancedweb.hu/secure-tempfiles-in-nodejs-without-dependencies/) — LOW (community blog)
- [Managing Redis Memory Limits in Docker-Compose](https://peterkellner.net/2023-09-24-managing-redis-memory-limits-with-docker-compose/) — LOW (community blog)
- Cross-checked: all patterns above (layered/ports-and-adapters separation, separate API/worker processes, independent status store, stream.pipeline for error/backpressure, avoiding sandboxed processors under tight memory) are corroborated by 2+ independent sources and align with official BullMQ/Node.js/stream-json documentation, supporting overall MEDIUM confidence despite individual sources being web-tier.

---
*Architecture research for: memory-constrained async security-scanner wrapper (Node.js/TypeScript)*
*Researched: 2026-07-09*
