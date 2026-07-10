import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Fail-closed compiled-worker process contract (Plan 03-03, Task 2).
 *
 * Validates the REAL compiled `dist/worker.js` under plain `node` — the path
 * unaffected by the recorded `@swc/core`+`@nestjs/bullmq` jest panic. It proves:
 *   - the worker emits EXACTLY `SCAN_WORKER_READY\n` after context + WorkerHost
 *     provider initialization, with NO unexpected pre-marker stdout/stderr;
 *   - the process is long-lived after the marker (a post-marker timeout is the
 *     expected outcome and is terminated cleanly);
 *   - invalid fault/marker configuration fails closed (non-zero exit, no marker);
 *   - the worker root wires the shared ScanModule and imports no HTTP/GraphQL
 *     transport and creates no network listener.
 *
 * A silent local TCP stub stands in for Redis so the assertions never depend on
 * a live Redis and no connection error reaches stderr during the bounded window.
 */

const API_DIR = fileURLToPath(new URL('../', import.meta.url));
const WORKER_JS = join(API_DIR, 'dist', 'worker.js');
const MARKER = 'SCAN_WORKER_READY';

const MARKER_TIMEOUT_MS = 30_000;
const POST_MARKER_HOLD_MS = 1_500;
const FAIL_CLOSED_TIMEOUT_MS = 30_000;

/** Build the compiled worker first so the contract is self-contained. */
function ensureBuilt() {
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: API_DIR,
    shell: false,
    stdio: 'ignore',
    timeout: 180_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `npm run build failed (status ${String(result.status)}${
        result.error ? `, ${result.error.message}` : ''
      })`,
    );
  }
  assert.ok(existsSync(WORKER_JS), `expected compiled worker at ${WORKER_JS}`);
}

/** Silent TCP stub: accepts connections and swallows bytes, never replying. */
function startRedisStub() {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.on('data', () => {});
      socket.on('error', () => {});
    });
    server.on('error', () => {});
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function baseEnv(overrides) {
  return {
    ...process.env,
    NODE_ENV: 'production',
    REDIS_HOST: '127.0.0.1',
    SCAN_ENGINE_READY_MARKER: 'none',
    ...overrides,
  };
}

/**
 * Spawn the compiled worker and resolve once the marker is seen (holding briefly
 * to confirm the process stays alive) or once it exits / times out beforehand.
 */
