# Phase 2: Streaming Parse Pipeline & Memory Proof - Research

**Researched:** 2026-07-09
**Domain:** Memory-bounded streaming JSON parsing (stream-json/stream-chain), Node.js process memory instrumentation, memory-bounded fixture generation, ESLint mechanical guards, GitHub Actions CI gating
**Confidence:** MEDIUM-HIGH (core stream-json API verified directly against the official GitHub wiki/README source, fetched raw — not AI-summarized in the load-bearing parts; Node.js `process.memoryUsage()` semantics verified against official Node docs; Context7 MCP was unavailable in this session, same as prior phases — all "docs" questions used direct wiki/README fetches instead of WebSearch summaries wherever a load-bearing API claim was involved)

## Summary

The phase's central technical risk is not "can stream-json handle 500MB" (it can, trivially) — it's **which exact stream-json composition avoids materializing an entire Trivy `Result` object** when a single Result can itself contain thousands of vulnerabilities. Research surfaced two hard findings that change the plan from what CONTEXT.md's D-02/D-08 currently assume:

1. **The nested `pick`+`streamArray` approach the project's own PITFALLS.md/ARCHITECTURE.md sketch (`pick('Results')` → `streamArray()`, then iterate `value.Vulnerabilities` per Result) is NOT memory-flat.** `streamArray()` is built on `Assembler` — "the Assembler ... consumes the token stream and rebuilds a complete JavaScript value" for **each top-level array element** [CITED: github.com/uhop/stream-json/wiki/Concepts]. Since the outer array being streamed is `Results`, each `{value}` handed to your code is a **fully-assembled `Result` object with its entire `Vulnerabilities` array already in memory** — exactly the failure mode PITFALLS.md's own Pitfall 6 warns about ("risks materializing a whole Result"), just not spelled out as a certainty until this session. If a fixture (or a real large scan) concentrates thousands of vulnerabilities in one Target/Result — the natural way to synthesize 500MB quickly — this pipeline shape buffers that whole array at the peak, which can spike RSS proportional to that single Result's size rather than staying flat.
2. **The memory-flat fix is a single-stage `Pick` with a path regex that reaches directly into the leaf array, paired with `streamValues()` (not `streamArray()`).** `Pick`'s filter accepts a `RegExp` tested against the dot-joined stack path (default separator `.`) [CITED: github.com/uhop/stream-json/wiki/FilterBase], so `pick({filter: /^Results\.\d+\.Vulnerabilities\.\d+$/})` selects **every individual vulnerability object across every Result**, one token-run at a time, without ever assembling a `Result` or a whole `Vulnerabilities` array. Because Pick then "produces a stream of objects similar to JSON Streaming ... usually piped through StreamValues" [CITED: github.com/uhop/stream-json/wiki/Pick], the correct downstream streamer is **`streamValues()`, not `streamArray()`** — this is the officially documented companion for exactly this multi-match-Pick shape.
3. **This directly conflicts with D-08's forbidden-API list**, which currently bans `streamValues(` in the parser path (inherited from PITFALLS.md Pitfall 1, which characterizes `streamValues` as looking "deceptively 'stream-like'" while buffering). That characterization does not hold up against the official docs: `streamValues()` streams one **complete value** at a time — same memory contract as `streamArray()`, just for a value-sequence instead of one big array's elements — see `## Correction to Prior Research` below. **The planner must resolve this before finalizing tasks** (see Open Questions #1).
4. **stream-json's current major (3.x, latest `3.5.0`) is ESM-only and requires Node ≥22** [VERIFIED: uhop/stream-json README, `"type": "module"` confirmed in the published package.json]. This project's `apps/api/tsconfig.json` pins `"module": "commonjs"` (locked in Phase 1 for NestJS decorator-metadata compatibility) — and TypeScript's CommonJS emit **downlevels dynamic `import()` to `require()`** unless `module` is `node16`/`node18`/`nodenext`/`preserve` [CITED: typescriptlang.org/docs/handbook/modules/theory.html]. Since changing `module` is out of this phase's scope and risky against Phase 1's locked NestJS DI decision, **pin `stream-json@2.1.0`** (the last version published with `"type": "commonjs"`, functionally identical API per the official 2.x→3.x migration guide) instead of the newer ESM-only 3.x line that STACK.md/existing research had not yet flagged as a compatibility hazard.

**Primary recommendation:** Build the parser on `pick({filter: /^Results\.\d+\.Vulnerabilities\.\d+$/})` → `streamValues()` → a plain-function CRITICAL filter stage → `chain.none` to drop, consuming the resulting `chain()` Node stream via `for await...of` inside the `async *parse()` generator. Pin `stream-json@2.1.0` + `stream-chain@3.6.3` (both CommonJS-compatible, zero tsconfig changes needed). Flag the D-08 forbidden-API conflict for the planner/user to resolve explicitly.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Stream-parse Trivy JSON, filter CRITICAL | Backend / parser module (`apps/api/src/parser/`) | — | Pure Node.js stream pipeline; no HTTP/GraphQL/queue involvement this phase (ARCH boundary per CONTEXT.md `<domain>`) |
| Fixture generation (500MB+ synthetic report) | Backend / dev tooling (`apps/api/scripts/`) | — | Build-time/CI-time tool, not shipped runtime code |
| Memory self-test harness (peak RSS/heapUsed sampling) | Backend / dev tooling (`apps/api/scripts/`) | — | Runs the parser standalone under `node --max-old-space-size=150`; not wired into any server |
| Forbidden-API guard (D-08) | Static analysis / CI (ESLint config + `lint` script) | — | Mechanical enforcement, zero runtime cost |
| CI memory gate (D-09) | CI / GitHub Actions | — | Reproducibility of the pass/fail claim outside any developer's machine |
| Domain type mapping (TrivyVulnerability → Vulnerability) | Backend / parser module | Domain layer (`apps/api/src/domain/`, already built Phase 1) | Parser imports and maps into Phase 1's frozen types; no new type authoring needed |

## Correction to Prior Research

> This section reconciles findings that materially change or override claims in `.planning/research/PITFALLS.md` and `.planning/research/STACK.md`. The planner should treat this section as authoritative for Phase 2 over those files where they conflict.

### `streamValues()` is not a buffering trap — PITFALLS.md Pitfall 1 overstates this

PITFALLS.md's Pitfall 1 lists `stream-json`'s `StreamValues`/`streamValues()` alongside Node's `Readable.toArray()` as things that "buffer entire values into memory by design." Verified against the official wiki [CITED: github.com/uhop/stream-json/wiki/StreamValues, github.com/uhop/stream-json/wiki/Concepts]:

> "`StreamValues` assumes that a token stream represents subsequent values and streams them out one by one ... As every streamer, it assumes that individual objects can fit in memory, but the whole file, or any other source, should be streamed."

This is the **identical memory contract as `streamArray()`** — one item fully in memory at a time, the surrounding stream never buffered. The two streamers differ only in what "item" means: `streamArray()` = elements of one top-level array (`{key: index, value}`); `streamValues()` = a sequence of independent values, typically the multiple subobjects a multi-match `Pick` selects (`{key: sequenceIndex, value}`). `Readable.toArray()` (Node 17+, a totally separate, non-stream-json built-in) is the actual full-buffering trap PITFALLS.md was really warning about — the two got conflated in that document. **Do not carry the "ban streamValues" conclusion into this phase's D-08 guard without resolving this** (see Open Questions #1).

### The nested nested-Result approach in ARCHITECTURE.md's Pattern 2 example is a latent memory-flatness bug

ARCHITECTURE.md's own code example (`## Pattern 2`) does:
```typescript
for await (const {value} of pipeline) {          // pipeline = pick('Results') -> streamArray()
  for (const vuln of value.Vulnerabilities ?? []) { ... }
}
```
This is exactly the shape that fully assembles each `Result` (including its whole `Vulnerabilities` array) before your code ever sees it. It happens to "work" and even look correct in a unit test with 2-3 small Results, and would still pass a 500MB self-test **if the fixture generator happens to spread vulnerabilities evenly across many small Results** — but it does not satisfy MEM-04's "at most one vulnerability object in memory at a time" as a structural guarantee, only as an accident of fixture shape. The regex-Pick + `streamValues()` approach (below) removes this dependency on fixture shape entirely.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| stream-json | **2.1.0** (NOT latest 3.5.0) | Streaming JSON tokenizer + pick/streamValues | Last release published `"type": "commonjs"` [VERIFIED via `npm pack stream-json@2.1.0` and inspecting package.json directly]. 3.x is ESM-only and requires Node ≥22 with `module: nodenext`-style TS config to consume via dynamic import without downlevel-to-`require()` breakage — a tsconfig change this phase should not force. Per the official migration guide, "runtime APIs, factory shapes, token vocabulary, and per-module export structure are unchanged" between 2.x and 3.x [CITED: github.com/uhop/stream-json/wiki/Migrating-from-2.x-to-3.x] — no functional loss from pinning 2.1.0 |
| stream-chain | **3.6.3** | Pipeline composition (`chain([...])`), backpressure propagation | Matches stream-json@2.1.0's declared dependency range (`^3.6.1`) [VERIFIED: `npm pack stream-json@2.1.0` package.json `dependencies.stream-chain`]. Same author, versions move in lockstep |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Node.js built-in `fs.createWriteStream` + `node:stream/promises` `once`/`finished` | n/a (built-in) | Fixture generator backpressure (D-03) | Always — `ws.write(chunk)` returning `false` means "await `once(ws, 'drain')` before writing more"; standard Node backpressure idiom [CITED: nodejs.org/learn/modules/backpressuring-in-streams, already in PITFALLS.md sources] |
| Node.js built-in `node:process` `memoryUsage()` / `memoryUsage.rss()` | n/a (built-in) | Memory self-test sampling (D-05) | Always — `memoryUsage.rss()` is a cheaper single-value call than full `memoryUsage()`, useful for a tight sampler interval [VERIFIED: nodejs.org/api/process.html, fetched directly] |
| ESLint core rules `no-restricted-syntax`, `no-restricted-properties`, `no-restricted-imports` | Already installed (project's ESLint 10.6.0) | Forbidden-API guard (D-08) | No new dependency — the project's existing ESLint config gains rule entries; see Code Examples below |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `pick(regex)` + `streamValues()` (recommended) | `pick('Results')` + `streamArray()` + nested per-Result `Disassembler`→`pick`→`streamArray` re-tokenization | More "textbook nested pipeline" look, but requires re-serializing each Result back to tokens via `Disassembler` before re-picking — no official worked example found for this exact shape in the current docs; higher implementation risk for no memory-safety benefit over the regex-Pick approach. Not recommended |
| stream-json@2.1.0 (CJS) | stream-json@3.5.0 (ESM) + `await import()` inside the async generator + tsconfig `module: nodenext` | Viable in principle (dynamic `import()` from a CJS module IS a supported Node interop pattern) but requires changing `apps/api/tsconfig.json`'s `module` setting, which risks the NestJS `emitDecoratorMetadata` CJS-reflection behavior Phase 1 explicitly locked in. Revisit if the project later migrates the whole app to ESM |
| Grep-based CI check (D-08) | Custom ESLint rule (`no-restricted-syntax`/`no-restricted-properties`) | ESLint gives inline editor feedback and typed AST matching (won't false-positive on comments/strings containing the banned text, unlike naive grep); grep is simpler to write but noisier. Recommend ESLint since the project already has strict ESLint infrastructure from Phase 1 |

**Installation:**
```bash
cd apps/api
npm install stream-json@2.1.0 stream-chain@3.6.3
```

**Version verification performed this session:**
```
$ npm view stream-json version        # 3.5.0 (latest, ESM-only — do NOT use)
$ npm view stream-chain version       # 4.2.5 (latest, paired with stream-json 3.x)
$ npm pack stream-json@2.1.0 && inspect package.json  # "type": "commonjs", deps: {"stream-chain": "^3.6.1"}
$ npm view stream-chain versions      # confirms 3.6.3 exists as latest 3.6.x patch
```

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|--------------|---------|-------------|
| stream-json | npm | created 2013 (package.json "latest"=3.5.0 published 2026-07-07) | 7.63M/week | github.com/uhop/stream-json | SUS (reason: "too-new" — flags the *latest* 3.5.0 release's publish recency, not the package's legitimacy) | **Approved for pin at 2.1.0** (published well before the flagged recency window; package identity itself is a long-established, high-download, real-repo project — not a slopsquat concern) |
| stream-chain | npm | long-established | 7.88M/week | github.com/uhop/stream-chain | OK | Approved |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** `stream-json` — flagged only because the automated check queried the `latest` dist-tag (3.5.0, published 2 days before this research session) for recency, which is a false-positive for this phase's purposes since the plan pins the older, stable `2.1.0` release specifically for CJS compatibility, not the flagged latest version. No `checkpoint:human-verify` is warranted on legitimacy grounds — the package identity is confirmed via 13 years of registry history, 7.6M weekly downloads, and a real, active GitHub source repo, all checked directly.

## Architecture Patterns

### System Architecture Diagram

```
apps/api/src/parser/report-parser.ts (this phase, exported, not wired anywhere yet)

  fixturePath (local disk file, 50MB-1GB, produced by scripts/gen-fixture.ts)
        │
        ▼
  fs.createReadStream(fixturePath)          ← bounded-size chunks (highWaterMark)
        │
        ▼
  parser()                                   ← stream-json tokenizer: bytes -> SAX-style tokens
        │
        ▼
  pick({ filter: /^Results\.\d+\.Vulnerabilities\.\d+$/ })
        │   ↳ matches ONLY leaf vulnerability objects, at any Result index;
        │     everything else (Target, SchemaVersion, non-matching paths) is
        │     dropped as tokens -- never assembled into a JS object
        ▼
  streamValues()                              ← assembles ONE matched object at a time
        │        {key: sequenceIndex, value: TrivyVulnerability}
        ▼
  (data) => data.value.Severity === 'CRITICAL' ? data.value : chain.none
        │        ← plain function stage; cheapest chain() stage type;
        │          drops non-CRITICAL before it reaches the generator
        ▼
  ReportParser.parse() [async generator]
        │   for await (const vuln of pipeline) { yield mapToVulnerability(vuln); }
        ▼
  CONSUMER (this phase: memory self-test counts/discards;
            Phase 3 later: BullMQ worker persists to ScanRepository)
```

### Recommended Project Structure

```
apps/api/
├── src/
│   └── parser/
│       ├── report-parser.ts        # ReportParser: async *parse(path) -> AsyncIterable<Vulnerability>
│       └── report-parser.spec.ts   # correctness test against the small committed fixture (D-04)
├── scripts/
│   ├── gen-fixture.ts              # D-03: memory-bounded fixture generator CLI
│   ├── memtest.ts                  # D-05: single-size memory self-test (peak RSS/heapUsed)
│   └── memtest-sweep.ts            # D-06: 50/200/500MB(/1GB) flat-RSS sweep
├── fixtures/
│   └── known-severity-mix.json     # D-04: small, committed, hand-crafted fixture
└── eslint.config.mjs               # D-08: forbidden-API guard rule additions
```

### Pattern 1: Regex-Pick + streamValues for nested-array leaf extraction

**What:** A single `Pick` stage with a `RegExp` filter matched against the dot-joined stack path, selecting every leaf-level object at a fixed structural depth regardless of how many ancestors repeat.
**When to use:** Whenever the target objects sit inside a nested array-of-arrays (or array-of-objects-with-arrays) shape and you need every leaf item across every ancestor, without assembling the ancestors.
**Example:**
```typescript
// Source: github.com/uhop/stream-json/wiki/Pick (verified via direct GitHub wiki fetch)
// and github.com/uhop/stream-json/wiki/FilterBase (path/stack semantics)
import chain from 'stream-chain';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { streamValues } from 'stream-json/streamers/stream-values.js';
import { createReadStream } from 'node:fs';

// Path semantics: stack = [..array indices (number) and object keys (string)..].join('.')
// For { Results: [ { Vulnerabilities: [ {...}, {...} ] } ] } the path to each
// vulnerability is "Results.<resultIndex>.Vulnerabilities.<vulnIndex>"
const CRITICAL_LEAF_PATH = /^Results\.\d+\.Vulnerabilities\.\d+$/;

export async function* parseCriticalVulnerabilities(reportPath: string) {
  const pipeline = chain([
    createReadStream(reportPath),
    parser(),
    pick({ filter: CRITICAL_LEAF_PATH }),
    streamValues(),
    (data: { value: { Severity: string } }) =>
      data.value.Severity === 'CRITICAL' ? data.value : chain.none,
  ]);

  for await (const vuln of pipeline) {
    yield vuln;
  }
}
```

### Pattern 2: Bridging a stream-chain pipeline into an async generator

**What:** `chain([...])` returns a Node `Duplex`-shaped stream in object mode; Node Readables (including Duplexes) implement `Symbol.asyncIterator` natively, so `for await...of` drains the pipeline one item at a time with backpressure applied automatically (the loop does not pull the next item until your `await` body completes) [HIGH confidence: Node.js core stream API, well-established since Node 10+ `Readable[Symbol.asyncIterator]`].
**When to use:** Any time the consumer needs an `AsyncIterable` (D-01's required parser shape) rather than `.on('data', ...)` event handlers.
**Example:** see Pattern 1 above — the `for await (const vuln of pipeline)` line is the entire bridge; no extra adapter library is needed.
**Trade-off note (from official Performance guidance):** `chain()` stage cost ranking, cheapest first, is: plain functions < async functions < generator functions < async generator functions < Node streams < Web streams [CITED: github.com/uhop/stream-json/wiki/Performance]. The CRITICAL filter above is written as a **plain function** (cheapest), not a generator, since it only needs to accept-or-reject one item per call — reserve generator/async-generator stages for genuine one-to-many fan-out.

### Pattern 3: Memory-bounded fixture generation with explicit backpressure

**What:** Stream a Trivy-shaped JSON document to disk incrementally, respecting `write()`'s boolean return value.
**When to use:** Any generator producing output larger than convenient in-memory buffering (D-03).
**Example:**
```typescript
// Source: Node.js official backpressure guide (nodejs.org/learn/modules/backpressuring-in-streams)
// — pattern already cited in .planning/research/PITFALLS.md
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

async function writeChunk(ws: NodeJS.WritableStream, chunk: string): Promise<void> {
  if (!ws.write(chunk)) {
    await once(ws, 'drain');
  }
}

export async function generateFixture(path: string, targetBytes: number, criticalRatio: number) {
  const ws = createWriteStream(path);
  await writeChunk(ws, '{"SchemaVersion":2,"Results":[{"Target":"synthetic","Vulnerabilities":[');
  let written = 0;
  let i = 0;
  while (written < targetBytes) {
    const severity = i % Math.round(1 / criticalRatio) === 0 ? 'CRITICAL' : 'LOW';
    const obj = JSON.stringify({
      VulnerabilityID: `CVE-SYN-${i}`,
      PkgName: 'synthetic-pkg',
      InstalledVersion: '1.0.0',
      Severity: severity,
      Title: 'Synthetic vulnerability for memory fixture',
      PrimaryURL: 'https://example.invalid/cve',
    });
    const chunk = (i > 0 ? ',' : '') + obj;
    await writeChunk(ws, chunk);
    written += Buffer.byteLength(chunk);
    i += 1;
  }
  await writeChunk(ws, ']}]}');
  ws.end();
  await once(ws, 'finish');
}
```
Note: each `JSON.stringify(obj)` call here is bounded to ONE small vulnerability object — this is not the forbidden "JSON.parse/readFile on the report" path (ENGINE-05 bans parsing the *report*, not generating a small per-item string during fixture synthesis); the guard in D-08 should scope its ban to `apps/api/src/parser/**`, not `apps/api/scripts/**`.

### Anti-Patterns to Avoid

- **`pick('Results')` + `streamArray()` alone, assuming per-Result iteration is "streamed":** As detailed in `## Correction to Prior Research` above — each `{value}` from this shape is a fully-assembled Result, defeating MEM-04 if any single Result is large. Use Pattern 1 instead.
- **Setting `--max-old-space-size` without also logging `rss`/`external`:** V8's old-space cap does not bound `Buffer`/`ArrayBuffer` memory, which Node's own docs confirm is tracked under `external` (with `arrayBuffers` as a named subset of it) [VERIFIED: nodejs.org/api/process.html]. Log all of `rss`, `heapUsed`, `external` per D-05 — already directionally correct in CONTEXT.md, now confirmed against primary source.
- **Assuming a single final `process.memoryUsage()` reading reflects the run's memory behavior:** peak can occur transiently mid-stream; D-05's periodic sampler is the correct approach — confirmed no built-in "peak so far" API exists, sampling is the standard technique.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Path-based JSON subtree selection across nested arrays | A custom SAX-token state machine tracking array/object depth manually | `stream-json`'s `pick({filter: RegExp})` | The regex-against-joined-stack-path mechanism is exactly built for this; a hand-rolled version reimplements `FilterBase`'s stack-tracking logic (including the `maxDepth` DoS guard, default 1024, `RangeError` on deeper nesting) for no benefit |
| Async-iterator bridging over a Node stream | A manual `EventEmitter`-to-generator adapter (`.on('data')` push into a queue consumed by a generator) | Native `for await (const x of nodeStream)` | Node streams already implement `Symbol.asyncIterator` with correct backpressure semantics; a hand-rolled bridge risks getting backpressure wrong (the exact bug class Pitfall 1/4 in PITFALLS.md warn about) |
| Peak-memory tracking across a run | A custom memory-diffing algorithm | `setInterval` sampling `process.memoryUsage()` (or the cheaper `process.memoryUsage.rss()`) into a running max | `process.memoryUsage()` already gives every needed field in one call; no library needed, but do NOT reinvent the sampling loop's edge cases (e.g., must sample from the very start, must not stop before the stream truly ends) |

**Key insight:** every "custom" solution this phase might reach for (manual token state machine, manual stream-to-generator bridge, manual memory diffing) is a strictly worse reimplementation of something already correctly built into either `stream-json`/`stream-chain` or Node core — the phase should need zero bespoke streaming infrastructure beyond wiring the pipeline shape in Pattern 1.

## Common Pitfalls

### Pitfall 1: Nested `pick`+`streamArray` looks memory-safe but isn't (see `## Correction to Prior Research`)
**What goes wrong:** `pick('Results')` → `streamArray()` → per-Result `.Vulnerabilities` iteration assembles each whole Result object, including its entire Vulnerabilities array, before your filter runs.
**Why it happens:** `streamArray()`'s `{value}` is a *complete* assembled top-level-array element; this is correct/expected behavior for `streamArray`, but the wrong tool when the "unit of streaming" you actually want is one level deeper than the array you're picking.
**How to avoid:** Use Pattern 1 (regex-Pick reaching directly to the `Vulnerabilities` leaf + `streamValues()`).
**Warning signs:** Peak RSS in the flat-RSS sweep (D-06) scales with the size of the largest single Result's Vulnerabilities array, not with total file size — this could still look "flat" if the fixture generator distributes vulnerabilities evenly across many Results, silently hiding the bug. **Explicitly test a skewed fixture** (one Result with a very large Vulnerabilities array) as part of D-06/D-04 to catch this.

### Pitfall 2: `--max-old-space-size` vs RSS/external memory confusion (already documented in PITFALLS.md Pitfall 2 — reconfirmed against primary source)
**What goes wrong:** heap-only monitoring misses Buffer/ArrayBuffer memory.
**Confirmed via Node docs:** `external` = "memory usage of C++ objects bound to JavaScript objects managed by V8"; `arrayBuffers` (a subset of `external`) = "memory allocated for ArrayBuffers and SharedArrayBuffers, including all Node.js Buffers" [VERIFIED: nodejs.org/api/process.html]. `rss` = total process memory including all of the above plus code/stack.
**How to avoid:** D-05 must log `rss`, `heapUsed`, AND `external` (not just heap), matching CONTEXT.md's existing decision — now confirmed at HIGH confidence against primary source rather than PITFALLS.md's self-rated MEDIUM/websearch-tier confidence.
**Additional finding not in PITFALLS.md:** On Linux/glibc, "an application may have sustained rss growth despite stable heapTotal due to fragmentation caused by the glibc malloc implementation" [VERIFIED: nodejs.org/api/process.html, "A note on process memoryUsage"]. When setting D-05/D-06's peak-RSS threshold, budget a small margin for this — a few MB of gradual RSS creep across a long sweep run is a known allocator artifact, not necessarily evidence of a leak, but should not be waved away either; document the threshold's basis.

### Pitfall 3: stream-json 3.x's ESM-only requirement silently breaking a CommonJS build
**What goes wrong:** `npm install stream-json` (no version pin) picks up latest `3.5.0`; a CommonJS-compiled TypeScript project (`module: "commonjs"`, this project's Phase 1 locked setting) transpiles `import {pick} from 'stream-json/filters/pick.js'` to `require(...)`, which throws `ERR_REQUIRE_ESM` at runtime since `stream-json@3.x` ships no CJS entry (`"type": "module"`, `exports` map has no `require` condition).
**Why it happens:** The error only appears at runtime (`node dist/...js`), not at `tsc` compile time — `tsc --noEmit` will happily type-check against `stream-json`'s bundled `.d.ts` even though the emitted JS will fail to load.
**How to avoid:** Pin `stream-json@2.1.0` explicitly in `package.json` (not `^3.0.0` or unpinned latest).
**Warning signs:** `Error [ERR_REQUIRE_ESM]: require() of ES Module ... not supported` when running the built self-test or worker.

### Pitfall 4: forbidding `streamValues(` (D-08) blocks the only memory-safe path to nested leaf extraction
**What goes wrong:** the mechanical grep/ESLint guard rejects legitimate, correct code.
**Why it happens:** PITFALLS.md's Pitfall 1 mischaracterized `streamValues` (see `## Correction to Prior Research`).
**How to avoid:** See Open Questions #1 — planner must decide how to phrase D-08 so it still bans the *actual* danger (`Readable.toArray()`, `JSON.parse`, `fs.readFile`/`readFileSync` on the report) without also banning `streamValues()`.

## Code Examples

### Full parser skeleton (D-01 + D-02 shape, corrected pipeline)
```typescript
// apps/api/src/parser/report-parser.ts
// Sources: github.com/uhop/stream-json/wiki/Pick, /StreamValues, /FilterBase, /Performance
// (all fetched directly from the GitHub wiki this session)
import chain from 'stream-chain';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { streamValues } from 'stream-json/streamers/stream-values.js';
import { createReadStream } from 'node:fs';
import type { TrivyVulnerability } from '../domain/trivy-report.types';
import type { Vulnerability } from '../domain/vulnerability.types';

const CRITICAL_LEAF_PATH = /^Results\.\d+\.Vulnerabilities\.\d+$/;

function toVulnerability(v: TrivyVulnerability): Vulnerability {
  return {
    vulnerabilityId: v.VulnerabilityID,
    pkgName: v.PkgName,
    installedVersion: v.InstalledVersion,
    severity: 'CRITICAL',
    title: v.Title,
    primaryUrl: v.PrimaryURL,
  };
}

export class ReportParser {
  async *parse(reportPath: string): AsyncIterable<Vulnerability> {
    const pipeline = chain([
      createReadStream(reportPath),
      parser(),
      pick({ filter: CRITICAL_LEAF_PATH }),
      streamValues(),
      (data: { value: TrivyVulnerability }) =>
        data.value.Severity === 'CRITICAL' ? data.value : chain.none,
    ]);

    for await (const vuln of pipeline as AsyncIterable<TrivyVulnerability>) {
      yield toVulnerability(vuln);
    }
  }
}
```

### Memory self-test sampler skeleton (D-05)
```typescript
// apps/api/scripts/memtest.ts
// Source: nodejs.org/api/process.html (process.memoryUsage / process.memoryUsage.rss)
import { ReportParser } from '../src/parser/report-parser';

async function main() {
  const fixturePath = process.argv[2];
  if (!fixturePath) {
    console.error('Usage: memtest.ts <fixture-path>');
    process.exit(2);
  }

  let peakRss = 0;
  let peakHeapUsed = 0;
  let peakExternal = 0;
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    peakRss = Math.max(peakRss, m.rss);
    peakHeapUsed = Math.max(peakHeapUsed, m.heapUsed);
    peakExternal = Math.max(peakExternal, m.external);
  }, 200);

  const parser = new ReportParser();
  let count = 0;
  try {
    for await (const _vuln of parser.parse(fixturePath)) {
      count += 1;
    }
  } finally {
    clearInterval(sampler);
  }

  console.log(JSON.stringify({
    criticalCount: count,
    peakRssMb: +(peakRss / 1024 / 1024).toFixed(1),
    peakHeapUsedMb: +(peakHeapUsed / 1024 / 1024).toFixed(1),
    peakExternalMb: +(peakExternal / 1024 / 1024).toFixed(1),
  }));

  // Threshold: derive from an observed flat baseline + margin (Claude's Discretion, CONTEXT.md).
  const RSS_THRESHOLD_MB = 180; // document the basis for this number once measured
  if (peakRss / 1024 / 1024 > RSS_THRESHOLD_MB) {
    console.error(`Peak RSS ${peakRss} exceeded threshold ${RSS_THRESHOLD_MB}MB`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### ESLint forbidden-API guard skeleton (D-08)
```javascript
// apps/api/eslint.config.mjs — additive rules scoped to the parser path
// Sources: eslint.org/docs/latest/rules/no-restricted-syntax,
//          eslint.org/docs/latest/rules/no-restricted-properties,
//          eslint.org/docs/latest/rules/no-restricted-imports (importNames option)
export default [
  // ...existing config...
  {
    files: ['src/parser/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='JSON'][callee.property.name='parse']",
          message: 'JSON.parse is forbidden on the report path (ENGINE-05).',
        },
        {
          // Node 17+ Readable.toArray() — the real full-buffering trap
          selector: "CallExpression[callee.property.name='toArray']",
          message: 'Readable.toArray() buffers the entire stream — forbidden on the report path.',
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'fs', property: 'readFileSync', message: 'Use the streaming parser pipeline instead.' },
        { object: 'fs', property: 'readFile', message: 'Use the streaming parser pipeline instead.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:fs',
              importNames: ['readFile', 'readFileSync'],
              message: 'Use fs.createReadStream via the stream-json pipeline instead.',
            },
            {
              name: 'fs',
              importNames: ['readFile', 'readFileSync'],
              message: 'Use fs.createReadStream via the stream-json pipeline instead.',
            },
          ],
        },
      ],
      // NOTE: streamValues( is intentionally NOT banned here — see RESEARCH.md
      // "## Correction to Prior Research" and Open Questions #1. If the planner
      // decides to keep the ban from D-08 literally, add a matching
      // no-restricted-syntax selector for CallExpression[callee.name='streamValues'].
    },
  },
];
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `stream-json` 1.x/2.x CommonJS, `require('stream-json')` | `stream-json` 3.x, ESM-only, `import` | 3.0.0 (per Release history, moved to ESM on `stream-chain` 4.x) | Any CJS/TypeScript-`commonjs`-module project must either pin ≤2.1.0 or adopt `module: node16/nodenext` + dynamic import |
| `Assembler` extending `EventEmitter`, `.on('done', ...)` | `Assembler`/`FlexAssembler` plain classes with `onDone(fn)` callback | 3.0.0 | Not directly used by this phase's plan (we use `streamValues()`, which sits on `Assembler` internally but doesn't expose this), but relevant if Claude's Discretion leads toward driving `Assembler` directly |
| Default export `make()` bundling `emit()` | Default export renamed `parserStream`, `emit()` decoration dropped | 3.0.0 | Not used by this phase's recommended pipeline (we use the named `parser` export directly) |

