import { join } from 'node:path';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { MercuriusDriver } from '@nestjs/mercurius';
import type { MercuriusDriverConfig } from '@nestjs/mercurius';
import { ServeStaticModule } from '@nestjs/serve-static';
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
 *
 * Bonus A (Phase 6): `ServeStaticModule` serves the built React SPA
 * (`apps/web/dist`, copied to `apps/api/dist/web` by the api build) from origin
 * root `GET /` on the SAME Fastify listener as REST + GraphQL (D-04 — one URL,
 * no CORS). `rootPath: join(__dirname, 'web')` resolves to `apps/api/dist/web`
 * at `node dist/index.js` runtime (`__dirname` = `apps/api/dist`, Pitfall 3).
 * The api build ALWAYS (re)creates `dist/web/index.html` after `nest build`'s
 * `deleteOutDir` (real Vite bundle when present, else a placeholder) so the
 * rootPath always exists and the criterion #5a self-test never regresses
 * (T-06-08). Like GraphQL, static serving is AppModule-ONLY — the worker heap
 * never loads it.
 *
 * `exclude` bypasses ALL FOUR backend route groups so the SPA catch-all never
 * shadows them (Pitfall 4, T-06-03): the `/api/*` scan routes, `/health`,
 * `/graphql`, and `/graphiql`. The wildcard token is path-to-regexp v8
 * (`/api/{*path}`) — confirmed empirically by `serve-static-routes.smoke.mjs`
 * (Open Question 1). `@fastify/static` (under ServeStaticModule) normalizes and
 * rejects path traversal, serving only files under `dist/web` (T-06-04).
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
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, 'web'),
      exclude: ['/api/{*path}', '/health', '/graphql', '/graphiql'],
    }),
  ],
  controllers: [ScanController, HealthController],
  providers: [HealthService, ScanResolver],
})
export class AppModule {}
