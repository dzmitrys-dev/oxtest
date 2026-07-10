import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';

import type { EngineLogger } from './scan-engine';

/**
 * pino adapter behind the existing {@link EngineLogger} port (D-01). The domain
 * engine imports NOTHING from pino — this framework-free translation layer is
 * the only place pino is referenced for engine lifecycle logging, so its pure
 * mapping is unit-testable under Jest without pulling `@nestjs/bullmq` into the
 * graph (05-RESEARCH Pitfall 5 — the `@swc/core` miette panic).
 */

/**
 * Resolve the base pino options for a given `NODE_ENV`. ndjson to stdout is the
 * ONLY output in production/container/CI (empty options → pino's default);
 * `pino-pretty` is configured EXCLUSIVELY when `NODE_ENV==='development'`
 * (D-04b / Pitfall 3). A transport spawns a worker thread whose second V8
 * isolate adds RSS under the 200m limit being proven, so it must never ship in
 * the container image (`pino-pretty` is a devDependency only).
 */
export function resolveBaseLoggerOptions(
  nodeEnv: string | undefined,
): LoggerOptions {
  return nodeEnv === 'development'
    ? { transport: { target: 'pino-pretty' } }
    : {};
}

/**
 * Build the shared base pino logger. Defaults to ndjson on stdout; an optional
 * `destination` is a testability affordance (an in-memory sink in the unit
 * spec) and is never supplied by the DI wiring, which calls `createBaseLogger()`
 * with no argument.
 */
export function createBaseLogger(destination?: DestinationStream): Logger {
  const options = resolveBaseLoggerOptions(process.env.NODE_ENV);
  return destination === undefined ? pino(options) : pino(options, destination);
}

/**
 * Bind `scanId` as a structured pino child field (D-02) and expose it through
 * the widened `EngineLogger` port. `scanId` is attached automatically by
 * `child({ scanId })` and NEVER string-interpolated into the message, closing
 * the log-injection surface (V7 / T-05-01-02).
 */
export function engineLoggerFor(base: Logger, scanId: string): EngineLogger {
  const child = base.child({ scanId });
  return {
    info: (message: string): void => {
      child.info(message);
    },
    warn: (message: string): void => {
      child.warn(message);
    },
    error: (message: string): void => {
      child.error(message);
    },
  };
}
