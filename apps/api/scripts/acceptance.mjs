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
 * Plan 05-03 — assignment-level ACCEPTANCE harness (criteria #1, #3, richer #5).
 *
 * Proves the whole submission as a single runnable command against the COMPILED
 * application — the real `dist/index.js` API process AND the real `dist/worker.js`
 * worker process — over a disposable `redis:7-alpine` container:
 *
 *   (1) HAPPY PATH        POST /api/scan -> 202 {scanId,Queued}; a worker scan
 *                         reaches Finished, GET returns the two pinned CRITICAL
 *                         CVEs, and clone/report artifacts are cleaned up.
 *   (2) FORCED FAILURE    POST -> 202 -> worker(fault:clone) -> Failed(clone),
 *                         artifacts cleaned up (cleanup-on-failure, criterion #1).
 *   (3) scanId CORRELATION a single scan's API line + worker line share one
 *                         scanId in ndjson stdout (OPS-04, criterion #3).
 *   (4) CRITERION #5      RICHER Docker-path superset of `selftest-index-boot.mjs`
 *                         (index.js + worker.js boot @150) + the 500MB parse @150
 *                         via the reused Phase-2 memtest.
 *
 * The Docker-FREE authoritative criterion-#5a proof is the standalone
 * `selftest-index-boot.mjs`; this harness is the richer Docker-backed superset.
 * Every Docker-requiring case is gated by `isDockerAvailable()` + `t.skip(reason)`
 * (D-12: skip-with-reason, never fail closed on an infeasible runner).
 *
 * SELF-CONTAINED per the codebase convention (no import from
 * `api-integration.mjs`): the proven helper SHAPES are lifted here verbatim
 * (the "Don't Hand-Roll" seam) and given an optional `nodeArgs` affordance so the
 * criterion-#5 case can prepend `--max-old-space-size=150`. Conventions mirror
 * `api-integration.mjs`: `node:test` / `assert`, discrete argv arrays with
 * `shell: false`, finite bounded timeouts, status-preserving `finally` teardown.
 */

const API_DIR = fileURLToPath(new URL('../', import.meta.url));
const API_JS = join(API_DIR, 'dist', 'index.js');
const WORKER_JS = join(API_DIR, 'dist', 'worker.js');
const MEMTEST_JS = join(API_DIR, 'dist', 'scripts', 'memtest.js');
const BUNDLE_GENERATOR = fileURLToPath(
  new URL('../test-fixtures/create-sample-repo-bundle.mjs', import.meta.url),
);
const SAMPLE_BUNDLE = fileURLToPath(
  new URL('../test-fixtures/sample-repo.bundle', import.meta.url),
);

const WORKER_READY_MARKER = 'SCAN_WORKER_READY';
const API_READY_MARKER = 'API HTTP listener ready';
const REDIS_IMAGE = 'redis:7-alpine';
/** The graded heap ceiling prepended to the criterion-#5 boot cases. */
const HEAP_FLAG = '--max-old-space-size=150';

/** Bounded timeouts (finite, status-preserving) for the real process boundary. */
const BUILD_TIMEOUT_MS = 180_000;
const WORKER_READY_TIMEOUT_MS = 60_000;
const API_READY_TIMEOUT_MS = 60_000;
const REDIS_READY_TIMEOUT_MS = 30_000;
/** First Docker Trivy run pulls the image and downloads the vuln DB. */
const SCAN_TERMINAL_TIMEOUT_MS = 300_000;
const FAULT_TERMINAL_TIMEOUT_MS = 60_000;
const STATUS_POLL_INTERVAL_MS = 25;
const FIXTURE_GEN_TIMEOUT_MS = 180_000;
const MEMTEST_TIMEOUT_MS = 300_000;
/** The compiled worker's default SHUTDOWN_GRACE_MS (env.validation.ts). */
const SHUTDOWN_GRACE_MS = 8_000;
const SHUTDOWN_MARGIN_MS = 7_000;

/** The two CRITICAL CVEs the pinned fixture reliably yields, in report order. */
const EXPECTED_CRITICAL_IDS = ['CVE-2019-10744', 'CVE-2021-44906'];

/** A valid GitHub target (the assignment's NodeGoat) used only as an input. */
const VALID_REPO_URL = 'https://github.com/OWASP/NodeGoat';

/**
 * The 500MB+ parse proof size (criterion #5b). Defaults to 512 (the >=500MB
 * value CI runs); a smaller value can be set locally via ACCEPTANCE_MEMPROOF_SIZE_MB.
 */
const MEMPROOF_SIZE_MB = (() => {
  const raw = process.env.ACCEPTANCE_MEMPROOF_SIZE_MB;
  if (raw === undefined || raw.trim() === '') return 512;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 2048 ? n : 512;
})();

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
  assert.ok(existsSync(MEMTEST_JS), `expected compiled memtest at ${MEMTEST_JS}`);
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
    throw new Error('docker is not available; the acceptance harness requires Docker');
  }
}

/** Is Docker usable right now (soft check for the Docker-gated cases)? */
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
  redis.on('error', () => {});
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
 * of DISTINCT statuses the domain record passes through.
 */
function startStatusObserver(port, scanId) {
  const key = `scan:${scanId}`;
  const observed = [];
  let running = true;
  const conn = new Redis({ host: '127.0.0.1', port, maxRetriesPerRequest: null });
  conn.on('error', () => {});
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
 * spawns. (`index.ts` does not echo its chosen port, so the harness picks one.)
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
 * `SCAN_WORKER_READY` bootstrap sentinel, and expose bounded waiters. `nodeArgs`
 * prepends node flags (e.g. the graded `--max-old-space-size=150`).
 */
function spawnWorker({ port, scanTmpDir, fault, readyMarker, nodeEnv, nodeArgs }) {
  const child = spawn(process.execPath, [...(nodeArgs ?? []), WORKER_JS], {
    cwd: API_DIR,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // HIGH-02: the SCAN_ENGINE_TEST_FAULT seam is INERT in production, so a
      // fault-injection case MUST run under a non-production NODE_ENV. The
      // Docker success path stays 'production' and exercises the real adapters.
      NODE_ENV: nodeEnv ?? 'production',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: String(port),
      SCAN_TMP_DIR: scanTmpDir,
      SCAN_ENGINE_TEST_FAULT: fault,
      SCAN_ENGINE_READY_MARKER: readyMarker,
      // CR-01: production defaults to `https` only. This harness clones the
      // committed bundle over git's `file` transport, so it — and ONLY it, as
      // TRUSTED local test infrastructure — widens the allowlist to `https:file`.
      SCAN_GIT_ALLOWED_PROTOCOLS: 'https:file',
    },
  });

  const state = { stdout: '', stderr: '', workerReady: false };
  const readyWaiters = [];
  const exitWaiters = [];
  let exitInfo = null;

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    state.stdout += text;
    if (!state.workerReady && state.stdout.includes(WORKER_READY_MARKER)) {
      state.workerReady = true;
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
 * wait for the `API HTTP listener ready` sentinel, and expose `baseUrl` + bounded
 * waiters. `nodeArgs` prepends node flags (e.g. `--max-old-space-size=150`).
 */
async function spawnApi({ port, scanTmpDir, nodeEnv, nodeArgs }) {
  const apiPort = await allocatePort();
  const child = spawn(process.execPath, [...(nodeArgs ?? []), API_JS], {
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
 * (`repo/`) NOR the report file (`report.json`) survives under SCAN_TMP_DIR.
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
 * body so error-path assertions never throw on parse.
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
 * Parse the ndjson lines of a captured stdout buffer and return true iff at
 * least one JSON line carries a `scanId` field equal to `scanId`.
 */
function streamHasScanId(stdout, scanId) {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed[0] !== '{') continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && parsed.scanId === scanId) return true;
  }
  return false;
}

/**
 * Provision a disposable Redis + a private SCAN_TMP_DIR, run `fn`, and tear down
 * every disposable resource in a status-preserving `finally`.
 */
async function withHarness(fn) {
  ensureBuilt();
  ensureFixture();
  assertDockerAvailable();

  const redisHandle = startDisposableRedis();
  const scanTmpDir = await mkdtemp(join(tmpdir(), 'acceptance-'));
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

/* ------------------------------------------------------------------------- *
 * (1) HAPPY PATH — POST -> 202 Queued (REST enqueue) AND a real Trivy scan of
 * the committed bundle reaches Finished -> GET returns the two pinned CRITICAL
 * CVEs -> cleanup-on-success. Docker-gated (disposable Redis + Trivy image).
 * ------------------------------------------------------------------------- */
test(
  'criterion #1 (happy): POST -> 202 Queued, then a real scan reaches Finished with the two pinned CRITICAL CVEs and artifacts are cleaned up',
  { timeout: SCAN_TERMINAL_TIMEOUT_MS + BUILD_TIMEOUT_MS + 120_000 },
  async (t) => {
    if (!isDockerAvailable()) {
      t.skip('Docker unavailable — skipping the disposable-Redis + real-Trivy happy path (D-12)');
      return;
    }
    await withHarness(async (ctx) => {
      const api = await ctx.spawnApi({});
      await api.waitReady(API_READY_TIMEOUT_MS);

      // (a) REST enqueue half: POST a valid GitHub URL -> 202 {scanId,Queued}.
      const submit = await fetchJson(`${api.baseUrl}/api/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoUrl: VALID_REPO_URL }),
      });
      assert.equal(submit.status, 202, 'valid submit returns HTTP 202');
      assert.equal(typeof submit.body.scanId, 'string');
      assert.ok(submit.body.scanId.length > 0, 'scanId is a non-empty string');
      assert.equal(submit.body.status, 'Queued');
      assert.deepEqual(
        Object.keys(submit.body).sort(),
        ['scanId', 'status'],
        'enqueue body is exactly {scanId, status}',
      );
      assert.equal(await ctx.redis.hget(`scan:${submit.body.scanId}`, 'status'), 'Queued');

      // (b) scan -> CRITICAL half: seed the committed bundle Queued and run a real
      // worker + pinned Trivy to Finished (the bundle is not an https GitHub URL,
      // so it is seeded directly; the API enqueue path is proven by half (a)).
      const scanId = randomUUID();
      await seedQueued(ctx.redis, scanId, SAMPLE_BUNDLE);
      const worker = ctx.spawnWorker({ fault: 'none', readyMarker: 'log', nodeEnv: 'production' });
      await worker.waitReady(WORKER_READY_TIMEOUT_MS);
      await ctx.openQueue().add('scan', { scanId, repoUrl: SAMPLE_BUNDLE });

      const terminal = await waitTerminal(ctx.redis, scanId, SCAN_TERMINAL_TIMEOUT_MS);
      assert.equal(terminal, 'Finished', 'a findings scan is a SUCCESS, not a failure');

      const res = await fetchJson(`${api.baseUrl}/api/scan/${scanId}`);
      assert.equal(res.status, 200, 'Finished GET returns 200');
      assert.equal(res.body.status, 'Finished');
      assert.ok(Array.isArray(res.body.criticalVulnerabilities), 'criticalVulnerabilities is an array');
      assert.deepEqual(
        res.body.criticalVulnerabilities.map((v) => v.vulnerabilityId),
        EXPECTED_CRITICAL_IDS,
        'the two pinned CVEs in report order',
      );
      for (const v of res.body.criticalVulnerabilities) {
        assert.equal(v.severity, 'CRITICAL');
      }

      // criterion #1 cleanup-on-SUCCESS: neither repo/ nor report.json survives.
      await assertNoScanArtifacts(ctx.scanTmpDir);
    });
  },
);

/* ------------------------------------------------------------------------- *
 * (2) FORCED FAILURE — POST -> 202 -> worker(fault:clone, NODE_ENV=test) ->
 * Failed(clone) via GET -> cleanup-on-FAILURE. Deterministic / no network.
 * Docker-gated only for the disposable Redis.
 * ------------------------------------------------------------------------- */
test(
  'criterion #1 (forced failure): POST -> 202 -> Failed(clone) via GET, artifacts cleaned up after failure',
  { timeout: FAULT_TERMINAL_TIMEOUT_MS + BUILD_TIMEOUT_MS + 120_000 },
  async (t) => {
    if (!isDockerAvailable()) {
      t.skip('Docker unavailable — skipping the disposable-Redis forced-failure path (D-12)');
      return;
    }
    await withHarness(async (ctx) => {
      const api = await ctx.spawnApi({});
      await api.waitReady(API_READY_TIMEOUT_MS);

      const submit = await fetchJson(`${api.baseUrl}/api/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoUrl: VALID_REPO_URL }),
      });
      assert.equal(submit.status, 202);
      assert.equal(submit.body.status, 'Queued');
      const scanId = submit.body.scanId;
      assert.ok(typeof scanId === 'string' && scanId.length > 0);

      const observer = startStatusObserver(ctx.port, scanId);
      const worker = ctx.spawnWorker({ fault: 'clone', readyMarker: 'none', nodeEnv: 'test' });
      try {
        await worker.waitReady(WORKER_READY_TIMEOUT_MS);
        const deadline = Date.now() + FAULT_TERMINAL_TIMEOUT_MS;
        let poll;
        for (;;) {
          poll = await fetchJson(`${api.baseUrl}/api/scan/${scanId}`);
          if (poll.status === 200 && poll.body.status === 'Failed') break;
          if (Date.now() > deadline) {
            throw new Error(`scan did not reach Failed via GET (last: ${JSON.stringify(poll.body)})`);
          }
          await sleep(100);
        }

        assert.equal(poll.body.status, 'Failed');
        assert.equal(poll.body.error.category, 'clone', 'failure category is clone');
        assert.equal(typeof poll.body.error.detail, 'string');
        assert.ok(
          poll.body.error.detail.length > 0 && poll.body.error.detail.length <= 500,
          'error detail is bounded (1..500 chars)',
        );

        await observer.stop();
        assert.deepEqual(
          observer.observed,
          ['Queued', 'Scanning', 'Failed'],
          `unexpected lifecycle: ${observer.observed.join(' -> ')}`,
        );
      } finally {
        await observer.stop().catch(() => undefined);
      }

      // criterion #1 cleanup-on-FAILURE: neither repo/ nor report.json survives.
      await assertNoScanArtifacts(ctx.scanTmpDir);
    });
  },
);

/* ------------------------------------------------------------------------- *
 * (3) scanId CORRELATION (OPS-04, criterion #3) — a single scan's API ndjson
 * line AND worker ndjson line both carry the same scanId, so the lifecycle is
 * reconstructable across the two processes. Uses the deterministic clone-fault
 * path (no network) so the worker still emits its scanId'd lifecycle line.
 * ------------------------------------------------------------------------- */
test(
  'criterion #3 (correlation): the API enqueue line and a worker lifecycle line share the same scanId across processes',
  { timeout: FAULT_TERMINAL_TIMEOUT_MS + BUILD_TIMEOUT_MS + 120_000 },
  async (t) => {
    if (!isDockerAvailable()) {
      t.skip('Docker unavailable — skipping the cross-process scanId correlation (D-12)');
      return;
    }
    await withHarness(async (ctx) => {
      const api = await ctx.spawnApi({});
      await api.waitReady(API_READY_TIMEOUT_MS);

      const submit = await fetchJson(`${api.baseUrl}/api/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoUrl: VALID_REPO_URL }),
      });
      assert.equal(submit.status, 202);
      const scanId = submit.body.scanId;
      assert.ok(typeof scanId === 'string' && scanId.length > 0);

      const worker = ctx.spawnWorker({ fault: 'clone', readyMarker: 'none', nodeEnv: 'test' });
      await worker.waitReady(WORKER_READY_TIMEOUT_MS);

      // Drive the scan to a terminal state so the worker has emitted its lifecycle
      // lines, then let stdout flush before parsing the ndjson.
      const deadline = Date.now() + FAULT_TERMINAL_TIMEOUT_MS;
      for (;;) {
        const poll = await fetchJson(`${api.baseUrl}/api/scan/${scanId}`);
        if (poll.status === 200 && poll.body.status === 'Failed') break;
        if (Date.now() > deadline) {
          throw new Error('scan did not reach Failed while waiting to correlate logs');
        }
        await sleep(100);
      }
      await sleep(250);

      assert.ok(
        streamHasScanId(api.state.stdout, scanId),
        `expected an API ndjson line carrying scanId=${scanId}; stdout was:\n${api.state.stdout}`,
      );
      assert.ok(
        streamHasScanId(worker.state.stdout, scanId),
        `expected a worker ndjson line carrying scanId=${scanId}; stdout was:\n${worker.state.stdout}`,
      );
    });
  },
);

/* ------------------------------------------------------------------------- *
 * (4a/4a') CRITERION #5 (richer Docker-path superset) — boot BOTH compiled
 * entrypoints under the graded `--max-old-space-size=150` flag over the real
 * disposable infra and assert clean readiness (no OOM/non-zero exit). The
 * authoritative Docker-FREE #5a proof is the standalone selftest-index-boot.mjs.
 * ------------------------------------------------------------------------- */
test(
  'criterion #5 (Docker-path superset): dist/index.js and dist/worker.js both boot clean under --max-old-space-size=150',
  { timeout: BUILD_TIMEOUT_MS + WORKER_READY_TIMEOUT_MS + API_READY_TIMEOUT_MS + 120_000 },
  async (t) => {
    if (!isDockerAvailable()) {
      t.skip('Docker unavailable — skipping the Docker-path criterion-#5 superset (D-12)');
      return;
    }
    await withHarness(async (ctx) => {
      const api = await ctx.spawnApi({ nodeArgs: [HEAP_FLAG] });
      await api.waitReady(API_READY_TIMEOUT_MS);
      assert.equal(api.child.exitCode, null, 'API @150 still running at readiness (no crash/OOM)');
      assert.equal(api.child.signalCode, null, 'API @150 not signalled at readiness');

      const worker = ctx.spawnWorker({
        fault: 'none',
        readyMarker: 'none',
        nodeEnv: 'production',
        nodeArgs: [HEAP_FLAG],
      });
      await worker.waitReady(WORKER_READY_TIMEOUT_MS);
      assert.equal(worker.child.exitCode, null, 'worker @150 still running at readiness (no crash/OOM)');
      assert.equal(worker.child.signalCode, null, 'worker @150 not signalled at readiness');
    });
  },
);

/* ------------------------------------------------------------------------- *
 * (4b) CRITERION #5b — the 500MB+ parse survives under --max-old-space-size=150
 * via the reused Phase-2 memtest (Docker-FREE; the memory.yml Node-22 gate is
 * the always-required CI owner of this proof — this is the acceptance echo).
 * ------------------------------------------------------------------------- */
test(
  'criterion #5b: the reused memtest parses a >=500MB fixture under --max-old-space-size=150 and exits 0',
  { timeout: BUILD_TIMEOUT_MS + FIXTURE_GEN_TIMEOUT_MS + MEMTEST_TIMEOUT_MS + 60_000 },
  async () => {
    ensureBuilt();
    const fixtureDir = await mkdtemp(join(tmpdir(), 'acceptance-memproof-'));
    const fixturePath = join(fixtureDir, 'report.json');
    try {
      const gen = spawnSync(
        'npm',
        ['run', 'gen:fixture', '--', '--size-mb', String(MEMPROOF_SIZE_MB), '--output', fixturePath],
        { cwd: API_DIR, shell: false, encoding: 'utf8', timeout: FIXTURE_GEN_TIMEOUT_MS },
      );
      assert.equal(gen.status, 0, `fixture generation failed: ${gen.stderr ?? ''}`);
      const generatedBytes = statSync(fixturePath).size;
      assert.ok(
        generatedBytes >= MEMPROOF_SIZE_MB * 1024 * 1024,
        `fixture is ${generatedBytes} bytes, expected >= ${MEMPROOF_SIZE_MB}MB`,
      );

      const memtest = spawnSync(process.execPath, [HEAP_FLAG, MEMTEST_JS, fixturePath], {
        cwd: API_DIR,
        shell: false,
        encoding: 'utf8',
        timeout: MEMTEST_TIMEOUT_MS,
      });
      assert.equal(
        memtest.status,
        0,
        `memtest did not exit 0 under ${HEAP_FLAG}: ${memtest.stderr ?? ''}`,
      );
      // The memtest prints a JSON metrics line (peak RSS/heapUsed) on success.
      assert.match(memtest.stdout, /peakRssMb/, 'memtest emitted its peak-RSS metrics');
    } finally {
      await rm(fixtureDir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
);
