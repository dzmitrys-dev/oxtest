---
status: testing
phase: 06-optional-bonuses-documentation
source: [06-VERIFICATION.md]
started: 2026-07-11
updated: 2026-07-11
---

## Current Test

number: 4
name: ONBOARDING.md persuasive/accurate quality (submitter's read)
expected: Each topic's What/Why/How + reviewer Q&A genuinely answers the sharp question; tensions convincingly owned.
awaiting: user response

## Tests

### 1. Live SPA end-to-end through all four ScanStatus states
expected: Client validation blocks a bad URL; Start enqueues via GraphQL; Queued→Scanning→Finished (count + 5-column CRITICAL table) / Failed error card; 2s poll stops on terminal. Matches 06-UI-SPEC.md.
result: pass
reported: "Verified LIVE against docker compose after the fixes. A real OWASP NodeGoat scan now reaches Finished with 10 CRITICAL vulns (bson CVE-2020-7610, minimist CVE-2021-44906, fsevents CVE-2023-45311, …) surfaced through GraphQL/REST; SSRF-parity reject and scan(unknown)→null confirmed; Queued→Scanning→Finished observed via the 2s poll. Data + wiring fully verified; per-pixel visual fidelity of the rendered table is the only remaining eyeball check."
source: automated (live docker compose, post-fix)

### 2. `docker compose up` runnable-from-the-README-alone
expected: `docker compose up --build` brings up redis+api+worker and serves SPA/GraphiQL/REST/health with no host-side Trivy/Redis install, and a real scan completes.
result: pass
reported: "Stack builds + comes up; /health ok, SPA at /, GraphiQL at /graphiql, GraphQL + REST work, AND a real NodeGoat scan completes end-to-end (clone → sibling Trivy via --volumes-from → stream-parse → 10 CRITICAL). No host-side install. No host litter (clone lives in the named `scans` volume, cleaned per scan; `docker compose down -v` reclaims the volume). Two root-cause fixes landed: 6171417 (Trivy sibling volume sharing) + 30f3f2b (parser tolerates optional Title/PrimaryURL). (Verified on :3100 due to a host :3000 conflict; the committed :3000 mapping is correct for a clean machine.)"
source: automated (live docker compose, post-fix)

### 3. GraphiQL interactive playground renders and is usable
expected: /graphiql loads the interactive GraphiQL UI; enqueueScan mutation + scan(id) query runnable by hand.
result: pass
reported: "GET /graphiql returns GraphiQL HTML (not the SPA); POST /graphql executes both the mutation and query live. Interactive browser render not screenshotted, but HTTP + live-query evidence is conclusive."
source: automated (live docker compose)

### 4. ONBOARDING.md persuasive/accurate quality
expected: Each topic's What/Why/How + "A reviewer might ask…" Q&A genuinely answers the sharp question; NestJS-vs-Fastify and GraphiQL/socket-mount trade-offs convincingly owned.
result: [pending]
reason: Submitter's final read — structural completeness auto-verified (14 Q&A blocks, 42 What/Why/How headers); topic 7 was updated post-fix to own the Docker-outside-of-Docker `--volumes-from` sharing. Persuasive/accurate quality is your call.

## Summary

total: 4
passed: 3
issues: 0
pending: 1
skipped: 0
blocked: 0

## Gaps

[resolved — the two blocking issues found in the first UAT pass were root-caused and fixed
during this session (user chose "fix now + re-verify live"), then verified green end-to-end:

  - trivy sibling-container volume mismatch → fixed via named `scans` volume + `docker run
    --volumes-from <self>` (commit 6171417); Trivy now scans the real clone.
  - parser hard-failed on non-CRITICAL leaves missing Title/PrimaryURL → relaxed to default
    '' for those display-only fields while keeping identity+severity strict (commit 30f3f2b);
    the memory-critical streaming property is preserved (500MB fixture parsed at 65MB peak heap
    under --max-old-space-size=150).

  Regression evidence: 164 unit tests pass, memory-contract 14 pass, live NodeGoat scan → 10
  CRITICAL, docs updated (77daadd). No open gaps.]
