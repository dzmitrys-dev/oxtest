# Phase 1: Foundations, Domain Types & Strict Config - Research

**Researched:** 2026-07-09
**Domain:** NestJS 11 (Fastify adapter) project scaffolding, npm workspaces monorepo, strict TypeScript config, boot-time env validation, two-entrypoint module topology
**Confidence:** MEDIUM (package versions/compatibility verified live via `npm view` and official NestJS docs source; Context7 MCP was not exposed as a callable tool in this session — all "docs"-kind questions were answered via WebFetch against `raw.githubusercontent.com/nestjs/docs.nestjs.com` official doc source and WebSearch, not the curated Context7 provider, so per the source-hierarchy seam these are tagged LOW-tier provider confidence even though the content itself is official-docs-sourced — see Sources)

## Summary

This phase has almost no business-logic risk — it is pure scaffolding — but it has one **critical, time-sensitive risk that training data and even yesterday's STACK.md research got wrong**: `npm view typescript version` currently resolves to **7.0.2**, TypeScript's new Go-native compiler released 2026-07-08. That compiler does not yet expose a stable programmatic API, and both `typescript-eslint` (peer range `>=4.8.4 <6.1.0`) and `ts-jest` (peer range `>=4.3 <7`) explicitly do not support it. The correct, tooling-compatible pin for this project is **TypeScript 6.0.3** (latest 6.x), not 7.x and not the `5.9.x` figure in the earlier STACK.md/PROJECT.md research. This must be locked explicitly in `package.json` (`"typescript": "6.0.3"` or `"~6.0.3"`, not a bare `^` on `latest`) or the very first `npm install` silently pulls an incompatible compiler.

Beyond that, the phase is standard NestJS ceremony verified against official docs: `NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())` for the API entrypoint, `NestFactory.createApplicationContext(WorkerModule)` for the worker entrypoint (no HTTP, HTTP-only decorators/middleware/guards are inert), `ConfigModule.forRoot({ validationSchema: Joi.object({...}) })` for fail-fast env validation (an uncaught validation exception during bootstrap crashes the process non-zero — this is native Nest behavior, no extra code needed), and `app.enableShutdownHooks()` for graceful SIGTERM/SIGINT handling (opt-in, disabled by default). `nest new` itself scaffolds `strict: false` by default and must be immediately overridden. npm workspaces is a simple root `package.json` with a `workspaces` array; because `apps/web` does not exist until Phase 6, list `apps/api` explicitly rather than a `apps/*` glob to avoid ambiguity about an as-yet-empty, package.json-less directory.

