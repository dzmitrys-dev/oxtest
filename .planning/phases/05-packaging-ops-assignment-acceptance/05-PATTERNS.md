# Phase 5: Packaging, Ops & Assignment Acceptance - Pattern Map

**Mapped:** 2026-07-10
**Files analyzed:** 15 (5 new, 10 modified)
**Analogs found:** 13 / 15

This is a packaging/ops phase: the scan engine, REST API, worker, streaming
parser, memory proof, and graceful shutdown all exist (Phases 1–4). The work is
composition and packaging, not construction. For the genuinely new artifacts
(Dockerfile, docker-compose.yml, CI jobs, pino adapter, acceptance harness) the
closest analogs are the existing compiled-`dist` + `node:test` harnesses, the
`EngineLogger` port + `worker.module.ts` adapter wiring, `package.json` scripts,
and the existing `scan-engine.yml`/feasibility-probe pattern.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `apps/api/src/engine/pino-logger.adapter.ts` *(new)* | adapter/utility | event-driven (log emission) | `worker.module.ts` inline `EngineLogger` (lines 69–77) + `adapter-factory.ts` | role-match |
| `apps/api/src/engine/scan-engine.ts` | port/model | event-driven | itself (`EngineLogger` port, lines 26–38) | exact (edit in place) |
| `apps/api/src/engine/scan-worker.ts` | worker | event-driven / request-response | itself (`process(job)`, lines 35–37) | exact (edit in place) |
| `apps/api/src/worker.module.ts` | config/provider | event-driven | itself (`SCAN_ENGINE` factory, lines 45–98) | exact (edit in place) |
| `apps/api/src/engine/adapter-factory.ts` | utility | event-driven | itself (`FaultSeamLogger`, lines 65–68) | exact (edit in place) |
| `apps/api/src/scan/scan.service.ts` | service | request-response | itself (`enqueue`, lines 32–45) | exact (edit in place) |
| `apps/api/src/http/validation/github-url.pipe.ts` | middleware (pipe) | request-response | itself (`transform`, lines 19–32) | exact (WR-01) |
| `apps/api/src/config/env.validation.ts` | config | — | itself (`SHUTDOWN_GRACE_MS`, line 51) | exact (WR-02) |
| `apps/api/src/scan/scan.module.ts` | config/provider | CRUD (redis) | itself (`REDIS_CLIENT` factory, lines 42–47) | exact (WR-03) |
| `apps/api/scripts/acceptance.mjs` *(new)* | test harness | request-response + event-driven | `scripts/api-integration.mjs` | exact |
| `apps/api/package.json` | config | — | itself (`scripts` block, lines 11–30) | exact (add `test:acceptance`) |
| `.github/workflows/scan-engine.yml` | config (CI) | batch | itself (contract+integration jobs) | exact (extend) |
| `.github/CI-CONTRACT.md` | doc | — | itself | exact (extend) |
| `Dockerfile` *(new)* | config (packaging) | — | none (greenfield) | no analog |
| `docker-compose.yml` *(new)* | config (packaging) | — | `scan-engine-feasibility.mjs` docker/redis/trivy pins | partial |
| `.dockerignore` *(new)* | config (packaging) | — | `.gitignore` | partial |

## Shared Patterns

### Bounded-timeout, `shell:false`, status-preserving `node:test` harness
**Source:** `apps/api/scripts/api-integration.mjs`
**Apply to:** the new `acceptance.mjs` harness.
- All subprocess calls use discrete argv arrays with `shell: false` and a finite `timeout` (lines 75–79, 96–101, 137–141).
- Every disposable resource is torn down in an independent `finally` where one teardown failure never skips the others (`withHarness`, lines 571–627).
- Bounded timeout constants declared up front (lines 53–65); a real Trivy run allows `SCAN_TERMINAL_TIMEOUT_MS = 300_000` for image pull + DB download.

