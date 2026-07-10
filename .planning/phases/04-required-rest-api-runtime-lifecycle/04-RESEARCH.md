# Phase 4: Required REST API & Runtime Lifecycle - Research

**Researched:** 2026-07-10
**Domain:** NestJS 11 (Fastify adapter) HTTP transport layer, request validation, health checks, and graceful process lifecycle over an existing BullMQ/ioredis scan engine
**Confidence:** HIGH (transport/lifecycle APIs verified against official NestJS/BullMQ sources; integration-test strategy grounded in the working Phase 3 harness)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**URL validation policy (SCAN-02)**
- **D-01:** Accept **HTTPS `github.com` URLs only**: `https://github.com/{owner}/{repo}` with an optional `.git` suffix. Reject SSH (`git@github.com:...`), `git://`, `file://`, plain `http://`, and every non-GitHub host.
- **D-02:** Validation is **parse-then-allowlist with path-shape enforcement** (defense-in-depth): URL-parse the input; require `protocol === 'https:'`; require `hostname` to be exactly in `{github.com, www.github.com}`; reject embedded credentials (`user:pass@`); reject non-standard ports; and require a `/{owner}/{repo}` path matching GitHub's owner/repo naming rules. Explicitly rejects look-alike hosts (`github.com.evil.com`), userinfo, odd ports, and single-segment paths.
- **D-03:** Validation lives at the **controller boundary as a DTO + `ValidationPipe`** (custom validator/refinement on the DTO), so a malformed/non-GitHub URL returns **400 before `ScanService.enqueue` is ever called**. Keeps the controller thin and `ScanService` free of transport concerns (ARCH-01, D-02 from Phase 3). Rationale: SSRF/command-injection guard, defense-in-depth on top of the Phase 3 `shell: false` argv-array clone.

**Response contracts (SCAN-01, SCAN-03, SCAN-04, SCAN-05)**
- **D-04:** `POST /api/scan` returns **HTTP 202 Accepted** with body exactly `{ scanId, status: "Queued" }`. The response DTO maps the domain `id` field to the transport field name `scanId`; no engine work is awaited.
- **D-05:** `GET /api/scan/:scanId` returns a **state-shaped DTO at HTTP 200**: `Queued`/`Scanning` → `{ scanId, status }`; `Finished` → adds `criticalVulnerabilities: [...]`; `Failed` → adds `error: { category, detail }`. An **unknown scanId returns 404** (mapping the `null` from `ScanService.get`, per Phase 3 D-11).
- **D-06:** The Finished vulnerabilities field is named **`criticalVulnerabilities`** — deliberately matching the future GraphQL `type Scan { criticalVulnerabilities }` (API-01).
- **D-07:** The Failed error body exposes **both `category` and `detail`**: `category` is the bounded domain enum (`clone`/`trivy`/`disk-full`/`timeout`/`parse`/`unknown`), `detail` is the ≤500-char sanitized message from Phase 3.

**Health check (API-03)**
- **D-08:** `/health` performs an **active Redis `PING`** (~1s timeout) over an **existing** connection (the BullMQ producer queue's ioredis connection or the `ScanRepository`'s client). Do NOT open a third Redis connection.
- **D-09:** `/health` returns **503 Service Unavailable when Redis is unreachable, 200 when healthy** (both with a JSON body).
- **D-10:** Health body includes **`{ status, redis, uptime }`**. It does NOT probe Trivy/Docker.