**Primary recommendation:** Scaffold `apps/api` with `nest new`, immediately pin TypeScript to `6.0.3`, immediately overwrite the generated `tsconfig.json` with `strict: true` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`, swap `@nestjs/platform-express` → `@nestjs/platform-fastify`, and hand-build the two entrypoints (`src/index.ts`, `src/worker.ts`) plus `ScanModule`/`AppModule`/`WorkerModule`/`domain/` per the exact API signatures below — do not rely on `nest new`'s generated `main.ts` beyond its shape as a starting template.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| HTTP bootstrap (`NestFactory.create` + `listen`) | API / Backend | — | `src/index.ts` is the sole HTTP entrypoint; owns the Fastify adapter instance |
| Worker bootstrap (`createApplicationContext`) | API / Backend (background) | — | `src/worker.ts` is a non-HTTP process; still "backend tier" but a distinct OS process/container from the API |
| Env schema validation (Joi) | API / Backend | — | Runs at process boot in both entrypoints via shared `ConfigModule`; fails fast before any transport/queue wiring |
| Domain types (`Scan`, `Vulnerability`, `ScanStatus`, Trivy report shape) | Database / Storage (shape) | API / Backend (consumer) | Pure TS interfaces with zero runtime dependency — they describe the shape of what's persisted/parsed, but live in `domain/` and are imported by both API and worker tiers, never the reverse |
| `ScanModule` (skeleton) | API / Backend | — | Shared DI seam both `AppModule` and `WorkerModule` import; owns nothing yet (stub only) this phase |
| Graceful shutdown (`enableShutdownHooks`) | API / Backend | — | Called in both entrypoints independently; each process manages its own lifecycle |

## Standard Stack

### Core

| Library | Version (verified `npm view` 2026-07-09) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@nestjs/core` | 11.1.28 | Nest runtime/DI container | Locked framework choice (PROJECT.md); provides `NestFactory` |
| `@nestjs/common` | 11.1.28 | Decorators, pipes, base classes | Paired 1:1 with `@nestjs/core` |
| `@nestjs/platform-fastify` | 11.1.28 | Fastify HTTP adapter for Nest | D-05/D-06 locked decision; bundles `fastify@5.10.0` as a direct dependency (not a peer — no separate `fastify` install needed) |
| `@nestjs/config` | 4.0.4 | `ConfigModule`, env loading | OPS-03 locked mechanism; peers only on `@nestjs/common ^10\|\|^11` and `rxjs ^7.1.0` — no Joi peer, Joi is a manual sibling dependency |
| `joi` | 18.2.3 | Env schema validation | OPS-03 locked; v18 is a low-risk maintenance release over v17 (drops Node <20 support, minor TS-generic array typing change) — `Joi.object()/.string()/.number()/.valid()/.default()/.required()/.port()` API used in the standard pattern is unchanged |
| `reflect-metadata` | 0.2.2 | Decorator metadata reflection | Required by Nest's DI (`emitDecoratorMetadata` + this library is how Nest reads constructor param types) |
| `rxjs` | 7.8.2 | Reactive primitives Nest depends on | Required peer of `@nestjs/*` packages |
| `typescript` | **6.0.3** (NOT the npm "latest" tag, which is 7.0.2 — see State of the Art) | Language / compiler | Only version compatible with `typescript-eslint` and `ts-jest`/`@swc/jest`-adjacent tooling today |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@nestjs/cli` | 11.0.23 | `nest new`/`nest generate`/`nest build` | Scaffold step (D-05) and ongoing codegen; not required at runtime |
| `@nestjs/schematics` | 11.1.0 | Templates used by `@nestjs/cli` | Installed automatically as a dep of `@nestjs/cli` |
| `@nestjs/testing` | 11.1.28 | `Test.createTestingModule` | Unit/integration test scaffolding (later phases build on this; install now since `nest new` includes it) |
| `eslint` | 10.6.0 | Lint | `nest new` in 2026 generates flat-config `eslint.config.mjs`, not `.eslintrc.*` |
| `typescript-eslint` | 8.63.0 (unified package) | TS-aware lint rules | Peer-capped at `typescript >=4.8.4 <6.1.0` — reinforces the TS 6.0.3 pin |
| `prettier` | 3.9.4 | Formatting | `nest new` default |
| `@types/node` | 26.1.1 | Node type defs | Match installed Node major (20/22 LTS types still ship under this major) |
| `jest` | 30.4.2 | Test runner | `nest new` default; CONTEXT.md discretion note keeps Jest unless a reason to switch — no reason surfaced |
| `@swc/jest` | 0.2.39 | Fast Jest transform | CONTEXT.md discretion: use for speed over `ts-jest` |
| `tsx` | 4.23.0 | Dev-time watch/run for both entrypoints | `tsx watch src/index.ts` / `tsx watch src/worker.ts` — replaces `nest start --watch` since we have two custom entrypoints (see Pitfall 3 below) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| TypeScript 6.0.3 | TypeScript 7.0.2 (npm `latest`) | Rejected for this phase: `ts-jest`/`typescript-eslint` peer ranges explicitly exclude it; TS7's own programmatic API is documented as not-yet-stable even by its own release-candidate announcement. Revisit once `typescript-eslint` publishes a TS7-compatible major. |
| `@swc/jest` | `ts-jest` | `ts-jest` (29.4.11) also works (peer `typescript >=4.3 <7`, compatible with 6.0.3) and gives more precise type-checking-in-tests; `@swc/jest` is faster but skips type-checking during test transform (acceptable since `tsc --noEmit` is the authoritative type gate per TYPE-01) |
| Listing `apps/api` explicitly in `workspaces` | `"apps/*"` glob | A glob is more idiomatic long-term (Phase 6 adds `apps/web` with zero root `package.json` edits), but npm's exact behavior for glob-matched directories that exist but lack a `package.json` (i.e., a placeholder `apps/web/`) is not authoritatively documented — safer to list `apps/api` explicitly now and switch to (or add) the glob/second entry in Phase 6 when `apps/web` actually has a `package.json` |

**Installation:**
```bash
# from repo root, after apps/api exists (see Architecture Patterns > Scaffold Steps)
npm install --workspace apps/api \
  @nestjs/core@11.1.28 @nestjs/common@11.1.28 @nestjs/platform-fastify@11.1.28 \
  @nestjs/config@4.0.4 joi@18.2.3 reflect-metadata@0.2.2 rxjs@7.8.2

npm install --workspace apps/api --save-dev \
  typescript@6.0.3 @nestjs/cli@11.0.23 @nestjs/schematics@11.1.0 @nestjs/testing@11.1.28 \
  eslint@10.6.0 typescript-eslint@8.63.0 prettier@3.9.4 @types/node@26.1.1 \
  jest@30.4.2 @swc/jest@0.2.39 tsx@4.23.0

