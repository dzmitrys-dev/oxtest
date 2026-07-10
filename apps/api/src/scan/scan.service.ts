import type { Scan } from '../domain/scan.types';

/**
 * RED stub — real queue submission / read orchestration lands in the GREEN step.
 */
export class ScanService {
  enqueue(_repoUrl: string): Promise<Scan> {
    return Promise.reject(new Error('not implemented'));
  }

  get(_id: string): Promise<Scan | null> {
    return Promise.reject(new Error('not implemented'));
  }
}
