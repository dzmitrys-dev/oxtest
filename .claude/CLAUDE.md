<!-- GSD:project-start source:PROJECT.md -->

## Project

**Code Guardian — Supply Chain Scanner**

A high-performance Node.js/TypeScript backend service that wraps the Trivy security scanner: submit a GitHub repository URL, get an async scan that clones the repo, runs Trivy, and stream-parses massive (500MB+) JSON reports to extract CRITICAL vulnerabilities — all inside a 256MB RAM constraint. Built as a senior backend engineer take-home assignment where the deliverable is a best-in-class public GitHub repo plus an interview-prep onboarding document explaining every solution in "What, why, how" form.

**Core Value:** The service must process a 500MB+ Trivy JSON report without OOM under `node --max-old-space-size=150` — memory efficiency is the explicit pass/fail criterion; everything else is quality signal on top.

### Constraints

- **Memory**: 256MB RAM assumption; self-test at 150MB heap; Docker `mem_limit: 200m` — the defining constraint of the whole design
- **Forbidden APIs**: `fs.readFile` and `JSON.parse` on scan results — must use Node.js streams (stream-json or bfj)
- **Tech stack**: NestJS 11 (TypeScript) on the Fastify adapter — Module/Controller/Provider model directly demonstrates the graded Controller/Service/Worker separation; `@nestjs/bullmq` for the queue, code-first GraphQL via MercuriusDriver, stream-json for parsing. API entry named `src/index.ts` → `dist/index.js` to match the assignment's self-test command verbatim.
- **Timeline**: 2–3 days to submission
- **Runnability**: Reviewer must be able to run everything from README alone — docker-compose path must work end-to-end

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

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

# Core

# Supporting

# Dev dependencies

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

- Use graphql-yoga instead of Mercurius
- Because it's framework-agnostic and portable, at the cost of running as its own mounted handler rather than a native plugin
- Use BullMQ sandboxed processors (`Worker Threads` or spawned child processes)
- Because isolating CPU-heavy work prevents it from stalling the event loop and triggering BullMQ's stalled-job detection
- Fall back to invoking Trivy via its official Docker image (`docker run aquasecurity/trivy:0.69.3 ...`) through the same `execa` call
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

## Trivy CLI Reference (verified via official docs)

# Scan an already-cloned local directory

# Scan a remote repo directly (Trivy clones it internally) — alternative to manual git clone + fs scan

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

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
