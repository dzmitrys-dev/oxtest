import type { DestinationStream } from 'pino';

import type { EngineLogger } from './scan-engine';
import {
  createBaseLogger,
  engineLoggerFor,
  resolveBaseLoggerOptions,
} from './pino-logger.adapter';

/**
 * Jest-safe unit test of the pure pino→EngineLogger mapping (D-01, D-04b).
 *
 * This spec imports ONLY `pino` (transitively, via the adapter) and the
 * `EngineLogger` *type* — NEVER `scan-worker.ts` / `@nestjs/bullmq`. That keeps
 * it out of the recorded `@swc/core` miette Jest panic graph (05-RESEARCH
 * Pitfall 5): the adapter is a framework-free translation layer.
 */

/** In-memory pino destination: captures each ndjson line pino writes. */
function captureSink(): { lines: string[]; stream: DestinationStream } {
  const lines: string[] = [];
  const stream: DestinationStream = {
    write: (chunk: string): void => {
      lines.push(chunk);
    },
  };
  return { lines, stream };
}

describe('resolveBaseLoggerOptions (transport gating — D-04b / Pitfall 3)', () => {
  it.each(['production', 'test', undefined])(
    'carries NO transport key when NODE_ENV=%p (ndjson to stdout only)',
    (nodeEnv) => {
      const options = resolveBaseLoggerOptions(nodeEnv);
      expect(options).not.toHaveProperty('transport');
    },
  );

  it("configures the pino-pretty transport ONLY when NODE_ENV==='development'", () => {
    const options = resolveBaseLoggerOptions('development');
    expect(options.transport).toEqual({ target: 'pino-pretty' });
  });
});

describe('createBaseLogger', () => {
  it('returns a pino instance whose write is valid single-line JSON (ndjson)', () => {
    const { lines, stream } = captureSink();
    const base = createBaseLogger(stream);

    // pino instances expose child/info — the port-satisfying surface we use.
    expect(typeof base.child).toBe('function');
    expect(typeof base.info).toBe('function');

    base.info('hello');

    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(line.endsWith('\n')).toBe(true);
    // Exactly one JSON object per line — no embedded newlines.
    expect(line.trimEnd().includes('\n')).toBe(false);
    const parsed = JSON.parse(line) as { msg?: string };
    expect(parsed.msg).toBe('hello');
  });
});

describe('engineLoggerFor (scanId-bound child mapping — D-02/D-03)', () => {
  function lastRecord(lines: string[]): Record<string, unknown> {
    const line = lines.at(-1) ?? '';
    return JSON.parse(line) as Record<string, unknown>;
  }

  it('binds scanId as a structured child field for info', () => {
    const { lines, stream } = captureSink();
    const logger: EngineLogger = engineLoggerFor(
      createBaseLogger(stream),
      'abc123',
    );

    logger.info('scan started');

    const record = lastRecord(lines);
    expect(record.scanId).toBe('abc123');
    expect(record.msg).toBe('scan started');
    expect(record.level).toBe(30); // pino info level
    // scanId is NOT string-interpolated into the message (log-injection guard).
    expect(record.msg).not.toContain('abc123');
  });

  it('binds scanId as a structured child field for warn', () => {
    const { lines, stream } = captureSink();
    const logger = engineLoggerFor(createBaseLogger(stream), 'warn-id');

    logger.warn('something odd');

    const record = lastRecord(lines);
    expect(record.scanId).toBe('warn-id');
    expect(record.msg).toBe('something odd');
    expect(record.level).toBe(40); // pino warn level
  });

  it('binds scanId as a structured child field for error', () => {
    const { lines, stream } = captureSink();
    const logger = engineLoggerFor(createBaseLogger(stream), 'err-id');

    logger.error('boom');

    const record = lastRecord(lines);
    expect(record.scanId).toBe('err-id');
    expect(record.msg).toBe('boom');
    expect(record.level).toBe(50); // pino error level
  });
});
