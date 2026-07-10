# Phase 6: Optional Bonuses & Documentation - Pattern Map

**Mapped:** 2026-07-11
**Files analyzed:** 11 new/modified surfaces (5 GraphQL backend, 1 module wiring, 5+ apps/web greenfield, 2 docs)
**Analogs found:** 6 with strong analogs / 11 (apps/web is greenfield — no in-repo analog; docs map lightly)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `apps/api/src/graphql/scan.resolver.ts` (new) | resolver (transport edge) | request-response | `apps/api/src/http/scan.controller.ts` | exact (both thin adapters over `ScanService`) |
| `apps/api/src/graphql/scan.model.ts` (new) | model / object-type | transform | `apps/api/src/domain/scan.types.ts` (shape source) | role-match (decorated mirror of domain) |
| `apps/api/src/graphql/vulnerability.model.ts` (new) | model / object-type | transform | `apps/api/src/domain/vulnerability.types.ts` (shape source) | role-match |
| `apps/api/src/graphql/scan-graphql.mapper.ts` (new) | mapper / utility | transform | `apps/api/src/http/dto/scan-response.ts` (`toScanResponse`) | exact (status-switched domain→wire mapper) |
| `apps/api/src/graphql/scan.resolver.spec.ts` (new) | test (unit) | request-response | `apps/api/src/http/scan.controller.spec.ts` | exact (mock `ScanService`, never import `ScanModule`) |
| `apps/api/src/app.module.ts` (modified) | config / module wiring | — | existing `AppModule` (same file) | exact (add imports/providers only) |
| GraphQL integration coverage (optional, new `.mjs`) | test (integration) | request-response | `apps/api/scripts/api-integration.mjs` | role-match (compiled-`dist` + `node:test`) |
| `apps/web/**` (new workspace) | component / store / hook | request-response + polling | none in repo (greenfield) | no analog — RESEARCH Patterns 3–6 + 06-UI-SPEC |
| `README.md` (new) | docs | — | `.planning` docs + cited source files | content deliverable |
| `ONBOARDING.md` (new) | docs | — | Phase 1–5 CONTEXT/STATE files | content deliverable |

## Pattern Assignments

### `apps/api/src/graphql/scan.resolver.ts` (resolver, request-response)

**Analog:** `apps/api/src/http/scan.controller.ts` (the REST edge — mirror its delegation shape exactly)

**Delegation pattern to copy** — the controller's ONLY collaborator is `ScanService`; it calls only `enqueue`/`get`. The resolver mirrors this 1:1:

`scan.controller.ts:26-54`:
```typescript
@Controller('api/scan')
export class ScanController {
  constructor(private readonly scans: ScanService) {}   // sole collaborator

  @Post()
  @HttpCode(202)
  async create(@Body(GithubUrlPipe) body: CreateScanDto): Promise<{ scanId: string; status: 'Queued' }> {
    const scan = await this.scans.enqueue(body.repoUrl);   // scan.service.ts:34
    return { scanId: scan.id, status: 'Queued' as const };
  }

  @Get(':scanId')
  async get(@Param('scanId') scanId: string): Promise<ScanResponse> {
    const scan = await this.scans.get(scanId);             // scan.service.ts:55
    if (scan === null) { throw new NotFoundException(); }  // null == 404 parity
    return toScanResponse(scan);
  }
}
```

**Resolver equivalent (from RESEARCH Pattern 1, D-02/D-06):**
- `@Query(() => ScanModel, { nullable: true }) scan(id)` → `this.scans.get(id)`; return `null` when service returns `null` (D-06 REST 404 parity — the controller throws `NotFoundException`, the resolver returns `null` since GraphQL query is nullable).
- `@Mutation(() => ScanModel) enqueueScan(repoUrl)` → validate then `this.scans.enqueue(canonical)`.

**Service signatures to delegate to** (`scan.service.ts`):
- `async enqueue(repoUrl: string): Promise<Scan>` (:34)
- `get(id: string): Promise<Scan | null>` (:55)

**SSRF/injection parity — CRITICAL (Pitfall 5):** The REST path validates via `GithubUrlPipe` bound to `@Body(GithubUrlPipe)`. That pipe is NOT bound to the resolver, so the resolver MUST call `parseGithubUrl` itself and enqueue the CANONICAL URL — replicating the pipe's exact behavior.