**Deprecated/outdated:**
- `stream-json`'s old `jsonl/Parser` / `jsonl/Stringer` — deprecated in favor of `stream-chain`'s JSONL support; irrelevant to this phase (Trivy output is a single JSON document, not JSONL).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The synthetic fixture generator's output shape (one `Result` with a flat `Vulnerabilities` array, vs. many small Results) is left to Claude's Discretion per CONTEXT.md — this research recommends explicitly testing BOTH a many-small-Results fixture and a single-huge-Result fixture, since real Trivy output for a monorepo scan can plausibly produce either shape depending on how many distinct manifest files are scanned | Runtime State Inventory / Pattern 1 | If only the "many small Results" shape is tested, Pitfall 1's memory-flatness bug can hide undetected until a real large scan (Phase 3+) with a concentrated Result triggers it |
| A2 | `stream-json@2.1.0`'s bundled TypeScript typings (`types: "./src/index.d.ts"`) are compatible with this project's strict tsconfig (`noUncheckedIndexedAccess`, `strict: true`) without needing `@types/stream-json` — not independently verified this session (types file existence was confirmed in the packed tarball listing, but type-compatibility with strict mode was not compiled/tested) | Standard Stack | Minor: a handful of `as` casts or a local `.d.ts` augmentation might be needed at implementation time if a type doesn't line up; low implementation risk, not a design risk |
| A3 | The RSS threshold value in the memtest skeleton (180MB) is a placeholder, not a researched number — CONTEXT.md explicitly leaves this to Claude's Discretion ("derive from observed flat baseline + margin") | Code Examples | If the planner or executor copies the placeholder verbatim without deriving it from an actual measured run, the self-test could pass/fail incorrectly |

