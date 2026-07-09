# Pitfalls Research

**Domain:** Memory-constrained async job service wrapping a CLI scanner (Node.js/TypeScript, stream-json, BullMQ, Docker) — graded take-home with a hard memory pass/fail gate
**Researched:** 2026-07-09
**Confidence:** MEDIUM (Node.js core stream/memory semantics and Trivy CLI flags are well-documented and cross-checked across multiple independent sources; provider access in this session was limited to web search rather than curated docs providers, so treat exact numeric defaults — e.g. maxBuffer sizes — as LOW-confidence and verify against the installed Node/Trivy versions before relying on them)

## Critical Pitfalls

### Pitfall 1: Accidental full-buffering of the "streamed" pipeline (the assignment's #1 fail condition)

**What goes wrong:**
The code looks like it streams (uses `stream-json`, `fs.createReadStream`) but somewhere in the chain the whole document is materialized in memory anyway: collecting every parsed vulnerability into an array before filtering, calling a helper that does `.toArray()` / `chain-async`'s collect step, awaiting a non-streaming JSON library (`JSON.parse`, `bfj.parse` in non-streaming mode, `fast-json-parse`) on the same file "just to double check", or building an in-memory summary object that grows with every element instead of writing/counting incrementally. Because Trivy's shape is `{Results: [{Vulnerabilities: [...]}]}`, a very common half-measure is streaming the outer `Results` array but then doing `JSON.parse` or `.toArray()` on each individual Result's `Vulnerabilities` sub-array once it's "small enough" — this is still forbidden and still an eventual OOM if any single Result has thousands of vulns.

**Why it happens:**
`stream-json`'s API (pick → streamArray → chain of transforms) is more awkward to reason about than "just parse it and filter," so developers reach for a synchronous escape hatch under time pressure, especially for the inner `Vulnerabilities` array once they've already streamed the outer `Results` array. It also happens invisibly: `Readable.toArray()` (Node 17+) or `stream-json`'s `StreamValues`/`streamValues()` (as opposed to `streamArray()`) buffer entire values into memory by design and look deceptively "stream-like" because they're stream classes.

**How to avoid:**
- Nest two `pick`+`streamArray` stages: one for the outer `Results` array, one applied per-Result for the inner `Vulnerabilities` array. Never resolve a Result object as a whole JS object before its Vulnerabilities are individually filtered.
- Ban `JSON.parse` and `fs.readFile`/`readFileSync` on the report file at the lint level (custom ESLint rule or grep-based CI check) — the assignment explicitly forbids these, so a mechanical guard is worth building in the setup phase.
- Never call `.toArray()`, `.read()` without a size argument in a loop that accumulates, or any collection method on the parsed stream for the *raw* report; only accumulate the small, filtered CRITICAL-only result set.
- Emit vulnerabilities directly to a `fs.createWriteStream` (e.g., NDJSON) or increment counters/append to a small array *of already-filtered* CRITICAL items — the accumulation target must shrink relative to input size, not track it 1:1.

