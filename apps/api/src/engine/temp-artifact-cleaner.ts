import { rm } from 'node:fs/promises';

/**
 * Injectable idempotent cleanup for the clone directory and report file
 * (ENGINE-07, T-03-09). Both paths are always attempted, missing paths
 * (`ENOENT`) are treated as success, and any secondary removal error is
 * reported via the logger WITHOUT throwing — so the original scan failure is
 * never masked by a cleanup error (D-22).
 */
export interface TempArtifactCleaner {
  remove(cloneDir: string, reportPath: string): Promise<void>;
}

export const TEMP_ARTIFACT_CLEANER = Symbol('TEMP_ARTIFACT_CLEANER');

export interface CleanerRmOptions {
  recursive: boolean;
  force: boolean;
}

/** Filesystem seam so idempotence can be exercised without a real disk. */
export interface CleanerFs {
  rm(target: string, options: CleanerRmOptions): Promise<void>;
}

/** Minimal logger seam (bounded to what cleanup diagnostics need). */
export interface CleanerLogger {
  warn(message: string): void;
}

export interface TempArtifactCleanerOptions {
  fs?: CleanerFs;
  logger?: CleanerLogger;
}

const defaultFs: CleanerFs = {
  async rm(target: string, options: CleanerRmOptions): Promise<void> {
    await rm(target, options);
  },
};

const defaultLogger: CleanerLogger = {
  warn(message: string): void {
    console.warn(message);
  },
};

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export class TempArtifactCleanerAdapter implements TempArtifactCleaner {
  private readonly fs: CleanerFs;
  private readonly logger: CleanerLogger;

  constructor(options: TempArtifactCleanerOptions = {}) {
    this.fs = options.fs ?? defaultFs;
    this.logger = options.logger ?? defaultLogger;
  }

  async remove(cloneDir: string, reportPath: string): Promise<void> {
    // Always attempt BOTH paths, even if the first errors.
    for (const target of [cloneDir, reportPath]) {
      try {
        await this.fs.rm(target, { recursive: true, force: true });
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          // Already gone — cleanup is idempotent, treat as success.
          continue;
        }
        // Secondary cleanup failure: report but never rethrow (D-22).
        this.logger.warn(
          `Failed to remove scan artifact ${target}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
  }
}
