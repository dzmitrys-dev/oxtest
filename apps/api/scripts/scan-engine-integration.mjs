import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * Plan 03-04 — end-to-end scan-engine integration harness.
 *
 * Proves the REAL compiled `dist/worker.js` process across its true boundaries:
 * it consumes a typed BullMQ job from a disposable Redis container, clones the
 * committed `sample-repo.bundle` fixture with the exact
 * `git clone --depth 1 <bundle> <destination>` contract, runs the pinned Docker
 * Trivy image (the launch-failure fallback path, exercised because no local
 * `trivy` binary is present in the assignment/CI environments), stream-parses
 * the real Trivy JSON, and stores ordered CRITICAL results in Redis.
 *
 * Task 1 (this section) owns fixture setup, the disposable-Redis lifecycle, the
 * compiled-worker spawn, and the final no-artifacts cleanup assertion, plus the
 * headline success path (Queued → Scanning → Finished with ordered CRITICALs).
 * Task 2 extends the SUCCESS-path scaffolding below with deterministic
 * fault-injection cases through the Plan 03 `SCAN_ENGINE_TEST_FAULT` seam.
 *
 * Conventions mirror the Phase 2 `memory-process-contract.test.mjs`: `node:test`
 * / `assert`, discrete argv arrays with `shell: false`, bounded timeouts, and
 * status-preserving `finally` cleanup of every disposable resource.
 */

const API_DIR = fileURLToPath(new URL('../', import.meta.url));
const WORKER_JS = join(API_DIR, 'dist', 'worker.js');
const BUNDLE_GENERATOR = fileURLToPath(
  new URL('../test-fixtures/create-sample-repo-bundle.mjs', import.meta.url),
);
const SAMPLE_BUNDLE = fileURLToPath(
  new URL('../test-fixtures/sample-repo.bundle', import.meta.url),
);

const WORKER_READY_MARKER = 'SCAN_WORKER_READY';
const REPORT_READY_PREFIX = 'REPORT_READY ';
const REDIS_IMAGE = 'redis:7-alpine';

/** Bounded timeouts (finite, status-preserving) for the real process boundary. */
const BUILD_TIMEOUT_MS = 180_000;
const WORKER_READY_TIMEOUT_MS = 60_000;
const REDIS_READY_TIMEOUT_MS = 30_000;
/** First Docker Trivy run pulls the image and downloads the vuln DB. */
const SCAN_TERMINAL_TIMEOUT_MS = 300_000;
const FAULT_TERMINAL_TIMEOUT_MS = 60_000;
const STATUS_POLL_INTERVAL_MS = 25;

/** The two CRITICAL CVEs the pinned fixture reliably yields, in report order. */
const EXPECTED_CRITICAL_IDS = ['CVE-2019-10744', 'CVE-2021-44906'];

/** Seven-day retention floor (allow a small margin below 604800). */
const MIN_TTL_SECONDS = 600_000;

let built = false;

/** Build the compiled worker once per harness process (self-contained gate). */
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

/** Preflight: Docker must be usable or the integration cannot run at all. */
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
 * the brief `Scanning` window even on instantaneous fault paths (proven against
 * the fault seam), because each worker transition is a Redis round-trip.
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
 * Spawn the compiled worker with a validated argv array and env, wait for the
 * independent `SCAN_WORKER_READY` bootstrap sentinel (NEVER conflated with the
 * report-readiness marker), and capture the first `REPORT_READY <path>` line.
 */
