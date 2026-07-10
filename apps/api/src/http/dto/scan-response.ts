import { Scan, ScanFailureReason, ScanStatus } from '../../domain/scan.types';
import type { Vulnerability } from '../../domain/vulnerability.types';

/**
 * State-shaped wire representation of a scan (D-05/06/07). Discriminated on
 * `status` so a client polling `GET /api/scan/:scanId` gets only the fields
 * meaningful for that state — and never the raw domain object (`repoUrl`,
 * timestamps are dropped, T-04-03).
 */
export type ScanResponse =
  | { scanId: string; status: 'Queued' }
  | { scanId: string; status: 'Scanning' }
  | {
      scanId: string;
      status: 'Finished';
      criticalVulnerabilities: Vulnerability[];
    }
  | { scanId: string; status: 'Failed'; error: ScanFailureReason };

/**
 * Explicit, status-switched domain→wire mapper mirroring the field-by-field
 * `serialize`/`deserialize` idiom in `scan.repository.ts` — the raw `Scan` is
 * NEVER spread. Domain `id` becomes `scanId` on the wire (D-04).
 */
export function toScanResponse(scan: Scan): ScanResponse {
  const scanId = scan.id;
  switch (scan.status) {
    case ScanStatus.Queued:
      return { scanId, status: 'Queued' };
    case ScanStatus.Scanning:
      return { scanId, status: 'Scanning' };
    case ScanStatus.Finished:
      return {
        scanId,
        status: 'Finished',
        criticalVulnerabilities: scan.vulnerabilities ?? [],
      };
    case ScanStatus.Failed:
      return {
        scanId,
        status: 'Failed',
        error: {
          category: scan.error?.category ?? 'unknown',
          detail: scan.error?.detail ?? '',
        },
      };
  }
}
