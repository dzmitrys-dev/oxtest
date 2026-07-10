import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Plan 05-03 — compose-driven in-container OOM proof (criterion #2).
 *
 * Proves the memory-critical worker survives the LARGEST fixture under the
 * graded constraint — `mem_limit: 200m` (docker `--memory=200m`) +
 * `--max-old-space-size=150` — by running the compiled `dist/scripts/memtest.js`
 * (the Phase-2 streaming parser proof, reused verbatim per D-10) inside a
 * ONE-SHOT worker container built from the Plan-02 image, then asserting
 *
 *     docker inspect --format '{{.State.OOMKilled}} {{.State.ExitCode}}'  ==  "false 0"
 *
 * BOTH conditions are required. Asserting `OOMKilled == false` ALONE is a
 * false-negative trap (Pitfall 2): a process can exit 137 (SIGKILL) with
 * `OOMKilled:false` under some cgroup/runtime combinations, so exit-0 is the
 * co-requisite that closes the gap.
 *
 * Feasibility-gated (D-12), mirroring `scan-engine-feasibility.mjs`:
 *   - cleanly-DETERMINED infeasibility (no docker / no compose) -> feasible:false,
 *     exit 0 (skip-with-reason, never fail closed on an infeasible runner);
 *   - an UNEXPECTED error (checks could not complete) -> exit 1 (fail closed).
 *
 * Conventions mirror the in-repo harnesses: discrete argv arrays with
 * `shell: false`, finite bounded timeouts, and a status-preserving teardown.
 */

const API_DIR = fileURLToPath(new URL('../', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const COMPOSE_FILE = join(REPO_ROOT, 'docker-compose.yml');

/** The image the compose `worker` service builds/tags (docker-compose.yml). */
const WORKER_IMAGE = 'code-guardian-app:latest';
/** Where the compiled memtest lives inside the runtime image (working_dir /app/apps/api). */
const CONTAINER_WORKDIR = '/app/apps/api';
const CONTAINER_MEMTEST = 'dist/scripts/memtest.js';
const CONTAINER_FIXTURE = '/fixtures/report.json';

/** The graded constraints. */
const MEMORY_LIMIT = '200m';
const HEAP_FLAG = '--max-old-space-size=150';
/** The >=500MB largest-fixture proof size (criterion #2). */
const FIXTURE_SIZE_MB = 512;

/** Bounded, status-preserving timeouts. */
const PROBE_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 600_000;
const FIXTURE_GEN_TIMEOUT_MS = 180_000;
const RUN_TIMEOUT_MS = 300_000;
const INSPECT_TIMEOUT_MS = 30_000;

function run(command, args, { cwd, timeout } = {}) {
  return spawnSync(command, args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    timeout: timeout ?? PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Emit the machine-readable result on stdout, then exit with the given code. */
function finish(result, exitCode) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(exitCode);
}

/** Cleanly-determined infeasibility: skip-with-reason, exit 0 (never fail closed). */
function determinedInfeasible(reason) {
  finish({ feasible: false, reason }, 0);
}

function main() {
  // 1. Feasibility preflight — Docker daemon + `docker compose` plugin.
  const dockerInfo = run('docker', ['info']);
  if (dockerInfo.status !== 0) {
    determinedInfeasible('docker daemon not available (docker info failed)');
    return;
  }
  const composeVersion = run('docker', ['compose', 'version']);
  if (composeVersion.status !== 0) {
    determinedInfeasible('docker compose plugin not available (docker compose version failed)');
    return;
  }

  const containerName = `code-guardian-oom-${process.pid}-${randomUUID().slice(0, 8)}`;
  const fixtureDir = mkdtempSync(join(tmpdir(), 'oom-proof-'));
  const fixturePath = join(fixtureDir, 'report.json');
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    run('docker', ['rm', '-f', containerName], { timeout: INSPECT_TIMEOUT_MS });
    rmSync(fixtureDir, { recursive: true, force: true });
  };

  try {
    // 2. Build the worker image via compose (reuse the Plan-02 image).
    const build = run('docker', ['compose', '-f', COMPOSE_FILE, 'build', 'worker'], {
      cwd: REPO_ROOT,
      timeout: BUILD_TIMEOUT_MS,
    });
    if (build.status !== 0) {
      throw new Error(`docker compose build worker failed: ${build.stderr?.trim() ?? ''}`);
    }

    // 3. Generate the >=500MB fixture on the host.
    const gen = run(
      'npm',
      ['run', 'gen:fixture', '--', '--size-mb', String(FIXTURE_SIZE_MB), '--output', fixturePath],
      { cwd: API_DIR, timeout: FIXTURE_GEN_TIMEOUT_MS },
    );
    if (gen.status !== 0) {
      throw new Error(`fixture generation failed: ${gen.stderr?.trim() ?? ''}`);
    }
    const fixtureBytes = statSync(fixturePath).size;
    if (fixtureBytes < FIXTURE_SIZE_MB * 1024 * 1024) {
      throw new Error(`fixture is ${fixtureBytes} bytes, expected >= ${FIXTURE_SIZE_MB}MB`);
    }
    // Parse the generator's last JSON line for the exact CRITICAL count, so the
    // in-container memtest asserts a FULL stream parse (not an early bail-out).
    let expectedCritical;
    try {
      const lastLine = gen.stdout.trim().split('\n').at(-1) ?? '{}';
      const parsed = JSON.parse(lastLine);
      if (Number.isInteger(parsed.criticalVulnerabilities) && parsed.criticalVulnerabilities > 0) {
        expectedCritical = String(parsed.criticalVulnerabilities);
      }
    } catch {
      /* fall back to the memtest's default minimum (>=1) if unparseable */
    }

    // 4. Run a ONE-SHOT worker container under the graded constraint. The host
    // fixture is bind-mounted read-only; the entrypoint is node + the heap flag.
    const runArgs = [
      'run',
      '--name',
      containerName,
      `--memory=${MEMORY_LIMIT}`,
      '--entrypoint',
      'node',
      '-w',
      CONTAINER_WORKDIR,
      '-v',
      `${fixturePath}:${CONTAINER_FIXTURE}:ro`,
    ];
    if (expectedCritical !== undefined) {
      runArgs.push('-e', `MEMTEST_EXPECTED_CRITICAL_COUNT=${expectedCritical}`);
    }
    runArgs.push(WORKER_IMAGE, HEAP_FLAG, CONTAINER_MEMTEST, CONTAINER_FIXTURE);
    const containerRun = run('docker', runArgs, { timeout: RUN_TIMEOUT_MS });

    // 5. Inspect BOTH OOMKilled AND ExitCode — the Pitfall-2 false-negative guard.
    const inspect = run(
      'docker',
      ['inspect', '--format', '{{.State.OOMKilled}} {{.State.ExitCode}}', containerName],
      { timeout: INSPECT_TIMEOUT_MS },
    );
    if (inspect.status !== 0) {
      throw new Error(`docker inspect failed: ${inspect.stderr?.trim() ?? ''}`);
    }
    const inspectOut = inspect.stdout.trim();
    const [oomKilled, exitCodeRaw] = inspectOut.split(/\s+/);
    const exitCode = Number(exitCodeRaw);

    // 6. Surface the memtest metrics (peak RSS/heapUsed) from the container stdout.
    let metrics = null;
    for (const line of (containerRun.stdout ?? '').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{') && trimmed.includes('peakRssMb')) {
        try {
          metrics = JSON.parse(trimmed);
        } catch {
          /* leave metrics null if the line is not clean JSON */
        }
      }
    }

    const survived = oomKilled === 'false' && exitCode === 0;
    const result = {
      feasible: true,
      survived,
      oomKilled,
      exitCode,
      inspect: inspectOut,
      memoryLimit: MEMORY_LIMIT,
      heapFlag: HEAP_FLAG,
      fixtureSizeMb: FIXTURE_SIZE_MB,
      fixtureBytes,
      metrics,
    };

    if (!survived) {
      // A real memory regression — fail closed with the container diagnostics.
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.stderr.write(
        `OOM proof FAILED: expected "false 0" from docker inspect, got "${inspectOut}"\n` +
          `container stderr:\n${containerRun.stderr ?? ''}\n`,
      );
      cleanup();
      process.exit(1);
    }

    cleanup();
    finish(result, 0);
  } catch (error) {
    cleanup();
    throw error;
  }
}

try {
  main();
} catch (error) {
  // Unexpected error (checks could not complete) -> fail closed (exit 1).
  finish(
    {
      feasible: false,
      reason: `oom-proof error: ${error instanceof Error ? error.message : String(error)}`,
    },
    1,
  );
}
