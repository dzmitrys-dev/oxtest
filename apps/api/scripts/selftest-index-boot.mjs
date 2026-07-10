import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Plan 05-03 — criterion #5a AUTHORITATIVE, Docker-FREE self-test.
 *
 * The assignment's single-most-graded artifact is the verbatim command
 *
 *     node --max-old-space-size=150 dist/index.js
 *
 * This script proves that command boots the REST API cleanly WITHOUT OOM and
 * WITHOUT a non-zero exit — on a runner that has NEITHER Docker NOR a reachable
 * Redis. That independence is what makes it the always-required contract-job
 * gate (the richer Docker-path superset lives in `acceptance.mjs`).
 *
 * How it needs no infrastructure: `index.ts` prints the readiness marker AFTER
 * `app.listen()`, which does NOT await a Redis connection — ioredis/BullMQ
 * connect lazily in the background, and 05-01 (WR-03) attached a non-throwing
 * Redis `error` listener so an unreachable broker cannot crash boot. We point
 * the API at a deliberately CLOSED loopback port (allocate an ephemeral port,
 * release it, reuse it as `REDIS_PORT`) so no Redis/Docker is required.
 *
 * Conventions mirror `api-integration.mjs`: `node:test` / `assert`, discrete
 * argv arrays with `shell: false`, finite bounded timeouts, and a
 * status-preserving `finally` teardown. This file is intentionally
 * SELF-CONTAINED (no import from `api-integration.mjs`) per the codebase
 * convention that each harness `.mjs` stands alone; it reuses the proven
 * `allocatePort` / `spawnApi` bounded-wait SHAPES only as a pattern.
 */

const API_DIR = fileURLToPath(new URL('../', import.meta.url));
const API_JS = join(API_DIR, 'dist', 'index.js');
const API_READY_MARKER = 'API HTTP listener ready';

/** Bounded, status-preserving timeouts for the real process boundary. */
const BUILD_TIMEOUT_MS = 180_000;
const API_READY_TIMEOUT_MS = 60_000;
/** The compiled app's default SHUTDOWN_GRACE_MS (env.validation.ts, WR-02 <=9000). */
const SHUTDOWN_GRACE_MS = 8_000;
/** Margin above the grace window for a bounded, non-flaky exit assertion. */
const SHUTDOWN_MARGIN_MS = 7_000;
/** Node abort / OOM-kill exit codes — an explicit false-negative guard. */
const ABORT_EXIT_CODE = 134;
const OOM_EXIT_CODE = 137;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Build the compiled app once if `dist/index.js` is absent (self-contained gate). */
function ensureBuilt() {
  if (existsSync(API_JS)) return;
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: API_DIR,
    shell: false,
    stdio: 'ignore',
    timeout: BUILD_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(
      `npm run build failed (status ${String(result.status)}${
        result.error ? `, ${result.error.message}` : ''
      })`,
    );
  }
  assert.ok(existsSync(API_JS), `expected compiled API at ${API_JS}`);
}

/**
 * Allocate a free loopback TCP port by opening a throwaway server on
 * `127.0.0.1:0`, reading the OS-assigned port, then closing it before returning.
 * The returned port is therefore CLOSED/unreachable at resolution time — exactly
 * what we want for `REDIS_PORT` (guaranteed connection-refused, no Redis needed)
 * and for the API's own `PORT` (which the caller then binds).
 */
function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Spawn the verbatim graded command `node --max-old-space-size=150 dist/index.js`
 * with `REDIS_PORT` pointed at a CLOSED loopback port, wait for the readiness
 * marker, and expose bounded `waitReady`/`waitExit`/`kill` (mirrors the
 * `spawnApi` shape but prepends the heap flag and forces an unreachable Redis).
 */
