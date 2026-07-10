# ONBOARDING — Code Guardian, explained

This is the interview-prep companion to [README.md](./README.md). The README tells
you how to **run** the service; this document explains **why every solution is the
way it is**. Each topic follows the same shape:

- **What** — the solution, in one or two sentences.
- **Why** — the reasoning and the constraint it serves.
- **How** — where it lives in the code and how it works.
- **A reviewer might ask…** — the sharp question a skeptical senior reviewer would
  actually raise, answered honestly.
- **Rejected alternatives / trade-offs** — what we deliberately did *not* do.

The single organizing constraint behind almost every decision: **memory efficiency
is the graded pass/fail axis** — process a 500MB+ Trivy report without OOM under
`node --max-old-space-size=150`. Everything else is quality signal layered on top.

---

## 1. Memory strategy — the pass/fail axis

**What.** The service processes a 500MB+ Trivy JSON report while peak RSS stays
**flat** and V8 old-space stays under a hard **150MB** heap cap. Memory does not
scale with input size.

**Why.** The assignment grades memory management first and pass/fail: loading a
500MB report into a V8 string/object graph blows a 150MB heap instantly. The whole
architecture is bent around never holding the report in memory.

**How.** The report is consumed by a streaming pipeline (topic 2) that yields one
vulnerability object at a time via an async generator, so there is never an
accumulator that grows with input. A memory self-test (`npm run memtest
--workspace apps/api`) drains the parser against a 500MB fixture under
`--max-old-space-size=150`, sampling `process.memoryUsage()` on an interval and
asserting **peak** RSS (not a final reading) stays in a flat band. A sweep
(`memtest:sweep`) runs 50MB → 1GB and asserts the band stays constant.

**A reviewer might ask…**
- *"`--max-old-space-size` only caps V8 old-space heap — what about off-heap
  Buffers?"* Correct, and that is exactly why the self-test samples **`rss`,
  `heapUsed`, AND `external`**, not just `heapUsed`. Stream buffers live off-heap;
  a heap-only assertion would miss a real RSS spike. The threshold is on peak RSS.
- *"Why prove the parser standalone instead of end-to-end?"* Memory is won or lost
  in the parser, so it was built and gated **in isolation before any queue/HTTP/
  Trivy plumbing existed** — a regression surfaces immediately, not at submission.

**Rejected alternatives / trade-offs.** Running on Bun was rejected:
`--max-old-space-size` is a V8-only flag, so Bun would silently disable the exact
heap gate this project exists to prove (Phase 1). Raising `mem_limit` to make
headroom was rejected in favor of *lowering* the heap flag if RSS creeps — the
point is to keep proving the constraint, not to escape it.

---

## 2. Streaming & backpressure — how the 500MB never lands in memory

**What.** A `stream-json` pipeline reads the report as bytes, descends directly to
the leaf vulnerability objects, filters `Severity === 'CRITICAL'`, maps each to the
domain `Vulnerability` shape, and yields it — one object at a time.

**Why.** This is the mechanism behind topic 1 and it directly satisfies the
assignment's hard prohibition: **no `fs.readFile` / `JSON.parse` on the scan
report.** Backpressure through the pipeline keeps RSS flat regardless of file size.

**How.** `apps/api/src/parser/report-parser.ts` exposes
`async *parse(reportPath): AsyncIterable<Vulnerability>`. The pipeline is:

```
chain([ fs.createReadStream(path), parser(),
        pick({ filter: /^Results\.\d+\.Vulnerabilities\.\d+$/ }),
        streamValues(), <filter CRITICAL>, <map to Vulnerability>, yield ])
```

An async generator *structurally* guarantees "at most one vulnerability in memory"
— it yields, then suspends; it cannot silently accumulate. `stream-chain`
propagates backpressure end-to-end. Pinned `stream-json@2.1.0` + `stream-chain@3.6.3`
(the last CJS releases; v3 of stream-json is ESM-only and breaks the
`module: commonjs` tsconfig — identical APIs).

