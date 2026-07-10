/**
 * GraphQL documents + result types for the Bonus A SPA.
 *
 * Both documents mirror the Wave-1 code-first schema exactly
 * (apps/api/src/graphql/scan.model.ts, vulnerability.model.ts, scan.resolver.ts):
 *   - Mutation: enqueueScan(repoUrl: String!): Scan { id, status }
 *   - Query:    scan(id: ID!): Scan { id, status, criticalVulnerabilities { 6 fields } }
 *
 * D-08 (HARD): the GetScan selection set lists EXACTLY the six stored Vulnerability
 * fields the parser persists (vulnerabilityId, pkgName, installedVersion, severity,
 * title, primaryUrl) — the SPA never requests a field the parser does not persist.
 * There is no `fixedVersion` field, so there is no such column downstream.
 */

/** The four ScanStatus wire strings (status is String! in the schema, not an enum). */
export type ScanStatus = 'Queued' | 'Scanning' | 'Finished' | 'Failed';

/** One CRITICAL vulnerability — exactly the six persisted fields (D-08). */
export interface Vulnerability {
  vulnerabilityId: string;
  pkgName: string;
  installedVersion: string;
  severity: string;
  title: string;
  primaryUrl: string;
}

/** The Scan projection returned by the GetScan query. */
export interface Scan {
  id: string;
  status: string;
  criticalVulnerabilities: Vulnerability[] | null;
}

/** urql data shape for GetScan (scan is nullable — unknown id resolves null, D-06). */
export interface GetScanData {
  scan: Scan | null;
}

export interface GetScanVariables {
  id: string;
}

/** urql data shape for EnqueueScan. */
export interface EnqueueScanData {
  enqueueScan: {
    id: string;
    status: string;
  };
}

export interface EnqueueScanVariables {
  repoUrl: string;
}

export const EnqueueScan = /* GraphQL */ `
  mutation EnqueueScan($repoUrl: String!) {
    enqueueScan(repoUrl: $repoUrl) {
      id
      status
    }
  }
`;

export const GetScan = /* GraphQL */ `
  query GetScan($id: ID!) {
    scan(id: $id) {
      id
      status
      criticalVulnerabilities {
        vulnerabilityId
        pkgName
        installedVersion
        severity
        title
        primaryUrl
      }
    }
  }
`;
