import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { envValidationSchema } from './config/env.validation';
import {
  createEngineAdapters,
  reportReadyStdoutProducer,
  resolveEngineTestFault,
} from './engine/adapter-factory';
import { ScanEngine, type EngineLogger } from './engine/scan-engine';
import { SCAN_ENGINE, ScanWorker } from './engine/scan-worker';
import {
  SCAN_REPOSITORY,
  type ScanRepository,
} from './scan/scan.repository.port';
import { ScanModule } from './scan/scan.module';

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
      inject: [SCAN_REPOSITORY, ConfigService],
      useFactory: (
        repository: ScanRepository,
        config: ConfigService,
      ): ScanEngine => {
        const scanTmpDir = config.getOrThrow<string>('SCAN_TMP_DIR');
        // Fail-closed fault resolution: the env schema already validates the
        // allowlist, but resolving again keeps the factory authoritative.
        const fault = resolveEngineTestFault(
          config.get<string>('SCAN_ENGINE_TEST_FAULT'),
        );
        const readyMarker =
          config.get<string>('SCAN_ENGINE_READY_MARKER') ?? 'none';
        const adapters = createEngineAdapters({ scanTmpDir, fault });

        const nestLogger = new Logger('ScanEngine');
        const logger: EngineLogger = {
          warn: (message: string): void => {
            nestLogger.warn(message);
          },
          error: (message: string): void => {
            nestLogger.error(message);
          },
        };

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
  ],
})
export class WorkerModule {}
