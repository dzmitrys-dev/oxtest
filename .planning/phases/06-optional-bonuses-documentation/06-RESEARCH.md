# Phase 6: Optional Bonuses & Documentation - Research

**Researched:** 2026-07-11
**Domain:** NestJS 11 code-first GraphQL (MercuriusDriver) + Vite/React/Tailwind SPA served static by Fastify + reviewer-facing documentation (README/ONBOARDING)
**Confidence:** HIGH (stack + compatibility verified against npm registry and official NestJS/Mercurius docs; documentation is source-harvesting from existing CONTEXT files)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Build BOTH Bonus A (React/Vite) and Bonus B (GraphQL). Docs (README + ONBOARDING) ship regardless. Bonus C already done (Phase 5).
- **D-02:** GraphQL is **code-first via MercuriusDriver, registered on the SAME Fastify process/port as REST** (one process, zero second-listener overhead). Query calls `ScanService.get(id)` (`apps/api/src/scan/scan.service.ts:55`), mutation calls `ScanService.enqueue(repoUrl)` (`apps/api/src/scan/scan.service.ts:34`). Schema **locked by API-01**: `type Scan { id: ID!, status: String!, criticalVulnerabilities: [Vulnerability] }`. Do NOT reimplement scan logic in a resolver.
- **D-03:** The React app consumes **GraphQL (not REST)** — enqueue via mutation, then poll `scan(id)` every 2s (FE-02). GraphQL client dependency added (urql preferred; Apollo acceptable — Claude discretion). REST endpoints remain unchanged.
- **D-04:** React app is **built (`vite build`) and served as static assets by the API (Fastify) on the same origin** — no CORS, one URL. New monorepo workspace `apps/web`. `docker compose up` must serve the built UI.
- **D-05:** **GraphiQL ENABLED at `/graphiql` in all environments, including the container** (`graphiql: true`). Note the prod-hygiene trade-off in ONBOARDING.
- **D-06 (discretion, must be parity):** GraphQL error/empty semantics **mirror REST** — unknown id resolves like `ScanService.get` returning `null`; failed scan surfaces via `status: "Failed"` (+ empty `criticalVulnerabilities`). Exact error mapping is Claude's discretion provided REST-consistent.
- **D-07:** Polish via **Tailwind** (or component library); bar is "looks finished, not scaffolded" — **every state handled**: URL input + client-side validation, `Queued`, `Scanning` (spinner), `Finished` (results), `Failed` (error). All four `ScanStatus` states must render.
- **D-08:** **CRITICAL results render as a TABLE with a count summary.** Columns map ONLY to the stored `Vulnerability` shape: `pkgName`, `vulnerabilityId`, `installedVersion`, `title`, `primaryUrl` (+ `severity`). **HARD CONSTRAINT: no `fixedVersion` field exists — do NOT add a "Fixed version" column and do NOT expand the parser.**
- **D-09:** Single `ONBOARDING.md`. Each topic: **What/Why/How + an explicit "A reviewer might ask…" Q&A block**.
- **D-10:** Each topic documents **rejected alternatives / trade-offs** explicitly (harvest from Phase 1–5 CONTEXT files). Explicitly own the **NestJS-vs-Fastify tension** (`.claude/CLAUDE.md` recommends Fastify-over-NestJS yet the build is NestJS+Fastify adapter).
- **D-11:** **Expanded topic coverage:** memory strategy, architecture layering, queue design, error handling, type safety PLUS streaming/backpressure, Trivy local-detect+Docker-fallback & socket-mount trade-off, two-entrypoint + self-test honesty, guaranteed try/finally cleanup, testing strategy (the `@nestjs/bullmq`+`@swc` Jest landmine → compiled-`dist` + `node:test`).
- **D-12:** **docker-compose-first primary run path** (`docker compose up`). Local dev secondary. Runnable from README alone.
- **D-13:** **Architecture overview as ASCII diagram + brief prose** (no mermaid/render dependency).
- **D-14:** **README runs, ONBOARDING explains.** README = run instructions + short architecture overview + link to ONBOARDING. No duplication.
- **D-15 (criterion #3 checklist — MANDATORY in README):** copy-paste run (compose + local dev), memory self-test command, assignment-level acceptance command, architecture overview, **(a)** real functional scan demo against forked **OWASP NodeGoat**, **(b)** honest explanation that `node --max-old-space-size=150 dist/index.js` boots the API while the 500MB+ parse runs in `dist/worker.js` (standalone parser memtest = the honest 500MB proof), per Phase 5 D-10.

### Claude's Discretion
- GraphQL client library for `apps/web` (urql preferred for leanness vs Apollo).
- Exact GraphQL error mapping (must be REST parity per D-06) and enqueue mutation input shape (e.g. `enqueueScan(repoUrl: String!): Scan`).
- `apps/web` internal structure, Vite config, Tailwind-vs-component-library specifics.
- Static-serving mechanism (`@fastify/static` vs Nest `ServeStaticModule`) and how `vite build` output wires into the Dockerfile/compose stage.
- Precise ONBOARDING section ordering and README section ordering.

### Deferred Ideas (OUT OF SCOPE)
- None — discussion stayed within phase scope.
- (From REQUIREMENTS v2, explicitly NOT this phase: SCALE-01 dedupe, SCALE-02 timeout/retry, SCALE-03 pagination, DX-01 OpenAPI, DX-02 e2e-frontend.)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| **API-01** | GraphQL `scan(id)` query returning `type Scan { id: ID!, status: String!, criticalVulnerabilities: [Vulnerability] }` (code-first, MercuriusDriver) | Standard Stack (quartet + versions); Pattern 1 (code-first types + resolver); Pattern 2 (domain→GraphQL mapper, no DB); status is `String!` not enum |
| **API-02** | GraphQL mutation enqueues a scan (parity with `POST /api/scan`), delegates to same `ScanService` | Pattern 1 (`@Mutation` → `ScanService.enqueue`); **Pitfall 5 (SSRF parity — reuse `parseGithubUrl`)**; D-06 error parity |
| **FE-01** | React app (Vite) accepts a repo URL + "Start" button calling the scan endpoint | Standard Stack (Vite/React/urql); Pattern 3 (urql `useMutation` → `enqueueScan`); Pattern 5 (client-side URL validation) |
| **FE-02** | App polls status every 2s while scan in progress | Pattern 4 (urql poll loop: `setInterval` + `reexecuteQuery({requestPolicy:'network-only'})`, pause on terminal state) |
| **FE-03** | App displays CRITICAL vulns when `Finished`, error state on `Failed` | Pattern 6 (four-state renderer); D-08 table columns; Vulnerability field list |
| **DOC-01** | `README.md` — copy-paste run (local + compose), memory self-test cmd, architecture overview | Documentation Source Map; existing script/command inventory; ASCII diagram; criterion-#3 checklist |
| **DOC-02** | `ONBOARDING.md` — every solution as What/Why/How interview-prep | Documentation Source Map (rejected-alternatives harvest table); D-09/D-10/D-11 topic list |
</phase_requirements>

## Summary

This is an **additive** phase: Phases 1–5 shipped a submission-ready, memory-proof, Dockerized REST scan engine. Phase 6 layers three things on top without touching the memory-critical parser/worker/REST contracts: (1) a code-first GraphQL surface via NestJS `MercuriusDriver` on the *same* Fastify process, (2) a Vite/React/Tailwind SPA that dogfoods that GraphQL surface and is served as static files by the API, and (3) two documentation deliverables (README, ONBOARDING).

The single highest-risk technical finding is a **version-pinning landmine**: the GraphQL quartet (`@nestjs/graphql`, `@nestjs/mercurius`, `mercurius`) all peer-depend on **`graphql@^16`**, but the current `graphql` latest is **17.0.2**. Installing `graphql` unpinned pulls 17 and breaks the peer graph. **Pin `graphql@16.14.2`.** Second landmine, already documented in project STATE: adding `@nestjs/graphql` to `AppModule` is fine, but any **new `*.spec.ts` that transitively imports `ScanModule`/`@nestjs/bullmq` will trigger the `@swc/core` miette panic under Jest** — the GraphQL resolver unit test must mock `ScanService` (like `scan.controller.spec.ts` does) and never import `ScanModule`.

**Primary recommendation:** Install the pinned quartet + `@nestjs/serve-static`; create `apps/web` as a new npm workspace (Vite + React 19 + urql + Tailwind v4 via `@tailwindcss/vite`); register `GraphQLModule.forRoot<MercuriusDriverConfig>({ driver: MercuriusDriver, autoSchemaFile: true, graphiql: true })` and `ServeStaticModule` (serving `apps/web/dist`, excluding `/api`, `/graphql`, `/graphiql`, `/health`) in `AppModule` only (never the worker); fold a `web` build stage into the existing multi-stage Dockerfile; and write README (runs) + ONBOARDING (explains) harvesting rejected-alternative rationale already recorded across the Phase 1–5 CONTEXT files.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| GraphQL query/mutation resolution | API / Backend (NestJS resolver) | — | Thin transport adapter (ARCH-01), delegates to `ScanService`; no logic in the edge |
| Scan orchestration (enqueue/get) | API / Backend (`ScanService`) | Database/Storage (Redis) | Already owns this; GraphQL reuses it, no reimplementation (D-02) |
| GitHub URL validation for mutation | API / Backend (`parseGithubUrl`) | — | Security boundary — must apply on the GraphQL path too, not only REST (Pitfall 5) |
| Static SPA delivery | Frontend Server / Static (Fastify via `@fastify/static`) | CDN/Static (none — single origin) | D-04: one origin, no CORS; API process serves `apps/web/dist` |
| SPA state machine + polling | Browser / Client (React + urql) | — | All four `ScanStatus` states + 2s poll live client-side (FE-02/03) |
| GraphiQL playground | API / Backend (Mercurius) | — | `/graphiql` in all envs (D-05) |
| Documentation | Docs (repo root README/ONBOARDING) | — | DOC-01/02 |

## Standard Stack

All versions below verified via `npm view <pkg> version` and `npm view <pkg> peerDependencies` on 2026-07-11, and cross-checked against the installed `fastify@5.10.0` (under `@nestjs/platform-fastify@11.1.28`).

### Core — GraphQL (Bonus B, API-01/02)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@nestjs/graphql` | 13.4.2 | Code-first decorators (`@ObjectType`/`@Field`/`@Resolver`/`@Query`/`@Mutation`), schema autogen | Official NestJS GraphQL package; peer `@nestjs/core ^11.0.1` ✓ [VERIFIED: npm registry] |
| `@nestjs/mercurius` | 13.4.2 | `MercuriusDriver` + `MercuriusDriverConfig` bridging Nest ↔ Mercurius on Fastify | Official Fastify-native driver; peer `fastify ^5.2.1` ✓ (have 5.10.0), `mercurius ^16.0.1`, `@nestjs/graphql ^13` ✓ [VERIFIED: npm registry] |
| `mercurius` | 16.9.0 | The Fastify GraphQL plugin (graphql-jit compilation, GraphiQL) | CONTEXT-locked driver; peer `graphql ^16.0.0`; bundles `@fastify/static@^9` + `graphql-jit@0.8.7` transitively [VERIFIED: npm registry] |
| `graphql` | **16.14.2** | GraphQL runtime (peer of all three above) | ⚠️ **MUST pin to 16.x. Latest is 17.0.2 which the quartet rejects** (`@nestjs/graphql` peer `graphql ^16.11.0`) [VERIFIED: npm registry] |

### Core — Static serving (Bonus A wiring, FE / D-04)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@nestjs/serve-static` | 5.0.5 | Serve `apps/web/dist` from the Fastify adapter with `exclude` for API routes | Nest-idiomatic; peer `@fastify/static ^8||^9` (Mercurius already provides `@fastify/static@9`) + `fastify ^5.2.1` ✓ [VERIFIED: npm registry] |

*Alternative: register `@fastify/static` directly on the Fastify instance (`app.getHttpAdapter().getInstance().register(...)`). `@nestjs/serve-static` is recommended for the declarative `exclude` list and Nest-idiomatic wiring.*

### Core — React SPA (Bonus A, FE-01/02/03) — new `apps/web` workspace
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `vite` | 8.1.4 | Dev server + `vite build` static output | Leanest React build; CONTEXT-locked [VERIFIED: npm registry] |
| `@vitejs/plugin-react` | 6.0.3 | React fast-refresh + JSX for Vite | Official; peer `vite ^8.0.0` ✓ [VERIFIED: npm registry] |
| `react` / `react-dom` | 19.2.7 | UI runtime | Current stable; urql peer `react >=16.8` ✓ [VERIFIED: npm registry] |
| `urql` | 5.0.3 | React GraphQL client bindings (`Provider`, `useQuery`, `useMutation`) | Leaner than Apollo (D-03 preference); peer `react >=16.8`, `@urql/core ^6.0.0` [VERIFIED: npm registry] |
| `@urql/core` | 6.0.3 | urql core (`Client`, `cacheExchange`, `fetchExchange`) | urql peer dependency [VERIFIED: npm registry] |
| `graphql` | 16.14.2 | urql peer (GraphQL parsing) — **same pin as backend** | Keep one graphql major across the monorepo [VERIFIED: npm registry] |
| `tailwindcss` | 4.3.2 | Utility CSS for the "looks finished" bar (D-07) | Current v4 [VERIFIED: npm registry] |
| `@tailwindcss/vite` | 4.3.2 | Tailwind v4 Vite plugin (no `postcss.config`, no `tailwind.config.js`) | v4's official Vite integration; peer `vite ^5.2||6||7||8` ✓ [VERIFIED: npm registry] |
| `typescript` | 6.0.3 | Match the pinned API TS version | Reuse the project pin (avoid a second TS major) [VERIFIED: npm registry] |

### Supporting / dev (apps/web)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@types/react`, `@types/react-dom` | latest 19.x | React TS types | Always (strict TS, no `any`) |
| `typescript-eslint` | 8.63.0 (match API) | Lint the web workspace | Optional but consistent with repo lint discipline |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| urql | Apollo Client | Apollo has built-in `pollInterval` (nice for FE-02) but is heavier and CONTEXT prefers urql for leanness. urql needs a manual `setInterval` poll (Pattern 4) — a few lines |
| `@nestjs/serve-static` | raw `@fastify/static` | Raw plugin is one fewer dependency (Mercurius already bundles `@fastify/static`), but you hand-wire route exclusion and the Fastify adapter instance. ServeStaticModule is more declarative |
| Tailwind v4 | plain CSS / component lib (MUI, shadcn) | A component lib inflates bundle for a single-screen app; plain CSS is fine but slower to reach "finished." Tailwind v4 + `@tailwindcss/vite` is the leanest polished path |
| `autoSchemaFile: true` (in-memory) | `autoSchemaFile: 'schema.gql'` (on disk) | On-disk schema is reviewer-inspectable (a nice artifact) but adds a generated file to manage. In-memory is simpler; either satisfies D-02 |
| Static serve via API process | separate nginx/static container | A second container contradicts D-04's "same origin, one URL" and adds compose weight for zero benefit here |

**Installation:**
```bash
# Backend (in apps/api) — GraphQL quartet + static serving. NOTE the graphql pin.
npm install --workspace apps/api \
  @nestjs/graphql@13.4.2 @nestjs/mercurius@13.4.2 mercurius@16.9.0 graphql@16.14.2 \
  @nestjs/serve-static@5.0.5

# Frontend (new apps/web workspace) — scaffold then add deps
npm create vite@latest apps/web -- --template react-ts   # then pin versions in its package.json
npm install --workspace apps/web \
  urql@5.0.3 @urql/core@6.0.3 graphql@16.14.2
npm install --workspace apps/web -D \
  tailwindcss@4.3.2 @tailwindcss/vite@4.3.2
```

**Version verification note:** `graphql@16.14.2` is the current 16.x tip (`npm view 'graphql@^16' version` → 16.14.2). Do **not** accept `graphql@17.x`. The `@vitejs/plugin-react@6` peer list mentions `@rolldown/plugin-babel` and `babel-plugin-react-compiler` — both are **optional** (React Compiler opt-in); a plain react-ts scaffold does not need them.

## Package Legitimacy Audit

Ran `gsd-tools query package-legitimacy check --ecosystem npm ...` on 2026-07-11 plus `npm view` cross-checks.

| Package | Registry | Age (last publish) | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|--------------------|-----------|-------------|---------|-------------|
| @nestjs/graphql | npm | 2026-05-21 | 1.2M/wk | github.com/nestjs/graphql | OK | Approved |
| @nestjs/mercurius | npm | 2026-05-21 | 50k/wk | github.com/nestjs/graphql | OK | Approved |
| mercurius | npm | 2026-04-03 | 156k/wk | github.com/mercurius-js/mercurius | OK | Approved |
| graphql | npm | 2026-07-03 | 40M/wk | github.com/graphql/graphql-js | SUS (too-new) | Approved — **pin 16.14.2** (the "too-new" flag is the 17.0.2 latest tag; our pin is the mature 16.x line) |
| @nestjs/serve-static | npm | 2026-04-09 | 925k/wk | github.com/nestjs/serve-static | OK | Approved |
| urql | npm | 2026-06-15 | 959k/wk | github.com/urql-graphql/urql | SUS (too-new) | Approved — false positive: recent patch of mature package |
| @urql/core | npm | 2026-06-22 | 5.8M/wk | github.com/urql-graphql/urql | SUS (too-new) | Approved — false positive |
| vite | npm | 2026-07-09 | 152M/wk | github.com/vitejs/vite | SUS (too-new) | Approved — false positive |
| @vitejs/plugin-react | npm | 2026-06-23 | 67M/wk | github.com/vitejs/vite-plugin-react | SUS (too-new) | Approved — false positive |
| tailwindcss | npm | 2026-06-29 | 124M/wk | github.com/tailwindlabs/tailwindcss | SUS (too-new) | Approved — false positive |
| @tailwindcss/vite | npm | 2026-06-29 | 40M/wk | github.com/tailwindlabs/tailwindcss | SUS (too-new) | Approved — false positive |
| react / react-dom | npm | 2026-06-01 | 146M/138M wk | github.com/facebook/react | OK | Approved |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** graphql, urql, @urql/core, vite, @vitejs/plugin-react, tailwindcss, @tailwindcss/vite — **all "too-new" only**, meaning their newest published version landed within the seam's recency window. Each has millions of weekly downloads and an official source repo; the flag is a recency false positive on actively-maintained packages, not a slopsquat signal. No `postinstall` scripts on any package. No `checkpoint:human-verify` needed, but the planner SHOULD still gate the install commands so the pins are applied verbatim (especially the `graphql@16` pin).

## Architecture Patterns

### System Architecture Diagram (data flow — Phase 6 additions in **bold**)

```
                         ┌─────────────────────────────────────────────┐
   Reviewer's browser    │              API process (dist/index.js)     │
   ────────────────►     │              NestFactory + FastifyAdapter    │
     GET /               │   ┌────────────────────────────────────┐    │
     (React SPA)         │   │  ServeStaticModule → apps/web/dist  │◄───┼── D-04 static SPA
        │                │   │  (excludes /api /graphql /graphiql  │    │
        ▼                │   │            /health)                 │    │
  ┌───────────┐          │   └────────────────────────────────────┘    │
  │ apps/web  │  POST /graphql (enqueueScan mutation)                   │
  │ React +   │─────────►┌────────────────────────────────────┐        │
  │ urql +    │          │  GraphQLModule (MercuriusDriver)     │        │
  │ Tailwind  │◄─────────│  Resolver (thin, ARCH-01)            │        │
  └───────────┘  poll    │    @Mutation enqueueScan ─┐         │        │
      every 2s           │    @Query    scan(id) ────┼──┐      │        │
  (scan(id) query)       │  /graphiql (D-05)         │  │      │        │
                         │  ┌────────────────────────▼──▼───┐  │        │
   REST clients ────────►│  │  ScanController (unchanged)   │  │        │
   POST/GET /api/scan    │  └───────────┬──────────────────┘  │        │
                         │              ▼                       │        │
                         │        ScanService  (enqueue/get)   │        │
                         │         │            │              │        │
                         └─────────┼────────────┼──────────────┘        │
                                   │ BullMQ add │ ScanRepository.get
                                   ▼            ▼
                          ┌──────────────────────────┐   ┌────────────────────────────┐
                          │        Redis             │◄──│  Worker (dist/worker.js)   │
                          │  queue + scan records    │   │  clone→Trivy→stream-parse  │
                          └──────────────────────────┘   │  CRITICAL → Redis, cleanup │
                                                          │  NO GraphQL, NO SPA (heap) │
                                                          └────────────────────────────┘
```
*The worker process never loads `GraphQLModule` or `ServeStaticModule` — it boots `WorkerModule`, keeping the memory-critical process's heap free of GraphQL/SPA code (matches the two-entrypoint dead-heap rationale). Both new surfaces are API-process-only.*

### Recommended Project Structure
```
apps/
├── api/
│   └── src/
│       ├── graphql/                 # NEW — Bonus B (thin, ARCH-01)
│       │   ├── scan.model.ts        # @ObjectType() Scan (id/status:String!/criticalVulnerabilities)
│       │   ├── vulnerability.model.ts# @ObjectType() Vulnerability (6 stored fields)
│       │   ├── scan.resolver.ts      # @Query scan(id)->ScanService.get; @Mutation enqueueScan->ScanService.enqueue
│       │   └── scan-graphql.mapper.ts# domain Scan -> GraphQL Scan model (mirrors toScanResponse)
│       ├── app.module.ts            # + GraphQLModule.forRoot + ServeStaticModule (API only)
│       └── ... (unchanged)
└── web/                             # NEW WORKSPACE — Bonus A
    ├── package.json
    ├── vite.config.ts               # react() + tailwindcss()
    ├── index.html
    └── src/
        ├── main.tsx                 # urql <Provider client={...}>
        ├── App.tsx                  # form + state machine (4 ScanStatus states)
        ├── graphql.ts               # gql documents: EnqueueScan, GetScan
        ├── useScanPolling.ts        # setInterval + reexecuteQuery (2s), pause on terminal
        └── index.css                # @import "tailwindcss";
README.md                            # NEW at repo root (DOC-01)
ONBOARDING.md                        # NEW at repo root (DOC-02)
```

### Pattern 1: Code-first GraphQL types + thin resolver (API-01/02)
**What:** Decorated model classes generate the SDL; a thin resolver delegates to `ScanService`.
**When to use:** All of Bonus B.
**Example:**
```typescript
// Source: docs.nestjs.com/graphql/quick-start (code-first) + github.com/nestjs/nest sample/33-graphql-mercurius
// apps/api/src/graphql/vulnerability.model.ts
import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class VulnerabilityModel {
  @Field() vulnerabilityId!: string;
  @Field() pkgName!: string;
  @Field() installedVersion!: string;
  @Field() severity!: string;      // always 'CRITICAL'
  @Field() title!: string;
  @Field() primaryUrl!: string;
}

// apps/api/src/graphql/scan.model.ts
@ObjectType()
export class ScanModel {
  @Field(() => ID) id!: string;
  @Field() status!: string;                              // String! per locked schema (NOT an enum)
  @Field(() => [VulnerabilityModel], { nullable: true }) // [Vulnerability] nullable list
  criticalVulnerabilities?: VulnerabilityModel[];
}

// apps/api/src/graphql/scan.resolver.ts
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ScanService } from '../scan/scan.service';
import { parseGithubUrl } from '../http/validation/github-url';        // SSRF parity (Pitfall 5)
import { toScanModel } from './scan-graphql.mapper';

@Resolver(() => ScanModel)
export class ScanResolver {
  constructor(private readonly scans: ScanService) {}   // ONLY collaborator (ARCH-01)

  @Query(() => ScanModel, { nullable: true })
  async scan(@Args('id', { type: () => ID }) id: string): Promise<ScanModel | null> {
    const scan = await this.scans.get(id);              // scan.service.ts:55
    return scan === null ? null : toScanModel(scan);    // null == REST 404 parity (D-06)
  }

  @Mutation(() => ScanModel)
  async enqueueScan(@Args('repoUrl') repoUrl: string): Promise<ScanModel> {
    const parsed = parseGithubUrl(repoUrl);             // reuse the REST validator
    if (parsed === null) throw new Error('repoUrl must be an https://github.com/{owner}/{repo} URL');
    const canonical = `https://github.com/${parsed.owner}/${parsed.repo}`;
    return toScanModel(await this.scans.enqueue(canonical)); // scan.service.ts:34
  }
}
```
Register `ScanResolver` as a provider in `AppModule` (or a small `GraphqlModule`), and `GraphQLModule.forRoot<MercuriusDriverConfig>` in `imports`.

### Pattern 2: Register GraphQL (MercuriusDriver) + static serving in AppModule only
**What:** Both new surfaces mount on the existing Fastify HTTP server; neither touches the worker.
**Example:**
```typescript
// Source: docs.nestjs.com/graphql/quick-start + docs.nestjs.com/recipes/serve-static
import { GraphQLModule } from '@nestjs/graphql';
import { MercuriusDriver, MercuriusDriverConfig } from '@nestjs/mercurius';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envValidationSchema }),
    ScanModule,
    GraphQLModule.forRoot<MercuriusDriverConfig>({
      driver: MercuriusDriver,
      autoSchemaFile: true,      // in-memory schema (or 'schema.gql' for a reviewable artifact)
      graphiql: true,            // D-05: GraphiQL at /graphiql in ALL envs incl. container
    }),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', '..', 'web', 'dist'),  // apps/web/dist relative to dist/
      exclude: ['/api/{*path}', '/health', '/graphql', '/graphiql'],
    }),
  ],
  controllers: [ScanController, HealthController],
  providers: [HealthService, ScanResolver],
})
export class AppModule {}
```
**Note:** the exact `rootPath` depends on the runtime layout (compiled `dist/index.js` vs the Dockerfile's `working_dir: /app/apps/api`). Verify the relative path against where the Dockerfile copies `apps/web/dist`. The `exclude` glob syntax follows the path-to-regexp/`@fastify/static` conventions in serve-static v5 — confirm the exact wildcard token during implementation (see Open Question 1).

### Pattern 3: urql client provider + mutation (FE-01)
```tsx
// Source: urql-graphql/urql docs (Basics / React)
// main.tsx
import { Client, cacheExchange, fetchExchange, Provider } from 'urql';
const client = new Client({
  url: '/graphql',                                   // same origin (D-04) — relative URL, no CORS
  exchanges: [cacheExchange, fetchExchange],
});
createRoot(document.getElementById('root')!).render(
  <Provider value={client}><App /></Provider>,
);

// in App.tsx
import { useMutation } from 'urql';
const ENQUEUE = `mutation($repoUrl:String!){ enqueueScan(repoUrl:$repoUrl){ id status } }`;
const [, enqueue] = useMutation(ENQUEUE);
// onSubmit: const res = await enqueue({ repoUrl }); const id = res.data?.enqueueScan.id;
```

### Pattern 4: 2-second poll loop with urql (FE-02)
**What:** urql has no built-in `pollInterval`; drive it with `setInterval` + `reexecuteQuery`.
```tsx
// Source: urql-graphql/urql docs (Queries — requestPolicy / reexecuteQuery)
import { useEffect } from 'react';
import { useQuery } from 'urql';
const GET_SCAN = `query($id:ID!){ scan(id:$id){ id status criticalVulnerabilities{
  vulnerabilityId pkgName installedVersion severity title primaryUrl } } }`;

function useScanPolling(id: string | null) {
  const [result, reexecute] = useQuery({
    query: GET_SCAN, variables: { id }, pause: id === null,
  });
  const status = result.data?.scan?.status;
  const terminal = status === 'Finished' || status === 'Failed';
  useEffect(() => {
    if (id === null || terminal) return;               // stop polling on terminal state
    const t = setInterval(() => reexecute({ requestPolicy: 'network-only' }), 2000);
    return () => clearInterval(t);
  }, [id, terminal, reexecute]);
  return result;
}
```

### Pattern 5: Client-side URL validation before enqueue (FE-01, defense-in-depth)
Validate the `https://github.com/{owner}/{repo}` shape in the browser for instant UX feedback, but treat it as **cosmetic only** — the authoritative guard is server-side `parseGithubUrl` (Pitfall 5). Never rely on client validation for security.

