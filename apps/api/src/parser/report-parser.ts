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
    title: vulnerability.Title,
    primaryUrl: vulnerability.PrimaryURL,
  };
}

export class ReportParser {
  async *parse(reportPath: string): AsyncIterable<Vulnerability> {
    const pipeline = chain.chainUnchecked<unknown, TrivyVulnerability>([
      createReadStream(reportPath),
      parser(),
      pick({ filter: CRITICAL_LEAF_PATH }),
      streamValues(),
      (data: { value: TrivyVulnerability }) =>
        data.value.Severity === 'CRITICAL' ? data.value : chain.none,
    ]);

    for await (const vulnerability of pipeline as AsyncIterable<TrivyVulnerability>) {
      yield toVulnerability(vulnerability);
    }
  }
}
