import { Injectable } from '@nestjs/common';
import { Scan, ScanStatus } from '../domain/scan.types';

/**
 * In-memory ScanStore stub — the concrete cross-layer usage point for the
 * domain types (Success Criterion #4). No business logic, no persistence:
 * real persistence (Redis ScanRepository) arrives in Phase 3.
 */
@Injectable()
export class ScanStore {
  private readonly scans = new Map<string, Scan>();

  get(id: string): Scan | null {
    return this.scans.get(id) ?? null;
  }

  list(): Scan[] {
    return [...this.scans.values()];
  }

  listByStatus(status: ScanStatus): Scan[] {
    return this.list().filter((s) => s.status === status);
  }
}
