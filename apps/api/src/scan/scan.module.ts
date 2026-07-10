import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import { ReportParser } from '../parser/report-parser';
import { createBaseLogger } from '../engine/pino-logger.adapter';
import { REDIS_CLIENT, ScanRepositoryAdapter } from './scan.repository';
import { SCAN_REPOSITORY } from './scan.repository.port';
import { ScanService } from './scan.service';
import { BASE_LOGGER, SCAN_QUEUE, SCAN_QUEUE_NAME } from './scan.types';

/**
 * The single shared DI seam imported IDENTICALLY by AppModule and WorkerModule
 * (D-01). It binds the Redis repository, the queue producer, the streaming
 * parser, and the orchestration service; the worker plan later adds only the
 * ScanWorker processor on top of this seam. No HTTP/GraphQL transport here.
 *
 * One BullMQ connection and exactly one `scan` queue are registered so the
 * producer (ScanService) and the future worker cannot drift onto separate
 * queues (threat T-03-01).
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: config.getOrThrow<number>('REDIS_PORT'),
        },
      }),
    }),
    BullModule.registerQueue({ name: SCAN_QUEUE_NAME }),
  ],
  providers: [
    {
      // Dedicated repository connection, distinct from BullMQ's own connections.
      // Never set ioredis keyPrefix (BullMQ/repository constraint, T-03-03).
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis => {
        const client = new Redis({
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: config.getOrThrow<number>('REDIS_PORT'),
        });
        // WR-03 (D-13): a non-throwing 'error' listener. ioredis emits 'error'
        // on every connection drop/reconnect; with NO listener attached Node
        // treats it as an unhandled 'error' event and crashes the process. This
        // keeps a transient Redis blip from killing the API/worker (compose /
        // reconnect resilience, T-05-01-04). Diagnostics stay in logs only.
        const logger = new Logger('RedisClient');
        client.on('error', (err: Error) => {
          logger.warn(`Redis connection error: ${err.message}`);
        });
        return client;
      },
    },
    { provide: SCAN_REPOSITORY, useClass: ScanRepositoryAdapter },
    // Bridge BullMQ's own queue token to the framework-neutral SCAN_QUEUE token
    // ScanService injects, so the service stays free of `@nestjs/bullmq`.
    { provide: SCAN_QUEUE, useExisting: getQueueToken(SCAN_QUEUE_NAME) },
    // Shared base pino logger (OPS-04, D-01/D-02): one ndjson logger both the
    // API (ScanService enqueue line) and the worker (per-job pino.child) draw
    // from, so their lines are joinable by scanId. Framework-free factory — no
    // @nestjs/bullmq, no FastifyAdapter double-pino wiring (D-Fastify).
    { provide: BASE_LOGGER, useFactory: createBaseLogger },
    ReportParser,
    ScanService,
  ],
  exports: [
    ScanService,
    SCAN_REPOSITORY,
    SCAN_QUEUE,
    BASE_LOGGER,
    REDIS_CLIENT,
    ReportParser,
    BullModule,
  ],
})
export class ScanModule {}
