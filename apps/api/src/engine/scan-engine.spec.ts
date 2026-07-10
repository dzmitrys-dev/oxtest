import type { ScanFailureReason } from '../domain/scan.types';
import type { Vulnerability } from '../domain/vulnerability.types';
import type { ScanRepository } from '../scan/scan.repository.port';
import type { ScanJob } from '../scan/scan.types';
import type { RepoCloner } from './repo-cloner.port';
import type {
  ScanPathAllocation,
  ScanPathAllocator,
} from './scan-path-allocator.port';
import type { TempArtifactCleaner } from './temp-artifact-cleaner';
import type { TrivyRunner, TrivyRunOptions } from './trivy-runner.port';

import {
  createEngineAdapters,
  resolveEngineTestFault,
} from './adapter-factory';
import { RepoClonerAdapter } from './repo-cloner.adapter';
import { ReportParser } from '../parser/report-parser';
import {
  ScanEngine,
  type ReportParserLike,
  type ScanEngineDeps,
} from './scan-engine';
import { ScanPathAllocatorAdapter } from './scan-path-allocator.adapter';
import { TempArtifactCleanerAdapter } from './temp-artifact-cleaner';
import { TrivyRunnerAdapter } from './trivy-runner.adapter';

const JOB: ScanJob = { scanId: 'scan-123', repoUrl: 'https://example.test/r.git' };
const ALLOCATION: ScanPathAllocation = {
  cloneDir: '/tmp/scan/scan-123-x/repo',
  reportPath: '/tmp/scan/scan-123-x/out/report.json',
};

function vuln(id: string): Vulnerability {
  return {
    vulnerabilityId: id,
    pkgName: 'pkg',
    installedVersion: '1.0.0',
    severity: 'CRITICAL',
    title: `title-${id}`,
    primaryUrl: `https://example.test/${id}`,
  };
}

function enospcError(message = 'ENOSPC: no space left on device'): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'ENOSPC';
  return error;
}

/** Sequence-recording fake repository implementing the framework-free port. */
class FakeRepository implements ScanRepository {
  readonly events: string[];
  readonly appended: Vulnerability[] = [];
  markFailedReason: ScanFailureReason | undefined;
  markFinishedCount = 0;
  markFailShouldThrow = false;

  constructor(events: string[]) {
    this.events = events;
  }

  create(): Promise<void> {
    return Promise.resolve();
  }

  get(): Promise<null> {
    return Promise.resolve(null);
  }

  markScanning(): Promise<void> {
    this.events.push('markScanning');
    return Promise.resolve();
  }

  appendVulnerability(_id: string, vulnerability: Vulnerability): Promise<void> {
    this.events.push(`append:${vulnerability.vulnerabilityId}`);
    this.appended.push(vulnerability);
    return Promise.resolve();
  }

  markFinished(): Promise<void> {
    this.events.push('markFinished');
    this.markFinishedCount += 1;
    return Promise.resolve();
  }

  markFailed(_id: string, reason: ScanFailureReason): Promise<void> {
    this.events.push(`markFailed:${reason.category}`);
    this.markFailedReason = reason;
    if (this.markFailShouldThrow) {
      return Promise.reject(new Error('secondary markFailed failure'));
    }
    return Promise.resolve();
  }
}

interface Fakes {
  events: string[];
  repository: FakeRepository;
  allocator: ScanPathAllocator;
  cloner: RepoCloner;
  trivy: TrivyRunner;
  parser: ReportParserLike;
  cleaner: TempArtifactCleaner & { calls: number };
}

interface FakeOverrides {
  yields?: Vulnerability[];
  clone?: (repoUrl: string, cloneDir: string) => Promise<void>;
  trivyRun?: (
    cloneDir: string,
    reportPath: string,
    options?: TrivyRunOptions,
  ) => Promise<void>;
  parse?: (reportPath: string) => AsyncIterable<Vulnerability>;
  remove?: (cloneDir: string, reportPath: string) => Promise<void>;
  allocate?: (scanId: string) => Promise<ScanPathAllocation>;
}