### `EngineLogger` port + injected adapter (hexagonal)
**Source:** `apps/api/src/engine/scan-engine.ts:26-38`, wired in `worker.module.ts:69-77`
**Apply to:** the new pino adapter — satisfy the widened port, keep pino imports out of `scan-engine.ts`.

### Fail-closed feasibility gating
**Source:** `apps/api/scripts/scan-engine-feasibility.mjs` + `.github/workflows/scan-engine.yml:44-61`
**Apply to:** all Docker/Redis/Trivy-backed CI jobs (acceptance, in-container OOM proof). Cleanly-determined infeasibility → exit 0 + `feasible=false`; unexpected error → exit 1 (fail closed). Docker-gated `node:test` cases use `t.skip(reason)` (api-integration.mjs:861-865).

---

## Pattern Assignments

### `apps/api/src/engine/scan-engine.ts` (widen `EngineLogger` port — D-03)

**Analog:** itself. Add `info` to the port and the noop default.

**Current port** (lines 26–38):
```typescript
export interface EngineLogger {
  warn(message: string): void;
  error(message: string): void;
}

const noopLogger: EngineLogger = {
  warn(): void { /* discarded by default; the worker injects a real logger */ },
  error(): void { /* discarded by default; the worker injects a real logger */ },
};
```
Add `info(message: string): void;` to the interface and a matching noop. Optionally add lifecycle `info` lines at each transition inside `run()` (markScanning line 116, clone line 119, trivy line 122, parse line 130, markFinished line 135) so each carries `scanId` once the pino child is injected.

**Signature seam (Pattern 2 / A4):** `run(job)` (line 97) currently reads `this.logger`. To keep the engine a singleton while binding `scanId` per job, prefer widening to `run(job, logger?: EngineLogger)` and using the passed logger over `this.logger`. Alternative: construct a per-job engine (internal choice only).

---

### `apps/api/src/engine/scan-worker.ts` (thread `pino.child({ scanId })` — D-02)

**Analog:** itself. ⚠️ This is the ONLY worker-path `@nestjs/bullmq` file — NEVER import it into a Jest spec (documented `@swc/core` miette panic).

**Current** (lines 35–37):
```typescript
async process(job: Job<ScanJob, void, typeof SCAN_JOB_NAME>): Promise<void> {
  await this.engine.run(job.data);
}
```
Build the scanId-bound child at the top of `process` and pass it to the engine:
```typescript
async process(job: Job<ScanJob, void, typeof SCAN_JOB_NAME>): Promise<void> {
  const logger = engineLoggerFor(this.baseLogger, job.data.scanId);
  await this.engine.run(job.data, logger);
}
```
`baseLogger` is injected (via a DI token from the new adapter, wired in `worker.module.ts`). The existing `@OnWorkerEvent('error')` NestJS `Logger` (lines 29, 44–47) may stay or migrate to pino.

---

### `apps/api/src/engine/pino-logger.adapter.ts` (new — D-01, D-04b)

**Analog:** the inline `EngineLogger` object in `worker.module.ts:69-77` (the shape to replace) and `adapter-factory.ts:65-68` `FaultSeamLogger` (adapter-shape precedent).

**Inline adapter being replaced** (`worker.module.ts:69-77`):
```typescript
const nestLogger = new Logger('ScanEngine');
const logger: EngineLogger = {
  warn: (message: string): void => { nestLogger.warn(message); },
  error: (message: string): void => { nestLogger.error(message); },
};
```
Replace with a framework-free `createBaseLogger()` factory + `engineLoggerFor(base, scanId)` (RESEARCH Pattern 1, Open Question 1). Key constraint (D-04b / Pitfall 3): **NO transport in container/prod** — `pino({})` defaults to ndjson on stdout; `pino-pretty` transport only behind `NODE_ENV==='development'` (devDependency only, never shipped). Must import NOTHING that pulls `@nestjs/bullmq` so the pure mapping can be unit-tested under Jest.

---

### `apps/api/src/worker.module.ts` (swap NestJS Logger → pino base logger — D-01)