# Explicitly REMOVE express traces left by `nest new` before continuing:
npm uninstall --workspace apps/api @nestjs/platform-express
```

**Version verification:** All versions above were confirmed live via `npm view <pkg> version` on 2026-07-09 — do not treat the table as static; re-run `npm view` at actual install time since this stack moves fast (see State of the Art). `npm view <pkg> scripts.postinstall` was also checked for `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-fastify`, `@nestjs/config`, `joi`, and `typescript` — none define a `postinstall` script.

## Package Legitimacy Audit

The legitimacy seam (`gsd-tools query package-legitimacy check`) flags several packages `SUS` under a **"too-new"** signal. Manual inspection shows this is a heuristic false-positive pattern: the signal fires because each package's *most recent version* was published within the checker's freshness window, not because the *package itself* is new or unvetted. All flagged packages have multi-year-old canonical GitHub repos and tens-to-hundreds of millions of weekly downloads. Per protocol, they are still tagged `SUS` below and the planner must gate their install behind a `checkpoint:human-verify` task — but the audit notes below explain why this is very likely a benign false positive so the human check should be fast.

| Package | Registry | Weekly Downloads | Source Repo | Latest Publish | Verdict | Disposition |
|---------|----------|-------------------|--------------|-----------------|---------|-------------|
| `@nestjs/core` | npm | 11,473,369/wk | github.com/nestjs/nest | 2026-07-08 | `SUS` ("too-new") | Flagged — checkpoint required, but downloads/repo confirm legitimacy |
| `@nestjs/common` | npm | 11,864,738/wk | github.com/nestjs/nest | 2026-07-08 | `SUS` ("too-new") | Flagged — same as above |
| `@nestjs/platform-fastify` | npm | 1,174,519/wk | github.com/nestjs/nest | 2026-07-08 | `SUS` ("too-new") | Flagged — same as above |
| `@nestjs/config` | npm | 6,833,763/wk | github.com/nestjs/config | 2026-04-09 | `OK` | Approved |
| `@nestjs/cli` | npm | 6,640,958/wk | github.com/nestjs/nest-cli | 2026-06-09 | `OK` | Approved |
| `joi` | npm | 20,861,431/wk | github.com/hapijs/joi | 2026-06-17 | `SUS` ("too-new") | Flagged — same false-positive pattern (mature hapi.js-ecosystem library) |
| `typescript` | npm | 216,419,900/wk | github.com/microsoft/TypeScript | 2026-07-08 | `SUS` ("too-new") | Flagged — same pattern **AND** independently, do not install the `latest`-tagged version (7.0.2) anyway — pin `6.0.3` per Standard Stack above |
| `rxjs` | npm | 87,880,104/wk | github.com/reactivex/rxjs | 2025-02-22 | `OK` | Approved |
| `reflect-metadata` | npm | 34,425,762/wk | github.com/rbuckton/reflect-metadata | 2024-03-29 | `OK` | Approved |
| `jest` | npm | 42,043,156/wk | github.com/jestjs/jest | 2026-05-09 | `OK` | Approved |
| `@swc/jest` | npm | 5,827,920/wk | github.com/swc-project/pkgs | 2025-07-09 | `OK` | Approved |
| `fastify` (transitive via platform-fastify) | npm | 9,043,157/wk | github.com/fastify/fastify | 2026-07-05 | `SUS` ("too-new") | Flagged — same false-positive pattern; not installed directly, arrives as `@nestjs/platform-fastify`'s pinned dependency (`fastify@5.10.0` exact) |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-fastify`, `joi`, `typescript`, `fastify` — all six are the "too-new" false-positive pattern described above (extremely high weekly downloads + long-lived canonical org repos). The planner must still insert one `checkpoint:human-verify` task before the first `npm install` step covering this whole group (a single check of "yes, these are the real `nestjs/nest`, `hapijs/joi`, `microsoft/TypeScript`, `fastify/fastify` packages" suffices — no need for six separate checkpoints).

*No packages in this phase were discovered via WebSearch as a wholly new/unfamiliar name — all are pre-existing locked decisions from PROJECT.md/CLAUDE.md/prior STACK.md research, re-verified here against the live registry.*

## Architecture Patterns

### System Architecture Diagram

```
                     npm workspaces root (package.json: workspaces:["apps/api"])
                                     │
                     ┌───────────────┴────────────────┐
                     │           apps/api               │
                     │  (its own package.json,          │
                     │   tsconfig.json, nest-cli.json)   │
                     └───────────────┬────────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                        │
      src/index.ts            src/worker.ts             src/domain/*.ts
   (API entrypoint)          (worker entrypoint)         (framework-free types)
              │                      │                        ▲
   NestFactory.create(          NestFactory.                   │  imported by both
     AppModule,              createApplicationContext(         │  entrypoints & ScanModule
     new FastifyAdapter())      WorkerModule)                  │
   await app.listen(PORT)     app.enableShutdownHooks()        │
   app.enableShutdownHooks()  (no .listen() call — stays       │
              │                alive until SIGTERM/SIGINT)     │
              ▼                      ▼                        │
        AppModule                WorkerModule                 │
   imports: ConfigModule,    imports: ConfigModule,            │
     ScanModule,               ScanModule                     │
     (HTTP/GraphQL later)    (NO GraphQL/HTTP import — ─────────┘
              │                dead-heap guard)
              └──────────┬───────────┘
                         ▼
                    ScanModule (skeleton/stub this phase)
                         │
              ConfigModule.forRoot({
                validationSchema: Joi.object({...}),
              })
                         │
              boot-time validation:
              invalid/missing env → Nest throws
              during bootstrap → uncaught → process
              exits non-zero, clear Joi message
              valid env → bootstrap proceeds
```

### Recommended Project Structure

