# Phase 1: Foundations, Domain Types & Strict Config - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-09
**Phase:** 1-Foundations, Domain Types & Strict Config
**Areas discussed:** Repo structure, Domain type strategy, Scaffold approach, Entrypoint layout, Runtime (Node vs Bun)

---

## Repo / Workspace Structure

| Option | Description | Selected |
|--------|-------------|----------|
| Monorepo: apps/api + apps/web | npm workspaces, one install, per-app Dockerfile | ✓ |
| Single package, web/ subfolder | Backend at root (dist/index.js exact), React self-contained in web/ | |
| Backend only at root, frontend separate later | Least commitment now | |

**User's choice:** Monorepo apps/api + apps/web
**Notes:** Self-test path shifts to `apps/api/dist/index.js` — must be documented in README so reviewer copy-paste works. Entry basename stays `index.ts`.

---

## Domain Type Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Plain interfaces now, GraphQL mirrors later | Framework-free domain layer; @ObjectType maps to it in Phase 4 | ✓ |
| Class-based models now, decorate in Phase 4 | One type serves both, but couples domain to GraphQL early | |

**Trivy typing depth:**

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal — only fields we extract | Type just Results[].Vulnerabilities[] CRITICAL fields | ✓ |
| Full documented report schema | Model entire Trivy report | |

**User's choice:** Plain interfaces + minimal Trivy typing
**Notes:** Keeps domain pure, worker free of GraphQL deps — protects layering grade + worker heap.

---

## Scaffold Approach

| Option | Description | Selected |
|--------|-------------|----------|
| Hand-rolled minimal on Fastify | Author package.json/tsconfig directly, leaner tree | |
| `nest new` then swap to Fastify | CLI idiomatic structure + Jest/eslint/prettier, replace Express | ✓ |

**User's choice:** `nest new` then swap to Fastify
**Notes:** Reviewer-familiar conventions. Planner must adapt the standalone scaffold into the apps/api workspace package, restructure to two entrypoints, and verify no residual Express-only deps remain.

---

## Entrypoint Layout

| Option | Description | Selected |
|--------|-------------|----------|
| Shared ScanModule, separate root modules | AppModule (HTTP/GraphQL) + WorkerModule (Bull only, no GraphQL) | ✓ |
| One AppModule, worker skips listen() | Simpler, but worker loads GraphQL/HTTP into heap | |

**User's choice:** Shared ScanModule, separate root modules
**Notes:** Worker container carries no dead HTTP/GraphQL heap — intentional memory decision to highlight in ONBOARDING.

---

## Runtime (Node vs Bun)

Raised by user mid-discussion ("would it better to run the app on bun?"). Researched before answering.

| Option | Description | Selected |
|--------|-------------|----------|
| Node.js | Honors `--max-old-space-size=150` (V8) — the assignment's exact self-test/pass-fail gate | ✓ |
| Bun | JSC runtime; lower baseline RSS but ignores `--max-old-space-size` (no-op) | |

**User's choice:** Node.js (recommended, ~95% confidence)
**Notes:** Bun cannot enforce the V8 heap flag the assignment grades on (silently disables the gate + breaks copy-paste self-test); RSS win is marginal and non-deterministic under mem_limit:200m (oven-sh/bun#27514); BullMQ lacks Bun.redis support. Documented as a "considered and rejected" one-liner in README/ONBOARDING to earn initiative credit without breaking anything.

## Claude's Discretion

- Exact tsconfig flags beyond mandated `strict` + `noUncheckedIndexedAccess`
- Precise required env var keys in the Joi schema (mechanism locked, keys are discretion)
- Test runner details (Jest + @swc/jest unless reason to switch)
- Directory naming within apps/api/src

## Deferred Ideas

None — discussion stayed within phase scope. Frontend structure surfaced but is correctly Phase 6; the workspace layout accommodating it is decided here.
