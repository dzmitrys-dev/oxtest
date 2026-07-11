# Phase 2: Streaming Parse Pipeline & Memory Proof - Pattern Map

**Mapped:** 2026-07-09
**Files analyzed:** 11 planned/modified files (including package lock, ignore rule, and CI workflow)
**Analogs found:** 7 / 11 (4 direct project analogs; 3 configuration analogs; no existing streaming/CI analog)

## Scope and file inventory

The CONTEXT and RESEARCH files identify the following deliverables. Files marked **new** do not currently exist; files marked **modify** already exist.

- **new** `apps/api/src/parser/report-parser.ts` — framework-free `ReportParser` async generator.
- **new** `apps/api/src/parser/report-parser.spec.ts` — Jest correctness test against the committed fixture.
- **new** `apps/api/scripts/gen-fixture.ts` — bounded synthetic Trivy JSON generator.
- **new** `apps/api/scripts/memtest.ts` — peak memory self-test and exit gate.
- **new** `apps/api/scripts/memtest-sweep.ts` — configurable flat-RSS size sweep.
- **new** `apps/api/fixtures/known-severity-mix.json` — small committed mixed-severity fixture.
- **new** `.github/workflows/memory.yml` (or equivalent workflow name) — Node 22 CI memory gate.
- **modify** `apps/api/package.json` — pin stream dependencies and add fixture/memory scripts.
- **modify** `package-lock.json` — lock the dependency additions through the workspace install.
- **modify** `apps/api/eslint.config.mjs` — parser-path forbidden API rules.
- **modify** `.gitignore` — ignore generated 500MB+ fixture artifacts; do not ignore the small fixture.

No new domain model, Nest module wiring, runtime entrypoint, or `tsconfig` change is required. Phase 3 will consume the exported parser through the existing seam.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps/api/src/parser/report-parser.ts` | service/utility (framework-free adapter) | streaming, transform | `apps/api/src/scan/scan.store.ts` + research Pattern 1 | role-match; no streaming analog |
| `apps/api/src/parser/report-parser.spec.ts` | test | file I/O, transform | `apps/api/package.json` Jest config; no existing spec | test-config match |
| `apps/api/scripts/gen-fixture.ts` | utility/dev script | file I/O, batch generation | `apps/api/src/index.ts` bootstrap error boundary | role-partial |
| `apps/api/scripts/memtest.ts` | utility/dev script | streaming consumer, measurement | `apps/api/src/worker.ts` CLI-style `main`/catch | role-partial |
| `apps/api/scripts/memtest-sweep.ts` | utility/dev script | batch/measurement | `memtest.ts` (new sibling) | planned sibling |
| `apps/api/fixtures/known-severity-mix.json` | fixture/test data | file I/O input | `apps/api/src/domain/trivy-report.types.ts` | shape-match |
| `.github/workflows/memory.yml` | config/CI | batch/request-response process gate | none | no analog |
| `apps/api/package.json` | config | batch command orchestration | existing scripts/deps | exact config file |
| `package-lock.json` | config/lockfile | dependency resolution | existing workspace lock | exact config file |
| `apps/api/eslint.config.mjs` | config/static guard | transform/static analysis | existing ESLint config | exact config file |
| `.gitignore` | config | file I/O hygiene | none in examined source | no code analog |

## Pattern Assignments

### `apps/api/src/parser/report-parser.ts` (service/utility, streaming transform)

**Analog:** `apps/api/src/scan/scan.store.ts` (framework-free-ish domain service shape; lines 1, 9-24), plus the authoritative corrected streaming skeleton in `02-RESEARCH.md` lines 281-323. There is no existing repository streaming parser to copy. Keep this file free of Nest imports; `ScanStore` demonstrates the project’s simple named-class/export convention.

**Imports and type contract** (research skeleton lines 286-292; domain analog lines 6-22):

```typescript
import chain from 'stream-chain';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { streamValues } from 'stream-json/streamers/stream-values.js';
import { createReadStream } from 'node:fs';
import type { TrivyVulnerability } from '../domain/trivy-report.types';
import type { Vulnerability } from '../domain/vulnerability.types';
```

Use the existing frozen types exactly: `TrivyVulnerability.Severity` is a literal union (source lines 15-22), and output `Vulnerability.severity` is literally `'CRITICAL'` (source lines 6-13). Do not create a second parser DTO or use `any`; `tsconfig.json` lines 18-22 enforce strict/no-unchecked-indexed-access/no implicit returns.

**Core pipeline and API** (RESEARCH.md lines 294-321):

```typescript
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

