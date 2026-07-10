import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envValidationSchema } from './config/env.validation';
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
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    ScanModule,
  ],
  controllers: [ScanController, HealthController],
  providers: [HealthService],
})
export class AppModule {}
