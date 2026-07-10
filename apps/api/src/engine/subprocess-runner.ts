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
  /**
   * Wall-clock ceiling for the whole run (HIGH-01). On expiry the child is sent
   * `SIGTERM`, then `SIGKILL` after a short grace, and the run rejects with a
   * timeout-classified {@link SubprocessRunError}. Absent → a sane default
   * bounds every run so one hung `git`/`trivy` can never stall the
   * concurrency-one worker forever.
   */
  readonly timeoutMs?: number;
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
  /**
   * `true` when the run exceeded its wall-clock budget and the child was killed
   * (HIGH-01). Distinct from launch-failure and non-zero-exit so the engine can
   * classify it into a bounded `timeout` category. A timeout is a genuine stage
   * failure (`launchFailed:false`) — it must NEVER trigger a Docker fallback.
   */
  timedOut?: boolean;
  exitCode?: number;
  signal?: string;
  /** Node errno code (e.g. `ENOENT`, `EACCES`, `ENOSPC`) when available. */
  code?: string;
  /** Bounded stderr retained for diagnostics/logs only (never persisted raw). */
  stderr: string;
}

export class SubprocessRunError extends Error {
  readonly launchFailed: boolean;
  readonly timedOut: boolean;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly code?: string;
  readonly stderr: string;

  constructor(info: SubprocessErrorInfo) {
    const detail = info.timedOut
      ? `timed out${info.signal ? ` (signal ${info.signal})` : ''}`
      : info.launchFailed
        ? `launch error${info.code ? ` (${info.code})` : ''}`
        : `exit ${info.exitCode ?? 'unknown'}${info.signal ? ` (signal ${info.signal})` : ''}`;
    super(`Subprocess '${info.file}' failed: ${detail}`);
    this.name = 'SubprocessRunError';
    this.launchFailed = info.launchFailed;
    this.timedOut = info.timedOut ?? false;
    this.exitCode = info.exitCode;
    this.signal = info.signal;
    this.code = info.code;
    this.stderr = info.stderr;
  }
}

const MAX_STDERR_BYTES = 8192;

/**
 * Default wall-clock budget for any run without an explicit `timeoutMs`
 * (HIGH-01). Injectable per-run so callers can set distinct clone vs. Trivy
 * budgets; the ceiling exists only to guarantee eventual recovery, not to bound
 * legitimate work tightly.
 */
export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 120_000;

/** Grace between the escalating `SIGTERM` and the final `SIGKILL`. */
export const DEFAULT_SIGKILL_GRACE_MS = 5_000;

/** Injectable seams — production uses the real `spawn` and the default grace. */
export interface SpawnRunnerDeps {
  spawn?: typeof spawn;
  sigkillGraceMs?: number;
}

/**
 * Default runner backed by `child_process.spawn` with `shell:false`. stdout is
 * ignored (never collected) so a large Trivy report written to `--output`
 * cannot inflate Node heap; stderr is captured but bounded for diagnostics.
 */
export function createSpawnSubprocessRunner(
  deps: SpawnRunnerDeps = {},
): SubprocessRunner {
  const spawnFn = deps.spawn ?? spawn;
  const sigkillGraceMs = deps.sigkillGraceMs ?? DEFAULT_SIGKILL_GRACE_MS;
  return {
    run(
      file: string,
      args: readonly string[],
      options: SubprocessRunOptions,
    ): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const child = spawnFn(file, [...args], {
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

        // Wall-clock timeout with a hand-rolled SIGTERM→SIGKILL escalation:
        // Node's own `spawn` `timeout` sends only ONE signal (no escalation), so
        // a child that ignores SIGTERM would never die. Both timers are cleared
        // on close/error so a fast run schedules nothing.
        const timeoutMs = options.timeoutMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS;
        let timedOut = false;
        let graceTimer: NodeJS.Timeout | undefined;
        const killTimer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          graceTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGKILL');
            }
          }, sigkillGraceMs);
          graceTimer.unref?.();
        }, timeoutMs);
        killTimer.unref?.();

        const clearTimers = (): void => {
          clearTimeout(killTimer);
          if (graceTimer) {
            clearTimeout(graceTimer);
          }
        };

        child.once('error', (error: NodeJS.ErrnoException) => {
          clearTimers();
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
            clearTimers();
            if (timedOut) {
              reject(
                new SubprocessRunError({
                  file,
                  args,
                  launchFailed: false,
                  timedOut: true,
                  signal: signal ?? 'SIGKILL',
                  stderr,
                }),
              );
              return;
            }
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
