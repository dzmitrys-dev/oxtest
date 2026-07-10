---
phase: 05-packaging-ops-assignment-acceptance
reviewed: 2026-07-10T00:00:00Z
depth: standard
files_reviewed: 21
files_reviewed_list:
  - apps/api/package.json
  - apps/api/scripts/acceptance.mjs
  - apps/api/scripts/docker-oom-proof.mjs
  - apps/api/scripts/selftest-index-boot.mjs
  - apps/api/src/config/env.validation.spec.ts
  - apps/api/src/config/env.validation.ts
  - apps/api/src/engine/pino-logger.adapter.spec.ts
  - apps/api/src/engine/pino-logger.adapter.ts
  - apps/api/src/engine/scan-engine.ts
  - apps/api/src/engine/scan-worker.ts
  - apps/api/src/http/validation/github-url.pipe.ts
  - apps/api/src/http/validation/github-url.spec.ts
  - apps/api/src/scan/scan.module.ts
  - apps/api/src/scan/scan.service.spec.ts
  - apps/api/src/scan/scan.service.ts
  - apps/api/src/scan/scan.types.ts
  - apps/api/src/worker.module.ts
  - docker-compose.yml
  - Dockerfile
  - .dockerignore
  - .github/workflows/scan-engine.yml
findings:
  critical: 2
  warning: 5
  info: 2
  total: 9
status: issues_found
---

# Phase 5: Code Review Report

**Reviewed:** 2026-07-10
**Depth:** standard
**Files Reviewed:** 21
**Status:** issues_found

## Summary

Phase 5 packages the service and adds acceptance/OOM harnesses. The memory
discipline is sound (no shipped pino transport worker-thread; the OOM proof and
self-test correctly gate on both `OOMKilled==false` AND exit-0; `fs.readFile` /
`JSON.parse` are absent from the scan-result path), the pino/scanId logging seam
is correct and Jest-safe (no transitive `scan-worker.ts` import), and the WR/CR
hardening fixes (canonical URL reconstruction, git transport allowlist,
non-throwing Redis error listener, capped shutdown grace) are implemented as
described.

However, the shipped runtime image **cannot perform a scan**. The worker clones
with `git` and reaches Trivy with the `docker` CLI, but the `node:22-slim`
runtime installs neither binary and the Dockerfile runs no `apt-get`. The
documented "`docker compose up` works end-to-end" reviewer path — an explicit
pass criterion in the project brief — fails at the clone stage. This is invisible
to CI because every harness (`acceptance.mjs`, `docker-oom-proof.mjs`) spawns the
worker on the **host** (which has git/docker) or runs only the pure memtest, so a
green pipeline does not prove the image works. Two BLOCKERs and five WARNINGs
follow.

## Critical Issues

### CR-01: Runtime image has no `git` — every real scan fails at the clone stage

**File:** `Dockerfile:33-50`, `docker-compose.yml:58-81`, `apps/api/src/engine/repo-cloner.adapter.ts:54-67`
**Issue:** The `runtime` stage is `node:22-slim` (Debian slim, which does **not**
ship `git`) and the Dockerfile installs no OS packages. `RepoClonerAdapter.clone`
unconditionally spawns `git clone --depth 1 -- <url> <dir>` for every scan (the
engine calls `cloner.clone` before Trivy in `scan-engine.ts:138`). In the compose
worker container the `git` executable does not exist, so the spawn fails with
`ENOENT` and every scan terminates as `Failed(clone)`. The project brief requires
the docker-compose path to work end-to-end from the README; it cannot. This is
masked in CI because `acceptance.mjs` spawns `dist/worker.js` via
`process.execPath` on the host runner (which has git), never inside the built
image.
**Fix:** Install git (and, for CR-02, the Docker CLI) in the runtime stage:
```dockerfile
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
```
Add a test that exercises the scan path **inside** the built image (not the host)
so this class of regression is caught.

### CR-02: Runtime image has no `docker` CLI — the socket mount is inert, Trivy cannot run