**Warning signs:**
- Peak RSS scales linearly with input file size in your own load test (run the self-test at 100MB, 500MB, 1GB fixture sizes — if peak memory roughly triples, you're buffering).
- Any variable named `allVulns`, `results`, `report` that is populated inside a stream `data` handler and never truncated.
- Grep for `JSON.parse(`, `readFileSync(`, `.toArray(`, `streamValues(` (vs `streamArray(`) in the scan-processing path.

**Phase to address:**
Core streaming pipeline implementation phase — this is the load-bearing requirement; write the memory self-test *before or alongside* the streaming code (test-first) so regressions are caught immediately, not discovered at submission time.

---

### Pitfall 2: Confusing V8 heap limit with actual process memory (RSS) — passing your own self-test while still being OOM-killed in Docker

**What goes wrong:**
`node --max-old-space-size=150` only caps V8's old-space heap. It does **not** cap the new-space heap ceiling as tightly, stack memory, native/C++ allocations, or — critically — `Buffer`/`TypedArray` memory, which V8 tracks as "external" memory living off-heap. A pipeline that avoids putting large JS objects on the heap but still allocates large Buffers (e.g., buffering `child_process` stdout chunks, base64-decoding large blobs, or holding file-read chunks longer than needed) can pass a heap-only self-test while RSS balloons past the Docker `mem_limit: 200m`, causing a container OOM-kill (exit 137) that never shows up as a JS heap error.

**Why it happens:**
Developers verify success by watching `process.memoryUsage().heapUsed` or by the absence of a "heap out of memory" crash, both of which only reflect the V8 heap, not RSS. Buffers, streams' internal `highWaterMark` chunk pools, and native child-process pipe buffers are invisible to heap-based monitoring.

**How to avoid:**
- Instrument the self-test to log `process.memoryUsage().rss` (and ideally `external`), not just `heapUsed`, and assert RSS stays under the Docker `mem_limit` (with margin), not just under `--max-old-space-size`.
- Size `--max-old-space-size` conservatively relative to the container limit (roughly 50-70% of `mem_limit`), leaving explicit headroom for buffers/native memory — don't set it to nearly the full container budget.
- Avoid holding onto `Buffer` chunks longer than one stream tick; never concatenate raw chunks (see Pitfall 3).
- Test both constraints as separate, explicit gates: (1) `node --max-old-space-size=150` self-test (heap-focused, per the assignment's literal instruction) and (2) full `docker-compose` run with `mem_limit: 200m` (RSS-focused, Bonus C's real-world check). Passing one does not imply passing the other.

**Warning signs:**
- Container exits with code 137 / `docker events` shows an OOM kill, but the Node process logs nothing (V8 never saw an allocation failure — the kernel killed it first).
- `docker stats` shows memory climbing steadily during a scan that the heap-only self-test "passed."

**Phase to address:**
Memory self-test / verification phase, and again in the Docker/Bonus-C packaging phase — this needs two separate verification passes because they test different memory dimensions.

---

### Pitfall 3: `child_process.exec()` maxBuffer trap and stdout re-buffering when invoking Trivy

**What goes wrong:**
Using `exec("trivy ...")` (or `execFile` without a large `maxBuffer`) to run Trivy and capture its JSON on stdout will throw `Error: stdout maxBuffer exceeded` once output crosses the default limit (a few hundred KB to 1MB depending on Node version) — which a 500MB+ report will always exceed. Even fixing this by raising `maxBuffer` to something huge just relocates the same full-buffering problem from `stream-json` (Pitfall 1) into `child_process`: Node now holds the entire Trivy output as one Buffer/string in memory before your code ever gets to stream-parse it, defeating the whole point.

**Why it happens:**
`exec()` is the first API most developers reach for because it's promise-friendly and simple; its buffering behavior is opaque until it breaks at scale, and by then "just increase maxBuffer" looks like a valid quick fix.

**How to avoid:**
- Use `spawn()`, not `exec()`/`execFile()`, for invoking Trivy.
- Prefer Trivy's own `--output <file>` flag so Trivy writes the JSON report directly to disk — Node never sees the bytes on a pipe at all. This is the most memory-efficient option and sidesteps Node's stdout pipe buffering entirely.
- If you must consume via `spawn()`'s stdout pipe (e.g., for progress or when `--output` isn't suitable), pipe `child.stdout` directly into a `fs.createWriteStream` via `pipeline()`, never accumulate chunks in a JS array/string.
- Never set an artificially large `maxBuffer` as a "fix" — treat any `maxBuffer` increase as a smell indicating something is still being fully buffered.

**Warning signs:**
- `maxBuffer` appears anywhere in the codebase with a large numeric value.
- Any use of `exec(` / `execFile(` around the Trivy invocation.
- Trivy is invoked without `--output`, and you also don't see a `pipeline()`/`createWriteStream()` immediately following `spawn()`.

**Phase to address:**
Scan/worker implementation phase (the "clone repo → run Trivy → JSON report to disk" requirement) — get the invocation pattern right before building the parser on top of it.

---

### Pitfall 4: String/Buffer concatenation instead of streaming transforms

**What goes wrong:**
Even with `spawn()` and `stream-json` in place, a subtle version of full-buffering creeps in via chunk concatenation: `let buf = ''; stream.on('data', chunk => buf += chunk)`, or building up a growing `Buffer.concat([...])` across ticks (e.g., to "look at the whole line before parsing", or to reconstruct a value that `stream-json` already emits token-by-token). Each concatenation reallocates a new, larger string/Buffer, so peak memory during accumulation is roughly 2x the final size, and if it's never released, it converges on the same O(n) memory profile you were trying to avoid.

