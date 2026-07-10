---
plan_id: 05-04
status: complete
gap_closure: true
requirements: [OPS-02]
self_check: passed
key_files:
  created:
    - docker-entrypoint.sh — runtime socket-gid resolution + setpriv privilege drop
    - apps/api/scripts/docker-image-smoke.mjs — in-image CR-01/CR-02 regression guard
  modified:
    - Dockerfile — install git + docker-ce-cli (client) in runtime stage; ENTRYPOINT; drop USER node
    - docker-compose.yml — memswap_limit 200m (WR-02); remove fragile group_add
    - apps/api/package.json — add test:smoke:image script
    - .github/workflows/scan-engine.yml — add feasibility-gated scan-engine-image-smoke job
---

# Summary 05-04 — Gap closure: `docker compose up` can actually scan (OPS-02 / Criterion #2)

## What was broken
`05-VERIFICATION.md` (status `gaps_found`, 4/5) + `05-REVIEW.md` (CR-01, CR-02): the
`node:22-slim` runtime image installed no OS packages, but the worker shells out to
`git clone` and (TRIVY_MODE=docker) the `docker` CLI to run the pinned Trivy sibling — both
absent → every in-container scan fails ENOENT. Invisible to CI because `acceptance.mjs` runs
the worker on the HOST and the OOM proof runs only the pure memtest.

## What shipped (user-chosen Option A — keep D-05 non-root + D-06 docker-sibling)
1. **Runtime image now has the per-scan tools** — `git` + `docker-ce-cli` (client only, from
   Docker's official Debian apt repo) installed in the runtime stage. The Trivy *binary* is
   deliberately NOT bundled and Trivy is NOT run in-process — it stays a sibling container so
   its memory never counts against the worker's 200m cap.
2. **Non-root socket access on any host** — `docker-entrypoint.sh` starts as root, resolves the
   mounted socket's gid at runtime, adds `node` to it, then `setpriv`-drops to non-root `node`.
   So a raw `docker compose up` works on any host with no reviewer-supplied docker gid, while
   the scan process stays non-root (D-05). Removed the fragile compose `group_add` (its default
   gid 999 mismatched this host's actual gid 115).
3. **Closed the CI blind spot** — `docker-image-smoke.mjs` builds the image and asserts, inside
   it, non-root node + git + docker CLI (feasibility-gated). Wired as `scan-engine-image-smoke`
   (required-when-Docker-feasible) + `test:smoke:image` npm script. Also capped worker swap
   (`memswap_limit: 200m`, WR-02) so the 200m proof is RAM-real.

## Verification (proven live — docker 29.6.1 on this host)
- `docker build --target runtime` succeeds.
- Inside the built image, run as compose would (socket mounted, entrypoint active):
  `user=node uid=1000 groups=node dockerhost` (non-root, socket group auto-added),
  `git version 2.39.5`, `Docker version 29.6.1`, and a non-root
  `docker run ghcr.io/aquasecurity/trivy:0.69.3 --version` → `Version: 0.69.3` (TRIVY_SIBLING_OK).
- `npm run test:smoke:image` → PASS (non-root / git / docker) exit 0.
- `docker compose config` VALID: worker mem_limit==memswap_limit==209715200; no group_add.
- `scan-engine.yml` parses; 6 jobs incl. `scan-engine-image-smoke` (feasibility-gated);
  contract job stays always-required.

## Self-Check: passed
Criterion #2 (`docker compose up` end-to-end scan capability, non-root, off-cap Trivy memory)
is now satisfied and guarded against regression. The one accepted `high` residual (docker.sock
host-Docker control, D-06) is carried forward unchanged for ONBOARDING.

## Note
Executed INLINE by the orchestrator (not via a gsd-executor subagent): the org hit its monthly
API spend limit mid-run, which failed all subagent spawns. Inline execution is the workflow's
sanctioned fallback when the Agent tool is unavailable. The model substitution (Opus in place of
the configured openrouter/gpt-5.6-* models, unroutable via the Agent tool) was user-confirmed
earlier in the run.
