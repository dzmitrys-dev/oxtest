import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from '../scan/scan.repository';

/**
 * Liveness probe for Redis connectivity (API-03, D-08). Reuses the SAME
 * existing `REDIS_CLIENT` connection exported by `ScanModule` — it never
 * constructs a new connection (D-08). An ACTIVE `PING` (not a passive
 * `.status === 'ready'` read) is used so a wedged-but-open socket is detected;
 * the ping is bounded by a race so a hung socket cannot stall `/health`.
 */
@Injectable()
export class HealthService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * @returns `true` iff `PING` returns `PONG` within `timeoutMs`; `false` on
   *   any rejection, non-PONG reply, or timeout (fail-closed).
   */
  async redisUp(timeoutMs = 1000): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const pong = await Promise.race([
        this.redis.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('redis ping timeout')),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
      return pong === 'PONG';
    } catch {
      return false;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
