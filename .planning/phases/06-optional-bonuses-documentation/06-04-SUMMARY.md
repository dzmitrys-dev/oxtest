---
phase: 06-optional-bonuses-documentation
plan: 04
subsystem: docs
tags: [docs, readme, onboarding, interview-prep, bonus, reviewer-run-guide]

# Dependency graph
requires:
  - phase: 06-01
    provides: "Code-first GraphQL surface (/graphql + /graphiql), SSRF-parity enqueueScan mutation + scan(id) query — the GraphiQL trade-off and SSRF-parity story documented here"
  - phase: 06-02
    provides: "apps/web Vite/React/urql SPA — the 2s poll, 6-field table, generic Failed card documented here"
  - phase: 06-03
    provides: "ServeStaticModule same-origin SPA serving + Docker web-build fold-in — the 'docker compose up serves the UI on :3000' run path documented here"
  - phase: 05
    provides: "docker-compose (redis/api/worker), socket-mount trade-off, self-test honesty (index.js vs worker.js), node:22-slim rationale, memory-margin tuning — harvested into README/ONBOARDING"
  - phase: 02
    provides: "streaming parser + memtest/fixture — the 500MB proof and streaming/backpressure rationale"
provides:
  - "README.md — reviewer run guide (compose-first, criterion #3 checklist, ASCII architecture, NodeGoat demo, honest self-test mapping)"
  - "ONBOARDING.md — interview-prep What/Why/How + reviewer Q&A across 13 topics + both bonuses, owning rejected alternatives and the NestJS-vs-Fastify / GraphiQL / socket-mount trade-offs"
affects: [milestone submission — public repo deliverables DOC-01/DOC-02]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "README runs, ONBOARDING explains — single source of truth per concern, no duplication (D-14)"
    - "Docs harvest recorded Phase 1-5 rationale rather than re-deriving it (D-10)"
    - "Every cited command cross-checked against apps/api/package.json + root package.json + docker-compose.yml (no invented scripts)"

key-files:
  created:
    - README.md
    - ONBOARDING.md
  modified:
    - .planning/STATE.md
    - .planning/ROADMAP.md
    - .planning/REQUIREMENTS.md

key-decisions:
  - "README leads with `docker compose up` (redis+api+worker+served UI on :3000); local dev secondary; every command is a real apps/api/root script or the graded verbatim `node --max-old-space-size=150 dist/index.js` (D-12/D-15)"
  - "Architecture is an ASCII diagram + prose (no mermaid) and links to ONBOARDING; README does not duplicate ONBOARDING's rationale (D-13/D-14)"
  - "Honest self-test mapping stated plainly: index.js boots the API under the 150MB cap (test:selftest); the 500MB stream-parse runs in worker.js; standalone memtest is the honest 500MB proof (D-15b, Phase 5 D-10)"
  - "NodeGoat demo uses the default upstream https://github.com/OWASP/NodeGoat + an explicit substitute-your-fork note — not blocked on a user-provided fork URL (D-15a)"
  - "ONBOARDING = 13 topics, each What/Why/How + 'A reviewer might ask…' + rejected alternatives; owns the NestJS-vs-Fastify tension, the GraphiQL/introspection exposure (Pitfall 6), and the Docker socket-mount trade-off (D-09/D-10/D-11)"
  - "Testing-strategy topic reflects the CORRECTED Jest-landmine root cause discovered in Wave 1 — editor buildHook (Console Ninja) injection into the Jest process, fixed by transformIgnorePatterns hardening — framed with the compiled-dist + node:test pattern for BullMQ-touching integration tests"

requirements-completed: [DOC-01, DOC-02]