function makeFakes(overrides: FakeOverrides = {}): Fakes {
  const events: string[] = [];
  const repository = new FakeRepository(events);
  const yields = overrides.yields ?? [vuln('CVE-1'), vuln('CVE-2'), vuln('CVE-3')];

  const allocator: ScanPathAllocator = {
    allocate:
      overrides.allocate ??
      ((): Promise<ScanPathAllocation> => Promise.resolve(ALLOCATION)),
  };

  const cloner: RepoCloner = {
    clone:
      overrides.clone ??
      ((): Promise<void> => {
        events.push('clone');
        return Promise.resolve();
      }),
  };

  const trivy: TrivyRunner = {
    run:
      overrides.trivyRun ??
      (async (
        _cloneDir: string,
        reportPath: string,
        options?: TrivyRunOptions,
      ): Promise<void> => {
        events.push('trivy.run');
        if (options?.onReportReady) {
          await options.onReportReady(reportPath);
          events.push('onReportReady');
        }
      }),
  };

  const parser: ReportParserLike = {
    parse:
      overrides.parse ??
      // eslint-disable-next-line @typescript-eslint/require-await
      (async function* (): AsyncIterable<Vulnerability> {
        events.push('parse:start');
        for (const item of yields) {
          yield item;
        }
      }),
  };

  const cleaner: TempArtifactCleaner & { calls: number } = {
    calls: 0,
    remove:
      overrides.remove ??
      function (this: { calls: number }): Promise<void> {
        events.push('cleanup');
        this.calls += 1;
        return Promise.resolve();
      },
  };
  // Ensure `calls` increments even when a custom remove is provided.
  if (overrides.remove) {
    const custom = overrides.remove;
    cleaner.remove = function (
      this: { calls: number },
      cloneDir: string,
      reportPath: string,
    ): Promise<void> {
      events.push('cleanup');
      this.calls += 1;
      return custom(cloneDir, reportPath);
    };
  }

  return { events, repository, allocator, cloner, trivy, parser, cleaner };
}

function makeEngine(fakes: Fakes, extra: Partial<ScanEngineDeps> = {}): ScanEngine {
  return new ScanEngine({
    repository: fakes.repository,
    allocator: fakes.allocator,
    cloner: fakes.cloner,
    trivy: fakes.trivy,
    parser: fakes.parser,
    cleaner: fakes.cleaner,
    ...extra,
  });
}

