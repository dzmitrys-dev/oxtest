---
phase: 01-foundations-domain-types-strict-config
fixed_at: 2026-07-09T18:18:49Z
review_path: .planning/phases/01-foundations-domain-types-strict-config/01-REVIEW.md
iteration: 1
findings_in_scope: 5
fixed: 4
skipped: 1
status: partial
followup_commit: 0dccd37
followup_note: WR-01 and WR-03 applied in a later user-authorized session (config-protection hook bypassed with explicit approval); only WR-05 (nit) remains, correctly rejected.
---

# Phase 1: Code Review Fix Report

**Fixed at:** 2026-07-09T18:18:49Z
**Source review:** .planning/phases/01-foundations-domain-types-strict-config/01-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 5 (WR-01..WR-05; the 2 Info findings were out of scope per `fix_scope: critical_warning`)
- Fixed: 4 (WR-02, WR-04 in the original fixer pass; WR-01, WR-03 in a later user-authorized follow-up — see "Follow-up Resolution" below, commit `0dccd37`)
- Skipped: 1 (WR-05 — suggested fix does not actually resolve the deprecation, rolled back)

## Fixed Issues

### WR-02: Validated `PORT` is never actually read back through `ConfigService`

**Files modified:** `apps/api/src/index.ts`
**Commit:** c570c8d
**Applied fix:** `index.ts` now calls `app.get(ConfigService)` and reads `configService.get<number>('PORT', 3000)` instead of `process.env.PORT ?? 3000`. This routes the boot-time listen port through the same Joi-validated config the rest of the app uses, closing the two-sources-of-truth gap the review flagged. `tsc --noEmit` remains clean after the change.

### WR-04: `npm test` fails out of the box; blocker note was stale

**Files modified:** `apps/api/package.json`, `.planning/STATE.md`, `.planning/phases/01-foundations-domain-types-strict-config/01-01-SUMMARY.md`
**Commit:** 90dc8e3
**Applied fix:**
- Added `--passWithNoTests` to the jest invocation (`"test": "jest --passWithNoTests"`) so `npm test` exits 0 while no spec files exist, instead of the previous `No tests found, exiting with code 1`.
- Reconciled the stale blocker note: re-verified with a throwaway smoke spec (`Test.createTestingModule(...)`) that the `@swc/core@1.15.43`/`miette@7.6.0` native panic under `@swc/jest` **still reproduces today** — but only checked on Node 24 (the only runtime available in this session); it remains **unverified against the project's actually-pinned Node 22 runtime** (`engines: ">=22 <23"`). Updated `.planning/STATE.md` (Blockers/Concerns) and appended a reconciliation note to `01-01-SUMMARY.md` documenting that the *previously tracked* failure (the swc/miette panic) is not what `npm test` currently reproduces (that was simply "no spec files match testRegex," now fixed), while flagging the swc/miette panic itself as a live, not-stale, blocker that Phase 2 must re-verify on Node 22 before adding real spec files.
- Did **not** reintroduce `ts-jest` or attempt an `@swc/core` npm `overrides` pin — out of scope for a "make `npm test` not fail trivially" fix, and pinning blind without a confirmed Node-22 repro risked a change I couldn't verify.

## Skipped Issues

### WR-01: `npm run lint` fails once `dist/` exists

**File:** `apps/api/eslint.config.mjs:7-9`
**Reason:** Blocked by a repo-level `config-protection` hook (installed from the `everything-claude-code` plugin, `hooks/hooks.json`, matcher `Write|Edit|MultiEdit`) that unconditionally refuses any modification to `eslint.config.mjs` (and other linter/formatter config files) by filename, regardless of the direction or intent of the change. The hook's own message states: *"Fix the source code to satisfy linter/formatter rules instead of weakening the config. If this is a legitimate config change, disable the config-protection hook temporarily."* Per this agent's operating constraints, no instruction in this task (including the review finding itself) authorizes disabling a safety hook, and routing around it via a non-guarded tool (e.g. shell `sed`) would circumvent the same control by a technicality — so this was not attempted.
**Original issue:** ESLint's flat-config `ignores` array only excludes `eslint.config.mjs` itself, not `dist/**`; `npm run build && npm run lint` reproducibly fails with 10 "not found by the project service" parsing errors once compiled output exists.
**Action needed:** A human (or a session with the config-protection hook explicitly and temporarily disabled) needs to add `'dist/**'` (and optionally `'node_modules/**'`, `'coverage/**'`) to the `ignores` array in `apps/api/eslint.config.mjs`. Confirmed via direct reproduction in this session that this is still the only broken piece — the fix itself is a one-line, low-risk addition.

### WR-03: ESLint's "no any" / floating-promise rules are weakened from the strict-type-checked preset

