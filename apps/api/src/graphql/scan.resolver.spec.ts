import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Scan, ScanStatus } from '../domain/scan.types';
import type { Vulnerability } from '../domain/vulnerability.types';
import type { ScanService } from '../scan/scan.service';
import { ScanResolver } from './scan.resolver';

/**
 * Unit spec for the GraphQL ScanResolver. It mirrors scan.controller.spec.ts's
 * mock-service strategy EXACTLY to dodge the Jest landmine (Pitfall 2, STATE):
 * the `@swc/core` + `miette` native panic aborts Jest whenever `@nestjs/bullmq`
 * enters the module graph (via `ScanModule`/`AppModule`), on Node 22 AND 24.
 * So we construct `new ScanResolver(mockService)` by hand and import ONLY the
 * resolver under test — never `ScanModule`/`AppModule`/`@nestjs/bullmq`.
 */

const baseScan = (overrides: Partial<Scan>): Scan => ({
  id: 'scan-1',
  status: ScanStatus.Queued,
  repoUrl: 'https://github.com/owner/repo',
  createdAt: '2026-07-10T00:00:00.000Z',
  updatedAt: '2026-07-10T00:00:00.000Z',
  ...overrides,
});

const critical: Vulnerability = {
  vulnerabilityId: 'CVE-2026-0001',
  pkgName: 'left-pad',
  installedVersion: '1.0.0',
  severity: 'CRITICAL',
  title: 'boom',
  primaryUrl: 'https://example.invalid/cve',
};

function makeResolver(): {
  resolver: ScanResolver;
  enqueue: jest.Mock<Promise<Scan>, [string]>;
  get: jest.Mock<Promise<Scan | null>, [string]>;
} {
  const enqueue = jest.fn<Promise<Scan>, [string]>();
  const get = jest.fn<Promise<Scan | null>, [string]>();
  const service = { enqueue, get } as unknown as ScanService;
  return { resolver: new ScanResolver(service), enqueue, get };
}

describe('ScanResolver.scan (query, D-06 null-parity)', () => {
  it('maps a Finished scan through toScanModel incl. criticalVulnerabilities', async () => {
    const { resolver, get } = makeResolver();
    get.mockResolvedValue(
      baseScan({ status: ScanStatus.Finished, vulnerabilities: [critical] }),
    );

    const result = await resolver.scan('scan-1');

    expect(get).toHaveBeenCalledWith('scan-1');
    expect(result).not.toBeNull();
    expect(result).toEqual(
      expect.objectContaining({
        id: 'scan-1',
        status: 'Finished',
        criticalVulnerabilities: [critical],
      }),
    );
    // No raw-domain leak: repoUrl/createdAt/updatedAt never reach the model.
    expect(result).not.toHaveProperty('repoUrl');
    expect(result).not.toHaveProperty('createdAt');
    expect(result).not.toHaveProperty('updatedAt');
  });

  it('returns null (not throw) when the service resolves null (D-06)', async () => {
    const { resolver, get } = makeResolver();
    get.mockResolvedValue(null);

    await expect(resolver.scan('missing')).resolves.toBeNull();
    expect(get).toHaveBeenCalledWith('missing');
  });
});

describe('ScanResolver.enqueueScan (mutation, SSRF parity T-06-01)', () => {
  it('enqueues the CANONICAL url exactly once for a valid github URL (normalizes www. + .git)', async () => {
    const { resolver, enqueue } = makeResolver();
    enqueue.mockResolvedValue(baseScan({ id: 'new-id' }));

    const result = await resolver.enqueueScan(
      'https://www.github.com/owner/repo.git',
    );

    // Canonicalized: www. host + trailing .git stripped to the canonical form.
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('https://github.com/owner/repo');
    expect(result).toEqual(
      expect.objectContaining({ id: 'new-id', status: 'Queued' }),
    );
  });

  it('enqueues the canonical url (not the raw input) for a plain valid URL', async () => {
    const { resolver, enqueue } = makeResolver();
    enqueue.mockResolvedValue(baseScan({ id: 'new-id' }));

    await resolver.enqueueScan('https://github.com/owner/repo/');

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('https://github.com/owner/repo');
  });

  it.each([
    ['ssh scp-syntax', 'git@github.com:owner/repo'],
    ['git:// transport', 'git://github.com/owner/repo'],
    ['file:// scheme', 'file:///etc/passwd'],
    ['non-github host', 'https://evil.com/owner/repo'],
    ['look-alike host', 'https://github.com.evil.com/owner/repo'],
    ['embedded credentials', 'https://user:pass@github.com/owner/repo'],
    ['plain http', 'http://github.com/owner/repo'],
  ])('rejects %s WITHOUT calling enqueue (T-06-01)', async (_label, url) => {
    const { resolver, enqueue } = makeResolver();

    await expect(resolver.enqueueScan(url)).rejects.toThrow(
      'repoUrl must be an https://github.com/{owner}/{repo} URL',
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('ScanResolver import-guard (ARCH-01)', () => {
  it('imports none of the forbidden engine/queue/fs modules', () => {
    const source = readFileSync(
      path.resolve(__dirname, 'scan.resolver.ts'),
      'utf8',
    );
    const specifiers = importSpecifiers(source);
    for (const forbidden of [
      'node:fs',
      'fs',
      'node:child_process',
      'child_process',
      'execa',
      '@nestjs/bullmq',
    ]) {
      expect(specifiers).not.toContain(forbidden);
    }
    expect(specifiers.some((s) => s.includes('report-parser'))).toBe(false);
    expect(specifiers.some((s) => s.includes('engine/'))).toBe(false);
  });
});

/** Extract the module specifiers of `import ... from '<spec>'` statements only. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /^\s*import\b[^\n]*?from\s+['"]([^'"]+)['"]/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}
