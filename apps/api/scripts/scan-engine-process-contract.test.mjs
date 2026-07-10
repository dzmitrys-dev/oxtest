import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Plan 03-04 — always-run process/command-safety contract (Docker-free).
 *
 * Static source assertions that lock the security-relevant invariants of the
 * scan engine's process boundary so a regression fails CI even on runners
 * WITHOUT Docker/Redis. It intentionally requires no external services, mirroring
 * the Phase 2 `memory-process-contract.test.mjs` pattern, and is the core of the
 * always-required `scan-engine-contract` CI status. The Docker-backed behavioural
 * proof lives in `scan-engine-integration.mjs` behind the feasibility gate.
 */

const API_DIR = fileURLToPath(new URL('../', import.meta.url));
const readSrc = (rel) => readFile(join(API_DIR, rel), 'utf8');

const TRIVY_IMAGE = 'ghcr.io/aquasecurity/trivy:0.69.3';

test('integration harness spawns the compiled worker with argv arrays and shell:false', async () => {
  const src = await readSrc('scripts/scan-engine-integration.mjs');
  // Discrete argv spawn of the compiled entrypoint; never a shell string.
  assert.match(src, /spawn\(\s*process\.execPath\s*,\s*\[WORKER_JS\]/);
  assert.match(src, /shell:\s*false/);
  assert.match(src, /dist['"),\s]/);
  assert.match(src, /worker\.js/);
  // No shell execution anywhere in the harness or its docker helpers.
  assert.doesNotMatch(src, /shell:\s*true/);
  // Never the shell-string exec family (ioredis `multi().exec()` is unrelated).
  assert.doesNotMatch(src, /\bexecSync\(|\bexecFile\(|\bexecFileSync\(/);
});

test('integration harness keeps SCAN_WORKER_READY and REPORT_READY as DISTINCT markers', async () => {
  const src = await readSrc('scripts/scan-engine-integration.mjs');
  assert.match(src, /SCAN_WORKER_READY/);
  assert.match(src, /REPORT_READY/);
  // Bootstrap readiness is awaited before enqueue; report readiness is a
  // separate observation with its own waiter — the two are never conflated.
  assert.match(src, /waitReady\(/);
  assert.match(src, /waitReport\(/);
  assert.ok(
    src.indexOf('WORKER_READY_MARKER') < src.indexOf('REPORT_READY_PREFIX'),
    'the bootstrap sentinel is defined/handled independently of the report marker',
  );
});

test('integration harness clones the committed bundle offline — never a live Git URL', async () => {
  const src = await readSrc('scripts/scan-engine-integration.mjs');
  assert.match(src, /sample-repo\.bundle/);
  assert.doesNotMatch(src, /github\.com|https?:\/\/[^\s'"]*\.git\b/);
});

test('Trivy adapter pins the reviewed GHCR image (no :latest, no stale Docker Hub ref) with the exact mount contract', async () => {
  const src = await readSrc('src/engine/trivy-runner.adapter.ts');
  assert.match(src, new RegExp(`TRIVY_DOCKER_IMAGE\\s*=\\s*'${TRIVY_IMAGE.replace(/[.]/g, '\\.')}'`));
  // No floating tag on the image itself (the "NEVER :latest" doc note is fine).
  assert.doesNotMatch(src, /trivy:latest/);
  // Every `aquasecurity/trivy` reference MUST be the ghcr.io-pinned one.
  assert.doesNotMatch(src, /(?<!ghcr\.io\/)aquasecurity\/trivy/);
  // Read-only clone mount, writable report-parent mount, ephemeral tmpfs cache.
  assert.match(src, /:\$\{CONTAINER_SRC\}:ro`|:\/src:ro/);
  assert.match(src, /CONTAINER_OUT|:\/out/);
  assert.match(src, /type=tmpfs/);
  assert.match(src, /'--rm'/);
  assert.match(src, /'--exit-code',\s*\n?\s*'0'|'--exit-code', '0'/);
});

test('worker configures concurrency 1 with NO automatic BullMQ retry/backoff', async () => {
  const workerSrc = await readSrc('src/engine/scan-worker.ts');
  assert.match(workerSrc, /@Processor\(\s*[^)]*concurrency:\s*1/s);
  const serviceSrc = await readSrc('src/scan/scan.service.ts');
  // Producer enqueues the minimal typed payload with no retry policy.
  assert.match(serviceSrc, /queue\.add\(\s*SCAN_JOB_NAME\s*,\s*\{\s*scanId:\s*id,\s*repoUrl\s*\}\s*\)/);
  for (const src of [workerSrc, serviceSrc, await readSrc('src/worker.module.ts')]) {
    assert.doesNotMatch(src, /attempts\s*:/);
    assert.doesNotMatch(src, /backoff\s*:/);
  }
});

test('ScanService is transport/engine-free: no node:fs, node:child_process, execa, or docker', async () => {
  const src = await readSrc('src/scan/scan.service.ts');
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  for (const forbidden of ['node:fs', 'fs', 'node:child_process', 'child_process', 'execa']) {
    assert.ok(!imports.includes(forbidden), `ScanService must not import ${forbidden}`);
  }
  // No parser/adapter implementation import either (the JSDoc naming Docker/Trivy
  // in its prohibition note is expected and not scanned here).
  assert.ok(!imports.some((i) => /engine\/|report-parser/.test(i)), 'no engine/parser imports');
});

test('adapter-factory fault seam is opt-in and fail-closed; production builds only real adapters', async () => {
  const src = await readSrc('src/engine/adapter-factory.ts');
  // Fail-closed resolution: an unknown fault throws rather than degrading.
  assert.match(src, /export function resolveEngineTestFault/);
  assert.match(src, /throw new Error\(\s*[\s\S]*Invalid SCAN_ENGINE_TEST_FAULT/);
  // fault 'none' → the real adapters (RepoClonerAdapter, TrivyRunnerAdapter, …).
  assert.match(src, /if\s*\(\s*fault === 'none'\s*\)/);
  assert.match(src, /new TrivyRunnerAdapter\(/);
  // The real clone adapter is constructed with the validated git transport
  // allowlist injected (CR-01); it must still be the REAL adapter class.
  assert.match(src, /new RepoClonerAdapter\(/);
  // The REPORT_READY producer is distinct from the bootstrap sentinel.
  assert.match(src, /reportReadyStdoutProducer/);
  assert.match(src, /REPORT_READY \$\{reportPath\}/);
});

test('env schema keeps a fail-closed fault allowlist that EXCLUDES the unit-only cleanup mode', async () => {
  const src = await readSrc('src/config/env.validation.ts');
  assert.match(src, /SCAN_ENGINE_TEST_FAULT[\s\S]*valid\('none',\s*'clone',\s*'trivy',\s*'disk-full',\s*'parse'\)[\s\S]*default\('none'\)/);
  // 'cleanup' is a direct-call-only unit fault; it must never be env-reachable.
  const faultLine = src.slice(src.indexOf('SCAN_ENGINE_TEST_FAULT'), src.indexOf('SCAN_ENGINE_READY_MARKER'));
  assert.doesNotMatch(faultLine, /'cleanup'/);
});

test('worker root and entrypoint stay transport-free (no HTTP/GraphQL/listener)', async () => {
  const moduleSrc = await readSrc('src/worker.module.ts');
  const workerSrc = await readSrc('src/worker.ts');
  for (const src of [moduleSrc, workerSrc]) {
    for (const rx of [
      /@nestjs\/platform-fastify/,
      /@nestjs\/platform-express/,
      /@nestjs\/graphql/,
      /mercurius/,
      /@Controller\b/,
      /@Resolver\b/,
      /\.listen\s*\(/,
    ]) {
      assert.doesNotMatch(src, rx, `forbidden transport/listener token ${rx}`);
    }
  }
  assert.match(workerSrc, /createApplicationContext\s*\(/);
  assert.match(workerSrc, /SCAN_WORKER_READY/);
});

test('out-of-scope guard: the harness/probe add no Phase 4 transport, Phase 5 Compose, or Phase 6 docs', async () => {
  // (This contract file itself names those tokens inside assertion patterns, so
  // it is deliberately excluded from its own negative scan.)
  const harness = await readSrc('scripts/scan-engine-integration.mjs');
  const feasibility = await readSrc('scripts/scan-engine-feasibility.mjs');
  for (const src of [harness, feasibility]) {
    assert.doesNotMatch(src, /@nestjs\/graphql|mercurius|docker-compose|compose\.ya?ml/i);
  }
});
