import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { raceDrain } from './drain';

/**
 * Pure-function unit tests for the bounded graceful-drain logic (D-12, ERR-05).
 *
 * These tests exercise `raceDrain` against a hand-rolled fake exposing ONLY the
 * structural `{ close(force?) }` shape — no `bullmq` / `@nestjs/bullmq` ever
 * enters this spec's module graph, so the recorded `@swc/core` miette panic
 * (Pitfall 1) cannot be triggered.
 */

type CloseArg = boolean | undefined;

interface FakeWorker {
  close(force?: boolean): Promise<void>;
  /** Ordered record of the `force` argument passed to each `close()` call. */
  readonly calls: CloseArg[];
}

/**
 * Build a fake worker whose graceful `close()` and forced `close(true)` paths
 * are driven by injected handlers, recording every call's `force` argument.
 */
function fakeWorker(handlers: {
  drain: () => Promise<void>;
  force?: () => Promise<void>;
}): FakeWorker {
  const calls: CloseArg[] = [];
  return {
    calls,
    close(force?: boolean): Promise<void> {
      calls.push(force);
      if (force === true) {
        return (handlers.force ?? ((): Promise<void> => Promise.resolve()))();
      }
      return handlers.drain();
    },
  };
}

describe('raceDrain', () => {
  it("returns 'drained' when close() resolves within grace, never force-closing", async () => {
    const worker = fakeWorker({ drain: () => Promise.resolve() });

    const outcome = await raceDrain(worker, 1000);

    expect(outcome).toBe('drained');
    // Exactly one graceful close, no force-close.
    expect(worker.calls).toEqual([undefined]);
  });

  it("returns 'forced' and calls close(true) exactly once when the drain exceeds grace", async () => {
    const worker = fakeWorker({
      drain: () => new Promise<void>(() => {}), // never resolves
      force: () => Promise.resolve(),
    });

    const outcome = await raceDrain(worker, 10);

    expect(outcome).toBe('forced');
    expect(worker.calls.filter((force) => force === true)).toHaveLength(1);
    expect(worker.calls).toEqual([undefined, true]);
  });

  it('clears the pending timeout on the drained path (no dangling timer keeps the loop alive)', async () => {
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    const worker = fakeWorker({ drain: () => Promise.resolve() });

    await raceDrain(worker, 1000);

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('accepts any plain object satisfying the { close(force?) } structural type', async () => {
    await expect(
      raceDrain({ close: (): Promise<void> => Promise.resolve() }, 50),
    ).resolves.toBe('drained');
  });

  it('imports neither bullmq nor @nestjs/bullmq (Jest-safe by construction, Pitfall 1)', () => {
    const src = readFileSync(path.resolve(__dirname, 'drain.ts'), 'utf8');
    expect(src).not.toMatch(/from\s+['"]bullmq['"]/);
    expect(src).not.toMatch(/from\s+['"]@nestjs\/bullmq['"]/);
  });
});
