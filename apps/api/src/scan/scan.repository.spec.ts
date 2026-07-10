import type { Redis } from 'ioredis';

import { Scan, ScanStatus } from '../domain/scan.types';
import type { Vulnerability } from '../domain/vulnerability.types';
import { ScanRepositoryAdapter } from './scan.repository';

const RETENTION_SECONDS = 7 * 24 * 60 * 60; // 604800

/**
 * Minimal in-memory ioredis double supporting the exact command subset the
 * adapter uses, with real optimistic-locking (WATCH/MULTI/EXEC) semantics and a
 * one-shot pre-exec hook so a concurrent writer can be injected deterministically.
 */
class FakeRedis {
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly lists = new Map<string, string[]>();
  private readonly ttls = new Map<string, number>();
  private readonly versions = new Map<string, number>();
  private watched: Map<string, number> | null = null;
  private readonly beforeExecHooks: Array<() => void> = [];

  execAttempts = 0;

  /** Register a one-shot callback that runs immediately before the next EXEC. */
  injectBeforeNextExec(hook: () => void): void {
    this.beforeExecHooks.push(hook);
  }

  private bump(key: string): void {
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }

  private exists(key: string): boolean {
    return this.hashes.has(key) || this.lists.has(key);
  }

  _hset(key: string, value: Record<string, string>): void {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, fieldValue] of Object.entries(value)) {
      hash.set(field, fieldValue);
    }
    this.hashes.set(key, hash);
    this.bump(key);
  }

  _del(key: string): void {
    this.hashes.delete(key);
    this.lists.delete(key);
    this.ttls.delete(key);
    this.bump(key);
  }

  _rpush(key: string, values: string[]): void {
    const list = this.lists.get(key) ?? [];
    list.push(...values);
    this.lists.set(key, list);
    this.bump(key);
  }

  _expire(key: string, seconds: number): void {
    if (!this.exists(key)) {
      return;
    }
    this.ttls.set(key, seconds);
    this.bump(key);
  }

  watch(key: string): Promise<'OK'> {
    const watched = this.watched ?? new Map<string, number>();
    watched.set(key, this.versions.get(key) ?? 0);
    this.watched = watched;
    return Promise.resolve('OK');
  }

  unwatch(): Promise<'OK'> {
    this.watched = null;
    return Promise.resolve('OK');
  }

  hget(key: string, field: string): Promise<string | null> {
    return Promise.resolve(this.hashes.get(key)?.get(field) ?? null);
  }

  hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.hashes.get(key);
    if (!hash) {
      return Promise.resolve({});
    }
    return Promise.resolve(Object.fromEntries(hash));
  }

  lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const end = stop === -1 ? list.length : stop + 1;
    return Promise.resolve(list.slice(start, end));
  }

  ttl(key: string): Promise<number> {
    if (!this.exists(key)) {
      return Promise.resolve(-2);
    }
    return Promise.resolve(this.ttls.get(key) ?? -1);
  }

  multi(): FakeMulti {
    const watched = this.watched ?? new Map<string, number>();
    return new FakeMulti(this, watched);
  }

  _exec(
    watched: Map<string, number>,
    ops: Array<() => void>,
  ): Promise<Array<[Error | null, unknown]> | null> {
    this.execAttempts += 1;
    const hook = this.beforeExecHooks.shift();
    if (hook) {
      hook();
    }
    for (const [key, version] of watched) {
      if ((this.versions.get(key) ?? 0) !== version) {
        this.watched = null;
        return Promise.resolve(null); // WATCH conflict
      }
    }
    const results: Array<[Error | null, unknown]> = ops.map((op) => {
      op();
      return [null, 'OK'];
    });
    this.watched = null;
    return Promise.resolve(results);
  }
}

class FakeMulti {
  private readonly ops: Array<() => void> = [];

  constructor(
    private readonly db: FakeRedis,
    private readonly watched: Map<string, number>,
  ) {}

  hset(key: string, value: Record<string, string>): this {
    this.ops.push(() => this.db._hset(key, value));
    return this;
  }

  del(key: string): this {
    this.ops.push(() => this.db._del(key));
    return this;
  }

  rpush(key: string, ...values: string[]): this {
    this.ops.push(() => this.db._rpush(key, values));
    return this;
  }

  expire(key: string, seconds: number): this {
    this.ops.push(() => this.db._expire(key, seconds));
    return this;
  }

  exec(): Promise<Array<[Error | null, unknown]> | null> {
    return this.db._exec(this.watched, this.ops);
  }
}

function makeRepo(): { repo: ScanRepositoryAdapter; fake: FakeRedis } {
  const fake = new FakeRedis();
  const repo = new ScanRepositoryAdapter(fake as unknown as Redis);
  return { repo, fake };
}

