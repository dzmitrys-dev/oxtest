import { Redis } from 'ioredis';

import { Scan, ScanStatus } from '../domain/scan.types';
import type { Vulnerability } from '../domain/vulnerability.types';
import { ScanRepositoryAdapter } from './scan.repository';

const RETENTION_SECONDS = 7 * 24 * 60 * 60; // 604800
const TTL_FLOOR = RETENTION_SECONDS - 100; // 604700

/**
 * Disposable-Redis integration proof. Skipped unless REDIS_TEST_URL points at a
 * throwaway Redis so the default `npm test` never blocks on infrastructure
 * (plan success criterion). Provision Redis and export REDIS_TEST_URL to run it.
 */
const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
const describeRedis = REDIS_TEST_URL ? describe : describe.skip;

function queued(id: string, repoUrl: string): Scan {
  const now = new Date().toISOString();
  return {
    id,
    status: ScanStatus.Queued,
    repoUrl,
    createdAt: now,
    updatedAt: now,
  };
}

function vuln(id: string, pkg: string): Vulnerability {
  return {
    vulnerabilityId: id,
    pkgName: pkg,
    installedVersion: '1.0.0',
    severity: 'CRITICAL',
    title: `Critical ${pkg} issue`,
    primaryUrl: `https://example.invalid/${id}`,
  };
}

describeRedis('ScanRepositoryAdapter (real Redis)', () => {
  let client: Redis;
  let repo: ScanRepositoryAdapter;
  const createdIds: string[] = [];

  beforeAll(() => {
    // Never set keyPrefix (BullMQ/repository constraint) — use a raw client.
    client = new Redis(REDIS_TEST_URL as string, {
      maxRetriesPerRequest: null,
    });
    repo = new ScanRepositoryAdapter(client);
  });

  afterEach(async () => {
    for (const id of createdIds) {
      await client.del(`scan:${id}`, `scan:${id}:critical`);
    }
    createdIds.length = 0;
  });

  afterAll(async () => {
    await client.quit();
  });

  function track(id: string): string {
    createdIds.push(id);
    return id;
  }

  it('reconstructs hash + ordered list and refreshes seven-day TTL on both keys', async () => {
    const id = track(`it-${Date.now()}-recon`);
    await repo.create(queued(id, 'https://example.invalid/repo.git'));
    await repo.markScanning(id);
    await repo.appendVulnerability(id, vuln('CVE-1', 'openssl'));
    await repo.appendVulnerability(id, vuln('CVE-2', 'glibc'));
    await repo.markFinished(id);

    const scan = await repo.get(id);
    expect(scan?.status).toBe(ScanStatus.Finished);
    expect(scan?.vulnerabilities?.map((v) => v.vulnerabilityId)).toEqual([
      'CVE-1',
      'CVE-2',
    ]);

    const hashTtl = await client.ttl(`scan:${id}`);
    const listTtl = await client.ttl(`scan:${id}:critical`);
    expect(hashTtl).toBeGreaterThanOrEqual(TTL_FLOOR);
    expect(hashTtl).toBeLessThanOrEqual(RETENTION_SECONDS);
    expect(listTtl).toBeGreaterThanOrEqual(TTL_FLOOR);
    expect(listTtl).toBeLessThanOrEqual(RETENTION_SECONDS);
  });

  it('returns null for a missing scan', async () => {
    await expect(repo.get(`absent-${Date.now()}`)).resolves.toBeNull();
  });

  it('guards terminal state against a late duplicate mutation', async () => {
    const id = track(`it-${Date.now()}-terminal`);
    await repo.create(queued(id, 'https://example.invalid/repo.git'));
    await repo.markScanning(id);
    await repo.markFailed(id, { category: 'trivy', detail: 'genuine failure' });
    await repo.markFinished(id); // must be rejected by the terminal guard

    const scan = await repo.get(id);
    expect(scan?.status).toBe(ScanStatus.Failed);
    expect(scan?.error).toEqual({
      category: 'trivy',
      detail: 'genuine failure',
    });
  });
});