function spawnWorker({ port, scanTmpDir, fault, readyMarker }) {
  const child = spawn(process.execPath, [WORKER_JS], {
    cwd: API_DIR,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: String(port),
      SCAN_TMP_DIR: scanTmpDir,
      SCAN_ENGINE_TEST_FAULT: fault,
      SCAN_ENGINE_READY_MARKER: readyMarker,
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
          // Observe the report the instant the worker announces it: stat on the
          // host BEFORE any parser/cleanup could remove it, and record whether a
          // terminal state has already been seen (it must NOT have).
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

/** Read the persisted structured failure reason, if any. */
async function readFailureReason(redis, scanId) {
  const raw = await redis.hget(`scan:${scanId}`, 'error');
  return raw ? JSON.parse(raw) : null;
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
 * SCAN_TMP_DIR. The allocator's empty base/`out` directory shells are outside
 * the cleaner's ownership and are permitted to remain.
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
 * Provision a disposable Redis + a private SCAN_TMP_DIR, run `fn`, and tear down
 * every disposable resource in a status-preserving `finally` (each teardown step
 * is independent so one failure never skips the others).
 */
async function withHarness(fn) {
  ensureBuilt();
  ensureFixture();
  assertDockerAvailable();

  const redisHandle = startDisposableRedis();
  const scanTmpDir = await mkdtemp(join(tmpdir(), 'scan-engine-int-'));
  let redis;
  let worker;
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
      openQueue: () => {
        queue = new Queue('scan', { connection: { host: '127.0.0.1', port: redisHandle.port } });
        return queue;
      },
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
  'success: compiled worker clones the bundle, runs Docker Trivy, and stores ordered CRITICALs',
  { timeout: SCAN_TERMINAL_TIMEOUT_MS + 120_000 },
  async () => {
    await withHarness(async (ctx) => {
      const scanId = randomUUID();
      // Prove the allocator has not created anything yet: SCAN_TMP_DIR is empty
      // before any subprocess runs (allocation happens inside the worker run).
      assert.deepEqual(await readdir(ctx.scanTmpDir), []);

      await seedQueued(ctx.redis, scanId, SAMPLE_BUNDLE);
      assert.equal(await ctx.redis.hget(`scan:${scanId}`, 'status'), 'Queued');

      const observer = startStatusObserver(ctx.port, scanId);
      const worker = ctx.spawnWorker({ fault: 'none', readyMarker: 'log' });
      try {
        await worker.waitReady(WORKER_READY_TIMEOUT_MS);

        const queue = ctx.openQueue();
        const job = await queue.add('scan', { scanId, repoUrl: SAMPLE_BUNDLE });

        // The report-readiness event MUST arrive (host stat succeeds) before any
        // terminal state and before cleanup — it is the distinct REPORT_READY
        // marker, never the SCAN_WORKER_READY bootstrap sentinel.
        const report = await worker.waitReport(SCAN_TERMINAL_TIMEOUT_MS);
        assert.ok(report, 'expected a REPORT_READY event');
        assert.equal(report.existedAtEvent, true, 'report file must exist at event time');
        assert.ok(
          report.reportPath.startsWith(ctx.scanTmpDir),
          'report path must be confined under SCAN_TMP_DIR',
        );
        assert.ok(
          report.reportPath.endsWith('/out/report.json'),
          'report path must be the allocator-owned report.json',
        );

        const terminal = await waitTerminal(ctx.redis, scanId, SCAN_TERMINAL_TIMEOUT_MS);
        assert.equal(terminal, 'Finished', 'a findings scan is a SUCCESS, not a failure');

        assert.equal(await job.getState(), 'completed', 'BullMQ job completed');

        await observer.stop();
        // Exact lifecycle progression, independent of BullMQ job state.
        assert.deepEqual(
          observer.observed,
          ['Queued', 'Scanning', 'Finished'],
          `unexpected lifecycle: ${observer.observed.join(' -> ')}`,
        );

        // Ordered CRITICAL results, exactly the two pinned CVEs in report order.
        const criticals = await readCriticals(ctx.redis, scanId);
        assert.equal(criticals.length, 2, 'expected exactly two CRITICAL findings');
        assert.deepEqual(
          criticals.map((v) => v.vulnerabilityId),
          EXPECTED_CRITICAL_IDS,
          'CRITICAL results must be stored in discovery (report) order',
        );
        for (const v of criticals) {
          assert.equal(v.severity, 'CRITICAL');
          assert.equal(typeof v.title, 'string');
          assert.equal(typeof v.primaryUrl, 'string');
        }

        // Seven-day TTL is refreshed on both keys.
        assert.ok((await ctx.redis.ttl(`scan:${scanId}`)) >= MIN_TTL_SECONDS);
        assert.ok((await ctx.redis.ttl(`scan:${scanId}:critical`)) >= MIN_TTL_SECONDS);

        // No clone/report artifact survives on the success path.
        await assertNoScanArtifacts(ctx.scanTmpDir);
      } finally {
        await observer.stop().catch(() => undefined);
      }
    });
  },
);