**Graceful shutdown (ERR-05)**
- **D-11:** On SIGTERM/SIGINT the **worker drains**: stop pulling new jobs, let the active scan complete via BullMQ `worker.close()`, then close Redis/repository connections and exit 0.
- **D-12:** The drain is **bounded by a configurable `SHUTDOWN_GRACE_MS`** (default ~8s, under Docker's default 10s window). If the grace elapses, force-close (`worker.close(true)`) and exit. Add `SHUTDOWN_GRACE_MS` to the Joi env schema with a safe default.
- **D-13:** Shutdown is wired through **Nest lifecycle hooks on both entrypoints**: `enableShutdownHooks()` (present in `src/index.ts`; add to `src/worker.ts`) plus `OnApplicationShutdown`/`onModuleDestroy` in the providers that own the worker/queue and Redis clients. Avoid hand-rolled `process.on` handlers.
- **D-14:** The **API** shutdown path is lighter: stop accepting requests and close its queue/repository Redis handles via the same lifecycle hooks. No job-draining concern.

### Claude's Discretion
- Exact controller/DTO file names and directory layout under `apps/api/src` (e.g., `scan.controller.ts` + `health.controller.ts`, or a small `http/` folder), provided controllers stay thin and delegate to `ScanService`.
- The precise GitHub owner/repo naming regex, provided it enforces two path segments and rejects the look-alike/userinfo/port cases in D-02.
- Whether URL validation uses class-validator decorators, a custom `PipeTransform`, or a framework-free `validateGithubUrl()` helper the DTO calls — provided the 400-before-enqueue and thin-controller contracts hold.
- Whether `/health` is a dedicated controller or a route on an existing one; the exact PING timeout value; and which existing ioredis handle it borrows.
- The exact default value and env key casing for the shutdown grace, provided it is configurable, schema-validated, and defaults under the container SIGKILL window.
- Global vs per-controller `ValidationPipe` registration and the 400 error-envelope shape, provided malformed bodies are rejected before `ScanService`.

### Deferred Ideas (OUT OF SCOPE)
- **GraphQL `scan` query + enqueue mutation** (API-01/API-02) — Phase 6 / Bonus B; must reuse this same `ScanService` and the `criticalVulnerabilities` field name.
- **`scanId` log correlation across API and worker** (OPS-04) — Phase 5.
- **Docker Compose packaging + container memory gate + healthcheck wiring** (OPS-01/02) — Phase 5.
- **CORS for the React frontend** (FE-01..03) — Phase 6.
- **Rate limiting / auth / request-dedup** — out of scope (v2 SCALE / Out-of-Scope).
- **Integration-test strategy details** — noted in CONTEXT as a real design point left to research; resolved in this document (see Architecture Patterns → Integration Test Strategy).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SCAN-01 | `POST /api/scan` returns `{ scanId, status: "Queued" }` immediately, non-blocking | `@HttpCode(202)` + thin controller awaits only `ScanService.enqueue` (which itself only persists + `queue.add`, no engine work). Response DTO maps `id`→`scanId`. See Architecture Pattern 1. |
| SCAN-02 | Rejects missing/malformed/non-GitHub URLs with 400 before enqueue | `ValidationPipe` (global or route) rejects before the handler body runs → 400 before `enqueue`. Pure `parseGithubUrl()` validator (Pattern 2). |
| SCAN-03 | `GET /api/scan/:scanId` returns current status | Controller delegates to `ScanService.get(id)`; maps `Scan.status`. State-shaped response DTO (Pattern 3). |
| SCAN-04 | Finished → CRITICAL vulns; Failed → error reason | Map `Scan.vulnerabilities`→`criticalVulnerabilities` (Finished) and `Scan.error {category,detail}`→`error` (Failed). Source shapes in `domain/scan.types.ts` + `domain/vulnerability.types.ts`. |
| SCAN-05 | Unknown scanId → 404 | `ScanService.get` already returns `null` (Phase 3 D-11); controller throws `NotFoundException` on `null`. |
| API-03 | `GET /health` reports service + Redis connectivity | Health provider injects the existing `REDIS_CLIENT` ioredis handle, runs `PING` with a ~1s race timeout; 200/`{status:'ok',redis:'up',uptime}` or 503/`{status:'error',redis:'down',uptime}`. Pattern 4. |
| ARCH-01 | Thin transport adapters, one shared `ScanService` | Controllers contain no business logic, no `fs`/`child_process`/URL-parse in the service; validation + status mapping live in transport. Enforced by an import-guard spec (Pattern 5). |
| ERR-05 | Graceful SIGTERM/SIGINT shutdown, drain + close | `enableShutdownHooks()` + a bounded-drain lifecycle hook racing `worker.close()` vs `SHUTDOWN_GRACE_MS` then `worker.close(true)`; explicit close of the hand-rolled `REDIS_CLIENT`. Pattern 6. |
</phase_requirements>

## Summary

Phase 4 is a **thin transport + lifecycle layer** over a fully-built engine. Nearly all technical risk is not in the HTTP handlers (which are idiomatic NestJS) but in two places: (1) proving the required end-to-end path (success criterion #5) **without importing the `@nestjs/bullmq`-wired module into Jest**, which triggers the confirmed `@swc/core` miette native panic on Node 22 AND 24; and (2) implementing a **bounded** graceful drain, because BullMQ's `worker.close()` has no built-in timeout and `@nestjs/bullmq`'s own teardown does not expose a configurable grace window.

The good news: Phase 3 already solved both shapes of problem. The working `scripts/scan-engine-integration.mjs` harness (compiled `dist/worker.js` + disposable Redis container + `node:test`) is the exact mechanism to extend for the `POST → Queued → poll → Finished/Failed` proof — it just needs the compiled `dist/index.js` API process started alongside the worker (or an in-process Nest HTTP app that never imports the worker/BullMQ graph). And the Phase 3 "plain-logic-in-a-testable-function, wiring-validated-by-compiled-.mjs" split is the template for the shutdown drain: put the `raceDrain(worker, graceMs)` logic in a plain function (unit-tested with a fake worker), wire it into a `@nestjs/bullmq`-adjacent lifecycle provider that only the compiled process ever loads.

**Primary recommendation:** Add three controllers (`scan.controller.ts`, `health.controller.ts`) + response/request DTOs under `apps/api/src/http/`, a pure `parseGithubUrl()` validator behind a custom `ValidationPipe`/class-validator DTO, a `HealthService` that PINGs the injected `REDIS_CLIENT` with a 1s race, and a bounded-drain lifecycle hook. Prove SCAN-01..05 + API-03 with Jest controller specs against a mocked `ScanService` (no BullMQ in the graph), and prove ERR-05 + the full async contract with an extended compiled-process `.mjs` harness.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| GitHub URL validation / 400 | API / HTTP transport (ValidationPipe/DTO) | — | Transport concern (D-03, ARCH-01); must reject before the service. Never in `ScanService`. |
| `POST /api/scan` → enqueue | API / HTTP transport (controller) | Backend service (`ScanService.enqueue`) | Controller is a thin adapter; orchestration already lives in the shared service. |
| `GET /api/scan/:id` status/results | API / HTTP transport (controller + response DTO) | Backend service (`ScanService.get`) + Redis (`ScanRepository`) | Controller maps domain `Scan`→state-shaped DTO; data owned by Redis. |
| 404 for unknown id | API / HTTP transport (controller `NotFoundException`) | Backend service (returns `null`) | Null-to-HTTP mapping is a transport decision (D-05). |
| `/health` Redis PING | API / HTTP transport (health controller/service) | Redis (`REDIS_CLIENT` ioredis) | Liveness is an API-tier concern; borrows an existing connection (D-08). |
| Graceful drain of active scan | Worker process (BullMQ worker lifecycle) | Redis (job/connection state) | Only the worker consumes jobs; drain is a worker-tier concern (D-11). |
| API shutdown (stop accepting, close handles) | API process (Nest lifecycle) | Redis (queue producer + repo connections) | API is a producer; lighter shutdown (D-14). |
| Env schema `SHUTDOWN_GRACE_MS` | Config (Joi at boot) | Both processes | Fail-closed validated config, extends the OPS-03 pattern. |

## Standard Stack

### Core (already installed — no new runtime deps required for the minimal path)
| Library | Version (installed) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @nestjs/common | 11.1.28 | Controllers, pipes, `@HttpCode`, `NotFoundException`, lifecycle interfaces | Already the framework; provides everything the transport layer needs. `[VERIFIED: npm registry]` current is 11.1.28. |
| @nestjs/platform-fastify | 11.1.28 | Fastify HTTP adapter (`NestFastifyApplication`) | Already wired in `src/index.ts`; global `ValidationPipe`, `@HttpCode`, and exception filters all work identically on Fastify. `[VERIFIED: npm registry]` |
| @nestjs/core | 11.1.28 | `NestFactory`, `enableShutdownHooks()`, lifecycle dispatch | Owns the SIGTERM/SIGINT → hook wiring. |
| bullmq | 5.79.3 | `Worker.close(force)` drain/force semantics | The worker instance to drain; `close(force=false)` drains, `close(true)` forces. `[VERIFIED: bullmq source/docs]` |
| ioredis | 5.11.1 | `.ping()` for the `/health` probe over the existing `REDIS_CLIENT` | Already the repository's client; `ping()` returns `'PONG'`. |
| joi | 18.2.3 | Add `SHUTDOWN_GRACE_MS` to the boot schema | Extends the existing `env.validation.ts` fail-closed pattern (OPS-03). |

### Supporting (OPTIONAL — only if the DTO-decorator validation style is chosen over a pure validator)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| class-validator | 0.15.1 | Declarative DTO validation decorators (`@IsString`, custom `@Validate`) for the `ValidationPipe` | Only if the team prefers idiomatic decorator DTOs over a framework-free validator. `[CITED: docs.nestjs.com/techniques/validation]` — NestJS's officially recommended validation library. |
| class-transformer | 0.5.1 | Payload→DTO-class transformation that `ValidationPipe` uses | Peer of class-validator; required together when `transform: true`. |

> **Note:** Neither package is currently installed. The **default recommendation is the zero-dependency custom pipe** (see Alternatives Considered). Both were legitimacy-audited (below) so the planner can choose the decorator style with confidence if desired.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Zero-dep custom `ValidationPipe` wrapping `parseGithubUrl()` | class-validator DTO + global `ValidationPipe` | Decorator DTOs are the recognized NestJS idiom a senior reviewer expects, but add two runtime deps and pull `reflect-metadata`/decorator-metadata into the validation path. The pure-function pipe is leaner (matters under the 256MB ethos), trivially unit-testable with no module graph, and carries zero Jest-panic risk. **Recommend the pure validator for this memory-conscious, minimal-dep project; document the tradeoff in ONBOARDING.** |
| `NotFoundException` (throw) for 404 | Manual `reply.code(404)` on the Fastify reply | Throwing the built-in exception is idiomatic, adapter-agnostic, and testable without a real HTTP server. Avoid touching the raw Fastify reply. |
| Global `ValidationPipe` (`app.useGlobalPipes`) | Per-route `@UsePipes` / per-param pipe | Global is the standard; a param-level custom pipe is fine for a single field. Either satisfies "400 before enqueue." |

**Installation (only if decorator-DTO style is chosen):**
```bash
npm install class-validator@0.15.1 class-transformer@0.5.1
```
The minimal path (pure validator) requires **no `npm install`**.

## Package Legitimacy Audit

> Only relevant if the optional decorator-DTO validation style is adopted. The minimal path adds no packages.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| class-validator | npm | published 2026-02-26 (v0.15.1) | ~10.0M/wk | github.com/typestack/class-validator | OK | Approved (only if decorator style chosen) |
| class-transformer | npm | published 2021-11-22 (v0.5.1) | ~10.6M/wk | github.com/typestack/class-transformer | OK | Approved (only if decorator style chosen) |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none
No postinstall scripts on either package (`postinstall: null`).

## Architecture Patterns

### System Architecture Diagram

```
                         ┌────────────────────────── API process (dist/index.js) ──────────────────────────┐
 client                  │                                                                                   │
   │  POST /api/scan      │   Fastify HTTP  ──▶ ValidationPipe (parseGithubUrl)                              │
   ├────────────────────▶│         │              │ invalid → 400 (BEFORE handler runs)                     │
   │                      │         ▼ valid                                                                  │
   │   202 {scanId,       │   ScanController.create ──▶ ScanService.enqueue(repoUrl)                         │
   │◀──── status:Queued}  │                                     │ (persist Queued + queue.add — no wait)     │
   │                      │                                     ▼                                            │
   │  GET /api/scan/:id   │   ScanController.get  ──▶ ScanService.get(id) ──▶ ScanRepository.get             │
   ├────────────────────▶│         │ null → 404 (NotFoundException)          │                              │
   │  200 state-shaped    │         │ Scan → map to state-shaped DTO         │                              │
   │◀────────────────────│         ▼                                        │                              │
   │  GET /health         │   HealthController ──▶ HealthService.check ──▶ REDIS_CLIENT.ping() (1s race)     │
   ├────────────────────▶│                                     up→200 / down→503                            │
   │                      │                                                  │                              │
   │                      │   SIGTERM/SIGINT ─▶ enableShutdownHooks ─▶ onModuleDestroy: close queue+redis   │
   └──────────────────────┼──────────────────────────────────────────────────────┬───────────────────────┘
                          │                                                        │ shared ScanModule
              ┌───────────▼────────── Redis ───────────▼──────────┐                │ (queue + REDIS_CLIENT + ScanService)
              │  scan:<id> hash · scan:<id>:critical list · BullMQ │                │
              │  'scan' queue                                      │                │
              └───────────▲───────────────────────────────────────┘                │
                          │ consume job                                             │
  ┌───────────────────────┼──────────── Worker process (dist/worker.js) ───────────┼──┐
  │  BullMQ Worker (concurrency 1) ─▶ ScanWorker.process ─▶ ScanEngine.run          │  │
  │  SIGTERM/SIGINT ─▶ enableShutdownHooks ─▶ bounded drain hook:                   │  │
  │     race[ worker.close() , timeout(SHUTDOWN_GRACE_MS) ] ─▶ on timeout close(true)│ │
  │     then close REDIS_CLIENT, exit 0                                             │  │
  └────────────────────────────────────────────────────────────────────────────────┘
```

Primary use case trace: client `POST` → ValidationPipe (400 on bad URL) → `ScanService.enqueue` → 202 `{scanId,"Queued"}` → job in Redis → worker consumes → engine transitions Redis state → client polls `GET` → controller maps `Scan`→state-shaped DTO (or 404).

### Recommended Project Structure
```
apps/api/src/
├── http/                       # NEW — all HTTP transport (Claude's discretion on exact layout)
│   ├── scan.controller.ts      # POST /api/scan, GET /api/scan/:scanId — thin, delegates to ScanService
│   ├── health.controller.ts    # GET /health — delegates to HealthService
│   ├── health.service.ts       # PING the injected REDIS_CLIENT with a bounded race
│   ├── dto/
│   │   ├── create-scan.dto.ts       # { repoUrl } request DTO + validation binding
│   │   └── scan-response.ts         # mappers: Scan -> {scanId,status[,criticalVulnerabilities|error]}
│   └── validation/
│       ├── github-url.ts            # pure parseGithubUrl(input): {owner,repo} | null  (unit-tested)
│       └── github-url.pipe.ts       # custom PipeTransform OR class-validator constraint using the pure fn
├── lifecycle/                  # NEW — shutdown wiring
│   ├── drain.ts                # pure raceDrain(worker, graceMs) (unit-tested with a fake worker)
│   └── worker-shutdown.provider.ts  # @nestjs/bullmq-adjacent hook; ONLY loaded by compiled worker
├── scan/  (unchanged)          # ScanService, ScanRepository, ScanModule — consumed, not modified
├── app.module.ts               # register ScanController + HealthController + global ValidationPipe
└── worker.module.ts            # add the worker-shutdown provider
```

### Pattern 1: Non-blocking POST with explicit 202 (SCAN-01, D-04)
**What:** A thin controller method decorated to return 202, awaiting only the fast `enqueue`.
**When to use:** The submit endpoint.
```typescript
// Pattern per docs.nestjs.com/controllers (status code) + docs.nestjs.com/techniques/validation
// [CITED: docs.nestjs.com/controllers]
@Controller('api/scan')
export class ScanController {
  constructor(private readonly scans: ScanService) {} // ARCH-01: only the shared service

  @Post()
  @HttpCode(202) // D-04: 202 Accepted; overrides POST's default 201
  async create(@Body() body: CreateScanDto): Promise<{ scanId: string; status: 'Queued' }> {
    const scan = await this.scans.enqueue(body.repoUrl); // no engine work awaited
    return { scanId: scan.id, status: 'Queued' }; // id -> scanId on the wire (D-04)
  }
}
```

### Pattern 2: Parse-then-allowlist GitHub URL validation (SCAN-02, D-01/D-02)
**What:** A pure function does WHATWG `URL` parsing + allowlist + path-shape; the pipe/DTO just calls it and throws `BadRequestException` (→ 400) on `null`. Because a `ValidationPipe`/pipe runs **before** the handler body, `enqueue` is never reached on invalid input (D-03).
```typescript
// [CITED: github.com/dead-claudia/github-limits — owner ≤39 alnum/hyphen no lead/trail/double hyphen; repo ≤100 alnum . _ -]
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;      // no leading/trailing/double hyphen, ≤39
const REPO  = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;                        // alnum . _ - ; not "." or ".."
const HOSTS = new Set(['github.com', 'www.github.com']);

export function parseGithubUrl(input: unknown): { owner: string; repo: string } | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2048) return null;
  let u: URL;
  try { u = new URL(input); } catch { return null; }          // rejects ssh/git@ scp-syntax, garbage
  if (u.protocol !== 'https:') return null;                    // rejects http:, git:, file:, ssh:
  if (u.username || u.password) return null;                   // rejects user:pass@ (D-02 userinfo)
  if (u.port !== '') return null;                              // rejects odd ports (D-02)
  if (!HOSTS.has(u.hostname)) return null;                     // exact host; rejects github.com.evil.com
  const parts = u.pathname.replace(/^\/+/, '').split('/');
  if (parts.length !== 2) return null;                         // exactly {owner}/{repo}; rejects single-segment
  const owner = parts[0] ?? '';
  let repo = parts[1] ?? '';
  if (repo.endsWith('.git')) repo = repo.slice(0, -4);         // optional .git suffix (D-01)
  if (!OWNER.test(owner) || !REPO.test(repo)) return null;
  return { owner, repo };
}
```
> `new URL('git@github.com:owner/repo.git')` throws (no scheme) → returns `null`; `new URL('git://…')`/`file://`/`http://` parse but fail the `protocol` gate. This is the SSRF/command-injection defense-in-depth D-03 calls for, layered on Phase 3's `shell:false` argv clone.

### Pattern 3: State-shaped GET response with 404 (SCAN-03/04/05, D-05)
```typescript
@Get(':scanId')
async get(@Param('scanId') scanId: string) {
  const scan = await this.scans.get(scanId);
  if (scan === null) throw new NotFoundException(); // SCAN-05, maps Phase 3 D-11 null → 404
  return toScanResponse(scan);                       // pure mapper below
}
// toScanResponse(scan): Queued/Scanning -> {scanId,status}
//   Finished -> {scanId,status,criticalVulnerabilities: scan.vulnerabilities ?? []}  (D-06 field name)
//   Failed   -> {scanId,status,error: {category, detail}}                             (D-07 shape)
```
Map from the existing domain types: `Scan.vulnerabilities: Vulnerability[]` (each `{vulnerabilityId,pkgName,installedVersion,severity:'CRITICAL',title,primaryUrl}`) and `Scan.error: {category, detail}`.

### Pattern 4: /health active PING with a bounded race (API-03, D-08/09/10)
**What:** Inject the already-bound `REDIS_CLIENT` (exported by `ScanModule`), race `ping()` against a ~1s timeout so a wedged socket cannot hang the endpoint. Return 503 on failure via `@HttpCode` + throwing `ServiceUnavailableException`, or set the reply code explicitly.
```typescript
@Injectable()
export class HealthService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}
  async redisUp(timeoutMs = 1000): Promise<boolean> {
    try {
      const pong = await Promise.race([
        this.redis.ping(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('ping timeout')), timeoutMs)),
      ]);
      return pong === 'PONG';
    } catch { return false; }
  }
}
// Controller: const up = await health.redisUp();
//   up  -> 200 { status: 'ok',    redis: 'up',   uptime: Math.floor(process.uptime()) }
//   down-> throw new ServiceUnavailableException({ status:'error', redis:'down', uptime: … })  // 503 + JSON body (D-09)
```
> `REDIS_CLIENT` is the repository's dedicated ioredis client — directly injectable via the exported Symbol (cleanest handle; the BullMQ queue's internal connection is not easily reachable). This is an **active** PING (D-08), not a passive `.status === 'ready'` read, so it catches a half-open socket.

### Pattern 5: Thin-controller enforcement (ARCH-01)
Mirror the Phase 3 `scan.service.spec.ts` import-guard: a Jest spec that reads `scan.controller.ts` source and asserts it imports **no** `node:fs`, `node:child_process`, `execa`, `@nestjs/bullmq`, or engine/parser modules — only `ScanService` (+ DTOs). This mechanically proves the controller is a pure transport adapter.

### Pattern 6: Bounded graceful drain (ERR-05, D-11/12/13/14)
**What:** BullMQ `worker.close()` drains but has **no built-in timeout**; `@nestjs/bullmq`'s own teardown does not expose a configurable grace. So implement the bound yourself as a Nest lifecycle hook, keeping the *logic* in a plain function (unit-testable, Jest-safe).
```typescript
// lifecycle/drain.ts — plain, unit-tested with a fake { close(force?) } (NO @nestjs/bullmq import)
export async function raceDrain(
  worker: { close(force?: boolean): Promise<void> },
  graceMs: number,
): Promise<'drained' | 'forced'> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<'timeout'>((res) => { timer = setTimeout(() => res('timeout'), graceMs); timer.unref?.(); });
  const outcome = await Promise.race([worker.close().then(() => 'drained' as const), timeout]);
  clearTimeout(timer!);
  if (outcome === 'timeout') { await worker.close(true); return 'forced'; } // D-12 force after grace
  return 'drained';
}
```
Wire it in a worker-side provider implementing `OnModuleDestroy` (or `beforeApplicationShutdown`), obtaining the live `Worker` from the injected `ScanWorker` (a `WorkerHost`) via its `worker` getter, then `raceDrain(worker, SHUTDOWN_GRACE_MS)`, then close the hand-rolled `REDIS_CLIENT`. This provider is `@nestjs/bullmq`-adjacent, so — exactly like `ScanWorker` — it is **never imported by a Jest spec**; its wiring is validated only by the compiled-process harness. **API side (D-14):** `enableShutdownHooks()` is already present; add `onModuleDestroy` to close the producer queue (largely handled by `@nestjs/bullmq`) and to `.quit()` the `REDIS_CLIENT`.

### Anti-Patterns to Avoid
- **URL validation or HTTP status mapping inside `ScanService`** — violates ARCH-01/D-03; keep it in the pipe/controller.
- **Opening a new ioredis connection for `/health`** — violates D-08; borrow `REDIS_CLIENT`.
- **Relying on `worker.close()` alone for shutdown** — it never times out; a hung job blocks until Docker's SIGKILL. Always bound it (D-12).
- **Hand-rolled `process.on('SIGTERM', …)`** — violates D-13; use Nest hooks + `enableShutdownHooks()`.
- **Importing the controller's real module graph (which pulls `@nestjs/bullmq`) into a Jest spec** — triggers the confirmed `@swc/core` miette panic. Mock `ScanService` in controller specs.
- **Returning the raw domain `Scan`** — over-exposes `repoUrl`/timestamps; use the state-shaped DTO (D-05).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| URL parsing | Custom scheme/host/port string splitting | WHATWG `new URL()` (built-in) | Correctly handles userinfo, ports, IDN, encoded chars; a hand-rolled parser misses look-alike/credential edge cases D-02 requires. |
| Request validation → 400 | `if (!body.repoUrl) reply.code(400)` inside the handler | `ValidationPipe` / custom `PipeTransform` (runs before handler) | Guarantees "400 before enqueue" (D-03) structurally, not by convention. |
| 404 / 503 responses | Manual `reply.code(...).send(...)` on the Fastify reply | `NotFoundException` / `ServiceUnavailableException` | Adapter-agnostic, testable without a live server, consistent error envelope. |
| SIGTERM wiring | `process.on('SIGTERM', …)` | `app.enableShutdownHooks()` + lifecycle interfaces | Nest dedupes signals, awaits async hooks, orders them (D-13). Hand-rolled handlers double-fire and race Nest's own. |
| Worker drain | Manual "wait for job then exit" loop | `worker.close()` (drain) + a race timer for the bound | BullMQ owns active-job tracking + stalled-job semantics; you only add the timeout. |

**Key insight:** The entire phase is "wire built pieces to standard framework primitives." The only genuinely custom code is the ~20-line `parseGithubUrl()` and the ~10-line `raceDrain()` — both pure functions, both fully unit-testable without the Jest-panic-inducing module graph.

## Common Pitfalls

### Pitfall 1: The `@swc/core` + `@nestjs/bullmq` Jest panic (the #1 risk)
**What goes wrong:** Any Jest spec whose module graph reaches `@nestjs/bullmq` aborts the whole Jest run with a native miette panic (`@swc/core@1.15.43`, `miette@7.6.0`). Confirmed reproducible on **both Node 22 and 24** (STATE.md).
**Why it happens:** SWC's native binding panics decoding `@nestjs/bullmq`'s decorator metadata under `@swc/jest`.
**How to avoid:**
- Controller specs import the **controller class + a mocked `ScanService`** only — never `AppModule`, never `ScanModule`, never `ScanWorker`. The controller itself imports only `@nestjs/common` + `ScanService` + DTOs, so its graph is clean.
- The bounded-drain **logic** lives in `lifecycle/drain.ts` (plain function, fake worker) — unit-tested. The **wiring** (provider that grabs the real `Worker` from `WorkerHost`) is validated only by the compiled `.mjs` harness.
- Do the full `POST → poll → Finished/Failed` proof against the **compiled** `dist/index.js` + `dist/worker.js`, never by importing the wired module into Jest.
**Warning signs:** A spec that imports anything under `engine/scan-worker.ts` or a Nest `Test.createTestingModule({ imports: [ScanModule] })`.

### Pitfall 2: `worker.close()` hangs shutdown past the container SIGKILL window
**What goes wrong:** A long-running scan (Docker Trivy pull + 500MB parse) is in flight at SIGTERM; `worker.close()` waits indefinitely; Docker SIGKILLs at +10s, producing a stalled job and a dirty exit.
**Why it happens:** `worker.close(force=false)` has no timeout by design (BullMQ docs: "will not timeout by itself"). `@nestjs/bullmq` provides no grace-window config.
**How to avoid:** `SHUTDOWN_GRACE_MS` default ~8s (< 10s), race `close()` against it, `close(true)` on elapse (Pattern 6, D-12).
**Warning signs:** Integration test where SIGTERM during an active scan does not exit within `SHUTDOWN_GRACE_MS + ε`.

### Pitfall 3: The hand-rolled `REDIS_CLIENT` is never closed on shutdown
**What goes wrong:** `@nestjs/bullmq` closes its own queue/worker connections on shutdown, but the repository's `REDIS_CLIENT` is a plain `new Redis(...)` from a `useFactory` — Nest does **not** auto-`.quit()` a raw ioredis instance. It lingers, and the process may not exit cleanly.
**Why it happens:** Nest only calls lifecycle hooks on providers that implement them; a bare `Redis` object has none.
**How to avoid:** Make `ScanRepositoryAdapter` (or a dedicated provider) implement `onModuleDestroy()` → `await this.redis.quit()`. Applies to **both** API and worker processes (D-13/14).
**Warning signs:** A process that needs SIGKILL to exit after hooks run; open handles reported by the compiled-process test.

### Pitfall 4: `@Body()` is `undefined`/unvalidated without a global pipe
**What goes wrong:** With no `ValidationPipe`, a missing/malformed body reaches the handler as `undefined`, `enqueue` runs on garbage, and the 400-before-enqueue contract (D-03) breaks.
**Why it happens:** NestJS does not validate DTOs unless a pipe (global or route) is registered.
**How to avoid:** Register the validation globally (`app.useGlobalPipes(new ValidationPipe(...))` in `src/index.ts`) or bind the custom pipe on the `@Body()`/param. Add a spec asserting a missing/empty/non-GitHub body returns 400 and that `ScanService.enqueue` was **not** called.

### Pitfall 5: Default POST status is 201, not 202
**What goes wrong:** Omitting `@HttpCode(202)` yields 201 Created, breaking D-04.
**How to avoid:** Explicit `@HttpCode(202)` on the POST handler; assert the status in the controller spec.

## Code Examples

### Verified: NestJS shutdown hook with signal (ERR-05)
```typescript
// [VERIFIED: raw.githubusercontent.com/nestjs/docs.nestjs.com master lifecycle-events.md]
// Order: onModuleDestroy -> beforeApplicationShutdown -> onApplicationShutdown; each receives the signal.
@Injectable()
export class WorkerShutdown implements OnModuleDestroy {
  constructor(@Inject(ScanWorker) private readonly host: ScanWorker,
              private readonly config: ConfigService,
              @Inject(REDIS_CLIENT) private readonly redis: Redis) {}
  async onModuleDestroy(): Promise<void> {
    const graceMs = this.config.get<number>('SHUTDOWN_GRACE_MS', 8000);
    await raceDrain(this.host.worker, graceMs); // host.worker is BullMQ's Worker (WorkerHost getter)
    await this.redis.quit();
  }
}
// src/worker.ts already calls app.enableShutdownHooks(); src/index.ts already does too.
```

### Verified: bounded PING race for /health (API-03)
See Pattern 4 — `Promise.race([redis.ping(), timeout])`; `ping()` resolves `'PONG'` when up.

### Env schema extension (D-12)
```typescript
// apps/api/src/config/env.validation.ts — add to the Joi.object({...})
SHUTDOWN_GRACE_MS: Joi.number().integer().min(0).max(60000).default(8000),
// default < Docker's 10s SIGTERM->SIGKILL window (D-12); fail-closed via existing schema (OPS-03)
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `process.on('SIGTERM')` manual handlers | `enableShutdownHooks()` + lifecycle interfaces | NestJS ≥ v7 | Nest awaits async hooks and orders them; avoid manual handlers (D-13). |
| Bull (v3) `queue.process()` | BullMQ `Worker` + `WorkerHost` | BullMQ 1.x+ | Already adopted in Phase 3; `worker.close(force)` is the drain API. |
| `@nestjs/bull` | `@nestjs/bullmq` 11.0.4 | current | Already installed; note the Jest-panic constraint. |

**Deprecated/outdated:**
- `bull` (v3) — superseded by `bullmq` (already avoided).
- Manual `reply.code()` error handling — prefer built-in Nest HTTP exceptions.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `@nestjs/bullmq` closes its own queue/worker connections on shutdown but does NOT bound the drain, so a custom bounded-drain hook is required and coexists idempotently with the package's teardown. | Pattern 6 / Pitfall 2 | If the package's own `worker.close()` hook runs first and blocks (unbounded), the custom bound may not take effect. **Mitigation:** validate empirically with the compiled-process harness (SIGTERM during an active scan must exit within grace). If it blocks, place the bounded drain in the earliest-firing hook (`onModuleDestroy` on a provider ordered before BullMQ's) or add a hard `setTimeout(process.exit).unref()` backstop. |
| A2 | `ScanWorker` (WorkerHost) exposes the live BullMQ `Worker` via a `worker` getter reachable from another provider. | Pattern 6 code | If the getter is not accessible/initialised at destroy time, obtain the worker differently (e.g., have `ScanWorker` itself implement the drain hook). Confirm against `@nestjs/bullmq` 11.0.4 `WorkerHost` at plan time. |
| A3 | GitHub repo names allow `A-Za-z0-9 . _ -` up to 100 chars and owner names allow `A-Za-z0-9` + non-consecutive, non-edge hyphens up to 39 chars. | Pattern 2 regex | Too-strict regex could 400 a legitimate repo; too-loose could accept junk. Low risk for this assignment (only clone targets). Regex is Claude's discretion (D-02) — tune if a valid URL is rejected. |
| A4 | The pure custom `ValidationPipe` (zero new deps) is preferable to class-validator DTOs for this project. | Standard Stack / Alternatives | If a reviewer strongly expects idiomatic class-validator DTOs, switch to the audited packages (both OK). Either satisfies D-03. |
| A5 | Injecting `REDIS_CLIENT` (repository's ioredis) is the intended "existing connection" for `/health` and is safe to PING under load. | Pattern 4 | If the repository client is saturated, PING could be delayed — the 1s race bounds this. BullMQ queue connection is the alternative handle if preferred. |

## Open Questions

1. **Does `@nestjs/bullmq` 11.0.4's own worker teardown pre-empt or block the custom bounded drain?**
   - What we know: `worker.close(force)` semantics are confirmed; the package tears down workers/queues on shutdown; NestJS hook order is confirmed (`onModuleDestroy` → `beforeApplicationShutdown` → `onApplicationShutdown`).
   - What's unclear: which exact hook `@nestjs/bullmq` uses to close the worker, and whether it runs before/after the custom provider's hook.
   - Recommendation: Verify at plan/execute time via the compiled-worker harness (SIGTERM mid-scan). If needed, own the drain from within `ScanWorker` itself (single hook, no ordering ambiguity), or add an `unref()`ed hard-exit backstop as belt-and-suspenders.

2. **Global vs param-level validation pipe registration.**
   - What we know: both satisfy D-03; global is idiomatic.
   - Recommendation: Global `ValidationPipe` in `src/index.ts` if using DTO decorators; a param-bound custom pipe if using the pure validator. Either is fine (Claude's discretion).

## Integration / Test Strategy (resolves CONTEXT `<deferred>`; success criterion #5)

This is the deferred design point; here is the concrete, minimal mechanism.

**Two-layer test plan:**

**Layer A — Jest unit/contract specs (fast, no BullMQ in graph):**
- `scan.controller.spec.ts`: instantiate `new ScanController(mockScanService)` directly (like `scan.service.spec.ts` builds `new ScanService(...)` with fakes). Assert: POST returns 202 + `{scanId,status:'Queued'}` and calls `enqueue` once; invalid URLs → 400 (via the pipe) with `enqueue` NOT called; GET maps each status to the state-shaped DTO; `null` → `NotFoundException` (404).
- `github-url.spec.ts`: table-test `parseGithubUrl()` against the D-02 accept/reject matrix (valid https, `.git` suffix, ssh, git://, file://, http, `github.com.evil.com`, `user:pass@github.com`, odd port, single-segment, `..` repo).
- `drain.spec.ts`: `raceDrain()` with a fake worker whose `close()` resolves fast → `'drained'`; whose `close()` never resolves → `'forced'` and `close(true)` called.
- `health.service.spec.ts`: fake `redis.ping()` → `'PONG'` (up), throws/hangs (down via the race).
- `scan.controller` import-guard (Pattern 5).

**Layer B — Compiled-process integration harness (`node:test` `.mjs`, real Redis, no Jest):**
Extend the existing `scripts/scan-engine-integration.mjs` pattern (disposable `redis:7-alpine`, `withHarness`, `spawnWorker`). Add an API dimension:
- Run `npm run build`, then spawn **both** `dist/worker.js` and `dist/index.js` (API) against the disposable Redis (set `PORT`, `REDIS_HOST/PORT`, `SCAN_TMP_DIR`, `SCAN_GIT_ALLOWED_PROTOCOLS='https:file'`, `SCAN_ENGINE_TEST_FAULT` as needed).
- `POST /api/scan` (HTTP, via `fetch` to the API port) with the committed `sample-repo.bundle` (or a `file:`-transport URL for offline determinism) → assert **202** + `{scanId,status:'Queued'}`.
- Poll `GET /api/scan/:scanId` every ~100ms → assert progression to `Finished` (or, with a `SCAN_ENGINE_TEST_FAULT`, to `Failed` with `{category,detail}`), and that `Finished` returns `criticalVulnerabilities`.
- `GET /api/scan/<random-uuid>` → assert **404**.
- `GET /health` → assert 200/`{status:'ok',redis:'up',uptime}`; (optionally) kill Redis → assert 503.
- **Shutdown (ERR-05):** enqueue a scan, send `SIGTERM` to the worker mid-scan, assert the process exits within `SHUTDOWN_GRACE_MS + ε` and the active job either completed (drain) or was force-closed; send `SIGTERM` to the API and assert clean exit (no SIGKILL needed).
- Register as `npm run test:api:integration` (name mirrors Phase 3's `test:scan-engine:integration`); gate in CI if feasible on free runners, else document the limitation (Phase 3 D-29 precedent).

**Why this shape:** It exercises the REAL HTTP + queue + Redis boundary end-to-end without ever loading `@nestjs/bullmq` into Jest, honoring the landmine while proving success criterion #5. Prefer the `file:`/bundle transport over a live GitHub clone for determinism (Phase 3 D-24 precedent) — but note the API's `parseGithubUrl` only accepts `https://github.com/...`, so the POST contract test should submit a valid GitHub URL and use the `SCAN_ENGINE_TEST_FAULT` seam (or a repo-URL→bundle mapping in the worker's test config) to reach a terminal state offline. Simplest offline option: assert POST→202→`Queued`→`Scanning`→`Failed(clone)` via an injected `clone` fault (deterministic, no network), and separately keep one Docker-backed `Finished` happy-path if runner budget allows.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | build/run both processes | ✓ (pinned) | `>=22 <23` (`engines`) | — |
| Redis (disposable container) | Layer B integration (real queue/state) | ✓ via Docker | redis:7-alpine | Layer A Jest specs cover contract logic without Redis |
| Docker | disposable Redis + (optional) Trivy happy-path | assumed ✓ (Phase 3 harness requires it) | — | Fault-injection path (`SCAN_ENGINE_TEST_FAULT`) reaches terminal state with no Docker/network |
| class-validator / class-transformer | ONLY if decorator-DTO style chosen | ✗ (not installed) | 0.15.1 / 0.5.1 | Zero-dep custom `ValidationPipe` (the default recommendation) |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** class-validator/class-transformer — the pure-function pipe needs neither.

## Security Domain

> `security_enforcement: true`, `security_asvs_level: 1`. This phase adds the first public HTTP attack surface, so input-validation and error-handling controls are central.

### Applicable ASVS Categories (L1)

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Auth is explicitly out of scope (REQUIREMENTS Out-of-Scope). |
| V3 Session Management | no | Stateless API, no sessions. |
| V4 Access Control | no | No multi-tenancy/authz in scope. |
| V5 Input Validation | **yes** | `parseGithubUrl()` parse-then-allowlist (D-01/02); `ValidationPipe` rejects before `enqueue` (D-03). Cap input length (≤2048). |
| V6 Cryptography | no | No secrets/crypto introduced this phase. |
| V7 Error Handling & Logging | **yes** | Return the bounded `{category,detail}` (≤500 chars, already sanitized in Phase 3 — no raw stderr/paths/credentials). Do not leak stack traces; use Nest exception filters' default safe envelope. |
| V12 Files & Resources / SSRF | **yes** | The URL allowlist (https + exact github.com host, no userinfo/ports, look-alike rejection) is the SSRF/command-injection guard (D-03), defense-in-depth over Phase 3's `shell:false` argv clone. |
| V14 Config | **yes** | `SHUTDOWN_GRACE_MS` added to the fail-closed Joi schema (OPS-03 pattern); no unsafe defaults. |

### Known Threat Patterns for NestJS/Fastify + BullMQ

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SSRF via crafted repo URL (`http://169.254.169.254`, `github.com.evil.com`, `file://`) | Information disclosure / Tampering | Parse-then-allowlist: exact host set, `https:` only, reject userinfo/ports/look-alikes (Pattern 2). |
| Command injection via URL into `git clone` | Tampering / Elevation | Phase 3 `shell:false` argv array (already closed); URL allowlist is defense-in-depth. |
| Error-message info leak (stderr/paths/credentials in `error.detail`) | Information disclosure | Bounded, sanitized `{category,detail}` produced upstream (Phase 3 D-20/21); controller passes it through verbatim, adds nothing. |
| Unbounded request body / oversized URL | DoS | Fastify default body limit + explicit URL length cap in the validator. |
| DoS via hung shutdown leaving stalled jobs | Availability | Bounded drain `SHUTDOWN_GRACE_MS` → `close(true)` (D-12). |
| `/health` as an unauthenticated PING amplifier / info leak | Information disclosure | Body limited to `{status,redis,uptime}` — no versions/hostnames/internal detail (D-10). |

## Sources

### Primary (HIGH confidence)
- `raw.githubusercontent.com/nestjs/docs.nestjs.com/master/content/fundamentals/lifecycle-events.md` — verified hook order (`onModuleDestroy` → `beforeApplicationShutdown` → `onApplicationShutdown`), signal argument, `enableShutdownHooks()` semantics, async-await behavior.
- `docs.bullmq.io/guide/workers/graceful-shutdown` + `github.com/taskforcesh/bullmq/blob/master/src/classes/worker.ts` + `api.docs.bullmq.io` — verified `close(force=false)` drains (no built-in timeout), `close(true)` force-closes without waiting.
- Existing codebase (read this session): `scan.service.ts`, `scan.module.ts`, `scan.repository.ts`, `scan.repository.port.ts`, `scan.types.ts`, `domain/*.types.ts`, `index.ts`, `worker.ts`, `worker.module.ts`, `app.module.ts`, `env.validation.ts`, `engine/scan-worker.ts`, `scripts/scan-engine-integration.mjs`, `scripts/worker-process-contract.mjs`, `scan.service.spec.ts`, `package.json` — the exact seams Phase 4 consumes.
- npm registry (`npm view`) — `@nestjs/common@11.1.28`, `@nestjs/platform-fastify@11.1.28`, `class-validator@0.15.1`, `class-transformer@0.5.1`; package-legitimacy seam → both validation packages `OK`.

### Secondary (MEDIUM confidence)
- `docs.nestjs.com/techniques/validation`, `/controllers` — `ValidationPipe`, `@HttpCode`, `NotFoundException`, DTO patterns (cross-confirmed by websearch; docs are SPA so quoted via search synthesis).
- WebSearch synthesis on `@nestjs/bullmq` shutdown behavior (nestjs/bull #2069, vendure #1649, bullmq #1205) — package auto-teardown of queues/workers + the "Connection is closed" gotcha.
- `github.com/dead-claudia/github-limits` + GitHub docs (websearch) — owner ≤39 chars alnum/hyphen; repo ≤100 chars alnum/`.`/`_`/`-`.

### Tertiary (LOW confidence)
- General NestJS graceful-shutdown blog posts (dev.to) — corroborating, not authoritative; superseded by the official lifecycle-events.md above.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all core deps already installed & version-confirmed; optional deps legitimacy-audited.
- Architecture / HTTP patterns: HIGH — idiomatic NestJS verified against official docs + existing codebase seams.
- Shutdown/lifecycle: HIGH on the primitives (hook order, `close(force)`), MEDIUM on the exact `@nestjs/bullmq` teardown interaction (A1/A2 — validate via compiled harness).
- Integration-test strategy: HIGH — direct extension of the proven Phase 3 harness.
- Pitfalls: HIGH — Jest panic and unbounded-drain are documented in STATE.md and BullMQ docs respectively.

**Research date:** 2026-07-10
**Valid until:** 2026-08-09 (stable stack; re-verify `@nestjs/*` and BullMQ minor versions at install time)
