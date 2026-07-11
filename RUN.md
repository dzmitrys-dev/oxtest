# How to run — Code Guardian (Supply Chain Scanner)

A copy-paste quickstart. For the full architecture + design rationale see
[`README.md`](./README.md) and [`ONBOARDING.md`](./ONBOARDING.md).

**Prereqs:** Docker + Docker Compose. Nothing else — no host-side Node, Redis,
or Trivy install needed for the compose path.

---

## 1. Run the whole stack (one command)

```bash
git clone git@github.com:dzmitrys-dev/oxtest.git
cd oxtest
docker compose up --build
```

This starts **three services** — `redis` + `api` + `worker` — and serves the
REST API, GraphQL, and the React UI on one origin. The API listens on `:3000`
inside the container and is published on **host port `3100`**.

> Using a different host port? Edit the `api` `ports:` mapping in
> `docker-compose.yml` (e.g. `"3000:3000"`), then re-run.

### Open it

| URL | What |
| --- | --- |
| <http://localhost:3100/> | **React UI** — the repo field is prefilled with OWASP NodeGoat; click **Start scan** |
| <http://localhost:3100/graphiql> | **GraphQL playground** |
| <http://localhost:3100/health> | Liveness (`200` ok / `503` if Redis is down) |

### Try a real scan

Open <http://localhost:3100/> and click **Start scan** (the field defaults to
`https://github.com/OWASP/NodeGoat`). You'll watch it go
`Queued → Scanning → Finished` and list the **CRITICAL** vulnerabilities.

Or over the API:

```bash
# Enqueue (REST) → { "scanId": "...", "status": "Queued" }
curl -s -X POST http://localhost:3100/api/scan \
  -H 'content-type: application/json' \
  -d '{"repoUrl":"https://github.com/OWASP/NodeGoat"}'

# Poll (REST) — substitute the scanId above
curl -s http://localhost:3100/api/scan/<scanId>
```

Only `https://github.com/{owner}/{repo}` URLs are accepted (fail-closed
allowlist on both REST and GraphQL).

### Stop & clean up

```bash
docker compose down -v      # -v also reclaims the named `scans` volume
```

---

## 2. The memory self-test (the graded requirement)

The defining requirement is parsing a **500MB+** Trivy report without OOM under a
150MB heap. Needs Node 22.

```bash
npm ci
npm run build --workspace apps/api

# The PDF's verbatim self-test — boots the API under the 150MB heap:
node --max-old-space-size=150 apps/api/dist/index.js     # Ctrl-C to stop
npm run test:selftest --workspace apps/api               # automated equivalent

# The real 500MB-under-150MB-heap proof (peak heap stays ~65MB):
npm run test:memory-contract --workspace apps/api
# or the full multi-size sweep:
npm run memtest:sweep --workspace apps/api
```

> Note on the two entrypoints: `dist/index.js` is the API (what the PDF's
> self-test command boots); the **500MB parse actually runs in the worker**
> (`dist/worker.js`), which is the memory-critical process. See README §"the
> honest self-test mapping".

---

## 3. Tests

```bash
npm test --workspace apps/api                 # unit + integration (164 tests)
npm run test:acceptance --workspace apps/api   # end-to-end POST→scan→CRITICAL (needs Docker)
```

---

## 4. Local development (no Docker for the app)

Needs Node 22 and a reachable Redis; a real scan needs a local `trivy` binary or
Docker for the pinned image.

```bash
npm ci
# terminal 1 — Redis (or point REDIS_HOST/REDIS_PORT at your own)
docker run --rm -p 6379:6379 redis:7-alpine
# terminal 2 — API (REST + GraphQL + served UI), defaults to :3000
REDIS_HOST=localhost REDIS_PORT=6379 npm run start:api --workspace apps/api
# terminal 3 — worker
REDIS_HOST=localhost REDIS_PORT=6379 npm run start:worker --workspace apps/api
```

The API's local port is the `PORT` env var (default `3000`).
