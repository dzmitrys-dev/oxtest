# Feature Research

**Domain:** Async security-scanner wrapper service (Trivy take-home, Senior Backend Engineer)
**Researched:** 2026-07-09
**Confidence:** MEDIUM (web-sourced patterns, cross-corroborated across 6+ independent sources per topic; no single-source claims; assignment-specific grading weight is inferred from PROJECT.md, not externally verifiable)

## Feature Landscape

This assignment is graded, not shipped to users — so "table stakes" means "what a senior reviewer expects to see or marks down for missing," and "differentiators" means "what makes a reviewer say hire." Every row below is mapped to the assignment's stated evaluation criteria (Memory > Architecture > Error handling > Type safety > forbidden-API compliance > Streams correctness) from PROJECT.md.

### Table Stakes (Reviewers Expect These — Missing Them Reads as Sloppy)

| Feature | Why Expected | Complexity | Evaluation Criterion Served | Notes |
|---------|--------------|------------|------------------------------|-------|
| Input validation on repo URL (shape + protocol) | Any senior reviewer tests with garbage input first; a 500 crash on `POST /api/scan {"url":"not-a-url"}` is an instant red flag | LOW | Error handling | Validate with `URL` parsing (never regex-only), restrict scheme to `https`, and ideally restrict host to `github.com`/`www.github.com` since the assignment only requires GitHub URLs |
| SSRF-aware guard on the clone target | Feeding a URL to `git clone`/`fetch` is a classic SSRF/RCE-adjacent vector; a senior candidate is expected to think about it even if the assignment doesn't say "security" | LOW–MEDIUM | Error handling, Architecture (shows security awareness) | Resolve DNS and reject private/loopback/link-local ranges (RFC1918, 127.0.0.0/8, 169.254.0.0/16, ::1, fc00::/7) before invoking any shell/git command; reject non-github hosts outright since scope is GitHub-only |
| Structured logging (JSON logs w/ scanId correlation) | Distinguishes "printf debugging" from production-grade service; makes async job flows traceable | LOW | Architecture | Use `pino` (fast, low-overhead — matters under the memory budget) with a per-request/per-scan correlation id threaded through controller → service → worker |
| `GET /health` (or `/healthz`) endpoint | Every real service has one; the docker-compose bonus implies orchestration awareness, and a health check is the natural companion | LOW | Architecture | Cheap check: process up + Redis ping. Doesn't need full k8s liveness/readiness split (that's over-scoped — see Anti-Features) but a single endpoint returning 200 + basic dependency status is expected |
| Idempotent, symmetric cleanup (success AND failure paths) | The assignment explicitly requires cleanup of cloned repo + JSON file; missing failure-path cleanup is a common bug that leaks disk under retries | LOW–MEDIUM | Error handling, Memory (disk pressure has the same "run out of resource" shape as OOM) | Wrap the clone→scan→parse pipeline in try/finally (or BullMQ's job `.finally`/completed+failed listeners) so cleanup runs exactly once regardless of outcome; also guard against double-cleanup if a job is retried |
| `.env`/config validation at boot | A senior candidate fails fast on misconfiguration rather than crashing 30 seconds into a scan; also demonstrates type safety applied to config, not just code | LOW | Type safety, Error handling | Validate env vars (`REDIS_URL`, `MAX_OLD_SPACE_SIZE`, `PORT`, etc.) with a schema (zod/envalid) at startup; refuse to boot with a clear error rather than failing deep in a worker |
| Graceful shutdown (SIGTERM/SIGINT) | Docker Compose sends SIGTERM on `docker compose down`; a service that doesn't drain in-flight jobs loses work and looks unfinished under the reviewer's own test run | LOW–MEDIUM | Architecture, Error handling | Order: stop accepting new HTTP requests → `await worker.close()` (drains active BullMQ jobs) → close Redis connections → exit. Add a force-exit timeout so shutdown never hangs |
| README with exact run instructions | Explicitly required by the assignment; reviewers will follow it verbatim, including the `node --max-old-space-size=150` self-test command | LOW | (gatekeeper — a broken README costs points before code is even read) | Must include: prerequisites, docker-compose path, manual path, how to run the memory self-test, how to trigger a scan end-to-end |
| Consistent, typed API error responses | Uncaught errors returning raw stack traces or inconsistent shapes signal "not production-minded" | LOW | Type safety, Error handling | A single error-handling middleware mapping known error classes (`InvalidUrlError`, `CloneFailedError`, `TrivyExecutionError`, `DiskFullError`) to consistent JSON `{error, code}` shapes |

### Differentiators (What Makes a Reviewer Say "Hire")

| Feature | Value Proposition | Complexity | Evaluation Criterion Served | Notes |
|---------|-------------------|------------|------------------------------|-------|
| Memory self-test/proof script + huge-fixture generator | The assignment's #1 grading axis is memory — a reviewer who can run one command and *see* heap stay flat under 150MB while processing a 500MB+ file is convinced instantly; without it they have to trust the code reading alone | MEDIUM | **Memory (primary criterion)** | Already in Active requirements — treat as P0, not a bonus. Fixture generator must itself stream-write (not build an in-memory array) so it doesn't contradict its own thesis. Proof script should print `process.memoryUsage().heapUsed` at intervals or use `--max-old-space-size=150` and simply not crash — visual proof (a small chart/log of RSS over time) elevates this further |
| Backpressure-aware stream pipeline (`pipeline()`/`pipe` with proper `highWaterMark`, no manual `.on('data')` buffering) | Distinguishes "used a streaming library" from "actually understands streams" — the assignment explicitly grades "Node.js Streams line-by-line/object-by-object parsing" | MEDIUM | **Streams correctness (explicit criterion)** | Use `stream.pipeline()` (not raw `.pipe()`) for automatic error propagation and cleanup; compose `fs.createReadStream → stream-json parser → filter transform → collector` as a single pipeline. Add a unit test that asserts memory stays bounded as input size grows (e.g., run against 10MB and 500MB fixtures and assert similar peak RSS) |
| Job retry/timeout policies (Trivy hang protection, exponential backoff) | A senior candidate anticipates that `trivy` or `git clone` can hang or fail transiently; BullMQ retries with backoff plus a hard timeout on the child process show defensive engineering | MEDIUM | Error handling, Architecture | Wrap `trivy`/`git` child processes with a timeout that kills the process and fails the job cleanly (still triggering cleanup); configure BullMQ `attempts` + exponential `backoff` for transient failures (e.g., clone network blips), but do NOT retry deterministic failures (invalid URL) — that wastes cycles and confuses status semantics |
| Concurrency limits on the worker | Assignment explicitly lists "concurrency control" under BullMQ value-add; caps resource usage so N simultaneous scans can't multiply memory/CPU load past the container limit | LOW–MEDIUM | **Memory**, Architecture | Set BullMQ worker `concurrency` conservatively (e.g., 1–2) given the 200MB container limit — this is a direct, visible link between architecture choice and the memory constraint, worth calling out in ONBOARDING.md |
| Deduplication of repeated scan requests | Shows systems thinking beyond the literal spec: don't reclone/rescan the same repo URL if a scan is already in-flight or was just completed | LOW–MEDIUM | Architecture | Achievable cheaply via BullMQ's `jobId` deduplication (deterministic ID derived from normalized repo URL) — returns the existing `scanId` instead of creating a duplicate. Worth a paragraph in ONBOARDING explaining the tradeoff (staleness window vs. duplicate work) |
| Pagination of vulnerability results | Anticipates the real failure mode: a report with thousands of CRITICAL findings would make `GET /api/scan/:id` itself return a huge JSON blob, undermining the memory story on the read path | MEDIUM | **Memory** (consistency of the memory story end-to-end) | Simple `?limit=&offset=` or cursor pagination on the critical-vulns array in the response; also demonstrates the memory discipline didn't stop at ingestion |
| OpenAPI/Swagger docs (`/api-docs`) | Turns "trust me it works" into a self-describing, clickable API a reviewer can try in 30 seconds — high visibility-to-effort ratio | LOW–MEDIUM | Architecture (professionalism signal) | `swagger-jsdoc` + `swagger-ui-express`; also doubles as living documentation for the GraphQL/REST parity bonus |
| CI (GitHub Actions): lint + typecheck + unit/integration tests + memory-proof script | Automated, reproducible proof beats "trust me" — running the memory self-test *in CI* is the single highest-leverage differentiator because it operationalizes the assignment's own pass/fail bar | MEDIUM | **Memory**, Type safety, Architecture | One workflow: `npm ci` → `tsc --noEmit` → `eslint` → `test:unit` + `test:integration` → a step that runs `node --max-old-space-size=150 dist/memory-proof.js` and fails the build if it OOMs or exceeds a byte threshold. This is rare among candidates and directly demonstrates the #1 criterion is continuously enforced, not a one-off demo |
| Meaningful test pyramid (unit for stream filter/transform, integration for API endpoints, e2e with fixture through the full pipeline) | The assignment doesn't mandate tests, but "tests make your task stand out because other candidates tend to skip them" — especially true for a memory-safety claim, which is only credible if backed by a test that actually exercises a large fixture | MEDIUM–HIGH | Type safety, Error handling, **Memory** (credibility) | Suggested split: unit tests for the CRITICAL-severity filter/transform logic and URL validator (fast, isolated); integration tests hitting `POST /api/scan` + `GET /api/scan/:id` against a real/local Redis; one e2e test running the actual pipeline against a medium-size (~50-100MB) fixture to keep CI fast while the true 500MB proof lives in its own dedicated script/CI step |
| Strict TypeScript modeling of Trivy's actual JSON schema | The assignment explicitly grades type safety and "no `any`"; hand-modeling the real `trivy image/fs --format json` schema (not a guessed shape) signals attention to the actual tool, not just the assignment prose | LOW–MEDIUM | **Type safety (explicit criterion)** | Pull a real (small) `trivy` JSON output sample to derive interfaces, or reference Trivy's documented output schema; use discriminated unions for severity levels rather than a bare `string` |
| ONBOARDING.md quality beyond "what/why/how" checklist | Already required, but a differentiator version explicitly ties each architectural decision back to the graded criteria (e.g., "we chose stream-json over JSONStream because X — this is why heap stays flat") — turns the doc into a rubric-matching artifact | LOW | All criteria (framing/communication) | Structure ONBOARDING.md sections to mirror the assignment's own evaluation priority order (Memory → Architecture → Error handling → Type safety → Streams) so the reviewer's mental checklist is answered in the order they'll grade it |

### Anti-Features (Add Scope, No Grade Value — Deliberately Skip)

| Feature | Why It Seems Appealing | Why Problematic Here | Alternative |
|---------|------------------------|-----------------------|-------------|
| Authentication / authorization (JWT, sessions, API keys) | "Real" APIs have auth; feels incomplete without it | Not requested, adds surface area with zero grading payoff, and risks introducing bugs in code paths nobody will evaluate — actively distracts from the memory/streams story the grader cares about | Explicitly note in ONBOARDING.md that auth was scoped out as "not requested; would be added via API-key middleware in a real deployment" — shows awareness without spending budget |
| Multi-tenant data isolation | Feels "enterprise-grade" | No concept of tenants in the assignment; adds modeling complexity (scoping every query/job by tenant) for a single-reviewer, single-run demo | None needed — a single global scan namespace is correct for this scope |
| Persistent database (Postgres/Mongo for scan history) | Feels more "production" than Redis-only | PROJECT.md already scoped this out — Redis (via BullMQ) suffices for job state + results and keeps the run story (docker-compose up, one dependency) simple; a DB adds migrations, an ORM, and another failure mode to explain for no criterion payoff | Redis-backed job/result storage, as already decided |
| Kubernetes manifests / Helm charts | Signals "I know k8s" | The assignment simulates constraints via Docker `mem_limit`, not real orchestration; k8s manifests are unused, untested (reviewer won't have a cluster), and dilute focus from the actual pass/fail axis | Docker Compose with `mem_limit`/`mem_reservation` is the correct-scope equivalent already in the bonus list |
| Full liveness/readiness probe split (`/livez` + `/readyz` a la k8s) | Common "senior" pattern from other search results | Over-engineered for a service that isn't deployed to an orchestrator in this assignment; adds two endpoints and dependency-check logic the reviewer will never exercise via a probe | A single `/health` endpoint returning process-up + Redis-connectivity status covers the credible need |
| Rate limiting / API gateway concerns | "Production APIs need it" | No load scenario in the assignment; the reviewer will make a handful of manual requests. Adds middleware and config with no evaluator payoff | Mention as a "future consideration" in ONBOARDING.md rather than implementing |
| Storing full (non-CRITICAL) vulnerability data "just in case" | Feels safer / more complete | The assignment explicitly instructs storing ONLY CRITICAL; storing more increases memory footprint and risks contradicting the graded memory-discipline requirement, and quietly reintroduces the `JSON.parse`-the-whole-thing temptation | Discard non-CRITICAL entries during the streaming filter step — never buffer them at all, don't just filter them out at the response layer |
| Custom scanning engines / supporting non-Trivy scanners | "More flexible" | Explicitly out of scope; the whole grading rubric is Trivy + streams + memory. Building an abstraction layer for hypothetical future scanners is premature and dilutes the code reviewers actually read | Hard-code the Trivy invocation; if genericity is desired, keep it to a single thin adapter interface, not a plugin system |

## Feature Dependencies

```
Strict TypeScript Trivy report interfaces
    └──requires──> Access to a real (small) Trivy JSON sample to model shape accurately

Backpressure-aware stream pipeline
    └──requires──> stream-json (or bfj) integrated as the parser
    └──enhances──> Memory self-test/proof script (pipeline is what the proof demonstrates)

Memory self-test/proof script
    └──requires──> Huge-fixture generator (must itself be memory-safe/streamed)
    └──enhances──> CI memory-check step (proof script becomes the CI assertion)

Idempotent cleanup (success + failure paths)
    └──requires──> Job retry/timeout policies (cleanup must run exactly once even across retries)

Deduplication of repeated scan requests
    └──requires──> BullMQ deterministic jobId strategy
    └──conflicts partially with──> Job retry policies (dedup + retry both touch jobId semantics; must design together, not bolt on separately)

Pagination of vulnerability results
    └──requires──> Stream pipeline already extracting only CRITICAL entries (paginating a small filtered set, not a huge blob)

Graceful shutdown
    └──requires──> Health endpoint (readiness flips to unhealthy during drain, even in the single-endpoint form)

OpenAPI/Swagger docs
    └──enhances──> GraphQL/REST parity bonus (shared service layer documented once, exposed twice)

Meaningful test pyramid
    └──requires──> Strict TypeScript interfaces (tests are far cheaper to write and more meaningful against typed shapes)
    └──enhances──> CI pipeline (tests are what CI runs)

SSRF-aware URL guard
    └──requires──> Input validation on repo URL (guard sits directly on top of the parsed/validated URL)
```

### Dependency Notes

- **Memory self-test requires the huge-fixture generator, and the generator itself must be streaming:** if the generator builds a giant array/object in memory before writing it to disk, it silently undermines the credibility of the entire memory-efficiency claim — this is the single most important ordering constraint in the whole feature set.
- **CI memory-check enhances the memory self-test:** the proof script and the CI step should be the *same* script — write it once as an npm script (`npm run memory:proof`) invoked both locally and in the GitHub Actions job — that also keeps this at LOW incremental complexity once the script exists.
- **Dedup and retry both touch job-identity logic in BullMQ:** design the `jobId` strategy (what it is derived from, whether retries reuse or replace it) once, up front, rather than adding dedup as an afterthought — retrofitting it is a common source of subtle bugs (e.g., a retried job accidentally treated as a "duplicate" of itself).
- **Pagination only makes sense after the streaming filter already narrows to CRITICAL-only:** don't build pagination against a hypothetical "all vulnerabilities" store; it should paginate the already-small, already-filtered result set that's stored per scan.
- **SSRF guard is a thin layer on top of URL validation**, not a separate subsystem — implement validation to also return the resolved-and-checked URL/host so the guard doesn't re-parse.

## MVP Definition

Given this is a graded artifact with a 2–3 day window, "MVP" = the minimum that satisfies every literal requirement plus every LOW-complexity table-stakes item, since those are cheap and their absence is disproportionately penalized relative to their cost.

### Launch With (v1 — must exist for submission)

- [ ] All literal assignment requirements (POST/GET endpoints, BullMQ worker, stream-parse to CRITICAL-only, cleanup, error handling, strict TS) — the pass/fail floor
- [ ] Input validation + SSRF-aware guard on repo URL — cheap, and a security lapse here is the kind of thing a senior reviewer specifically probes
- [ ] Structured logging with scanId correlation — near-zero cost, high signal for "production-minded"
- [ ] `.env` validation at boot + consistent typed error responses — LOW cost, prevents embarrassing failure modes during the reviewer's own test run
- [ ] Idempotent cleanup on success AND failure paths — directly required by the assignment; get this right first
- [ ] Graceful shutdown — matters because docker-compose bonus means the reviewer will `docker compose down` mid-run at some point
- [ ] Memory self-test/proof script + streaming fixture generator — this is not optional polish, it IS the #1 grading criterion made visible
- [ ] `/health` endpoint — trivial, expected
- [ ] README with exact run instructions including the self-test command

### Add After Validation (v1.x — do once the floor is solid)

- [ ] Job retry/timeout policies around Trivy/git child processes
- [ ] Concurrency limits tuned to the container memory budget (explicitly reasoned about in ONBOARDING.md)
- [ ] Deduplication of repeated scan requests
- [ ] Basic test pyramid: unit tests for the CRITICAL filter/transform + URL validator, integration tests for the two endpoints
- [ ] CI (GitHub Actions): lint + typecheck + unit/integration tests
- [ ] ONBOARDING.md written to mirror the assignment's own grading order

### Future Consideration (v2+ — only if time remains after everything above, and bonuses)

- [ ] Pagination of vulnerability results
- [ ] OpenAPI/Swagger docs
- [ ] CI step that runs the memory-proof script as a build gate (highest-leverage add if time allows — do this before Swagger/pagination if forced to choose)
- [ ] e2e test running the real pipeline against a medium fixture
- [ ] The three assignment bonuses (React poller, GraphQL, docker mem_limit) — already scoped as "all in" per PROJECT.md Key Decisions, but sequenced after the core memory/architecture/error-handling floor is verified solid, since those are worth more grading weight than any bonus

## Feature Prioritization Matrix

| Feature | Grading Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Streaming pipeline, CRITICAL-only extraction | HIGH | MEDIUM | P1 |
| Memory self-test + fixture generator | HIGH | MEDIUM | P1 |
| Input validation + SSRF guard | MEDIUM-HIGH | LOW | P1 |
| Idempotent cleanup (success+failure) | HIGH | LOW-MEDIUM | P1 |
| Structured logging | MEDIUM | LOW | P1 |
| `.env` validation, typed errors | MEDIUM | LOW | P1 |
| Graceful shutdown | MEDIUM | LOW-MEDIUM | P1 |
| Strict TS Trivy interfaces | HIGH | LOW-MEDIUM | P1 |
| `/health` endpoint | LOW-MEDIUM | LOW | P1 |
| Job retry/timeout policies | MEDIUM | MEDIUM | P2 |
| Concurrency limits | MEDIUM | LOW-MEDIUM | P2 |
| Test pyramid (unit+integration) | MEDIUM-HIGH | MEDIUM | P2 |
| GitHub Actions CI (lint/type/test) | MEDIUM | MEDIUM | P2 |
| Deduplication of scan requests | LOW-MEDIUM | LOW-MEDIUM | P2 |
| ONBOARDING.md rubric-aligned | HIGH (communication) | LOW | P1/P2 (write incrementally) |
| CI memory-proof gate | HIGH | LOW (reuses P1 script) | P2 |
| Pagination of results | LOW-MEDIUM | MEDIUM | P3 |
| OpenAPI/Swagger docs | LOW-MEDIUM | LOW-MEDIUM | P3 |
| e2e fixture test | MEDIUM | MEDIUM-HIGH | P3 |
| Bonuses (React/GraphQL/docker mem_limit) | MEDIUM (explicit bonus points) | MEDIUM-HIGH | P2 (per Key Decisions, all-in, but after floor) |

**Priority key:**
- P1: Must have — either literal requirement or LOW-cost/HIGH-signal table stakes
- P2: Should have — differentiators with good cost/value ratio, do after the floor is solid
- P3: Nice to have — polish that helps but isn't decisive if time runs out

## Competitor Feature Analysis

Not applicable in the traditional sense (no live competitor products) — the relevant "competitors" are other candidates' submissions for the same assignment. Substituted with a synthesis of what distinguishes strong vs. average submissions based on take-home-assignment review literature:

| Signal | Average Submission | Strong Senior Submission | Our Approach |
|--------|---------------------|---------------------------|--------------|
| Memory claim | Asserted in README prose only | Backed by a runnable, CI-gated proof script | Ship the proof script as a first-class artifact, referenced from README AND run in CI |
| Error handling | Try/catch wrapping the happy path | Typed error classes mapped to consistent API responses, retry/timeout policy for flaky child processes | Typed error hierarchy + BullMQ backoff + child-process timeouts |
| Security awareness | None (URL passed straight to `git clone`) | Explicit SSRF-aware validation, even though not asked | Implement the guard, document the reasoning in ONBOARDING.md |
| Tests | None, or a couple of happy-path unit tests | Test pyramid targeting the graded risk areas (stream filter correctness, memory bound, API contract) | Prioritize tests that directly exercise graded criteria over incidental coverage |
| Documentation | README only | README + ONBOARDING.md structured around the reviewer's own rubric | Mirror PROJECT.md's evaluation-criteria order in ONBOARDING.md structure |

## Sources

- [Make your Take-Home Coding Assignment stand out — Elia Bar, Medium](https://eliya-b.medium.com/make-your-take-home-coding-assignment-stand-out-477f6f1efa81)
- [Software Engineer Interview: Take-home Assignment — Stanislav Myachenkov](https://smyachenkov.com/posts/swe-interview-p2-take-home-assignment/)
- [Secrets from the Interview Room — BigPanda Engineering, Medium](https://medium.com/bigpanda-engineering/secrets-from-the-interview-room-what-reviewers-look-for-in-a-take-home-coding-assignment-1aaec70dabe0)
- [9 Tips to Ace Your Takehome Project — DEV Community](https://dev.to/gergelyorosz/9-insider-tips-to-ace-your-next-takehome-project-for-frontend-fullstack-and-mobile-interviews-41nn)
- [bfj — npm](https://www.npmjs.com/package/bfj)
- [How to stream big JSON files with low-memory footprint in Node.js](https://lepape.me/how-to-stream-big-json-files-with-low-memory-footprint-in-node-js/)
- [stream-json — GitHub](https://github.com/uhop/stream-json)
- [Preventing server-side request forgery in Node.js applications — Snyk](https://snyk.io/blog/preventing-server-side-request-forgery-node-js/)
- [SSRF Prevention in Node.js — OWASP Foundation](https://owasp.org/www-community/pages/controls/SSRF_Prevention_in_Nodejs)
- [How to Build a Graceful Shutdown Handler in Node.js — OneUptime](https://oneuptime.com/blog/post/2026-01-06-nodejs-graceful-shutdown-handler/view)
- [How to Implement Graceful Shutdown for BullMQ Workers — OneUptime](https://oneuptime.com/blog/post/2026-01-21-bullmq-graceful-shutdown/view)
- [Going to production — BullMQ docs](https://docs.bullmq.io/guide/going-to-production)
- [Deduplication — BullMQ docs](https://docs.bullmq.io/guide/jobs/deduplication)
- [Idempotent jobs — BullMQ docs](https://docs.bullmq.io/patterns/idempotent-jobs)
- [Concurrency — BullMQ docs](https://docs.bullmq.io/guide/workers/concurrency)
- [How to Implement Health Checks and Readiness Probes in Node.js — OneUptime](https://oneuptime.com/blog/post/2026-01-06-nodejs-health-checks-kubernetes/view)
- [Health Checks — nodeshift/nodejs-reference-architecture](https://github.com/nodeshift/nodejs-reference-architecture/blob/main/docs/operations/healthchecks.md)
- [How to Set Up Node.js CI Pipeline with GitHub Actions — OneUptime](https://oneuptime.com/blog/post/2025-12-20-github-actions-nodejs-ci/view)
- [GitHub Actions: Setting up Test Coverage for a JS/TS/Node project — Michael Zanggl](https://michaelzanggl.com/articles/github-actions-coverage-setup/)
- [Documentar tu API de Express con TypeScript usando OpenAPI (Swagger) — Analytics Lane](https://www.analyticslane.com/2025/10/21/documentar-tu-api-de-express-con-typescript-usando-openapi-swagger/)
- [Document a Node.js REST API with Swagger and Open API — Teric Cabrel](https://blog.tericcabrel.com/document-a-node-js-rest-api-with-swagger-and-open-api/)
- [Unit vs Integration vs E2E Testing: Testing Pyramid Decision Framework — Autonoma](https://getautonoma.com/blog/unit-vs-integration-vs-e2e-testing)
- [The Testing Pyramid: A Comprehensive Guide — TestRail](https://www.testrail.com/blog/testing-pyramid/)

---
*Feature research for: Async security-scanner wrapper service (Trivy take-home)*
*Researched: 2026-07-09*
