# Phase 3: Scan Engine - Adapters, Queue, Worker & Service - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in `03-CONTEXT.md`; this log preserves the alternatives considered.

**Date:** 2026-07-10
**Phase:** 3 - Scan Engine - Adapters, Queue, Worker & Service
**Areas discussed:** Redis retention, Trivy fallback, Failure semantics, Integration tests

---

## Redis retention

| Option | Description | Selected |
|--------|-------------|----------|
| 24-hour TTL | Bounds memory while leaving time to inspect results. | |
| 7-day TTL | More review/debug time with bounded Redis retention. | ✓ |
| No expiry | Unbounded retention; not specified by the assignment. | |

**User's choice:** 7-day TTL.
**Notes:** Use a hash for metadata and an ordered Redis list for vulnerabilities. Preserve insertion order, return an empty list for no findings, refresh TTL on writes, guard terminal states, return null for missing scans, use one full get contract, and make transition/TTL writes atomic.

---

## Trivy fallback

| Option | Description | Selected |
|--------|-------------|----------|
| Pin a reviewed version | Reproducible Docker fallback; planner selects a current reviewed tag. | ✓ |
| Use `latest` | Lowest maintenance but mutable behavior. | |
| Fallback only when absent | Docker only when local binary is missing. | |
| Fallback on launch failure | Docker on local missing/launch failure, not after a genuine scan failure. | ✓ |
| Always Docker | Maximum environment consistency but requires Docker. | |
| Read-only clone + writable report | Mount clone read-only and report parent writable. | ✓ |
| Single shared root | Mount one shared scan root. | |
| Persistent cache volume | Faster repeat scans but adds state and lifecycle. | |
| Ephemeral cache | Fresh per-scan cache and stateless fallback. | ✓ |

**User's choice:** Reviewed pinned image; fallback on local launch failure; read-only clone plus writable report mount; ephemeral cache.
**Notes:** Commands remain argv-safe with `shell: false`; Trivy writes JSON to a mounted report file with `--exit-code 0`.

---

## Failure semantics

| Option | Description | Selected |
|--------|-------------|----------|
| No automatic retry | Persist Failed and rethrow; retry policy remains deferred. | ✓ |
| One retry | Retry transient failures once. | |
| Bounded category + detail | Specific category plus sanitized detail capped at 500 characters. | ✓ |
| Category only | Safe but less diagnostic. | |
| Raw stderr | Diagnostic but risks leaking sensitive details. | |
| Separate diagnostics | Log detailed stderr while Redis keeps the bounded public reason. | ✓ |
| Same bounded reason | Use one reason for state and logs. | |
| Preserve original | Cleanup failures are secondary; original failure remains persisted. | ✓ |
| Findings are success | Force Trivy exit code 0; only genuine tool failures fail. | ✓ |

**User's choice:** No automatic retries; bounded category/detail; separate detailed diagnostics; preserve the original failure over cleanup errors; vulnerability findings are successful scans.
**Notes:** Categories must distinguish clone, Trivy, ENOSPC, and parse failures. Mark Finished only after all parser results are persisted.

---

## Integration tests

| Option | Description | Selected |
|--------|-------------|----------|
| Fakes + Redis | Fake adapters plus real Redis state. | |
| All Docker-backed | Real Docker Trivy/Redis path. | ✓ |
| Mostly fakes | Fast but weaker integration proof. | |
| Docker Trivy fallback | Proves the no-local-Trivy path and mounts. | ✓ |
| Local Trivy binary | Tests only the host installation. | |
| Both paths | Maximum coverage with more setup. | |
| Test seams | Inject deterministic failures through adapters in the real worker/Redis harness. | ✓ |
| Faulty containers | Induce failures through external environment faults. | |
| Mixed approach | Combine seams and environment faults. | |
| Full lifecycle | Assert status, bounded reasons, and artifact absence on every path. | ✓ |
| Status + cleanup | Flexible reason assertions. | |
| Smoke only | Minimal worker/result assertion. | |
| Committed fixture repo | Avoid live network and mutable repository behavior. | ✓ |
| Ephemeral Redis container | Disposable service container for the test command. | ✓ |
| Compiled worker process | Exercise `dist/worker.js` through BullMQ/Redis. | ✓ |

**User's choice:** Use a committed local fixture, Docker Trivy fallback, disposable Redis, compiled worker process, deterministic adapter-seam failures, and full lifecycle assertions. Make it a required GitHub Actions gate only if feasible on free GitHub-hosted runners; otherwise keep and document a named explicit integration command.

---

## the agent's Discretion

- Exact class, token, file, queue, Redis field, and test script names.
- Exact reviewed Trivy image tag and atomic Redis implementation mechanism.
- Exact bounded reason vocabulary and redaction details within the locked safety constraints.

## Deferred Ideas

- REST and GraphQL transport, URL validation, health, and API lifecycle: later phases.
- Automatic retry/backoff, deduplication, timeouts, and dead-letter handling: future work.
- Docker Compose packaging and container-level memory proof: later packaging scope.
- Persistent Trivy cache and retention management beyond seven days: future operational work.
