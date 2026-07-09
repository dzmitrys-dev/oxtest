---
phase: 01-foundations-domain-types-strict-config
reviewed: 2026-07-09T21:30:00Z
depth: standard
files_reviewed: 15
files_reviewed_list:
  - apps/api/src/index.ts
  - apps/api/src/worker.ts
  - apps/api/src/app.module.ts
  - apps/api/src/worker.module.ts
  - apps/api/src/scan/scan.module.ts
  - apps/api/src/scan/scan.store.ts
  - apps/api/src/config/env.validation.ts
  - apps/api/src/domain/scan.types.ts
  - apps/api/src/domain/vulnerability.types.ts
  - apps/api/src/domain/trivy-report.types.ts
  - apps/api/tsconfig.json
  - apps/api/tsconfig.build.json
  - apps/api/nest-cli.json
  - apps/api/eslint.config.mjs
  - apps/api/package.json
  - package.json
  - apps/api/.env.example
findings:
  critical: 0
  warning: 5
  info: 2
  total: 7
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-07-09T21:30:00Z
**Depth:** standard
**Files Reviewed:** 15 source/config files
**Status:** issues_found (advisory, non-blocking)

## Summary

This is a greenfield scaffold phase (no business logic expected — correctly not flagged). Layering is clean: `domain/*.types.ts` has zero `@nestjs` imports, `WorkerModule` imports nothing HTTP/GraphQL-related, and `ScanModule` is the shared DI seam both root modules import identically. Domain types are minimal and match the Trivy CRITICAL-only extraction path per D-04. `tsconfig.json` is genuinely `strict: true` + `noUncheckedIndexedAccess`, not just patched on top of a loose default, and `tsc --noEmit` reproduces clean.

The issues found are all in the toolchain/config layer this phase specifically set out to harden, not in the (intentionally stub) business logic: two of the phase's own delivered lifecycle scripts (`npm run lint`, `npm test`) fail out of the box when reproduced directly, the strict-typing ESLint preset has its two most relevant "no any" / floating-promise rules weakened from the Nest CLI default rather than tightened to match the project's own stated rationale for choosing `strict-type-checked`, the boot-time Joi-validated `PORT` is never actually read back through `ConfigService` (defeating part of the point of validating it), and the carried-forward `@swc/core`/miette test-runner blocker documented in both plan summaries no longer matches the failure this reviewer could reproduce.

None of these rise to Critical/blocker — nothing here causes data loss, a security bypass, or incorrect production behavior at this stub-only stage — but several should be fixed before Phase 2 builds real tests and CI gating on top of this foundation.

## Warnings

### WR-01: `npm run lint` fails out of the box once `dist/` exists

**File:** `apps/api/eslint.config.mjs:7-9`
**Issue:** The flat-config `ignores` array only excludes `eslint.config.mjs` itself:
```js
{
  ignores: ['eslint.config.mjs'],
},
```
It does not exclude `dist/`. `apps/api/tsconfig.json`'s `include` is `src/**/*.ts` only, so ESLint's typed-linting `projectService` can't resolve any `.js` file under `dist/` against a TS project. Reproduced directly in this review after `npm run build`:
```
$ npm run lint --workspace apps/api
.../dist/app.module.js
  0:0  error  Parsing error: ... was not found by the project service ...
[... 10 files, 10 errors ...]
✖ 10 problems (10 errors, 0 warnings)
```
Any reviewer/CI sequence of `build` → `lint` (a very common pipeline order, and one Phase 5's CI hardening will almost certainly use) hits this immediately, even though the source itself lints clean.
**Fix:**
```js
{
  ignores: ['eslint.config.mjs', 'dist/**'],
},
```

### WR-02: Validated `PORT` is never actually read back through `ConfigService`; the 3000 default is duplicated

**File:** `apps/api/src/index.ts:14`
**Issue:**
```ts
await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
```
`env.validation.ts` defines `PORT: Joi.number().port().default(3000)` specifically so a single validated/coerced value is available app-wide via `ConfigService`. `index.ts` bypasses that entirely and re-reads the raw, uncoerced `process.env.PORT` string, re-deriving its own `?? 3000` fallback. Functionally this happens to match today because both defaults are `3000`, but the two defaults are now two sources of truth that can silently drift (e.g., someone changes the Joi default without noticing `index.ts` has its own copy), and the whole point of running config through Joi — a single validated, typed value — is defeated at the one call site that uses it.
**Fix:**
```ts
const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
const configService = app.get(ConfigService);
await app.listen(configService.get<number>('PORT', 3000), '0.0.0.0');
```

### WR-03: ESLint's own "no any" / floating-promise guarantees are weakened, contradicting the project's stated rationale for choosing `strict-type-checked`

**File:** `apps/api/eslint.config.mjs:31-36`
**Issue:**
```js
{
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-floating-promises': 'warn',
    '@typescript-eslint/no-unsafe-argument': 'warn',
    "prettier/prettier": ["error", { endOfLine: "auto" }],
  },
},
```
These are the unmodified `nest new` CLI defaults, left in place. But the project's own CLAUDE.md STACK research explicitly calls out `@typescript-eslint` strict-type-checked as chosen specifically "to enforce 'no `any`' mechanically, not just by promise" — and TYPE-01 (this phase's own requirement) is "no `any` on scan-result handling paths." As shipped, nothing mechanically stops a future explicit `any` from landing (rule is `off`, not `warn`/`error`), and `no-floating-promises`/`no-unsafe-argument` are downgraded from the preset's `error` to `warn`, so a future missing `.catch()`/`await` would only warn, not fail lint. No current source file violates these (verified), so this is a preventive-control gap, not an active bug.
**Fix:** Re-enable at minimum `@typescript-eslint/no-explicit-any: 'error'`; restore `no-floating-promises`/`no-unsafe-argument` to `error` (or explicitly document in ONBOARDING.md why they're intentionally relaxed, if that's the real intent).

