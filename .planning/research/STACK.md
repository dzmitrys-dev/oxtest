# Stack Research

> **⚠ STACK DECISION UPDATE (2026-07-09 — user chose NestJS; supersedes the Fastify-first recommendation below):**
> Framework is **NestJS 11 on the Fastify adapter**. NestJS's Module/Controller/Provider model *is* the graded Controller/Service/Worker separation (framework-enforced, reviewer-legible); DI shares one `ScanService` across REST + GraphQL + worker. A lean single-module NestJS idles ~35–60MB RSS — acceptable within 200MB container / 150MB heap. Memory pass/fail is still decided by the stream-json `Pick`+`streamArray` strategy, not the framework.
> Packages: `@nestjs/core`/`@nestjs/common` 11.1.x, `@nestjs/platform-fastify` 11.1.x, `@nestjs/graphql` 13.x + `@nestjs/mercurius` (MercuriusDriver, code-first `autoSchemaFile`), `@nestjs/bullmq` 11.0.x (`@Processor`+`WorkerHost`, `concurrency:1`), `bullmq` 5.79.x, `ioredis` 5.11.x, `stream-json` 3.4.x, `execa`, `@nestjs/config`+Joi, `ValidationPipe`+class-validator, Jest+`@swc/jest`.
> Two entrypoints share `ScanModule`: `src/index.ts` (API, `NestFactory.create`+`listen`, emits `dist/index.js` to match the self-test) and `src/worker.ts` (`createApplicationContext`, no HTTP, boots `@Processor`). Worker must NOT import GraphQL. Pass `--max-old-space-size=150` explicitly in the worker `CMD` (V8 ignores cgroup at 200m). All stream-json/BullMQ/Trivy/tsconfig detail below stays valid — the HTTP framework wrapper is the only thing that changed.