describe('ScanEngine — concurrency-one lifecycle', () => {
  it('Test 1: marks Scanning, clones, runs Trivy, appends in order, Finished last', async () => {
    const fakes = makeFakes();
    await makeEngine(fakes).run(JOB);

    expect(fakes.events).toEqual([
      'markScanning',
      'clone',
      'trivy.run',
      'parse:start',
      'append:CVE-1',
      'append:CVE-2',
      'append:CVE-3',
      'markFinished',
    ]);
    // Scanning happens before any engine work.
    expect(fakes.events[0]).toBe('markScanning');
    // Finished only after the final append.
    expect(fakes.events.indexOf('markFinished')).toBeGreaterThan(
      fakes.events.indexOf('append:CVE-3'),
    );
    // Ordered awaited appends preserve discovery order.
    expect(fakes.repository.appended.map((v) => v.vulnerabilityId)).toEqual([
      'CVE-1',
      'CVE-2',
      'CVE-3',
    ]);
    expect(fakes.cleaner.calls).toBe(1);
    expect(fakes.repository.markFailedReason).toBeUndefined();
  });

  it('Test 2a: onReportReady resolves before ReportParser.parse is called', async () => {
    const fakes = makeFakes();
    await makeEngine(fakes, {
      onReportReady: (reportPath: string): Promise<void> => {
        expect(reportPath).toBe(ALLOCATION.reportPath);
        return Promise.resolve();
      },
    }).run(JOB);

    expect(fakes.events.indexOf('onReportReady')).toBeLessThan(
      fakes.events.indexOf('parse:start'),
    );
  });

  it('Test 2b: a parser rejection still reaches Failed and cleanup', async () => {
    const boom = new Error('parser exploded');
    const fakes = makeFakes({
      // eslint-disable-next-line @typescript-eslint/require-await, require-yield
      parse: async function* (): AsyncIterable<Vulnerability> {
        throw boom;
      },
    });

    await expect(makeEngine(fakes).run(JOB)).rejects.toBe(boom);
    expect(fakes.repository.markFailedReason?.category).toBe('parse');
    expect(fakes.cleaner.calls).toBe(1);
    expect(fakes.repository.markFinishedCount).toBe(0);
  });

  it('Test 3: findings are success; genuine Trivy rejection is Failed and rethrown without retry', async () => {
    // Findings-as-success: a normal run with findings finishes, never fails.
    const ok = makeFakes({ yields: [vuln('CVE-9')] });
    await makeEngine(ok).run(JOB);
    expect(ok.repository.markFinishedCount).toBe(1);
    expect(ok.repository.markFailedReason).toBeUndefined();

    // Genuine Trivy rejection: Failed(trivy), rethrown, and run invoked once.
    const trivyError = new Error('trivy scan failed');
    let runCount = 0;
    const bad = makeFakes({
      trivyRun: (): Promise<void> => {
        runCount += 1;
        return Promise.reject(trivyError);
      },
    });
    await expect(makeEngine(bad).run(JOB)).rejects.toBe(trivyError);
    expect(bad.repository.markFailedReason?.category).toBe('trivy');
    expect(runCount).toBe(1);
    expect(bad.cleaner.calls).toBe(1);
  });

  it('Test 4a: clone failure marks Failed(clone), rethrows original, cleans once', async () => {
    const cloneError = new Error('git clone failed');
    const fakes = makeFakes({
      clone: (): Promise<void> => Promise.reject(cloneError),
    });
    await expect(makeEngine(fakes).run(JOB)).rejects.toBe(cloneError);
    expect(fakes.repository.markFailedReason?.category).toBe('clone');
    expect(fakes.cleaner.calls).toBe(1);
  });

  it('Test 4b: ENOSPC anywhere is promoted to disk-full', async () => {
    const diskError = enospcError();
    const fakes = makeFakes({
      clone: (): Promise<void> => Promise.reject(diskError),
    });
    await expect(makeEngine(fakes).run(JOB)).rejects.toBe(diskError);
    expect(fakes.repository.markFailedReason?.category).toBe('disk-full');
    expect(fakes.cleaner.calls).toBe(1);
  });

  it('Test 4c: parser failure mid-iteration keeps prior appends and cleans once', async () => {
    const midError = new Error('parse blew up mid-stream');
    const fakes = makeFakes({
      parse: async function* (): AsyncIterable<Vulnerability> {
        yield vuln('CVE-A');
        await Promise.resolve();
        throw midError;
      },
    });
    await expect(makeEngine(fakes).run(JOB)).rejects.toBe(midError);
    expect(fakes.repository.appended.map((v) => v.vulnerabilityId)).toEqual([
      'CVE-A',
    ]);
    expect(fakes.repository.markFailedReason?.category).toBe('parse');
    expect(fakes.cleaner.calls).toBe(1);
    expect(fakes.repository.markFinishedCount).toBe(0);
  });

  it('Test 4d: a secondary cleanup failure never masks the original engine error', async () => {
    const primary = new Error('primary trivy failure');
    const fakes = makeFakes({
      trivyRun: (): Promise<void> => Promise.reject(primary),
      remove: (): Promise<void> =>
        Promise.reject(new Error('cleanup also failed')),
    });
    // The ORIGINAL error is rethrown, not the cleanup error.
    await expect(makeEngine(fakes).run(JOB)).rejects.toBe(primary);
    expect(fakes.repository.markFailedReason?.category).toBe('trivy');
    expect(fakes.cleaner.calls).toBe(1);
  });

  it('Test 4e: allocator rejection is owned by the allocator; worker cleanup is not called', async () => {
    const allocError = enospcError('ENOSPC during allocation');
    const fakes = makeFakes({
      allocate: (): Promise<ScanPathAllocation> => Promise.reject(allocError),
    });
    await expect(makeEngine(fakes).run(JOB)).rejects.toBe(allocError);
    // Allocator owns partial-allocation cleanup — the worker has no pair to clean.
    expect(fakes.cleaner.calls).toBe(0);
    // ENOSPC still promoted to disk-full on persistence.
    expect(fakes.repository.markFailedReason?.category).toBe('disk-full');
  });

  it('a failure-persistence error does not replace the original engine error', async () => {
    const primary = new Error('primary clone failure');
    const fakes = makeFakes({
      clone: (): Promise<void> => Promise.reject(primary),
    });
    fakes.repository.markFailShouldThrow = true;
    await expect(makeEngine(fakes).run(JOB)).rejects.toBe(primary);
    expect(fakes.cleaner.calls).toBe(1);
  });
});