function spawnGradedApi({ redisPort, apiPort, scanTmpDir }) {
  const child = spawn(process.execPath, ['--max-old-space-size=150', API_JS], {
    cwd: API_DIR,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: String(redisPort),
      SCAN_TMP_DIR: scanTmpDir,
      PORT: String(apiPort),
    },
  });

  const state = { stdout: '', stderr: '', ready: false };
  const readyWaiters = [];
  const exitWaiters = [];
  let exitInfo = null;

  child.stdout.on('data', (chunk) => {
    state.stdout += chunk.toString('utf8');
    if (!state.ready && state.stdout.includes(API_READY_MARKER)) {
      state.ready = true;
      while (readyWaiters.length) readyWaiters.shift()();
    }
  });
  child.stderr.on('data', (chunk) => {
    state.stderr += chunk.toString('utf8');
  });
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    while (exitWaiters.length) exitWaiters.shift()(exitInfo);
  });

  return {
    child,
    state,
    waitReady(timeoutMs) {
      if (state.ready) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`API did not emit "${API_READY_MARKER}": ${state.stderr}`)),
          timeoutMs,
        );
        // If the child dies before the marker, fail fast with the captured stderr.
        exitWaiters.push((info) => {
          if (!state.ready) {
            clearTimeout(timer);
            reject(
              new Error(
                `API exited before "${API_READY_MARKER}" (${JSON.stringify(info)}): ${state.stderr}`,
              ),
            );
          }
        });
        readyWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    waitExit(timeoutMs) {
      if (exitInfo) return Promise.resolve(exitInfo);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`API did not exit within ${timeoutMs}ms: ${state.stderr}`)),
          timeoutMs,
        );
        exitWaiters.push((info) => {
          clearTimeout(timer);
          resolve(info);
        });
      });
    },
    kill() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    },
  };
}

test(
  'criterion #5a (Docker-FREE): `node --max-old-space-size=150 dist/index.js` boots to the listener marker against a CLOSED Redis port, no OOM/non-zero exit',
  { timeout: BUILD_TIMEOUT_MS + API_READY_TIMEOUT_MS + SHUTDOWN_GRACE_MS + SHUTDOWN_MARGIN_MS + 30_000 },
  async () => {
    ensureBuilt();
    assert.ok(existsSync(API_JS), `expected compiled API at ${API_JS} (build gate)`);

    // A CLOSED loopback port for Redis: allocate then immediately release, so a
    // connection attempt is guaranteed-refused — no Docker, no Redis required.
    const closedRedisPort = await allocatePort();
    const apiPort = await allocatePort();
    const scanTmpDir = await mkdtemp(join(tmpdir(), 'selftest-index-'));

    const api = spawnGradedApi({ redisPort: closedRedisPort, apiPort, scanTmpDir });
    try {
      // (iv) the child prints the EXACT marker within the bounded window.
      await api.waitReady(API_READY_TIMEOUT_MS);

      // (v) still alive at the marker — it did not crash or OOM during boot.
      assert.equal(
        api.child.exitCode,
        null,
        'API process is still running at the readiness marker (no crash/OOM during boot)',
      );
      assert.equal(
        api.child.signalCode,
        null,
        'API process was not signalled at the readiness marker',
      );

      // (vi) SIGTERM-drain and assert a clean, non-OOM/non-abort exit.
      api.child.kill('SIGTERM');
      const exit = await api.waitExit(SHUTDOWN_GRACE_MS + SHUTDOWN_MARGIN_MS);

      assert.notEqual(
        exit.code,
        ABORT_EXIT_CODE,
        `API must not abort (exit ${ABORT_EXIT_CODE}); got ${JSON.stringify(exit)} :: ${api.state.stderr}`,
      );
      assert.notEqual(
        exit.code,
        OOM_EXIT_CODE,
        `API must not be OOM-killed (exit ${OOM_EXIT_CODE}); got ${JSON.stringify(exit)} :: ${api.state.stderr}`,
      );
      assert.ok(
        exit.code === 0 || exit.signal === 'SIGTERM',
        `expected a clean shutdown (exit 0 or re-raised SIGTERM), got ${JSON.stringify(exit)} :: ${api.state.stderr}`,
      );
    } finally {
      // (vii) always kill any survivor and remove the temp dir.
      api.kill();
      await rm(scanTmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
);
