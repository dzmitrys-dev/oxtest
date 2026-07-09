/**
 * Framework-free domain type — no NestJS/GraphQL imports (D-03).
 * Per D-04, this models ONLY the parse path (Results[].Vulnerabilities[])
 * — not Trivy's full report schema.
 */
export interface TrivyReport {
  Results?: TrivyResult[];
}

export interface TrivyResult {
  Target: string;
  Vulnerabilities?: TrivyVulnerability[];
}

export interface TrivyVulnerability {
  VulnerabilityID: string;
  PkgName: string;
  InstalledVersion: string;
  Severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  Title: string;
  PrimaryURL: string;
}
