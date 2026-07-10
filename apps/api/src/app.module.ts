import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { MercuriusDriver } from '@nestjs/mercurius';
import type { MercuriusDriverConfig } from '@nestjs/mercurius';
import { envValidationSchema } from './config/env.validation';
import { ScanResolver } from './graphql/scan.resolver';
import { HealthController } from './http/health.controller';
import { HealthService } from './http/health.service';
import { ScanController } from './http/scan.controller';
import { ScanModule } from './scan/scan.module';

/**
 * API-side root module. Registers the REQUIRED REST transport (Phase 4):
 * `ScanController` (POST/GET) and `HealthController` (+ `HealthService`).
 * `ScanModule` is already imported and exports `ScanService` + `REDIS_CLIENT`,
 * so `ScanController` resolves `ScanService` and `HealthService` resolves the
 * existing `REDIS_CLIENT` with no new module imports (D-08).
 *
 * Bonus B (Phase 6): the code-first GraphQL surface mounts here via
 * `MercuriusDriver` on the SAME Fastify listener as REST (one process, zero
 * second-listener overhead, D-02). `graphiql: true` exposes GraphiQL at
 * `/graphiql` in ALL environments incl. the container for reviewer
 * explorability (D-05). GraphQL is registered in AppModule ONLY — never
 * `WorkerModule` — keeping the memory-critical worker heap free of GraphQL
 * code (two-entrypoint discipline). `ScanResolver` delegates to the shared
 * `ScanService` exported by `ScanModule`.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    ScanModule,
    GraphQLModule.forRoot<MercuriusDriverConfig>({
      driver: MercuriusDriver,
      autoSchemaFile: true,
      graphiql: true,
    }),
  ],
  controllers: [ScanController, HealthController],
  providers: [HealthService, ScanResolver],
})
export class AppModule {}