**A reviewer might ask…**
- *"Why the deep `pick(/Results.N.Vulnerabilities.N/)` + `streamValues()` and not
  `pick('Results') → streamArray()`?"* Because `streamArray()` rebuilds each
  top-level `Results[]` element as a **complete** object — materializing an entire
  `Result` and *all* its `Vulnerabilities` at once, which spikes RSS on a
  vuln-heavy target. The deep pick reaches the leaf, so `streamValues()` assembles
  exactly **one** vulnerability object at a time. (An early research note
  mischaracterized `streamValues` as a buffering trap — it has the same
  one-item-at-a-time contract as `streamArray`; verified against the stream-json
  wiki.)
- *"How do you *know* `JSON.parse` never sneaks back in?"* A mechanical CI guard
  greps the parser path (`apps/api/src/parser/**`) and fails the build if
  `JSON.parse`, `fs.readFile`/`readFileSync`, or `.toArray(` appear. The
  prohibition is an enforced gate, not a promise.

**Rejected alternatives / trade-offs.** `bfj` was rejected — it is explicitly
documented as *not* optimized for speed, and its `walk`/`match` SAX API is for
arbitrary unknown shapes; our shape is known, so `pick` + `streamValues` is the
surgical fit. `JSONStream` is superseded by the actively-maintained
`stream-json`/`stream-chain` (same author). `fs.readFile` + `JSON.parse` is the
literal forbidden API — and the literal cause of the OOM the exercise tests for.

---

## 3. Architecture layering — Controller / Service / Worker

**What.** Thin transport edges (REST controller, GraphQL resolver) delegate to a
single shared `ScanService`; the service talks to injectable **adapters**
(cloner, Trivy runner, parser, repository, logger) behind ports. The worker is a
thin `@Processor` shell over a framework-free scan engine.

**Why.** The assignment grades "Clean Controller / Service / Worker separation."
NestJS's Module/Controller/Provider model *is* that separation, made legible to a
reviewer at a glance, and lets one `ScanService` be shared across REST + GraphQL +
worker with zero duplication.

**How.** `ScanController` (`apps/api/src/http/scan.controller.ts`) and
`ScanResolver` (`apps/api/src/graphql/scan.resolver.ts`) each declare `ScanService`
as their **only** collaborator and call only `enqueue`/`get`. An **import-guard**
unit test asserts the transport files never import the engine, parser, queue, or
any I/O primitive (`node:fs`, `child_process`, `execa`, `@nestjs/bullmq`) — the
thin-edge discipline (ARCH-01) is enforced mechanically, not by convention. The
engine sits behind hexagonal ports (`RepoCloner`, `TrivyRunner`, `ReportParser`,
`ScanRepository`, `EngineLogger`), each satisfied by an injected adapter.

**A reviewer might ask…**
- *"Isn't 'delegate to a service' just moving code around?"* The value is that the
  same `ScanService.enqueue`/`get` back **three** surfaces (REST, GraphQL, the SPA
  through GraphQL) with one implementation and one security boundary — add a
  transport, reuse the logic and the validation. The import-guard proves no logic
  leaked into the edges.
- *"Why ports/adapters for a take-home?"* So the memory-critical engine core is
  framework-free and unit-testable without booting Nest or Redis, and so the
  worker container carries no transport heap.

**Rejected alternatives / trade-offs.** A fatter controller that called the cloner/
Trivy directly was rejected — it would couple transport to I/O and duplicate the
validation across REST and GraphQL. See topic 13 for the NestJS-vs-Fastify tension
this layering choice sits inside.

---

## 4. Queue design — BullMQ, concurrency:1, restart survival

**What.** Scans run as **BullMQ** jobs over **Redis**; the worker processes with
`concurrency: 1`; queued jobs and scan records survive a restart because they live
in Redis, not process memory.

**Why.** A production-grade queue is the senior-level signal the assignment asks
for (retries, concurrency control, restart survival) — and `concurrency: 1` is
**load-bearing for memory**: one 500MB parse at a time keeps peak RSS inside the
200m cap. Parallel jobs would multiply the memory footprint and break the proof.

**How.** `ScanService.enqueue` adds a `ScanJob = { scanId, repoUrl }` to the queue;
the worker's `@Processor` (`concurrency: 1`) consumes it and delegates to the
framework-free engine. Scan state (`Queued → Scanning → Finished/Failed`) and
CRITICAL results are persisted in Redis by `ScanRepository` using WATCH/MULTI/EXEC
with conflict-retry to guard terminal states, refreshing a 7-day TTL atomically.

