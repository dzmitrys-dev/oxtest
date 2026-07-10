/**
 * Bounded graceful-drain primitive for worker shutdown (ERR-05, D-11/D-12).
 *
 * BullMQ's `worker.close()` drains in-flight jobs but has NO built-in timeout
 * (BullMQ docs: "will not timeout by itself"), and `@nestjs/bullmq` exposes no
 * grace-window config (Pitfall 2). This function adds the missing bound: it
 * races the graceful `close()` against a timer and, if the grace elapses,
 * force-closes via `close(true)` so the process always exits before Docker's
 * default 10s SIGTERM→SIGKILL window (D-12).
 *
 * It is a PURE function typed against the minimal structural `{ close(force?) }`
 * interface — it imports NEITHER `bullmq` NOR `@nestjs/bullmq`, so it is fully
 * Jest-safe: a fake worker unit-tests every branch without pulling the recorded
 * `@swc/core` miette panic into the module graph (Pitfall 1). The live BullMQ
 * `Worker` (obtained via `WorkerHost.worker`) satisfies this shape structurally.
 */
export async function raceDrain(
  worker: { close(force?: boolean): Promise<void> },
  graceMs: number,
): Promise<'drained' | 'forced'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), graceMs);
    // Never let the grace timer itself hold the event loop open — if the
    // graceful close resolves first, the process must be free to exit.
    timer.unref?.();
  });

  const outcome = await Promise.race([
    worker.close().then((): 'drained' => 'drained'),
    timeout,
  ]);
  // Clear the pending grace timer on BOTH paths so no dangling timer lingers.
  clearTimeout(timer);

  if (outcome === 'timeout') {
    // Grace elapsed while the drain was still in flight — force-close so the
    // process terminates cleanly ahead of an external SIGKILL (D-12).
    await worker.close(true);
    return 'forced';
  }
  return 'drained';
}