## Open Questions (RESOLVED)

1. **D-08 wording — RESOLVED.**
   - The guard bans the actual full-materialization operations on `apps/api/src/parser/**`: `JSON.parse`, `fs.readFile`/`readFileSync`, and `Readable.toArray()`.
   - `streamValues()` is explicitly permitted because the corrected leaf-Pick/streamValues pipeline is the verified memory-flat implementation. The guard also requires the deep `Results.<index>.Vulnerabilities.<index>` Pick path, so permitting `streamValues()` cannot silently restore the old whole-Result shape.

2. **Fixture shape — RESOLVED.**
   - The committed correctness fixture contains multiple `Results` entries and a deliberately skewed entry with a concentrated vulnerability array, alongside mixed CRITICAL and non-CRITICAL severities.
   - The generated memory-proof fixture defaults to the concentrated single-Result shape so the self-test exercises the former whole-Result materialization failure mode; the generator may expose an explicit distributed shape for diagnostics, but the default sweep and CI gate use the skewed shape.

3. **Node 22 versus local Node 24 — RESOLVED.**
   - Node 22 is authoritative because `apps/api/package.json` pins `>=22 <23` and the GitHub Actions job uses `actions/setup-node@v4` with `node-version: 22`.
   - The authoritative command is `node --max-old-space-size=150 apps/api/dist/scripts/memtest.js <fixture-path>` after the API build. A matching local command is required and must be run when Node 22 is available; on the current Node 24 sandbox it is a smoke check only and must be labeled non-authoritative, with CI retaining the Node 22 proof.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Self-test runtime, build | Partial | v24.10.0 local (pinned range is `>=22 <23`) | Rely on GitHub Actions' `actions/setup-node@v4` with `node-version: '22'` for authoritative CI verification (D-09); treat local runs as smoke tests only |