**A reviewer might ask…**
- *"How does the API inject a BullMQ queue without dragging `@nestjs/bullmq` into
  the test graph?"* `ScanService` injects the queue via a framework-neutral
  **`SCAN_QUEUE` Symbol token** (bridged to the real queue with
  `getQueueToken`/`useExisting`) instead of `@InjectQueue`. That keeps
  `@nestjs/bullmq` out of the Jest-loaded module graph — see topic 10 for why that
  matters.
- *"Where does `scanId` correlation come from across the Redis hop?"* It rides in
  the **job payload**, not `AsyncLocalStorage` — the worker builds a
  `pino.child({ scanId })` at the top of `process(job)` and threads it through
  every `EngineLogger` call.

**Rejected alternatives / trade-offs.** `AsyncLocalStorage` for correlation was
rejected — **ALS cannot cross the Redis queue boundary** (a new process picks up
the job), so the id must travel in the payload. The legacy `bull` (v3) was rejected
for BullMQ (TypeScript-first, sandboxed-processor model, active maintenance).
`concurrency > 1` is deliberately avoided to protect the memory ceiling.

---

## 5. Error handling — Trivy exit codes and bounded failure reasons

**What.** Every failure mode — invalid URL, clone failure, Trivy failure, disk
full, parse failure — marks the scan `Failed` with a bounded, sanitized
`{ category, detail }` reason. Finding vulnerabilities is **success**, not failure.

**Why.** The assignment explicitly grades "Trivy fails? disk full?" robustness. A
scanner that returns a non-zero exit *because it found CVEs* must not be treated as
an error, and raw stderr/paths/credentials must never leak into stored state.

**How.** `ScanFailureReason` (`apps/api/src/domain/scan.types.ts`) has a bounded
category vocabulary — `'clone' | 'trivy' | 'disk-full' | 'timeout' | 'parse' |
'unknown'` — and a `detail` string **capped at 500 chars at the persistence
boundary**. The engine normalizes each failure into one of these categories;
"vulnerabilities found" is a normal Finished outcome carrying the CRITICAL list.
The REST DTO surfaces `error` on a Failed scan; the GraphQL surface (topic 11)
deliberately exposes only `status: "Failed"` with empty vulnerabilities.

**A reviewer might ask…**
- *"How do you distinguish 'Trivy found CVEs' from 'Trivy crashed'?"* By exit-code
  semantics and category normalization — a scan that surfaces CRITICALs is
  `Finished` with results; only genuine invocation/clone/disk/parse failures map to
  a `Failed` category.
- *"Why cap `detail` and enumerate categories?"* To prevent unbounded or sensitive
  data (raw stderr, tokens, filesystem paths) from being persisted or returned —
  the category is a safe, closed vocabulary; the detail is truncated.

**Rejected alternatives / trade-offs.** Returning raw error strings was rejected
(information disclosure + unbounded storage). Treating any non-zero Trivy exit as
failure was rejected (would mislabel successful vulnerability findings).

---

## 6. Type safety — strict, no `any`, `@ObjectType` as typed models

**What.** Strict TypeScript everywhere (`strict`, `noUncheckedIndexedAccess`, no
`any`), with the Trivy report and domain shapes fully modeled, and code-first
GraphQL `@ObjectType()` classes doubling as the typed API models.

**Why.** "Strict TypeScript — no `any`, proper interfaces for Trivy report shapes"
is a graded criterion. `noUncheckedIndexedAccess` in particular guards the parser's
array/index access on untrusted report structure.

**How.** Framework-free domain types (`domain/vulnerability.types.ts`,
`domain/scan.types.ts`) carry **no** NestJS/GraphQL imports; the GraphQL layer
declares **separate** decorated mirrors (`graphql/scan.model.ts`,
`graphql/vulnerability.model.ts`) plus a mapper — the decorated class is the single
typed source of truth for the wire shape (TYPE-02). TypeScript is pinned to exactly
**6.0.3** and `verbatimModuleSyntax` is deliberately **omitted**.

**A reviewer might ask…**
- *"Why pin TypeScript to 6.0.3 instead of latest?"* For `typescript-eslint` /
  `@swc/jest` peer compatibility — a floating TS major risks breaking the lint/test
  toolchain. It is a stability pin, documented, not an accident.
