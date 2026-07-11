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
  // Display-only and OPTIONAL in real Trivy output — many advisories (e.g.
  // NSWG npm entries) omit PrimaryURL, and some omit Title. The parser must
  // NOT fail a scan over a missing display field (06-UAT); it defaults these
  // to '' when absent.
  Title?: string;
  PrimaryURL?: string;
}