`github-url.pipe.ts:19-38` (the canonical-form contract the resolver must reproduce):
```typescript
const parsed = parseGithubUrl(repoUrl);
if (parsed === null) {
  throw new BadRequestException('repoUrl must be an https://github.com/{owner}/{repo} URL');
}
// WR-01: enqueue the CANONICAL form, NOT the raw string
return { repoUrl: `https://github.com/${parsed.owner}/${parsed.repo}` };
```
Resolver: `import { parseGithubUrl } from '../http/validation/github-url';` (the pure validator, NOT the pipe), reject on `null`, enqueue `https://github.com/${parsed.owner}/${parsed.repo}`.

**Import-guard note (ARCH-01):** The controller has a mechanical import-guard test forbidding `node:fs`, `child_process`, `execa`, `@nestjs/bullmq`, `report-parser`, `engine/*`. The resolver holds the same discipline — its only imports are `@nestjs/graphql`, `ScanService`, `parseGithubUrl`, and the mapper/models.

---

### `apps/api/src/graphql/scan-graphql.mapper.ts` (mapper, transform)

**Analog:** `apps/api/src/http/dto/scan-response.ts` — `toScanResponse` (exact analog; the GraphQL mapper is its GraphQL-model twin)

**Status-switched mapper pattern to copy** (`scan-response.ts:25-48`):
```typescript
export function toScanResponse(scan: Scan): ScanResponse {
  const scanId = scan.id;
  switch (scan.status) {
    case ScanStatus.Queued:   return { scanId, status: 'Queued' };
    case ScanStatus.Scanning: return { scanId, status: 'Scanning' };
    case ScanStatus.Finished:
      return { scanId, status: 'Finished', criticalVulnerabilities: scan.vulnerabilities ?? [] };
    case ScanStatus.Failed:
      return { scanId, status: 'Failed',
        error: { category: scan.error?.category ?? 'unknown', detail: scan.error?.detail ?? '' } };
  }
}
```

**Key idiom:** raw `Scan` is NEVER spread — fields are mapped explicitly (drops `repoUrl`/`createdAt`/`updatedAt`; the controller spec asserts this "no raw-domain leak" at `scan.controller.spec.ts:93-98`). The GraphQL mapper (`toScanModel`, RESEARCH Code Examples) applies the same discipline: `status` enum value IS the wire string; `criticalVulnerabilities` populated only when `Finished`, else `undefined`/`[]` (D-06 parity).

---

### `apps/api/src/graphql/scan.model.ts` + `vulnerability.model.ts` (object-types, transform)

**Analog:** the framework-free domain types `apps/api/src/domain/scan.types.ts` and `apps/api/src/domain/vulnerability.types.ts` — the models are DECORATED mirrors (do NOT decorate the domain types; ANTI-PATTERN).

**Authoritative field list — `Vulnerability` (`vulnerability.types.ts:6-13`), NO `fixedVersion` (D-08 HARD CONSTRAINT):**
```typescript
export interface Vulnerability {
  vulnerabilityId: string;
  pkgName: string;
  installedVersion: string;
  severity: 'CRITICAL';   // always CRITICAL
  title: string;
  primaryUrl: string;
}
```
`VulnerabilityModel` = these 6 fields as `@Field()` (severity as `string`). No new fields; do not touch the parser.

**`Scan` domain (`scan.types.ts:6-39`)** — `ScanStatus` enum has exactly four values `Queued | Scanning | Finished | Failed` (the four states the UI must render). `ScanModel` locked schema (API-01): `@Field(() => ID) id`, `@Field() status: string` (String!, NOT an enum — map the enum value to its string), `@Field(() => [VulnerabilityModel], { nullable: true }) criticalVulnerabilities`.

**Anti-pattern (RESEARCH):** never `import '@nestjs/graphql'` into `src/domain/*` — those files carry the `// Framework-free domain type — no NestJS/GraphQL imports (D-03)` header. Create separate model classes in `graphql/`.

---

### `apps/api/src/graphql/scan.resolver.spec.ts` (unit test)

**Analog:** `apps/api/src/http/scan.controller.spec.ts` (exact — copy its mocking strategy verbatim to dodge the Jest landmine)