- *"Why omit `verbatimModuleSyntax` in a strict setup?"* NestJS DI relies on
  CommonJS `emitDecoratorMetadata`; `verbatimModuleSyntax` interferes with that
  emit. `strict` + `noUncheckedIndexedAccess` already deliver the no-`any`
  guarantee without it.
- *"Why not decorate the domain types directly?"* Keeping `domain/*` framework-free
  means the memory-critical engine and parser never import `@nestjs/graphql`; the
  decorated models live only in the API-process GraphQL layer.

**Rejected alternatives / trade-offs.** Decorating domain types with `@ObjectType`
was rejected — it would pull GraphQL into the worker/parser heap and violate the
framework-free core. TS latest (`7.x`) was rejected for the peer-compat pin.

---

## 7. Trivy invocation — local-detect + Docker fallback + the socket-mount trade-off

**What.** The worker runs Trivy by **auto-detecting a local `trivy` binary** and
otherwise **falling back to the pinned Docker image**
`ghcr.io/aquasecurity/trivy:0.69.3`, run as a *sibling container* through a mounted
host Docker socket.

**Why.** Most reviewer-friendly: it works whether or not Trivy is installed on the
host, and keeps the app image lean (Trivy is not baked in). Running Trivy as a
sibling container also keeps the scanner's memory in a **separate** container, so it
never counts against the worker's 200m cap.

**How.** The `TrivyRunner` adapter shells out with `shell: false` argv (no string
interpolation), so a hostile repo URL cannot inject shell metacharacters. In
compose, the worker mounts `/var/run/docker.sock`; a root entrypoint adds the
`node` user to the socket's runtime gid and then **drops to non-root** before
exec'ing the app.

**A reviewer might ask…**
- *"Mounting the Docker socket gives the container Docker control — isn't that a
  privilege risk?"* **Yes, and we own it.** It is an accepted **single-tenant
  take-home trade-off**: it buys a zero-host-install reviewer experience and lean
  image. The worker still runs as non-root `node`, only ever invokes the *pinned*
  scanner image, and passes the repo URL as discrete argv. In a real multi-tenant
  deployment you would replace the socket mount with a rootless/remote build
  service or a sidecar with a scoped API — same honesty posture as the GraphiQL
  exposure (topic 11).
- *"Why pin the Trivy image?"* Reproducible scans and a known, audited scanner
  version — no drifting `latest`.

**Rejected alternatives / trade-offs.** Baking Trivy into the app image was
rejected (bloats the image, couples app and scanner release cadence). `alpine`/
`distroless` bases were rejected for `node:22-slim` (see topic 8). Interpolating
the URL into a shell string was rejected — a command-injection vector; argv arrays
close it.

---

## 8. Two-entrypoint topology & self-test honesty

**What.** Two Node entrypoints share `ScanModule`: `dist/index.js` (the API — REST
+ GraphQL + served SPA) and `dist/worker.js` (the worker — clone/Trivy/parse). The
worker loads **neither** GraphQL nor the static SPA.

**Why.** The memory-critical process must carry the smallest possible heap: no
GraphQL schema, no Apollo/Mercurius runtime, no static-serving — that would be dead
heap under the very cap being proven. Splitting the entrypoints sizes each process
independently. It also lets the API entrypoint match the assignment's verbatim
self-test command.

**How.** `src/index.ts` → `NestFactory.create` + `listen` (compiles to
`dist/index.js`); `src/worker.ts` → `createApplicationContext` with no HTTP
listener, booting `WorkerModule` with `@Processor concurrency:1`. GraphQL and
`ServeStaticModule` are registered in **`AppModule` only**, never `WorkerModule`.
The base image is `node:22-slim`.

**A reviewer might ask…**
- *"The self-test is `node --max-old-space-size=150 dist/index.js`, but you say the
  API doesn't parse 500MB — is the self-test meaningful?"* This is the honesty
  point we lead into rather than hide. The verbatim command proves the **API boots
  cleanly** under the 150MB cap (proven by `npm run test:selftest`). The 500MB
  stream-parse runs in `dist/worker.js` (compose runs it under the same
  `--max-old-space-size=150`), and the **honest 500MB proof is the standalone
  `memtest`** against the 500MB fixture, which exercises exactly the worker's parse
  path. Two artifacts, one honest story — documented in the README's "Honest
  self-test mapping."