```
/ (repo root)
├── package.json                 # "workspaces": ["apps/api"], no deps of its own
├── .nvmrc                       # pinned Node LTS (D-4b)
├── apps/
│   ├── api/
│   │   ├── package.json         # nest new-generated, then pruned (express removed)
│   │   ├── tsconfig.json        # OVERWRITTEN with strict:true + noUncheckedIndexedAccess
│   │   ├── tsconfig.build.json  # nest-cli default build config (excludes test files)
│   │   ├── nest-cli.json        # entryFile left at Nest default; unused for our custom start scripts
│   │   ├── eslint.config.mjs    # nest new flat-config default
│   │   └── src/
│   │       ├── index.ts         # API entrypoint -> dist/index.js
│   │       ├── worker.ts        # worker entrypoint -> dist/worker.js
│   │       ├── app.module.ts    # AppModule: ConfigModule + ScanModule (+ HTTP/GraphQL later)
│   │       ├── worker.module.ts # WorkerModule: ConfigModule + ScanModule (NO GraphQL/HTTP)
│   │       ├── scan/
│   │       │   └── scan.module.ts   # ScanModule skeleton — no providers with logic yet
│   │       ├── domain/
│   │       │   ├── scan.types.ts        # Scan, ScanStatus enum
│   │       │   ├── vulnerability.types.ts  # Vulnerability interface
│   │       │   └── trivy-report.types.ts   # minimal Trivy report shape (D-04)
│   │       └── config/
│   │           └── env.validation.ts    # Joi schema, exported for ConfigModule.forRoot()
│   │       
│   └── web/                     # EMPTY placeholder this phase (Phase 6 populates) — NOT
│                                 # listed in root workspaces array yet (see Alternatives Considered)
└── .planning/                   # existing GSD scaffolding
```

### Pattern 1: Two NestFactory bootstraps sharing one module graph

**What:** `src/index.ts` calls `NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())` + `app.listen()`; `src/worker.ts` calls `NestFactory.createApplicationContext(WorkerModule)` and never calls `.listen()`. Both `AppModule` and `WorkerModule` import the same `ScanModule`.
**When to use:** Any Nest app that needs an HTTP-facing process and a background-processing process sharing domain/service code without duplicating it.
**Example:**
```typescript
// src/index.ts — Source: docs.nestjs.com/techniques/performance (WebFetch, official docs mirror)
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();
```
```typescript
// src/worker.ts — Source: docs.nestjs.com/application-context (WebFetch, official docs mirror)
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  // No app.listen(), no app.close() here — the process stays alive
  // until enableShutdownHooks' SIGTERM/SIGINT handling triggers teardown.
}
bootstrap();
```
**Critical caveat verified via official docs:** a standalone application-context app "does not have any network listeners, so any Nest features related to HTTP (e.g., middleware, interceptors, pipes, guards, etc.) are not available in this context" — confirms D-06's requirement that `WorkerModule` must never import an HTTP/GraphQL module; doing so wouldn't just waste heap, decorators tied to HTTP request lifecycle silently do nothing in this mode.

### Pattern 2: Boot-time fail-fast env validation

**What:** `ConfigModule.forRoot({ validationSchema: Joi.object({...}) })` imported once inside `ScanModule` (or a small `AppConfigModule` wrapper both `AppModule`/`WorkerModule` import) validates `process.env` synchronously during module instantiation.
**When to use:** Always, per OPS-03 — both entrypoints must refuse to boot on invalid config.
**Example:**
```typescript
// src/config/env.validation.ts — Source: docs.nestjs.com/techniques/configuration (WebFetch, official docs mirror)
import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().port().default(3000),
  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().port().required(),
  SCAN_TMP_DIR: Joi.string().required(),
  TRIVY_MODE: Joi.string().valid('binary', 'docker').default('binary'),
});
```
```typescript
// app.module.ts / worker.module.ts (both import this the same way)
import { ConfigModule } from '@nestjs/config';
import { envValidationSchema } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      // validationOptions defaults: allowUnknown: true, abortEarly: false
    }),
    ScanModule,
  ],
})
export class AppModule {}
```
**Verified failure behavior:** per official docs, "the validation step will throw an exception if we don't provide the variable in the environment" — this exception is thrown synchronously during `NestFactory.create(...)`/`createApplicationContext(...)`, before `bootstrap()`'s promise resolves. An unhandled rejection at the top level of a Node script terminates the process with a non-zero exit code and prints the Joi error message to stderr by default — no extra `try/catch`+`process.exit(1)` wiring is required to satisfy "refuses to run on invalid config," though wrapping in `try/catch` with an explicit `process.exit(1)` is recommended for a cleaner, more explicit log line (see Common Pitfalls).

### Pattern 3: `nest new` scaffold, then swap to Fastify

