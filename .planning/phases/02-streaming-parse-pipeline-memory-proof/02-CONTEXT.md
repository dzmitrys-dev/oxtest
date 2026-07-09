# Phase 2: Streaming Parse Pipeline & Memory Proof - Context

**Gathered:** 2026-07-09
**Status:** Ready for planning
**Source:** discuss-phase `--auto` (decisions auto-selected from requirements + project research; see DISCUSSION-LOG.md for the auto-selection trail)

<domain>
## Phase Boundary

Deliver the `ReportParser` streaming pipeline that extracts CRITICAL-only vulnerabilities from a 500MB+ Trivy JSON report under a 150MB V8 heap — **proven in isolation and gated in CI, before any queue/HTTP/Trivy-invocation plumbing exists**. This is the assignment's load-bearing pass/fail requirement (flat memory under a hard heap cap).

**In scope:** the `ReportParser` (stream-json `Pick`→`streamArray`→per-object filter, CRITICAL-only), a memory-bounded fixture generator (500MB+ streamed to disk), a small committed known-severity correctness fixture, a memory self-test harness (peak RSS/heapUsed logging under `--max-old-space-size=150`), a flat-RSS multi-size sweep, a mechanical forbidden-API guard (no `fs.readFile`/`JSON.parse` on the report), and a GitHub Actions CI job that fails the build on OOM. Covers ENGINE-05, MEM-01, MEM-02, MEM-03, MEM-04.

**Out of scope (later phases):** BullMQ worker invoking the parser, `git clone`, Trivy CLI execution, cleanup of clone/report (Phase 3); REST/GraphQL surface (Phase 4); Docker `mem_limit: 200m` RSS gate / Bonus C (Phase 5); React frontend (Phase 6). The parser is built standalone and exported for Phase 3 to wire into the `ScanModule` seam — it is NOT wired into any runtime entrypoint in this phase.
</domain>

<decisions>
## Implementation Decisions

### Parser API & Streaming Shape
- **D-01:** `ReportParser` exposes an **async generator** — `async *parse(reportPath: string): AsyncIterable<Vulnerability>` — yielding one mapped `Vulnerability` at a time. An async generator *structurally* guarantees "at most one vulnerability object in memory at a time" (MEM-04): it yields one value then suspends, so it cannot silently accumulate. The consumer (the memory self-test now; the Phase 3 worker later) decides what to do with each yielded CRITICAL vuln (persist / count / write NDJSON) — the parser never owns an accumulator that scales with input.
- **D-02:** The pipeline uses a **single deep `pick`** that reaches the leaf vulnerability objects directly, paired with **`streamValues()`** so exactly one vulnerability object is assembled at a time: `chain([fs.createReadStream(path), parser(), pick({ filter: /^Results\.\d+\.Vulnerabilities\.\d+$/ }), streamValues(), ...])`. Filter `Severity === 'CRITICAL'` per vulnerability, map `TrivyVulnerability` → `Vulnerability` (camelCase, per Phase 1 D-04 shape), and `yield`. Backpressure propagates end-to-end via stream-chain.
  - **Corrected by 02-RESEARCH.md (verified against the stream-json wiki):** the originally-sketched `pick('Results') → streamArray()` shape is NOT memory-flat — `streamArray()` (via `Assembler`) rebuilds each top-level `Results[]` element as a *complete* object, materializing a whole `Result` and all its `Vulnerabilities` at once (RSS spikes on a vuln-heavy Result). The deep-pick + `streamValues()` shape above is the verified flat approach. `streamValues()` has the SAME one-item-at-a-time contract as `streamArray()` — PITFALLS.md's characterization of it as a buffering trap is incorrect.
  - **Version pin:** `stream-json@2.1.0` + `stream-chain@3.6.3` (last CJS-published releases — stream-json@3.5.0 is ESM-only and breaks the locked `module: commonjs` tsconfig; APIs are identical).
  - **Zero** `fs.readFile`/`readFileSync`/`JSON.parse`/`.toArray()` on the report path (ENGINE-05; PITFALLS Pitfall 1). `streamValues()` is explicitly ALLOWED (see corrected D-08).

