import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type { TrivyRunner, TrivyRunOptions } from './trivy-runner.port';
import {
  createSpawnSubprocessRunner,
  SubprocessRunError,
  type SubprocessRunner,
} from './subprocess-runner';

/**
 * Pinned, reviewed official Trivy image (D-13). NEVER `:latest` — a floating
 * tag would break the supply-chain-scanner's own reproducibility guarantee.
 */
export const TRIVY_DOCKER_IMAGE = 'aquasecurity/trivy:0.69.3';

/** Container mount points for the Docker fallback (D-16). */
const CONTAINER_SRC = '/src';
const CONTAINER_OUT = '/out';
/** Ephemeral in-container cache — tmpfs so it is discarded with `--rm` (D-17). */
const CONTAINER_CACHE = '/root/.cache/trivy';

export interface TrivyRunnerOptions {
  /** Local binary name/path (defaults to `trivy` on PATH). */
  localCommand?: string;
  /** Docker executable name/path (defaults to `docker` on PATH). */
  dockerCommand?: string;
  /** Overridable only for tests; production always uses the pinned image. */
  dockerImage?: string;
  runner?: SubprocessRunner;
  stat?: (reportPath: string) => Promise<void>;
}

/**
 * Runs Trivy against a cloned repository, writing a JSON report to the exact
 * allocator-owned `reportPath` on disk. Local binary is preferred; Docker is
 * used ONLY when the local binary cannot launch (missing/uninstallable), never
 * after a genuine scan execution failure (D-14). Report bytes are never
 * buffered — `--output` writes to disk and stdout is discarded (T-03-06).
 *
 * Findings are a success: `--exit-code 0` prevents vulnerabilities from being
 * misclassified as a tool failure (ERR-01).
 */
export class TrivyRunnerAdapter implements TrivyRunner {
  private readonly localCommand: string;
  private readonly dockerCommand: string;
  private readonly dockerImage: string;
  private readonly runner: SubprocessRunner;
  private readonly statReport: (reportPath: string) => Promise<void>;

  constructor(options: TrivyRunnerOptions = {}) {
    this.localCommand = options.localCommand ?? 'trivy';
    this.dockerCommand = options.dockerCommand ?? 'docker';
    this.dockerImage = options.dockerImage ?? TRIVY_DOCKER_IMAGE;
    this.runner = options.runner ?? createSpawnSubprocessRunner();
    this.statReport =
      options.stat ??
      (async (reportPath: string): Promise<void> => {
        await stat(reportPath);
      });
  }

  async run(
    cloneDir: string,
    reportPath: string,
    options?: TrivyRunOptions,
  ): Promise<void> {
    await this.execute(cloneDir, reportPath);

    // Report readiness is the LAST adapter action: stat-validate the exact host
    // report path first, then hand the SAME path to the readiness callback.
    await this.statReport(reportPath);
    if (options?.onReportReady) {
      await options.onReportReady(reportPath);
    }
  }

  private async execute(cloneDir: string, reportPath: string): Promise<void> {
    try {
      await this.runner.run(
        this.localCommand,
        this.buildLocalArgs(cloneDir, reportPath),
        { shell: false },
      );
    } catch (error) {
      // Fall back to Docker ONLY for a local launch/infrastructure failure.
      // A genuine non-zero scan execution error is rethrown, never re-run.
      if (error instanceof SubprocessRunError && error.launchFailed) {
        await this.runner.run(
          this.dockerCommand,
          this.buildDockerArgs(cloneDir, reportPath),
          { shell: false },
        );
        return;
      }
      throw error;
    }
  }

  private buildLocalArgs(cloneDir: string, reportPath: string): string[] {
    return [
      'filesystem',
      '--format',
      'json',
      '--output',
      reportPath,
      '--no-progress',
      '--exit-code',
      '0',
      cloneDir,
    ];
  }

  private buildDockerArgs(cloneDir: string, reportPath: string): string[] {
    const reportParent = dirname(reportPath);
    const reportFile = basename(reportPath);
    return [
      'run',
      '--rm',
      // Ephemeral per-scan cache: tmpfs discarded when the container exits.
      '--mount',
      `type=tmpfs,destination=${CONTAINER_CACHE}`,
      // Read-only clone mount; writable report-parent mount.
      '-v',
      `${cloneDir}:${CONTAINER_SRC}:ro`,
      '-v',
      `${reportParent}:${CONTAINER_OUT}`,
      this.dockerImage,
      'filesystem',
      '--format',
      'json',
      '--output',
      `${CONTAINER_OUT}/${reportFile}`,
      '--no-progress',
      '--exit-code',
      '0',
      CONTAINER_SRC,
    ];
  }
}
