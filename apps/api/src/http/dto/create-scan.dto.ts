/**
 * Minimal typed request contract for `POST /api/scan` (SCAN-01, D-04).
 *
 * Framework-neutral by design: this is the zero-dependency pure-validator path
 * (RESEARCH A4) — the URL is validated by `GithubUrlPipe`/`parseGithubUrl`, so
 * class-validator / class-transformer are deliberately NOT introduced here.
 */
export interface CreateScanDto {
  repoUrl: string;
}