### Fixtures
- **D-03:** The **fixture generator** is a Node script using `fs.createWriteStream` with explicit backpressure (`await once(ws, 'drain')` when `write()` returns false), emitting a Trivy-shaped JSON document incrementally (open `{"Results":[{"Target":...,"Vulnerabilities":[`, stream N vulnerability objects, close brackets). It is itself memory-bounded (no growing in-memory array). CLI args: target size in MB (default **500**) and a deterministic severity mix (so the count of CRITICAL vs non-CRITICAL is known/reproducible). Output streamed to disk on demand (MEM-01).
- **D-04:** A **separate, small, hand-crafted fixture** with a known mix of severities is **committed** to the repo and drives the correctness test (Success Criterion 3): the parser must emit exactly the CRITICAL vulnerabilities and zero non-CRITICAL. Keeping it tiny + committed makes the correctness assertion deterministic and fast, independent of the large generated fixture.

### Memory Self-Test & Proof
- **D-05:** The **memory self-test** runs `ReportParser.parse()` against the 500MB fixture under `node --max-old-space-size=150`, draining the async generator (counting yields, not collecting them). A periodic sampler (`setInterval`, ~200ms) records **peak** `process.memoryUsage()` — `rss`, `heapUsed`, AND `external` (Buffers live off-heap; `--max-old-space-size` only caps V8 old-space — PITFALLS Pitfall 2). It logs peak RSS + heapUsed and exits **0** on success, **non-zero** on OOM or if peak RSS exceeds a documented threshold (MEM-02).
- **D-06:** A **flat-RSS sweep** (Success Criterion 2 / MEM-04) runs the parser across increasing fixture sizes (50MB / 200MB / 500MB / 1GB) and asserts peak RSS stays within a small constant band — memory must NOT scale with input. Sizes are configurable; the 1GB case is opt-in for local runs, CI uses 500MB to bound runtime.

### Code Location & Enforcement
- **D-07:** The parser lives at `apps/api/src/parser/report-parser.ts` (framework-free or trivially `@Injectable()` so Phase 3 can provide it through the existing `ScanModule` seam). The fixture generator and self-test live as scripts under `apps/api/scripts/` (or equivalent), runnable via `package.json` scripts (e.g. `gen:fixture`, `memtest`, `memtest:sweep`). The parser is **exported but not wired** into any runtime entrypoint this phase.
- **D-08:** A **mechanical forbidden-API guard** — a grep-based CI check (or custom ESLint rule) — asserts that `fs.readFile`/`readFileSync`, `JSON.parse`, and `.toArray(` never appear in the parser path (`apps/api/src/parser/**`). This turns ENGINE-05's prohibition into an enforced gate, not a promise (PITFALLS Pitfall 1 "warning signs").
  - **Corrected by 02-RESEARCH.md:** `streamValues(` is REMOVED from the ban list — it is the memory-safe API the flat pipeline requires (see D-02), not a buffering trap. The ban covers only the genuine full-materialization APIs: `JSON.parse`, `fs.readFile`/`readFileSync`, `.toArray(`. (The guard MAY additionally assert the parser uses `streamValues`/deep-`pick`, but must not forbid it.)

### CI Gate
- **D-09:** A **GitHub Actions** job (Node **22**, matching `.nvmrc`/`engines`) generates a 500MB fixture, then runs the memory self-test under `--max-old-space-size=150`, **failing the build on any non-zero exit (OOM)** — turning the pass/fail claim into a reproducible gate (MEM-03). The fixture is ephemeral (generated in-job, not committed). Runtime cost of generating 500MB in CI is documented; a smaller documented size is the fallback only if runner limits demand it.

### Claude's Discretion
- Exact `package.json` script names; sampler interval; the concrete peak-RSS threshold value (derive from observed flat baseline + margin); NDJSON-writer vs counter on the *consumer* side of the self-test (parser only yields); `parser/` vs `engine/` directory naming; grep-guard vs ESLint-rule for D-08; whether the sweep is a separate script or a `--sweep` flag on the self-test.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase requirements & goal
- `.planning/ROADMAP.md` §"Phase 2" — goal + 5 success criteria (the near-spec)
- `.planning/REQUIREMENTS.md` §ENGINE (ENGINE-05), §MEM (MEM-01, MEM-02, MEM-03, MEM-04)
- `.planning/PROJECT.md` — Core Value (the 150MB-heap memory pass/fail is THE grading criterion)

