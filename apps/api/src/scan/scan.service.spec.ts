import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Queue } from 'bullmq';
import type { Logger } from 'pino';

import { Scan, ScanStatus } from '../domain/scan.types';
import type { ScanRepository } from './scan.repository.port';
import { ScanService } from './scan.service';
import { SCAN_JOB_NAME } from './scan.types';

type ScanQueue = Queue<{ scanId: string; repoUrl: string }, void, 'scan'>;

function makeService(): {
  service: ScanService;
  create: jest.Mock<Promise<void>, [Scan]>;
  get: jest.Mock<Promise<Scan | null>, [string]>;
  add: jest.Mock;
  info: jest.Mock;
} {
  const create = jest.fn<Promise<void>, [Scan]>().mockResolvedValue(undefined);
  const get = jest.fn<Promise<Scan | null>, [string]>().mockResolvedValue(null);
  const add = jest.fn().mockResolvedValue({ id: '1' });
  const info = jest.fn();
  const repository = { create, get } as unknown as ScanRepository;
  const queue = { add } as unknown as ScanQueue;
  // Fake pino logger: only `info` is exercised by enqueue; `child` returns self
  // so any child-binding is inert in the unit path.
  const logger = { info, child: (): Logger => logger } as unknown as Logger;
  return {
    service: new ScanService(repository, queue, logger),
    create,
    get,
    add,
    info,
  };
}

describe('ScanService', () => {
  it('enqueues: generates an id, persists Queued, and adds exactly {scanId, repoUrl}', async () => {
    const { service, create, add } = makeService();
    const repoUrl = 'https://example.invalid/repo.git';

    const scan = await service.enqueue(repoUrl);

    expect(scan.status).toBe(ScanStatus.Queued);
    expect(scan.repoUrl).toBe(repoUrl);
    expect(typeof scan.id).toBe('string');
    expect(scan.id.length).toBeGreaterThan(0);

    expect(create).toHaveBeenCalledTimes(1);
    const persisted = create.mock.calls[0]?.[0];
    expect(persisted?.id).toBe(scan.id);
    expect(persisted?.status).toBe(ScanStatus.Queued);

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(SCAN_JOB_NAME, {
      scanId: scan.id,
      repoUrl,
    });
  });

  it('emits exactly one structured ndjson enqueue line carrying scanId + repoUrl (OPS-04, D-02)', async () => {
    const { service, info } = makeService();
    const repoUrl = 'https://github.com/owner/repo';

    const scan = await service.enqueue(repoUrl);

    expect(info).toHaveBeenCalledTimes(1);
    // scanId + repoUrl are STRUCTURED fields (object arg), never interpolated
    // into the message string (V7 log-injection guard).
    expect(info).toHaveBeenCalledWith(
      { scanId: scan.id, repoUrl },
      'scan queued',
    );
    const [fields, message] = info.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(message).not.toContain(scan.id);
    expect(fields.scanId).toBe(scan.id);
    expect(fields.repoUrl).toBe(repoUrl);
  });

  it('persists the Queued record before enqueuing the job', async () => {
    const { service, create, add } = makeService();
    const order: string[] = [];
    create.mockImplementation(() => {
      order.push('create');
      return Promise.resolve();
    });
    add.mockImplementation(() => {
      order.push('add');
      return Promise.resolve({ id: '1' });
    });

    await service.enqueue('https://example.invalid/repo.git');

    expect(order).toEqual(['create', 'add']);
  });

  it('generates a distinct id per enqueue', async () => {
    const { service } = makeService();
    const a = await service.enqueue('https://example.invalid/a.git');
    const b = await service.enqueue('https://example.invalid/b.git');
    expect(a.id).not.toBe(b.id);
  });

  it('get delegates to the repository single full read and preserves null', async () => {
    const { service, get } = makeService();
    await expect(service.get('missing')).resolves.toBeNull();
    expect(get).toHaveBeenCalledWith('missing');

    const stored: Scan = {
      id: 'abc',
      status: ScanStatus.Finished,
      repoUrl: 'https://example.invalid/repo.git',
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:00.000Z',
      vulnerabilities: [],
    };
    get.mockResolvedValueOnce(stored);
    await expect(service.get('abc')).resolves.toEqual(stored);
  });

  it('does not import filesystem, subprocess, or engine implementation details (ARCH-02, D-02)', () => {
    const specifiers = importSpecifiers(
      readFileSync(path.resolve(__dirname, 'scan.service.ts'), 'utf8'),
    );
    for (const forbidden of [
      'node:fs',
      'fs',
      'node:child_process',
      'child_process',
      'execa',
      '@nestjs/bullmq',
    ]) {
      expect(specifiers).not.toContain(forbidden);
    }
    expect(specifiers.some((s) => s.includes('report-parser'))).toBe(false);
    expect(specifiers.some((s) => s.includes('engine/'))).toBe(false);
  });
});

/** Extract the module specifiers of `import ... from '<spec>'` statements only. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /^\s*import\b[^\n]*?from\s+['"]([^'"]+)['"]/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

describe('Shared module topology', () => {
  const read = (file: string): string =>
    readFileSync(path.resolve(__dirname, '..', file), 'utf8');

  it('AppModule and WorkerModule both import the shared ScanModule', () => {
    const app = read('app.module.ts');
    const worker = read('worker.module.ts');
    expect(app).toContain('ScanModule');
    expect(worker).toContain('ScanModule');
  });

  it('WorkerModule imports no HTTP/Fastify/GraphQL transport (D-01)', () => {
    const specifiers = importSpecifiers(read('worker.module.ts')).map((s) =>
      s.toLowerCase(),
    );
    for (const transport of [
      'fastify',
      'platform-fastify',
      'mercurius',
      'graphql',
      '@nestjs/graphql',
    ]) {
      expect(specifiers.some((s) => s.includes(transport))).toBe(false);
    }
  });

  it('ScanModule registers exactly one BullMQ scan queue and no WorkerHost processor', () => {
    const scanModule = read('scan/scan.module.ts');
    expect(scanModule).toContain('registerQueue');
    expect(scanModule).not.toContain('WorkerHost');
    expect(scanModule).not.toContain('@Processor');
  });
});