**What:** Run `nest new` (D-05) to get idiomatic file layout, then replace the Express platform package with Fastify and remove residual Express dependencies.
**Verified exact steps (Source: docs.nestjs.com/techniques/performance, WebFetch):**
```bash
npm uninstall @nestjs/platform-express
npm install @nestjs/platform-fastify
```
```typescript
// generated main.ts before -> after
- import { NestFactory } from '@nestjs/core';
- import { AppModule } from './app.module';
- const app = await NestFactory.create(AppModule);
+ import { NestFactory } from '@nestjs/core';
+ import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
+ import { AppModule } from './app.module';
+ const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
```
**Verify no residual Express deps (planner action item):** after the swap, run `npm ls express @types/express --workspace apps/api` (expect "not installed") and grep `apps/api/package.json`/`apps/api/src` for `express` — `nest new`'s default `package.json` only declares `@nestjs/platform-express` (no bare `express`) as a direct dep, so a plain uninstall is normally sufficient, but any hand-added Express middleware/types during scaffolding exploration should be caught by this grep.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Env validation | A custom `if (!process.env.X) throw` block per variable | `ConfigModule.forRoot({ validationSchema: Joi.object(...) })` | One schema, one fail-fast point, consistent error formatting, already the locked mechanism (OPS-03) |
| Graceful shutdown wiring | Manual `process.on('SIGTERM', ...)` handlers in each entrypoint | `app.enableShutdownHooks()` + Nest lifecycle hooks (`onModuleDestroy`/`onApplicationShutdown`) | Nest's own hook sequence is what later phases (Redis/BullMQ connection draining, ERR-05) will attach to — reinventing signal handling here creates two competing shutdown paths later |
| Multi-entry build wiring | A custom webpack/esbuild config to produce `dist/index.js` and `dist/worker.js` | Plain `tsc` (or `nest build`, which defaults to `tsc` under the hood unless `compilerOptions.webpack: true`) compiling the whole `src/**/*.ts` tree | Two independent `.ts` files at the top of `src/` each become their own `dist/*.js` output automatically under `tsc`'s default per-file emit — no bundler needed for a reviewer-run `node dist/index.js` |

**Key insight:** Every "hard" problem in this phase (fail-fast config, worker lifecycle, multi-entry build) already has a first-class Nest/tsc mechanism — the actual risk in this phase is entirely in the *toolchain version pinning* (TypeScript 6 vs 7), not in inventing new patterns.

## Common Pitfalls

### Pitfall 1: Installing TypeScript's `latest` tag (7.0.2) instead of the tooling-compatible 6.0.3

**What goes wrong:** `npm install typescript` (or `typescript@latest`, or an unpinned `^7` in a copy-pasted example) pulls TypeScript 7.0.2, the new Go-native compiler. `tsc --noEmit` may still appear to work standalone, but `typescript-eslint` (peer `>=4.8.4 <6.1.0`) and `ts-jest` (peer `>=4.3 <7`) will fail to install cleanly (npm peer-dep warnings) or, worse, silently mis-typecheck since TS7 doesn't yet expose the same programmatic compiler API those tools embed.
**Why it happens:** Training-data knowledge (and even same-day prior research in this project's own STACK.md) assumed TypeScript 5.9.x was current; TS7 shipped as `latest` on 2026-07-08, one day before this research.
**How to avoid:** Pin `"typescript": "6.0.3"` (or `"~6.0.3"`) explicitly in `apps/api/package.json`; never rely on an unpinned `^` that could float to 7.x once minor patches land, and never copy a `typescript@latest` install command into scripts/README.
**Warning signs:** `npm ls typescript` inside `apps/api` shows a `7.x` version; `npx tsc --version` prints `7.0.2`; ESLint errors about unsupported TypeScript version at lint time.
**Phase to address:** This phase, at the moment `typescript` is first added to `package.json` — the very first dependency pin decision in the project.

### Pitfall 2: `nest new`'s generated `tsconfig.json` ships `strict: false`

**What goes wrong:** The scaffolded `tsconfig.json` sets `strictNullChecks: false`, `noImplicitAny: false`, etc. — directly violating TYPE-01. If the planner only *adds* `noUncheckedIndexedAccess` on top of the generated file without also flipping `strict: true`, the tsconfig looks "strict-ish" but isn't.
**Why it happens:** NestJS CLI intentionally ships a looser default to ease onboarding for teams migrating from looser codebases; this is a known, discussed NestJS CLI behavior, not a bug.
**How to avoid:** Do not diff/patch the generated `tsconfig.json` — overwrite it wholesale with the strict block from Standard Stack/STACK.md, then re-run `tsc --noEmit` immediately after scaffolding (before writing any domain code) to confirm zero errors against the (currently empty) generated boilerplate.
**Warning signs:** `grep strictNullChecks apps/api/tsconfig.json` shows `false`; `tsc --noEmit` passes suspiciously easily on code that should trigger `noUncheckedIndexedAccess` errors.
**Phase to address:** This phase, immediately after `nest new` runs, before any other file is touched.

### Pitfall 3: Relying on `nest start --watch` / `nest-cli.json`'s single `entryFile` for a two-entrypoint layout

**What goes wrong:** `nest-cli.json`'s `entryFile` field (default `"main"`) and `nest start` assume exactly one bootstrap file. With two entrypoints (`index.ts`, `worker.ts`), `nest start`/`nest start --watch` only ever runs one of them, and a planner following typical single-entry NestJS tutorials may not realize the CLI's dev-server convenience doesn't cover the worker.
**Why it happens:** Every NestJS "getting started" tutorial and the CLI's own defaults assume one process; the two-entrypoint pattern (ARCH-04) is a deliberate deviation this project's own decision (D-06), not something `nest-cli.json` models natively.
**How to avoid:** Don't fight `nest-cli.json` — leave `entryFile` at its default (it's irrelevant once we stop using `nest start`) and instead define explicit `package.json` scripts: `"dev:api": "tsx watch src/index.ts"`, `"dev:worker": "tsx watch src/worker.ts"`, `"build": "tsc -p tsconfig.build.json"` (or `nest build` — equivalent since no webpack), `"start:api": "node dist/index.js"`, `"start:worker": "node dist/worker.js"`.
**Warning signs:** A README or npm script referencing bare `nest start` with no clear script for the worker; only one of `dist/index.js`/`dist/worker.js` exists after a build.
**Phase to address:** This phase, when writing `package.json` scripts.