**Mock-ScanService pattern to copy** (`scan.controller.spec.ts:1`, `32-41`):
```typescript
import 'reflect-metadata';                       // FIRST import — decorators
// ...
function makeController() {
  const enqueue = jest.fn<Promise<Scan>, [string]>();
  const get = jest.fn<Promise<Scan | null>, [string]>();
  const service = { enqueue, get } as unknown as ScanService;   // mock, NOT the real class
  return { controller: new ScanController(service), enqueue, get };
}
```
Fixture builders `baseScan(overrides)` (`:14-21`) and `critical: Vulnerability` (`:23-30`) are directly reusable.

**Jest landmine (Pitfall 2, STATE):** the spec must construct `new ScanResolver(mockService)` directly and import ONLY the resolver — NEVER `ScanModule` / `AppModule` / `@nestjs/bullmq` (the `@swc/core` + `miette` panic aborts Jest). `scan.controller.spec.ts` is the proof this pattern works; mirror it exactly.

**Coverage to mirror:** `enqueue` called once with canonical URL; `get` → mapper; `get` → `null` returns `null` (resolver) / 404 (controller); invalid URL rejected before `enqueue` runs.

---

### `apps/api/src/app.module.ts` (module wiring — MODIFIED)

**Analog:** the file itself (add-only). Current state:
```typescript
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envValidationSchema }),
    ScanModule,
  ],
  controllers: [ScanController, HealthController],
  providers: [HealthService],
})
export class AppModule {}
```

**Additions (RESEARCH Pattern 2):** add `GraphQLModule.forRoot<MercuriusDriverConfig>({ driver: MercuriusDriver, autoSchemaFile: true, graphiql: true })` and `ServeStaticModule.forRoot({ rootPath, exclude: [...] })` to `imports`; add `ScanResolver` to `providers`.

**CRITICAL constraint:** GraphQL + static-serving go in `AppModule` ONLY, never `worker.module.ts` (keep the memory-critical worker heap lean — RESEARCH, two-entrypoint rationale). The API bootstrap is `src/index.ts` (`NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())`, logs `'API HTTP listener ready'`) — unchanged; static `rootPath` must resolve against `dist/` at `node dist/index.js` runtime (Pitfall 3, Open Question 2).

---

### GraphQL integration coverage (optional new `.mjs`)

**Analog:** `apps/api/scripts/api-integration.mjs` (compiled-`dist` + `node:test` harness)

**Idioms to copy** (`api-integration.mjs:1-59`): `import test from 'node:test'` + `node:assert/strict`; spawn the real `dist/index.js` (`API_READY_MARKER = 'API HTTP listener ready'`) over a disposable `redis:7-alpine` on an ephemeral loopback port; discrete argv arrays with `shell: false`; finite bounded timeouts; status-preserving `finally` teardown. NEVER import the `@nestjs/bullmq`-wired module into Jest (Pitfall 2). Each harness `.mjs` stays self-contained per codebase convention.

---

### `apps/web/**` (GREENFIELD — no in-repo analog)

**No existing frontend in this repo.** Flag as a brand-new npm workspace. There are NO intra-repo analogs — map from RESEARCH Patterns 3–6 and `06-UI-SPEC.md` only:
- `main.tsx` — urql `<Provider client={new Client({ url: '/graphql', exchanges: [cacheExchange, fetchExchange] })}>` (relative URL, same origin, no CORS — D-04). RESEARCH Pattern 3.
- `App.tsx` — form + four-state renderer (`Queued`/`Scanning`/`Finished`/`Failed`). RESEARCH Pattern 6, UI-SPEC "Four-state renderer".
- `useScanPolling.ts` — `setInterval` + `reexecuteQuery({ requestPolicy: 'network-only' })` every 2s, stop on terminal state (urql has no `pollInterval`). RESEARCH Pattern 4.
- `graphql.ts` — `EnqueueScan` mutation + `GetScan` query documents; the query selects ONLY the 6 stored `Vulnerability` fields (no `fixedVersion`).
- `vite.config.ts` — `react() + tailwindcss()`, dev proxy `/graphql → http://localhost:3000`. `index.css` — `@import "tailwindcss";` (Tailwind v4, no config file).
- **Field/column source of truth is `06-UI-SPEC.md` "Results table contract"** — columns Package/CVE/Installed/Severity/Title map to `pkgName`/`vulnerabilityId`/`installedVersion`/`severity`/`title`+`primaryUrl` link. NO "Fixed" column (D-08).
- Version pin: `graphql@16.14.2` in `apps/web` too (Pitfall 1 — keep one graphql major across the monorepo).