| npm | Package install | ✓ | 11.6.1 | — |
| Disk space (for 500MB+ fixture generation) | D-03/D-09 | ✓ | GitHub Actions `ubuntu-latest` guarantees ~14GB usable disk [CITED: github.com/actions/runner-images, community-verified]; local sandbox has 60GB free on `/tmp` | 500MB fixture is well within either budget — no cleanup action needed in the CI workflow |
| GitHub Actions runner | D-09 CI gate | ✓ (assumed available to the repo) | `ubuntu-latest`, `actions/setup-node@v4` | — |

**Missing dependencies with no fallback:** none blocking.
**Missing dependencies with fallback:** exact-Node-22 local verification (falls back to CI as the authoritative gate, per Open Question #3).

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No | Not applicable — this phase has no HTTP/auth surface |
| V3 Session Management | No | Not applicable |
| V4 Access Control | No | Not applicable |
| V5 Input Validation | Partial | Fixture generator CLI args (target size in MB, severity mix ratio) should be validated as positive numbers within sane bounds before use — low-risk since args come from a developer/CI job, not an external user, but cheap to guard |
| V6 Cryptography | No | Not applicable — no secrets/crypto in this phase |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|-----------------------|
| Pathologically deep/adversarial JSON nesting causing stack exhaustion or resource exhaustion during parse | Denial of Service | `stream-json`'s `FilterBase` (used by `pick`) has a built-in `maxDepth` guard (default `1024`) that throws a `RangeError` instead of matching deeper-nested tokens [VERIFIED: github.com/uhop/stream-json/wiki/FilterBase, fetched directly] — this is a real, already-built-in defense; no additional code needed, just don't override `maxDepth: Infinity` without a reason |
| A single skewed/malicious report concentrating enormous data in one array element to defeat "streaming" | Denial of Service | Addressed structurally by Pattern 1's leaf-level regex-Pick — since no ancestor object (`Result`) is ever assembled whole, a single skewed Result cannot create an outsized peak the way the naive `pick('Results')+streamArray()` approach could (see `## Correction to Prior Research`) |

## Sources

### Primary (HIGH confidence)
- github.com/uhop/stream-json/README.md (raw, fetched directly) — module type, version history line "3.0.0 Moved to ESM using stream-chain 4.x"
- github.com/uhop/stream-json/wiki/Concepts, /Intro, /Pick, /StreamArray, /StreamValues, /FilterBase, /Performance (raw wiki markdown, fetched directly via `raw.githubusercontent.com/wiki/...`, NOT AI-summarized) — exact pipeline composition, path/stack semantics, streamer contracts, stage-cost ranking
- github.com/uhop/stream-json/wiki/Migrating-from-2.x-to-3.x (raw, fetched directly) — CJS→ESM breaking change table, confirms API-identical claim
- `npm pack stream-json@2.1.0` / `@3.5.0` / `stream-chain` (local tarball inspection of actual published `package.json`) — confirmed `"type"` field, `exports`, `dependencies` version ranges directly from registry artifacts
- nodejs.org/api/process.html (raw HTML, fetched and parsed directly) — `process.memoryUsage()` field definitions (`rss`, `heapTotal`, `heapUsed`, `external`, `arrayBuffers`), glibc malloc fragmentation note, `process.memoryUsage.rss()`
- eslint/eslint GitHub repo raw docs (`docs/src/rules/no-restricted-imports.md`, fetched directly) — `importNames` option syntax, confirmed

### Secondary (MEDIUM confidence)
- typescriptlang.org/docs/handbook/modules/theory.html (via WebSearch synthesis) — TypeScript's CommonJS emit behavior for dynamic `import()` (downlevels to `require()` unless `module` is `node16`/`node18`/`nodenext`/`preserve`)
- eslint.org/docs/latest/rules/no-restricted-syntax, /no-restricted-properties (via WebSearch synthesis) — `CallExpression` selector syntax, `object`/`property` option shape
- GitHub Actions runner disk space community sources (via WebSearch synthesis, cross-referenced against `actions/runner-images` discussions) — ~14GB guaranteed usable disk on `ubuntu-latest`
- `.planning/research/PITFALLS.md`, `.planning/research/STACK.md`, `.planning/research/ARCHITECTURE.md` (existing project research, MEDIUM per their own self-rating) — reused for fixture/backpressure patterns, corrected where found inaccurate (see `## Correction to Prior Research`)

### Tertiary (LOW confidence)
- None outstanding — the load-bearing API claims (pick/streamValues semantics, ESM/CJS module type) were all cross-checked against directly-fetched primary sources rather than left at WebSearch-summary tier.

## Metadata

**Confidence breakdown:**
- Standard stack (stream-json/stream-chain version pinning, CJS/ESM compatibility): HIGH — verified via direct `npm pack` tarball inspection and official GitHub wiki/README, not summarized
- Architecture (regex-Pick + streamValues pipeline shape): HIGH — verified via official wiki pages (Pick, StreamValues, FilterBase, Concepts) fetched raw
- Pitfalls (memory-flatness of nested pick/streamArray vs. regex-Pick): HIGH — directly derived from official docs' own description of how `streamArray`/`Assembler` work; MEDIUM on the specific claim about how CONTEXT.md's fixture generator will distribute severities (depends on planner/executor choices not yet made)
- ESLint guard patterns: HIGH for core rule existence/syntax (fetched eslint.org/eslint repo docs directly); MEDIUM on exact selector strings not independently executed against a live ESLint instance this session
- Security domain: MEDIUM — ASVS applicability reasoning is straightforward for this narrow, non-HTTP phase; the `maxDepth` DoS mitigation is HIGH (verified in official docs)

**Research date:** 2026-07-09
**Valid until:** 30 days for the architecture/pitfall findings (stable Node.js/stream-json core semantics); 7 days for the exact version pins (`stream-json@2.1.0`, `stream-chain@3.6.3`) if the team wants to re-check for newer CJS-compatible patches before implementation starts