**Analog:** itself. Provide `createBaseLogger()` as a DI value/factory and inject it into `ScanWorker`; remove the inline `nestLogger`/`EngineLogger` block (lines 69–77). The `SCAN_ENGINE` factory (lines 49–97) and the `FaultSeamLogger` passed to `createEngineAdapters` (line 87) must keep a compatible logger — align its shape with the widened port.

---

### `apps/api/src/scan/scan.service.ts` (enqueue log line carrying scanId — D-02)

**Analog:** itself, `enqueue` (lines 32–45). The service currently has no logger. Inject the base pino logger (or a Nest pino) and emit one ndjson line after the `queue.add`:
```typescript
await this.queue.add(SCAN_JOB_NAME, { scanId: id, repoUrl });
this.logger.info({ scanId: id, repoUrl }, 'scan queued');
```
Keep the ARCH-02 constraint: no fs/child_process/Docker/parser here — a logger injection is allowed.

---

### `apps/api/src/http/validation/github-url.pipe.ts` (WR-01 — return canonical URL)

**Analog:** itself, `transform` (lines 19–32). Today it returns the raw `repoUrl` (line 31). Use the parsed result so the enqueued/cloned string equals the validated form:
```typescript
const parsed = parseGithubUrl(repoUrl);
if (parsed === null) {
  throw new BadRequestException('repoUrl must be an https://github.com/{owner}/{repo} URL');
}
return { repoUrl: `https://github.com/${parsed.owner}/${parsed.repo}` };
```
Confirm `parseGithubUrl` returns `{owner, repo}` (read `./github-url.ts` at plan time).

---

### `apps/api/src/config/env.validation.ts` (WR-02 — cap SHUTDOWN_GRACE_MS)

**Analog:** itself, line 51. Lower `.max(60000)` to `.max(9000)` so the drain window (backstop at grace+margin) stays under Docker's 10s SIGTERM→SIGKILL window:
```typescript
SHUTDOWN_GRACE_MS: Joi.number().integer().min(0).max(9000).default(8000),
```

---

### `apps/api/src/scan/scan.module.ts` (WR-03 — REDIS_CLIENT error listener)

**Analog:** itself, `REDIS_CLIENT` factory (lines 42–47). Add a non-throwing `error` listener so a Redis drop cannot crash the process:
```typescript
useFactory: (config: ConfigService): Redis => {
  const client = new Redis({
    host: config.getOrThrow<string>('REDIS_HOST'),
    port: config.getOrThrow<number>('REDIS_PORT'),
  });
  const logger = new Logger('RedisClient');
  client.on('error', (err) => logger.warn(`Redis connection error: ${err.message}`));
  return client;
},
```
(`Logger` is already imported patterns exist in `worker.module.ts`; add the import here.)

---

### `apps/api/scripts/acceptance.mjs` (new — D-08, D-09)

**Analog:** `apps/api/scripts/api-integration.mjs` (near-clone target).

**Reuse verbatim (the "Don't Hand-Roll" seam):**
- `ensureBuilt()` / `ensureFixture()` (lines 72–106) — compile once, guarantee the committed `sample-repo.bundle`.
- `startDisposableRedis()` (lines 136–165), `connectRedis()` (168–192) — disposable `redis:7-alpine` on an ephemeral loopback port.
- `spawnWorker()` (272–388), `spawnApi()` (395–468) — real `dist/worker.js` + `dist/index.js` with ready-sentinel waiters and bounded `waitExit`.
- `startStatusObserver()` (221–245), `waitTerminal()` (471–482), `readCriticals()` (485–488) — lifecycle capture.
- `assertNoScanArtifacts()` (514–524) — the exact clone/report cleanup assertion (criterion #1).
- `withHarness()` (571–627) — provisioning + status-preserving teardown.
- `isDockerAvailable()` + `t.skip(...)` (121–128, 861–865) — feasibility gate.

**Happy path** (clone from `api-integration.mjs:857-899`): POST → 202 Queued → spawn worker (`fault:'none', nodeEnv:'production'`) → real Docker Trivy scan → poll GET until `Finished` → assert the two pinned CRITICAL CVEs (`EXPECTED_CRITICAL_IDS`, line 68) → assert `assertNoScanArtifacts`.

**Forced-failure path** (clone from `api-integration.mjs:792-855`): POST → 202 → spawn worker with `{ fault:'clone', nodeEnv:'test' }` (activates the `SCAN_ENGINE_TEST_FAULT` seam per `adapter-factory.ts:98-120`) → poll GET until `Failed` with `error.category==='clone'` → assert `assertNoScanArtifacts` (cleanup on failure).

**D-10 criterion #5:** (a) assert `dist/index.js` boots clean under `--max-old-space-size=150` (a `spawnApi` variant passing the flag via argv, mirroring `spawn(process.execPath, [API_JS], ...)` at line 397); (b) reuse Phase 2 `scripts/memtest.ts` for the worker-side 500MB proof (Claude's Discretion on whether standalone or through a booted worker).

---

### `apps/api/package.json` (add `test:acceptance`)

**Analog:** the existing `test:*:integration` scripts (lines 27–29). Add mirroring the `node --import tsx --test` runner:
```json
"test:acceptance": "node --import tsx --test scripts/acceptance.mjs"
```
Also add `pino` as a direct dependency (`10.3.1`, already resident transitively via Fastify) and `pino-pretty` as a **devDependency only** (never shipped).

---

### `.github/workflows/scan-engine.yml` (extend with gated jobs — D-11, D-12)

**Analog:** itself. The existing `scan-engine-contract` (always-required, lines 13–53) and `scan-engine-integration` (feasibility-gated, `if: needs.scan-engine-contract.outputs.feasible == 'true'`, lines 55–81) are the exact template.
- Wire the currently-ungated `test:api:integration` and the new `test:acceptance` as feasibility-gated jobs (clone the `scan-engine-integration` job block: checkout → setup-node@22 → assert Node 22 → `npm ci` → build → run script).
- Docker-free additions (REST-contract-only static checks) go in the always-required contract job (steps pattern lines 30–39).
- Keep `.github/workflows/memory.yml` untouched (always-required Node-22 memory proof).

---

### `.github/CI-CONTRACT.md` (document new statuses — D-11, D-12)

**Analog:** itself. Follow the existing status table + per-status prose + feasibility-semantics table (lines 10–65). Add rows for the new acceptance / api-integration / in-container-OOM statuses, classified as feasibility-gated (required-when-run). Keep the "never treat unknown as success" and "skipped ≠ required" policy notes verbatim in spirit.

---

## No Analog Found

Files with no close in-repo match — planner should use RESEARCH.md Patterns 3–5.

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `Dockerfile` | config (packaging) | — | Greenfield; no Docker artifacts exist. Use RESEARCH Pattern 3 (multi-stage `node:22-slim`, non-root `node`, builder+runtime). |
| `docker-compose.yml` | config (packaging) | — | Greenfield. Use RESEARCH Pattern 4 (`mem_limit:200m` TOP-LEVEL not `deploy.resources`; worker CMD `node --max-old-space-size=150 dist/worker.js`; API CMD `node dist/index.js`; healthcheck off `/health`; socket mount for Trivy). Image pins (`redis:7-alpine`, `ghcr.io/aquasecurity/trivy:0.69.3`) match `scan-engine-feasibility.mjs:24-25`. |

Partial: `.dockerignore` has no direct analog but should mirror `.gitignore` exclusions plus `.env`, `.git`, `dist`, `node_modules`, `test-fixtures/*.bundle`, and `.planning`.

## Metadata

**Analog search scope:** `apps/api/src/engine`, `apps/api/src/scan`, `apps/api/src/http`, `apps/api/src/config`, `apps/api/scripts`, `.github/workflows`, `.github`, `apps/api/package.json`
**Files scanned:** 12 read in full/targeted
**Pattern extraction date:** 2026-07-10
```
