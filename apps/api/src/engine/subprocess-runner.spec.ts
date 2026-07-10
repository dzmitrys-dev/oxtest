import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import {
  createSpawnSubprocessRunner,
  SubprocessRunError,
} from './subprocess-runner';

/**
 * HIGH-01 — a bounded wall-clock timeout with a hand-rolled SIGTERM→SIGKILL
 * escalation. A deterministic fake child (never a real process) proves the
 * escalation order, the timeout classification, and that a fast run schedules
 * no kill and cancels the grace timer.
 */
interface FakeHandlers {
  onSigterm?: () => void;
  onSigkill?: () => void;
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly stderr = null;
  readonly killed: string[] = [];
  private readonly handlers: FakeHandlers;

  constructor(handlers: FakeHandlers = {}) {
    super();
    this.handlers = handlers;
  }

  kill(signal: string): boolean {
    this.killed.push(signal);
    if (signal === 'SIGTERM') this.handlers.onSigterm?.();
    if (signal === 'SIGKILL') this.handlers.onSigkill?.();
    return true;
  }
}

function runnerFor(child: FakeChild, sigkillGraceMs: number) {
  const spawnFn = ((): FakeChild => child) as unknown as typeof spawn;
  return createSpawnSubprocessRunner({ spawn: spawnFn, sigkillGraceMs });
}

describe('createSpawnSubprocessRunner — timeout escalation', () => {
  it('resolves on a clean exit and schedules no kill', async () => {
    const child = new FakeChild();
    const runner = runnerFor(child, 5);

    const pending = runner.run('trivy', [], {
      shell: false,
      timeoutMs: 10_000,
    });
    child.emit('close', 0, null);

    await expect(pending).resolves.toBeUndefined();
    expect(child.killed).toEqual([]);
  });

  it('escalates SIGTERM then SIGKILL when the child ignores SIGTERM, rejecting timedOut', async () => {
    // Only SIGKILL makes this child exit — proving the escalation is required.
    const child = new FakeChild({
      onSigkill: () => {
        child.signalCode = 'SIGKILL';
        setImmediate(() => child.emit('close', null, 'SIGKILL'));
      },
    });
    const runner = runnerFor(child, 15);

    const error = await runner
      .run('git', ['clone'], { shell: false, timeoutMs: 15 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SubprocessRunError);
    const runError = error as SubprocessRunError;
    expect(runError.timedOut).toBe(true);
    // A timeout is a genuine stage failure, never a launch failure (no Docker fallback).
    expect(runError.launchFailed).toBe(false);
    expect(child.killed).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not escalate to SIGKILL when the child exits on SIGTERM (grace timer cleared)', async () => {
    const child = new FakeChild({
      onSigterm: () => {
        child.signalCode = 'SIGTERM';
        setImmediate(() => child.emit('close', null, 'SIGTERM'));
      },
    });
    const runner = runnerFor(child, 5_000);

    const error = await runner
      .run('git', ['clone'], { shell: false, timeoutMs: 10 })
      .catch((caught: unknown) => caught);

    expect((error as SubprocessRunError).timedOut).toBe(true);
    expect(child.killed).toEqual(['SIGTERM']);
  });
});