- *"Why `node:22-slim` and not alpine or distroless?"* alpine's musl can inflate
  RSS (bad when RSS is graded); distroless has no shell, which breaks the Trivy
  Docker-fallback shell-out and the acceptance harness. `node:22-slim` is the lean
  Debian base that keeps a shell.

**Rejected alternatives / trade-offs.** A single combined entrypoint was rejected —
it would load GraphQL/SPA into the memory-critical process. `alpine`/`distroless`
rejected as above. Node 20/24 not pinned — the project pins **Node 22**
(`engines: ">=22 <23"`, `.nvmrc`), the runtime the memory gate is verified against.

---

## 9. Guaranteed cleanup — `try/finally` on every path

**What.** The cloned repository directory and the on-disk Trivy report are deleted
after processing — on **success and on every failure path**.

**Why.** The assignment explicitly requires cleanup of the clone and JSON file
after processing. Leaked clones/reports would exhaust disk over repeated scans
(and "disk full" is itself a graded failure mode).

**How.** The engine wraps the clone→scan→parse sequence in `try/finally`; the
`finally` removes the temp clone dir and the report file regardless of outcome, so
a clone failure, a Trivy crash, or a parse error all still clean up. Temp paths live
under the configured `SCAN_TMP_DIR`.

**A reviewer might ask…**
- *"What if cleanup itself throws, or the process is killed mid-scan?"* Cleanup is
  in `finally` and is best-effort-logged so it never masks the original failure;
  because temp artifacts live under a known `SCAN_TMP_DIR`, a restart can also
  reclaim orphans. The forced-failure path is exercised by the acceptance gate,
  which asserts cleanup after *both* success and induced failure.

**Rejected alternatives / trade-offs.** Cleaning up only on the success path was
rejected — the failure paths are exactly where disk leaks accumulate. Deferring
cleanup to a cron/sweeper was rejected as unnecessary complexity for a synchronous
`try/finally`.

---

## 10. Testing strategy — the Jest landmine and the compiled-`dist` harness

**What.** Unit specs are mock-only and never import the BullMQ-wired module graph;
anything that must exercise `@nestjs/bullmq` end-to-end runs against **compiled
`dist` under `node:test`**, not Jest.

**Why.** There is a real toolchain landmine: loading certain Nest module graphs
under Jest triggered a native `@swc/core` + `miette` panic (SIGABRT) that aborts
the test run. The strategy routes around it so tests are reliable.

**How.** Two complementary harnesses:
1. **Mock-only Jest unit specs** (e.g. `scan.controller.spec.ts`,
   `scan.resolver.spec.ts`) mock `ScanService` and import only the unit under test
   — never `ScanModule`/`AppModule`/`@nestjs/bullmq`.
2. **Compiled-`dist` + `node:test` integration harnesses** (`api-integration.mjs`,
   `scan-engine-integration.mjs`, `acceptance.mjs`) run the real `dist/index.js` /
   `dist/worker.js` against a disposable Redis and the pinned Docker Trivy — the
   pattern that dodges the Jest landmine entirely.

The `SCAN_QUEUE` Symbol token (topic 4) is what lets the injectable service code
stay out of the Jest BullMQ graph.

**A reviewer might ask…**
- *"What actually caused the `@swc/core`/miette panic?"* Investigation (instrumenting
  `@swc/core.transformSync` to log the file it was transforming when it aborted)
  traced the true trigger to an **editor extension injected into the Jest process**
  — the Console Ninja editor buildHook, a multi-MB instrumentation bundle that
  lives *outside* `node_modules/`. When a Nest module graph loads, the extension
  injects that hook; `@swc/jest` then tries to transform an out-of-tree file and
  `@swc/core` panics formatting a diagnostic on it. It reproduced with
  `@nestjs/graphql` alone — no BullMQ needed — which corrected the earlier
  hypothesis that `@nestjs/bullmq` was the root cause.
- *"How is it fixed, and is the fix portable?"* By hardening Jest's
  `transformIgnorePatterns` to exclude editor-extension instrumentation
  (`.(cursor|vscode|vscode-server)/extensions/`), so the project transformer never
  touches editor-injected files. The pattern is editor-general (no per-user path)
  and has zero effect on project-file transforms — `npm test` runs clean.

**Rejected alternatives / trade-offs.** Running BullMQ-touching code under Jest was
rejected (the panic). The compiled-`dist` + `node:test` harness is heavier to write
than a Jest integration test but is the only reliable path given the toolchain, and
it has the bonus of testing the **actual shipped artifacts**.

