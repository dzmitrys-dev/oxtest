import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';

import { Scan, ScanStatus } from '../domain/scan.types';
import { SCAN_REPOSITORY } from './scan.repository.port';
import type { ScanRepository } from './scan.repository.port';
import { BASE_LOGGER, ScanJob, SCAN_JOB_NAME, SCAN_QUEUE } from './scan.types';

/**
 * Pure orchestration boundary (ARCH-02, D-02): submit jobs and read full scan
 * state. This service MUST NOT touch node:fs, node:child_process, Docker, Trivy,
 * the parser, adapter classes, URL validation, or HTTP status mapping — those
 * belong to the worker/adapters (Phase 3 later plans) and the transport (Phase 4).
 *
 * The queue is injected via the framework-neutral SCAN_QUEUE token (bridged to
 * BullMQ in the module) so this file never imports `@nestjs/bullmq`.
 */
@Injectable()
export class ScanService {
  constructor(
    @Inject(SCAN_REPOSITORY) private readonly repository: ScanRepository,
    @Inject(SCAN_QUEUE)
    private readonly queue: Queue<ScanJob, void, typeof SCAN_JOB_NAME>,
    @Inject(BASE_LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Create a Queued scan, submit exactly one typed job, and return the queued
   * identity immediately — no engine work is awaited here.
   */
  async enqueue(repoUrl: string): Promise<Scan> {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const scan: Scan = {
      id,
      status: ScanStatus.Queued,
      repoUrl,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.repository.create(scan);
    await this.queue.add(SCAN_JOB_NAME, { scanId: id, repoUrl });
    // ndjson enqueue line: scanId + repoUrl as STRUCTURED pino fields (never
    // string-interpolated — V7 log-injection guard, T-05-01-02). A scan's
    // lifecycle starts here in the API logs and continues in the worker logs,
    // joinable across processes by scanId (OPS-04, D-02).
    this.logger.info({ scanId: id, repoUrl }, 'scan queued');
    return scan;
  }

  /** Single full read; null for an unknown id is preserved for Phase 4 mapping. */
  get(id: string): Promise<Scan | null> {
    return this.repository.get(id);
  }
}
