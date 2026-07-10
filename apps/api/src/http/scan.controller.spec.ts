import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NotFoundException } from '@nestjs/common';

import { Scan, ScanStatus } from '../domain/scan.types';
import type { Vulnerability } from '../domain/vulnerability.types';
import type { ScanService } from '../scan/scan.service';
import { toScanResponse } from './dto/scan-response';
import { ScanController } from './scan.controller';
import { GithubUrlPipe } from './validation/github-url.pipe';

const baseScan = (overrides: Partial<Scan>): Scan => ({
  id: 'scan-1',
  status: ScanStatus.Queued,
  repoUrl: 'https://github.com/owner/repo',
  createdAt: '2026-07-10T00:00:00.000Z',
  updatedAt: '2026-07-10T00:00:00.000Z',
  ...overrides,
});

const critical: Vulnerability = {
  vulnerabilityId: 'CVE-2026-0001',
  pkgName: 'left-pad',
  installedVersion: '1.0.0',
  severity: 'CRITICAL',
  title: 'boom',
  primaryUrl: 'https://example.invalid/cve',
};

function makeController(): {
  controller: ScanController;
  enqueue: jest.Mock<Promise<Scan>, [string]>;
  get: jest.Mock<Promise<Scan | null>, [string]>;
} {
  const enqueue = jest.fn<Promise<Scan>, [string]>();
  const get = jest.fn<Promise<Scan | null>, [string]>();
  const service = { enqueue, get } as unknown as ScanService;
  return { controller: new ScanController(service), enqueue, get };
}

describe('toScanResponse (state-shaped mapper, D-05/06/07)', () => {
  it('maps Queued → {scanId, status}', () => {
    expect(toScanResponse(baseScan({ status: ScanStatus.Queued }))).toEqual({
      scanId: 'scan-1',
      status: 'Queued',
    });
  });

  it('maps Scanning → {scanId, status}', () => {
    expect(toScanResponse(baseScan({ status: ScanStatus.Scanning }))).toEqual({
      scanId: 'scan-1',
      status: 'Scanning',
    });
  });

  it('maps Finished → adds criticalVulnerabilities (D-06)', () => {
    expect(
      toScanResponse(
        baseScan({ status: ScanStatus.Finished, vulnerabilities: [critical] }),
      ),
    ).toEqual({
      scanId: 'scan-1',
      status: 'Finished',
      criticalVulnerabilities: [critical],
    });
  });

  it('maps Finished with no vulnerabilities → empty array', () => {
    expect(toScanResponse(baseScan({ status: ScanStatus.Finished }))).toEqual({
      scanId: 'scan-1',
      status: 'Finished',
      criticalVulnerabilities: [],
    });
  });

  it('maps Failed → adds error {category, detail} (D-07)', () => {
    expect(
      toScanResponse(
        baseScan({
          status: ScanStatus.Failed,
          error: { category: 'clone', detail: 'nope' },
        }),
      ),
    ).toEqual({
      scanId: 'scan-1',
      status: 'Failed',
      error: { category: 'clone', detail: 'nope' },
    });
  });

  it('never leaks repoUrl/createdAt/updatedAt (no raw-domain leak)', () => {
    const out = toScanResponse(baseScan({ status: ScanStatus.Queued }));
    expect(out).not.toHaveProperty('repoUrl');
    expect(out).not.toHaveProperty('createdAt');
    expect(out).not.toHaveProperty('updatedAt');
  });
});

describe('ScanController', () => {
  it('POST create → returns {scanId, status:Queued} and calls enqueue once (SCAN-01/D-04)', async () => {
    const { controller, enqueue } = makeController();
    enqueue.mockResolvedValue(baseScan({ id: 'new-id' }));

    const result = await controller.create({
      repoUrl: 'https://github.com/owner/repo',
    });

    expect(result).toEqual({ scanId: 'new-id', status: 'Queued' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('https://github.com/owner/repo');
  });

  it('POST create handler is decorated with HTTP 202 (D-04)', () => {
    // @HttpCode(202) stores the status on the method via reflect metadata.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- metadata target, `this` unused
    const handler = ScanController.prototype.create;
    const code: unknown = Reflect.getMetadata('__httpCode__', handler);
    expect(code).toBe(202);
  });

  it('GET → maps a resolved scan through toScanResponse', async () => {
    const { controller, get } = makeController();
    get.mockResolvedValue(
      baseScan({ status: ScanStatus.Finished, vulnerabilities: [critical] }),
    );

    await expect(controller.get('scan-1')).resolves.toEqual({
      scanId: 'scan-1',
      status: 'Finished',
      criticalVulnerabilities: [critical],
    });
    expect(get).toHaveBeenCalledWith('scan-1');
  });

  it('GET → throws NotFoundException (404) when the service returns null (SCAN-05/D-05)', async () => {
    const { controller, get } = makeController();
    get.mockResolvedValue(null);

    await expect(controller.get('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('invalid URL is rejected by the pipe BEFORE enqueue runs (400 before enqueue)', () => {
    const { enqueue } = makeController();
    const pipe = new GithubUrlPipe();

    expect(() =>
      pipe.transform({ repoUrl: 'git://github.com/owner/repo' }),
    ).toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('ScanController import-guard (ARCH-01)', () => {
  it('imports none of the forbidden engine/queue/fs modules', () => {
    const source = readFileSync(
      path.resolve(__dirname, 'scan.controller.ts'),
      'utf8',
    );
    const specifiers = importSpecifiers(source);
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