### Pitfall 4: `apps/web` listed in root `workspaces` before it has a `package.json`

**What goes wrong:** If the root `package.json` sets `"workspaces": ["apps/*"]` while `apps/web/` exists as an empty directory (no `package.json`), npm's exact handling of that half-populated glob match is not authoritatively documented in the sources checked this session — behavior could range from silently skipping the directory to a confusing install-time warning.
**Why it happens:** D-01 anticipates `apps/web` structurally now but populates it only in Phase 6; it's tempting to write the "final" glob pattern immediately.
**How to avoid:** List `"workspaces": ["apps/api"]` explicitly (not a glob) in this phase; switch to `"apps/*"` or add `"apps/web"` explicitly in Phase 6 once that directory has a real `package.json`. This is a one-line, low-risk change to make later and removes any ambiguity now.
**Warning signs:** `npm install` at repo root prints an unexpected workspace-related warning; `npm ls --workspaces` lists an unexpected or missing member.
**Phase to address:** This phase (root `package.json` authoring) — revisit in Phase 6.

### Pitfall 5: Confusing "throws during bootstrap" with "the process actually exits non-zero"

**What goes wrong:** OPS-03 and the phase's Success Criteria #3 require a non-zero exit on invalid config. Nest's own Joi validation failure throws an exception inside `NestFactory.create(...)`/`createApplicationContext(...)`, which — if `bootstrap()` is called without a `.catch()` — becomes an unhandled promise rejection. Node's default behavior for unhandled rejections is version-dependent; without an explicit `try/catch` + `process.exit(1)`, the exit code and log clarity are less deterministic than the requirement implies ("clear Joi validation message" + a guaranteed non-zero code).
**Why it happens:** The docs example (`bootstrap()` with no `.catch()`) is optimized for readability, not for a graded "boots cleanly / exits non-zero" test harness.
**How to avoid:** Wrap both entrypoints' `bootstrap()` calls in an explicit handler: `bootstrap().catch((err) => { console.error(err); process.exit(1); });` — this guarantees both a printed Joi message and a deterministic non-zero exit code, satisfying Success Criteria #3 literally rather than relying on Node's default unhandled-rejection behavior.
**Warning signs:** Manually testing with a missing required env var produces exit code `0` or an ambiguous stack trace instead of a clear Joi message.
**Phase to address:** This phase — write this exact pattern into both `src/index.ts` and `src/worker.ts` from the start.

## Code Examples

### Full env-validated, dual-entrypoint bootstrap (composite of verified patterns above)

```typescript
// src/index.ts
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

```typescript
// src/worker.ts
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  // Long-lived: no .listen(), no .close() — process exits only via
  // enableShutdownHooks' signal handling once BullMQ is wired in (Phase 3).
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### Domain types skeleton (TYPE-02, D-03, D-04)

```typescript
// src/domain/scan.types.ts
export enum ScanStatus {
  Queued = 'Queued',
  Scanning = 'Scanning',
  Finished = 'Finished',
  Failed = 'Failed',
}

export interface Scan {
  id: string;
  status: ScanStatus;
  repoUrl: string;
  vulnerabilities?: Vulnerability[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// src/domain/vulnerability.types.ts
export interface Vulnerability {
  vulnerabilityId: string;
  pkgName: string;
  installedVersion: string;
  severity: 'CRITICAL';
  title: string;
  primaryUrl: string;
}

// src/domain/trivy-report.types.ts — minimal, per D-04 (only the path actually parsed)
export interface TrivyReport {
  Results?: TrivyResult[];
}

export interface TrivyResult {
  Target: string;
  Vulnerabilities?: TrivyVulnerability[];
}

export interface TrivyVulnerability {
  VulnerabilityID: string;
  PkgName: string;
  InstalledVersion: string;
  Severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  Title: string;
  PrimaryURL: string;
}
```

## State of the Art