### WR-04: `npm test` fails out of the box, and the reason no longer matches the documented carried-forward blocker

**File:** `apps/api/package.json:18` (jest config), `.planning/phases/.../01-01-SUMMARY.md:173-176`, `.planning/STATE.md:85`
**Issue:** Reproduced directly in this review:
```
$ npm test --workspace apps/api
No tests found, exiting with code 1
testRegex: .*\.spec\.ts$ - 0 matches
```
01-01-SUMMARY.md and STATE.md both document the carried-forward blocker as "`@swc/core@1.15.43` + `miette@7.6.0` native panic under jest on Node 24," to be fixed via an `npm overrides` pin before real tests land. That specific failure can no longer be reproduced because Plan 02's Task 3 deleted the only spec file (`app.controller.spec.ts`) that exercised the swc/jest transform, and no replacement spec exists anywhere in `apps/api/src`. The actual, current, reproducible failure is simply "no spec files match `testRegex`," a different root cause than what's tracked. Additionally, the original repro was performed on Node 24 while the project's own `.nvmrc`/`engines` field pins Node 22 (`>=22 <23`) — so whether the miette panic still applies on the actually-pinned runtime is unverified. Neither the stale symptom nor the current one is reflected in ROADMAP.md's Phase 2 entry (which does add real tests and CI gating), so there's a real risk this surfaces as a fresh, confusing CI failure in Phase 2 with no breadcrumb pointing back to this analysis.
**Fix:** Before Phase 2 adds real spec files: (a) re-verify the swc/miette panic under the pinned Node 22 with a trivial spec file, since the prior repro environment didn't match `engines`; (b) if it still reproduces, apply the documented `npm overrides` pin; (c) either way, add `--passWithNoTests` or a minimal smoke spec now so `npm test` doesn't fail trivially in the interim; (d) reference this blocker explicitly from Phase 2's plan/success-criteria, not just STATE.md, so it isn't lost.

### WR-05 (nit): `ignoreDeprecations: "6.0"` is a blanket suppressor where a targeted rename would do; `baseUrl` is otherwise unused

**File:** `apps/api/tsconfig.json:5,9`
**Issue:** TS 6.0.3 promotes bare `moduleResolution: "node"` (paired with `baseUrl`) to a hard error; the fix applied was a blanket `"ignoreDeprecations": "6.0"`. The documented, non-suppressing fix for this specific deprecation is renaming the value to its explicit equivalent, `"moduleResolution": "node10"` — no suppression flag needed, and it won't need re-bumping at the next TS major or risk silently swallowing an unrelated future deprecation warning. Separately, `baseUrl: "./"` has no accompanying `paths` mapping anywhere in the config, so it's dead configuration once `moduleResolution` is fixed directly.
**Fix:**
```json
"moduleResolution": "node10"
```
and drop `ignoreDeprecations` + `baseUrl` (unless `paths` aliases are planned).

## Info

### IN-01: Bootstrap uses `console.log`/`console.error` instead of Nest's `Logger`

**File:** `apps/api/src/index.ts:15`, `apps/api/src/worker.ts:10,14`
**Issue:** Matches the exact pattern in RESEARCH.md's verified code examples (bootstrap runs before DI is available, so this is the idiomatic Nest pattern, not a bug) — flagged only as a forward-looking note since later phases will want structured (pino) logging for scan lifecycle events, and it's worth deciding now whether bootstrap-time logs should also go through a shared logger for consistency once one exists.
**Fix:** No action needed this phase; revisit once a shared logger is wired in (Phase 3+).

### IN-02: `Vulnerability`/`TrivyVulnerability` field-name casing mismatch is intentional but undocumented in-file

**File:** `apps/api/src/domain/vulnerability.types.ts`, `apps/api/src/domain/trivy-report.types.ts`
**Issue:** `TrivyVulnerability` uses Trivy's raw PascalCase JSON field names (`VulnerabilityID`, `PkgName`, ...) while `Vulnerability` uses camelCase (`vulnerabilityId`, `pkgName`, ...) — correct design (raw parse shape vs. domain shape), but there's no mapping function yet and no comment noting that Phase 2's parser is responsible for the field-name translation. Worth a one-line comment now so Phase 2 doesn't have to rediscover the intended mapping point.
**Fix:** Optional: add `// mapped from TrivyVulnerability by the Phase 2 parser — field names are intentionally translated PascalCase -> camelCase` to one of the two files.

---

_Reviewed: 2026-07-09T21:30:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
