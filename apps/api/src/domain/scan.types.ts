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

export interface Scan {
  id: string;
  status: ScanStatus;
  repoUrl: string;
  vulnerabilities?: Vulnerability[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}
