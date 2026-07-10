# Phase 4: Required REST API & Runtime Lifecycle - Pattern Map

**Mapped:** 2026-07-10
**Files analyzed:** 12 (7 new, 5 modified)
**Analogs found:** 12 / 12

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `apps/api/src/http/scan.controller.ts` (NEW) | controller | request-response | `apps/api/src/scan/scan.service.ts` (thin-delegation idiom); `apps/api/src/engine/scan-worker.ts` (thin shell + DI-token inject) | role-adjacent (no existing controller) |
| `apps/api/src/http/health.controller.ts` (NEW) | controller | request-response | `apps/api/src/engine/scan-worker.ts` (thin shell) | role-adjacent |
| `apps/api/src/http/health.service.ts` (NEW) | service | request-response | `apps/api/src/scan/scan.repository.ts` (`@Inject(REDIS_CLIENT)` ioredis consumer) | exact (DI + ioredis) |
| `apps/api/src/http/dto/create-scan.dto.ts` (NEW) | model/DTO | transform | `apps/api/src/scan/scan.types.ts` (framework-neutral contract file) | role-match |
| `apps/api/src/http/dto/scan-response.ts` (NEW) | utility (mapper) | transform | `apps/api/src/scan/scan.repository.ts` `serialize`/`deserialize` (domain↔wire mapping) | role-match |
| `apps/api/src/http/validation/github-url.ts` (NEW) | utility (pure validator) | transform | `apps/api/src/config/env.validation.ts` `validateGitProtocols` (pure fail-closed validator) | role-match |
| `apps/api/src/http/validation/github-url.pipe.ts` (NEW) | middleware (pipe) | request-response | — (no existing PipeTransform) | no analog (framework primitive) |
| `apps/api/src/lifecycle/drain.ts` (NEW) | utility (pure fn) | event-driven | `apps/api/src/config/env.validation.ts` `validateGitProtocols` (plain, unit-tested, no framework import) | role-match |
| `apps/api/src/lifecycle/worker-shutdown.provider.ts` (NEW) | provider (lifecycle hook) | event-driven | `apps/api/src/scan/scan.repository.ts` (`@Inject` provider consuming REDIS_CLIENT + WorkerHost) | role-adjacent |
| `apps/api/src/app.module.ts` (MODIFIED) | config (module) | — | itself + `apps/api/src/worker.module.ts` (provider/import wiring) | exact |
| `apps/api/src/worker.ts` (MODIFIED) | config (entrypoint) | — | `apps/api/src/index.ts` (`enableShutdownHooks()` already present there) | exact |
| `apps/api/src/config/env.validation.ts` (MODIFIED) | config (schema) | — | itself (existing Joi keys, esp. `PORT`/numeric) | exact |
| `apps/api/src/scan/scan.repository.ts` (MODIFIED — add `onModuleDestroy`) | provider | — | `apps/api/src/engine/scan-worker.ts` (`OnWorkerEvent` lifecycle interface impl) | role-match |
| `apps/api/scripts/api-integration.mjs` (NEW) | test | request-response | `apps/api/scripts/scan-engine-integration.mjs` (compiled-process + disposable Redis harness) | exact |

> No REST controller exists yet, so controllers have no exact analog. The strongest existing patterns to copy are: (1) the **thin-shell + framework-neutral DI-token inject** idiom from `ScanService`/`ScanWorker`, and (2) the **domain↔wire mapping** idiom from `ScanRepositoryAdapter`. Framework primitives (`PipeTransform`, `@Controller`) come from the CITED NestJS docs in RESEARCH.md Patterns 1–4.

## Pattern Assignments

### `apps/api/src/http/scan.controller.ts` (controller, request-response)

**Analogs:** `scan.service.ts` (delegation + JSDoc "thin boundary" comment), `scan-worker.ts` (thin shell, `@Inject` token, delegate-only `process`).