describe('adapter-factory — production/test-fault construction', () => {
  it('Test 5a: production (no fault) constructs only the real adapters', () => {
    const adapters = createEngineAdapters({ scanTmpDir: '/tmp/scan', fault: 'none' });
    expect(adapters.allocator).toBeInstanceOf(ScanPathAllocatorAdapter);
    expect(adapters.cloner).toBeInstanceOf(RepoClonerAdapter);
    expect(adapters.trivy).toBeInstanceOf(TrivyRunnerAdapter);
    expect(adapters.parser).toBeInstanceOf(ReportParser);
    expect(adapters.cleaner).toBeInstanceOf(TempArtifactCleanerAdapter);
  });

  it('Test 5a: an absent fault setting defaults to production adapters', () => {
    const adapters = createEngineAdapters({ scanTmpDir: '/tmp/scan' });
    expect(adapters.cloner).toBeInstanceOf(RepoClonerAdapter);
    expect(adapters.trivy).toBeInstanceOf(TrivyRunnerAdapter);
  });

  it.each([
    ['clone', 'clone'],
    ['trivy', 'trivy'],
    ['disk-full', 'disk-full'],
    ['parse', 'parse'],
  ] as const)(
    'Test 5b: fault "%s" injects a %s failure through the port boundary',
    async (fault, expectedCategory) => {
      const events: string[] = [];
      const repository = new FakeRepository(events);
      const adapters = createEngineAdapters({
        scanTmpDir: '/tmp/scan',
        fault,
      });
      const engine = new ScanEngine({ repository, ...adapters });
      await expect(engine.run(JOB)).rejects.toBeInstanceOf(Error);
      expect(repository.markFailedReason?.category).toBe(expectedCategory);
    },
  );

  it('Test 5c: fault "cleanup" fails cleanup only; findings remain a success', async () => {
    const events: string[] = [];
    const repository = new FakeRepository(events);
    const adapters = createEngineAdapters({
      scanTmpDir: '/tmp/scan',
      fault: 'cleanup',
    });
    const engine = new ScanEngine({ repository, ...adapters });
    // Cleanup failure must never mask a successful scan (D-23).
    await expect(engine.run(JOB)).resolves.toBeUndefined();
    expect(repository.markFinishedCount).toBe(1);
    expect(repository.markFailedReason).toBeUndefined();
  });

  it('resolveEngineTestFault accepts the allowlist and rejects anything else (fail-closed)', () => {
    expect(resolveEngineTestFault(undefined)).toBe('none');
    expect(resolveEngineTestFault('clone')).toBe('clone');
    expect(resolveEngineTestFault('disk-full')).toBe('disk-full');
    expect(() => resolveEngineTestFault('bogus')).toThrow(/SCAN_ENGINE_TEST_FAULT/);
  });
});