---

## 11. Bonus B — GraphQL (code-first Mercurius) and the GraphiQL trade-off

**What.** A code-first GraphQL surface (`MercuriusDriver`) on the **same Fastify
process/port** as REST: a `scan(id)` query and an `enqueueScan(repoUrl)` mutation,
both thin adapters over the same `ScanService`. GraphiQL is enabled at `/graphiql`.

**Why.** Bonus B, earned without a second server: Mercurius is a Fastify-native
plugin, so REST + GraphQL share one listener and one service layer — zero
second-listener memory overhead, protecting the graded budget.

**How.** `graphql/scan.resolver.ts` delegates: the query calls `ScanService.get(id)`
and returns `null` for an unknown id (parity with REST's 404); the mutation reuses
the **same `parseGithubUrl` allowlist** as REST and enqueues only the canonical
`https://github.com/{owner}/{repo}`. The schema is locked to `type Scan { id: ID!,
status: String!, criticalVulnerabilities: [Vulnerability] }` (`status` is `String!`,
not a GraphQL enum). `graphql` is pinned to **16.14.2** (root `overrides`).

**A reviewer might ask…**
- *"The GraphQL mutation is a second path to the cloner — is it validated like
  REST?"* Yes — SSRF/injection parity is explicit. `enqueueScan` calls the same
  fail-closed `parseGithubUrl` validator and enqueues only the canonical URL,
  rejecting `git@`/`file://`/non-github/userinfo inputs *before* `ScanService.enqueue`
  runs (asserted by 7 negative + 2 canonicalization unit cases). One validator,
  both transports.
- *"GraphiQL and introspection are enabled in the container — isn't that a prod
  smell?"* **Yes, and it is a deliberate, documented demo choice.** For a
  single-tenant take-home, reviewer explorability (run the mutation + query by hand)
  outweighs introspection hardening. In a real deployment you would gate
  GraphiQL/introspection behind environment + auth. Same honesty posture as the
  socket-mount trade-off (topic 7).
- *"Why `graphql@16` not `17`?"* graphql 17 shipped recently and the NestJS/Mercurius
  quartet still peer-requires `graphql ^16`; unpinned installs pull 17 and break the
  peer graph / schema build. A root `overrides` locks 16.14.2 across the monorepo.

**Rejected alternatives / trade-offs.** Apollo Server (bare) was rejected — heaviest
option and it means a second HTTP listener alongside Fastify. A GraphQL `status`
enum was rejected — the locked schema is `String!`. Reimplementing scan logic in the
resolver was rejected — it only delegates (ARCH-01).

---

## 12. Bonus A — React SPA served same-origin

**What.** A Vite/React 19 + urql + Tailwind v4 single-screen app that submits a repo
URL, enqueues via GraphQL, polls `scan(id)` every 2s, and renders all four
`ScanStatus` states with a CRITICAL results table. It is built (`vite build`) and
served as static assets by the API on the **same origin** — one URL, no CORS.

**Why.** The SPA is the reviewer's first visual impression and doubles as a live
demo of Bonus B (it dogfoods the GraphQL surface). Serving it from the API keeps it
to one origin and one process — no second container, no CORS.

**How.** urql client points at the **relative** `/graphql` URL (same origin, D-04).
`useScanPolling` uses `setInterval` + `reexecute({ requestPolicy: 'network-only' })`
at 2000ms and **stops re-arming on a terminal state** (`Finished`/`Failed`). The
results table maps **only the six persisted `Vulnerability` fields** — Package
(`pkgName`), CVE (`vulnerabilityId`, linked via `primaryUrl`), Installed
(`installedVersion`), Severity, Title. `ServeStaticModule` serves the built bundle
from `apps/api/dist/web` with `/api`, `/health`, `/graphql`, `/graphiql` excluded so
the SPA catch-all never shadows a backend route (exclude token confirmed
empirically). A boot-safe placeholder keeps the `dist/index.js` self-test green even
when the SPA is unbuilt.

**A reviewer might ask…**
- *"Why no 'Fixed version' column?"* The stored `Vulnerability` type has **no**
  `fixedVersion` field, and adding one would mean expanding the memory-critical
  streaming parser to capture more fields. The UI renders only what is already
  persisted — the memory pipeline is not touched for a cosmetic column.
- *"Why does the Failed card show a generic message?"* The GraphQL `ScanModel`
  intentionally exposes only `id`/`status`/`criticalVulnerabilities` — no `error`
  field — so the SPA renders a humanized generic message rather than requesting a
  field the schema does not provide. (The per-category map is retained in code for
  if/when the schema exposes `error`.)
- *"Why urql, not Apollo?"* Leaner for a single-screen app; the only manual bit is
  the 2s poll loop (urql has no built-in `pollInterval`), which is a few lines.

**Rejected alternatives / trade-offs.** Apollo Client was rejected for leanness
(despite its built-in polling). A component library (MUI/shadcn) was rejected —
Tailwind v4's zero-config Vite plugin reaches "looks finished" with the least bundle
weight. A separate nginx/static container was rejected — it contradicts the
one-origin, one-URL goal.

---

## 13. The NestJS-vs-Fastify tension — owning the decision

**What.** This repo's own `.claude/CLAUDE.md` research recommends **Fastify over
NestJS** for this assignment; the build is **NestJS on the Fastify adapter**. We own
that tension rather than leaving it unexamined.

**Why the recommendation exists.** The research argued that raw Fastify has a lower
per-instance memory footprint than NestJS's DI container, and that every MB of RSS
counts under a 200m cap — a legitimate concern for a memory-graded project.

**Why we chose NestJS(+Fastify adapter) anyway.**
- **Module/Controller/Provider *is* the graded separation.** The assignment grades
  "Clean Controller/Service/Worker separation"; NestJS makes that separation
  framework-enforced and legible to a reviewer at a glance, rather than a hand-rolled
  folder convention.
- **One `ScanService` across three surfaces.** DI shares a single service across
  REST, GraphQL, and the worker with no duplication and one security boundary.
- **The Fastify adapter keeps it lean.** We get Nest's structure *on* Fastify's
  low-overhead HTTP core, and Mercurius (Fastify-native) mounts GraphQL on the same
  listener — REST + GraphQL + SPA in one process, no second server.
- **The memory concern is neutralized where it actually matters.** The graded memory
  path is the **worker**, and the worker is a lean `createApplicationContext` with no
  GraphQL/SPA/HTTP-listener heap (topic 8). The DI container's overhead does not sit
  on the 500MB parse path.

**A reviewer might ask…**
- *"So did you ignore your own research?"* No — we weighed it. The research's memory
  argument is real for the *HTTP* process, but the pass/fail memory proof is the
  *worker*, which is deliberately kept framework-light. On the API side we accepted a
  small, bounded DI overhead in exchange for framework-enforced architecture that
  directly demonstrates a graded criterion. It is a documented trade-off, not an
  oversight.

**Rejected alternatives / trade-offs.** Raw Fastify was rejected for the reasons
above (loses the framework-enforced separation and the shared-DI service). Express
was never in contention (lower throughput, no built-in schema validation).

---

## Appendix — where to read the code

| Concern | Files |
| --- | --- |
| Streaming parser | `apps/api/src/parser/report-parser.ts` |
| Memory proof | `apps/api/scripts/memtest.ts`, `memtest-sweep.ts`, `gen-fixture.ts` |
| Shared service | `apps/api/src/scan/scan.service.ts` (`enqueue`, `get`) |
| REST edge | `apps/api/src/http/scan.controller.ts`, `dto/scan-response.ts` |
| GraphQL edge | `apps/api/src/graphql/{scan.resolver,scan.model,vulnerability.model,scan-graphql.mapper}.ts` |
| URL allowlist | `apps/api/src/http/validation/github-url.ts` |
| Worker / engine | `apps/api/src/worker.ts`, `src/engine/*` |
| Two entrypoints | `apps/api/src/index.ts`, `apps/api/src/worker.ts` |
| Static serving | `apps/api/src/app.module.ts` (`ServeStaticModule`) |
| React SPA | `apps/web/src/{App,main,useScanPolling,graphql}.tsx?` |
| Packaging | `Dockerfile`, `docker-compose.yml` |
| Acceptance / self-test | `apps/api/scripts/{acceptance,selftest-index-boot,serve-static-routes.smoke}.mjs` |

For run instructions, see **[README.md](./README.md)**.
