import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Plan 03-04 — machine-readable Docker/Redis/Trivy feasibility probe.
 *
 * Determines whether the CURRENT runner can execute the Docker-backed
 * `scan-engine-integration` gate. It ALWAYS emits a JSON result (stdout + a
 * `scan-engine-feasibility.json` artifact) and, under GitHub Actions, sets the
 * step outputs `feasible=true|false` and `reason=<text>`.
 *
 * Fail-closed posture (never implicit success):
 *   - A cleanly-DETERMINED infeasibility (e.g. no Docker daemon, image pull
 *     blocked, insufficient memory) → `feasible=false` + reason, exit 0. The
 *     always-run contract job passes and the integration job is SKIPPED with a
 *     recorded reason.
 *   - An UNEXPECTED probe error (the probe cannot even complete its checks) →
 *     `feasible=false` + reason, exit 1, so the always-run contract job FAILS
 *     CLOSED rather than treating an unknown state as success.
 */

const TRIVY_IMAGE = 'ghcr.io/aquasecurity/trivy:0.69.3';
const REDIS_IMAGE = 'redis:7-alpine';
/** Minimum total memory to reliably pull the Trivy image + run a scan. */
const MIN_TOTAL_MEM_BYTES = 3 * 1024 * 1024 * 1024;

const RESULT_PATH = fileURLToPath(new URL('../scan-engine-feasibility.json', import.meta.url));

function run(command, args, timeoutMs) {
  return spawnSync(command, args, {
    shell: false,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Emit the result everywhere required, then exit with the given code. */
function finish(result, exitCode) {
  const json = JSON.stringify(result, null, 2);
  process.stdout.write(`${json}\n`);
  try {
    writeFileSync(RESULT_PATH, `${json}\n`);
  } catch {
    /* artifact write is best-effort; the JSON on stdout is authoritative */
  }
  if (process.env.GITHUB_OUTPUT) {
    try {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `feasible=${result.feasible ? 'true' : 'false'}\nreason=${result.reason}\n`,
      );
    } catch {
      /* if we cannot write the output, fail closed below */
    }
  }
  process.exit(exitCode);
}

function determined(result, reason) {
  result.feasible = false;
  result.reason = reason;
  finish(result, 0);
}

function main() {
  const result = {
    feasible: false,
    reason: '',
    checks: {},
    trivyImage: TRIVY_IMAGE,
    node: process.version,
  };

  // 1. Docker daemon reachable.
  const dockerInfo = run('docker', ['info'], 30_000);
  result.checks.dockerInfo = dockerInfo.status === 0;
  if (dockerInfo.status !== 0) {
    determined(result, 'docker daemon not available (docker info failed)');
    return;
  }

  // 2. Sufficient memory for image pull + scan.
  result.checks.totalMemBytes = totalmem();
  result.checks.freeMemBytes = freemem();
  if (totalmem() < MIN_TOTAL_MEM_BYTES) {
    determined(
      result,
      `insufficient memory: ${Math.round(totalmem() / 1e6)}MB total < ${Math.round(MIN_TOTAL_MEM_BYTES / 1e6)}MB required`,
    );
    return;
  }

  // 3. Disposable Redis container can start and be removed.
  const redisRun = run('docker', ['run', '-d', '--rm', '-p', '127.0.0.1:0:6379/tcp', REDIS_IMAGE], 60_000);
  result.checks.redisStart = redisRun.status === 0;
  if (redisRun.status !== 0) {
    determined(result, `disposable Redis container failed to start: ${redisRun.stderr?.trim() ?? ''}`);
    return;
  }
  const redisId = redisRun.stdout.trim();
  const redisRemove = run('docker', ['rm', '-f', redisId], 30_000);
  result.checks.redisRemove = redisRemove.status === 0;

  // 4. Pinned Trivy image is pullable and executable (network/image access).
  const trivyPull = run('docker', ['pull', TRIVY_IMAGE], 300_000);
  result.checks.trivyPull = trivyPull.status === 0;
  if (trivyPull.status !== 0) {
    determined(result, `pinned Trivy image pull blocked: ${trivyPull.stderr?.trim() ?? ''}`);
    return;
  }
  const trivyVersion = run('docker', ['run', '--rm', TRIVY_IMAGE, '--version'], 60_000);
  result.checks.trivyRun = trivyVersion.status === 0;
  if (trivyVersion.status !== 0) {
    determined(result, `pinned Trivy image failed to execute: ${trivyVersion.stderr?.trim() ?? ''}`);
    return;
  }

  result.feasible = true;
  result.reason = 'docker, disposable Redis, pinned Trivy image, and memory prerequisites satisfied';
  finish(result, 0);
}

try {
  main();
} catch (error) {
  // Unknown/unexpected probe error → fail closed (exit 1), never implicit success.
  finish(
    {
      feasible: false,
      reason: `probe error: ${error instanceof Error ? error.message : String(error)}`,
      checks: {},
      trivyImage: TRIVY_IMAGE,
      node: process.version,
    },
    1,
  );
}