### Pattern 6: Four-state renderer + CRITICAL table (FE-03, D-07/D-08)
```tsx
// status ∈ 'Queued' | 'Scanning' | 'Finished' | 'Failed'  (exact ScanStatus values)
// Queued/Scanning -> spinner; Failed -> error card; Finished -> count summary + table.
// Table columns (ONLY stored Vulnerability fields — NO fixedVersion, D-08):
//   Package (pkgName) | CVE (vulnerabilityId, link primaryUrl) | Installed (installedVersion)
//   | Severity (severity) | Title (title)
// Empty Finished -> "0 CRITICAL vulnerabilities found."
```

### Anti-Patterns to Avoid
- **Decorating the framework-free domain types.** `Vulnerability`/`Scan`/`ScanStatus` in `src/domain/*` are intentionally decorator-free (D-03). Create *separate* `@ObjectType()` model classes in `graphql/` + a mapper. Do not import `@nestjs/graphql` into `src/domain/`.
- **Reimplementing scan logic in the resolver.** The resolver only calls `ScanService.get`/`enqueue` (D-02, ARCH-01).
- **Registering GraphQL/static in `WorkerModule`.** They belong to `AppModule` only — the worker must stay heap-lean.
- **A GraphQL `status` enum.** The locked schema is `status: String!` (API-01). Map the `ScanStatus` enum value to its string.
- **A second HTTP listener / separate static container.** Everything shares one Fastify process/port (D-02/D-04).
- **Serving the SPA with a catch-all that shadows `/api`/`/graphql`.** Use `exclude` (Pitfall 4).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| GraphQL schema/SDL | Hand-written `.graphql` string + manual resolvers map | `@nestjs/graphql` code-first decorators + `autoSchemaFile` | Type-safe, single source of truth, matches TYPE-02 ("`@ObjectType()` classes double as typed domain models") |
| GraphQL-over-HTTP + playground | Custom Fastify route parsing GraphQL | `mercurius` via `MercuriusDriver` | Mercurius handles POST/GET, GraphiQL, graphql-jit compilation |
| GraphQL client cache/fetch/dedupe | `fetch('/graphql')` + hand-rolled polling/cache | `urql` (`useQuery`/`useMutation`) | Request dedupe, cache, React bindings; the poll loop is the only manual bit |
| Static file serving + SPA routing | `fs.readFile` route handlers | `@nestjs/serve-static` (or `@fastify/static`) | Content-types, caching headers, index fallback, range requests |
| GitHub URL validation on the GraphQL path | New validator | Existing `parseGithubUrl` (`src/http/validation/github-url.ts`) | One fail-closed allowlist for BOTH transports (SCAN-02 parity) |
| Tailwind PostCSS pipeline | Manual `postcss.config` + `tailwind.config.js` + content globs | `@tailwindcss/vite` plugin + `@import "tailwindcss";` | Tailwind v4 zero-config Vite integration |
| CSS build for React | Custom CSS bundling | Vite (esbuild dev, Rollup prod) | Zero-config, fastest scaffold |