**DI + delegation idiom to copy** (`scan.service.ts:20-51`) — controller mirrors this thinness, injecting only `ScanService`:
```typescript
@Injectable()
export class ScanService {
  constructor(
    @Inject(SCAN_REPOSITORY) private readonly repository: ScanRepository,
    @Inject(SCAN_QUEUE)
    private readonly queue: Queue<ScanJob, void, typeof SCAN_JOB_NAME>,
  ) {}

  async enqueue(repoUrl: string): Promise<Scan> { /* ...no engine work... */ }
  get(id: string): Promise<Scan | null> { return this.repository.get(id); }
}
```

**Controller shape** — from RESEARCH.md Pattern 1 (`@HttpCode(202)`) + Pattern 3 (`NotFoundException` on `null`). The ONLY collaborator is `ScanService`; `enqueue`/`get` are the ONLY methods callable. Map domain `id`→`scanId` on the wire (D-04), delegate the state-shaped mapping to `toScanResponse` (below).

**Import-guard requirement (ARCH-01):** add a spec mirroring `scan.service.spec.ts:92-108` asserting the controller imports NONE of `node:fs`, `node:child_process`, `execa`, `@nestjs/bullmq`, `report-parser`, `engine/` — only `@nestjs/common` + `ScanService` + DTOs. Reuse the exact `importSpecifiers()` helper (`scan.service.spec.ts:111-123`).

---

### `apps/api/src/http/health.service.ts` (service, request-response)

**Analog:** `scan.repository.ts:56-58` — the established `@Inject(REDIS_CLIENT)` ioredis-consumer idiom:
```typescript
@Injectable()
export class ScanRepositoryAdapter implements ScanRepository {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}
```
`REDIS_CLIENT` is exported by `ScanModule` (`scan.module.ts:59`), so `HealthService` injects the SAME existing connection (D-08 — no third connection). Use `import type { Redis } from 'ioredis'` (type-only, matching `scan.repository.ts:2`). Bounded PING race per RESEARCH.md Pattern 4.

---

### `apps/api/src/http/dto/scan-response.ts` (mapper, transform)

**Analog:** `scan.repository.ts:167-211` `serialize`/`deserialize` — the codebase's domain↔representation mapping idiom (explicit field-by-field, no spread of the raw domain object, guards on `status`). Source shapes:
- `Scan` / `ScanStatus` / `ScanFailureReason {category, detail}` — `domain/scan.types.ts:6-39`
- `Vulnerability {vulnerabilityId,pkgName,installedVersion,severity:'CRITICAL',title,primaryUrl}` — `domain/vulnerability.types.ts:6-13`

State-shaped mapping (D-05/06/07): `Queued`/`Scanning`→`{scanId,status}`; `Finished`→ add `criticalVulnerabilities: scan.vulnerabilities ?? []`; `Failed`→ add `error: {category, detail}`. Never return the raw `Scan` (drops `repoUrl`/timestamps).

---

### `apps/api/src/http/validation/github-url.ts` (pure validator, transform)

**Analog:** `env.validation.ts:18-32` `validateGitProtocols` — the project's pure, fail-closed validator idiom (return sentinel on reject, no throw). `parseGithubUrl()` returns `{owner,repo} | null` per RESEARCH.md Pattern 2. Table-test against the D-02 accept/reject matrix (RESEARCH Test Strategy Layer A). Security rationale (SSRF/allowlist) mirrors the existing `GIT_TRANSPORT_ALLOWLIST` fail-closed comment style (`env.validation.ts:1-11`).

---

### `apps/api/src/lifecycle/drain.ts` (pure fn, event-driven)

**Analog:** `env.validation.ts` pure-function style (no NestJS/BullMQ import → Jest-safe). `raceDrain(worker, graceMs)` per RESEARCH.md Pattern 6, typed against the minimal `{ close(force?): Promise<void> }` structural interface so a fake worker unit-tests it (`drain.spec.ts`) without importing `@nestjs/bullmq` (Pitfall 1).

---

### `apps/api/src/lifecycle/worker-shutdown.provider.ts` (lifecycle provider, event-driven)

**Analogs:** `scan-worker.ts:28-47` (a provider implementing a Nest/BullMQ lifecycle interface — mirror the `implements OnModuleDestroy` shape the way `ScanWorker extends WorkerHost` + `@OnWorkerEvent`); `worker.module.ts:44-99` (provider registration via `useFactory`/`inject`).

