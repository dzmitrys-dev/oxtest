---
phase: 02-streaming-parse-pipeline-memory-proof
verified: 2026-07-10T00:00:00Z
status: human_needed
score: 3/5 must-haves verified
behavior_unverified: 2
overrides_applied: 0
behavior_unverified_items:
  - truth: "The 512 MiB fixture parses successfully under the authoritative Node 22 executable with a 150 MiB V8 heap cap."
    test: "Run the exact Node 22 CI command on a Node 22 runner."
    expected: "The byte assertion passes, memtest drains all expected CRITICAL records, logs peak rss/heapUsed/external, and exits 0 below the RSS threshold."
    why_human: "This workspace only has Node 24.10.0; the fail-closed Node 22 guard prevents the authoritative command from running locally."
  - truth: "The GitHub Actions Node 22 memory job executes and fails closed on an OOM or non-zero memory proof."
    test: "Run or inspect a completed GitHub Actions memory-proof job on the submitted workflow."
    expected: "Node major 22 is enforced, the 512 MiB fixture is byte-checked immediately before memtest, and any non-zero memtest/sweep result fails the job."
    why_human: "Static workflow inspection proves command ordering and shell semantics, but not an actual hosted runner execution."
human_verification:
  - test: "Execute the authoritative Node 22 sequence from .github/workflows/memory.yml on Node 22."
    expected: "The 512 MiB fixture is at least 512*1024*1024 bytes; node --max-old-space-size=150 apps/api/dist/scripts/memtest.js exits 0 and logs peak RSS/heapUsed/external; the bounded sweep passes."
    why_human: "Local Node 24.10.0 cannot provide authoritative Node 22 evidence, and the repository has no completed CI run available to this verifier."
  - test: "Confirm a GitHub Actions run of the memory.yml job completes successfully."
    expected: "The exact Node 22 gate and bounded sweep pass, with cleanup preserving the primary command's exit status."
    why_human: "Hosted CI execution is external to the local codebase."
---

# Phase 02: Streaming Parse Pipeline & Memory Proof Verification Report

**Phase Goal:** The stream-json parse pipeline extracts CRITICAL-only vulnerabilities from a 500MB+ Trivy report under a 150MB heap — proven in isolation and gated in CI — before any queue/HTTP plumbing exists.
**Verified:** 2026-07-10
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | The memory self-test runs ReportParser against a 500MB+ fixture under `node --max-old-space-size=150` and exits 0, logging peak RSS and heapUsed. | ⚠️ PARTIAL / BEHAVIOR UNVERIFIED | Independently generated a 536,871,164-byte fixture and ran the exact compiled memtest shape under `--max-old-space-size=150` on Node 24; it passed with 262,944 CRITICALs, peak RSS 190.7 MiB, heapUsed 63.0 MiB, external 2.3 MiB. The authoritative Node 22 guard was run and exited 2: `Node 22 required for authoritative self-test`. |
| 2 | Peak RSS stays flat across 50MB / 200MB / 500MB fixtures. | ✓ VERIFIED | Live default sweep passed for 50/200/500 MiB: peak RSS 228.4, 228.7, and 224.4 MiB respectively; the 40 MiB raw-byte band passed for every case. The default dry-run enumerated exactly those three cases; 1 GiB appeared only with `--include-1gb`. |
| 3 | A mixed-severity fixture emits exactly CRITICAL vulnerabilities and zero non-CRITICAL values without report-wide reads or JSON.parse. | ✓ VERIFIED | Full parser test run passed: 6/6 tests, including exact three-item mapped output and all-CRITICAL assertion. `report-parser.ts` uses `createReadStream`, deep `Results.\\d+.Vulnerabilities.\\d+` pick, `streamValues`, and has no `readFile`, `readFileSync`, `JSON.parse`, or `.toArray(`. |
| 4 | The fixture generator produces a 500MB+ Trivy-shaped JSON on demand while remaining streamed and bounded. | ✓ VERIFIED | Live generator run produced 536,871,164 bytes (strictly above 512 MiB and 500 MiB), 2,629,434 records, and 262,944 CRITICAL records. Source uses one object at a time, explicit drain handling, atomic temporary output, and no report-sized array. |
| 5 | A GitHub Actions CI job runs the memory self-test and fails the build on OOM. | ⚠️ PARTIAL / BEHAVIOR UNVERIFIED | `.github/workflows/memory.yml` statically contains setup-node `node-version: 22`, `npm ci`, a major-version assertion, build, immediate 512 MiB generation, exact byte assertion, exact 150 MiB memtest command, `set -euo pipefail`, and a status-preserving cleanup trap; the contract test passed. No hosted Node 22 execution was available. |

**Score:** 3/5 truths verified (2 present and wired, behavior-unverified)

## Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `apps/api/src/parser/report-parser.ts` | Leaf-streaming async generator and CRITICAL mapping | ✓ VERIFIED | Substantive implementation; imports frozen domain types; no forbidden materialization APIs. |
| `apps/api/src/parser/report-parser.spec.ts` | Deterministic parser regression test | ✓ VERIFIED | 6 focused tests pass against committed fixture and malformed/missing inputs. |
| `apps/api/fixtures/known-severity-mix.json` | Committed mixed-severity Trivy-shaped input | ✓ VERIFIED | Fixture is consumed by the passing focused test. |
| `apps/api/scripts/gen-fixture.ts` | Backpressure-aware generator | ✓ VERIFIED | Live 512 MiB byte proof passed; invalid-input and safety cases are covered by the 14-test contract. |
| `apps/api/scripts/memtest.ts` | Peak memory self-test and exit gate | ✓ VERIFIED | Drains without collecting, samples RSS/heapUsed/external, clears sampler in finally, and fails closed. Node 24 local run passed; Node 22 remains unexecuted. |
| `apps/api/scripts/memtest-sweep.ts` | Flat-RSS matrix and explicit 1 GiB opt-in | ✓ VERIFIED | Live default sweep and both dry-run modes passed. |
| `apps/api/scripts/memory-process-contract.test.mjs` | Process-safety assertions | ✓ VERIFIED | 14/14 tests passed. |
| `.github/workflows/memory.yml` | Node 22 CI gate | ✓ VERIFIED (static) | Exact sequencing and fail-closed shell behavior present; hosted execution is unverified. |

## Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `report-parser.ts` | domain vulnerability/report types | typed leaf validation and PascalCase-to-camelCase mapping | ✓ WIRED | Imports and uses `TrivyVulnerability` and `Vulnerability`; typecheck passes. |
| parser spec | known-severity fixture | async-generator iteration | ✓ WIRED | `for await` consumes the fixture and asserts exact output. |
| generator | memtest | generated fixture path | ✓ WIRED | CI and sweep pass the generated path as a discrete argument. |
| memtest | ReportParser | direct async-generator drain | ✓ WIRED | `for await` increments only a count; no result collection. |
| workflow | generator/memtest/sweep | ordered Node 22 shell commands | ✓ WIRED (static) | Contract test and direct source inspection pass; no live hosted run available. |

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| `ReportParser` | yielded `Vulnerability` | streamed report leaf objects from fixture | Yes | ✓ FLOWING |
| `memtest.ts` | `criticalCount` and peak metrics | parser async generator and `process.memoryUsage()` sampler | Yes | ✓ FLOWING |
| `memtest-sweep.ts` | raw `peakRssBytes` | child memtest JSON output | Yes | ✓ FLOWING |

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Exact parser correctness | `npm test --workspace apps/api -- --runInBand` | 6/6 tests passed | ✓ PASS |
| Type/build/lint integrity | `npm run typecheck --workspace apps/api && npm run lint --workspace apps/api && npm run build --workspace apps/api` | All passed | ✓ PASS |
| Process safety and cleanup | `npm run test:memory-contract --workspace apps/api` | 14/14 tests passed | ✓ PASS |
| Flat-RSS default sweep | `npm run memtest:sweep --workspace apps/api` | 50/200/500 MiB passed; 228.4/228.7/224.4 MiB RSS | ✓ PASS |
| 1 GiB opt-in behavior | `npm run memtest:sweep --workspace apps/api -- --include-1gb --dry-run` | 1024 MiB included only when requested | ✓ PASS |
| Authoritative Node 22 proof | exact plan/workflow command | Node 24 guard exited 2 before execution | ? SKIP / HUMAN |

## Probe Execution

No phase-declared `probe-*.sh` or conventional probe scripts were present. No probe substitution was used.

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| ENGINE-05 | 02-01 | Stream-parse report and retain only CRITICAL; no report `readFile`/`JSON.parse` | ✓ SATISFIED | Passing parser tests, deep leaf pipeline, static forbidden-API guard. |
| MEM-01 | 02-01/02 | Generate 500MB+ Trivy-shaped fixture on demand, streamed to disk | ✓ SATISFIED | Live 536,871,164-byte generated fixture and backpressure implementation. |
| MEM-02 | 02-02 | Run parser under 150MB heap and log peak memory | ? NEEDS HUMAN | Node 24 local execution passed, but authoritative Node 22 command was blocked by the explicit version guard. |
| MEM-03 | 02-02 | Run memory proof as GitHub Actions CI gate | ? NEEDS HUMAN | Workflow is statically correct and contract-tested; no completed hosted run was available. |
| MEM-04 | 02-01/02 | At most one vulnerability in parser and flat RSS across sizes | ✓ SATISFIED | Async generator, discard-only memtest, and live 50/200/500 MiB raw RSS band pass. |

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| — | — | None found | — | No unreferenced TODO/FIXME/XXX, placeholder implementation, empty data path, or console-only implementation in phase files. |

## Later-Phase Wiring Check

The parser is intentionally not wired into `apps/api/src/index.ts`, `apps/api/src/worker.ts`, or `apps/api/src/scan/scan.module.ts`; an independent search found no `ReportParser` reference in those files. No BullMQ, clone, Trivy invocation, REST, GraphQL, or Docker runtime plumbing was added to the phase implementation. This matches the phase boundary and confirms no later-phase wiring has been pulled forward.

## Human Verification Required

1. Run the exact authoritative Node 22 command on a Node 22 runner and retain its output.
2. Confirm a successful GitHub Actions `node-22-memory` job, including the bounded sweep.

## Gaps Summary

No implementation blocker was found. The remaining escalation is evidence scope, not a detected code defect: this environment has Node 24.10.0, while the project requires Node `>=22 <23` and the workflow explicitly refuses non-22 runtimes. Therefore the local 150 MiB run and static CI inspection are strong partial evidence, but they do not replace the authoritative Node 22 execution.

---

_Verified: 2026-07-10_
_Verifier: the agent (gsd-verifier)_
