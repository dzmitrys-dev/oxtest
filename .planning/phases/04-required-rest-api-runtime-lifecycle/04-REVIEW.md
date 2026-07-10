---
phase: 04-required-rest-api-runtime-lifecycle
reviewed: 2026-07-10T00:00:00Z
depth: standard
files_reviewed: 19
files_reviewed_list:
  - apps/api/src/http/validation/github-url.ts
  - apps/api/src/http/validation/github-url.pipe.ts
  - apps/api/src/http/dto/create-scan.dto.ts
  - apps/api/src/http/dto/scan-response.ts
  - apps/api/src/http/scan.controller.ts
  - apps/api/src/http/health.service.ts
  - apps/api/src/http/health.controller.ts
  - apps/api/src/app.module.ts
  - apps/api/src/config/env.validation.ts
  - apps/api/src/lifecycle/drain.ts
  - apps/api/src/lifecycle/worker-shutdown.provider.ts
  - apps/api/src/scan/scan.repository.ts
  - apps/api/src/worker.module.ts
  - apps/api/scripts/api-integration.mjs
  - apps/api/src/http/validation/github-url.spec.ts
  - apps/api/src/http/scan.controller.spec.ts
  - apps/api/src/http/health.service.spec.ts
  - apps/api/src/lifecycle/drain.spec.ts
  - apps/api/package.json
findings:
  critical: 0
  warning: 3
  info: 3
  total: 6
status: issues_found
---

# Phase 4: Code Review Report

**Reviewed:** 2026-07-10
**Depth:** standard
**Files Reviewed:** 19
**Status:** issues_found

## Summary

Reviewed the required REST transport (scan + health controllers, DTOs, URL
validation pipe), the runtime-lifecycle providers (bounded graceful drain,
worker-shutdown, env schema), the Redis repository, and the compiled-process
integration harness for Phase 4.

Overall the security posture is strong and the review-focus invariants mostly
hold: the GitHub-URL allowlist is fail-closed and parse-then-allowlist correct
(protocol/userinfo/port/exact-host/path-shape/char-class all gated in the right
order); the 400-before-enqueue contract is structurally enforced by binding the
pipe on `@Body`; the controller stays thin (import-guarded, only touches
`ScanService`); `git clone` is fed argv-array with `shell: false`; and the
`REDIS_CLIENT` double-quit is guarded on both shutdown hooks. No injection,
authn/authz, or data-loss BLOCKER was found.

Three WARNING-level defects reduce robustness of the security controls and the
shutdown invariant: (1) the pipe forwards the *raw* request string rather than
the parsed/canonical URL, opening a WHATWG-vs-git parser differential; (2) the
`SHUTDOWN_GRACE_MS` schema `max` permits values that exceed Docker's 10s
SIGTERM→SIGKILL window, defeating the "always exit before SIGKILL" guarantee;
and (3) the production `REDIS_CLIENT` has no `error` listener, risking an
unhandled `'error'` event exactly on the Redis-drop path the `/health` 503 test
exercises. Three INFO items round out the review.

## Warnings

### WR-01: URL pipe forwards the raw request string, not the validated/canonical URL (parser differential)

**File:** `apps/api/src/http/validation/github-url.pipe.ts:31` (with `apps/api/src/http/validation/github-url.ts:34-68`)
**Issue:**
`parseGithubUrl` validates the *parsed* components of the URL via `new URL(input)`,
but the pipe returns the **original, unparsed** string:

```ts
if (parseGithubUrl(repoUrl) === null) { throw new BadRequestException(...); }
return { repoUrl: repoUrl as string };   // <-- raw input, not canonical
```

The WHATWG URL parser silently **strips all ASCII tab / LF / CR characters
(U+0009/U+000A/U+000D) and trims leading/trailing C0-control + space** before
parsing. So an input such as `"https://github.com/owner/re\tpo"` or
`"https://gith\nub.com/owner/repo"` parses to a *clean* `github.com/owner/repo`
that passes every gate — yet the raw string that survives into
`CreateScanDto.repoUrl` still contains the control characters. That raw string
is what `ScanService.enqueue(repoUrl)` persists and hands to the worker's
`git clone` (confirmed: `scan.service.ts:42-43` enqueues `repoUrl` verbatim).