Do **not** copy the older `pick('Results') -> streamArray() -> value.Vulnerabilities` sketch from `REQUIREMENTS.md` line 24 or the old research Pattern 2. RESEARCH.md lines 9-16 and 256-260 establish that it assembles a complete `Result`; the leaf regex Pick plus `streamValues()` is the required memory-flat pattern. `streamValues()` is explicitly allowed by the corrected D-08 interpretation.

**Error/backpressure convention:** Let stream errors reject the async generator; do not swallow them or collect output. Native `for await...of` supplies the stream-chain bridge/backpressure (RESEARCH.md lines 187-192). No accumulator, `.toArray()`, `JSON.parse`, `fs.readFile`, or `readFileSync` in this path.

### `apps/api/src/parser/report-parser.spec.ts` (test, file I/O + transform)

**Analog:** no existing spec file is present. Copy the project test runner conventions from `apps/api/package.json` lines 49-83: `rootDir: "src"`, `testRegex: ".*\\.spec\\.ts$"`, `@swc/jest`, CommonJS transform, `testEnvironment: "node"`. The planned spec belongs beside the parser under `src/parser/`, so the existing Jest root and test regex discover it automatically.

**Test pattern to implement:** create a temporary or fixture-path read, iterate `for await (const vulnerability of new ReportParser().parse(path))`, and assert the exact mapped CRITICAL list plus count zero for HIGH/LOW. Use `apps/api/fixtures/known-severity-mix.json` as deterministic committed input. Add a skewed vulnerability array case if the fixture also guards the former whole-Result materialization trap. Do not test by reading/parsing the report in the test helper in a way that could be mistaken for parser behavior; the parser itself is the subject under test.

**Existing test caveat:** STATE.md line 85 records a Node 24-only `@swc/core`/`miette` Jest panic not yet verified on pinned Node 22. Preserve the existing `--passWithNoTests` script behavior while adding this real spec; planner should make Node 22 verification explicit.

### `apps/api/scripts/gen-fixture.ts` (utility, file-I/O batch generation)

**Analog:** no fixture generator exists. Use the research backpressure example (RESEARCH.md lines 199-236) and the project’s existing CLI failure boundary in `apps/api/src/worker.ts` lines 4-16:

```typescript
async function writeChunk(ws: NodeJS.WritableStream, chunk: string): Promise<void> {
  if (!ws.write(chunk)) {
    await once(ws, 'drain');
  }
}
```

Use `createWriteStream` and `once` from `node:events`; emit the opening Trivy JSON, one bounded `JSON.stringify` vulnerability object per iteration, then closing brackets. Validate positive target MB and deterministic severity options before writing. Await `finish`; never build an array or whole document in memory. Per RESEARCH.md lines 236, `JSON.stringify` is acceptable here because it serializes one bounded generated object, not the report parse path.

### `apps/api/scripts/memtest.ts` (utility, streaming consumer + memory measurement)

**Analog:** `apps/api/src/worker.ts` lines 4-16: a small async bootstrap, explicit `process.exit(1)` on failure, and no HTTP wiring. Import the parser directly rather than booting Nest; CONTEXT.md lines 10-15 require isolation.

**Sampler pattern** (RESEARCH.md lines 338-376):