**Why it happens:**
Line-by-line or "wait for a complete chunk" mental models transfer from other tooling (log processing, CSV) where concatenation is normal; with a 500MB target, it feels tempting to build "one JSON string" and hand it to a JSON parser at the end.

**How to avoid:**
- Let `stream-json`'s token-level API assemble individual array elements/objects for you (that's its job) — you should only ever hold one `Vulnerability`-sized object in memory at a time, not the surrounding structure.
- If any manual byte-buffering is needed (e.g., custom NDJSON line splitting), use a proper streaming line-splitter (`readline` on a stream, or a small state machine that emits and discards) rather than `+=` accumulation.
- Code review checklist item: any `+=` on a string/Buffer that's fed by a stream `data` event is a red flag.

**Warning signs:**
- Memory profile shows sawtooth-then-climbing pattern (grows even as elements are processed) rather than flat/bounded.
- `Buffer.concat` or `+=` inside a stream event handler.

**Phase to address:**
Core streaming pipeline implementation phase, caught via code review before merge.

---

### Pitfall 5: Storing all vulnerabilities (or all Results metadata) instead of only CRITICAL

**What goes wrong:**
The assignment explicitly requires storing only `Severity: "CRITICAL"` vulnerabilities, but it's easy to accidentally retain more: keeping the full `Result` object (which includes Target, Class, Type, and *all* its vulnerabilities) just to "extract" the CRITICAL ones later, or storing all severities and filtering at the API-response layer instead of at ingestion. Both approaches multiply memory and Redis job-payload size by however many non-CRITICAL vulns exist (often 10-50x more common than CRITICAL).

**Why it happens:**
Filtering "later" (at display time) feels more flexible and is a common habit from non-memory-constrained work, but here it directly violates both the memory constraint and the literal grading criterion.