The validated form and the used form therefore differ — a classic validator
bypass / parser differential. Actual command-injection and SSRF are still
blocked downstream (execa argv with `shell:false`; git/libcurl reject embedded
control chars), which is why this is a WARNING and not a BLOCKER — but the
stated invariant ("only `https://github.com/{owner}/{repo}` survives ... before
it can reach `git clone`") is not actually upheld for the bytes that get used.

**Fix:** Return a value reconstructed from the validated parse result, never the
raw input. Have `parseGithubUrl` return (or the pipe rebuild) a canonical URL:

```ts
const parsed = parseGithubUrl(repoUrl);
if (parsed === null) {
  throw new BadRequestException('repoUrl must be an https://github.com/{owner}/{repo} URL');
}
return { repoUrl: `https://github.com/${parsed.owner}/${parsed.repo}` };
```

This makes the enqueued/cloned string provably equal to what was validated.

### WR-02: `SHUTDOWN_GRACE_MS` max (60000) exceeds Docker's 10s SIGKILL window, defeating the bounded-drain guarantee

**File:** `apps/api/src/config/env.validation.ts:51`
**Issue:**
`SHUTDOWN_GRACE_MS: Joi.number().integer().min(0).max(60000).default(8000)`.
The design contract (drain.ts:1-9, worker-shutdown.provider.ts:20-26, and the
schema's own comment) is that the grace window must stay **below Docker's
default 10s SIGTERM→SIGKILL window** so the process force-closes and exits
before an external SIGKILL. The default (8000) honors that, but the schema
`max` of 60000 lets an operator set e.g. `SHUTDOWN_GRACE_MS=30000` and still
boot. In that case `raceDrain` waits up to 30s, and the hard-exit backstop
(`worker-shutdown.provider.ts:65-68`) only fires at `graceMs + 500` = 30500ms —
long after Docker has already SIGKILLed the container at ~10s. The
"process always exits before SIGKILL" claim in `drain.ts` silently breaks, and
in-flight scans are hard-killed instead of drained.

**Fix:** Cap the schema at (or below) the SIGKILL window so a misconfiguration
fails closed at boot rather than at shutdown, e.g.:

```ts
// Must stay < Docker's 10s stop grace so the backstop always beats SIGKILL.
SHUTDOWN_GRACE_MS: Joi.number().integer().min(0).max(9000).default(8000),
```

(Choose a max that leaves headroom for `BACKSTOP_MARGIN_MS` under 10000.)

### WR-03: Production `REDIS_CLIENT` has no `'error'` listener — unhandled `'error'` event can crash the process on Redis drop

**File:** `apps/api/src/scan/scan.module.ts:42-47` (consumed by the reviewed `health.service.ts` / `worker-shutdown.provider.ts` / `scan.repository.ts`)
**Issue:**
The `REDIS_CLIENT` `useFactory` creates a bare `new Redis({...})` with no
`.on('error', ...)` handler. ioredis instances are `EventEmitter`s that emit
`'error'` on connection/reconnect failures; an `'error'` event with no listener
throws as an uncaught exception and can crash the process. This is precisely the
scenario the reviewed `/health` 503 flow depends on: the integration harness
kills the disposable Redis (`api-integration.mjs:765`) and then expects the API
to *stay up* and return 503. Tellingly, the harness attaches
`redis.on('error', () => {})` to its **own** test client
(`api-integration.mjs:176-178`) and comments that ioredis "emits reconnect
`'error'` events" — but the application's own client has no equivalent guard.

The `HealthService` PING path itself is safe (the rejection is caught and mapped
to 503), so this is about the *background* reconnect errors on the shared client,
not the request path — hence WARNING rather than BLOCKER, and the exact behavior
is ioredis-version-dependent. It should still be closed.

**Fix:** Attach a logging (non-throwing) error handler in the factory:

```ts
useFactory: (config: ConfigService): Redis => {
  const client = new Redis({ host: config.getOrThrow('REDIS_HOST'), port: config.getOrThrow('REDIS_PORT') });
  const logger = new Logger('RedisClient');
  client.on('error', (err) => logger.warn(`Redis connection error: ${err.message}`));
  return client;
},
```

## Info

### IN-01: Unguarded `JSON.parse` on Redis-stored values in the read path

**File:** `apps/api/src/scan/scan.repository.ts:105-107` and `:230`
**Issue:** `get()` maps `rawList.map((entry) => JSON.parse(entry) as Vulnerability)`
and `deserialize` does `JSON.parse(error)` with no try/catch. A single corrupted
list entry or `error` field turns a `GET /api/scan/:id` into an unhandled 500
instead of degrading gracefully. Data is app-written so risk is low, but a
defensive guard keeps a poisoned record from breaking the read endpoint. (Note:
this is *not* a violation of the forbidden-API constraint — that applies to the
500MB Trivy report, which is streamed; these are small per-item vuln objects.)
**Fix:** Wrap each parse in a try/catch, skipping/nulling malformed entries and
logging once.

### IN-02: Controller HTTP-status test asserts against a private Nest metadata key

**File:** `apps/api/src/http/scan.controller.spec.ts:118-120`
**Issue:** `Reflect.getMetadata('__httpCode__', handler)` couples the test to an
internal `@nestjs/common` metadata key that is not part of the public API and can
change between Nest minors, causing a false failure on upgrade.
**Fix:** Prefer asserting the observed status through the integration harness
(the 202 path is already covered in `api-integration.mjs`) rather than the
private reflect key, or import Nest's exported `HTTP_CODE_METADATA` constant if
available.

### IN-03: `get()` reads hash and list in two non-atomic round-trips

**File:** `apps/api/src/scan/scan.repository.ts:99-108`
**Issue:** `hgetall` and `lrange` are separate calls; a concurrent worker
`appendVulnerability`/`markFinished` between them can yield a hash/list snapshot
that is momentarily inconsistent (e.g. status read before a just-appended vuln).
For a poll-based status API this is benign, but it is a latent consistency seam
worth noting.
**Fix:** If strict consistency is ever required, read both keys inside a single
`MULTI` (or a `WATCH`ed transaction) so the poll sees one coherent snapshot.

---

_Reviewed: 2026-07-10_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
