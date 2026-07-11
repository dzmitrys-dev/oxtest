import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';

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
export const TRIVY_DOCKER_IMAGE = 'ghcr.io/aquasecurity/trivy:0.69.3';

/**
 * Wall-clock budget for a Trivy run (HIGH-01). Larger than the clone default
 * because the FIRST Docker run legitimately pulls the pinned image and
 * downloads the vulnerability DB before scanning; the ceiling exists only to
 * guarantee the concurrency-one worker eventually recovers from a hung run.
 */
export const DEFAULT_TRIVY_TIMEOUT_MS = 600_000;

/** Ephemeral in-container cache — tmpfs so it is discarded with `--rm` (D-17). */
const CONTAINER_CACHE = '/root/.cache/trivy';

/**
 * Resolve THIS worker container's id for `docker run --volumes-from <self>`.
 *
 * The worker invokes the sibling Trivy container through the mounted HOST
 * docker socket (DooD), so any `-v <src>:<dst>` it passes has `<src>` resolved
 * on the HOST filesystem — never the worker's own overlay. The scan workdir
 * therefore MUST be a real Docker volume propagated into the sibling via
 * `--volumes-from`, which mounts it at the SAME absolute path the worker uses
 * (06-UAT: sibling-container namespace mismatch → ENOENT + host litter).
 *
 * `HOSTNAME` is the short container id under docker/compose (we set neither
 * `hostname:` nor `container_name:` on the worker service). Fall back to
 * parsing `/proc/self/mountinfo` for cgroup-v2 hosts where `HOSTNAME` may be
 * overridden or where a custom hostname was injected.
 */
export function resolveSelfContainerRef(
  env: NodeJS.ProcessEnv = process.env,
  readContainerId: () => string | undefined = readContainerIdFromMountInfo,
): string {
  const hostname = env.HOSTNAME;
  if (hostname && /^[0-9a-f]{12,64}$/i.test(hostname)) {
    return hostname;
  }
  const fromMountInfo = readContainerId();
  if (fromMountInfo) {
    return fromMountInfo;
  }
  if (hostname) {
    return hostname;
  }
  throw new Error(
    'Cannot resolve own container id for `docker run --volumes-from` — set HOSTNAME or run inside a container',
  );
}

function readContainerIdFromMountInfo(): string | undefined {
  try {
    const info = readFileSync('/proc/self/mountinfo', 'utf8');
    return info.match(/\/docker\/containers\/([0-9a-f]{64})\//i)?.[1];
  } catch {
    return undefined;
  }
}

export interface TrivyRunnerOptions {
  /** Local binary name/path (defaults to `trivy` on PATH). */
  localCommand?: string;
  /** Docker executable name/path (defaults to `docker` on PATH). */
  dockerCommand?: string;
  /** Overridable only for tests; production always uses the pinned image. */
  dockerImage?: string;
  /**
   * Overridable only for tests; production resolves THIS container's id via
   * {@link resolveSelfContainerRef} for the sibling `--volumes-from` mount.
   */
  dockerSelfRef?: string;
  runner?: SubprocessRunner;
  stat?: (reportPath: string) => Promise<void>;
  /** Wall-clock budget per Trivy invocation (defaults to {@link DEFAULT_TRIVY_TIMEOUT_MS}). */
  timeoutMs?: number;
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
  private readonly dockerSelfRefOverride: string | undefined;
  private resolvedSelfRef: string | undefined;
  private readonly runner: SubprocessRunner;
  private readonly statReport: (reportPath: string) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(options: TrivyRunnerOptions = {}) {
    this.localCommand = options.localCommand ?? 'trivy';
    this.dockerCommand = options.dockerCommand ?? 'docker';
    this.dockerImage = options.dockerImage ?? TRIVY_DOCKER_IMAGE;
    this.dockerSelfRefOverride = options.dockerSelfRef;
    this.runner = options.runner ?? createSpawnSubprocessRunner();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TRIVY_TIMEOUT_MS;
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
        { shell: false, timeoutMs: this.timeoutMs },
      );
    } catch (error) {
      // Fall back to Docker ONLY for a local launch/infrastructure failure.
      // A genuine non-zero scan execution error is rethrown, never re-run.
      if (error instanceof SubprocessRunError && error.launchFailed) {
        await this.runner.run(
          this.dockerCommand,
          this.buildDockerArgs(cloneDir, reportPath),
          { shell: false, timeoutMs: this.timeoutMs },
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

  /** THIS container's id for the sibling `--volumes-from` mount (cached). */
  private selfContainerRef(): string {
    if (this.dockerSelfRefOverride !== undefined) {
      return this.dockerSelfRefOverride;
    }
    this.resolvedSelfRef ??= resolveSelfContainerRef();
    return this.resolvedSelfRef;
  }

  private buildDockerArgs(cloneDir: string, reportPath: string): string[] {
    // DooD sibling sharing: `--volumes-from <self>` mounts the worker's real
    // `/tmp/scans` volume into the Trivy sibling at the SAME absolute path, so
    // `cloneDir`/`reportPath` pass through UNCHANGED — no `/src`//`/out` remap,
    // which was the host-vs-overlay ENOENT bug (06-UAT). Bind `-v` is unusable
    // here because the host daemon would resolve its source on the host FS.
    return [
      'run',
      '--rm',
      '--volumes-from',
      this.selfContainerRef(),
      // Ephemeral per-scan Trivy cache: tmpfs discarded when the sibling exits.
      '--mount',
      `type=tmpfs,destination=${CONTAINER_CACHE}`,
      this.dockerImage,
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
}
