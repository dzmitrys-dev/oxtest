#!/usr/bin/env node
/**
 * Deterministic generator for `sample-repo.bundle` — the SOLE repository source
 * consumed by the Plan 04 scan-engine integration harness (Task 1).
 *
 * It builds a throwaway Git repository with fixed file bytes, a fixed author,
 * and a fixed commit date, then serialises it to a single-file Git bundle via
 * `git bundle create <bundle> --all`. The committed bundle is cloned offline by
 * the harness with the exact `git clone --depth 1 <bundle> <destination>`
 * contract — never a live GitHub URL or network Git source (T-03-11).
 *
 * Because every input byte, the author identity, and both commit timestamps are
 * pinned, the resulting commit hash (and therefore the bundle) is reproducible:
 * re-running the generator produces a byte-identical repository history.
 *
 * The repository contains a `package-lock.json` pinning two dependencies with
 * well-known CRITICAL CVEs that the pinned Trivy image (0.69.3) reliably flags:
 *   - lodash@4.17.11   → CVE-2019-10744 (prototype pollution, CVSS 9.8)
 *   - minimist@1.2.0   → CVE-2021-44906 (prototype pollution, CVSS 9.8)
 * Two ordered CRITICAL findings let the harness prove ordered result storage.
 *
 * Safety: every Git invocation uses a discrete argv array with `shell: false`
 * (no shell string interpolation, T-03-10). No network access is performed.
 *
 * Usage: `node apps/api/test-fixtures/create-sample-repo-bundle.mjs`
 *        (also wired as `npm run fixture:sample-repo --workspace apps/api`).
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Absolute path of the committed bundle (sibling of this generator). */
const BUNDLE_PATH = fileURLToPath(
  new URL('./sample-repo.bundle', import.meta.url),
);

/** Pinned identity + timestamps so the commit hash is fully reproducible. */
const AUTHOR_NAME = 'Code Guardian Fixture';
const AUTHOR_EMAIL = 'fixture@code-guardian.test';
const FIXED_DATE = '2024-01-01T00:00:00Z';

/**
 * Fixed repository content. `package-lock.json` (npm lockfile v1) is what Trivy
 * parses to detect the two CRITICAL CVEs; the README documents the fixture so a
 * reviewer understands why the dependencies are intentionally outdated.
 */
const FILES = {
  'package-lock.json': `${JSON.stringify(
    {
      name: 'vulnerable-fixture',
      version: '1.0.0',
      lockfileVersion: 1,
      requires: true,
      dependencies: {
        lodash: {
          version: '4.17.11',
          resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.11.tgz',
          integrity:
            'sha512-cQKh8igo5QUhZ7lg38DYWAxMvjSAKG0A8wGSVimP07SIUEK2UO+arSRKbRZWtelMtN5V0Hkwh5ryOto/SshYIg==',
        },
        minimist: {
          version: '1.2.0',
          resolved: 'https://registry.npmjs.org/minimist/-/minimist-1.2.0.tgz',
          integrity: 'sha1-o1AIsg9BOD7sH7kU9M1d95omQoQ=',
        },
      },
    },
    null,
    2,
  )}\n`,
  'README.md':
    '# Sample vulnerable repository (test fixture)\n\n' +
    'This repository is intentionally pinned to dependencies with known CRITICAL\n' +
    'CVEs (lodash@4.17.11, minimist@1.2.0) so the scan-engine integration harness\n' +
    'can prove ordered CRITICAL extraction offline. Do not use as real code.\n',
};

/**
 * Run a Git command with a discrete argv array and no shell (T-03-10).
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string>} [extraEnv]
 * @returns {string}
 */
function git(cwd, args, extraEnv = {}) {
  const result = spawnSync('git', args, {
    cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  });
  if (result.error) {
    throw new Error(
      `git ${args.join(' ')} failed to launch: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} exited ${String(result.status)}: ${result.stderr?.trim() ?? ''}`,
    );
  }
  return result.stdout ?? '';
}

async function main() {
  const workDir = await mkdtemp(join(tmpdir(), 'sample-repo-src-'));
  try {
    // Deterministic, fully local repository — no user/global config, no network.
    git(workDir, ['init', '-q', '-b', 'main']);
    git(workDir, ['config', 'user.name', AUTHOR_NAME]);
    git(workDir, ['config', 'user.email', AUTHOR_EMAIL]);
    git(workDir, ['config', 'commit.gpgsign', 'false']);

    for (const [name, contents] of Object.entries(FILES)) {
      await writeFile(join(workDir, name), contents);
    }

    git(workDir, ['add', '--all']);
    git(
      workDir,
      [
        'commit',
        '-q',
        '-m',
        'Add intentionally vulnerable fixture dependencies',
      ],
      {
        GIT_AUTHOR_DATE: FIXED_DATE,
        GIT_COMMITTER_DATE: FIXED_DATE,
      },
    );

    // Overwrite any prior bundle deterministically.
    await rm(BUNDLE_PATH, { force: true });
    git(workDir, ['bundle', 'create', BUNDLE_PATH, '--all']);

    const head = git(workDir, ['rev-parse', 'HEAD']).trim();
    process.stdout.write(
      `${JSON.stringify({ bundle: BUNDLE_PATH, commit: head, files: Object.keys(FILES) })}\n`,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `create-sample-repo-bundle failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
