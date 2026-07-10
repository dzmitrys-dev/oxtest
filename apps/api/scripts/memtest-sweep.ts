import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';

const DEFAULT_SIZES_MB = [50, 200, 500] as const;
const ONE_GB_SIZE_MB = 1024;
// The largest case may exceed the smallest baseline by this fixed allocator margin.
const RSS_BAND_MB = 40;
const FIXTURE_PREFIX = '/tmp/oxtest-phase2-sweep-';
const COMPILED_SCRIPT_DIR = resolve(__dirname.endsWith('/dist/scripts') ? __dirname : resolve(__dirname, '../dist/scripts'));
const RUNTIME_SCRIPT_DIR = existsSync(resolve(COMPILED_SCRIPT_DIR, 'memtest.js'))
  ? COMPILED_SCRIPT_DIR
  : __dirname;
const SCRIPT_LAUNCH_ARGS = RUNTIME_SCRIPT_DIR === COMPILED_SCRIPT_DIR
  ? []
  : [resolve(__dirname, '../../../node_modules/tsx/dist/cli.mjs')];
const MEMTEST_PATH = resolve(RUNTIME_SCRIPT_DIR, RUNTIME_SCRIPT_DIR === COMPILED_SCRIPT_DIR ? 'memtest.js' : 'memtest.ts');

function validateSize(size: number): void {
  if (!Number.isInteger(size) || size <= 0 || size > 2048) {
    throw new Error(`Invalid sweep size: ${size}`);
  }
}

function validateChildArguments(args: readonly string[]): void {
  if (args.length === 0 || args.some((arg) => arg.trim() === '' || arg.includes('\0'))) {
    throw new Error('Child process arguments must be non-empty strings without NUL bytes');
  }
}

function generatorArguments(sizeMb: number, fixturePath: string): string[] {
  validateSize(sizeMb);
  const args = [
    ...SCRIPT_LAUNCH_ARGS,
    resolve(RUNTIME_SCRIPT_DIR, RUNTIME_SCRIPT_DIR === COMPILED_SCRIPT_DIR ? 'gen-fixture.js' : 'gen-fixture.ts'),
    '--size-mb',
    String(sizeMb),
    '--output',
    fixturePath,
  ];
  validateChildArguments(args);
  return args;
}

function memtestArguments(fixturePath: string): string[] {
  const args = [...SCRIPT_LAUNCH_ARGS, MEMTEST_PATH, fixturePath];
  validateChildArguments(args);
  return args;
}

function parseArguments(argv: string[]): { sizes: readonly number[]; dryRun: boolean } {
  const dryRun = argv.includes('--dry-run');
  const includeOneGb = argv.includes('--include-1gb');
  const unknown = argv.filter((arg) => !['--dry-run', '--include-1gb'].includes(arg));
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  const sizes = includeOneGb ? [...DEFAULT_SIZES_MB, ONE_GB_SIZE_MB] : DEFAULT_SIZES_MB;
  sizes.forEach(validateSize);
  return { sizes, dryRun };
}

async function runProcess(args: string[], captureOutput: boolean): Promise<string> {
  validateChildArguments(args);
  const child = spawn(process.execPath, args, {
    shell: false,
    stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
  });
  let stdout = '';
  let stderr = '';
  if (captureOutput) {
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  }
  const [exitCode] = await once(child, 'close');
  if (exitCode !== 0) throw new Error(stderr || `Child process failed with exit code ${exitCode}`);
  return stdout;
}

async function runCase(sizeMb: number, dryRun: boolean): Promise<number | undefined> {
  const fixturePath = `${FIXTURE_PREFIX}${sizeMb}mb.json`;
  if (dryRun) {
    console.log(JSON.stringify({ sizeMb, fixturePath, rssBandMb: RSS_BAND_MB, dryRun: true }));
    return undefined;
  }

  try {
    await runProcess(generatorArguments(sizeMb, fixturePath), false);
    const stdout = await runProcess(memtestArguments(fixturePath), true);
    console.log(stdout.trim());
    const metrics = JSON.parse(stdout) as { peakRssMb?: unknown };
    if (typeof metrics.peakRssMb !== 'number' || !Number.isFinite(metrics.peakRssMb)) {
      throw new Error(`Memory test did not report a numeric peak RSS for ${sizeMb}MB`);
    }
    return metrics.peakRssMb;
  } finally {
    if (existsSync(fixturePath)) unlinkSync(fixturePath);
  }
}

async function main(): Promise<void> {
  const { sizes, dryRun } = parseArguments(process.argv.slice(2));
  let baselineRssMb: number | undefined;
  for (const size of sizes) {
    const peakRssMb = await runCase(size, dryRun);
    if (peakRssMb !== undefined) {
      baselineRssMb ??= peakRssMb;
      if (peakRssMb > baselineRssMb + RSS_BAND_MB) {
        throw new Error(
          `Peak RSS ${peakRssMb}MB exceeds baseline ${baselineRssMb}MB plus ${RSS_BAND_MB}MB band`,
        );
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
