# Phase 4: Required REST API & Runtime Lifecycle - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-10
**Phase:** 4-Required REST API & Runtime Lifecycle
**Areas discussed:** URL validation policy, Response contracts, /health check depth, Graceful shutdown behavior

---

## URL validation policy (SCAN-02)

### Which repo URL forms to accept
| Option | Description | Selected |
|--------|-------------|----------|
| HTTPS github.com only | Only `https://github.com/{owner}/{repo}(.git)`; reject SSH, git://, file://, other hosts | ✓ |
| HTTPS + SSH github.com | Also accept `git@github.com:owner/repo.git` | |
| Any github.com transport | Any protocol as long as host resolves to github.com | |

### How strict the host + path check should be
| Option | Description | Selected |
|--------|-------------|----------|
| Parse + exact host allowlist + path shape | URL-parse, https-only, host in {github.com,www.github.com}, reject userinfo/odd ports, require /{owner}/{repo} | ✓ |
| Host allowlist only | Parse + hostname===github.com, no path-shape enforcement | |

### Where validation lives
| Option | Description | Selected |
|--------|-------------|----------|
| DTO + ValidationPipe at controller | 400 before ScanService is called; keeps controller thin | ✓ |
| Shared validator function | Framework-free helper reusable by GraphQL; manual 400 wiring | |

**User's choice:** HTTPS-only + strict parse/allowlist/path-shape + controller-level DTO validation.
**Notes:** Defense-in-depth on top of Phase 3's `shell:false` argv clone; the strict path shape rejects look-alike hosts, embedded credentials, odd ports, and single-segment paths.

---

## Response contracts (SCAN-01, 03, 04, 05)

### POST /api/scan success code + body
| Option | Description | Selected |
|--------|-------------|----------|
| 202 Accepted, {scanId, status} | Precise async "queued, not processed" semantic; body exactly {scanId,status:'Queued'} | ✓ |
| 201 Created, {scanId, status} | Frames scan as created resource | |
| 202, richer body | 202 + repoUrl + createdAt | |

### GET /api/scan/:id per-state shape
| Option | Description | Selected |
|--------|-------------|----------|
| State-shaped DTO, 200 (404 unknown) | Fields vary by state; Finished adds criticalVulnerabilities, Failed adds error; unknown→404 | ✓ |
| Uniform full DTO, 200 | Same full shape always with empty/null fields | |

### Failed error body
| Option | Description | Selected |
|--------|-------------|----------|
| Both category + detail | error:{category,detail} — bounded enum + ≤500-char sanitized message | ✓ |
| Detail string only | Flat error:'<detail>' string | |

**User's choice:** 202 + exact `{scanId,status}`; state-shaped 200 with 404 for unknown; full `{category,detail}` error.
**Notes:** Finished field named `criticalVulnerabilities` to match future GraphQL `type Scan` (API-01) for REST/GraphQL consistency.

---

## /health check depth (API-03)

### How to probe Redis
| Option | Description | Selected |
|--------|-------------|----------|
| Active PING via existing conn | Reuse BullMQ/repository ioredis connection, issue PING with short timeout | ✓ |
| Passive .status check | Read ioredis connection.status === 'ready' | |

### Status code when Redis unreachable
| Option | Description | Selected |
|--------|-------------|----------|
| 503 unhealthy / 200 healthy | Orchestrator/LB can key off the code; sets up Phase 5 packaging | ✓ |
| Always 200 + status field | Caller inspects body only | |

### Scope beyond Redis
| Option | Description | Selected |
|--------|-------------|----------|
| Redis + basic service info | {status, redis, uptime}; no Trivy/Docker probe | ✓ |
| Redis-only, minimal | Just {status, redis} | |

**User's choice:** Active PING (short timeout) over an existing connection; 503/200; body `{status, redis, uptime}`.
**Notes:** No third Redis client — borrow the queue's or repository's handle. Trivy/Docker are per-scan concerns, not liveness.

---

## Graceful shutdown behavior (ERR-05)

### In-flight scan handling on SIGTERM/SIGINT
| Option | Description | Selected |
|--------|-------------|----------|
| Drain: finish, no new jobs | worker.close() — stop new, await active, then exit | ✓ |
| Abort + mark, then exit | worker.close(true); job re-runs on restart | |
| Drain with re-queue fallback | Drain, on timeout force-close + re-deliver | |

### Drain timeout bounding
| Option | Description | Selected |
|--------|-------------|----------|
| Configurable grace, then force-close | SHUTDOWN_GRACE_MS (~8s default, under Docker's 10s SIGKILL) then force-close | ✓ |
| Unbounded (rely on SIGKILL) | Await active job with no timeout | |

### Shutdown wiring
| Option | Description | Selected |
|--------|-------------|----------|
| Nest lifecycle hooks, both entrypoints | enableShutdownHooks + OnApplicationShutdown/onModuleDestroy | ✓ |
| Manual signal handlers | process.on('SIGTERM'/'SIGINT') in entrypoints | |

**User's choice:** Drain the active scan (bounded by configurable grace, then force-close) wired via Nest lifecycle hooks on both API and worker.
**Notes:** Phase 3 `try/finally` cleanup still removes artifacts even under force-close. API path is lighter (producer only — stop accepting + close handles).

---

## Claude's Discretion

- Exact controller/DTO file names and directory layout under `apps/api/src`.
- GitHub owner/repo naming regex, PING timeout value, which ioredis handle `/health` borrows.
- Validation mechanism (class-validator vs custom pipe vs framework-free helper), global vs per-controller `ValidationPipe`, and 400 error-envelope shape.
- Exact `SHUTDOWN_GRACE_MS` default/casing, provided it is configurable, schema-validated, and under the container SIGKILL window.

## Deferred Ideas

- Integration-test strategy details (compiled-worker + disposable Redis vs in-process fake queue; CI-gating) — offered but deferred to researcher/planner.
- GraphQL query + mutation (API-01/02) — Phase 6 / Bonus B.
- `scanId` log correlation (OPS-04) — Phase 5.
- Docker Compose packaging + container healthcheck (OPS-01/02) — Phase 5.
- CORS for the React frontend (FE) — Phase 6.
- Rate limiting / auth / request-dedup — out of scope.
