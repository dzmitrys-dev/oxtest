import { spawn } from 'node:child_process';

/**
 * Infrastructure seam for launching external processes (`git`, `trivy`,
 * `docker`). It is intentionally framework-free so the clone and Trivy
 * adapters can be unit-tested with a recording double, and so `shell:false`
 * plus argv-array invocation is enforced structurally rather than by
 * convention (threat T-03-05 — no shell strings, no `exec`).
 */
export interface SubprocessRunOptions {
  /**
   * Shell interpolation is forbidden on every subprocess path. The option is
   * `false` (never a boolean) so a caller cannot accidentally opt into a shell.
   */
  readonly shell: false;
  /**
   * Locked-down environment overrides MERGED over `process.env` for this child
   * only (T-03-05, CR-01). The clone adapter uses this to force git's transport
   * allowlist (`GIT_ALLOW_PROTOCOL`), neutralize user-policy transports
   * (`GIT_PROTOCOL_FROM_USER=0`), and disable credential prompts
   * (`GIT_TERMINAL_PROMPT=0`). Absent → the child inherits `process.env` verbatim.
   */
  readonly env?: Readonly<Record<string, string>>;
}

export interface SubprocessRunner {
  /**
   * Resolves when the process exits 0; rejects with a {@link SubprocessRunError}
   * otherwise. Report bytes are never buffered here — callers direct large
   * output to a file via `--output`, and stdout is discarded.
   */
  run(
    file: string,
    args: readonly string[],
    options: SubprocessRunOptions,
  ): Promise<void>;
}

export interface SubprocessErrorInfo {
  file: string;
  args: readonly string[];
  /**
   * `true` when the process could not be spawned at all (missing binary,
   * permission, Docker daemon unreachable). `false` when it started but exited
   * non-zero — a genuine execution failure that must NOT trigger a fallback.
   */
  launchFailed: boolean;
  exitCode?: number;
  signal?: string;
  /** Node errno code (e.g. `ENOENT`, `EACCES`, `ENOSPC`) when available. */
  code?: string;
  /** Bounded stderr retained for diagnostics/logs only (never persisted raw). */
  stderr: string;
}

export class SubprocessRunError extends Error {
  readonly launchFailed: boolean;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly code?: string;
  readonly stderr: string;

  constructor(info: SubprocessErrorInfo) {
    const detail = info.launchFailed
      ? `launch error${info.code ? ` (${info.code})` : ''}`
      : `exit ${info.exitCode ?? 'unknown'}${info.signal ? ` (signal ${info.signal})` : ''}`;
    super(`Subprocess '${info.file}' failed: ${detail}`);
    this.name = 'SubprocessRunError';
    this.launchFailed = info.launchFailed;
    this.exitCode = info.exitCode;
    this.signal = info.signal;
    this.code = info.code;
    this.stderr = info.stderr;
  }
}

const MAX_STDERR_BYTES = 8192;

/**
 * Default runner backed by `child_process.spawn` with `shell:false`. stdout is
 * ignored (never collected) so a large Trivy report written to `--output`
 * cannot inflate Node heap; stderr is captured but bounded for diagnostics.
 */
export function createSpawnSubprocessRunner(): SubprocessRunner {
  return {
    run(
      file: string,
      args: readonly string[],
      options: SubprocessRunOptions,
    ): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const child = spawn(file, [...args], {
          shell: options.shell,
          stdio: ['ignore', 'ignore', 'pipe'],
          // Locked-down env is MERGED over the inherited environment so the child
          // keeps PATH/HOME while the caller's security overrides (e.g. git's
          // transport allowlist) always win. Absent → inherit `process.env`.
          env: options.env ? { ...process.env, ...options.env } : process.env,
        });

        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderr.length < MAX_STDERR_BYTES) {
            stderr = (stderr + chunk.toString('utf8')).slice(
              0,
              MAX_STDERR_BYTES,
            );
          }
        });

        child.once('error', (error: NodeJS.ErrnoException) => {
          reject(
            new SubprocessRunError({
              file,
              args,
              launchFailed: true,
              code: error.code,
              stderr,
            }),
          );
        });

        child.once(
          'close',
          (exitCode: number | null, signal: string | null) => {
            if (exitCode === 0) {
              resolve();
              return;
            }
            reject(
              new SubprocessRunError({
                file,
                args,
                launchFailed: false,
                exitCode: exitCode ?? undefined,
                signal: signal ?? undefined,
                stderr,
              }),
            );
          },
        );
      });
    },
  };
}
