import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { ReportParser } from './report-parser';

describe('ReportParser', () => {
  async function parseReport(report: unknown): Promise<void> {
    const directory = await mkdtemp(path.join(tmpdir(), 'oxtest-parser-'));
    const reportPath = path.join(directory, 'report.json');
    await writeFile(reportPath, JSON.stringify(report));
    try {
      for await (const vulnerability of new ReportParser().parse(reportPath)) {
        // Drain the stream so parser errors are observed by the assertion.
        void vulnerability;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

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

  it.each([
    ['null', null],
    ['missing required fields', { Severity: 'CRITICAL' }],
    [
      'wrong field types',
      {
        VulnerabilityID: 42,
        PkgName: 'pkg',
        InstalledVersion: '1.0.0',
        Severity: 'CRITICAL',
        Title: 'title',
        PrimaryURL: 'https://example.invalid',
      },
    ],
  ])('rejects %s vulnerability leaves', async (_description, leaf) => {
    await expect(
      parseReport({
        Results: [{ Vulnerabilities: [leaf] }],
      }),
    ).rejects.toThrow('Invalid Trivy vulnerability leaf');
  });
});
