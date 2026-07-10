import type {
  ScanFailureCategory,
  ScanFailureReason,
} from '../domain/scan.types';

/**
 * The engine stage that produced a failure. ENOSPC anywhere is promoted to
 * `disk-full` regardless of stage (ERR-03); otherwise the stage maps directly
 * to its category.
 */
export type ScanErrorStage = 'clone' | 'trivy' | 'parse';

/** Persisted detail is bounded to 500 characters (D-20). */
const MAX_DETAIL_LENGTH = 500;

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function errorStderr(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'stderr' in error) {
    const { stderr } = error;
    return typeof stderr === 'string' ? stderr : '';
  }
  return '';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}

function isDiskFull(error: unknown): boolean {
  if (errorCode(error) === 'ENOSPC') {
    return true;
  }
  const haystack = `${errorMessage(error)} ${errorStderr(error)}`;
  return /ENOSPC|no space left on device/i.test(haystack);
}

/**
 * Redact secrets and uncontrolled filesystem paths from a diagnostic string
 * (D-21, T-03-07). Raw stderr, credentials, and absolute paths must never
 * reach persisted Redis state; detailed diagnostics stay in worker logs only.
 */
function redact(input: string): string {
  let output = input;
  // URL userinfo credentials: scheme://user:token@host → scheme://***@host
  output = output.replace(/([a-zA-Z][\w+.-]*:\/\/)[^\s/@]+@/g, '$1***@');
  // Windows absolute paths: C:\a\b\c
  output = output.replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>');
  // POSIX absolute paths (>=2 segments), not the // of a URL authority.
  output = output.replace(/(?<![\w:])\/(?:[\w.-]+\/)+[\w.-]*/g, '<path>');
  return output;
}

/**
 * Normalize an unknown thrown value into a bounded, sanitized, categorized
 * failure reason suitable for persistence on a `Failed` scan.
 */
export function classifyScanError(
  stage: ScanErrorStage,
  error: unknown,
): ScanFailureReason {
  const category: ScanFailureCategory = isDiskFull(error) ? 'disk-full' : stage;
  const detail = redact(errorMessage(error)).slice(0, MAX_DETAIL_LENGTH);
  return { category, detail };
}
