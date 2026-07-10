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
