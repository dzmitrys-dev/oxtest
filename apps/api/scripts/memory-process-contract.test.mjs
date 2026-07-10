import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./memtest-sweep.ts', import.meta.url), 'utf8');

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
});