### Technical research (READ the memory pitfalls before coding)
- `.planning/research/PITFALLS.md` — Pitfall 1 (accidental full-buffering — the assignment's #1 fail; nested pick/streamArray, ban JSON.parse/toArray/streamValues), Pitfall 2 (heap vs RSS — log `rss`+`external`, not just `heapUsed`)
- `.planning/research/STACK.md` — stream-json `Pick`+`streamArray` pattern, stream-chain pipeline + backpressure, version pins
- `.planning/research/ARCHITECTURE.md` — where the parser sits relative to worker/service (the seam Phase 3 plugs into)

### I/O contract (built in Phase 1 — the parser's input & output types)
- `apps/api/src/domain/trivy-report.types.ts` — `TrivyReport`/`TrivyResult`/`TrivyVulnerability` (parse-path-only input shape, D-04 Phase 1)
- `apps/api/src/domain/vulnerability.types.ts` — `Vulnerability` (CRITICAL-only camelCase output; parser maps to this on yield)
- `apps/api/src/scan/scan.module.ts` + `scan.store.ts` — the shared DI seam Phase 3 will wire the parser into

### Assignment source
- `Senior Backend Engineer Assignment_ The Supply Chain Scanner (1) (3).pdf` (repo root) — the graded spec; note the literal forbidden APIs and the `--max-old-space-size=150` self-test
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Domain types (Phase 1):** `TrivyVulnerability` (input) and `Vulnerability` (CRITICAL-only output) are the parser's exact I/O contract — the parser maps `TrivyVulnerability` → `Vulnerability` on each yield. No new type modeling needed.
- **`ScanStore` / `ScanModule` seam (Phase 1):** the DI seam the Phase 3 worker uses; the parser will be provided here later. This phase only builds+exports the parser, it does not wire it in.
- **Strict tsconfig + `@swc/jest` + ESLint (Phase 1):** the parser and its tests inherit strict typing (no `any`) and the test transform; the correctness fixture test runs under the existing jest setup.

### Established Patterns
- **Framework-free core (Phase 1 D-03):** keep the parser pure (or trivially injectable) so the worker container carries no extra transport heap — consistent with the memory discipline of this project.
- **Node, not Bun (Phase 1 D-4b):** load-bearing here — `--max-old-space-size` is a V8-only flag; running on Bun would silently disable the exact heap gate this phase proves.

### Integration Points
- Parser is consumed this phase ONLY by the memory self-test script; in Phase 3 the BullMQ worker calls it via the `ScanModule` seam. Design the async-generator API so both consumers work unchanged.
</code_context>

<specifics>
## Specific Ideas

- Write the memory self-test **alongside** the parser (test-first pressure), per PITFALLS "Phase to address" — regressions in memory behavior must surface immediately, not at submission.
- The self-test must assert on **peak RSS across the whole run** (sampled), not a single final reading — a final reading can miss a transient spike.
- Keep the large fixture ephemeral/git-ignored; commit only the tiny known-severity correctness fixture.
</specifics>

<deferred>
## Deferred Ideas

- **Worker/BullMQ invocation of the parser, `git clone`, Trivy CLI execution, clone/report cleanup** — Phase 3. (The `child_process`/`execa` maxBuffer trap in PITFALLS Pitfall 3 is a Phase 3 concern — Phase 2 parses a fixture on disk, it does not invoke Trivy.)
- **REST/GraphQL surface exposing scan results** — Phase 4.
- **Docker `mem_limit: 200m` RSS gate (Bonus C)** — Phase 5. This phase's RSS logging is the groundwork, but the container-level OOM gate is separate.
- None of the above were in scope; discussion stayed within the parse/proof boundary.
</deferred>

---

*Phase: 2-Streaming Parse Pipeline & Memory Proof*
*Context gathered: 2026-07-09 via discuss-phase --auto*
