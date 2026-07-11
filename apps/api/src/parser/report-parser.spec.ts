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
      await drainReport(reportPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function drainReport(reportPath: string): Promise<void> {
    for await (const vulnerability of new ReportParser().parse(reportPath)) {
      // Drain the stream so parser errors are observed by the assertion.
      void vulnerability;
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

  it('tolerates real-Trivy leaves that omit Title/PrimaryURL (defaults to empty, never fails the scan)', async () => {
    // Reproduces 06-UAT: a real NodeGoat report has a MEDIUM leaf missing
    // PrimaryURL (pkg `marked`), which previously threw and failed the whole
    // scan even though it is discarded. A CRITICAL leaf may also omit them.
    const directory = await mkdtemp(path.join(tmpdir(), 'oxtest-parser-opt-'));
    const reportPath = path.join(directory, 'report.json');
    await writeFile(
      reportPath,
      JSON.stringify({
        Results: [
          {
            Vulnerabilities: [
              {
                VulnerabilityID: 'NSWG-ECO-101',
                PkgName: 'marked',
                InstalledVersion: '0.3.5',
                Severity: 'MEDIUM',
                Title: 'Sanitization bypass',
                // no PrimaryURL — must not fail the scan (discarded leaf)
              },
              {
                VulnerabilityID: 'CVE-CRITICAL-XYZ',
                PkgName: 'lodash',
                InstalledVersion: '4.17.11',
                Severity: 'CRITICAL',
                // no Title, no PrimaryURL — default to ''
              },
            ],
          },
        ],
      }),
    );

    const emitted: Array<{ title: string; primaryUrl: string }> = [];
    try {
      for await (const v of new ReportParser().parse(reportPath)) {
        emitted.push(v);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    expect(emitted).toEqual([
      {
        vulnerabilityId: 'CVE-CRITICAL-XYZ',
        pkgName: 'lodash',
        installedVersion: '4.17.11',
        severity: 'CRITICAL',
        title: '',
        primaryUrl: '',
      },
    ]);
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

  it('preserves the filesystem error for a missing report file', async () => {
    const reportPath = path.join(tmpdir(), `oxtest-missing-${Date.now()}.json`);

    await expect(drainReport(reportPath)).rejects.toMatchObject({
      code: 'ENOENT',
      path: reportPath,
    });
  });

  it('allows a valid report with no vulnerabilities to emit no results', async () => {
    await expect(
      parseReport({ Results: [{ Target: 'empty', Vulnerabilities: [] }] }),
    ).resolves.toBeUndefined();
  });
});