```typescript
let peakRss = 0;
let peakHeapUsed = 0;
let peakExternal = 0;
const sampler = setInterval(() => {
  const m = process.memoryUsage();
  peakRss = Math.max(peakRss, m.rss);
  peakHeapUsed = Math.max(peakHeapUsed, m.heapUsed);
  peakExternal = Math.max(peakExternal, m.external);
}, 200);

try {
  for await (const _vuln of new ReportParser().parse(fixturePath)) {
    count += 1;
  }
} finally {
  clearInterval(sampler);
}
```

Require a fixture path, count/discard yielded values, log peak RSS + heapUsed + external, and return nonzero for parser failure or threshold breach. The process is launched with `node --max-old-space-size=150`; the script itself should not accumulate vulnerabilities. Derive and document the RSS threshold from a measured baseline plus margin; RESEARCH.md line 366’s 180MB is explicitly only a placeholder.

### `apps/api/scripts/memtest-sweep.ts` (utility, batch measurement)

**Analog:** `memtest.ts` above (same parser API and sampler). Run configured 50/200/500MB sizes, with 1GB opt-in; generate or accept fixture paths, execute each case sequentially, and compare peak RSS to a documented constant band. Keep only counters and per-run metrics. CI should use 500MB to bound runtime, as specified in CONTEXT.md lines 31-33.

### `apps/api/fixtures/known-severity-mix.json` (fixture, file-I/O input)

**Analog:** `apps/api/src/domain/trivy-report.types.ts` lines 6-22 defines the exact minimal shape: optional top-level `Results`, each result has `Target` and optional `Vulnerabilities`, and each vulnerability uses the PascalCase Trivy fields. Include a small deterministic mix of CRITICAL and non-CRITICAL objects, including the fields required by the parser mapping. Commit this file; generated 500MB artifacts are not committed.

### `.github/workflows/memory.yml` (CI config, batch process gate)

**Analog:** none exists in the repository. Follow the project’s Node engine convention in `apps/api/package.json` lines 8-10 (`>=22 <23`) and research decision D-09: `actions/checkout`, `actions/setup-node@v4` with Node 22, workspace install, generate a 500MB fixture, then execute the self-test under `node --max-old-space-size=150`. The job must fail on any nonzero command; generated fixtures are ephemeral. Document runtime cost and keep the 1GB sweep out of the default CI path.

### `apps/api/package.json` (config, command orchestration)

**Analog:** existing script block lines 11-20 and dependency layout lines 22-47. Preserve the workspace-local naming style (`build`, `typecheck`, `test`, `lint`) and add explicit scripts for generator, memtest, and sweep. Pin `stream-json` to `2.1.0` and `stream-chain` to `3.6.3` in dependencies per RESEARCH.md lines 51-58 and 76-80; do not install latest ESM-only stream-json 3.x because `tsconfig.json` line 3 is CommonJS. Decide whether scripts call `tsx` directly or build first, but ensure CI invokes Node 22 and the 150MB flag around the built/script entry.

### `package-lock.json` (config, dependency resolution)

**Analog:** existing npm workspace lock structure lines 1-47. Update only as the mechanical result of the package dependency/script change; retain lockfileVersion 3 and the `apps/api` workspace entry. No hand-authored application pattern is needed.

### `apps/api/eslint.config.mjs` (config, static analysis)

**Analog:** existing flat ESLint config lines 7-34. Add a later scoped config object for `files: ['src/parser/**/*.ts']`; preserve `tseslint.config(...)`, `recommendedTypeChecked`, Prettier, `sourceType: 'commonjs'`, and existing no-explicit-any/no-floating-promises rules.

**Guard excerpts to copy/adapt** (RESEARCH.md lines 385-430):

```javascript
{
  files: ['src/parser/**/*.ts'],
  rules: {
    'no-restricted-syntax': ['error',
      { selector: "CallExpression[callee.object.name='JSON'][callee.property.name='parse']",
        message: 'JSON.parse is forbidden on the report path (ENGINE-05).' },
      { selector: "CallExpression[callee.property.name='toArray']",
        message: 'Readable.toArray() buffers the entire stream — forbidden on the report path.' },
    ],
    'no-restricted-properties': ['error',
      { object: 'fs', property: 'readFileSync', message: 'Use the streaming parser pipeline instead.' },
      { object: 'fs', property: 'readFile', message: 'Use the streaming parser pipeline instead.' },
    ],
  },
}
```

