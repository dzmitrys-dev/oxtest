import path from 'node:path';

import { RepoClonerAdapter } from './repo-cloner.adapter';
import { ScanPathAllocatorAdapter } from './scan-path-allocator.adapter';
import type {
  SubprocessRunner,
  SubprocessRunOptions,
} from './subprocess-runner';

interface RecordedCall {
  file: string;
  args: string[];
  options: SubprocessRunOptions;
}

function recordingRunner(): {
  runner: SubprocessRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: SubprocessRunner = {
    run(
      file: string,
      args: readonly string[],
      options: SubprocessRunOptions,
    ): Promise<void> {
      calls.push({ file, args: [...args], options });
      return Promise.resolve();
    },
  };
  return { runner, calls };
}

function codedError(message: string, code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

describe('ScanPathAllocatorAdapter', () => {
  it('exclusively allocates a unique cloneDir and reportPath under SCAN_TMP_DIR', async () => {
    const created: string[] = [];
    const allocator = new ScanPathAllocatorAdapter({
      scanTmpDir: '/scan-root',
      idFactory: () => 'uuid-1',
      fs: {
        mkdir: (dir: string): Promise<void> => {
          created.push(dir);
          return Promise.resolve();
        },
        rm: (): Promise<void> => Promise.resolve(),
      },
    });

    const { cloneDir, reportPath } = await allocator.allocate('scan-abc');

    // Both paths live beneath the validated SCAN_TMP_DIR root.
    expect(cloneDir.startsWith(`${path.sep}scan-root${path.sep}`)).toBe(true);
    expect(reportPath.startsWith(`${path.sep}scan-root${path.sep}`)).toBe(true);
    // Clone directory and report path are distinct.
    expect(cloneDir).not.toEqual(reportPath);
    // Report parent is NOT the clone directory (separate Docker mounts).
    expect(path.dirname(reportPath)).not.toEqual(cloneDir);
    // Both derive from a single unique per-scan base directory.
    const base = path.dirname(cloneDir);
    expect(path.dirname(path.dirname(reportPath))).toEqual(base);
    expect(base.includes('uuid-1')).toBe(true);
    // Both directories were created before allocate returned.
    expect(created).toContain(cloneDir);
    expect(created).toContain(path.dirname(reportPath));
  });

  it('removes any partially-created path when allocation fails before returning', async () => {
    let mkdirCalls = 0;
    const removed: string[] = [];
    const allocator = new ScanPathAllocatorAdapter({
      scanTmpDir: '/scan-root',
      idFactory: () => 'uuid-2',
      fs: {
        mkdir: (): Promise<void> => {
          mkdirCalls += 1;
          if (mkdirCalls === 2) {
            return Promise.reject(codedError('mkdir failed', 'EACCES'));
          }
          return Promise.resolve();
        },
        rm: (dir: string): Promise<void> => {
          removed.push(dir);
          return Promise.resolve();
        },
      },
    });

    await expect(allocator.allocate('scan-xyz')).rejects.toThrow(
      'mkdir failed',
    );
    // The already-created per-scan base was cleaned up before rejecting.
    expect(removed).toHaveLength(1);
    expect(removed[0]?.includes('uuid-2')).toBe(true);
  });
});

describe('RepoClonerAdapter', () => {
  it('runs a shallow git clone with discrete argv, shell disabled, consuming cloneDir unchanged', async () => {
    const { runner, calls } = recordingRunner();
    const cloner = new RepoClonerAdapter({ runner });

    const cloneDir = '/scan-root/scan-abc-uuid-1/repo';
    await cloner.clone('https://example.invalid/org/repo.git', cloneDir);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('git');
    expect(calls[0]?.args).toEqual([
      'clone',
      '--depth',
      '1',
      '--',
      'https://example.invalid/org/repo.git',
      cloneDir,
    ]);
    // Shell is disabled and the locked-down git transport env is always set,
    // defaulting to HTTPS only (CR-01). A future global hardening cannot silently
    // drop the allowlist without failing this assertion.
    expect(calls[0]?.options).toEqual({
      shell: false,
      env: {
        GIT_ALLOW_PROTOCOL: 'https',
        GIT_PROTOCOL_FROM_USER: '0',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
  });

  it('defaults the git transport allowlist to https only when none is injected', async () => {
    const { runner, calls } = recordingRunner();
    const cloner = new RepoClonerAdapter({ runner });

    await cloner.clone('https://example.invalid/repo.git', '/clone/dir');

    expect(calls[0]?.options.env?.GIT_ALLOW_PROTOCOL).toBe('https');
  });

  it('forwards an injected allowlist verbatim as GIT_ALLOW_PROTOCOL (trusted-test widening)', async () => {
    const { runner, calls } = recordingRunner();
    const cloner = new RepoClonerAdapter({
      runner,
      allowedProtocols: 'https:file',
    });

    await cloner.clone('https://example.invalid/repo.git', '/clone/dir');

    // The exact injected value flows through; env is the sole mechanism (it
    // overrides any `-c protocol.*` config, which is never used).
    expect(calls[0]?.options.env).toEqual({
      GIT_ALLOW_PROTOCOL: 'https:file',
      GIT_PROTOCOL_FROM_USER: '0',
      GIT_TERMINAL_PROMPT: '0',
    });
  });

  it('never generates its own temp directory or report path', async () => {
    const { runner, calls } = recordingRunner();
    const cloner = new RepoClonerAdapter({ runner });

    const cloneDir = '/explicit/clone/dir';
    await cloner.clone('https://example.invalid/repo.git', cloneDir);

    // The destination argv entry is EXACTLY the supplied cloneDir.
    expect(calls[0]?.args.at(-1)).toBe(cloneDir);
  });
});