**Wiring:** implement `OnModuleDestroy`, inject `ScanWorker` (grab live BullMQ `Worker` via `WorkerHost.worker` getter — verify at plan time, Assumption A2), `ConfigService` for `SHUTDOWN_GRACE_MS`, and `@Inject(REDIS_CLIENT)`. Call `raceDrain(host.worker, graceMs)` then `redis.quit()` (RESEARCH Code Example). This file is `@nestjs/bullmq`-adjacent → **never imported by a Jest spec** (same rule that governs `scan-worker.ts:15-25`); wiring validated only by the compiled `.mjs` harness. Register in `worker.module.ts` providers array (alongside `ScanWorker`, `scan-worker.ts` is registered at `worker.module.ts:98`).

---

### `apps/api/src/scan/scan.repository.ts` (MODIFIED — add `onModuleDestroy`)

**Analog:** itself + `scan-worker.ts` lifecycle-interface impl. Add `implements OnModuleDestroy` to `ScanRepositoryAdapter` (`scan.repository.ts:57`) with `async onModuleDestroy() { await this.redis.quit(); }` — Nest does NOT auto-`.quit()` the raw `useFactory` ioredis instance (RESEARCH Pitfall 3). Applies to BOTH processes (the adapter is in shared `ScanModule`), satisfying D-13/D-14. Add `OnModuleDestroy` to the `@nestjs/common` import at `scan.repository.ts:1`.

---

### `apps/api/src/app.module.ts` (MODIFIED)

**Analog:** itself (`app.module.ts:10-19`) + `worker.module.ts:36-100` (controllers/providers registration idiom). Add `controllers: [ScanController, HealthController]` and register the validation pipe globally (or bind the custom pipe). `ScanModule` is already imported (`app.module.ts:15`) and exports `ScanService` + `REDIS_CLIENT` (`scan.module.ts:55-62`), so no new imports beyond the HTTP layer. Global pipe alternatively registered in `index.ts` (`app.useGlobalPipes(...)` next to `app.enableShutdownHooks()` at `index.ts:14`).

---

### `apps/api/src/worker.ts` (MODIFIED)

**Analog:** `index.ts:14` — `app.enableShutdownHooks()` is ALREADY called in `worker.ts:17`. No new call needed; only the new `worker-shutdown.provider.ts` registered in `worker.module.ts` drives the drain. (Confirm `worker.ts:17` already has the hook — it does; this "modification" may reduce to registering the provider only.)

---

### `apps/api/src/config/env.validation.ts` (MODIFIED)

**Analog:** `env.validation.ts:44` (`PORT: Joi.number().port().default(3000)`) — numeric key with a safe default. Add per RESEARCH:
```typescript
SHUTDOWN_GRACE_MS: Joi.number().integer().min(0).max(60000).default(8000),
```
Default 8000 < Docker's 10s SIGTERM→SIGKILL window (D-12). Fits the existing fail-closed schema (OPS-03).

---

### `apps/api/scripts/api-integration.mjs` (NEW test harness)

**Analog:** `scripts/scan-engine-integration.mjs` — EXTEND, do not reinvent. Reusable pieces to lift directly:
- `startDisposableRedis()` (lines 119-147), `connectRedis()` (150-170) — disposable `redis:7-alpine` on an ephemeral loopback port.
- `withHarness(fn)` (402-445) — provisions Redis + private `SCAN_TMP_DIR`, status-preserving `finally` teardown. Extend `ctx` with a `spawnApi()` alongside the existing `spawnWorker` (230-332).
- `spawnWorker()` env block (235-254) — copy the env-var contract (`REDIS_HOST/PORT`, `SCAN_TMP_DIR`, `SCAN_ENGINE_TEST_FAULT`, `SCAN_GIT_ALLOWED_PROTOCOLS='https:file'`); add `PORT` for the API process; readiness sentinel pattern (`SCAN_WORKER_READY` → analogous `API HTTP listener ready`, already logged at `index.ts:17`).
- `waitTerminal()` (335-346), `readCriticals()` (349-352), `readFailureReason()` (355-357), `startStatusObserver()` (199-223) — reuse for the poll assertions.
- `ensureBuilt()` (67-84) already runs `npm run build` producing BOTH `dist/index.js` and `dist/worker.js`.

