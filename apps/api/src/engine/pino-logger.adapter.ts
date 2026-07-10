import type { DestinationStream, Logger, LoggerOptions } from 'pino';

import type { EngineLogger } from './scan-engine';

// RED stub — implemented in the GREEN step.
export function resolveBaseLoggerOptions(_nodeEnv: string | undefined): LoggerOptions {
  throw new Error('not implemented');
}

export function createBaseLogger(_destination?: DestinationStream): Logger {
  throw new Error('not implemented');
}

export function engineLoggerFor(_base: Logger, _scanId: string): EngineLogger {
  throw new Error('not implemented');
}
