# Phase 5: Packaging, Ops & Assignment Acceptance - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-10
**Phase:** 5-Packaging, Ops & Assignment Acceptance
**Areas discussed:** Logging correlation, Docker scope & sequencing, Acceptance gate shape, CI gating strategy

---

## Logging correlation (OPS-04)

### Mechanism
| Option | Description | Selected |
|--------|-------------|----------|
| pino via EngineLogger port | pino adapter satisfying existing port; per-job `pino.child({scanId})`; no ALS lib | ✓ |
| nestjs-pino + nestjs-cls (ALS) | Full ALS context; overkill given worker has no HTTP lifecycle + engine already receives an injected logger | |
| Extend Nest built-in Logger | Custom transport on Nest Logger; reinvents what pino gives free | |

**User's choice:** pino via EngineLogger port.
**Notes:** Research confirmed `AsyncLocalStorage` cannot cross the Redis queue hop; `scanId` rides the job payload (already `{scanId, repoUrl}`) and is re-established at the top of the worker's `process(job)`.

### Port shape
| Option | Description | Selected |
|--------|-------------|----------|
| Widen to info/debug | Add info(+debug) to EngineLogger + noop default in one change; enables scanId'd lifecycle lines | ✓ |
| Keep warn/error only | Emit lifecycle lines outside the engine; scatters correlated logging | |

**User's choice:** Widen to info/debug.
**Notes:** Needed for criterion #3 (trace a scan across both processes).

### Log format
| Option | Description | Selected |
|--------|-------------|----------|
| JSON always; pretty dev-only | NDJSON in container/CI/prod; pino-pretty behind dev flag; include pid+scanId | ✓ |
| JSON everywhere, no pretty | Never load pino-pretty at all | |

**User's choice:** JSON always; pretty dev-only.
**Notes:** Never ship a pino transport into the container (worker-thread RSS under the memory limit).

---

## Docker scope & sequencing (OPS-01/02, criterion #2)

### Scope
| Option | Description | Selected |
|--------|-------------|----------|
| Build full compose now | compose (redis+api+worker) + slim Dockerfiles + mem_limit:200m + in-container OOM proof this phase | ✓ |
| Required-only; defer Docker to P6 | Phase 5 = logging + CI + acceptance on bare node; Docker to Phase 6 | |
| Build artifacts, gate proof by feasibility | Author Dockerfiles+compose, feasibility-gate the OOM proof | |

**User's choice:** Build full compose now.
**Notes:** Matches the phase name "Packaging" and satisfies criterion #2 directly. Consequence: OPS-01/OPS-02 pulled forward from Phase 6 Bonus C into Phase 5 — ROADMAP/REQUIREMENTS traceability to be re-mapped.

### Trivy in compose
| Option | Description | Selected |
|--------|-------------|----------|
| Host Docker socket mount | Worker runs pinned trivy:0.69.3 as sibling via existing adapter; document trade-off | ✓ |
| Trivy as its own compose service | Cleaner isolation; requires shared-volume + network/exec wiring, diverges from adapter | |
| Decide during planning | Both viable | |

**User's choice:** Host Docker socket mount.
**Notes:** Reuses the existing local-detect + Docker-fallback code path unchanged; keeps the app image lean.

---

## Acceptance gate shape (criteria #1 & #5)

### Gate form
| Option | Description | Selected |
|--------|-------------|----------|
| node:test harness + npm script | `.mjs` harness + `test:acceptance`; matches compiled-dist + node:test pattern (dodges Jest landmine) | ✓ |
| Shell script (scripts/acceptance.sh) | Transparent for a reviewer; shell-level assertions, duplicates orchestration | |
| Both: thin shell over node:test | Reviewer entry + code assertions; more surface | |

**User's choice:** node:test harness + npm script.

### Gate target
| Option | Description | Selected |
|--------|-------------|----------|
| Compiled dist + real Redis + real Trivy | Full fidelity; POST→Queued→scan→poll→CRITICAL + cleanup on success AND forced failure; feasibility-gated | ✓ |
| Compiled dist + real Redis + mocked Trivy | Faster/always-runnable; loses real-CVE fidelity | |

**User's choice:** Compiled dist + real Redis + real Trivy.

### Self-test mapping (criterion #5)
| Option | Description | Selected |
|--------|-------------|----------|
| Two-part proof | (a) index.js boots under 150MB; (b) 500MB parse under 150MB in worker path (reuse Phase 2 memtest); README documents mapping | ✓ |
| Boot-only on index.js | Just prove index.js boots; cite Phase 2 memtest separately | |
| Decide during planning | Endpoint clear; planner picks worker-side proof mechanism | |

**User's choice:** Two-part proof.

---

## CI gating strategy (OPS-05, criterion #4)

### CI layout
| Option | Description | Selected |
|--------|-------------|----------|
| Extend scan-engine.yml + keep memory.yml | Add REST-contract + acceptance jobs to existing workflow; update CI-CONTRACT.md; memory.yml stays separate required gate | ✓ |
| New dedicated acceptance.yml | Separate workflow; third status to keep in sync | |
| Decide during planning | Endpoint clear; planner picks topology | |

**User's choice:** Extend scan-engine.yml + keep memory.yml.
**Notes:** `test:api:integration` exists but is currently ungated in CI — wire it in.

### Required status
| Option | Description | Selected |
|--------|-------------|----------|
| Tiered like today | Docker-free = always-required; Redis/Docker/Trivy-backed = feasibility-gated (required-when-run, skip-with-reason, fail-closed-on-unknown) | ✓ |
| Make everything hard-required | All jobs required including Docker-backed; fails closed on Docker-less runners | |

**User's choice:** Tiered like today.

### Phase-4 review warnings
| Option | Description | Selected |
|--------|-------------|----------|
| Fold in as hardening | Address the 3 04-REVIEW warnings in Phase 5 (packaging/ops-adjacent) | ✓ |
| Leave for separate /gsd-code-review --fix | Keep Phase 5 strictly on OPS-04/05 + acceptance | |

**User's choice:** Fold in as hardening.
**Notes:** URL pipe raw-string forwarding; SHUTDOWN_GRACE_MS max vs Docker window; missing REDIS_CLIENT error listener.

---

## Claude's Discretion

- File names/layout for the pino adapter, acceptance harness, and Dockerfiles.
- Whether the in-container OOM proof lives in the acceptance harness or a dedicated compose CI step (must assert OOMKilled:false AND exit 0, surface peak RSS).
- Log level defaults and bound-field set beyond scanId/pid; whether `debug` ships now.
- Compose healthcheck wiring against `/health`, `.dockerignore`, image-size targets.
- Whether the worker-side 500MB proof reuses `memtest.js` as-is or runs through a booted `dist/worker.js`.
- Exact CI job names/topology within the extend-`scan-engine.yml` decision.

## Deferred Ideas

- GraphQL query + mutation (API-01/02) — Phase 6 / Bonus B.
- React (Vite) polling frontend (FE-01..03) — Phase 6 / Bonus A.
- README.md + ONBOARDING.md (DOC-01/02) — Phase 6.
- CORS for the frontend — Phase 6, if cross-origin.
- `--max-semi-space-size` / young-gen tuning — only if in-container RSS profiling shows pressure.
- Rate limiting / auth / request-dedup — out of scope (v2).
