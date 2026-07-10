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
 * Plan 06-03 (T-06-03 / Pitfall 4) — ROUTE-EXCLUSION + SPA-SERVED smoke.
 *
 * `AppModule` serves the built React SPA from `dist/web` at origin root via
 * `ServeStaticModule`, with an `exclude` list that MUST prevent the SPA
 * catch-all from shadowing the four backend route groups. This harness proves
 * BOTH sides EMPIRICALLY against a real `node dist/index.js` process (the exact
 * runtime the reviewer uses), which is the only trustworthy way to confirm the
 * path-to-regexp v8 exclude token (`/api/{*path}`) — RESEARCH Open Question 1:
 *
 *   - GET /                       -> SPA HTML (served from dist/web; `id="root"`)
 *   - GET /health                 -> JSON, NOT the SPA (503 w/o Redis is fine)
 *   - GET /graphiql               -> GraphiQL playground HTML, NOT the SPA
 *   - POST /graphql {__typename}  -> GraphQL JSON, NOT the SPA
 *   - GET /api/scan/<unknown>     -> reaches the scan handler, NOT the SPA
 *
 * It intentionally MIRRORS `selftest-index-boot.mjs`'s Redis-less boot idiom
 * (node:test + assert/strict; allocate-then-release an ephemeral loopback port
 * reused as a CLOSED `REDIS_PORT`; `shell: false` argv; bounded readiness wait;
 * status-preserving `finally` teardown). It is SELF-CONTAINED per the codebase
 * convention that each harness `.mjs` stands alone.
 *
 * NOTE on the `/api/scan/*` route: the scan `get` handler reads Redis, which is
 * deliberately unreachable here, so it may error OR stay pending. Either outcome
 * PROVES non-shadowing — a SPA-shadowed route would return `index.html`
 * INSTANTLY (like GET /). The only failure is a fast response whose body is the
 * SPA HTML. The assertion encodes exactly that.
 */

const API_DIR = fileURLToPath(new URL('../', import.meta.url));
const API_JS = join(API_DIR, 'dist', 'index.js');
const WEB_INDEX = join(API_DIR, 'dist', 'web', 'index.html');
const API_READY_MARKER = 'API HTTP listener ready';

const BUILD_TIMEOUT_MS = 180_000;
const API_READY_TIMEOUT_MS = 60_000;
/** Per-HTTP-request bound; short so a Redis-less hang on /api/scan can't stall. */
const REQUEST_TIMEOUT_MS = 4_000;
const SPA_MARKER = 'id="root"';

/** Build once if the compiled app OR the boot-safe dist/web is absent. */
function ensureBuilt() {
  if (existsSync(API_JS) && existsSync(WEB_INDEX)) return;
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
  assert.ok(existsSync(WEB_INDEX), `expected boot-safe SPA index at ${WEB_INDEX}`);
}

/** A guaranteed-CLOSED loopback port: open on :0, read it, close before return. */
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

/** Spawn `node dist/index.js` with Redis pointed at a CLOSED port. */
function spawnApi({ redisPort, apiPort, scanTmpDir }) {
  const child = spawn(process.execPath, [API_JS], {
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
    kill() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    },
  };
}

/**
 * Bounded HTTP request. Resolves `{ timedOut:false, status, contentType, body }`
 * or `{ timedOut:true }` when the request exceeds REQUEST_TIMEOUT_MS (used to
 * treat a Redis-less handler hang as valid non-shadowing evidence).
 */
async function request(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const body = await res.text();
    return {
      timedOut: false,
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      body,
    };
  } catch (err) {
    if (controller.signal.aborted) return { timedOut: true };
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

test(
  'ServeStaticModule serves the SPA at / while /health, /graphql, /graphiql, /api/scan/* bypass it (T-06-03, Pitfall 4)',
  { timeout: BUILD_TIMEOUT_MS + API_READY_TIMEOUT_MS + 60_000 },
  async () => {
    ensureBuilt();

    const closedRedisPort = await allocatePort();
    const apiPort = await allocatePort();
    const scanTmpDir = await mkdtemp(join(tmpdir(), 'serve-static-smoke-'));
    const base = `http://127.0.0.1:${apiPort}`;

    const api = spawnApi({ redisPort: closedRedisPort, apiPort, scanTmpDir });
    try {
      await api.waitReady(API_READY_TIMEOUT_MS);

      // (1) GET / — the SPA is served from dist/web.
      const root = await request(`${base}/`);
      assert.equal(root.timedOut, false, 'GET / must not time out');
      assert.equal(root.status, 200, `GET / expected 200, got ${root.status}`);
      assert.ok(
        root.body.includes(SPA_MARKER),
        `GET / should serve the SPA HTML (contains ${SPA_MARKER}); got: ${root.body.slice(0, 200)}`,
      );

      // (2) GET /health — reaches the health handler (JSON), NOT the SPA. 503
      // without Redis is expected and acceptable — the point is it is NOT HTML.
      const health = await request(`${base}/health`);
      assert.equal(health.timedOut, false, 'GET /health must not time out (bounded ping)');
      assert.ok(
        !health.body.includes(SPA_MARKER),
        `GET /health must NOT be shadowed by the SPA; got: ${health.body.slice(0, 200)}`,
      );
      const healthJson = JSON.parse(health.body);
      assert.ok(
        typeof healthJson === 'object' && healthJson !== null,
        'GET /health returns a JSON object (health/error body)',
      );

      // (3) GET /graphiql — the GraphiQL playground, NOT the SPA.
      const graphiql = await request(`${base}/graphiql`);
      assert.equal(graphiql.timedOut, false, 'GET /graphiql must not time out');
      assert.equal(graphiql.status, 200, `GET /graphiql expected 200, got ${graphiql.status}`);
      assert.ok(
        graphiql.body.toLowerCase().includes('graphiql'),
        `GET /graphiql should serve the GraphiQL playground; got: ${graphiql.body.slice(0, 200)}`,
      );
      assert.ok(
        !graphiql.body.includes(SPA_MARKER),
        'GET /graphiql must NOT be shadowed by the SPA',
      );

      // (4) POST /graphql — a trivial introspection query reaches Mercurius.
      const gql = await request(`${base}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      assert.equal(gql.timedOut, false, 'POST /graphql must not time out');
      assert.ok(
        !gql.body.includes(SPA_MARKER),
        `POST /graphql must NOT be shadowed by the SPA; got: ${gql.body.slice(0, 200)}`,
      );
      const gqlJson = JSON.parse(gql.body);
      assert.equal(
        gqlJson?.data?.__typename,
        'Query',
        `POST /graphql should return the GraphQL root type; got: ${gql.body.slice(0, 200)}`,
      );

      // (5) GET /api/scan/<unknown> — reaches the scan handler, NOT the SPA.
      // Redis is unreachable, so the handler may error OR stay pending; either
      // way it is NOT the instant SPA static response. Only a fast SPA-HTML
      // body fails.
      const apiScan = await request(`${base}/api/scan/does-not-exist`);
      if (apiScan.timedOut) {
        // Reached the Redis-backed handler (it out-waited the static server,
        // which would have answered instantly) — non-shadowing proven.
      } else {
        assert.ok(
          !apiScan.body.includes(SPA_MARKER),
          `GET /api/scan/* must NOT be shadowed by the SPA; got: ${apiScan.body.slice(0, 200)}`,
        );
        assert.notEqual(
          apiScan.status,
          200,
          'GET /api/scan/<unknown> should not be a 200 SPA page',
        );
      }
    } finally {
      api.kill();
      await rm(scanTmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
);
