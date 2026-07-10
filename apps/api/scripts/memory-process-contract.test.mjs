import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import test from 'node:test';

const source = await readFile(new URL('./memtest-sweep.ts', import.meta.url), 'utf8');
const { runCase, runProcess } = await import('./memtest-sweep.ts');
const generatorPath = new URL('./gen-fixture.ts', import.meta.url).pathname;

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
  const workflow = yaml.load(
    await readFile(new URL('../../../.github/workflows/memory.yml', import.meta.url), 'utf8'),
  );
  assert.ok(workflow && typeof workflow === 'object');
  assert.match(
    await readFile(new URL('../../../.github/workflows/memory.yml', import.meta.url), 'utf8'),
    /node --max-old-space-size=150 apps\/api\/dist\/scripts\/memtest\.js/,
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
  const fixturePath = '/tmp/oxtest-phase2-sweep-50mb.json';
  await rm(fixturePath, { force: true });
  let invocation = 0;
  const failingRunner = async (args) => {
    invocation += 1;
    if (invocation === 1) {
      const outputIndex = args.indexOf('--output');
      await writeFile(args[outputIndex + 1], '{}');
      return '';
    }
    throw new Error('synthetic child failure');
  };
  await assert.rejects(runCase(50, false, failingRunner), /synthetic child failure/);
  await assert.rejects(stat(fixturePath), { code: 'ENOENT' });
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
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
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
