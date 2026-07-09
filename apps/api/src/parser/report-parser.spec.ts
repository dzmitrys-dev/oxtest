import path from 'node:path';

import { ReportParser } from './report-parser';

describe('ReportParser', () => {
  it('emits the exact mapped CRITICAL vulnerabilities from nested results', async () => {
    const reportPath = path.resolve(
      __dirname,
      '../../fixtures/known-severity-mix.json',
    );
    const vulnerabilities: Array<{
      vulnerabilityId: string;
      pkgName: string;
      installedVersion: string;
      severity: 'CRITICAL';
      title: string;
      primaryUrl: string;
    }> = [];

    for await (const vulnerability of new ReportParser().parse(reportPath)) {
      vulnerabilities.push(vulnerability);
    }

    expect(vulnerabilities).toEqual([
      {
        vulnerabilityId: 'CVE-CRITICAL-001',
        pkgName: 'openssl',
        installedVersion: '3.0.1',
        severity: 'CRITICAL',
        title: 'Critical OpenSSL issue',
        primaryUrl: 'https://example.invalid/CVE-CRITICAL-001',
      },
      {
        vulnerabilityId: 'CVE-CRITICAL-002',
        pkgName: 'glibc',
        installedVersion: '2.35',
        severity: 'CRITICAL',
        title: 'Critical glibc issue',
        primaryUrl: 'https://example.invalid/CVE-CRITICAL-002',
      },
      {
        vulnerabilityId: 'CVE-CRITICAL-003',
        pkgName: 'curl',
        installedVersion: '8.0.0',
        severity: 'CRITICAL',
        title: 'Critical curl issue',
        primaryUrl: 'https://example.invalid/CVE-CRITICAL-003',
      },
    ]);
    expect(
      vulnerabilities.every(({ severity }) => severity === 'CRITICAL'),
    ).toBe(true);
  });
});