| Old Approach (training-data assumption) | Current Approach (verified 2026-07-09) | When Changed | Impact |
|--------------|------------------|--------------|--------|
| TypeScript 5.9.x is "current stable" (this project's own STACK.md/PROJECT.md, one day old) | TypeScript 7.0.2 is npm's `latest` tag; 6.0.3 is the actual tooling-compatible stable | TS7 released 2026-07-08 (per official TypeScript devblog "Announcing TypeScript 7.0") | Must pin `typescript@6.0.3` explicitly — a bare `latest`/`^7` install breaks `typescript-eslint` and `ts-jest` peer resolution immediately |
| ESLint config via `.eslintrc.js` | ESLint 9/10 flat config (`eslint.config.mjs`), using the unified `typescript-eslint` package rather than separate `@typescript-eslint/parser` + `@typescript-eslint/eslint-plugin` | ESLint 9 (flat config default) shipped 2024; NestJS's own `nest new` template and `nestjs/nest`'s own `eslint.config.mjs` confirm this is now the CLI default | Planner should expect/author `eslint.config.mjs`, not `.eslintrc.js`, when `nest new` scaffolds |

**Deprecated/outdated:**
- TypeScript 5.9.x as a "current" pin for a project starting fresh in July 2026 — it's not wrong to use, but 6.0.3 is the actual current stable and carries the same strict-flag feature set (`noUncheckedIndexedAccess`, `verbatimModuleSyntax` are both available since 5.x and remain in 6.x).
- `.eslintrc.js`-based ESLint config for a fresh `nest new` scaffold in 2026.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | npm silently skips a `workspaces` glob-matched directory that lacks a `package.json` (rather than erroring) | Pitfall 4 / Alternatives Considered | Low — mitigated by sidestepping the glob entirely and listing `apps/api` explicitly this phase; only matters if the planner chooses the glob form anyway |
| A2 | Node's default unhandled-rejection behavior would not reliably satisfy "clear message + non-zero exit" without an explicit `.catch()` + `process.exit(1)` | Pitfall 5 | Low-medium — worst case the explicit `.catch()` pattern is simply defensive/redundant; it is never harmful to include it |
| A3 | Joi v18's array-typing change and CIDR-validation change do not affect this project's schema (`.object/.string/.number/.valid/.default/.required/.port` only) | Standard Stack (joi row) | Low — these are the only Joi methods this phase's schema needs; confirmed no deprecation notice against them in the v18 changelog summary found |

**If this table is empty:** N/A — see entries above; all three are low-risk, defensively-handled, or easily re-verified with a one-line grep/test during planning.

## Open Questions

1. **Should `ts-jest` or `@swc/jest` be the actual Jest transform for this phase's (minimal) tests?**
   - What we know: Both are peer-compatible with TypeScript 6.0.3; CONTEXT.md's discretion note prefers `@swc/jest` for speed.
   - What's unclear: `@swc/jest` skips type-checking during test transform, meaning a test file with a type error could still run — TYPE-01's "zero `tsc --noEmit` errors" gate is the actual enforcement point, so this is likely fine, but the planner should make explicit that `tsc --noEmit` (not the test runner) is the type-safety gate.
   - Recommendation: Use `@swc/jest` per CONTEXT.md discretion; add a CI/verification step note that `tsc --noEmit` runs independently of `npm test`.

2. **Exact required env var list beyond the minimum CONTEXT.md names (`REDIS_HOST`, `REDIS_PORT`, `PORT`, a workspace/temp dir, Trivy-mode toggle)?**
   - What we know: CONTEXT.md leaves this to planner discretion; later phases (3, 4) will need `REDIS_HOST`/`REDIS_PORT` for BullMQ/ioredis and a temp-dir base for `RepoCloner`.
   - What's unclear: Whether to require these now (Phase 1) even though nothing consumes them yet, versus a minimal Phase-1-only schema (`PORT`, `NODE_ENV`) extended in Phase 3/4.
   - Recommendation: Define the full Joi schema now (all names CONTEXT.md lists) even though only `PORT`/`NODE_ENV` are consumed by Phase-1 skeleton code — this proves the fail-fast mechanism end-to-end against the real eventual env surface and avoids a schema-migration task later. Provide a `.env.example` with all keys and safe local defaults (`REDIS_HOST=localhost`, `REDIS_PORT=6379`, `SCAN_TMP_DIR=/tmp/scans`, `TRIVY_MODE=binary`) so `docker-compose`/local dev isn't blocked before Phase 3 exists.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TYPE-01 | `tsconfig` is strict (`strict: true`, `noUncheckedIndexedAccess`) and codebase has no `any` on scan-result handling paths | Standard Stack tsconfig block (inherited from STACK.md, re-confirmed valid under TS 6.0.3); Pitfall 2 documents that `nest new`'s generated tsconfig defaults to non-strict and must be overwritten, not patched |
| TYPE-02 | Trivy report shapes and domain models (`Scan`, `Vulnerability`, status enum) expressed as explicit TS types/interfaces | Code Examples > Domain types skeleton; D-03/D-04 locked decisions (framework-free interfaces, minimal Trivy shape) directly implemented |
| ARCH-04 | Two entrypoints sharing one `ScanModule`: `src/index.ts` (API, HTTP) and `src/worker.ts` (worker-only, `createApplicationContext`, no HTTP listener) | Architecture Patterns > Pattern 1 (verified `NestFactory.create`/`createApplicationContext` signatures via official docs mirror); System Architecture Diagram |
| OPS-03 | `.env` schema-validated at boot (Joi via `@nestjs/config`); app refuses to start on invalid/missing config | Architecture Patterns > Pattern 2 (verified `ConfigModule.forRoot({validationSchema})` behavior + failure semantics); Pitfall 5 (guaranteeing non-zero exit) |
</phase_requirements>

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No | Out of scope for this project (REQUIREMENTS.md "Out of Scope") |
| V3 Session Management | No | No sessions exist in this phase |
| V4 Access Control | No | No access-controlled resources exist in this phase (skeleton only) |
| V5 Input Validation | Yes | Boot-time env validation via Joi (`ConfigModule.forRoot({validationSchema})`) is this phase's only input-validation surface — request-body validation (`class-validator`/`ValidationPipe`) is Phase 4's concern, not this phase's |
| V6 Cryptography | No | No secrets/crypto handled directly by this phase's code (env values are read, not encrypted/decrypted here) |
| V14 Configuration | Yes | Fail-closed config validation (OPS-03) is itself an ASVS V14.1-aligned control — refusing to boot on missing/invalid required config is the standard mitigation for "insecure default configuration" |

### Known Threat Patterns for this stack (this phase's surface only)

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| App boots successfully with missing/malformed required config (e.g., missing `REDIS_HOST`), silently degrading into an unsafe default | Tampering / Denial of Service (deferred failure) | Joi `validationSchema` with `.required()` on every security/connectivity-relevant key; no `Joi.string().optional()` fallback for connection-critical vars; verified Nest throws synchronously on violation (Pattern 2 above) |
| Env values logged in cleartext during a validation-failure stack trace (e.g., a future `REDIS_PASSWORD` appearing in an uncaught Joi error message) | Information Disclosure | Not yet a concern this phase (no secret-shaped env vars defined yet), but flag for Phase 3/4 planner: when secret-bearing keys (Redis auth, etc.) are added to the schema, ensure error logging doesn't echo raw values — Joi's default error message includes the *key name* but not necessarily the *value* for `.required()` failures; verify this holds once secret keys exist |

## Sources

### Primary (MEDIUM confidence — official docs content, fetched via WebFetch against the docs' own GitHub-hosted markdown source; Context7 MCP was not exposed as a callable tool this session, so provider-tier classification is LOW per the confidence seam even though content is official-docs-sourced)
- `raw.githubusercontent.com/nestjs/docs.nestjs.com/master/content/techniques/performance.md` — Fastify adapter swap steps, `NestFactory.create<NestFastifyApplication>` signature
- `raw.githubusercontent.com/nestjs/docs.nestjs.com/master/content/application-context.md` — `NestFactory.createApplicationContext`, unavailable-features list, close/lifecycle behavior
- `raw.githubusercontent.com/nestjs/docs.nestjs.com/master/content/techniques/configuration.md` — `ConfigModule.forRoot({validationSchema})`, `validationOptions` defaults, `expandVariables`
- `raw.githubusercontent.com/nestjs/docs.nestjs.com/master/content/fundamentals/lifecycle-events.md` — `enableShutdownHooks()`, SIGTERM/SIGINT hook ordering, Windows caveat

### Secondary (verified via direct tool call — `npm view`, live registry, HIGH-reliability data source despite LOW provider-tier tag from the confidence seam)
- `npm view <pkg> version` / `dist-tags` / `peerDependencies` / `dependencies` / `scripts.postinstall` for: `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-fastify`, `@nestjs/config`, `@nestjs/cli`, `@nestjs/schematics`, `@nestjs/testing`, `joi`, `typescript` (incl. full `versions` list confirming 6.0.3 → 7.0.1-rc → 7.0.2 → 7.1.0-dev sequence), `rxjs`, `reflect-metadata`, `jest`, `@swc/jest`, `eslint`, `typescript-eslint`, `prettier`, `@types/node`, `tsx`, `class-validator`, `class-transformer`, `fastify`
- `gsd-tools query package-legitimacy check` — verdicts for all packages in Package Legitimacy Audit

### Tertiary (LOW confidence — WebSearch synthesis, cross-referenced against the primary/secondary sources above where possible)
- WebSearch: "TypeScript 7.0 native compiler stability recommendation production use 2026" — corroborates that TS7's RC/GA messaging itself describes the programmatic API as not-yet-stable, matching the `ts-jest`/`typescript-eslint` peer-range evidence from `npm view`
- WebSearch: "nest new eslint.config.mjs flat config" — corroborated by inspecting `nestjs/nest`'s own `eslint.config.mjs` existing in its repo (per search result title), not independently fetched this session
- WebSearch: "Joi v18 breaking changes changelog" — used only to confirm no impact on this phase's specific Joi method usage; full joi.dev changelog not independently fetched
- WebSearch: "npm workspaces glob pattern folder without package.json ignored" — inconclusive; treated as Assumption A1, mitigated by avoiding the glob form this phase

## Metadata

**Confidence breakdown:**
- Standard stack (package versions/compatibility): HIGH-equivalent evidence (live `npm view` + peer-dependency ranges are directly verifiable facts), tagged MEDIUM overall per the confidence seam's provider-tier rules since Context7 was unavailable
- Architecture (two-entrypoint bootstrap, Joi validation, shutdown hooks): MEDIUM — verified against official docs content (via WebFetch, not Context7), single-source per topic but each is Nest's own canonical documentation page
- Pitfalls: MEDIUM-HIGH for the TypeScript-version and strict-tsconfig-default pitfalls (directly reproduced via `npm view`/well-known NestJS CLI behavior); LOW-MEDIUM for the npm-workspaces-glob pitfall (unverified, flagged as Assumption A1)

**Research date:** 2026-07-09
**Valid until:** 7 days for the TypeScript-version finding specifically (this ecosystem corner is moving fast post-TS7-release — re-run `npm view typescript-eslint peerDependencies` and `npm view ts-jest peerDependencies` before finalizing `package.json` if planning happens more than a few days after this research); 30 days for the rest (standard NestJS API surface, stable)

---
*Phase 1 research for: Code Guardian — Supply Chain Scanner*
*Researched: 2026-07-09*