coverage:
  - id: D1
    description: "README.md is runnable from the README alone: compose-first primary path + local-dev secondary, with the full criterion #3 checklist (run, memory self-test, acceptance, architecture, NodeGoat demo, honest self-test mapping)"
    requirement: "DOC-01"
    verification:
      - kind: automated
        ref: "test -f README.md && grep docker-compose-up/memtest/test:acceptance/NodeGoat/dist-worker.js — all present (PASS)"
        status: pass
      - kind: manual_procedural
        ref: "A reviewer runs `docker compose up` and reaches the SPA/GraphiQL/REST/health on :3000 from the README alone"
        status: unknown
    human_judgment: true
    rationale: "End-to-end 'runnable from the README alone' against a live Docker stack is a human/UAT check; the automated grep only proves the required sections/commands are present, not that the reviewer's environment brings the stack up."
  - id: D2
    description: "ONBOARDING.md explains every implemented solution as What/Why/How + an explicit reviewer Q&A block, with rejected alternatives per topic, owning the NestJS-vs-Fastify and GraphiQL trade-offs across all D-11 topics + both bonuses"
    requirement: "DOC-02"
    verification:
      - kind: automated
        ref: "test -f ONBOARDING.md && grep 'reviewer might ask'/Fastify/GraphiQL/(landmine|@nestjs/bullmq) — all present; 13 topics each carry a reviewer-Q + rejected-alternatives block (PASS)"
        status: pass
      - kind: manual_procedural
        ref: "A senior reviewer reads a topic and judges the What/Why/How + Q&A actually answers the sharp question"
        status: unknown
    human_judgment: true
    rationale: "Interview-prep quality (does the Q&A satisfy a skeptical reviewer, is the rationale accurate to the code) is a judgment call; the automated check proves structural presence, not persuasive completeness."

# Metrics
duration: 5min
completed: 2026-07-10
status: complete
---

# Phase 6 Plan 04: README + ONBOARDING Documentation Summary

**Shipped the two required documentation deliverables: a compose-first, runnable-from-the-README-alone README.md with the full criterion #3 checklist (ASCII architecture, OWASP NodeGoat demo, honest index.js-vs-worker.js self-test mapping), and an interview-prep ONBOARDING.md explaining all 13 topics + both bonuses as What/Why/How + skeptical-reviewer Q&A + rejected alternatives — owning the NestJS-vs-Fastify tension and the GraphiQL/socket-mount trade-offs, with every cited command cross-checked as real.**

## Performance
- **Duration:** ~5 min
- **Tasks:** 2
- **Files created:** 2 (README.md, ONBOARDING.md)

## Accomplishments

### Task 1 — README.md (DOC-01) — commit `a093661`
- **Compose-first primary path (D-12):** `docker compose up --build` brings up redis + api + worker and serves the SPA (`/`), GraphiQL (`/graphiql`), REST (`/api/scan`, `/api/scan/:scanId`), and `/health` on one origin (`:3000`); states no host-side Trivy/Redis install is needed (Docker-socket sibling scanner).
- **Local dev secondary section:** `npm ci`, `npm run build:all`, `start:api`/`start:worker`, `dev:api`/`dev:worker` (tsx watch), and `npm run dev --workspace apps/web` (Vite `/graphql` proxy) — all real scripts.
- **Criterion #3 checklist complete (D-15):** copy-paste run (compose + local); memory self-test (`memtest`, `memtest:sweep`, `gen:fixture` under `apps/api`); acceptance (`npm run test:acceptance --workspace apps/api`); ASCII architecture diagram + prose linking to ONBOARDING; a real OWASP NodeGoat scan demo (REST curl + GraphQL) with the default upstream URL and a substitute-your-fork note (D-15a); the honest self-test mapping (D-15b) — `node --max-old-space-size=150 dist/index.js` boots the API (proven by `test:selftest`), while the 500MB stream-parse runs in `dist/worker.js` and the standalone `memtest` is the honest 500MB proof.
- Env var **names** only (`PORT`, `REDIS_HOST`, `REDIS_PORT`, `SCAN_TMP_DIR`, `TRIVY_MODE`, `NODE_ENV`) — no secret values (T-06-09).

