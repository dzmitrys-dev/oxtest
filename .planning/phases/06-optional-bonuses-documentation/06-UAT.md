---
status: testing
phase: 06-optional-bonuses-documentation
source: [06-VERIFICATION.md]
started: 2026-07-11
updated: 2026-07-11
---

## Current Test

number: 1
name: Live SPA end-to-end through all four ScanStatus states
expected: |
  Serve the UI, submit a GitHub repo URL, and observe the full flow.
  Client validation blocks a non-github/non-https URL; "Start scan" enqueues via the
  GraphQL mutation; Queued and Scanning render (indigo spinner), Finished shows the count
  summary + 5-column CRITICAL table (or emerald all-clear), Failed shows the red error card.
  Matches 06-UI-SPEC.md.
awaiting: user response

## Tests

### 1. Live SPA end-to-end through all four ScanStatus states
expected: Client validation blocks a bad URL; Start enqueues via GraphQL; Queued→Scanning (spinner)→Finished (count + 5-column CRITICAL table, or emerald all-clear); Failed shows the red error card. The 2s poll updates status and STOPS on a terminal state (FE-02 cadence/halt). Matches 06-UI-SPEC.md.
result: [pending]

### 2. `docker compose up` runnable-from-the-README-alone
expected: Following README's `docker compose up --build` on a clean machine (no host-side Trivy/Redis install) brings up redis+api+worker and serves the SPA, GraphiQL, REST, and /health on :3000.
result: [pending]

### 3. GraphiQL interactive playground renders and is usable
expected: Opening `/graphiql` in a browser loads the interactive GraphiQL UI; the `enqueueScan` mutation and `scan(id)` query can be run by hand and return results.
result: [pending]

### 4. ONBOARDING.md persuasive/accurate quality
expected: A senior reviewer reads each of the 13 topics + both bonuses and finds the What/Why/How + "A reviewer might ask…" Q&A genuinely answers the sharp question; the NestJS-vs-Fastify tension and the GraphiQL / Docker socket-mount trade-offs are convincingly owned.
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps
