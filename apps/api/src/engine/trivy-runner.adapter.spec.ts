import { TrivyRunnerAdapter, TRIVY_DOCKER_IMAGE } from './trivy-runner.adapter';
import {
  SubprocessRunError,
  type SubprocessRunner,
  type SubprocessRunOptions,
} from './subprocess-runner';

interface RecordedCall {
  file: string;
  args: string[];
  options: SubprocessRunOptions;
}

const CLONE_DIR = '/scan-root/scan-abc-uuid-1/repo';
const REPORT_PATH = '/scan-root/scan-abc-uuid-1/out/report.json';

function codedError(message: string, code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

describe('TrivyRunnerAdapter', () => {
  it('runs local Trivy with discrete argv writing JSON to --output, never buffering report stdout', async () => {
    const calls: RecordedCall[] = [];
    const runner: SubprocessRunner = {
      run(file, args, options): Promise<void> {
        calls.push({ file, args: [...args], options });
        return Promise.resolve();
      },
    };
    const statted: string[] = [];
    const adapter = new TrivyRunnerAdapter({
      runner,
      stat: (p: string): Promise<void> => {
        statted.push(p);
        return Promise.resolve();
      },
    });

    await adapter.run(CLONE_DIR, REPORT_PATH);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('trivy');
    expect(calls[0]?.args).toEqual([
      'filesystem',
      '--format',
      'json',
      '--output',
      REPORT_PATH,
      '--no-progress',
      '--exit-code',
      '0',
      CLONE_DIR,
    ]);
    expect(calls[0]?.options).toEqual({ shell: false });
    expect(statted).toEqual([REPORT_PATH]);
  });

  it('falls back to the pinned Docker image on a local launch error with the exact mount/output contract', async () => {
    const calls: RecordedCall[] = [];
    const runner: SubprocessRunner = {
      run(file, args, options): Promise<void> {
        calls.push({ file, args: [...args], options });
        if (file === 'trivy') {
          return Promise.reject(
            new SubprocessRunError({
              file: 'trivy',
              args,
              launchFailed: true,
              code: 'ENOENT',
              stderr: '',
            }),
          );
        }
        return Promise.resolve();
      },
    };
    const adapter = new TrivyRunnerAdapter({
      runner,
      stat: (): Promise<void> => Promise.resolve(),
    });

    await adapter.run(CLONE_DIR, REPORT_PATH);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.file).toBe('docker');
    expect(calls[1]?.args).toEqual([
      'run',
      '--rm',
      '--mount',
      'type=tmpfs,destination=/root/.cache/trivy',
      '-v',
      `${CLONE_DIR}:/src:ro`,
      '-v',
      '/scan-root/scan-abc-uuid-1/out:/out',
      TRIVY_DOCKER_IMAGE,
      'filesystem',
      '--format',
      'json',
      '--output',
      '/out/report.json',
      '--no-progress',
      '--exit-code',
      '0',
      '/src',
    ]);
    expect(calls[1]?.options).toEqual({ shell: false });
  });

  it('pins the official Trivy image and never uses a floating tag', () => {
    expect(TRIVY_DOCKER_IMAGE).toBe('ghcr.io/aquasecurity/trivy:0.69.3');
    expect(TRIVY_DOCKER_IMAGE.endsWith(':latest')).toBe(false);
  });

  it('does not silently rerun Docker after a genuine local scan execution failure', async () => {
    const calls: string[] = [];
    const runner: SubprocessRunner = {
      run(file, args): Promise<void> {
        calls.push(file);
        return Promise.reject(
          new SubprocessRunError({
            file,
            args,
            launchFailed: false,
            exitCode: 2,
            stderr: 'trivy: fatal scan error',
          }),
        );
      },
    };
    const adapter = new TrivyRunnerAdapter({
      runner,
      stat: (): Promise<void> => Promise.resolve(),
    });

    await expect(adapter.run(CLONE_DIR, REPORT_PATH)).rejects.toBeInstanceOf(
      SubprocessRunError,
    );
    expect(calls).toEqual(['trivy']);
  });

  it('stat-validates the report before onReportReady, calls it last, and preserves the exact reportPath', async () => {
    const order: string[] = [];
    const seen: string[] = [];
    const runner: SubprocessRunner = {
      run(): Promise<void> {
        order.push('run');
        return Promise.resolve();
      },
    };
    const adapter = new TrivyRunnerAdapter({
      runner,
      stat: (p: string): Promise<void> => {
        order.push(`stat:${p}`);
        return Promise.resolve();
      },
    });

    await adapter.run(CLONE_DIR, REPORT_PATH, {
      onReportReady: (p: string): Promise<void> => {
        order.push(`ready:${p}`);
        seen.push(p);
        return Promise.resolve();
      },
    });

    expect(order).toEqual([
      'run',
      `stat:${REPORT_PATH}`,
      `ready:${REPORT_PATH}`,
    ]);
    expect(seen).toEqual([REPORT_PATH]);
  });

  it('fails readiness when the host report is missing and never calls onReportReady', async () => {
    let readyCalled = false;
    const runner: SubprocessRunner = {
      run(): Promise<void> {
        return Promise.resolve();
      },
    };
    const adapter = new TrivyRunnerAdapter({
      runner,
      stat: (): Promise<void> =>
        Promise.reject(codedError('missing report', 'ENOENT')),
    });

    await expect(
      adapter.run(CLONE_DIR, REPORT_PATH, {
        onReportReady: (): Promise<void> => {
          readyCalled = true;
          return Promise.resolve();
        },
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(readyCalled).toBe(false);
  });
});
