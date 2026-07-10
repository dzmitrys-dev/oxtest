import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * Plan 04-03 — end-to-end REST + runtime-lifecycle integration harness.
 *
 * Proves the Phase 4 contract against the COMPILED application — the real
 * `dist/index.js` API process AND the real `dist/worker.js` worker process —
 * over a disposable `redis:7-alpine` container bound to loopback on an ephemeral
 * port. This is the compiled-process owner for the proofs Plans 01 and 02
 * delegate here (ROADMAP success criterion #5), WITHOUT GraphQL and WITHOUT ever
 * importing the `@nestjs/bullmq`-wired module into Jest (the confirmed
 * `@swc/core` miette panic; STATE.md).
 *
 * This harness is intentionally SELF-CONTAINED: it lifts the proven helper
 * shapes from `scan-engine-integration.mjs` (disposable-Redis lifecycle,
 * `withHarness`, `spawnWorker`, status observer, terminal poll, cleanup asserts)
 * and ADDS the API dimension (`spawnApi`, `killRedis`). The Phase 3 harness is
 * deliberately left untouched — each harness `.mjs` stays self-contained per the
 * established codebase convention.
 *
 * Conventions mirror `scan-engine-integration.mjs`: `node:test` / `assert`,
 * discrete argv arrays with `shell: false`, finite bounded timeouts, and
 * status-preserving `finally` teardown of every disposable resource.
 */

const API_DIR = fileURLToPath(new URL('../', import.meta.url));
const API_JS = join(API_DIR, 'dist', 'index.js');
const WORKER_JS = join(API_DIR, 'dist', 'worker.js');
const BUNDLE_GENERATOR = fileURLToPath(
  new URL('../test-fixtures/create-sample-repo-bundle.mjs', import.meta.url),
);
const SAMPLE_BUNDLE = fileURLToPath(
  new URL('../test-fixtures/sample-repo.bundle', import.meta.url),
);

const WORKER_READY_MARKER = 'SCAN_WORKER_READY';
const REPORT_READY_PREFIX = 'REPORT_READY ';
const API_READY_MARKER = 'API HTTP listener ready';
const REDIS_IMAGE = 'redis:7-alpine';

/** Bounded timeouts (finite, status-preserving) for the real process boundary. */
const BUILD_TIMEOUT_MS = 180_000;
const WORKER_READY_TIMEOUT_MS = 60_000;
const API_READY_TIMEOUT_MS = 60_000;
const REDIS_READY_TIMEOUT_MS = 30_000;
/** First Docker Trivy run pulls the image and downloads the vuln DB. */
const SCAN_TERMINAL_TIMEOUT_MS = 300_000;
const FAULT_TERMINAL_TIMEOUT_MS = 60_000;
const STATUS_POLL_INTERVAL_MS = 25;
/** The compiled worker's default SHUTDOWN_GRACE_MS (env.validation.ts). */
const SHUTDOWN_GRACE_MS = 8_000;
/** Margin above the grace window for a bounded, non-flaky exit assertion. */
const SHUTDOWN_MARGIN_MS = 7_000;

/** The two CRITICAL CVEs the pinned fixture reliably yields, in report order. */
const EXPECTED_CRITICAL_IDS = ['CVE-2019-10744', 'CVE-2021-44906'];

let built = false;

/** Build the compiled app once per harness process (self-contained gate). */
function ensureBuilt() {
  if (built) return;
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
  assert.ok(existsSync(WORKER_JS), `expected compiled worker at ${WORKER_JS}`);
  built = true;
}

/** Ensure the committed bundle exists; regenerate deterministically if absent. */
function ensureFixture() {
  if (existsSync(SAMPLE_BUNDLE)) return;
  const result = spawnSync(process.execPath, [BUNDLE_GENERATOR], {
    cwd: API_DIR,
    shell: false,
    stdio: 'ignore',
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error('failed to generate sample-repo.bundle fixture');
  }
  assert.ok(existsSync(SAMPLE_BUNDLE), `expected committed bundle at ${SAMPLE_BUNDLE}`);
}

/** Preflight: Docker must be usable (the disposable Redis is a container). */
function assertDockerAvailable() {
  const result = spawnSync('docker', ['info'], {
    shell: false,
    stdio: 'ignore',
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error('docker is not available; the integration harness requires Docker');
  }
}

/** Is Docker usable right now (soft check for the Docker-gated Finished test)? */
function isDockerAvailable() {
  const result = spawnSync('docker', ['info'], {
    shell: false,
    stdio: 'ignore',
    timeout: 30_000,
  });
  return result.status === 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start a disposable Redis container on an ephemeral loopback port. Returns the
 * container id and mapped port plus a `remove()` that force-deletes it.
 */
function startDisposableRedis() {
  const runResult = spawnSync(
    'docker',
    ['run', '-d', '--rm', '-p', '127.0.0.1:0:6379/tcp', REDIS_IMAGE],
    { shell: false, encoding: 'utf8', timeout: 60_000 },
  );
  if (runResult.status !== 0) {
    throw new Error(`failed to start disposable Redis: ${runResult.stderr?.trim() ?? ''}`);
  }
  const containerId = runResult.stdout.trim();
  const portResult = spawnSync('docker', ['port', containerId, '6379/tcp'], {
    shell: false,
    encoding: 'utf8',
    timeout: 15_000,
  });
  const mapped = portResult.stdout.trim().split('\n')[0] ?? '';
  const port = Number(mapped.split(':').at(-1));
  if (!Number.isInteger(port) || port <= 0) {
    spawnSync('docker', ['rm', '-f', containerId], { shell: false, stdio: 'ignore' });
    throw new Error(`could not resolve mapped Redis port from '${mapped}'`);
  }
  return {
    containerId,
    port,
    remove() {
      // Idempotent: `docker rm -f` on an already-removed container is a no-op.
      spawnSync('docker', ['rm', '-f', containerId], { shell: false, stdio: 'ignore' });
    },
  };
}

/** Connect to the disposable Redis and wait until it answers PING. */
async function connectRedis(port) {
  const redis = new Redis({
    host: '127.0.0.1',
    port,
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
  const deadline = Date.now() + REDIS_READY_TIMEOUT_MS;
  for (;;) {
    try {
      await redis.ping();
      return redis;
    } catch (error) {
      if (Date.now() > deadline) {
        redis.disconnect();
        throw new Error(`Redis did not become ready: ${String(error)}`);
      }
      await sleep(100);
    }
  }
}

/** Seed a Queued domain record exactly as ScanService.enqueue would (hash + list). */
async function seedQueued(redis, scanId, repoUrl) {
  const key = `scan:${scanId}`;
  const ts = new Date().toISOString();
  await redis
    .multi()
    .del(key)
    .del(`${key}:critical`)
    .hset(key, {
      id: scanId,
      status: 'Queued',
      repoUrl,
      createdAt: ts,
      updatedAt: ts,
    })
    .rpush(`${key}:critical`, ' scan:list:init')
    .expire(key, 604_800)
    .expire(`${key}:critical`, 604_800)
    .exec();
}

/**
 * Tight-loop status observer on a DEDICATED connection. Records the ordered set
 * of DISTINCT statuses the domain record passes through — this reliably catches
 * the brief `Scanning` window even on instantaneous fault paths, because each
 * worker transition is a Redis round-trip.
 */
function startStatusObserver(port, scanId) {
  const key = `scan:${scanId}`;
  const observed = [];
  let running = true;
  const conn = new Redis({ host: '127.0.0.1', port, maxRetriesPerRequest: null });
  const loop = (async () => {
    while (running) {
      let status;
      try {
        status = await conn.hget(key, 'status');
      } catch {
        status = undefined;
      }
      if (status && observed.at(-1) !== status) observed.push(status);
    }
  })();
  return {
    observed,
    async stop() {
      running = false;
      await loop;
      conn.disconnect();
    },
  };
}

/**
 * Allocate a free loopback TCP port by opening a throwaway server on
 * `127.0.0.1:0`, reading the OS-assigned port, then closing it before the caller
 * spawns. The API entrypoint (`index.ts`) does not echo its chosen port, so the
 * harness MUST pick one. The small TOCTOU window (port could be taken between
 * close and spawn) is harness-acceptable for a loopback test.
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
 * Spawn the compiled worker with a validated argv array and env, wait for the
 * independent `SCAN_WORKER_READY` bootstrap sentinel (NEVER conflated with the
 * report-readiness marker), capture the first `REPORT_READY <path>` line, and
 * expose a bounded `waitExit` for the graceful-shutdown assertions.
 */
function spawnWorker({ port, scanTmpDir, fault, readyMarker, nodeEnv }) {
  const child = spawn(process.execPath, [WORKER_JS], {
    cwd: API_DIR,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // HIGH-02: the SCAN_ENGINE_TEST_FAULT seam is INERT in production, so a
      // fault-injection case MUST run under a non-production NODE_ENV to
      // activate the doubles. The Docker success path stays 'production' and
      // exercises the real adapters end-to-end.
      NODE_ENV: nodeEnv ?? 'production',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: String(port),
      SCAN_TMP_DIR: scanTmpDir,
      SCAN_ENGINE_TEST_FAULT: fault,
      SCAN_ENGINE_READY_MARKER: readyMarker,
      // CR-01: production defaults to `https` only. This harness clones the
      // committed `sample-repo.bundle` over git's `file` transport, so it — and
      // ONLY it, as TRUSTED local test infrastructure — widens the allowlist to
      // `https:file`. Production never enables `file`.
      SCAN_GIT_ALLOWED_PROTOCOLS: 'https:file',
    },
  });

  const state = {
    stdout: '',
    stderr: '',
    workerReady: false,
    reportReady: null,
  };
  const readyWaiters = [];
  const reportWaiters = [];
  const exitWaiters = [];
  let exitInfo = null;

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    state.stdout += text;
    if (!state.workerReady && state.stdout.includes(WORKER_READY_MARKER)) {
      state.workerReady = true;
      while (readyWaiters.length) readyWaiters.shift()();
    }
    if (!state.reportReady) {
      for (const line of state.stdout.split('\n')) {
        if (line.startsWith(REPORT_READY_PREFIX)) {
          const reportPath = line.slice(REPORT_READY_PREFIX.length).trim();
          let existedAtEvent = false;
          try {
            existedAtEvent = statSync(reportPath).isFile();
          } catch {
            existedAtEvent = false;
          }
          state.reportReady = { reportPath, existedAtEvent };
          while (reportWaiters.length) reportWaiters.shift()();
          break;
        }
      }
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
      if (state.workerReady) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`worker did not emit ${WORKER_READY_MARKER}: ${state.stderr}`)),
          timeoutMs,
        );
        readyWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    waitReport(timeoutMs) {
      if (state.reportReady) return Promise.resolve(state.reportReady);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('worker did not emit REPORT_READY in time')),
          timeoutMs,
        );
        reportWaiters.push(() => {
          clearTimeout(timer);
          resolve(state.reportReady);
        });
      });
    },
    waitExit(timeoutMs) {
      if (exitInfo) return Promise.resolve(exitInfo);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`worker did not exit within ${timeoutMs}ms: ${state.stderr}`)),
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

