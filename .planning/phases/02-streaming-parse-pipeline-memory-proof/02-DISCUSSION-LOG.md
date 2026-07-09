# Phase 2: Streaming Parse Pipeline & Memory Proof - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-09
**Phase:** 2-streaming-parse-pipeline-memory-proof
**Mode:** `--auto` (recommended option auto-selected for each gray area; grounded in REQUIREMENTS.md ENGINE-05/MEM-01..04 + research/PITFALLS.md + research/STACK.md)
**Areas discussed:** Parser output API, Streaming pipeline shape, Fixture generator, Correctness fixture, Memory self-test harness, Flat-RSS proof, Code location & forbidden-API guard, CI gate

---

## Parser Output API (D-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Async generator `async *parse(): AsyncIterable<Vulnerability>` | Yields one vuln then suspends — structurally one-object-in-flight | ✓ |
| EventEmitter / callback per vuln | Push model; harder to guarantee no accumulation | |
| Collect into CRITICAL-only array, return it | Fine for small CRITICAL count but couples parser to accumulation | |

**Auto-selected:** Async generator — structurally satisfies MEM-04 ("at most one vulnerability object in memory"); consumer decides persistence/counting.
**Notes:** A generator cannot silently accumulate — the strongest structural defense against PITFALLS Pitfall 1.

## Streaming Pipeline Shape (D-02)

| Option | Description | Selected |
|--------|-------------|----------|
| Nested `pick`+`streamArray` (outer Results, inner Vulnerabilities) | No Result ever materialized whole; per-vuln CRITICAL filter | ✓ |
| Stream outer Results, `JSON.parse` inner Vulnerabilities | Forbidden + OOM risk on large Results | |

**Auto-selected:** Nested pick/streamArray with per-object CRITICAL filter, zero JSON.parse/readFile/toArray/streamValues (ENGINE-05).
**Notes:** Directly implements the ROADMAP/ENGINE-05 pipeline and defuses PITFALLS Pitfall 1's "inner sub-array" half-measure.

## Fixture Generator (D-03) & Correctness Fixture (D-04)

| Option | Description | Selected |
|--------|-------------|----------|
| Streamed `fs.createWriteStream` writer w/ backpressure, size+mix CLI args | Memory-bounded generation of 500MB+; deterministic CRITICAL count | ✓ |
| Build in memory then write | Violates MEM-01 (must be memory-bounded) | |

**Auto-selected:** Streamed generator (default 500MB) + a separate tiny committed known-severity fixture for the correctness assertion (Criterion 3).
**Notes:** Large fixture ephemeral/git-ignored; small fixture committed for fast deterministic correctness.

## Memory Self-Test Harness (D-05) & Flat-RSS Proof (D-06)

| Option | Description | Selected |
|--------|-------------|----------|
| Periodic sampler tracking PEAK rss+heapUsed+external; non-zero on OOM/threshold; multi-size sweep | Catches transient spikes; honors heap-vs-RSS distinction | ✓ |
| Final `memoryUsage()` reading only | Misses transient peaks; heap-only blind to Buffers | |

**Auto-selected:** Sampled peak RSS (+external) under `--max-old-space-size=150`; flat-RSS sweep across 50/200/500MB/1GB.
**Notes:** PITFALLS Pitfall 2 — `--max-old-space-size` caps only V8 old-space; log `external` because Buffers live off-heap.

## Code Location & Forbidden-API Guard (D-07, D-08)

| Option | Description | Selected |
|--------|-------------|----------|
| `apps/api/src/parser/` + scripts under `apps/api/scripts/`; grep/lint guard; export but don't wire | Standalone, testable, Phase 3 wires via ScanModule | ✓ |
| Wire into ScanModule runtime now | Out of scope (queue/worker is Phase 3) | |

**Auto-selected:** Standalone `ReportParser` in `src/parser/`, self-test/fixture scripts, mechanical forbidden-API grep guard; not wired into runtime.

## CI Gate (D-09)

| Option | Description | Selected |
|--------|-------------|----------|
| GH Actions (Node 22): gen 500MB fixture → run self-test under heap cap → fail on non-zero exit | Reproducible OOM gate (MEM-03) | ✓ |
| Skip CI, local self-test only | Fails MEM-03 | |

**Auto-selected:** Dedicated GH Actions job; ephemeral fixture; fails build on OOM.

---

## Claude's Discretion

- Exact npm script names, sampler interval, concrete peak-RSS threshold value, consumer-side NDJSON vs counter, `parser/` vs `engine/` naming, grep-guard vs ESLint-rule, sweep as separate script vs `--sweep` flag.

## Deferred Ideas

- Worker/BullMQ invocation, `git clone`, Trivy CLI execution, cleanup → Phase 3 (incl. the `child_process`/execa maxBuffer trap, PITFALLS Pitfall 3).
- REST/GraphQL surface → Phase 4.
- Docker `mem_limit: 200m` RSS gate (Bonus C) → Phase 5.
