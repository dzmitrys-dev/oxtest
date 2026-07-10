import type { Redis } from 'ioredis';

import { HealthService } from './health.service';

function makeService(ping: jest.Mock): {
  service: HealthService;
  ping: jest.Mock;
} {
  const redis = { ping } as unknown as Redis;
  return { service: new HealthService(redis), ping };
}

describe('HealthService.redisUp (API-03, D-08)', () => {
  it('returns true when ping resolves PONG', async () => {
    const { service } = makeService(jest.fn().mockResolvedValue('PONG'));
    await expect(service.redisUp()).resolves.toBe(true);
  });

  it('returns false when ping resolves a non-PONG value', async () => {
    const { service } = makeService(jest.fn().mockResolvedValue('nope'));
    await expect(service.redisUp()).resolves.toBe(false);
  });

  it('returns false when ping rejects (error caught)', async () => {
    const { service } = makeService(
      jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );
    await expect(service.redisUp()).resolves.toBe(false);
  });

  it('returns false when ping never resolves within the timeout (bounded race)', async () => {
    const { service } = makeService(
      jest.fn().mockReturnValue(new Promise<string>(() => {})),
    );
    await expect(service.redisUp(20)).resolves.toBe(false);
  });

  it('performs an active PING (not a passive status read)', async () => {
    const { service, ping } = makeService(jest.fn().mockResolvedValue('PONG'));
    await service.redisUp();
    expect(ping).toHaveBeenCalledTimes(1);
  });
});
