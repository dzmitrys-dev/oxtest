import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envValidationSchema } from './config/env.validation';
import { ScanModule } from './scan/scan.module';

/**
 * Worker-side root module. Imports the IDENTICAL ConfigModule + ScanModule
 * as AppModule but NEVER any HTTP/GraphQL module (D-06 dead-heap and
 * dead-attack-surface guard) — a standalone application context has no
 * HTTP request lifecycle, so any HTTP/GraphQL module here would be inert
 * and wasteful.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    ScanModule,
  ],
})
export class WorkerModule {}
