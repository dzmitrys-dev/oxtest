import type { Vulnerability } from '../domain/vulnerability.types';
import type { ScanRepository } from '../scan/scan.repository.port';
import type { ScanJob } from '../scan/scan.types';

import { classifyScanError, type ScanErrorStage } from './scan-error';
import type { RepoCloner } from './repo-cloner.port';
import type {
  ScanPathAllocation,
  ScanPathAllocator,
} from './scan-path-allocator.port';
import type { TempArtifactCleaner } from './temp-artifact-cleaner';
import type { TrivyRunner } from './trivy-runner.port';

/**
 * Structural view of the Phase 2 {@link ReportParser} reused UNCHANGED (D-04):
 * the engine only needs the async-generator `parse(reportPath)` contract, so it
 * depends on this minimal shape rather than the concrete class. Keeping the
 * dependency structural also lets tests substitute a fake iterable without
 * importing the real streaming parser.
 */
export interface ReportParserLike {
  parse(reportPath: string): AsyncIterable<Vulnerability>;
}

/**
 * Bounded diagnostics sink — detail stays in worker logs only (D-21). Widened
 * in Phase 5 (D-03) to add `info` alongside `warn`/`error` so each lifecycle
 * transition (Queued → Scanning → Finished, clone/Trivy/parse) emits a
 * `scanId`-bound line via the pino adapter, satisfying OPS-04 criterion #3.
 */
export interface EngineLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const noopLogger: EngineLogger = {
  info(): void {
    /* discarded by default; the worker injects a real logger */
  },
  warn(): void {
    /* discarded by default; the worker injects a real logger */
  },
  error(): void {
    /* discarded by default; the worker injects a real logger */
  },
};

export interface ScanEngineDeps {
  repository: ScanRepository;
  allocator: ScanPathAllocator;
  cloner: RepoCloner;
  trivy: TrivyRunner;
  parser: ReportParserLike;
  cleaner: TempArtifactCleaner;
  /**
   * Report-readiness observability seam. When wired (the compiled worker with
   * `SCAN_ENGINE_READY_MARKER=log`) it emits a `REPORT_READY <path>` marker;
   * it is DISTINCT from the process-level `SCAN_WORKER_READY` bootstrap
   * sentinel. Passed straight through to the Trivy runner so the callback
   * resolves before `ReportParser.parse` is ever invoked.
   */
  onReportReady?: (reportPath: string) => Promise<void>;
  logger?: EngineLogger;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/**
 * Framework-free scan lifecycle engine (no `@nestjs/bullmq` import). It owns the
 * concurrency-one sequential lifecycle — allocate → Scanning → clone → Trivy →
 * stream-parse with awaited ordered appends → Finished — and the exact failure
 * semantics: every clone/Trivy/disk-full/parse rejection persists `Failed` with
 * a bounded, redacted reason, then rethrows the ORIGINAL error so BullMQ records
 * the first failure with NO automatic retry/backoff (D-19, D-23). Cleanup is
 * always awaited in `finally` and can never mask the primary result (D-22).
 *
 * The thin `@Processor`/`WorkerHost` shell in `scan-worker.ts` only delegates to
 * this class; all lifecycle logic lives here so the unit suite can exercise the
 * full contract without pulling `@nestjs/bullmq` into the jest module graph
 * (the recorded `@swc/core` miette panic).
 */
export class ScanEngine {
  private readonly repository: ScanRepository;
  private readonly allocator: ScanPathAllocator;
  private readonly cloner: RepoCloner;
  private readonly trivy: TrivyRunner;
  private readonly parser: ReportParserLike;
  private readonly cleaner: TempArtifactCleaner;
  private readonly onReportReady?: (reportPath: string) => Promise<void>;
  private readonly logger: EngineLogger;

