import type { Scan, ScanFailureReason } from '../domain/scan.types';
import type { Vulnerability } from '../domain/vulnerability.types';

/**
 * Framework-free persistence contract (D-03). This file must never import
 * Nest, BullMQ, ioredis, node:fs, or node:child_process — the concrete Redis
 * adapter binds behind this port so tests can substitute a fake.
 *
 * All methods are asynchronous because the authoritative store is Redis.
 * Terminal-state guards (D-10) and the seven-day TTL refresh (D-08) are owned
 * by the repository implementation, not the caller.
 */
export interface ScanRepository {
  /** Persist a freshly-enqueued Queued scan and initialise its result list. */
  create(scan: Scan): Promise<void>;

  /** Reconstruct one complete Scan, or null when the record is absent (D-11). */
  get(id: string): Promise<Scan | null>;

  /** Transition Queued → Scanning; no-op when already terminal. */
  markScanning(id: string): Promise<void>;

  /** Append one CRITICAL finding preserving discovery order (D-07). */
  appendVulnerability(id: string, vulnerability: Vulnerability): Promise<void>;

  /** Transition → Finished; rejected if already terminal (D-10). */
  markFinished(id: string): Promise<void>;

  /** Transition → Failed with a bounded reason; rejected if already terminal. */
  markFailed(id: string, reason: ScanFailureReason): Promise<void>;
}

/**
 * DI token for the repository port. A plain Symbol is framework-neutral; the
 * module (a later plan) binds the concrete adapter to this token.
 */
export const SCAN_REPOSITORY = Symbol('SCAN_REPOSITORY');