**Domain:** Memory-constrained Node.js/TypeScript async security-scanner wrapper (Trivy wrapper, senior backend take-home)
**Researched:** 2026-07-09
**Confidence:** MEDIUM (web-search cross-checked across multiple independent sources; Context7 MCP was unavailable in this research session — pin exact versions against `npm view <pkg> version` at `npm install` time before submission)

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|------------------|
| Node.js | 20 LTS or 22 LTS | Runtime | Required for Fastify v5; Node 20+ is container-memory-aware (auto-derives V8 heap ceiling from cgroup limits), which directly matters for this assignment's memory constraint |
| TypeScript | 5.9.x | Language | Current stable; `verbatimModuleSyntax`, `noUncheckedIndexedAccess` (used below) require 5.x |
| Fastify | 5.10.0 | HTTP framework (REST) | 30-40% higher throughput than Express (15-18k vs 10-12k req/s); built-in JSON Schema validation, first-class TypeScript typings, low overhead — critical when every MB of RSS counts under a 200MB container. Plugin/encapsulation model gives you Controller (route plugin) / Service (plain class/module) / Worker (BullMQ) separation for free, without NestJS's DI-container memory tax |
| Mercurius | 16.9.0 | GraphQL layer (Bonus B) | Fastify-native GraphQL adapter — registers as a Fastify plugin (`fastify.register(mercurius, {...})`) on the **same HTTP server/port** as REST. This is the deciding factor: it lets REST and GraphQL share one process and one Service layer, with zero second-server memory overhead. Ships graphql-jit compilation (fastest of the three major options in benchmarks) |
| BullMQ | 5.79.3 | Background job queue | Production-grade: retries, concurrency control, restart survival (jobs persist in Redis) — exactly what the assignment's "Clean Controller/Service/Worker separation" and "restart survival" criteria call for |
| ioredis | 5.11.1 | Redis client (BullMQ's required client) | BullMQ's documented/required connection library; `new Redis()` or `import { Redis } from 'ioredis'` (ESM-friendly since v5) |
| stream-json | 1.9.1 | Streaming JSON parser (CRITICAL vuln extraction) | `pick` filter + `streamArray` lets you descend directly into `Results[].Vulnerabilities` and stream out one vulnerability object at a time — bytes for non-matching branches are **never assembled into memory**. This is the most surgical fit for "filter Severity==CRITICAL out of a 500MB nested array" and satisfies the "no `fs.readFile`/`JSON.parse`" constraint directly |
| stream-chain | 1.0.x (stream-json's own dependency) | Pipeline composition | `chain([...])` wires `createReadStream → parser() → pick() → streamArray() → filter-fn` into one pipeline with automatic backpressure propagation end-to-end — this backpressure guarantee is what keeps RSS flat regardless of input file size |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| execa | 9.x (latest) | Shelling out to `git clone` and `trivy` | Always — promise-based API, automatically escapes/quotes each argv entry (critical: user-supplied repo URL must be passed as a discrete array element, never interpolated into a shell string, to close the command-injection hole) |
| @fastify/cors | latest 9.x/10.x | CORS for the Bonus React frontend polling the API | If serving the React app from a different origin/port than the API in dev |
| pino | bundled with Fastify (Fastify's default logger) | Structured logging | Always — Fastify ships pino by default; low overhead, JSON logs pair naturally with "Trivy failed / disk full / clone failed" error-handling criteria |
| zod (or Fastify's native JSON Schema) | 3.x / 4.x | Request validation + typed Trivy report interfaces | Validate `POST /api/scan` body (repo URL shape) and optionally derive/validate the parsed Trivy vulnerability shape at the stream boundary, reinforcing the "no `any`" requirement |
| vitest | 3.x (latest) | Test framework | Always — see rationale below vs Jest |
| tsx | latest 4.x | Dev-time TS execution / watch mode | `tsx watch src/index.ts` for local dev loop; not used in the shipped `dist/index.js` |
| Vite | 6.x/7.x (latest) | React frontend build tool (Bonus A) | Scaffold via `npm create vite@latest <name> -- --template react-ts` — zero-config, esbuild dev server, Rollup prod build; the leanest possible setup for a tiny 2s-polling status UI |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| tsc (`tsc --noEmit` for checking, `tsc` for build) | Type-checking + build | tsc remains the only tool that actually type-checks; for a deployed service reviewed via `node dist/index.js`, a plain `tsc` build (not tsup) is the leaner, more transparent choice — no bundler magic for a reviewer to untangle |
| ESLint + `@typescript-eslint` (strict-type-checked config) | Lint | Pairs with strict tsconfig below to enforce "no `any`" mechanically, not just by promise |
| Docker + docker-compose | Packaging (Bonus C) | `mem_limit: 200m` on the app service; Redis service alongside with its own conservative `mem_limit` |
| Vitest UI / `vitest --coverage` | Test running + coverage | Fast enough to run the memory self-test suite plus unit tests in the same CI step |

## Installation

```bash
# Core
npm install fastify mercurius graphql bullmq ioredis stream-json stream-chain execa

# Supporting
npm install zod @fastify/cors pino-pretty

# Dev dependencies
npm install -D typescript tsx vitest @types/node eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser
```

React frontend (separate `client/` workspace):
```bash
npm create vite@latest client -- --template react-ts
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|--------------|-------------|--------------------------|
| Fastify | NestJS | If the grader explicitly values framework-enforced DI/module conventions over raw memory footprint, or if the team already standardizes on NestJS — but NestJS's per-instance memory/CPU overhead works against a 200MB container ceiling, and its DI ceremony obscures the Controller/Service/Worker separation rather than showcasing it |
| Fastify | Express | Only if reviewer familiarity with Express is a stated concern; otherwise Express's lower throughput and lack of built-in schema validation offer no upside here |
| Mercurius | graphql-yoga | If you want a framework-agnostic GraphQL layer that could later run standalone (Cloudflare Workers, Deno, etc.) — graphql-yoga is the more "generic" 2026 default (~700k weekly downloads vs Mercurius's ~400k) but requires either its own HTTP handler mounted as a Fastify route or a second listener, adding complexity/memory this project doesn't need |
| stream-json | bfj | If you need `walk`/`match`'s async-yielding SAX-style API for arbitrary unknown JSON shapes without a fixed schema — but bfj is explicitly documented as not optimized for speed, and stream-json's `pick`+`streamArray` is the more surgical, more commonly cited pattern for "filter one field out of a huge known-shape array" |
| BullMQ in-process Worker | Sandboxed processors (separate process/Worker Threads) | If Trivy scanning itself became CPU-bound inside the Node process — it isn't; Trivy runs as an external binary via `execa`, so the Node-side work (spawn + stream-parse) is I/O-bound and doesn't need process isolation. Reserve sandboxing for future CPU-heavy in-process transforms |
| execa | raw `child_process.spawn` | If you want zero dependencies — but you then must hand-roll argv escaping and promise-wrapping, reintroducing the injection risk execa closes by default |
| Vitest | Jest | Only if the target environment is React Native (not the case here) — Jest 30 narrowed the gap but keeps a CJS-first architecture and slower cold starts/watch mode vs Vitest's native ESM pipeline |
| tsc build | tsup / esbuild bundling | If you needed a single bundled `dist/index.js` with no `node_modules` dependency tree (e.g., for serverless) — this assignment's reviewer runs `node dist/index.js` from a full repo checkout, so a straightforward multi-file `tsc` output is simpler to audit and debug than a bundled artifact |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|--------------|
| `fs.readFile()` + `JSON.parse()` on the Trivy report | Explicitly forbidden by the assignment; also the literal cause of the OOM the whole exercise is testing for — loading a 500MB string into a V8 string/object graph blows a 150MB heap immediately | `stream-json`'s `chain([createReadStream, parser(), pick(...), streamArray(), ...])` pipeline |
| NestJS for this specific assignment | Heavier per-instance memory/CPU footprint than Fastify; DI container adds indirection that can make "explain every solution in What/Why/How" harder for a reviewer skimming the repo, and works against the memory-efficiency grading criterion | Fastify with a hand-rolled `controllers/`, `services/`, `workers/` folder structure |
| Apollo Server (bare, without Fastify integration) | Heaviest of the three GraphQL options, increasingly wrapped into Apollo's managed-platform ecosystem; running it standalone means a second HTTP listener alongside Fastify, doubling baseline memory overhead for a "Bonus" feature | Mercurius (Fastify-native plugin, one process) |
| `bull` (v3, the predecessor to BullMQ) | Deprecated/legacy; lacks BullMQ's TypeScript-first API, sandboxed-processor model, and active maintenance | `bullmq` |
| ts-node for the shipped runtime | Slower startup than `tsx`/pre-built `dist`, and mixing it into production entrypoints is an outdated (~2022-era) pattern | `tsc` build for production, `tsx` only for local dev iteration |
| Manually building shell command strings (`child_process.exec('git clone ' + url)`) | Direct command-injection vector — a malicious/malformed repo URL string could inject shell metacharacters; also exactly the kind of finding a senior-level reviewer will look for in "robust error handling" | `execa('git', ['clone', repoUrl, dest])` — argv array, never a shell string |
| JSONStream (older streaming JSON lib) | Superseded by `stream-json`/`stream-chain`, less actively maintained, smaller/older filter API | `stream-json` |

## Stack Patterns by Variant

**If GraphQL must be fully decoupled from Fastify (e.g., future migration to a different HTTP layer):**
- Use graphql-yoga instead of Mercurius
- Because it's framework-agnostic and portable, at the cost of running as its own mounted handler rather than a native plugin

**If Trivy scanning were CPU-bound inside Node (it currently is not — Trivy runs as an external process):**
- Use BullMQ sandboxed processors (`Worker Threads` or spawned child processes)
- Because isolating CPU-heavy work prevents it from stalling the event loop and triggering BullMQ's stalled-job detection

**If the reviewer's environment lacks a local Trivy binary:**
- Fall back to invoking Trivy via its official Docker image (`docker run aquasec/trivy ...`) through the same `execa` call
- Because this matches the project's own key decision ("auto-detect local binary, fall back to Docker image") and keeps the CLI-shelling code path uniform

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|------------------|-------|
| bullmq@5.79.3 | ioredis@5.11.1 | Any ioredis connection passed into a `Worker` **must** set `maxRetriesPerRequest: null` — BullMQ uses blocking `BLPOP`; without this, ioredis throws on blocked commands. This is a well-documented breaking gotcha, not optional config |
| fastify@5.10.0 | mercurius@16.9.0, graphql (peer dep) | Mercurius v16.x targets Fastify v5; confirm `graphql` peer dependency version compatibility (`graphql@16.x`) when installing |
| typescript@5.9.x | `verbatimModuleSyntax` + `module: NodeNext` | Must be paired together — `verbatimModuleSyntax` alone doesn't fix ESM/CJS import syntax without `moduleResolution: NodeNext` |
| stream-json@1.9.1 | stream-chain (installed as its dependency, but import explicitly if composing custom pipelines) | Both are zero-dependency, from the same author (`uhop`); versions move in lockstep in practice |
| vite@6.x/7.x | react-ts template | The `--template react-ts` scaffold matches whatever Vite major is current at `npm create vite@latest` time — pin the generated `package.json` versions, don't hand-pick |

## Recommended tsconfig (strict)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```
This directly reinforces the assignment's "strict TypeScript, no `any`" grading criterion — `noUncheckedIndexedAccess` in particular forces explicit handling when indexing into parsed Trivy report arrays/objects.

## Trivy CLI Reference (verified via official docs)

```bash
# Scan an already-cloned local directory
trivy fs --format json --output result.json <path>

# Scan a remote repo directly (Trivy clones it internally) — alternative to manual git clone + fs scan
trivy repo --format json --output result.json <git-url>
```
Short flags: `-f/--format`, `-o/--output`.

**JSON report shape** (relevant subset):
```
{
  "Results": [
    {
      "Target": "<string>",
      "Vulnerabilities": [
        {
          "VulnerabilityID": "<string>",
          "PkgName": "<string>",
          "InstalledVersion": "<string>",
          "FixedVersion": "<string>",
          "Title": "<string>",
          "Description": "<string>",
          "Severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN",
          "References": ["<string>", ...]
        }
      ]
    }
  ]
}
```
This maps directly onto a `stream-json` pipeline: `pick({ filter: 'Results' })` → `streamArray()` on each Result → nested `pick`/`streamArray` (or a custom transform function) on that Result's `Vulnerabilities` array → filter where `Severity === 'CRITICAL'`.

## Sources

- npm registry / GitHub releases for Fastify, Mercurius, BullMQ, ioredis, stream-json, bfj version numbers — MEDIUM confidence (cross-checked across 2-3 independent search results per package; websearch provider tier)
- fastify.dev official TypeScript reference — MEDIUM confidence
- uhop/stream-json GitHub README + Wiki (StreamArray, pick filter) — MEDIUM confidence, official repo source
- philbooth/bfj GitHub README + npm page — MEDIUM confidence, official repo source
- docs.bullmq.io (Concurrency, Sandboxed processors, Connections pages) — MEDIUM confidence, official docs
- trivy.dev official docs (`trivy_filesystem`, `trivy_repository` CLI reference pages) — MEDIUM confidence, official docs
- the-guild.dev/graphql/yoga-server comparison page + mercurius.dev — MEDIUM confidence
- vite.dev Getting Started guide — MEDIUM confidence, official docs
- goldbergyoni/nodebestpractices (docker/memory-limit.md) — MEDIUM confidence, widely-cited community reference
- General web search synthesis on Fastify/Express/NestJS benchmarks, Vitest vs Jest 2026, tsconfig strict defaults, execa vs child_process — LOW-MEDIUM confidence (aggregated blog/community sources dated 2025-2026; version-sensitive claims should be spot-checked against `npm view` at install time)
- **Note:** Context7 MCP tool was not available in this research session (tool registration error); all "docs" kind questions were answered via WebSearch fallback instead. Recommend a quick `npm view <pkg> version` pass before finalizing `package.json` to confirm exact current versions have not shifted.

---
*Stack research for: memory-constrained Node.js/TypeScript async security-scanner wrapper service*
*Researched: 2026-07-09*
