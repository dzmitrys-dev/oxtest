import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { HealthService } from './health.service';

/** Bounded health body — exactly these three keys (D-10, T-04-04). */
interface HealthBody {
  status: 'ok' | 'error';
  redis: 'up' | 'down';
  uptime: number;
}

/**
 * Unauthenticated liveness probe (API-03, D-09/D-10). Returns 200 when the
 * active Redis PING succeeds and 503 (via a thrown exception) when it fails, so
 * a docker-compose healthcheck or load balancer can act on the status code
 * alone. The body is limited to `{status, redis, uptime}` — no versions,
 * hostnames, or internal paths leak (T-04-04).
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  async check(): Promise<HealthBody> {
    const uptime = Math.floor(process.uptime());
    const up = await this.health.redisUp();
    if (!up) {
      throw new ServiceUnavailableException({
        status: 'error',
        redis: 'down',
        uptime,
      } satisfies HealthBody);
    }
    return { status: 'ok', redis: 'up', uptime };
  }
}
