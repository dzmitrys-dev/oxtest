import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';

import { ScanWorker } from '../engine/scan-worker';
import { REDIS_CLIENT } from '../scan/scan.repository';
import { raceDrain } from './drain';

/**
 * Default grace window mirrored from the Joi schema (D-12); used only if
 * `SHUTDOWN_GRACE_MS` is somehow absent from config at destroy time.
 */
const DEFAULT_SHUTDOWN_GRACE_MS = 8000;

/**
 * Hard-exit backstop margin (Assumption A1). If any teardown step pathologically
 * hangs past the grace window, force the process out this many ms later so it can
 * never outlast Docker's 10s SIGTERM→SIGKILL window. The timer is `unref()`ed so
 * it never itself holds the loop open on the happy path.
 */
const BACKSTOP_MARGIN_MS = 500;

/**
 * Worker-side graceful-shutdown driver (ERR-05, D-11/D-12/D-13).
 *
 * On SIGTERM/SIGINT, NestJS `enableShutdownHooks()` (already wired in
 * `src/worker.ts`) invokes this `OnModuleDestroy` hook — NO hand-rolled
 * `process.on()` handler (D-13). It drains the live BullMQ worker (finish the
 * active scan) bounded by `SHUTDOWN_GRACE_MS`, force-closing on timeout via
 * {@link raceDrain} (D-12), then quits the raw `REDIS_CLIENT` that Nest does not
 * auto-close (Pitfall 3).
 *
 * ⚠️ `@nestjs/bullmq`-ADJACENT: this file imports {@link ScanWorker}, which is
 * the sole worker-path importer of `@nestjs/bullmq`. Exactly like
 * `engine/scan-worker.ts`, it MUST NEVER be imported by a Jest spec — the
 * recorded `@swc/core` miette panic aborts the whole Jest run whenever
 * `@nestjs/bullmq` enters the module graph. Its wiring is validated ONLY by the
 * Plan 03 compiled-process (`.mjs`) SIGTERM harness; the drain LOGIC is
 * unit-tested in the pure {@link raceDrain} (`drain.spec.ts`).
 */
@Injectable()
export class WorkerShutdown implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerShutdown.name);

  constructor(
    private readonly host: ScanWorker,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    const graceMs = this.config.get<number>(
      'SHUTDOWN_GRACE_MS',
      DEFAULT_SHUTDOWN_GRACE_MS,
    );

    // Belt-and-suspenders (Assumption A1): guarantee the process exits within
    // the grace window even if a teardown step hangs. unref() so this never
    // keeps the loop alive on the normal path; cleared once teardown completes.
    const backstop = setTimeout(
      () => process.exit(0),
      graceMs + BACKSTOP_MARGIN_MS,
    );
    backstop.unref?.();

    try {
      // Obtain the live BullMQ Worker via the inherited WorkerHost.worker getter
      // (Assumption A2 — verified present in @nestjs/bullmq 11.0.4). Guard for a
      // worker that never initialised so a failed bootstrap still exits cleanly.
      const worker = this.host.worker;
      if (worker) {
        const outcome = await raceDrain(worker, graceMs);
        this.logger.log(`Scan worker ${outcome} within ${graceMs}ms grace`);
      }
      // Close the raw useFactory ioredis client (Pitfall 3). Guarded because the
      // shared REDIS_CLIENT is also closed by ScanRepositoryAdapter.onModuleDestroy
      // (D-14) — a second quit() on an ended connection rejects, so skip/catch it.
      await this.quitRedis();
    } finally {
      clearTimeout(backstop);
    }
  }

  /** Quit the shared ioredis client at most once, tolerating a concurrent quit. */
  private async quitRedis(): Promise<void> {
    if (this.redis.status === 'end') {
      return;
    }
    try {
      await this.redis.quit();
    } catch {
      // Another shutdown hook already closed the shared client — benign.
    }
  }
}
