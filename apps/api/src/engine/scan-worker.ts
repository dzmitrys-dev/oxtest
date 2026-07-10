import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import {
  SCAN_JOB_NAME,
  SCAN_QUEUE_NAME,
  type ScanJob,
} from '../scan/scan.types';
import { ScanEngine } from './scan-engine';

/** DI token for the plain lifecycle engine the shell delegates to. */
export const SCAN_ENGINE = Symbol('SCAN_ENGINE');

/**
 * THIN BullMQ `WorkerHost` shell. It is the ONLY file in the worker path that
 * imports `@nestjs/bullmq`, and it is deliberately never imported by a jest
 * spec — the recorded `@swc/core` miette panic aborts jest whenever
 * `@nestjs/bullmq` enters the module graph. All lifecycle logic lives in the
 * plain, fully unit-tested {@link ScanEngine}; `process` merely delegates.
 *
 * The processor is bound to the single shared `scan` queue with
 * `{ concurrency: 1 }` so exactly one scan job runs at a time (T-03-08). The
 * worker never overwrites authoritative Redis terminal state — the repository
 * owns those guards.
 */
@Processor(SCAN_QUEUE_NAME, { concurrency: 1 })
export class ScanWorker extends WorkerHost {
  private readonly logger = new Logger(ScanWorker.name);

  constructor(@Inject(SCAN_ENGINE) private readonly engine: ScanEngine) {
    super();
  }

  async process(job: Job<ScanJob, void, typeof SCAN_JOB_NAME>): Promise<void> {
    await this.engine.run(job.data);
  }

  /**
   * Keep an unhandled worker-level error (e.g. a transient Redis blip) from
   * crashing the process or stopping job processing. Diagnostics stay in logs
   * only (D-21); no raw detail is persisted to Redis here.
   */
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(`Scan worker error: ${error.message}`);
  }
}