**How to avoid:**
- Filter at the earliest possible point in the stream pipeline — inside the per-Vulnerability transform, drop (don't collect) anything that isn't `Severity === 'CRITICAL'` before it's added to any accumulator.
- Never pass a whole `Result` object downstream; extract only the fields you need (package name, vuln ID, severity, title) for CRITICAL entries.

**Warning signs:**
- Any code path that stores a `Result` or non-CRITICAL `Vulnerability` object, even temporarily, "for later filtering."
- Output size scales with total vuln count rather than CRITICAL-only count in test fixtures.

**Phase to address:**
Core streaming pipeline implementation phase — this is a graded criterion, verify explicitly in the self-test fixture (include known counts of CRITICAL vs. non-CRITICAL and assert only CRITICAL survive).

---

### Pitfall 6: `stream-json`'s `pick` path mismatch for Trivy's actual nested shape

**What goes wrong:**
Trivy's JSON report is `{ SchemaVersion, ArtifactName, Results: [ { Target, Class, Type, Vulnerabilities: [ {...} ] } ] }`. A naive `pick({filter: 'Vulnerabilities'})` at the top level will find nothing (there's no top-level `Vulnerabilities` key — it's nested inside each array element of `Results`), or worse, silently emit zero results without an obvious error, making it look like the pipeline "ran successfully" while doing nothing.

**Why it happens:**
`stream-json`'s filter-string API resembles a JSON-path but doesn't traverse into array elements automatically — you need to pick the outer array first, stream each element, and pick again *within* each element's processing, or use a `filter` function that inspects the current stack/path rather than a single static key name.

**How to avoid:**
- Two-stage pipeline: `chain([fs.createReadStream(file), parser(), pick({filter: 'Results'}), streamArray()])` to get one `Result` object at a time, then run a second, per-Result `chain([parser-from-object-or-tokens, pick({filter: 'Vulnerabilities'}), streamArray()])`-equivalent — in practice this is commonly done by re-emitting the `Result.value` through `stream-json`'s `Disassembler`/`Assembler` helpers or, more simply, since a single `Result`'s `Vulnerabilities` array is expected to be reasonably bounded (unlike the full report), assembling that inner array directly via `streamArray()`'s `value` events on the outer object and filtering in JS after `pick`.
- Write a unit test against a small, hand-crafted fixture with the exact nested shape (2 Results, mixed severities) before running against the 500MB fixture — verify counts match expectations.
- Log a warning/assert if zero vulnerabilities are ever emitted from a non-empty report — silent empty output is the main failure mode here.

**Warning signs:**
- Zero CRITICAL vulns extracted from a fixture known to contain some.
- No errors thrown, pipeline "completes" suspiciously fast for a large file (indicates it short-circuited on an empty `pick` match).

**Phase to address:**
Core streaming pipeline implementation phase, with a small-fixture unit test as the very first verification step before scaling to the 500MB fixture.

---

### Pitfall 7: Trivy's `--exit-code` semantics misinterpreted as scan failure

**What goes wrong:**
By default, Trivy exits `0` even when vulnerabilities are found. If you pass `--exit-code 1` (a common CI convention) so that "vulnerabilities found" produces a non-zero exit, and your wrapper naively treats *any* non-zero exit code as "scan failed," every successful scan that finds vulnerabilities gets reported as a Trivy failure — including on the very NodeGoat fixture the assignment expects to succeed.

**Why it happens:**
Exit-code-as-error-signal is an extremely common Node convention (`child.on('exit', code => if (code !== 0) reject(...))`), and it's easy to copy that pattern onto Trivy without reading Trivy's own exit-code documentation.

**How to avoid:**
- Either don't pass `--exit-code` to Trivy at all (let it always exit 0 on success, non-zero only on genuine Trivy execution errors) and rely on your own severity-parsing for "were there criticals," or explicitly handle the known exit codes (0 = no matching severity found / success, the configured code = matching severity found = still a successful scan, anything else = real failure).
- Capture stderr separately and use it (plus recognized exit codes) to distinguish "Trivy ran and found vulnerabilities" from "Trivy crashed / couldn't clone / DB error."

**Warning signs:**
- Every scan against a repo with any CRITICAL vuln gets marked `Failed` in your system even though Trivy produced a valid report on disk.
- Error-handling code treats `code !== 0` as the sole failure signal for the Trivy child process.

**Phase to address:**
Trivy invocation / worker implementation phase; cover explicitly in error-handling requirements ("Trivy failure" acceptance criteria).

---

### Pitfall 8: Cleanup skipped on throw paths, partial failures, and process crashes

**What goes wrong:**
Cleanup of the cloned repo directory and the raw JSON report file is written as the "happy path" last step (`await scan(); await cleanup();`), so any exception thrown during cloning, Trivy execution, or streaming leaves the temp repo and/or multi-hundred-MB JSON file on disk permanently. Under repeated failed scans (e.g., invalid URLs, disk-full mid-clone) this silently exhausts disk space, and a subsequent scan then fails with a confusing `ENOSPC` unrelated to its own inputs.

**Why it happens:**
Cleanup-on-success is intuitive; cleanup-on-every-exit-path requires deliberate `try/finally` or equivalent structure, and it's easy to forget cleanup needs to run even when cleanup itself might fail (e.g., directory partially written, file handle still open).

**How to avoid:**
- Wrap the full scan lifecycle in `try { ... } finally { await cleanup(); }`, ensuring cleanup runs on success, on caught errors, and is also invoked from top-level `process.on('unhandledRejection')`/`uncaughtException` handlers for defense-in-depth (with logging, not silent swallowing).
- Make cleanup idempotent and tolerant of partial state (directory doesn't exist, file already deleted) — don't let a `cleanup()` throw mask the original error.
- Use unique per-scan temp paths (scanId-based) so a failed cleanup doesn't collide with the next scan, and consider a periodic sweep of orphaned temp dirs older than N minutes as a safety net.

**Warning signs:**
- Disk usage climbs monotonically across repeated failed-scan test runs.
- No `finally` block (or equivalent) wrapping clone → scan → parse → cleanup.

**Phase to address:**
Worker/cleanup implementation phase — write a test that intentionally fails a scan (bad URL, kill Trivy) and asserts the temp directory/file are gone afterward.

---

### Pitfall 9: BullMQ job data used as a dumping ground for scan results

**What goes wrong:**
Passing the full parsed result set (or worse, the raw report path plus large metadata) as BullMQ job `data`/`returnvalue` seems convenient since BullMQ persists it in Redis automatically, but Redis is single-threaded per node and large payloads block other queue operations while being serialized/written/read, and inflate Redis's own memory usage — which matters doubly here since Redis is a sibling container potentially sharing constrained host memory. Even "only CRITICAL vulns" can be large if a report has many.

**Why it happens:**
BullMQ makes it trivially easy to `return` any JS value from a processor and have it appear as `job.returnvalue`, so there's no natural friction pushing toward "store a reference, not the data."

**How to avoid:**
- Keep job data/return values small: store the scanId, status, and CRITICAL vuln list only if it's reliably small (which the CRITICAL-only filter should make true), or store a reference (file path/id) if it could still be large, and have `GET /api/scan/:scanId` load the small result from wherever it's actually persisted (Redis key with a size-appropriate value, or a small results file) rather than pushing it back through job data on every read.
- Avoid storing the raw repo/JSON file paths in Redis long-term — those get cleaned up (Pitfall 8) and shouldn't be treated as durable references.

**Warning signs:**
- `job.returnvalue` or job `data` payloads measured in the hundreds of KB to MB in testing.
- Redis memory usage growing unexpectedly relative to number of completed jobs.

**Phase to address:**
BullMQ integration phase — decide the job-data contract (what's small enough to live in Redis) before wiring up the API's polling endpoint.

---

### Pitfall 10: Worker and API server sharing one process/heap under the 150MB constraint

**What goes wrong:**
Running the BullMQ worker in the same Node process as the Express/GraphQL API server means the heap budget (`--max-old-space-size=150`) is shared between HTTP request handling and the memory-intensive scan/stream-parse work. A concurrent API request during a large scan competes for the same old-space heap, and if BullMQ concurrency is misconfigured (e.g., `concurrency > 1`) or a job overlaps with the self-test's exact scenario, two scans running "in parallel" in-process can each assume they have the full 150MB, together exceeding it.

**Why it happens:**
Running everything in one process is simpler to build and to reason about for a 2-3 day take-home, and the assignment's `dist/index.js` self-test phrasing doesn't obviously demand process separation.

**How to avoid:**
- Set BullMQ worker `concurrency: 1` explicitly (document why) so only one scan's streaming pipeline is active at a time, and treat this as a real architectural decision, not a default.
- If keeping worker + API in one process (reasonable for this scope), ensure the API routes never buffer scan results themselves (Pitfall 9) and don't do any heavy work synchronously that could stack on top of an in-flight scan's memory footprint.
- Document the single-process, concurrency-1 tradeoff explicitly in ONBOARDING.md — this is exactly the kind of "why" a reviewer will probe on.

**Warning signs:**
- BullMQ `concurrency` option left at a default >1 or unset without consideration.
- Self-test only ever exercises one scan in isolation, never a scan running concurrently with an API request/second scan attempt.

**Phase to address:**
Architecture/setup phase (decide process topology and concurrency explicitly) and BullMQ integration phase (enforce via config).

---

### Pitfall 11: Docker `mem_limit: 200m` without matching Node/V8 tuning inside the container

**What goes wrong:**
Setting `mem_limit: 200m` in `docker-compose.yml` without also setting `--max-old-space-size` (or `NODE_OPTIONS`) inside that same container leaves V8's default heap sizing based on host memory (or, on Node 20+, container-aware cgroup detection that may still leave insufficient headroom), so the container can be OOM-killed well before V8 would have self-reported a heap error — the failure mode looks like a silent crash/restart loop rather than a diagnosable Node error.

**Why it happens:**
The assignment's explicit self-test command (`node --max-old-space-size=150 dist/index.js`) is easy to treat as "the" memory contract, while the separate Docker `mem_limit: 200m` (Bonus C) requires its own, slightly different tuning — the two numbers (150 heap vs 200 container) are intentionally not identical and need to both be respected simultaneously inside the container.

**How to avoid:**
- Bake `NODE_OPTIONS=--max-old-space-size=150` (or similar, tuned below 200m with margin for Redis client buffers, HTTP server overhead, and Trivy's own child-process memory if Trivy runs inside the same container) into the Dockerfile/compose environment, don't rely on defaults.
- Remember Trivy itself (if invoked as a local binary rather than via a separate Trivy Docker image) also consumes memory inside that same `mem_limit: 200m` budget — its own RSS counts against the same cgroup limit as Node's.
- Test the actual `docker-compose up` path, not just the bare `node --max-old-space-size=150 dist/index.js` self-test, against the largest fixture before considering the memory work done.

**Warning signs:**
- Container restarts/exits during a large scan when run via `docker-compose` even though the standalone self-test passes.
- `docker stats` or `docker inspect <container> --format='{{.State.OOMKilled}}'` shows `true`.

**Phase to address:**
Docker/Bonus-C packaging phase, but the memory-tuning decision (what heap size relative to what container limit) should be made and documented once during the architecture/setup phase so it's consistent everywhere.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|-----------------|------------------|
| Using a real (small) NodeGoat scan output instead of a synthetic 500MB fixture for the memory self-test | Faster to wire up, no fixture generator needed | Doesn't actually prove the memory claim the assignment grades on — reviewer will notice a small-file "proof" doesn't demonstrate streaming under load | Never for the final submission; fine as an early smoke test only |
| `exec()` for quick Trivy invocation during early prototyping | Simpler code, promise-based | Silent maxBuffer ceiling, must be ripped out before any real-size test | Only in a throwaway spike, never committed |
| Skipping `try/finally` cleanup "for now" | Faster to get happy-path working | Disk fills up during iterative testing (you'll hit this yourself within an afternoon of repeated test runs) | Never — cheap to do correctly from the start |
| Storing all severities and filtering client-side | Simpler backend logic, more "flexible" data | Violates the explicit CRITICAL-only requirement; wastes memory exactly where it's most scrutinized | Never |
| Running worker + API in one process without setting `concurrency: 1` explicitly | Less config to think about | Unbounded/undocumented behavior under concurrent load, exactly what a memory-focused reviewer will stress-test | Acceptable only if explicitly documented and concurrency is still capped |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|-----------------|-------------------|
| Trivy CLI | Assuming Trivy binary exists on `PATH` in every environment (reviewer's machine) without a fallback | Auto-detect local binary, fall back to invoking the official Trivy Docker image (per project's own Key Decision), and fail with a clear, actionable error message if neither is available |
| Trivy vulnerability DB | Downloading the DB fresh on every scan/container start, hitting GitHub/OCI rate limits and adding minutes of latency to every self-test run | Mount a persistent volume at Trivy's cache dir (`~/.cache/trivy` inside the container) in `docker-compose.yml`, or pre-populate the DB during image build with `--download-db-only` |
| Redis (via BullMQ) | Treating Redis as infinitely elastic and dumping large job payloads into it | Keep job data small (status + CRITICAL-only results); large artifacts stay on the filesystem, cleaned up after processing |
| GitHub repo cloning | Using `git clone` without depth/size limits, or not handling private/invalid/huge repos gracefully | Use `git clone --depth 1` (shallow clone; Trivy fs-scanning doesn't need history), validate the URL format up front, and treat clone failures (auth, 404, network) as a distinct, reported error state rather than a generic "Failed" |
| Docker Compose memory limits | Setting `mem_limit` on the app service but forgetting Redis also needs a bounded footprint, or forgetting Trivy's own process memory shares the same container budget as Node | Size `mem_limit` with all co-located processes (Node + Trivy binary if not containerized separately) in mind, and consider a separate `mem_limit` for the Redis service |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|-----------------|
| Testing memory only against small/real repos (NodeGoat) | Self-test "works" but doesn't validate the actual claim | Build and use the synthetic 500MB+ fixture generator explicitly, at multiple sizes (e.g., 50MB/200MB/500MB/1GB) to show a flat, bounded memory curve | Reviewer runs their own larger fixture or increases severity/count in the report — a linear-memory implementation fails immediately |
| `pick`/`streamArray` chain re-parses or re-buffers per Result unnecessarily (e.g., re-serializing a Result back to a string just to pass it to another parser) | CPU and memory both scale worse than input size, scan takes much longer than Trivy's own runtime | Use `stream-json`'s token-based chain APIs (`Disassembler`/`Assembler`/`StreamArray`) without round-tripping through strings | Becomes visible once fixture sizes exceed a few hundred MB; may still "pass" a small self-test |
| Unbounded BullMQ retry/backoff on a scan that deterministically fails (e.g., bad repo URL) | Wasted Trivy DB checks, repeated clone attempts, queue backlog | Distinguish retryable failures (transient network) from permanent ones (invalid URL, repo not found) and set `attempts`/`backoff` accordingly, or don't retry permanent failures at all | Shows up under any bulk/automated testing of the `/api/scan` endpoint with bad input |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Accepting arbitrary repo URLs without validation and passing them straight into `git clone`/shell invocation | Command injection or SSRF-style abuse (cloning internal/arbitrary URLs, argument injection via crafted URL strings) | Validate the URL is a well-formed `https://github.com/...` URL before use; always invoke `git`/Trivy via `spawn()` with an argument array (never string-interpolated shell commands) so shell metacharacters in a malicious "URL" can't be interpreted |
| No limit on clone size/scan duration | A malicious or accidentally huge repo (or a repo with deep history) could exhaust disk or run indefinitely, indirectly causing the same OOM/disk-full failure modes as a legitimate huge report | Use `git clone --depth 1`, set a scan timeout that kills the Trivy child process and cleans up on timeout, and consider a maximum repo size check before/while cloning |
| Logging full Trivy JSON or full repo contents on error for "debuggability" | Could leak sensitive scan data or repo contents into logs that outlive the temp files you're carefully cleaning up elsewhere | Log structured, bounded error metadata (scanId, error type, exit code) — not raw report bytes or repo contents |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-------------------|
| `GET /api/scan/:scanId` blocks or is slow because it reconstructs/re-reads a large result set on every poll | 2s polling (per Bonus A) feels sluggish or times out under load | Ensure the persisted result (Redis key/small results file) is already small and directly readable — no re-parsing per poll |
| No intermediate status between `Queued` and `Finished`/`Failed` during a long scan | Frontend polling shows no progress for potentially minutes (clone + Trivy DB download + scan can be slow) | Use the `Scanning` status transition promptly (on job pickup, before Trivy even starts) so the UI can differentiate "still in queue" from "actively working" |
| Failure messages collapsed to a generic "Failed" | Reviewer/tester can't tell if it was a bad URL, disk full, Trivy crash, or clone failure — undermines the "robust error handling" grading criterion | Store a specific failure reason/category on the scan record (invalid URL, clone failed, Trivy error, disk full) and surface it in the `GET` response |

## "Looks Done But Isn't" Checklist

- [ ] **Streaming pipeline:** Often "streams" the outer array but buffers inner arrays or the final filtered list without bound — verify peak RSS is flat across 50MB/500MB/1GB fixtures, not just that it "doesn't crash" on one size.
- [ ] **Memory self-test:** Often tested only against the small real NodeGoat output — verify it's run against the synthetic 500MB+ fixture and both `heapUsed` and `rss` are logged and asserted.
- [ ] **Cleanup:** Often only wired for the success path — verify by forcing a failure (kill Trivy mid-scan, feed a bad URL, fill disk artificially) and confirming temp repo + JSON file are gone afterward.
- [ ] **CRITICAL-only filtering:** Often filters correctly in the happy path but leaks non-CRITICAL data through error paths, logs, or a "raw" debug endpoint — verify no code path stores/returns non-CRITICAL vulns anywhere, including logs.
- [ ] **Docker Bonus C:** Often demoed only via `node --max-old-space-size=150 dist/index.js` — verify the actual `docker-compose up` path with `mem_limit: 200m` also survives the largest fixture, since heap-limit and container-limit are different constraints.
- [ ] **Trivy invocation robustness:** Often only tested with Trivy present and working — verify behavior when the local binary is missing (falls back to Docker image) and when Trivy itself errors (clear `Failed` status, not a hang or silent success).
- [ ] **BullMQ restart survival:** Often assumed to work because BullMQ "handles" persistence — verify by killing the worker process mid-scan and confirming the job is retried or marked failed cleanly on restart, not left stuck `Scanning` forever (stalled job).

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|----------------|------------------|
| Discovered full-buffering only after building the whole pipeline | MEDIUM | Isolate the buffering point via the memory-scaling test (Pitfall 1's warning sign), replace only that stage with a proper `pick`/`streamArray`/`pipeline()` stage; the surrounding Controller/Service/Worker structure shouldn't need to change |
| RSS exceeds container limit despite heap self-test passing | LOW | Re-tune `--max-old-space-size` down relative to `mem_limit`, audit for Buffer/stream retention (Pitfall 3/4), re-run the Docker-based test, not just the bare-node self-test |
| Orphaned temp files/dirs discovered late (disk filling during testing) | LOW | Add `try/finally` cleanup, then manually sweep and delete any pre-existing orphaned temp paths from earlier failed runs before re-testing |
| BullMQ job data found to be storing large payloads late in development | MEDIUM | Migrate to storing only status + CRITICAL-list (small) in job data/Redis key; move any large artifact reference to disk path (already cleaned up) instead of Redis; update `GET /api/scan/:scanId` accordingly |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|-------------------|----------------|
| Full-buffering of the stream pipeline | Core streaming pipeline implementation | Memory self-test across multiple fixture sizes (50MB/200MB/500MB/1GB) shows flat/bounded RSS and heap growth |
| Heap limit vs RSS confusion | Memory self-test / verification phase + Docker packaging phase | Two explicit gates: bare `node --max-old-space-size=150` run AND full `docker-compose` run with `mem_limit: 200m`, both logging RSS |
| `child_process` maxBuffer / exec buffering | Scan/worker implementation (Trivy invocation) | Code review confirms `spawn()` + `--output` or piped `createWriteStream`, no `exec`/`execFile`, no large `maxBuffer` |
| String/Buffer concatenation | Core streaming pipeline implementation | Code review checklist item; memory-scaling test also catches this indirectly |
| Storing non-CRITICAL vulns | Core streaming pipeline implementation | Fixture with known CRITICAL/non-CRITICAL counts; assert only CRITICAL survive end-to-end |
| `stream-json` pick path mismatch for nested shape | Core streaming pipeline implementation | Small hand-crafted fixture unit test with known nested Results/Vulnerabilities counts before scaling to 500MB |
| `--exit-code` misinterpreted as failure | Trivy invocation / worker implementation | Test a scan against a repo/fixture with known CRITICAL findings and assert it completes as `Finished`, not `Failed` |
| Cleanup skipped on throw paths | Worker/cleanup implementation | Forced-failure test (bad URL, killed Trivy, simulated ENOSPC) asserts temp artifacts are removed |
| BullMQ job data as dumping ground | BullMQ integration phase | Inspect actual Redis payload size for a completed job; assert it stays small regardless of report size |
| Worker+API sharing heap / concurrency | Architecture/setup phase + BullMQ integration | Concurrency explicitly set and documented; test with an API request firing during an active large scan |
| Docker `mem_limit` without matching Node tuning | Docker/Bonus-C packaging phase | `docker-compose up` run against largest fixture; confirm no OOM-kill via `docker inspect --format='{{.State.OOMKilled}}'` |

## Sources

- [Node.js child_process documentation](https://nodejs.org/api/child_process.html) — HIGH-equivalent (official docs), confidence for this session classified LOW because access here was via web search summary rather than the curated docs provider; verify against installed Node version
- [nodejs/node maxBuffer default issue #9829](https://github.com/nodejs/node/issues/9829) — community discussion of maxBuffer defaults and history
- [lerna/lerna maxBuffer exceeded issue #213](https://github.com/lerna/lerna/issues/213) — real-world example of the exec() maxBuffer failure mode
- [Node.js Learn — Understanding and Tuning Memory](https://nodejs.org/learn/diagnostics/memory/understanding-and-tuning-memory) — heap vs RSS vs external memory distinction
- [Red Hat Developer — Node.js 20+ memory management in containers](https://developers.redhat.com/articles/2025/10/10/nodejs-20-memory-management-containers) — container-aware heap sizing behavior and caveats
- [nodebestpractices — Docker memory-limit guidance](https://github.com/goldbergyoni/nodebestpractices/blob/master/sections/docker/memory-limit.md) — practical ratio guidance for `--max-old-space-size` vs container limit
- [stream-json GitHub repository](https://github.com/uhop/stream-json) — pick/streamArray API and nested-document streaming patterns
- [Trivy documentation — Others/configuration (exit codes)](https://trivy.dev/docs/latest/configuration/others/) and related GitHub issues (#2378, #3478, #869, #1659) — `--exit-code` default-zero behavior and known inconsistencies
- [Trivy DB caching discussions #7587, #7699](https://github.com/aquasecurity/trivy/discussions/7587) — DB download/caching/rate-limit behavior
- [BullMQ — Going to production guide](https://docs.bullmq.io/guide/going-to-production) and community write-ups on job payload sizing — large-payload guidance for Redis-backed queues
- [Node.js Learn — Backpressuring in Streams](https://nodejs.org/learn/modules/backpressuring-in-streams) — `pipe()` vs `pipeline()` error handling and backpressure semantics
- [OneUptime — Alpine vs Debian-slim base image tradeoffs](https://oneuptime.com/blog/post/2026-02-08-how-to-choose-between-alpine-and-debian-slim-base-images/view) — image size vs native-dependency friction tradeoff relevant to Docker packaging with Trivy+git installed

---
*Pitfalls research for: memory-constrained async CLI-wrapper service (Trivy scanner, Node.js/TypeScript)*
*Researched: 2026-07-09*
