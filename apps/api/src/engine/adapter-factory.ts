import { join } from 'node:path';

import { ReportParser } from '../parser/report-parser';
import type { Vulnerability } from '../domain/vulnerability.types';

import type { ReportParserLike } from './scan-engine';
import { RepoClonerAdapter } from './repo-cloner.adapter';
import type { RepoCloner } from './repo-cloner.port';
import { ScanPathAllocatorAdapter } from './scan-path-allocator.adapter';
import type {
  ScanPathAllocation,
  ScanPathAllocator,
} from './scan-path-allocator.port';
import {
  TempArtifactCleanerAdapter,
  type TempArtifactCleaner,
} from './temp-artifact-cleaner';
import { TrivyRunnerAdapter } from './trivy-runner.adapter';
import type { TrivyRunner, TrivyRunOptions } from './trivy-runner.port';

/**
 * Deterministic engine fault seam consumed by the Plan 04 integration harness
 * and the worker unit suite. The env-validated `SCAN_ENGINE_TEST_FAULT`
 * allowlist (`none|clone|trivy|disk-full|parse`, owned by Plan 02) is a subset;
 * `cleanup` is an additional unit-only mode reachable only through direct
 * factory calls, never through the fail-closed env schema.
 */
export const ENGINE_TEST_FAULTS = [
  'none',
  'clone',
  'trivy',
  'disk-full',
  'parse',
  'cleanup',
] as const;

export type EngineTestFault = (typeof ENGINE_TEST_FAULTS)[number];

/**
 * Fail-closed resolution of a raw fault setting: any value outside the
 * allowlist throws rather than silently degrading to a real production run
 * (ASVS V14.1, mirroring the env schema's own posture).
 */
export function resolveEngineTestFault(
  raw: string | undefined,
): EngineTestFault {
  const value = raw ?? 'none';
  if ((ENGINE_TEST_FAULTS as readonly string[]).includes(value)) {
    return value as EngineTestFault;
  }
  throw new Error(
    `Invalid SCAN_ENGINE_TEST_FAULT '${value}'; expected one of ${ENGINE_TEST_FAULTS.join(', ')}`,
  );
}

/** The five engine adapters the worker orchestrates through their ports. */
export interface EngineAdapters {
  allocator: ScanPathAllocator;
  cloner: RepoCloner;
  trivy: TrivyRunner;
  parser: ReportParserLike;
  cleaner: TempArtifactCleaner;
}

/** Loud diagnostics sink for the fault-seam guard (HIGH-02). */
export interface FaultSeamLogger {
  warn(message: string): void;
}

export interface AdapterFactoryOptions {
  /** Validated `SCAN_TMP_DIR` root — the allocator's exclusive base. */
  scanTmpDir: string;
  fault?: EngineTestFault;
  /**
   * Validated `SCAN_GIT_ALLOWED_PROTOCOLS` (CR-01) forwarded to the real clone
   * adapter as git's `GIT_ALLOW_PROTOCOL` transport allowlist. Absent → the
   * adapter's fail-closed `https`-only default.
   */
  gitAllowedProtocols?: string;
  /**
   * Composition-time environment (HIGH-02). The fault seam is INERT unless
   * `nodeEnv !== 'production'`, so a stray `SCAN_ENGINE_TEST_FAULT` can never
   * silently disable real scanning in a production build. Absent → resolved
   * from `process.env.NODE_ENV`.
   */
  nodeEnv?: string;
  /** Loud WARN sink used when the fault seam is active (or ignored in prod). */
  logger?: FaultSeamLogger;
}

/**
 * Fail-closed decision of whether the fault seam actually activates (HIGH-02).
 * A non-`none` fault engages ONLY outside production; in production it is
 * ignored (real adapters run) with a loud WARN so a misconfiguration is
 * observable rather than silent. A single-guard (env var alone) is a latent
 * production incident, so both conditions are required at composition time.
 */
export function resolveActiveEngineFault(
  requested: EngineTestFault,
  nodeEnv: string | undefined,
  logger?: FaultSeamLogger,
): EngineTestFault {
  if (requested === 'none') {
    return 'none';
  }
  if (nodeEnv === 'production') {
    logger?.warn(
      `SCAN_ENGINE_TEST_FAULT='${requested}' IGNORED in production: the engine ` +
        `fault seam is inert; real adapters will run. This env var must not be ` +
        `set in production.`,
    );
    return 'none';
  }
  logger?.warn(
    `SCAN_ENGINE_TEST_FAULT='${requested}' ACTIVE (NODE_ENV=${nodeEnv ?? 'undefined'}): ` +
      `REAL scanning is DISABLED — in-memory fault doubles are in use. This must ` +
      `NEVER happen in production.`,
  );
  return requested;
}