  constructor(deps: ScanEngineDeps) {
    this.repository = deps.repository;
    this.allocator = deps.allocator;
    this.cloner = deps.cloner;
    this.trivy = deps.trivy;
    this.parser = deps.parser;
    this.cleaner = deps.cleaner;
    this.onReportReady = deps.onReportReady;
    this.logger = deps.logger ?? noopLogger;
  }

  /**
   * Run one scan's lifecycle. `logger` is the per-job `scanId`-bound sink the
   * worker builds via `engineLoggerFor(baseLogger, job.data.scanId)` (D-02); it
   * overrides the singleton fallback so every lifecycle line carries `scanId`
   * as a structured field. `scanId` is NEVER interpolated into the message —
   * the pino child binding attaches it (log-injection guard, T-05-01-02).
   */
  async run(job: ScanJob, logger?: EngineLogger): Promise<void> {
    const { scanId, repoUrl } = job;
    const log = logger ?? this.logger;

    // Allocation happens BEFORE the engine try/finally. The allocator is the
    // exclusive owner of both paths and cleans any partial allocation itself if
    // it rejects (D-16); the worker only owns cleanup once a pair is returned.
    let allocation: ScanPathAllocation;
    try {
      allocation = await this.allocator.allocate(scanId);
    } catch (error) {
      await this.persistFailed(scanId, 'clone', error, log);
      throw error;
    }

    const { cloneDir, reportPath } = allocation;
    // Both returned paths remain available to `finally` cleanup on every later
    // failure, regardless of which stage rejects.
    let stage: ScanErrorStage = 'clone';
    try {
      await this.repository.markScanning(scanId);
      log.info('scan scanning');

      stage = 'clone';
      log.info('clone started');
      await this.cloner.clone(repoUrl, cloneDir);
      log.info('clone completed');

      stage = 'trivy';
      log.info('trivy started');
      await this.trivy.run(cloneDir, reportPath, {
        onReportReady: this.onReportReady,
      });
      log.info('trivy completed');

      // Report-readiness (via the Trivy runner) has fully resolved before the
      // first `parse` call. Consume ONE yielded CRITICAL vulnerability at a
      // time, awaiting each append before requesting the next — never buffered.
      stage = 'parse';
      log.info('parse started');
      for await (const vulnerability of this.parser.parse(reportPath)) {
        await this.repository.appendVulnerability(scanId, vulnerability);
      }

      // Finished only after parser completion and all awaited appends.
      await this.repository.markFinished(scanId);
      log.info('scan finished');
    } catch (error) {
      await this.persistFailed(scanId, stage, error, log);
      // Original-error precedence: rethrow the first engine failure to BullMQ.
      // No retry/backoff is configured (D-19) — retry policy is deferred.
      throw error;
    } finally {
      await this.safeCleanup(cloneDir, reportPath, log);
    }
  }

  /**
   * Persist a bounded/redacted `Failed` reason. A failure-persistence error is
   * secondary and must never replace the original engine error (D-23), so it is
   * logged and swallowed here.
   */
  private async persistFailed(
    scanId: string,
    stage: ScanErrorStage,
    error: unknown,
    log: EngineLogger,
  ): Promise<void> {
    const reason = classifyScanError(stage, error);
    try {
      await this.repository.markFailed(scanId, reason);
    } catch (persistError) {
      log.error(
        `Failed to persist Failed state for scan ${scanId}: ${toMessage(persistError)}`,
      );
    }
  }

  /**
   * Awaited cleanup that never throws: a secondary cleanup failure is logged and
   * suppressed so it cannot mask a successful scan or the original engine error
   * (D-22, D-23). Invoked exactly once per run in `finally`.
   */
  private async safeCleanup(
    cloneDir: string,
    reportPath: string,
    log: EngineLogger,
  ): Promise<void> {
    try {
      await this.cleaner.remove(cloneDir, reportPath);
    } catch (cleanupError) {
      log.warn(`Cleanup failed for scan artifacts: ${toMessage(cleanupError)}`);
    }
  }
}
