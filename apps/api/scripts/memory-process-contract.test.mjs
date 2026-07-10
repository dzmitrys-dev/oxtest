import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import test from 'node:test';

const source = await readFile(new URL('./memtest-sweep.ts', import.meta.url), 'utf8');
const { runCase, runProcess } = await import('./memtest-sweep.ts');
const generatorPath = new URL('./gen-fixture.ts', import.meta.url).pathname;
const memtestPath = new URL('./memtest.ts', import.meta.url).pathname;
const { assertRssWithinThreshold } = await import('./memory-threshold.ts');

function runGenerator(args) {
  return runProcess(['--import', 'tsx', generatorPath, ...args], true);
}

test('memory sweep uses validated argv arrays and disables shell execution', () => {
  assert.match(source, /spawn\(\s*process\.execPath/);
  assert.match(source, /\{\s*shell: false/);
  assert.match(source, /validateSize/);
  assert.match(source, /validateChildArguments/);
  assert.ok(source.indexOf('validateChildArguments') < source.indexOf('spawn('));
  assert.ok(source.indexOf('generatorArguments') < source.indexOf('spawn('));
  assert.ok(source.indexOf('memtestArguments') < source.indexOf('spawn('));
  assert.doesNotMatch(source, /exec\(|execFile\([^,]+,\s*['"`]/);
  assert.doesNotMatch(source, /shell:\s*true/);
  assert.match(source, /finally\s*\{/);
  assert.match(source, /max-old-space-size=\$\{CHILD_HEAP_MB\}/);
  assert.match(source, /CHILD_TIMEOUT_MS/);
});

test('memory workflow is valid YAML and keeps the authoritative heap cap', async () => {
  const workflowSource = await readFile(
    new URL('../../../.github/workflows/memory.yml', import.meta.url),
    'utf8',
  );
  const workflow = yaml.load(
    workflowSource,
  );
  assert.ok(workflow && typeof workflow === 'object');
  assert.match(workflowSource, /node --max-old-space-size=150 apps\/api\/dist\/scripts\/memtest\.js/);
  assert.match(workflowSource, /timeout --signal=TERM --kill-after=30s 10m npm run memtest:sweep/);
  assert.ok(workflowSource.indexOf('node --max-old-space-size=150') < workflowSource.indexOf('memtest:sweep'));
});

test('memtest fails closed when parsing produces no CRITICAL vulnerabilities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oxtest-empty-memory-'));
  const fixturePath = join(directory, 'empty.json');
  try {
    await writeFile(fixturePath, JSON.stringify({ Results: [{ Vulnerabilities: [] }] }));
    await assert.rejects(
      runProcess(['--import', 'tsx', memtestPath, fixturePath], true),
      /parsed 0 CRITICAL vulnerabilities; expected at least 1/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('memtest rejects blank count environment variables and preserves valid counts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oxtest-memory-counts-'));
  const fixturePath = join(directory, 'critical.json');
  try {
    await writeFile(
      fixturePath,
      JSON.stringify({
        Results: [{
          Vulnerabilities: [{
            VulnerabilityID: 'CVE-2026-0001',
            PkgName: 'fixture-package',
            InstalledVersion: '1.0.0',
            Severity: 'CRITICAL',
            Title: 'Fixture vulnerability',
            PrimaryURL: 'https://example.test/CVE-2026-0001',
          }],
        }],
      }),
    );
    for (const name of ['MEMTEST_EXPECTED_CRITICAL_COUNT', 'MEMTEST_MIN_CRITICAL_COUNT']) {
      const environment = { ...process.env };
      delete environment.MEMTEST_EXPECTED_CRITICAL_COUNT;
      delete environment.MEMTEST_MIN_CRITICAL_COUNT;
      environment[name] = ' \t ';
      await assert.rejects(
        runProcess(
          ['--import', 'tsx', memtestPath, fixturePath],
          true,
          undefined,
          environment,
        ),
        new RegExp(`${name} must be a non-negative integer`),
      );
    }

    const output = await runProcess(
      ['--import', 'tsx', memtestPath, fixturePath],
      true,
      undefined,
      {
        ...process.env,
        MEMTEST_EXPECTED_CRITICAL_COUNT: ' 1 ',
        MEMTEST_MIN_CRITICAL_COUNT: ' 2 ',
      },
    );
    assert.match(output, /"criticalCount":1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('memtest rejects unsafe and overflowing count environment variables', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oxtest-memory-unsafe-counts-'));
  const fixturePath = join(directory, 'critical.json');
  try {
    await writeFile(
      fixturePath,
      JSON.stringify({ Results: [{ Vulnerabilities: [{ Severity: 'CRITICAL' }] }] }),
    );
    for (const value of ['9007199254740992', '9'.repeat(400)]) {
      const environment = {
        ...process.env,
        MEMTEST_EXPECTED_CRITICAL_COUNT: value,
      };
      await assert.rejects(
        runProcess(['--import', 'tsx', memtestPath, fixturePath], true, undefined, environment),
        /MEMTEST_EXPECTED_CRITICAL_COUNT must be a non-negative safe integer/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('RSS threshold rejects fractional-byte overage before metric rounding', () => {
  const thresholdBytes = 240 * 1024 * 1024;
  assert.doesNotThrow(() => assertRssWithinThreshold(thresholdBytes));
  assert.throws(
    () => assertRssWithinThreshold(thresholdBytes + 0.04 * 1024 * 1024),
    /Peak RSS 240MB exceeds 240MB threshold/,
  );
});

test('child failures and timeouts reject without leaving the caller hanging', async () => {
  await assert.rejects(
    runProcess(['-e', 'process.exit(7)'], true, 1_000),
    /exit code 7/,
  );
  await assert.rejects(
    runProcess(['-e', 'setTimeout(() => {}, 10_000)'], true, 50),
    /timed out after 50ms/,
  );
});

test('sweep removes a generated fixture when a child fails', async () => {
  let fixturePath = '';
  let invocation = 0;
  const failingRunner = async (args) => {
    invocation += 1;
    if (invocation === 1) {
      const outputIndex = args.indexOf('--output');
      fixturePath = args[outputIndex + 1];
      await writeFile(fixturePath, '{}');
      return '';
    }
    throw new Error('synthetic child failure');
  };
  await assert.rejects(runCase(50, false, failingRunner), /synthetic child failure/);
  await assert.rejects(stat(fixturePath), { code: 'ENOENT' });
});

test('sweep preserves a pre-existing fixture when generation fails', async () => {
  const fixturePath = '/tmp/oxtest-phase2-sweep-pre-existing.json';
  const original = '{"preExisting":true}';
  await writeFile(fixturePath, original);

  try {
    await assert.rejects(
      runCase(50, false, async () => { throw new Error('synthetic generation failure'); }, () => fixturePath),
      /synthetic generation failure/,
    );
    assert.equal(await readFile(fixturePath, 'utf8'), original);
  } finally {
    await rm(fixturePath, { force: true });
  }
});

test('concurrent sweep cases use distinct fixture paths and clean up their own files', async () => {
  const fixturePaths = [];
  const concurrentRunner = async (args, captureOutput) => {
    if (!captureOutput) {
      const outputIndex = args.indexOf('--output');
      const fixturePath = args[outputIndex + 1];
      fixturePaths.push(fixturePath);
      await writeFile(fixturePath, '{}');
      return '';
    }
    return '{"peakRssMb":100}';
  };

  await Promise.all([
    runCase(50, false, concurrentRunner),
    runCase(50, false, concurrentRunner),
  ]);

  assert.equal(new Set(fixturePaths).size, 2);
  for (const fixturePath of fixturePaths) {
    await assert.rejects(stat(fixturePath), { code: 'ENOENT' });
  }
});

test('fixture generation produces both CRITICAL and HIGH records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oxtest-fixture-'));
  const fixturePath = join(directory, 'fixture.json');
  try {
    const child = await runProcess([
      '--import', 'tsx',
      generatorPath,
      '--size-mb', '1',
      '--output', fixturePath,
    ], true);
    assert.match(child, /"vulnerabilities":/);
    const generated = JSON.parse(child.trim().split('\n').at(-1));
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
    const criticalCount = fixture.Results[0].Vulnerabilities.filter(
      (item) => item.Severity === 'CRITICAL',
    ).length;
    assert.equal(generated.criticalVulnerabilities, criticalCount);
    assert.ok(generated.criticalVulnerabilities > 0);
    const severities = new Set(fixture.Results[0].Vulnerabilities.map((item) => item.Severity));
    assert.ok(severities.has('CRITICAL'));
    assert.ok(severities.has('HIGH'));
    await stat(fixturePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fixture generator rejects invalid inputs without creating output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oxtest-fixture-invalid-'));
  const cases = [
    { args: ['--output', join(directory, 'missing-size.json')], output: 'missing-size.json' },
    { args: ['--size-mb', '0', '--output', join(directory, 'invalid-size.json')], output: 'invalid-size.json' },
    { args: ['--size-mb', '1'], output: undefined },
    {
      args: ['--size-mb', '1', '--output', join(directory, 'missing-parent', 'fixture.json')],
      output: 'missing-parent/fixture.json',
    },
  ];

  try {
    for (const testCase of cases) {
      await assert.rejects(runGenerator(testCase.args), /Usage|Output directory/);
      if (testCase.output !== undefined) {
        await assert.rejects(stat(join(directory, testCase.output)), { code: 'ENOENT' });
      }
    }
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fixture generator preserves existing files and rejects symlink outputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oxtest-fixture-existing-'));
  const outputPath = join(directory, 'existing.json');
  const targetPath = join(directory, 'target.json');
  const symlinkPath = join(directory, 'fixture-link.json');
  const original = '{"preserve":true}';

  try {
    await writeFile(outputPath, original);
    await writeFile(targetPath, original);
    await symlink(targetPath, symlinkPath);

    await assert.rejects(
      runGenerator(['--size-mb', '1', '--output', symlinkPath]),
      /regular file path/,
    );
    assert.equal(await readFile(outputPath, 'utf8'), original);
    assert.equal(await readFile(targetPath, 'utf8'), original);
    assert.equal(await readlink(symlinkPath), targetPath);
    assert.ok((await lstat(symlinkPath)).isSymbolicLink());

    const child = await runGenerator(['--size-mb', '1', '--output', outputPath]);
    assert.match(child, /"vulnerabilities":/);
    assert.notEqual(await readFile(outputPath, 'utf8'), original);
    assert.ok((await stat(outputPath)).isFile());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