Also use `no-restricted-imports` for `readFile`/`readFileSync` from both `node:fs` and `fs` as shown in RESEARCH.md lines 407-423. Do not ban `streamValues()`; research corrected the prior claim and it is required by the leaf-level pipeline.

### `.gitignore` (config, generated file-I/O hygiene)

**Analog:** no relevant existing rule was found. Add a narrow ignore for generated large fixtures under `apps/api/fixtures/` (for example a generated filename/pattern), while explicitly retaining `known-severity-mix.json`. Do not broadly ignore the whole fixture directory if that would hide the committed correctness fixture.

## Shared Patterns

### Framework-free boundary
**Sources:** `apps/api/src/domain/trivy-report.types.ts` lines 1-5 and `apps/api/src/scan/scan.store.ts` lines 1-10.
**Apply to:** parser and scripts. Keep parsing types free of Nest/GraphQL imports; parser is exported but not registered in `ScanModule` this phase. `ScanModule` lines 1-12 remains the Phase 3 DI seam.

### Strict TypeScript and CommonJS
**Sources:** `apps/api/tsconfig.json` lines 3-22; `apps/api/package.json` lines 55-76.
**Apply to:** all new `.ts` files. Avoid `any`, type stream values explicitly, and preserve CommonJS-compatible imports and the pinned CJS stream-json release.

### Failure handling
**Sources:** `apps/api/src/index.ts` lines 20-23 and `apps/api/src/worker.ts` lines 13-16.
**Apply to:** CLI scripts. Use a top-level async function and `.catch((err) => { console.error(err); process.exit(1); })`; use exit 2 for bad CLI usage if desired. Parser errors must propagate rather than be converted into a successful partial count.

### No runtime wiring in Phase 2
**Sources:** `apps/api/src/app.module.ts` lines 6-19 and `apps/api/src/worker.module.ts` lines 6-22; CONTEXT.md lines 14 and 83-85.
**Apply to:** parser. Do not import `ReportParser` into API/worker modules or add a provider yet; Phase 3 plugs it into the existing seam.

## No Analog Found

| File | Role | Data Flow | Reason / Planner Guidance |
|---|---|---|---|
| `apps/api/src/parser/report-parser.ts` | service/utility | streaming transform | No existing streaming parser; use corrected RESEARCH.md Pattern 1, not old `pick('Results') + streamArray()`. |
| `apps/api/scripts/gen-fixture.ts` | utility | file I/O batch | No generator; use Node write-stream backpressure example. |
| `apps/api/scripts/memtest.ts` | utility | streaming measurement | No memory harness; use `worker.ts` failure boundary plus research sampler. |
| `apps/api/scripts/memtest-sweep.ts` | utility | batch measurement | No sweep; compose the memtest contract sequentially. |
| `.github/workflows/memory.yml` | CI config | batch process gate | No workflow directory/file exists; create a minimal Node 22 job. |
| `.gitignore` large-fixture rule | config | file I/O hygiene | No applicable existing rule found. |

## Metadata

**Analog search scope:** `apps/api/src/**`, `apps/api/package.json`, root `package.json`/`package-lock.json`, `apps/api/eslint.config.mjs`, repository workflow paths.
**Files scanned:** 13 source/config files plus repository structure and package lock header.
**Key locked pattern:** deep regex `pick` to `Results.<i>.Vulnerabilities.<j>` + `streamValues()`; no whole-Result assembly.
**Known planning checkpoint:** RESEARCH.md lines 452-462 flags D-08 wording and skewed fixture shape. Planner should resolve/document both explicitly; the recommended resolution is to ban only `JSON.parse`, `fs.readFile`/`readFileSync`, and `.toArray()` while allowing `streamValues()`.