/**
 * Spawn the compiled API (`dist/index.js`) on a freshly allocated loopback port,
 * wait for the `API HTTP listener ready` stdout sentinel (index.ts:17), and
 * expose `baseUrl`, a bounded `waitReady`, a bounded `waitExit`, and a `kill`.
 */
async function spawnApi({ port, scanTmpDir, nodeEnv }) {
  const apiPort = await allocatePort();
  const child = spawn(process.execPath, [API_JS], {
    cwd: API_DIR,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: nodeEnv ?? 'production',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: String(port),
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
    baseUrl: `http://127.0.0.1:${apiPort}`,
    apiPort,
    waitReady(timeoutMs) {
      if (state.ready) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`API did not emit ${API_READY_MARKER}: ${state.stderr}`)),
          timeoutMs,
        );
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

/** Poll the authoritative domain status until it reaches a terminal state. */
async function waitTerminal(redis, scanId, timeoutMs) {
  const key = `scan:${scanId}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await redis.hget(key, 'status');
    if (status === 'Finished' || status === 'Failed') return status;
    if (Date.now() > deadline) {
      throw new Error(`scan ${scanId} did not reach a terminal state (last: ${String(status)})`);
    }
    await sleep(STATUS_POLL_INTERVAL_MS);
  }
}

/** Read the ordered CRITICAL results (skipping the index-0 sentinel). */
async function readCriticals(redis, scanId) {
  const raw = await redis.lrange(`scan:${scanId}:critical`, 1, -1);
  return raw.map((entry) => JSON.parse(entry));
}

/** Recursively list every entry name under a directory. */
async function walkEntries(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    out.push(entry.name);
    if (entry.isDirectory()) {
      const child = await walkEntries(join(dir, entry.name));
      out.push(...child);
    }
  }
  return out;
}

/**
 * Assert the exact Plan 02 cleanup contract: NEITHER the allocated cloneDir
 * (`repo/`) NOR the report file (`report.json`) survives anywhere under
 * SCAN_TMP_DIR.
 */
async function assertNoScanArtifacts(scanTmpDir) {
  const entries = await walkEntries(scanTmpDir);
  assert.ok(
    !entries.includes('report.json'),
    `report artifact survived cleanup: ${entries.join(', ')}`,
  );
  assert.ok(
    !entries.includes('repo'),
    `clone directory survived cleanup: ${entries.join(', ')}`,
  );
}

/**
 * Fetch JSON from the API, returning `{ status, body }`. Tolerates a non-JSON
 * body (returns `body: null`) so error-path assertions never throw on parse.
 */
async function fetchJson(url, init) {
  const res = await fetch(url, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, contentType: res.headers.get('content-type'), body };
}

/**
 * Provision a disposable Redis + a private SCAN_TMP_DIR, run `fn`, and tear down
 * every disposable resource in a status-preserving `finally` (each teardown step
 * is independent so one failure never skips the others). The `ctx` exposes the
 * Phase 3 `spawnWorker`/`openQueue` PLUS the Plan 04 `spawnApi`/`killRedis`.
 */
async function withHarness(fn) {
  ensureBuilt();
  ensureFixture();
  assertDockerAvailable();

  const redisHandle = startDisposableRedis();
  const scanTmpDir = await mkdtemp(join(tmpdir(), 'api-int-'));
  let redis;
  let worker;
  let api;
  let queue;
  try {
    redis = await connectRedis(redisHandle.port);
    const ctx = {
      port: redisHandle.port,
      scanTmpDir,
      redis,
      spawnWorker: (opts) => {
        worker = spawnWorker({ port: redisHandle.port, scanTmpDir, ...opts });
        return worker;
      },
      spawnApi: async (opts) => {
        api = await spawnApi({ port: redisHandle.port, scanTmpDir, ...opts });
        return api;
      },
      openQueue: () => {
        queue = new Queue('scan', { connection: { host: '127.0.0.1', port: redisHandle.port } });
        return queue;
      },
      killRedis: () => redisHandle.remove(),
    };
    await fn(ctx);
  } finally {
    if (worker) {
      try {
        worker.kill();
      } catch {
        /* preserve prior status */
      }
    }
    if (api) {
      try {
        api.kill();
      } catch {
        /* preserve prior status */
      }
    }
    if (queue) {
      await queue.close().catch(() => undefined);
    }
    if (redis) {
      redis.disconnect();
    }
    redisHandle.remove();
    await rm(scanTmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

test(
  'smoke: compiled API boots against live Redis and GET /health returns 200 {status:ok,redis:up,uptime}',
  { timeout: BUILD_TIMEOUT_MS + 120_000 },
  async () => {
    await withHarness(async (ctx) => {
      const api = await ctx.spawnApi({});
      await api.waitReady(API_READY_TIMEOUT_MS);

      const { status, body } = await fetchJson(`${api.baseUrl}/health`);
      assert.equal(status, 200, 'health returns 200 with live Redis');
      assert.equal(body.status, 'ok', "health body status === 'ok'");
      assert.equal(body.redis, 'up', "health body redis === 'up'");
      assert.equal(typeof body.uptime, 'number', 'health body uptime is a number');
    });
  },
);
