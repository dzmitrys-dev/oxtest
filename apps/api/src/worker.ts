import { NestFactory } from '@nestjs/core';

import { ScanWorker } from './engine/scan-worker';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  // `logger: false` keeps Nest's bootstrap chatter off stdout/stderr so the
  // ONLY pre-marker output is the readiness sentinel (the process contract
  // fails on any unexpected pre-marker stdout/stderr).
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
    // Surface bootstrap/validation failures to our own catch (a clear stderr
    // diagnostic + non-zero exit) instead of letting Nest swallow them under
    // the disabled logger.
    abortOnError: false,
  });
  app.enableShutdownHooks();

  // Confirm the concurrency-one WorkerHost provider actually initialised before
  // signalling readiness — `get` throws if the processor failed to wire, which
  // surfaces as a bootstrap rejection (non-zero exit, no marker).
  app.get(ScanWorker);

  // Deliberately no HTTP listener: a standalone context has no network
  // listener. The BullMQ worker keeps the process alive until SIGTERM/SIGINT,
  // at which point the shutdown hooks close the Redis/queue connections.
  process.stdout.write('SCAN_WORKER_READY\n');
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
