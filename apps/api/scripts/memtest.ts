import { existsSync, statSync } from 'node:fs';

import { ReportParser } from '../src/parser/report-parser';

// RSS includes native stream buffers and the Node runtime; keep a documented margin
// above the 150MB V8 heap cap while still failing on unbounded report materialization.
const RSS_THRESHOLD_MB = 240;
const SAMPLE_INTERVAL_MS = 200;
const DEFAULT_MIN_CRITICAL_COUNT = 1;

interface MemoryPeaks {
  rss: number;
  heapUsed: number;
  external: number;
}

function sample(peaks: MemoryPeaks): void {
  const memory = process.memoryUsage();
  peaks.rss = Math.max(peaks.rss, memory.rss);
  peaks.heapUsed = Math.max(peaks.heapUsed, memory.heapUsed);
  peaks.external = Math.max(peaks.external, memory.external);
}

function validateFixturePath(value: string | undefined): string {
  if (!value || value.trim() === '' || value.includes('\0')) {
    throw new Error('Usage: memtest <fixture-path>');
  }
  if (!existsSync(value) || !statSync(value).isFile()) {
    throw new Error(`Fixture is not a readable file: ${value}`);
  }
  return value;
}

function parseCount(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized === '' || !/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(normalized);
}

export function configuredCriticalCount(): { minimum: number; expected?: number } {
  const expected = parseCount(
    process.env.MEMTEST_EXPECTED_CRITICAL_COUNT,
    'MEMTEST_EXPECTED_CRITICAL_COUNT',
  );
  const configuredMinimum = parseCount(
    process.env.MEMTEST_MIN_CRITICAL_COUNT,
    'MEMTEST_MIN_CRITICAL_COUNT',
  );
  return {
    minimum: expected ?? configuredMinimum ?? DEFAULT_MIN_CRITICAL_COUNT,
    ...(expected === undefined ? {} : { expected }),
  };
}

export async function runMemoryTest(
  fixturePath: string,
  criticalCountConfig = configuredCriticalCount(),
): Promise<void> {
  const peaks: MemoryPeaks = { rss: 0, heapUsed: 0, external: 0 };
  sample(peaks);
  const sampler = setInterval(() => sample(peaks), SAMPLE_INTERVAL_MS);
  let criticalCount = 0;

  try {
    for await (const _vulnerability of new ReportParser().parse(fixturePath)) {
      criticalCount += 1;
    }
  } finally {
    clearInterval(sampler);
    sample(peaks);
  }

  if (criticalCount < criticalCountConfig.minimum) {
    throw new Error(
      `Memory proof parsed ${criticalCount} CRITICAL vulnerabilities; expected at least ${criticalCountConfig.minimum}`,
    );
  }
  if (
    criticalCountConfig.expected !== undefined &&
    criticalCount !== criticalCountConfig.expected
  ) {
    throw new Error(
      `Memory proof parsed ${criticalCount} CRITICAL vulnerabilities; expected exactly ${criticalCountConfig.expected}`,
    );
  }

  const metrics = {
    fixturePath,
    criticalCount,
    peakRssMb: Number((peaks.rss / 1024 / 1024).toFixed(1)),
    peakHeapUsedMb: Number((peaks.heapUsed / 1024 / 1024).toFixed(1)),
    peakExternalMb: Number((peaks.external / 1024 / 1024).toFixed(1)),
    rssThresholdMb: RSS_THRESHOLD_MB,
  };
  console.log(JSON.stringify(metrics));
  if (metrics.peakRssMb > RSS_THRESHOLD_MB) {
    throw new Error(`Peak RSS ${metrics.peakRssMb}MB exceeds ${RSS_THRESHOLD_MB}MB threshold`);
  }
}

async function main(): Promise<void> {
  await runMemoryTest(validateFixturePath(process.argv[2]));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