**Key insight:** Bonus B and A are almost entirely *composition of existing seams* — the resolver is a 30-line adapter over `ScanService`, and the SPA is a state machine over two GraphQL documents. The only genuinely new logic is the 2s poll loop and the four-state renderer. Resist scope creep into the parser or `ScanService`.

## Common Pitfalls

### Pitfall 1: `graphql@17` breaks the peer graph
**What goes wrong:** `npm install graphql` (or letting a transitive resolve to latest) pulls **17.0.2**; `@nestjs/graphql@13.4.2` peer-requires `graphql ^16.11.0`, `@nestjs/mercurius` `^16.10.0`, `mercurius` `^16.0.0` → peer conflicts / runtime schema-build failures.
**Why it happens:** graphql 17 shipped 2026-07-03; the NestJS/Mercurius line has not yet moved to 17.
**How to avoid:** Pin `graphql@16.14.2` in **both** `apps/api` and `apps/web` (keep one graphql major across the monorepo/workspaces). Consider a root `overrides`/`resolutions` for `graphql` to lock it.
**Warning signs:** `npm ls graphql` showing 17.x anywhere; `ERESOLVE` peer warnings mentioning graphql; schema builds throwing on `GraphQLSchema` version mismatch.

### Pitfall 2: The `@swc/core` + `@nestjs/bullmq` Jest miette panic (STATE landmine)
**What goes wrong:** Any Jest-loaded `.spec.ts` whose import graph reaches `@nestjs/bullmq` (via `ScanModule`) triggers a native `@swc/core@1.15.43` + `miette@7.6.0` panic that aborts Jest — reproduces on Node 22 AND 24 (per STATE 03-01).
**Why it happens:** SWC's decorator transform + BullMQ's module graph.
**How to avoid:** The GraphQL resolver unit test (`scan.resolver.spec.ts`) must **mock `ScanService`** and import ONLY the resolver — never `ScanModule`/`AppModule`/`@nestjs/bullmq` (mirror `scan.controller.spec.ts`'s pattern). For any GraphQL-through-the-worker integration coverage, use the compiled-`dist` + `node:test` harness idiom (like `api-integration.mjs`), never Jest.
**Warning signs:** Jest exits with a Rust panic/`miette` backtrace instead of test results.

### Pitfall 3: static `rootPath` wrong after compilation / in Docker
**What goes wrong:** `ServeStaticModule` resolves `rootPath` relative to the compiled `dist/` location and the container `working_dir`; a path that works in `tsx` dev breaks in `node dist/index.js` or in the image.
**Why it happens:** `__dirname` is `apps/api/dist` at runtime; `working_dir` is `/app/apps/api` in compose; the Dockerfile must copy `apps/web/dist` to a path the API resolves.
**How to avoid:** Decide one canonical location (e.g., copy `apps/web/dist` → `apps/api/dist/web` in the Dockerfile builder stage, and set `rootPath: join(__dirname, 'web')`). Verify with the acceptance/self-test harness or a manual `curl /` against the built image.
**Warning signs:** `GET /` 404s in the container but works in dev.

### Pitfall 4: SPA catch-all shadows API/GraphQL routes
**What goes wrong:** Serving static from `/` without exclusions makes `/api/scan`, `/graphql`, `/graphiql`, `/health` return `index.html` (or 404) instead of hitting their handlers.
**How to avoid:** Set `ServeStaticModule` `exclude: ['/api/{*path}', '/health', '/graphql', '/graphiql']`. Confirm the wildcard token version (path-to-regexp v8 uses `{*path}`; older uses `(.*)`) — see Open Question 1. Test all four routes after wiring.
**Warning signs:** `GET /health` returns HTML; GraphiQL 404.

### Pitfall 5: GraphQL mutation as an unvalidated SSRF/injection backdoor
**What goes wrong:** REST enqueue is guarded by `GithubUrlPipe`; if the GraphQL `enqueueScan` mutation forwards `repoUrl` straight to `ScanService.enqueue`, it bypasses SCAN-02's allowlist — a second, unguarded path to the cloner.
**Why it happens:** The pipe is bound to the REST controller, not the resolver.
**How to avoid:** Call `parseGithubUrl` in the resolver and enqueue the **canonical** `https://github.com/{owner}/{repo}` (exactly as `GithubUrlPipe` does — WR-01). Reject on `null`. This keeps one fail-closed validator across both transports.
**Warning signs:** A GraphQL mutation accepts `git@`, `file://`, non-github hosts, or embedded credentials.

### Pitfall 6: GraphiQL exposes introspection in the container (deliberate, but note it)
**What goes wrong:** `graphiql: true` + introspection in all envs is a minor prod-hygiene smell a security-minded reviewer will spot.
**How to avoid:** It's a **deliberate demo choice** (D-05) — don't "fix" it, but **own it in ONBOARDING**: single-tenant take-home, reviewer explorability > introspection hardening; in a real deployment you'd gate GraphiQL/introspection behind env + auth. Same honesty posture as the Phase 5 socket-mount trade-off.

### Pitfall 7: Vite `base` path for API-served assets
**What goes wrong:** If the SPA is served from a subpath, default absolute `/assets/...` URLs can 404. Served from root `/` (D-04), the default `base: '/'` is correct — but confirm.
**How to avoid:** Serve at origin root; keep Vite `base: '/'` (default). Only set `base` if you mount the SPA under a subpath (not planned).

## Documentation Source Map (DOC-01 / DOC-02)

The docs are a **harvest** of decisions already recorded — not re-derivation (D-10/D-11). Map each ONBOARDING topic to its rationale source:

| ONBOARDING topic (What/Why/How + "reviewer might ask") | Rejected-alternative rationale lives in |
|--------------------------------------------------------|------------------------------------------|
| Memory strategy (150MB heap, flat RSS) | `PROJECT.md` Core Value; `02-CONTEXT.md`; `REQUIREMENTS.md` MEM-01..04 |
| Streaming/backpressure (stream-json deep-leaf Pick) | `02-CONTEXT.md`; STATE Phase 2 flag (`pick`/`streamArray` composition); `.claude/CLAUDE.md` "What NOT to Use" (`fs.readFile`/`JSON.parse`, `bfj` vs `stream-json`, `JSONStream`) |
| Architecture layering (Controller/Service/Worker, ARCH-01/02/03) | `04-CONTEXT.md`; `03-CONTEXT.md`; ARCH reqs; thin-controller import-guard |
| Queue design (BullMQ, concurrency:1, restart survival) | `03-CONTEXT.md`; STATE 03-01 (SCAN_QUEUE Symbol token, AsyncLocalStorage rejected for the Redis hop) |
| Error handling (Trivy exit codes, clone/disk-full/parse, bounded reasons) | `03-CONTEXT.md`; ERR-01..05; `ScanFailureReason` D-20/D-21 |
| Type safety (strict, no `any`, `@ObjectType` doubling) | `01-CONTEXT` decisions; STATE Phase 01 (TS pinned 6.0.3, `verbatimModuleSyntax` omitted for Nest DI); TYPE-01/02 |
| Trivy local-detect + Docker fallback & **socket-mount trade-off** | `05-CONTEXT.md` D-06; `03-CONTEXT` (spawn, pinned `aquasecurity/trivy:0.69.3`); STATE 05-02, gap 05-04 |
| Two-entrypoint topology + **self-test honesty** (index.js boots API; 500MB parse in worker.js) | `05-CONTEXT.md` D-10; STATE 05-03 (`selftest-index-boot.mjs` authoritative, `acceptance.mjs` superset); `PROJECT.md` two-entrypoint |
| Guaranteed try/finally cleanup | `03-CONTEXT.md`; ENGINE-07; ERR-02/03 |
| Testing strategy (**Jest landmine** → compiled-`dist` + `node:test`) | STATE 01/03-01/03-03 (`@swc/core`+`@nestjs/bullmq` miette panic); `04-03`/`05-03` harness notes |
| **NestJS-vs-Fastify tension** (own it, D-10) | `.claude/CLAUDE.md` (recommends Fastify-over-NestJS) vs `PROJECT.md` Key Decisions (NestJS chosen: Module/Controller/Provider IS the graded separation); `04-CONTEXT` |
| Node image choice (`node:22-slim` over alpine/distroless) | `Dockerfile` header comments; `05-CONTEXT.md` D-05 |
| Logging (scanId correlation, no pino transport in-container) | STATE 05-01; OPS-04 |
| Config fail-closed (Joi, required keys) | STATE Phase 01; OPS-03 |

### README existing commands/artifacts to cite (DOC-01, D-12/D-15)
Verified against `apps/api/package.json` scripts, `docker-compose.yml`, and `apps/api/scripts/`:

| Purpose | Command / artifact | Notes |
|---------|--------------------|-------|
| One-command run (primary, D-12) | `docker compose up` | redis + api + worker; api on `:3000`; add "served UI" once static wiring lands |
| Local dev — API | `npm run dev:api` (`tsx watch src/index.ts`) or `npm run start:api` (`node dist/index.js`) | — |
| Local dev — worker | `npm run dev:worker` / `npm run start:worker` | — |
| Local dev — web (NEW) | `npm run dev --workspace apps/web` (Vite dev server) | proxy `/graphql` to `:3000` in Vite dev, or run built |
| **Memory self-test** (D-15) | `npm run memtest --workspace apps/api` (`tsx scripts/memtest.ts`); sweep: `npm run memtest:sweep` | the honest 500MB parser proof (worker path) |
| Fixture generator | `npm run gen:fixture --workspace apps/api` | 500MB+ synthetic Trivy JSON |
| Verbatim self-test (criterion #5a) | `node --max-old-space-size=150 dist/index.js` (proven by `npm run test:selftest`) | boots API without OOM |
| **Acceptance command** (D-15) | `npm run test:acceptance --workspace apps/api` (`scripts/acceptance.mjs`) | full submission proof over disposable redis |
| In-container OOM proof | `npm run test:oom:container` | Phase 5 |
| Build | `npm run build --workspace apps/api` (+ NEW `apps/web` build) | — |

**NodeGoat demo target (D-15a):** the forked **OWASP NodeGoat** repo — `https://github.com/OWASP/NodeGoat` (fork under the submitter's GitHub account, per the "forked" convention). Confirm the exact fork URL with the user before hard-coding it in README (Assumption A1).

**Honest self-test explanation (D-15b):** README must state that the PDF's `node --max-old-space-size=150 dist/index.js` boots the **API** (which does not itself parse 500MB), while the 500MB+ stream-parse runs in `dist/worker.js`; the standalone `memtest` against the 500MB fixture is the honest memory proof. Source: `05-CONTEXT.md` D-10, STATE 05-03.

## Runtime State Inventory

> This is a greenfield-additive phase (new GraphQL surface, new `apps/web` workspace, new docs). It renames nothing and migrates no stored data. Categories below verified explicitly.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — GraphQL reads existing Redis scan records via `ScanService.get`; no new keys, no schema change to stored `Scan`/`Vulnerability` | None |
| Live service config | None — no new external service; GraphiQL/GraphQL mount on the existing Fastify listener; compose gains only a served-UI note, no new service | None (verify compose still 3 services) |
| OS-registered state | None | None |
| Secrets/env vars | None new required. `apps/web` uses a **relative** `/graphql` URL (same origin, D-04) — no `VITE_API_URL` needed for the served build. (A Vite dev proxy may reference `:3000` in dev config only.) | None |
| Build artifacts | NEW: `apps/web/dist` (Vite output) must be produced and copied into the API image; root `package-lock.json` changes (new workspace + deps). Stale `apps/api/dist` rebuilt by existing `build` | Add `apps/web` build to Dockerfile + build scripts |

**Nothing found requiring data migration** — verified: the GraphQL `Scan`/`Vulnerability` GraphQL types are read-only projections of already-persisted domain objects.

## Code Examples

### Vite config (apps/web) — React + Tailwind v4 + dev proxy
```typescript
// Source: vitejs.dev/guide + tailwindcss.com/docs/installation/using-vite
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: { '/graphql': 'http://localhost:3000' },  // dev only; prod is same-origin (D-04)
  },
});
```
```css
/* apps/web/src/index.css — Tailwind v4 single import (no config file) */
@import "tailwindcss";
```

### Domain → GraphQL mapper (mirrors toScanResponse, D-06 parity)
```typescript
// apps/api/src/graphql/scan-graphql.mapper.ts
import type { Scan } from '../domain/scan.types';
import { ScanModel } from './scan.model';

export function toScanModel(scan: Scan): ScanModel {
  const model = new ScanModel();
  model.id = scan.id;
  model.status = scan.status;                                   // enum value IS the wire string
  model.criticalVulnerabilities =                              // empty/undefined unless Finished
    scan.status === 'Finished' ? (scan.vulnerabilities ?? []) : undefined;
  return model;                                                 // Failed -> status:'Failed', vulns undefined (D-06)
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Tailwind v3 (`tailwind.config.js` + PostCSS + `content` globs) | Tailwind v4 `@tailwindcss/vite` plugin + `@import "tailwindcss"` | v4 (2025) | No config files; automatic content detection |
| Apollo Server standalone / second listener | Fastify-native `mercurius` via `MercuriusDriver`, one process | NestJS 10+/11 | Zero second-listener memory (aligns with the memory grading) |
| urql/Apollo built-in polling everywhere | urql: explicit `setInterval` + `reexecuteQuery` (no `pollInterval` API) | urql 4+ | A few lines of poll code (Pattern 4) |
| `graphql@16` universal | `graphql@17` released 2026-07-03 | 2026-07 | NestJS/Mercurius not yet on 17 → **stay on 16.x** (Pitfall 1) |

**Deprecated/outdated:**
- Apollo bare server for this project (heaviest, second listener) — use Mercurius (already in `.claude/CLAUDE.md` "What NOT to Use").
- Tailwind v3 PostCSS pipeline — superseded by the v4 Vite plugin.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The NodeGoat demo target is a fork of `https://github.com/OWASP/NodeGoat` under the submitter's account | Documentation Source Map / D-15a | README cites a repo URL that isn't the intended fork; low risk (easily corrected), but confirm the exact fork URL/owner with the user |
| A2 | `autoSchemaFile: true` (in-memory) is acceptable vs an on-disk `schema.gql` artifact | Pattern 2 | Cosmetic — an on-disk schema is a nicer reviewer artifact; either satisfies API-01 |
| A3 | urql (not Apollo) is the chosen client | Standard Stack | CONTEXT states urql *preferred*, Apollo *acceptable* (Claude discretion) — planner may switch; poll pattern differs (Apollo has `pollInterval`) |
| A4 | Copying `apps/web/dist` into the API image and serving via `ServeStaticModule` `rootPath` resolves correctly at `node dist/index.js` runtime | Pattern 2 / Pitfall 3 | If path resolution differs, `GET /` 404s in container — must be verified against the built image, not just dev |
| A5 | `ServeStaticModule` v5 `exclude` uses `'/api/{*path}'`-style path-to-regexp v8 wildcards | Pattern 2 / Pitfall 4 | Wrong wildcard token silently fails to exclude → API routes shadowed; verify token at implementation (Open Question 1) |
| A6 | Tailwind v4 is chosen over a component library | Standard Stack / D-07 | CONTEXT allows "Tailwind or a component library" — discretion; Tailwind assumed for leanness |
| A7 | `@vitejs/plugin-react@6`'s babel/react-compiler peers are optional for a plain react-ts app | Installation | If Vite 8 + plugin-react 6 requires the rolldown babel peer, install may warn — plain scaffold expected to work without React Compiler |

**If any assumption is load-bearing for a locked decision, the planner should add a `checkpoint:human-verify` (especially A1 — the NodeGoat fork URL — and A4/A5 — static path + exclude, verified against the built image).**

## Open Questions

1. **Exact `ServeStaticModule` v5 / `@fastify/static` `exclude` wildcard syntax.**
   - What we know: serve-static v5 supports an `exclude` array; the Fastify path router uses path-to-regexp v8 (`{*path}`) in the NestJS 11 line.
   - What's unclear: whether it's `'/api/{*path}'`, `'/api/(.*)'`, or `'/api*'` for this exact version pairing.
   - Recommendation: during implementation, wire it, then `curl` `/health`, `/api/scan/x`, `/graphql`, `/graphiql`, `/` against the built image and adjust the token until all four backend routes bypass the SPA. Cheap to verify empirically.

2. **Canonical location for `apps/web/dist` inside the image.**
   - What we know: Dockerfile `working_dir: /app/apps/api`, entrypoint `node dist/index.js`.
   - What's unclear: cleanest copy target (`apps/api/dist/web` vs a sibling `apps/web/dist` with a relative `rootPath`).
   - Recommendation: copy into `apps/api/dist/web` in the builder stage and set `rootPath: join(__dirname, 'web')` — keeps everything under the one dir the runtime already ships.

3. **Vite dev proxy vs built-only for local dev.**
   - What we know: prod is same-origin; dev can proxy `/graphql` → `:3000`.
   - Recommendation: include the dev proxy (Code Examples) so `npm run dev --workspace apps/web` works against a locally running API; README's primary path stays `docker compose up`.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | build/run all | ✓ | project pins `>=22 <23` (repo `.nvmrc`=22) | — |
| npm | workspace install/build | ✓ | bundled with Node | — |
| Docker + compose | `docker compose up` primary run path (D-12) | ✓ (used in Phase 5) | — | local dev path (secondary) |
| Trivy (via Docker image) | worker scan (unchanged) | via `ghcr.io/aquasecurity/trivy:0.69.3` socket mount | — | local `trivy` binary auto-detect (ENGINE-04) |
| Redis | queue + scan records (unchanged) | container (`redis:7-alpine`) | 7 | — |
| Internet (npm registry) | install new deps | ✓ | — | — |

**Missing dependencies with no fallback:** none — Phase 6 adds only npm packages and a build step; no new system tools.

## Security Domain

> `security_enforcement: true`, `security_asvs_level: 1`. Phase 6 adds a new public input surface (GraphQL mutation) and a new served-asset surface — both in scope.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Take-home has no auth (out of scope, unchanged) |
| V3 Session Management | no | Stateless; no sessions |
| V4 Access Control | no | Single-tenant; GraphiQL/introspection deliberately open (D-05, documented) |
| V5 Input Validation | **yes** | GraphQL `enqueueScan` MUST reuse `parseGithubUrl` fail-closed allowlist (Pitfall 5); GraphQL args are typed (`String!`/`ID!`) |
| V6 Cryptography | no | No new secrets/crypto |
| V12 Files/Resources | **yes** | Static serving must not path-traverse outside `apps/web/dist` (`@fastify/static` handles this); `exclude` prevents API-route shadowing |
| V13 API/Web Service | **yes** | GraphQL surface parity with REST; introspection/GraphiQL exposure is a conscious, documented trade-off (D-05) |
| V14 Config | **yes** | No new required env; relative `/graphql` avoids leaking an API origin; `node:22-slim` non-root runtime unchanged |

### Known Threat Patterns for this stack
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SSRF / command-injection via GraphQL `repoUrl` (unvalidated backdoor) | Tampering / EoP | Reuse `parseGithubUrl`; enqueue canonical URL only; `git clone` already `shell:false` argv (Pitfall 5) |
| GraphQL introspection/GraphiQL info disclosure | Info Disclosure | **Accepted** for demo (D-05); documented in ONBOARDING as a real-deployment gate you'd add |
| GraphQL query-depth/complexity abuse | DoS | Schema is trivial (2 flat types, no nesting/recursion); complexity limiting not required at this scope — note as a v2 consideration |
| Static path traversal (`GET /../../etc/passwd`) | Info Disclosure | `@fastify/static` normalizes/rejects traversal; serve only `apps/web/dist` |
| SPA route shadowing backend endpoints | Tampering | `exclude` API/GraphQL/health routes (Pitfall 4) |
| Log injection via `repoUrl` | Tampering | Already mitigated — `ScanService.enqueue` logs `repoUrl` as a structured pino field, never interpolated (scan.service.ts:50) |

## Project Constraints (from CLAUDE.md)
- **Memory is the pass/fail axis** — Phase 6 must not touch the parser/worker heap path; GraphQL + SPA are API-process-only. No `fs.readFile`/`JSON.parse` on scan results (unchanged; not touched here).
- **Strict TypeScript, no `any`** — applies to all new GraphQL model/resolver/mapper code and all `apps/web` TS. `@ObjectType()` classes double as typed models (TYPE-02).
- **Research-first for features/UX** — this document + official NestJS/Mercurius/urql/Vite/Tailwind docs satisfy the rule; the React UI is user-facing (benchmark against a clean status-polling UX: input → progress → results table / error card).
- **NestJS-vs-Fastify tension is explicit** — `.claude/CLAUDE.md` recommends Fastify-over-NestJS; the build is NestJS+Fastify adapter. Per D-10, ONBOARDING must *own* this decision (Module/Controller/Provider IS the graded separation; Fastify adapter keeps it lean), not act on it.
- **Runnable from README alone** (docker-compose path end-to-end) — DOC-01 D-12/D-15.

## Sources

### Primary (HIGH confidence)
- `npm view` (registry) 2026-07-11 — versions + `peerDependencies` for the full stack (the compatibility quartet cross-checked field-by-field against installed `fastify@5.10.0`).
- `gsd-tools query package-legitimacy check` 2026-07-11 — all packages OK or "too-new" false positives (mature, high-download, official repos, no postinstall).
- Existing codebase (authoritative for contracts): `apps/api/src/scan/scan.service.ts` (`enqueue`:34 / `get`:55), `src/domain/{scan,vulnerability}.types.ts`, `src/http/scan.controller.ts` + `dto/scan-response.ts`, `src/http/validation/github-url.ts` + `.pipe.ts`, `src/scan/scan.module.ts`, `src/app.module.ts`, `Dockerfile`, `docker-compose.yml`, `apps/api/package.json` scripts.
- `docs.nestjs.com/graphql/quick-start` + `github.com/nestjs/nest` sample `33-graphql-mercurius` — code-first `MercuriusDriverConfig` (`autoSchemaFile`, `graphiql: true`, `/graphiql`).

### Secondary (MEDIUM confidence)
- WebSearch (2026-07-11) confirming `GraphQLModule.forRoot<MercuriusDriverConfig>` shape and GraphiQL-at-`/graphiql` behavior (mercurius integration docs, NestJS Mercurius samples).
- `urql-graphql/urql`, `vitejs.dev`, `tailwindcss.com` official docs (Provider/useQuery/useMutation; Vite react-ts; `@tailwindcss/vite`) — established patterns, versions pinned from registry.

### Tertiary (LOW confidence)
- Exact `ServeStaticModule` v5 `exclude` wildcard token (Open Question 1) — verify empirically against the built image.
- NodeGoat fork URL (Assumption A1) — confirm with user.

## Metadata

**Confidence breakdown:**
- Standard stack + version compatibility: HIGH — every version and peer range verified via `npm view` against the installed Fastify/NestJS; the `graphql@16` constraint is the load-bearing finding and is directly confirmed.
- Architecture patterns: HIGH — resolver/mapper mirror existing `scan.controller.ts`/`toScanResponse`; static + GraphQL wiring from official NestJS docs.
- Frontend patterns: MEDIUM-HIGH — urql poll loop and Tailwind v4 setup are established; exact React ergonomics are discretion.
- Static-serving path resolution + `exclude` syntax: MEDIUM — must be verified against the built image (Open Questions 1–2).
- Documentation: HIGH — a harvest of decisions already recorded in Phase 1–5 CONTEXT/STATE (mapped above), not new derivation.

**Research date:** 2026-07-11
**Valid until:** 2026-08-10 (30 days — stable stack; re-confirm `graphql` still <17 for the NestJS line, and Vite/Tailwind/urql patch versions, at install time)
