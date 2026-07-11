# Code Guardian — Supply Chain Scanner

Submit a GitHub repository URL, get an asynchronous security scan that clones the
repo, runs [Trivy](https://trivy.dev/), and **stream-parses a 500MB+ Trivy JSON
report to extract only `CRITICAL` vulnerabilities — inside a 256MB RAM budget,
under a hard `--max-old-space-size=150` V8 heap cap.** Memory efficiency is the
explicit pass/fail axis of this project: the report is never loaded with
`fs.readFile`/`JSON.parse`; it flows through a `stream-json` pipeline whose peak
RSS stays flat regardless of input size.

Built on **NestJS 11 (Fastify adapter)** with a **BullMQ/Redis** work queue, a
**code-first GraphQL** surface (Mercurius) alongside REST, and a **React (Vite)**
status UI — all served from one process on one port.

> **Why this design?** This README tells you how to *run* the service. For the
> full *what / why / how* of every decision — the memory strategy, the streaming
> pipeline, the two-entrypoint topology, the queue, error handling, type safety,
> the Trivy socket-mount trade-off, the testing strategy, and the
> NestJS-vs-Fastify tension — read **[ONBOARDING.md](./ONBOARDING.md)**.

---

## Quick start — `docker compose up` (primary path)

One command brings up the entire stack — **no host-side Trivy or Redis install
required**:

```bash
docker compose up --build
```

This starts exactly **three services** — `redis` + `api` + `worker` — and serves
everything on a single origin:

| URL | What |
| --- | --- |
| <http://localhost:3000/> | **React status UI** (submit a repo URL, watch it scan, see CRITICAL results) |
| <http://localhost:3000/graphiql> | **Interactive GraphQL playground** (run the mutation + query by hand) |
| `POST http://localhost:3000/api/scan` | **REST** — enqueue a scan |
| `GET  http://localhost:3000/api/scan/:scanId` | **REST** — poll a scan |
| `GET  http://localhost:3000/health` | Liveness (200 healthy / 503 when Redis is down) |

The **worker** reaches the security scanner as a *sibling container* through the
mounted Docker socket, invoking the pinned image
`ghcr.io/aquasecurity/trivy:0.69.3` — so you do **not** install Trivy on the
host. The clone/scan workdir is a named `scans` volume shared into the sibling
via `--volumes-from` (see ONBOARDING topic 7); reclaim it with
`docker compose down -v`. The worker runs under `node --max-old-space-size=150`
and is capped at `mem_limit: 200m` (with `memswap_limit: 200m`, so the cap is a
true RAM ceiling).

Configuration is by environment variable **name** only (values shown are the
compose defaults, no secrets): `PORT`, `REDIS_HOST`, `REDIS_PORT`,
`SCAN_TMP_DIR`, `TRIVY_MODE`, `NODE_ENV`.

### Try a real scan (OWASP NodeGoat demo)

With the stack up, open <http://localhost:3000/> and submit the deliberately
vulnerable **OWASP NodeGoat** repository, or drive it over the API:

```bash
# 1) Enqueue a scan (REST). Returns 202 { "scanId": "...", "status": "Queued" }
curl -s -X POST http://localhost:3000/api/scan \
  -H 'content-type: application/json' \
  -d '{"repoUrl":"https://github.com/OWASP/NodeGoat"}'

# 2) Poll it (REST). Substitute the scanId from step 1.
curl -s http://localhost:3000/api/scan/<scanId>
# -> { "scanId": "...", "status": "Finished", "criticalVulnerabilities": [ ... ] }
```

Or the same thing over **GraphQL** at `/graphiql`:

```graphql
mutation { enqueueScan(repoUrl: "https://github.com/OWASP/NodeGoat") { id status } }

query { scan(id: "<scanId>") {
  id status
  criticalVulnerabilities { vulnerabilityId pkgName installedVersion severity title primaryUrl }
} }
```

> **Substitute your own fork here.** The default target is the upstream
> `https://github.com/OWASP/NodeGoat`. Point it at **your fork** (or any public
> GitHub repo) by replacing the URL — the only accepted shape is
> `https://github.com/{owner}/{repo}` (validated by a fail-closed allowlist on
> both the REST and GraphQL paths).

---

## Local development (secondary path)

Requires **Node 22** (`.nvmrc` = 22, `engines: ">=22 <23"`), a reachable Redis,
and — for a real scan — either a local `trivy` binary or Docker for the pinned
image fallback.

```bash
# Install all workspaces (apps/api + apps/web) from the root lockfile
npm ci

# Build everything: the React SPA + the API/worker (dist/index.js, dist/worker.js,
# and the served UI at apps/api/dist/web)
npm run build:all

# Run the two entrypoints (separate terminals) against a running Redis
npm run start:api      # node dist/index.js   — REST + GraphQL + served UI on :3000
npm run start:worker   # node dist/worker.js  — the memory-critical scan worker
```

Watch-mode dev loop (TypeScript via `tsx`, no build step):

```bash
npm run dev:api        # tsx watch src/index.ts
npm run dev:worker     # tsx watch src/worker.ts
npm run dev --workspace apps/web   # Vite dev server; proxies /graphql -> :3000
```

`npm run build` (root) builds the API workspace only (the CI path). `build:all`
additionally builds `apps/web` and folds it into the served UI.

---

## Memory self-test — the pass/fail proof

The defining requirement is processing a **500MB+** Trivy report without OOM under
a **150MB** heap. Prove it directly:

```bash
# Generate a 500MB+ synthetic Trivy-shaped JSON fixture (streamed to disk)
npm run gen:fixture --workspace apps/api

# Run the streaming parser against it under the 150MB heap cap; logs peak RSS/heapUsed
npm run memtest --workspace apps/api

# Sweep multiple fixture sizes (50MB / 200MB / 500MB / 1GB) and assert peak RSS
# stays in a flat band — memory must NOT scale with input
npm run memtest:sweep --workspace apps/api
```

### Honest self-test mapping — `index.js` vs `worker.js`

The assignment's literal self-test command is:

```bash
node --max-old-space-size=150 dist/index.js
```

Run verbatim, this **boots the API process** (REST + GraphQL + served UI) under
the 150MB heap and confirms it starts cleanly — proven by:

```bash
npm run test:selftest --workspace apps/api   # scripts/selftest-index-boot.mjs
```

But `dist/index.js` **does not itself parse a 500MB report** — by design, the
memory-critical stream-parse runs in the **worker** process, `dist/worker.js`
(compose runs it as `node --max-old-space-size=150 dist/worker.js`). The
**honest 500MB proof** is therefore the standalone parser **`memtest` against the
500MB fixture** above, which exercises exactly the code path the worker runs. We
document this split rather than hiding it: the verbatim command proves the API
boots under the cap; the `memtest` proves the parse survives 500MB under the cap.

---

## Assignment acceptance gate

The end-to-end submission proof — `POST /api/scan → Queued → worker scan → poll →
CRITICAL results`, with clone/report cleanup verified on both success and forced
failure — runs over a disposable Redis and the pinned Docker Trivy:

```bash
npm run test:acceptance --workspace apps/api
```

Related packaging proofs:

```bash
npm run test:oom:container --workspace apps/api   # in-container OOMKilled==false + exit 0
npm run test:serve-static  --workspace apps/api   # SPA served at / while /api,/health,/graphql,/graphiql bypass it
```

---

## Architecture overview

Two Node entrypoints share one `ScanService`. The **API process**
(`dist/index.js`) serves the SPA, GraphQL, and REST; the **worker process**
(`dist/worker.js`) is the memory-critical one that clones, scans, and
stream-parses. GraphQL and the static SPA are **API-process-only** — the worker
heap never loads them.

```
   Browser ── GET / ───────────────►┌───────────────────────────────────────────┐
   (React SPA, urql, 2s poll)       │  API process  ·  dist/index.js              │
        │                           │  NestFactory + FastifyAdapter               │
        │  POST /graphql            │                                             │
        │  (enqueueScan mutation)   │   ServeStaticModule ──► apps/api/dist/web   │
        ▼                           │     (excludes /api /health /graphql         │
   REST clients ── POST/GET ───────►│      /graphiql)                             │
   /api/scan, /api/scan/:id         │                                             │
   GET /health                      │   GraphQL (MercuriusDriver) /graphql        │
                                    │     ScanResolver (thin, ARCH-01)            │
                                    │   ScanController  (thin, ARCH-01)           │
                                    │            │                                │
                                    │            ▼                                │
                                    │        ScanService  (enqueue / get)         │
                                    └──────┬──────────────────┬───────────────────┘
                                  BullMQ add │                │ ScanRepository.get
                                             ▼                ▼
                                   ┌────────────────────────────────┐
                                   │            Redis               │
                                   │   job queue + scan records     │
                                   └────────────────────────────────┘
                                             ▲                ▲
                                  consume job │                │ persist status + CRITICAL vulns
                                    ┌─────────┴────────────────┴──────────────────┐
                                    │  Worker process  ·  dist/worker.js          │
                                    │  --max-old-space-size=150 · mem_limit 200m  │
                                    │                                             │
                                    │  git clone ─► Trivy (sibling container via  │
                                    │  Docker socket) ─► stream-json parse        │
                                    │  (CRITICAL only, flat RSS) ─► Redis         │
                                    │  ─► try/finally cleanup (clone dir + report)│
                                    │  NO GraphQL · NO SPA  (heap stays lean)     │
                                    └─────────────────────────────────────────────┘
```

- **Thin edges, one service (ARCH-01):** both the REST controller and the GraphQL
  resolver only delegate to `ScanService` — no scan logic lives in the transport.
- **One Fastify listener:** REST + GraphQL + static SPA share a single process and
  port — no second server, protecting the graded memory budget.
- **The worker is the memory-critical process.** It is the only one that touches a
  500MB report, and it does so through the streaming pipeline under the 150MB cap.

For the reasoning behind each of these — and the rejected alternatives — see
**[ONBOARDING.md](./ONBOARDING.md)**.

---

## Requirements

- **Node 22** (`.nvmrc` = 22)
- **Docker + docker compose** for the primary run path and the acceptance/OOM proofs
- **Redis** (provided by compose; a reachable instance for local dev)
- **Trivy** is *not* required on the host — the worker uses the pinned
  `ghcr.io/aquasecurity/trivy:0.69.3` image via the Docker socket, or a local
  `trivy` binary if one is detected
