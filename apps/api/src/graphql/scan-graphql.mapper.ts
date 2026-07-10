import type { Scan } from '../domain/scan.types';
import { ScanStatus } from '../domain/scan.types';
import { ScanModel } from './scan.model';

/**
 * Status-switched domain→GraphQL mapper, the GraphQL twin of the REST
 * `toScanResponse` (D-06 parity). The raw `Scan` is NEVER spread: only `id`,
 * `status`, and (when Finished) `criticalVulnerabilities` reach the wire —
 * `repoUrl`/`createdAt`/`updatedAt`/`error` never leak on the GraphQL surface.
 *
 * `status` is the `ScanStatus` enum value, which IS the wire string
 * (`'Queued' | 'Scanning' | 'Finished' | 'Failed'`). `criticalVulnerabilities`
 * is populated only for Finished (from `scan.vulnerabilities ?? []`); for
 * Queued/Scanning/Failed it stays `undefined` — a Failed scan surfaces via
 * `status: 'Failed'` with no vulnerabilities (D-06).
 */
export function toScanModel(scan: Scan): ScanModel {
  const model = new ScanModel();
  model.id = scan.id;
  model.status = scan.status;
  model.criticalVulnerabilities =
    scan.status === ScanStatus.Finished ? (scan.vulnerabilities ?? []) : undefined;
  return model;
}
