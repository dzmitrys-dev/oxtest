import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  // Deliberately no HTTP listener and no explicit close call here — the
  // standalone context has no network listener; it stays alive until
  // SIGTERM/SIGINT once BullMQ is wired in (Phase 3).
  console.log('Worker application context started');
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