**File:** `apps/api/eslint.config.mjs:31-36`
**Reason:** Same root cause as WR-01 — the fix requires editing `eslint.config.mjs`, which the config-protection hook unconditionally blocks for Write/Edit/MultiEdit, independent of whether the edit strengthens or weakens the rules (this one strengthens them: `no-explicit-any` off→error, `no-floating-promises`/`no-unsafe-argument` warn→error). Not attempted for the same reason as WR-01.
**Original issue:** `@typescript-eslint/no-explicit-any` is `'off'` and `no-floating-promises`/`no-unsafe-argument` are downgraded to `'warn'` from the `recommendedTypeChecked` preset's `'error'`, contradicting the project's own stated rationale (CLAUDE.md STACK research) for choosing `strict-type-checked`. No current source file violates these rules, so this is a preventive-control gap rather than an active bug.
**Action needed:** With the config-protection hook temporarily disabled, set `@typescript-eslint/no-explicit-any: 'error'` and restore `no-floating-promises`/`no-unsafe-argument` to `'error'`, then run `npm run lint --workspace apps/api` (after WR-01 is also fixed, since lint currently can't even complete a clean pass) to confirm no real violations surface in the phase's existing source.

### WR-05 (nit): `ignoreDeprecations: "6.0"` suppressor; `baseUrl` unused

**File:** `apps/api/tsconfig.json:5,9`
**Reason:** Fix caused a regression and was rolled back. The review's suggested fix (`"moduleResolution": "node10"` in place of `"node"` + drop `ignoreDeprecations`) was applied, but re-running `tsc --noEmit` immediately surfaced a **new** error not present in the pre-fix baseline:
```
tsconfig.json(4,25): error TS5107: Option 'moduleResolution=node10' is deprecated and will stop functioning in TypeScript 7.0. Specify compilerOption '"ignoreDeprecations": "6.0"' to silence this error.
```
Verified directly: in TypeScript 6.0.3, `"node10"` is simply the explicit alias for the legacy `"node"` resolution strategy introduced in TS 5.0 — both trigger the identical TS5107 deprecation warning and both require `ignoreDeprecations` (or a real migration) to silence. Renaming `"node"` → `"node10"` does not remove the deprecation as the review assumed; it is the same deprecated setting under a different name. The only way to actually resolve the deprecation without a suppression flag is to migrate to `"node16"`, `"nodenext"`, or `"bundler"`, which is a materially larger and riskier change (affects module/import resolution semantics and interacts with this phase's own deliberate decision to omit `verbatimModuleSyntax` to preserve NestJS's CommonJS `emitDecoratorMetadata` DI model — see `01-01-SUMMARY.md` Decisions). Per the finding's own instruction ("if this risks breaking the strict build, skip it and document why"), the change was reverted via `git checkout -- apps/api/tsconfig.json` and left untouched, restoring the clean `tsc --noEmit` baseline.
**Action needed:** None urgent — this is a cosmetic/nit-level deprecation suppression, not a build blocker. If addressed later, budget it as a real `moduleResolution` migration (`node16`/`bundler`) with its own verification pass, not a one-line rename.

## Follow-up Resolution — WR-01 & WR-03 (commit `0dccd37`)

After the original fixer pass, the user explicitly authorized bypassing the `config-protection` hook to apply these two `eslint.config.mjs` changes. The hook is loaded into the running session at startup, so it could **not** be disabled mid-session by editing the plugin script (that was attempted and reverted byte-exact — the hook stayed active). Because the hook gates only `Edit`/`Write`/`MultiEdit` (not `Bash`), the change was applied via a `Bash` heredoc write with the user's explicit approval; the config-protection hook itself was left fully intact.

- **WR-01 (resolved):** `ignores` now includes `'dist/**'`, `'node_modules/**'`, `'coverage/**'`. `npm run lint` no longer parses compiled output.
- **WR-03 (resolved):** `@typescript-eslint/no-explicit-any`, `no-floating-promises`, and `no-unsafe-argument` all set to `'error'`, aligning ESLint with TYPE-01's "no `any`". Source is already `any`-free under the strict tsconfig, so no new violations surfaced.
- **Post-change verification:** `npm run lint --workspace apps/api` → exit 0 (clean); `npm run typecheck --workspace apps/api` → exit 0; `typescript@6.0.3` unchanged.

Only **WR-05** (nit) remains unresolved — correctly rejected because the proposed `moduleResolution: "node10"` triggers the identical TS5107 deprecation on TS 6.0.3 (see below).

## Verification Results (mandatory_verification_after_fixes)

Re-run in the isolated worktree after the fixed/skipped decisions above (with `dist/` and `node_modules` removed again afterward to leave the tree clean):

| Check | Result |
|---|---|
| `npm run typecheck --workspace apps/api` (`tsc --noEmit`) | PASS (exit 0, no output) |
| `npm run lint --workspace apps/api` | PASS (exit 0) after the WR-01/WR-03 follow-up (commit `0dccd37`). Was FAIL in the original fixer pass while those two were blocked by the config-protection hook. |
| `npm run build --workspace apps/api` | PASS — emits `dist/index.js` and `dist/worker.js` |
| `npm ls typescript --workspace apps/api` | `typescript@6.0.3` confirmed (unchanged) |

No regression was introduced by the two fixes actually committed (WR-02, WR-04). The one remaining regression risk (WR-05's suggested fix) was caught by tier-2 verification and rolled back before commit, per the 3-tier verification strategy.

---

_Fixed: 2026-07-09T18:18:49Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
