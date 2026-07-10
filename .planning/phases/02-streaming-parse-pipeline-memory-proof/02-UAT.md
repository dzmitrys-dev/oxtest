---
status: testing
phase: 02-streaming-parse-pipeline-memory-proof
source: [02-VERIFICATION.md]
started: 2026-07-10T00:00:00Z
updated: 2026-07-10T00:00:00Z
---

## Current Test

number: 1
name: Execute the authoritative Node 22 memory proof
expected: |
  On Node 22, generate the 512 MiB fixture, pass the exact byte assertion, run
  `node --max-old-space-size=150 apps/api/dist/scripts/memtest.js`, and confirm
  the parser drains the expected CRITICAL records while staying below the RSS gate.
awaiting: user response

## Tests

### 1. Execute the authoritative Node 22 memory proof
expected: The exact Node 22 sequence exits successfully and reports peak RSS, heapUsed, and external memory.
result: [pending]

### 2. Confirm the GitHub Actions memory-proof run
expected: The `node-22-memory` job completes successfully, including the bounded 50/200/500 MiB sweep and cleanup.
result: [pending]

## Summary

total: 2
passed: 0
issues: 0
pending: 2
skipped: 0
blocked: 0

## Gaps

- Node 22 is not installed in the current environment.
- No completed hosted GitHub Actions run is available in the current workspace.