**File:** `Dockerfile:33-50`, `docker-compose.yml:64-78`, `apps/api/src/engine/trivy-runner.adapter.ts:100-110,126-151`
**Issue:** The compose worker mounts `/var/run/docker.sock` and sets
`TRIVY_MODE: docker`, intending to reach Trivy as a sibling container. But
`TrivyRunnerAdapter` invokes the scanner with the `docker` **CLI** (`docker run
--rm ... ghcr.io/aquasecurity/trivy:0.69.3 ...`). `node:22-slim` does not include
the Docker CLI, and the Dockerfile installs none, so `docker` is `ENOENT`. The
adapter first tries the local `trivy` binary (also absent → `launchFailed`) then
falls back to `docker` (absent → fails). Mounting the socket without a client
binary grants privilege but no capability: the scanner can never be invoked from
the shipped image. (Clone fails first per CR-01, but even fixing git leaves this
broken.)
**Fix:** Install the Docker CLI in the runtime stage (client only is sufficient
for the socket), e.g. add `docker.io` or the `docker-ce-cli` package alongside the
CR-01 install. Alternatively install the `trivy` binary in the image and drop the
socket mount entirely (smaller attack surface — see WR-05). Whichever path is
chosen, add an in-image smoke test that runs one real scan.

## Warnings

### WR-01: `TRIVY_MODE` is validated and set but never read — dead, misleading config

**File:** `apps/api/src/config/env.validation.ts:59`, `docker-compose.yml:72`
**Issue:** `TRIVY_MODE` is validated (`binary|docker`, default `binary`) and the
compose worker sets `TRIVY_MODE: docker`, but no code reads it (grep across
`apps/api/src` finds the single definition in the schema and nothing else).
`TrivyRunnerAdapter` hard-codes "try local `trivy`, fall back to `docker` on
launch failure" and ignores the mode entirely. An operator setting
`TRIVY_MODE=docker` reasonably believes they are forcing the Docker path; they are
not. This dead knob also hides CR-02 (it reads like Docker mode is wired).
**Fix:** Either consume `TRIVY_MODE` in the adapter factory to select the runner
strategy explicitly (and force Docker when `docker`), or remove the env key and
the compose line so configuration matches behavior.

### WR-02: OOM proof and compose omit swap accounting — the 200m hard cap is not actually enforced

**File:** `apps/api/scripts/docker-oom-proof.mjs:145-151`, `docker-compose.yml:65`
**Issue:** The proof runs `docker run --memory=200m` (and compose sets
`mem_limit: 200m`) with **no** `--memory-swap` / `memswap_limit`. Docker's default
when only `--memory` is set allows swap up to `2 × memory`, so the container may
consume up to ~200m RAM **plus** ~200m swap before the kernel OOM-kills it. The
harness then asserts `OOMKilled==false && exitCode==0` and calls it a pass — but
that result no longer proves the worker stayed under a 200MB hard ceiling; it only
proves it stayed under 400MB of RAM+swap. The streaming parser likely keeps RSS
flat regardless, but the guarantee the proof claims to certify is weaker than
advertised.
**Fix:** Pin swap equal to memory so the cap is a true hard RAM limit:
```js
`--memory=${MEMORY_LIMIT}`, `--memory-swap=${MEMORY_LIMIT}`,
```
and add `memswap_limit: 200m` (or `mem_swappiness: 0`) to the compose worker.

### WR-03: `file` git transport is allowlisted unconditionally — production can enable local-file clone

