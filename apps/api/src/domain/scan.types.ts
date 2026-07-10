import type { Vulnerability } from './vulnerability.types';

/**
 * Framework-free domain type — no NestJS/GraphQL imports (D-03).
 */
export enum ScanStatus {
  Queued = 'Queued',
  Scanning = 'Scanning',
  Finished = 'Finished',
  Failed = 'Failed',
}

/**
 * Bounded, sanitized failure categories (D-20). The category vocabulary lives
 * in the framework-free domain; the normalizer that PRODUCES these values
 * (engine/scan-error.ts) arrives in a later Phase 3 plan.
 */
export type ScanFailureCategory =
  'clone' | 'trivy' | 'disk-full' | 'parse' | 'unknown';

/**
 * Structured failure reason persisted on a Failed scan (D-20). `detail` is
 * capped at 500 characters at the persistence boundary; raw stderr,
 * credentials, and uncontrolled paths must never reach this field (D-21).
 */
export interface ScanFailureReason {
  category: ScanFailureCategory;
  detail: string;
}

export interface Scan {
  id: string;
  status: ScanStatus;
  repoUrl: string;
  vulnerabilities?: Vulnerability[];
  error?: ScanFailureReason;
  createdAt: string;
  updatedAt: string;
}
