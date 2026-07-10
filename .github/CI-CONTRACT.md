# CI Status Contract — Scan Engine

This document is the checked-in source of truth for the two CI statuses produced
by [`.github/workflows/scan-engine.yml`](workflows/scan-engine.yml) and how they
map to branch-protection policy. It exists so the required-status configuration
is reviewable in-repo and cannot silently drift from the workflow.

## Statuses

| Status identifier          | When it runs                                   | Branch-protection policy                              |
| -------------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| `scan-engine-contract`     | **Always** (every push / pull request)         | **Required** — configure as a required status check.  |
| `scan-engine-integration`  | Only when the feasibility probe is `feasible`  | Required *by policy* **when it runs**; not dynamically required by GitHub when skipped. |

### `scan-engine-contract` (always-required)

Runs on `ubuntu-latest` with Node 22 and performs, in order:

1. `npm ci` (lockfile-pinned install — no floating versions; T-03-13 / T-03-SC).
2. `npm run typecheck --workspace apps/api`.
3. `npm run lint --workspace apps/api`.
4. `npm run build --workspace apps/api`.
5. `npm run test --workspace apps/api` (focused Jest unit suites).
6. `npm run test:scan-engine:contract --workspace apps/api` (Docker-free static
   process/command-safety contract).
7. `npm run scan-engine:feasibility --workspace apps/api` (the probe).

Every one of these gates **fails closed**: a non-zero step fails the job, so this
status turns red. It requires **no** Docker/Redis of its own (the static contract
and unit suites are self-contained), which is why it is safe to require on every
runner.

### `scan-engine-integration` (conditional, Docker-backed)

Depends on `scan-engine-contract` and runs **only** when that job's `feasible`
output is exactly `true`. It builds the workspace and runs
`npm run test:scan-engine:integration --workspace apps/api`, which exercises the
real compiled `dist/worker.js` against a disposable Redis container and the
pinned Docker Trivy image (`ghcr.io/aquasecurity/trivy:0.69.3`). Any integration
failure fails the job closed.

## Feasibility probe semantics

`scan-engine-feasibility.mjs` always emits a machine-readable result (JSON on
stdout, an uploaded `scan-engine-feasibility.json` artifact, and the GitHub
Actions step outputs `feasible=true|false` and `reason=<text>`). Its three
outcomes are:

| Outcome                                             | Probe exit | `feasible` | Effect                                                                 |
| --------------------------------------------------- | ---------- | ---------- | ---------------------------------------------------------------------- |
| Prerequisites satisfied                             | `0`        | `true`     | `scan-engine-integration` runs and must pass.                          |
| Cleanly-determined infeasibility (e.g. no Docker daemon, image pull blocked, insufficient memory) | `0` | `false` | `scan-engine-contract` passes; `scan-engine-integration` is **skipped** with the recorded `reason`. |
| Unexpected probe error (checks could not complete)  | `1`        | `false`    | `scan-engine-contract` **fails closed** — an unknown state is never treated as success. |

## Policy notes (do not over-promise GitHub semantics)

- Only `scan-engine-contract` is safe to mark **required** in branch protection,
  because it always runs. A skipped `scan-engine-integration` does **not** report
  a status, and GitHub cannot make a not-reported check block a merge.
- Therefore `scan-engine-integration` is treated as **required-when-run by team
  policy**: reviewers must not merge a PR where it ran and failed. GitHub does not
  dynamically enforce this on skipped runs, and this document does not claim it
  does.
- No integration result is ever treated as success on an unknown probe state:
  the probe fails the always-run contract job closed (exit 1) in that case.