New assertions per RESEARCH Test Strategy Layer B: `POST /api/scan`→202+`{scanId,status:'Queued'}` (via `fetch` to the API `PORT`); poll `GET /api/scan/:scanId`→`Finished`/`Failed`; `GET /api/scan/<random-uuid>`→404; `GET /health`→200/503; SIGTERM-mid-scan exits within `SHUTDOWN_GRACE_MS + ε`. Register as `test:api:integration` in `apps/api/package.json` scripts (mirrors `test:scan-engine:integration`, which uses `node --import tsx --test`).

## Shared Patterns

### Framework-neutral DI tokens (Symbol) + `@Inject`
**Source:** `scan.repository.port.ts:37` (`SCAN_REPOSITORY`), `scan.repository.ts:13` (`REDIS_CLIENT`), `scan.types.ts:25` (`SCAN_QUEUE`), consumed at `scan.service.ts:23-25`, `scan.repository.ts:58`.
**Apply to:** `HealthService` (inject `REDIS_CLIENT`), `worker-shutdown.provider.ts` (inject `REDIS_CLIENT` + `ScanWorker`).
```typescript
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
// consumer:
constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}
```

### Thin boundary + explicit "MUST NOT" JSDoc
**Source:** `scan.service.ts:11-19`, `scan-worker.ts:15-25`.
**Apply to:** both controllers — copy the JSDoc convention naming what the file must NOT import/do (ARCH-01), which the import-guard spec then enforces mechanically.

### Import-guard spec
**Source:** `scan.service.spec.ts:92-123` (`importSpecifiers()` + forbidden-list assertion) and topology checks `scan.service.spec.ts:125-157`.
**Apply to:** `scan.controller.spec.ts` (forbid `@nestjs/bullmq`, `node:fs`, `child_process`, `execa`, `engine/`) — the primary defense against the `@swc/core` Jest panic (RESEARCH Pitfall 1).

### Pure fail-closed validator (no throw, sentinel return)
**Source:** `env.validation.ts:18-32`.
**Apply to:** `parseGithubUrl()` (return `null`) and `raceDrain()` (return `'drained'|'forced'`) — both plain, Jest-safe, table-testable.

### Nest lifecycle interface on a provider
**Source:** `scan-worker.ts:28,44-47` (interface + decorated hook), `index.ts:14` / `worker.ts:17` (`enableShutdownHooks()`).
**Apply to:** `worker-shutdown.provider.ts` (`OnModuleDestroy`) and `ScanRepositoryAdapter` (add `OnModuleDestroy`→`redis.quit()`). Never hand-roll `process.on('SIGTERM')` (D-13, RESEARCH Pitfall / Don't-Hand-Roll).

### Compiled-process integration over disposable Redis
**Source:** entire `scripts/scan-engine-integration.mjs`.
**Apply to:** `api-integration.mjs` — proves the real HTTP+queue+Redis boundary without loading `@nestjs/bullmq` into Jest.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `apps/api/src/http/validation/github-url.pipe.ts` | middleware (PipeTransform) | request-response | No existing NestJS pipe in the codebase; follow RESEARCH.md Pattern 2 + CITED `docs.nestjs.com/techniques/validation`. Its INNER logic (`parseGithubUrl`) does have an analog (the pure-validator idiom). |
| `apps/api/src/http/scan.controller.ts` / `health.controller.ts` | controller | request-response | No REST controller exists yet (Phase 4 is the first HTTP surface). Structural pattern from RESEARCH.md Patterns 1/3/4; thinness/DI idiom borrowed from `ScanService`/`ScanWorker`. |

## Metadata

**Analog search scope:** `apps/api/src/{scan,domain,engine,config}`, `apps/api/src/{index,worker,app.module,worker.module}.ts`, `apps/api/scripts/`, `apps/api/package.json`.
**Files scanned:** 16 source/spec/script files read in full or targeted.
**Pattern extraction date:** 2026-07-10
</content>
</invoke>
