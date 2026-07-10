import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Queue } from 'bullmq';

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
} {
  const create = jest.fn<Promise<void>, [Scan]>().mockResolvedValue(undefined);
  const get = jest.fn<Promise<Scan | null>, [string]>().mockResolvedValue(null);
  const add = jest.fn().mockResolvedValue({ id: '1' });
  const repository = { create, get } as unknown as ScanRepository;
  const queue = { add } as unknown as ScanQueue;
  return { service: new ScanService(repository, queue), create, get, add };
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
    const source = readFileSync(
      path.resolve(__dirname, 'scan.service.ts'),
      'utf8',
    );
    for (const forbidden of [
      'node:fs',
      'node:child_process',
      "'fs'",
      "'child_process'",
      'execa',
      'trivy',
      'docker',
      'report-parser',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

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
    const worker = read('worker.module.ts');
    for (const transport of [
      'fastify',
      'platform-fastify',
      'mercurius',
      'graphql',
      '@nestjs/graphql',
    ]) {
      expect(worker.toLowerCase()).not.toContain(transport);
    }
  });

  it('ScanModule registers exactly one BullMQ scan queue and no WorkerHost processor', () => {
    const scanModule = read('scan/scan.module.ts');
    expect(scanModule).toContain('registerQueue');
    expect(scanModule).not.toContain('WorkerHost');
    expect(scanModule).not.toContain('@Processor');
  });
});
