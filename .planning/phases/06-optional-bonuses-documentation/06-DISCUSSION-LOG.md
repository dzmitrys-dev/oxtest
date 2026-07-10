# Phase 6: Optional Bonuses & Documentation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-11
**Phase:** 6-Optional Bonuses & Documentation
**Areas discussed:** Bonus scope, ONBOARDING doc, README run-story, Bonus surfaces

---

## Bonus scope

### Which optional bonuses to build?

| Option | Description | Selected |
|--------|-------------|----------|
| GraphQL only (B) | Build GraphQL parity, defer React | |
| Both A + B | Build GraphQL AND React polling frontend | ✓ |
| Docs only | Skip both code bonuses, defer A and B | |
| React only (A) | Build React, defer GraphQL | |

**User's choice:** Both A + B
**Notes:** Fullest feature set; docs ship regardless. Bonus C already delivered in Phase 5.

### Which backend should React call?

| Option | Description | Selected |
|--------|-------------|----------|
| REST | Poll GET /api/scan/:id; simplest client | |
| GraphQL | Use mutation + query; dogfoods bonus B | ✓ |
| You decide | Claude discretion | |

**User's choice:** GraphQL
**Notes:** Shows both bonuses working together; adds a GraphQL client dependency.

### How is the React app run/served for a reviewer?

| Option | Description | Selected |
|--------|-------------|----------|
| Vite dev server + CORS | `npm run dev`, API enables CORS | |
| Build + serve from API | vite build served static by Fastify, one origin | ✓ |
| You decide | Claude discretion | |

**User's choice:** Build + serve from API
**Notes:** No CORS, single URL for the reviewer; cleanest run-story.

---

## ONBOARDING doc

### What register/format per topic?

| Option | Description | Selected |
|--------|-------------|----------|
| What/Why/How + reviewer Q&A | Each topic ends with an "A reviewer might ask…" block | ✓ |
| What/Why/How only | Clean W/W/H, no Q&A | |
| Narrative deep-dive | Essay style + diagrams | |

**User's choice:** What/Why/How + reviewer Q&A
**Notes:** Directly serves the interview-prep goal.

### Document rejected alternatives / trade-offs?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — explicit per topic | Rejected alternatives on every topic; own the NestJS-vs-Fastify tension | ✓ |
| Only where notable | Trade-offs on big decisions only | |
| No — keep it lean | Chosen design only | |

**User's choice:** Yes — explicit per topic
**Notes:** Harvested from Phase 1–5 CONTEXT files; explicitly own the CLAUDE.md NestJS-vs-Fastify tension.

### Topic coverage breadth?

| Option | Description | Selected |
|--------|-------------|----------|
| Expanded | 5 named topics + streaming, Trivy fallback, two-entrypoint, cleanup, testing | ✓ |
| Named five only | memory, architecture, queue, error handling, type safety | |
| You decide | Claude discretion | |

**User's choice:** Expanded
**Notes:** Anticipate the questions a reviewer will actually probe.

---

## README run-story

### Primary (first) run path?

| Option | Description | Selected |
|--------|-------------|----------|
| docker-compose first | Lead with `docker compose up` | ✓ |
| Local-dev first | Lead with local npm scripts | |
| You decide | Claude discretion | |

**User's choice:** docker-compose first
**Notes:** Best matches "runnable from README alone".

### Architecture overview format?

| Option | Description | Selected |
|--------|-------------|----------|
| Mermaid diagram + prose | Renders on GitHub natively | |
| ASCII diagram + prose | Plain-text, always renders | ✓ |
| Prose only | No diagram | |

**User's choice:** ASCII diagram + prose
**Notes:** No render dependency; works everywhere.

### README ↔ ONBOARDING division of labor?

| Option | Description | Selected |
|--------|-------------|----------|
| README runs, ONBOARDING explains | README = run + overview + link; no duplication | ✓ |
| README self-contained | README repeats fuller decision summary | |

**User's choice:** README runs, ONBOARDING explains
**Notes:** Single source of truth per concern.

---

## Bonus surfaces

### Expose GraphiQL playground?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — enabled | `/graphiql` in all envs incl. container | ✓ |
| Dev-only | Off in production/container | |
| You decide | Claude discretion | |

**User's choice:** Yes — enabled
**Notes:** Reviewer explorability; minor prod-hygiene trade-off noted in ONBOARDING.

### React polish/styling level?

| Option | Description | Selected |
|--------|-------------|----------|
| Lean plain-CSS, all states | Minimal CSS, every state handled | |
| Tailwind / component lib | More polish, more deps | ✓ |
| Bare minimal | Near-unstyled | |

**User's choice:** Tailwind / component lib
**Notes:** Bar is "looks finished, not scaffolded" — all four ScanStatus states must render.

### CRITICAL results display?

| Option | Description | Selected |
|--------|-------------|----------|
| Table w/ key vuln fields | package, CVE, installed, fixed, title + count | ✓ |
| Compact list | package — CVE per row | |
| You decide | Claude discretion | |

**User's choice:** Table w/ key vuln fields
**Notes:** Constraint surfaced during scout — stored `Vulnerability` has NO `fixedVersion` field; table maps only to stored fields (pkgName, vulnerabilityId, installedVersion, title, primaryUrl). Do not expand the memory-critical parser.

---

## Claude's Discretion

- GraphQL client library for `apps/web` (urql preferred vs Apollo).
- Exact GraphQL error mapping (REST parity) and enqueue mutation input shape.
- `apps/web` internal structure, Vite config, Tailwind-vs-component-library specifics.
- Static-serving mechanism (`@fastify/static` vs Nest `ServeStaticModule`) and Docker/compose build wiring.
- Precise ONBOARDING and README section ordering.

## Deferred Ideas

None — discussion stayed within phase scope.
