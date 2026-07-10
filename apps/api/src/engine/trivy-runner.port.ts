/**
 * Options for a single Trivy run. The optional readiness callback is invoked
 * as the LAST adapter action, only after the host report file has been
 * stat-validated, so a downstream parser is never handed a missing/partial
 * report (D-16, T-03-06).
 */
export interface TrivyRunOptions {
  onReportReady?: (reportPath: string) => Promise<void>;
}

/**
 * Framework-free Trivy execution contract (D-03). Command/binary selection and
 * exit-code semantics stay behind the adapter; the report is always written to
 * disk (never returned as buffered stdout). Vulnerability findings are a
 * SUCCESSFUL run (`--exit-code 0`), not a failure (ERR-01).
 */
export interface TrivyRunner {
  run(
    cloneDir: string,
    reportPath: string,
    options?: TrivyRunOptions,
  ): Promise<void>;
}

export const TRIVY_RUNNER = Symbol('TRIVY_RUNNER');