### Task 2 — ONBOARDING.md (DOC-02) — commit `fa09ea9`
- **13 topics**, each as What/Why/How + an explicit "A reviewer might ask…" Q&A + a rejected-alternatives/trade-offs note: (1) memory strategy, (2) streaming/backpressure, (3) architecture layering, (4) queue design, (5) error handling, (6) type safety, (7) Trivy local-detect+Docker-fallback & socket-mount trade-off, (8) two-entrypoint topology + self-test honesty, (9) guaranteed try/finally cleanup, (10) testing strategy (Jest landmine), (11) Bonus B GraphQL + GraphiQL trade-off, (12) Bonus A SPA, (13) the NestJS-vs-Fastify tension.
- **Owns the tensions (D-10):** explicitly reconciles `.claude/CLAUDE.md`'s Fastify-over-NestJS recommendation with the NestJS(+Fastify-adapter) build; documents the GraphiQL/introspection-in-all-envs exposure (Pitfall 6) and the Docker socket-mount privilege as deliberate single-tenant demo trade-offs you'd gate in production.
- **Corrected Jest-landmine root cause:** the testing topic states the true trigger discovered in Wave 1 — an editor buildHook (Console Ninja) injected into the Jest process, not `@nestjs/bullmq` per se — fixed by hardening `transformIgnorePatterns`, framed alongside the compiled-`dist` + `node:test` pattern for BullMQ-touching integration tests.
- **Single source of truth for the "why" (D-14):** no README run-steps duplicated; harvested rationale from the Phase 1-5 CONTEXT/STATE sources rather than re-deriving.

## Task Commits
1. **Task 1: README.md — compose-first run guide + criterion #3 checklist** — `a093661` (docs)
2. **Task 2: ONBOARDING.md — What/Why/How + reviewer Q&A interview-prep** — `fa09ea9` (docs)

## Files Created/Modified
- `README.md` (created) — reviewer run guide (DOC-01).
- `ONBOARDING.md` (created) — interview-prep What/Why/How + Q&A (DOC-02).
- `.planning/STATE.md`, `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md` (modified) — plan-completion tracking.

## Decisions Made
- Cited only verified-real commands: cross-checked every command against `apps/api/package.json` (memtest, memtest:sweep, gen:fixture, test:selftest, test:acceptance, test:oom:container, test:serve-static, build, start/dev:api/worker), root `package.json` (build:all, dev --workspace apps/web), and `docker-compose.yml` — no invented script names.
- Kept the NodeGoat demo on the default upstream `https://github.com/OWASP/NodeGoat` + a substitute-your-fork note (Assumption A1) rather than blocking on a user-provided fork URL, per D-15a.
- README architecture is ASCII-only (no mermaid) and defers all rationale to ONBOARDING to honor the README-runs / ONBOARDING-explains division (D-13/D-14).

## Deviations from Plan

None — plan executed exactly as written. Both tasks (README, ONBOARDING) delivered per the criterion #3 checklist and the D-09/D-10/D-11 topic list; both `<verify>` greps pass; no secret values; no source-code behavior changed (docs-only plan).

## Accuracy Notes (corrected facts applied)
- **Jest landmine:** documented with the corrected Wave-1 root cause (editor buildHook injection → `transformIgnorePatterns` hardening), consistent with STATE and 06-01-SUMMARY — not the stale "@nestjs/bullmq is the cause" framing.
- **GraphQL:** code-first MercuriusDriver on the same Fastify listener; GraphiQL at `/graphiql`; `graphql` pinned 16.14.2; `status: String!` (not enum).
- **SPA:** urql, same-origin `/graphql`, 2s poll stopping on terminal, 6-field table (no fixedVersion), generic Failed card (ScanModel exposes no `error` field).

## Issues Encountered
- `state.add-decision` requires the `--summary` flag (not a positional arg); re-invoked with the correct flag. No impact on deliverables.

## User Setup Required
None — documentation-only. The docs reference the existing `docker compose up` path and existing npm scripts; no new configuration.

## Next Phase Readiness
- DOC-01 and DOC-02 are complete — the phase's success criteria #3 (README) and #4 (ONBOARDING) are satisfied; all Phase 6 requirements (API-01/02, FE-01/02/03, DOC-01/02) are now covered. Ready for phase verification.

## Self-Check: PASSED
- Files exist on disk: README.md, ONBOARDING.md.
- Task commits present in git history: a093661 (README), fa09ea9 (ONBOARDING).
- Plan `<verify>` chains re-run green: README grep (docker compose up / memtest / test:acceptance / NodeGoat / dist/worker.js) PASS; ONBOARDING grep (reviewer might ask / Fastify / GraphiQL / landmine|@nestjs/bullmq) PASS; secret scan clean on both.

---
*Phase: 06-optional-bonuses-documentation*
*Completed: 2026-07-10*