---

### `README.md` / `ONBOARDING.md` (docs — content deliverables, mapped lightly)

**Analogs:** the `.planning` CONTEXT/STATE files (rationale source) and the cited source files/scripts. Not code patterns — content harvests.
- README (DOC-01, D-12/D-15): lead with `docker compose up`; cite verified commands from RESEARCH "README existing commands to cite" table (`npm run memtest --workspace apps/api`, `node --max-old-space-size=150 dist/index.js`, `npm run test:acceptance --workspace apps/api`); ASCII architecture diagram (D-13); NodeGoat demo (D-15a — confirm fork URL, Assumption A1); honest `index.js`-boots-API vs `worker.js`-parses-500MB self-test explanation (D-15b).
- ONBOARDING (DOC-02, D-09/D-10/D-11): What/Why/How + "A reviewer might ask…" per topic; harvest rejected-alternative rationale via RESEARCH "Documentation Source Map" table; own the NestJS-vs-Fastify tension and the GraphiQL-introspection trade-off (Pitfall 6).

## Shared Patterns

### Thin transport edge (ARCH-01)
**Source:** `apps/api/src/http/scan.controller.ts:26-54`
**Apply to:** `scan.resolver.ts`
Sole collaborator is `ScanService`; call only `enqueue`/`get`; zero engine/parser/queue/fs imports (enforced by an import-guard test like `scan.controller.spec.ts:157-177`).

### GitHub URL fail-closed validation (SSRF/injection parity — SCAN-02)
**Source:** `apps/api/src/http/validation/github-url.ts` (`parseGithubUrl`) + `github-url.pipe.ts:19-38` (canonical-form contract)
**Apply to:** the `enqueueScan` mutation (Pitfall 5) — reuse the SAME validator, enqueue the canonical `https://github.com/{owner}/{repo}`. One fail-closed allowlist across BOTH transports.

### Status-switched domain→wire mapping (D-06 parity)
**Source:** `apps/api/src/http/dto/scan-response.ts:25-48` (`toScanResponse`)
**Apply to:** `scan-graphql.mapper.ts` (`toScanModel`)
Explicit `switch` on `ScanStatus`; never spread the raw `Scan`; vulns only when `Finished`; `Failed` carries bounded `{category, detail}`.

### Mock-service unit test (Jest landmine avoidance)
**Source:** `apps/api/src/http/scan.controller.spec.ts:1,32-41`
**Apply to:** `scan.resolver.spec.ts`
`reflect-metadata` first; construct the edge with a hand-mocked `{ enqueue, get } as unknown as ScanService`; NEVER import `ScanModule`/`@nestjs/bullmq` (the `@swc/core` miette panic). Reuse `baseScan`/`critical` fixtures.

### Compiled-`dist` + `node:test` integration harness
**Source:** `apps/api/scripts/api-integration.mjs:1-59`
**Apply to:** any GraphQL-through-the-worker integration coverage.
`node:test` + `assert/strict`, spawn real `dist/index.js` on disposable redis, `shell:false` argv, bounded timeouts, status-preserving `finally`. Self-contained `.mjs`.

### API-process-only surfaces (memory discipline)
**Source:** two-entrypoint topology (`src/index.ts` = AppModule; `src/worker.module.ts` = WorkerModule)
**Apply to:** GraphQLModule + ServeStaticModule registration — `AppModule` ONLY, never the worker (protects the graded 150MB heap / flat-RSS budget).

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `apps/web/**` (entire workspace) | component/hook/store | request-response + polling | No prior frontend exists in the repo — greenfield. Map from RESEARCH Patterns 3–6 + `06-UI-SPEC.md`. |
| `README.md` / `ONBOARDING.md` | docs | — | Content deliverables; "analog" is the `.planning` rationale corpus, not a code pattern. |

## Metadata

**Analog search scope:** `apps/api/src/**` (http, domain, scan, engine), `apps/api/scripts/**`, `apps/api/src/app.module.ts`, `apps/api/src/index.ts`
**Files scanned:** ~12 read in full/targeted; 46 TS source files enumerated
**Pattern extraction date:** 2026-07-11
</content>
</invoke>
