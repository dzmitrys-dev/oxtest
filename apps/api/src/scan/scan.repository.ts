import type { Redis } from 'ioredis';

import type { Scan, ScanFailureReason } from '../domain/scan.types';
import type { Vulnerability } from '../domain/vulnerability.types';
import type { ScanRepository } from './scan.repository.port';

/**
 * DI token for the injected ioredis client. The module binds a configured
 * `Redis` instance (REDIS_HOST/REDIS_PORT) to this token; the adapter never
 * constructs its own connection so tests can inject a fake.
 */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * RED stub — real Redis persistence is implemented in the GREEN step.
 */
export class ScanRepositoryAdapter implements ScanRepository {
  constructor(private readonly redis: Redis) {
    void this.redis;
  }

  create(_scan: Scan): Promise<void> {
    return Promise.reject(new Error('not implemented'));
  }

  get(_id: string): Promise<Scan | null> {
    return Promise.reject(new Error('not implemented'));
  }

  markScanning(_id: string): Promise<void> {
    return Promise.reject(new Error('not implemented'));
  }

  appendVulnerability(_id: string, _vulnerability: Vulnerability): Promise<void> {
    return Promise.reject(new Error('not implemented'));
  }

  markFinished(_id: string): Promise<void> {
    return Promise.reject(new Error('not implemented'));
  }

  markFailed(_id: string, _reason: ScanFailureReason): Promise<void> {
    return Promise.reject(new Error('not implemented'));
  }
}
