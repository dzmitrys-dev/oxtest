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

/**
 * DI token for the shared base pino logger (OPS-04, D-01/D-02). Provided by
 * `ScanModule` via `useFactory: createBaseLogger` and exported so BOTH the API
 * (`ScanService` enqueue line) and the worker (`ScanWorker` per-job
 * `pino.child({ scanId })`) draw from the SAME ndjson base logger, keeping their
 * lines joinable by `scanId`. Declared here — a framework-free tokens home —
 * rather than in `engine/` so `ScanService` never imports across the `engine/`
 * boundary its ARCH-02 spec forbids.
 */
export const BASE_LOGGER = Symbol('BASE_LOGGER');