/**
 * Produce a `REPORT_READY <absolute-report-path>` line on worker stdout after
 * the Trivy runner confirms the report is on disk. This is the report-readiness
 * marker the Plan 04 integration harness consumes; it is intentionally DISTINCT
 * from the process-level `SCAN_WORKER_READY` bootstrap sentinel in `worker.ts`.
 */
export function reportReadyStdoutProducer(reportPath: string): Promise<void> {
  process.stdout.write(`REPORT_READY ${reportPath}\n`);
  return Promise.resolve();
}

/**
 * Build the engine adapter set. With no fault (production) it constructs ONLY
 * the real adapters. With a named fault it returns benign in-memory doubles for
 * every port except the one under test, which deterministically rejects through
 * its normal port boundary — so a single injected failure can be exercised
 * without spawning real `git`/`trivy`/`docker` or touching a real disk.
 */
export function createEngineAdapters(
  options: AdapterFactoryOptions,
): EngineAdapters {
  // HIGH-02: resolve the EFFECTIVE fault at composition time. In production the
  // seam is forced inert (real adapters), so a stray env var cannot silently
  // disable real scanning.
  const fault = resolveActiveEngineFault(
    options.fault ?? 'none',
    options.nodeEnv ?? process.env.NODE_ENV,
    options.logger,
  );
  if (fault === 'none') {
    return {
      allocator: new ScanPathAllocatorAdapter({
        scanTmpDir: options.scanTmpDir,
      }),
      cloner: new RepoClonerAdapter({
        allowedProtocols: options.gitAllowedProtocols,
      }),
      trivy: new TrivyRunnerAdapter(),
      parser: new ReportParser(),
      cleaner: new TempArtifactCleanerAdapter(),
    };
  }
  return createFaultAdapters(fault, options);
}

const SAMPLE_FINDING: Vulnerability = {
  vulnerabilityId: 'CVE-FAULT-0001',
  pkgName: 'fault-injected-package',
  installedVersion: '0.0.0',
  severity: 'CRITICAL',
  title: 'Injected fault-mode CRITICAL finding',
  primaryUrl: 'https://example.test/CVE-FAULT-0001',
};

function enospc(): NodeJS.ErrnoException {
  const error = new Error(
    'ENOSPC: no space left on device',
  ) as NodeJS.ErrnoException;
  error.code = 'ENOSPC';
  return error;
}

function createFaultAdapters(
  fault: Exclude<EngineTestFault, 'none'>,
  options: AdapterFactoryOptions,
): EngineAdapters {
  // Benign baseline: no real subprocess or filesystem work.
  const allocator: ScanPathAllocator = {
    allocate: (scanId: string): Promise<ScanPathAllocation> => {
      const base = join(options.scanTmpDir, `${scanId}-fault`);
      return Promise.resolve({
        cloneDir: join(base, 'repo'),
        reportPath: join(base, 'out', 'report.json'),
      });
    },
  };

  const cloner: RepoCloner = {
    clone: (): Promise<void> => Promise.resolve(),
  };

  const trivy: TrivyRunner = {
    run: async (
      _cloneDir: string,
      reportPath: string,
      runOptions?: TrivyRunOptions,
    ): Promise<void> => {
      if (runOptions?.onReportReady) {
        await runOptions.onReportReady(reportPath);
      }
    },
  };

  const parser: ReportParserLike = {
    // eslint-disable-next-line @typescript-eslint/require-await
    parse: async function* (): AsyncIterable<Vulnerability> {
      yield SAMPLE_FINDING;
    },
  };

  const cleaner: TempArtifactCleaner = {
    remove: (): Promise<void> => Promise.resolve(),
  };

  switch (fault) {
    case 'clone':
      cloner.clone = (): Promise<void> =>
        Promise.reject(new Error('injected clone failure'));
      break;
    case 'trivy':
      trivy.run = (): Promise<void> =>
        Promise.reject(new Error('injected trivy failure'));
      break;
    case 'disk-full':
      // ENOSPC at the clone stage is promoted to `disk-full` by the classifier.
      cloner.clone = (): Promise<void> => Promise.reject(enospc());
      break;
    case 'parse':
      // eslint-disable-next-line @typescript-eslint/require-await, require-yield
      parser.parse = async function* (): AsyncIterable<Vulnerability> {
        throw new Error('injected parser failure');
      };
      break;
    case 'cleanup':
      cleaner.remove = (): Promise<void> =>
        Promise.reject(new Error('injected cleanup failure'));
      break;
  }

  return { allocator, cloner, trivy, parser, cleaner };
}