function runWorker(env, { markerTimeoutMs, postMarkerHoldMs }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER_JS], {
      cwd: API_DIR,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let markerIndex = -1;
    let preMarkerStderr = '';
    let exitCode = null;
    let settled = false;
    let holdTimer;

    const finish = (kind) => {
      if (settled) return;
      settled = true;
      clearTimeout(markerTimer);
      clearTimeout(holdTimer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
      resolve({
        kind,
        stdout,
        stderr,
        preMarkerStdout: markerIndex === -1 ? stdout : stdout.slice(0, markerIndex),
        preMarkerStderr,
        exitCode,
      });
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (markerIndex === -1) {
        const idx = stdout.indexOf(MARKER);
        if (idx !== -1) {
          markerIndex = idx;
          preMarkerStderr = stderr;
          holdTimer = setTimeout(() => finish('marker'), postMarkerHoldMs);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('exit', (code) => {
      exitCode = code;
      if (markerIndex === -1) finish('exit');
    });
    const markerTimer = setTimeout(() => {
      if (markerIndex === -1) finish('timeout');
    }, markerTimeoutMs);
  });
}

test('valid config: emits SCAN_WORKER_READY cleanly and stays long-lived', async () => {
  ensureBuilt();
  const server = await startRedisStub();
  const { port } = server.address();
  const scanTmpDir = await mkdtemp(join(tmpdir(), 'worker-contract-ok-'));
  try {
    const result = await runWorker(
      baseEnv({
        REDIS_PORT: String(port),
        SCAN_TMP_DIR: scanTmpDir,
        SCAN_ENGINE_TEST_FAULT: 'none',
      }),
      { markerTimeoutMs: MARKER_TIMEOUT_MS, postMarkerHoldMs: POST_MARKER_HOLD_MS },
    );

    assert.equal(result.kind, 'marker', `worker did not reach the marker: ${result.stderr}`);
    // The marker is the ONLY thing on stdout before it appears.
    assert.equal(result.preMarkerStdout, '', 'unexpected pre-marker stdout');
    // No stderr may precede the readiness marker.
    assert.equal(result.preMarkerStderr, '', `unexpected pre-marker stderr: ${result.preMarkerStderr}`);
    // Exact sentinel line.
    assert.match(result.stdout, /^SCAN_WORKER_READY\n/);
  } finally {
    server.close();
    await rm(scanTmpDir, { recursive: true, force: true });
  }
});

test('fail-closed: an invalid SCAN_ENGINE_TEST_FAULT refuses to boot with no marker', async () => {
  ensureBuilt();
  const server = await startRedisStub();
  const { port } = server.address();
  const scanTmpDir = await mkdtemp(join(tmpdir(), 'worker-contract-bad-'));
  try {
    const result = await runWorker(
      baseEnv({
        REDIS_PORT: String(port),
        SCAN_TMP_DIR: scanTmpDir,
        SCAN_ENGINE_TEST_FAULT: 'definitely-not-allowed',
      }),
      { markerTimeoutMs: FAIL_CLOSED_TIMEOUT_MS, postMarkerHoldMs: POST_MARKER_HOLD_MS },
    );

    assert.equal(result.kind, 'exit', 'invalid config must exit, not reach the marker');
    assert.notEqual(result.exitCode, 0, 'invalid config must exit non-zero');
    assert.ok(!result.stdout.includes(MARKER), 'no readiness marker on fail-closed boot');
    assert.match(result.stderr, /SCAN_ENGINE_TEST_FAULT/);
  } finally {
    server.close();
    await rm(scanTmpDir, { recursive: true, force: true });
  }
});

test('fail-closed: a missing required env var (SCAN_TMP_DIR) refuses to boot', async () => {
  ensureBuilt();
  const server = await startRedisStub();
  const { port } = server.address();
  try {
    const env = baseEnv({ REDIS_PORT: String(port), SCAN_ENGINE_TEST_FAULT: 'none' });
    delete env.SCAN_TMP_DIR;
    const result = await runWorker(env, {
      markerTimeoutMs: FAIL_CLOSED_TIMEOUT_MS,
      postMarkerHoldMs: POST_MARKER_HOLD_MS,
    });
    assert.equal(result.kind, 'exit', 'missing SCAN_TMP_DIR must exit, not reach the marker');
    assert.notEqual(result.exitCode, 0, 'missing required env must exit non-zero');
    assert.ok(!result.stdout.includes(MARKER), 'no readiness marker without valid env');
  } finally {
    server.close();
  }
});

test('worker root is transport-free and wires the shared ScanModule', async () => {
  const moduleSrc = await readFile(join(API_DIR, 'src', 'worker.module.ts'), 'utf8');
  const workerSrc = await readFile(join(API_DIR, 'src', 'worker.ts'), 'utf8');

  // Shared seam is imported (cannot be bypassed).
  assert.match(moduleSrc, /import\s*\{[^}]*\bScanModule\b[^}]*\}\s*from\s*'\.\/scan\/scan\.module'/);
  assert.match(moduleSrc, /imports:\s*\[[\s\S]*ScanModule[\s\S]*\]/);

  // No HTTP/GraphQL transport, controllers, resolvers, or network listeners.
  const forbidden = [
    /@nestjs\/platform-fastify/,
    /@nestjs\/platform-express/,
    /@nestjs\/graphql/,
    /mercurius/,
    /@Controller\b/,
    /@Resolver\b/,
    /NestFactory\.create\s*</,
    /NestFactory\.create\s*\(/,
    /\.listen\s*\(/,
  ];
  for (const pattern of [moduleSrc, workerSrc]) {
    for (const rx of forbidden) {
      assert.doesNotMatch(pattern, rx, `forbidden transport/listener token: ${rx}`);
    }
  }

  // The worker entrypoint uses a standalone context and emits the exact marker.
  assert.match(workerSrc, /createApplicationContext\s*\(/);
  assert.match(workerSrc, /process\.stdout\.write\('SCAN_WORKER_READY\\n'\)/);
});
