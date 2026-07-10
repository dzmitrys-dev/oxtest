# CI Status Contract — Scan Engine

This document is the checked-in source of truth for the CI statuses produced
by [`.github/workflows/scan-engine.yml`](workflows/scan-engine.yml) and
[`.github/workflows/memory.yml`](workflows/memory.yml), and how they map to
branch-protection policy. It exists so the required-status configuration is
reviewable in-repo and cannot silently drift from the workflow.

## Statuses

| Status identifier              | When it runs                                   | Branch-protection policy                              |
| ------------------------------ | ---------------------------------------------- | ----------------------------------------------------- |
| `scan-engine-contract`         | **Always** (every push / pull request)         | **Required** — configure as a required status check. Also carries the Docker-free criterion-#5a self-test. |
| `scan-engine-integration`      | Only when the feasibility probe is `feasible`  | Required *by policy* **when it runs**; not dynamically required by GitHub when skipped. |
| `scan-engine-api-integration`  | Only when the feasibility probe is `feasible`  | Required *by policy* **when it runs**; skipped-with-reason otherwise. |
| `scan-engine-acceptance`       | Only when the feasibility probe is `feasible`  | Required *by policy* **when it runs**; skipped-with-reason otherwise. |
| `scan-engine-oom`              | Only when the feasibility probe is `feasible`  | Required *by policy* **when it runs**; skipped-with-reason otherwise. |
| `node-22-memory`               | **Always** (separate `memory.yml` workflow)    | **Required** — the Node-22 500MB memory proof (criterion #5b); untouched by this plan. |

### `scan-engine-contract` (always-required)

Runs on `ubuntu-latest` with Node 22 and performs, in order:

1. `npm ci` (lockfile-pinned install — no floating versions; T-03-13 / T-03-SC).
2. `npm run typecheck --workspace apps/api`.
3. `npm run lint --workspace apps/api`.
4. `npm run build --workspace apps/api`.
5. `npm run test:selftest --workspace apps/api` (Docker-FREE criterion-#5a
   self-test — see below).
6. `npm run test --workspace apps/api` (focused Jest unit suites).
7. `npm run test:scan-engine:contract --workspace apps/api` (Docker-free static
   process/command-safety contract).
8. `npm run scan-engine:feasibility --workspace apps/api` (the probe).

Every one of these gates **fails closed**: a non-zero step fails the job, so this
status turns red. It requires **no** Docker/Redis of its own (the static contract,
unit suites, and the self-test are self-contained), which is why it is safe to
require on every runner.

**Criterion #5a (Docker-free) is carried by this always-required status.** The
`test:selftest` step spawns the verbatim graded command
`node --max-old-space-size=150 dist/index.js` with `REDIS_PORT` pointed at a
CLOSED loopback port (no Docker, no reachable Redis), asserts the API prints
`API HTTP listener ready` while still alive, and asserts a clean SIGTERM exit
that is never `134`/`137` (no abort/OOM-kill). This is DISTINCT from the
Docker-backed `scan-engine-acceptance` case, which is a richer superset run over
real disposable infrastructure. Because the self-test needs no Docker, criterion
#5a holds even on a Docker-less runner.

### `scan-engine-integration` (conditional, Docker-backed)

Depends on `scan-engine-contract` and runs **only** when that job's `feasible`
output is exactly `true`. It builds the workspace and runs
`npm run test:scan-engine:integration --workspace apps/api`, which exercises the
real compiled `dist/worker.js` against a disposable Redis container and the
pinned Docker Trivy image (`ghcr.io/aquasecurity/trivy:0.69.3`). Any integration
failure fails the job closed.

### `scan-engine-api-integration` (conditional, Docker-backed)

Depends on `scan-engine-contract` and runs **only** when `feasible == 'true'`.
Runs `npm run test:api:integration --workspace apps/api` — the compiled REST
contract against `dist/index.js` + `dist/worker.js` over a disposable Redis
(previously wired nowhere; now gated in per D-11). Fails closed.

### `scan-engine-acceptance` (conditional, Docker-backed)

Depends on `scan-engine-contract` and runs **only** when `feasible == 'true'`.
Runs `npm run test:acceptance --workspace apps/api` — the assignment-level
end-to-end gate: happy `POST -> Finished` with the two pinned CRITICAL CVEs and
cleanup-on-success (criterion #1), forced-failure cleanup (criterion #1),
cross-process `scanId` correlation (criterion #3), and the richer Docker-path
criterion-#5 superset plus the 500MB memtest. Docker-gated cases inside the
harness skip-with-reason when Docker is absent; at the job level this whole
status runs only on a feasible runner. Fails closed.

### `scan-engine-oom` (conditional, Docker-backed)

Depends on `scan-engine-contract` and runs **only** when `feasible == 'true'`.
Runs `npm run test:oom:container --workspace apps/api` — the compose-driven
in-container OOM proof: the worker image runs the reused `dist/scripts/memtest.js`
against a >=500MB fixture under `--memory=200m` + `--max-old-space-size=150`, and
`docker inspect` MUST yield `false 0` (`OOMKilled == false` AND `ExitCode == 0`,
the Pitfall-2 false-negative guard — criterion #2). Fails closed on a real
memory regression; records a feasibility skip when Docker is unavailable.

### `node-22-memory` (always-required, separate workflow)

Produced by [`.github/workflows/memory.yml`](workflows/memory.yml), which is
**untouched** by this plan. It builds on Node 22 and runs the authoritative
512 MiB streaming-parse proof under `--max-old-space-size=150` (criterion #5b)
plus the bounded flat-RSS sweep. It remains a SEPARATE always-required gate,
independent of the feasibility probe.

## Feasibility probe semantics

`scan-engine-feasibility.mjs` always emits a machine-readable result (JSON on
stdout, an uploaded `scan-engine-feasibility.json` artifact, and the GitHub
Actions step outputs `feasible=true|false` and `reason=<text>`). Its three
outcomes are:

| Outcome                                             | Probe exit | `feasible` | Effect                                                                 |
| --------------------------------------------------- | ---------- | ---------- | ---------------------------------------------------------------------- |
| Prerequisites satisfied                             | `0`        | `true`     | All feasibility-gated jobs (`scan-engine-integration`, `-api-integration`, `-acceptance`, `-oom`) run and must pass. |
| Cleanly-determined infeasibility (e.g. no Docker daemon, image pull blocked, insufficient memory) | `0` | `false` | `scan-engine-contract` passes; every feasibility-gated job is **skipped** with the recorded `reason`. |
| Unexpected probe error (checks could not complete)  | `1`        | `false`    | `scan-engine-contract` **fails closed** — an unknown state is never treated as success. |

## Policy notes (do not over-promise GitHub semantics)

- Only `scan-engine-contract` (always-run) and `node-22-memory` (always-run,
  `memory.yml`) are safe to mark **required** in branch protection, because they
  always run. A skipped feasibility-gated job does **not** report a status, and
  GitHub cannot make a not-reported check block a merge.
- The always-required `scan-engine-contract` status now ALSO covers the
  Docker-free `dist/index.js` @150 boot self-test (criterion #5a) — distinct from
  the Docker-backed `scan-engine-acceptance` case, which is a richer superset.
- `node-22-memory` remains the SEPARATE always-required Node-22 500 MB memory
  proof (criterion #5b) in `memory.yml`, unchanged by this plan.
- Therefore `scan-engine-integration`, `scan-engine-api-integration`,
  `scan-engine-acceptance`, and `scan-engine-oom` are treated as
  **required-when-run by team policy**: reviewers must not merge a PR where any
  of them ran and failed. GitHub does not dynamically enforce this on skipped
  runs, and this document does not claim it does.
- No integration/acceptance/OOM result is ever treated as success on an unknown
  probe state: the probe fails the always-run contract job closed (exit 1) in
  that case.
