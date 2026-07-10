import { classifyScanError } from './scan-error';
import { SubprocessRunError } from './subprocess-runner';
import {
  TempArtifactCleanerAdapter,
  type CleanerFs,
  type CleanerLogger,
} from './temp-artifact-cleaner';

function codedError(message: string, code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

interface RemoveCall {
  target: string;
  recursive: boolean;
  force: boolean;
}

describe('TempArtifactCleanerAdapter', () => {
  it('removes both the clone directory and report path recursively and forcefully', async () => {
    const calls: RemoveCall[] = [];
    const fs: CleanerFs = {
      rm: (target, opts): Promise<void> => {
        calls.push({
          target,
          recursive: opts.recursive,
          force: opts.force,
        });
        return Promise.resolve();
      },
    };
    const cleaner = new TempArtifactCleanerAdapter({ fs });

    await cleaner.remove('/base/repo', '/base/out/report.json');

    expect(calls.map((c) => c.target)).toEqual([
      '/base/repo',
      '/base/out/report.json',
    ]);
    expect(calls.every((c) => c.recursive && c.force)).toBe(true);
  });

  it('ignores ENOENT for already-missing paths', async () => {
    const fs: CleanerFs = {
      rm: (): Promise<void> => Promise.reject(codedError('missing', 'ENOENT')),
    };
    const cleaner = new TempArtifactCleanerAdapter({ fs });

    await expect(
      cleaner.remove('/gone/repo', '/gone/report.json'),
    ).resolves.toBeUndefined();
  });

  it('reports a secondary cleanup error without throwing over the primary scan error', async () => {
    const attempted: string[] = [];
    const warnings: string[] = [];
    const fs: CleanerFs = {
      rm: (target): Promise<void> => {
        attempted.push(target);
        if (target === '/base/repo') {
          return Promise.reject(codedError('device busy', 'EBUSY'));
        }
        return Promise.resolve();
      },
    };
    const logger: CleanerLogger = {
      warn: (message): void => {
        warnings.push(message);
      },
    };
    const cleaner = new TempArtifactCleanerAdapter({ fs, logger });

    // Must resolve (never throw) so the original scan failure is preserved.
    await expect(
      cleaner.remove('/base/repo', '/base/out/report.json'),
    ).resolves.toBeUndefined();
    // The second path was still attempted despite the first error.
    expect(attempted).toEqual(['/base/repo', '/base/out/report.json']);
    expect(warnings).toHaveLength(1);
  });
});

describe('classifyScanError', () => {
  it('distinguishes clone, Trivy, and report-parse categories by stage', () => {
    expect(
      classifyScanError('clone', new Error('git clone failed')).category,
    ).toBe('clone');
    expect(
      classifyScanError('trivy', new Error('trivy crashed')).category,
    ).toBe('trivy');
    expect(
      classifyScanError('parse', new Error('bad json leaf')).category,
    ).toBe('parse');
  });

  it('classifies ENOSPC as disk-full regardless of stage or error shape', () => {
    const fsError = codedError('write failed', 'ENOSPC');
    expect(classifyScanError('clone', fsError).category).toBe('disk-full');

    const subprocessError = new SubprocessRunError({
      file: 'trivy',
      args: [],
      launchFailed: false,
      exitCode: 1,
      stderr: 'fatal: No space left on device',
    });
    expect(classifyScanError('trivy', subprocessError).category).toBe(
      'disk-full',
    );
  });

  it('classifies a timed-out subprocess as the bounded timeout category', () => {
    const timedOut = new SubprocessRunError({
      file: 'git',
      args: [],
      launchFailed: false,
      timedOut: true,
      signal: 'SIGKILL',
      stderr: '',
    });
    // A timeout is distinct from clone/trivy stage failures and never disk-full.
    expect(classifyScanError('clone', timedOut).category).toBe('timeout');
    expect(classifyScanError('trivy', timedOut).category).toBe('timeout');
  });

  it('redacts URL credentials and absolute filesystem paths in the detail', () => {
    const error = new Error(
      'failed cloning https://alice:secrettoken@github.com/org/repo.git into /home/runner/scan-tmp/abc123/repo',
    );
    const { detail } = classifyScanError('clone', error);

    expect(detail).not.toContain('secrettoken');
    expect(detail).toContain('***');
    expect(detail).not.toContain('/home/runner/scan-tmp/abc123/repo');
    expect(detail).toContain('<path>');
    // Non-sensitive host context is preserved for diagnosability.
    expect(detail).toContain('github.com');
  });

  it('caps the persisted category and detail at 500 characters', () => {
    const error = new Error('x'.repeat(2000));
    const { category, detail } = classifyScanError('trivy', error);

    expect(detail.length).toBe(500);
    expect(category.length).toBeLessThanOrEqual(500);
  });
});
