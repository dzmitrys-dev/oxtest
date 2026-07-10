/**
 * Result of a single exclusive path allocation for one scan. Both paths live
 * beneath the validated `SCAN_TMP_DIR` root; the report path's parent is a
 * SEPARATE directory from the clone directory so Docker can bind-mount the
 * clone read-only at `/src` and the report parent writable at `/out` without
 * overlap (D-16).
 */
export interface ScanPathAllocation {
  cloneDir: string;
  reportPath: string;
}

/**
 * Framework-free contract (D-03). The allocator is the EXCLUSIVE owner of
 * creating both the clone directory and report path under `SCAN_TMP_DIR`, and
 * owns cleanup of any already-created path when a partial allocation fails
 * before {@link ScanPathAllocator.allocate} returns or rejects.
 */
export interface ScanPathAllocator {
  allocate(scanId: string): Promise<ScanPathAllocation>;
}

export const SCAN_PATH_ALLOCATOR = Symbol('SCAN_PATH_ALLOCATOR');
