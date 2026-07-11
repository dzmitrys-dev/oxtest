import { createReadStream } from 'node:fs';

import chain from 'stream-chain';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { streamValues } from 'stream-json/streamers/stream-values.js';

import type { TrivyVulnerability } from '../domain/trivy-report.types';
import type { Vulnerability } from '../domain/vulnerability.types';

// Canonical leaf path: Results.\d+.Vulnerabilities.\d+
const CRITICAL_LEAF_PATH = /^Results\.\d+\.Vulnerabilities\.\d+$/;

function toVulnerability(vulnerability: TrivyVulnerability): Vulnerability {
  return {
    vulnerabilityId: vulnerability.VulnerabilityID,
    pkgName: vulnerability.PkgName,
    installedVersion: vulnerability.InstalledVersion,
    severity: 'CRITICAL',
    // Title/PrimaryURL are display-only and OPTIONAL in real Trivy output —
    // default to '' rather than dropping the finding or failing the scan
    // (06-UAT: a MEDIUM leaf missing PrimaryURL previously killed the run).
    title: typeof vulnerability.Title === 'string' ? vulnerability.Title : '',
    primaryUrl:
      typeof vulnerability.PrimaryURL === 'string'
        ? vulnerability.PrimaryURL
        : '',
  };
}

const SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateVulnerability(value: unknown): TrivyVulnerability {
  // Strict on the identity + classification fields (always present in real
  // Trivy output). Title/PrimaryURL are display-only and legitimately absent
  // for some advisories, so they are validated leniently in toVulnerability
  // (default '') rather than failing the scan — see 06-UAT.
  if (
    !isRecord(value) ||
    typeof value.VulnerabilityID !== 'string' ||
    typeof value.PkgName !== 'string' ||
    typeof value.InstalledVersion !== 'string' ||
    typeof value.Severity !== 'string' ||
    !SEVERITIES.has(value.Severity)
  ) {
    throw new Error(
      'Invalid Trivy vulnerability leaf: expected VulnerabilityID, PkgName, InstalledVersion, and a valid Severity as string values',
    );
  }

  return value as unknown as TrivyVulnerability;
}

export class ReportParser {
  async *parse(reportPath: string): AsyncIterable<Vulnerability> {
    const pipeline = chain.chainUnchecked<unknown, TrivyVulnerability>([
      createReadStream(reportPath),
      parser(),
      pick({ filter: CRITICAL_LEAF_PATH }),
      streamValues(),
      (data: { value: unknown }) => {
        const vulnerability = validateVulnerability(data.value);
        return vulnerability.Severity === 'CRITICAL'
          ? vulnerability
          : chain.none;
      },
    ]);

    for await (const vulnerability of pipeline as AsyncIterable<TrivyVulnerability>) {
      yield toVulnerability(vulnerability);
    }
  }
}