**File:** `apps/api/src/config/env.validation.ts:11,79-81`
**Issue:** `GIT_TRANSPORT_ALLOWLIST = ['https', 'file']` permits
`SCAN_GIT_ALLOWED_PROTOCOLS=https:file` to pass validation **regardless of
NODE_ENV**. The comment asserts `file` is "exclusively for TRUSTED local
infrastructure," but nothing enforces that — a production deployment (or a
copy-pasted `.env`) can enable the `file` transport, and the worker clones the
job's `repoUrl` verbatim (`repo-cloner.adapter.ts`) with that
`GIT_ALLOW_PROTOCOL`. The HTTP pipe (`github-url.pipe.ts`) blocks `file://` at the
REST boundary, but the queue payload is the real trust boundary for the worker;
anything that can enqueue a `file:///…` path (or a future non-HTTP producer) gets
local-file disclosure. This is a defense-in-depth gap in a fail-closed schema.
**Fix:** Gate `file` behind non-production in the custom validator, e.g. reject any
token not in `['https']` when `process.env.NODE_ENV === 'production'`, so the
trusted-test widening cannot survive into a production boot.

### WR-04: `docker compose build` output can overflow spawnSync's default 1MB buffer → false build failure

**File:** `apps/api/scripts/docker-oom-proof.mjs:57-65,104-110`
**Issue:** `run()` uses `spawnSync(..., { stdio: ['ignore','pipe','pipe'] })` with
no `maxBuffer` override, so it defaults to 1MB. A `docker compose build worker`
(and, less often, `gen:fixture`) easily emits more than 1MB of stdout/stderr; when
the buffer is exceeded, Node kills the child, sets `result.error` (ENOBUFS) and a
null status, and the harness throws `"docker compose build worker failed"` even on
a successful build. This makes the OOM gate flaky / false-negative on verbose
builders.
**Fix:** Pass a generous `maxBuffer` (e.g. `maxBuffer: 64 * 1024 * 1024`) in the
`run()` options, or set `stdio: ['ignore','ignore','pipe']` for the build step
where stdout is not consumed.

### WR-05: Worker container mounts the host Docker socket → host-root from untrusted-repo processing

**File:** `docker-compose.yml:73-78`
**Issue:** The worker mounts `/var/run/docker.sock`, which is root-equivalent
control of the host Docker daemon. The worker's job is to clone attacker-supplied
GitHub repositories and run a scanner over their contents; any RCE in git/Trivy —
or a future bug that lets a non-github URL through — escalates directly to host
root via the socket. This is documented as an accepted single-tenant take-home
trade-off, so it is a WARNING rather than a BLOCKER, but it should be called out
explicitly and ideally removed.
**Fix:** Prefer installing the `trivy` binary directly in the image (see CR-02)
and dropping the socket mount, or if the sibling-container pattern is kept, mount
the socket read-only is **not** sufficient (the socket grants full control
regardless); use a socket-proxy that whitelists only `container create/run/rm` on
the pinned image, and document the residual risk for ONBOARDING.

## Info

### IN-01: Unused timeout constants in the acceptance harness

**File:** `apps/api/scripts/acceptance.mjs:74-76`
**Issue:** `SHUTDOWN_GRACE_MS` and `SHUTDOWN_MARGIN_MS` are declared (with a
comment referencing the worker's grace window) but never referenced anywhere in
`acceptance.mjs`. They appear to be copied from `selftest-index-boot.mjs`, where
they are used. Dead constants invite confusion about whether a shutdown assertion
is being made here (it is not).
**Fix:** Remove both constants, or add the intended graceful-shutdown assertion
that would consume them.

### IN-02: `startStatusObserver` busy-polls Redis with no delay

**File:** `apps/api/scripts/acceptance.mjs:247-257`
**Issue:** The observer loop `while (running) { await conn.hget(...) }` issues
`HGET` as fast as the event loop allows, with no `sleep` between iterations. This
is a deliberate tight loop to catch the transient `Scanning` status, but it spins
one CPU and hammers the disposable Redis for the whole scan; on a slow/loaded CI
runner the extra load can perturb the very timing it is trying to observe. This is
test-only and does not affect correctness.
**Fix:** Insert a small `await sleep(5)` inside the loop — still fast enough to
capture the `Queued → Scanning → Failed` transitions but no longer a hot spin.

---

_Reviewed: 2026-07-10_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
