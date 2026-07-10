/**
 * Framework-free BullMQ contract for the scan queue (D-05). One queue name and
 * one job name are shared by the producer (ScanService) and the worker so the
 * two entrypoints cannot drift onto separate queues.
 *
 * The payload is intentionally minimal: only the identifiers needed to look up
 * authoritative Redis state and clone the target. Never place status, paths,
 * credentials, or report contents on the job (threat T-03-01).
 */
export const SCAN_QUEUE_NAME = 'scan';
export const SCAN_JOB_NAME = 'scan';

export interface ScanJob {
  scanId: string;
  repoUrl: string;
}

/**
 * DI token for the injected typed producer queue. ScanService injects the queue
 * through this framework-neutral Symbol rather than `@InjectQueue`; the module
 * bridges it to BullMQ's own queue token via `useExisting`. This keeps
 * `@nestjs/bullmq` out of files loaded by the unit test path and decouples the
 * service from the transport library, matching the port/token design of Phase 3.
 */
export const SCAN_QUEUE = Symbol('SCAN_QUEUE');
