import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Logger as PinoLogger } from 'pino';

import { envValidationSchema } from './config/env.validation';
import {
  createEngineAdapters,
  reportReadyStdoutProducer,
  resolveEngineTestFault,
} from './engine/adapter-factory';
import { engineLoggerFor } from './engine/pino-logger.adapter';
import { ScanEngine } from './engine/scan-engine';
import { SCAN_ENGINE, ScanWorker } from './engine/scan-worker';
import { WorkerShutdown } from './lifecycle/worker-shutdown.provider';
import {
  SCAN_REPOSITORY,
  type ScanRepository,
} from './scan/scan.repository.port';
import { ScanModule } from './scan/scan.module';
import { BASE_LOGGER } from './scan/scan.types';

/**
 * Worker-side root module. It imports the IDENTICAL global ConfigModule and the
 * single shared ScanModule as AppModule (D-01), but NEVER any HTTP/GraphQL
 * transport (D-06): a standalone application context has no HTTP request
 * lifecycle, so any transport module here would be inert dead attack surface.
 *
 * The producer queue, Redis repository, and streaming parser all arrive through
 * the shared ScanModule seam; WorkerModule adds ONLY the worker-side providers —
 * the concurrency-one `ScanWorker` WorkerHost and the plain `ScanEngine` it
 * delegates to (constructed via the validated adapter factory).
 *
 * Redis retry policy is split by role (D-05): the producer queue uses the shared
 * ScanModule `BullModule.forRootAsync` connection, whose PLAIN options object is
 * given finite (ioredis-default) `maxRetriesPerRequest` for the non-blocking
 * queue, while BullMQ automatically forces `maxRetriesPerRequest: null` for this
 * module's blocking WorkerHost connection built from those same options
 * (bullmq RedisConnection). No `keyPrefix` is set on any connection (T-03-03).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    ScanModule,
  ],
  providers: [
    {
      // The plain engine is wired here so the swc+@nestjs/bullmq jest panic is
      // never triggered by the tested lifecycle code (it lives in ScanEngine).
      provide: SCAN_ENGINE,
      inject: [SCAN_REPOSITORY, ConfigService, BASE_LOGGER],
      useFactory: (
        repository: ScanRepository,
        config: ConfigService,
        baseLogger: PinoLogger,
      ): ScanEngine => {
        const scanTmpDir = config.getOrThrow<string>('SCAN_TMP_DIR');
        // Fail-closed fault resolution: the env schema already validates the
        // allowlist, but resolving again keeps the factory authoritative.
        const fault = resolveEngineTestFault(
          config.get<string>('SCAN_ENGINE_TEST_FAULT'),
        );
        const readyMarker =
          config.get<string>('SCAN_ENGINE_READY_MARKER') ?? 'none';
        // Validated git transport allowlist (CR-01) — production defaults to
        // `https` only via the env schema; forwarded to the real clone adapter.
        const gitAllowedProtocols = config.get<string>(
          'SCAN_GIT_ALLOWED_PROTOCOLS',
        );

        // Fallback engine logger drawn from the SHARED base pino logger (D-01).
        // The worker always injects a per-job `pino.child({ scanId })` into
        // `engine.run(job, logger)`, so this bound-to-'worker' logger only ever
        // backs the singleton default and the fault-seam WARN sink (structurally
        // a FaultSeamLogger). No NestJS `Logger` is constructed for engine
        // lifecycle anymore, and the base logger is NEVER wired onto the
        // FastifyAdapter (D-Fastify / Pitfall 4 — no double-pino).
        const logger = engineLoggerFor(baseLogger, 'worker');

        // HIGH-02: the fault seam is resolved at composition time against
        // NODE_ENV. In production a stray SCAN_ENGINE_TEST_FAULT is ignored
        // (real adapters run) with a loud WARN, never silently disabling scans.
        const adapters = createEngineAdapters({
          scanTmpDir,
          fault,
          gitAllowedProtocols,
          nodeEnv: config.get<string>('NODE_ENV'),
          logger,
        });

        return new ScanEngine({
          repository,
          ...adapters,
          onReportReady:
            readyMarker === 'log' ? reportReadyStdoutProducer : undefined,
          logger,
        });
      },
    },
    ScanWorker,
    // Worker-side graceful-shutdown driver (ERR-05, D-11/D-12/D-13): drains the
    // active scan bounded by SHUTDOWN_GRACE_MS then quits Redis via a Nest
    // lifecycle hook. @nestjs/bullmq-adjacent — never imported by a Jest spec.
    WorkerShutdown,
  ],
})
export class WorkerModule {}
