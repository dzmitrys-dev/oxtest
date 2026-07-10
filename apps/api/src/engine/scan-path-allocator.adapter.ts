import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  ScanPathAllocation,
  ScanPathAllocator,
} from './scan-path-allocator.port';

/**
 * Filesystem seam so partial-allocation cleanup can be exercised
 * deterministically in unit tests without touching a real disk.
 */
export interface ScanPathAllocatorFs {
  mkdir(dir: string): Promise<void>;
  rm(dir: string): Promise<void>;
}

export interface ScanPathAllocatorOptions {
  /** Validated `SCAN_TMP_DIR` — the exclusive root for every allocated path. */
  scanTmpDir: string;
  fs?: ScanPathAllocatorFs;
  /** Injectable unique-suffix source (defaults to `crypto.randomUUID`). */
  idFactory?: () => string;
}

const defaultFs: ScanPathAllocatorFs = {
  async mkdir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  },
  async rm(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
  },
};

/**
 * Sole owner of allocating both the clone directory and the report path under
 * the validated `SCAN_TMP_DIR` (D-16 ownership). Each scan gets a unique base
 * directory `<SCAN_TMP_DIR>/<scanId>-<uuid>/` containing:
 *   - `repo/`         → clone destination (Docker `/src:ro`)
 *   - `out/report.json` → Trivy report (Docker `/out`)
 *
 * If any directory creation fails mid-allocation, the entire per-scan base is
 * removed before {@link allocate} rejects, so no orphan artifact survives a
 * partial allocation. `RepoClonerAdapter` never touches this logic.
 */
export class ScanPathAllocatorAdapter implements ScanPathAllocator {
  private readonly scanTmpDir: string;
  private readonly fs: ScanPathAllocatorFs;
  private readonly idFactory: () => string;

  constructor(options: ScanPathAllocatorOptions) {
    this.scanTmpDir = options.scanTmpDir;
    this.fs = options.fs ?? defaultFs;
    this.idFactory = options.idFactory ?? ((): string => randomUUID());
  }

  async allocate(scanId: string): Promise<ScanPathAllocation> {
    // Confine every generated path beneath SCAN_TMP_DIR; sanitize the scanId so
    // it cannot escape the root via separators or traversal (T-03-05).
    const safeScanId = scanId.replace(/[^A-Za-z0-9._-]/g, '_');
    const base = join(this.scanTmpDir, `${safeScanId}-${this.idFactory()}`);
    const cloneDir = join(base, 'repo');
    const reportDir = join(base, 'out');
    const reportPath = join(reportDir, 'report.json');

    try {
      await this.fs.mkdir(cloneDir);
      await this.fs.mkdir(reportDir);
    } catch (error) {
      // Own cleanup of any partial allocation before surfacing the failure.
      await this.fs.rm(base).catch(() => undefined);
      throw error;
    }

    return { cloneDir, reportPath };
  }

  /** Exposed for callers that only have a reportPath and need its parent. */
  static reportParent(reportPath: string): string {
    return dirname(reportPath);
  }
}