function queued(id: string, repoUrl: string): Scan {
  const now = new Date('2026-07-10T00:00:00.000Z').toISOString();
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

describe('ScanRepositoryAdapter (fake Redis)', () => {
  it('reconstructs metadata and CRITICAL vulnerabilities in discovery order', async () => {
    const { repo } = makeRepo();
    await repo.create(queued('scan-1', 'https://example.invalid/repo.git'));
    await repo.markScanning('scan-1');
    await repo.appendVulnerability('scan-1', vuln('CVE-1', 'openssl'));
    await repo.appendVulnerability('scan-1', vuln('CVE-2', 'glibc'));
    await repo.appendVulnerability('scan-1', vuln('CVE-3', 'curl'));
    await repo.markFinished('scan-1');

    const scan = await repo.get('scan-1');
    expect(scan).not.toBeNull();
    expect(scan?.status).toBe(ScanStatus.Finished);
    expect(scan?.repoUrl).toBe('https://example.invalid/repo.git');
    expect(scan?.vulnerabilities?.map((v) => v.vulnerabilityId)).toEqual([
      'CVE-1',
      'CVE-2',
      'CVE-3',
    ]);
    expect(scan?.vulnerabilities?.[0]).toEqual(vuln('CVE-1', 'openssl'));
  });

  it('returns null for a missing scan hash rather than a synthesized record', async () => {
    const { repo } = makeRepo();
    await expect(repo.get('does-not-exist')).resolves.toBeNull();
  });

  it('refreshes a seven-day TTL on both keys after every write', async () => {
    const { repo, fake } = makeRepo();
    const expectFreshTtls = async (): Promise<void> => {
      expect(await fake.ttl('scan:scan-2')).toBe(RETENTION_SECONDS);
      expect(await fake.ttl('scan:scan-2:critical')).toBe(RETENTION_SECONDS);
    };

    await repo.create(queued('scan-2', 'https://example.invalid/repo.git'));
    await expectFreshTtls();

    await repo.markScanning('scan-2');
    await expectFreshTtls();

    await repo.appendVulnerability('scan-2', vuln('CVE-9', 'zlib'));
    await expectFreshTtls();

    await repo.markFinished('scan-2');
    await expectFreshTtls();
  });

  it('refreshes both TTLs when marking Failed with a bounded reason', async () => {
    const { repo, fake } = makeRepo();
    await repo.create(queued('scan-3', 'https://example.invalid/repo.git'));
    await repo.markScanning('scan-3');
    await repo.markFailed('scan-3', {
      category: 'clone',
      detail: 'git exited 128',
    });

    expect(await fake.ttl('scan:scan-3')).toBe(RETENTION_SECONDS);
    expect(await fake.ttl('scan:scan-3:critical')).toBe(RETENTION_SECONDS);
    const scan = await repo.get('scan-3');
    expect(scan?.status).toBe(ScanStatus.Failed);
    expect(scan?.error).toEqual({
      category: 'clone',
      detail: 'git exited 128',
    });
  });

  it('caps a persisted failure detail at 500 characters', async () => {
    const { repo } = makeRepo();
    await repo.create(queued('scan-cap', 'https://example.invalid/repo.git'));
    await repo.markFailed('scan-cap', {
      category: 'trivy',
      detail: 'x'.repeat(2000),
    });

    const scan = await repo.get('scan-cap');
    expect(scan?.error?.detail.length).toBe(500);
  });

  it('preserves the first terminal state: Finished is not overwritten by Failed', async () => {
    const { repo } = makeRepo();
    await repo.create(queued('scan-4', 'https://example.invalid/repo.git'));
    await repo.markScanning('scan-4');
    await repo.markFinished('scan-4');
    await repo.markFailed('scan-4', {
      category: 'trivy',
      detail: 'late failure',
    });

    const scan = await repo.get('scan-4');
    expect(scan?.status).toBe(ScanStatus.Finished);
    expect(scan?.error).toBeUndefined();
  });

  it('preserves the first terminal state: Failed is not overwritten by Finished', async () => {
    const { repo } = makeRepo();
    await repo.create(queued('scan-5', 'https://example.invalid/repo.git'));
    await repo.markScanning('scan-5');
    await repo.markFailed('scan-5', {
      category: 'parse',
      detail: 'truncated JSON',
    });
    await repo.markFinished('scan-5');

    const scan = await repo.get('scan-5');
    expect(scan?.status).toBe(ScanStatus.Failed);
    expect(scan?.error).toEqual({
      category: 'parse',
      detail: 'truncated JSON',
    });
  });

  it('rejects appends once a scan is terminal', async () => {
    const { repo } = makeRepo();
    await repo.create(queued('scan-6', 'https://example.invalid/repo.git'));
    await repo.markScanning('scan-6');
    await repo.markFinished('scan-6');
    await repo.appendVulnerability('scan-6', vuln('CVE-LATE', 'openssl'));

    const scan = await repo.get('scan-6');
    expect(scan?.vulnerabilities ?? []).toEqual([]);
  });

  it('a stale read cannot overwrite a terminal state committed by a concurrent writer', async () => {
    const { repo, fake } = makeRepo();
    await repo.create(queued('scan-7', 'https://example.invalid/repo.git'));
    await repo.markScanning('scan-7');

    // While a markFinished transaction is mid-flight (already read Scanning),
    // a concurrent writer commits Failed, invalidating the watched key.
    fake.injectBeforeNextExec(() => {
      fake._hset('scan:scan-7', {
        status: ScanStatus.Failed,
        error: JSON.stringify({ category: 'trivy', detail: 'genuine failure' }),
      });
    });

    await repo.markFinished('scan-7');

    const scan = await repo.get('scan-7');
    expect(scan?.status).toBe(ScanStatus.Failed);
    expect(scan?.error).toEqual({
      category: 'trivy',
      detail: 'genuine failure',
    });
  });

  it('retries a WATCH conflict and still commits a non-terminal transition', async () => {
    const { repo, fake } = makeRepo();
    await repo.create(queued('scan-8', 'https://example.invalid/repo.git'));
    await repo.markScanning('scan-8');

    // A non-terminal concurrent touch bumps the watched version once; the
    // adapter must retry and then succeed rather than losing the write.
    fake.injectBeforeNextExec(() => {
      fake._hset('scan:scan-8', { updatedAt: '2026-07-10T00:00:01.000Z' });
    });

    const attemptsBefore = fake.execAttempts;
    await repo.markFinished('scan-8');

    expect(fake.execAttempts).toBeGreaterThan(attemptsBefore + 1);
    const scan = await repo.get('scan-8');
    expect(scan?.status).toBe(ScanStatus.Finished);
  });
});
