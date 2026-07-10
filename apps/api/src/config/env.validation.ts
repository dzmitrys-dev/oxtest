import * as Joi from 'joi';

/**
 * Fail-closed git transport allowlist (CR-01). Only these transports may ever be
 * enabled via `SCAN_GIT_ALLOWED_PROTOCOLS`. `https` is the sole production
 * transport; `file` exists exclusively for TRUSTED local infrastructure (the
 * integration harness cloning a committed `.bundle`). Dangerous user-policy
 * transports — notably `ext` (RCE) and network-SSRF vectors — are absent by
 * construction, so any attempt to enable them refuses to boot.
 */
export const GIT_TRANSPORT_ALLOWLIST: readonly string[] = ['https', 'file'];

/**
 * Validate a colon-separated `GIT_ALLOW_PROTOCOL` value against the allowlist,
 * fail-closed: an empty value or any unlisted transport is rejected at boot
 * rather than silently widening git's attack surface (ASVS V14.1).
 */
function validateGitProtocols(
  value: string,
  helpers: Joi.CustomHelpers<string>,
): string | Joi.ErrorReport {
  const tokens = value.split(':').filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return helpers.error('any.invalid');
  }
  for (const token of tokens) {
    if (!GIT_TRANSPORT_ALLOWLIST.includes(token)) {
      return helpers.error('any.invalid');
    }
  }
  return tokens.join(':');
}

/**
 * Boot-time env schema (OPS-03). Connectivity-critical keys are `.required()`
 * with NO default (ASVS V14.1 fail-closed — threat T-01-02): a missing
 * REDIS_HOST/REDIS_PORT/SCAN_TMP_DIR must refuse to boot, never silently
 * fall back to an unsafe default.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),

  // Bounded graceful-shutdown grace window in milliseconds (D-12, ERR-05).
  // Default 8000 is deliberately < Docker's 10s SIGTERM→SIGKILL window so the
  // worker force-closes and exits cleanly before an external SIGKILL. Extends
  // the OPS-03 fail-closed schema: an out-of-range value refuses to boot rather
  // than silently widening the drain past the container stop grace.
  SHUTDOWN_GRACE_MS: Joi.number().integer().min(0).max(60000).default(8000),

  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().port().required(),
  SCAN_TMP_DIR: Joi.string().required(),
  TRIVY_MODE: Joi.string().valid('binary', 'docker').default('binary'),

  // Deterministic fault-injection point for the Plan 04 engine integration
  // harness (D-27). Fail-closed allowlist (ASVS V14.1): any value outside the
  // set refuses to boot rather than silently enabling an unknown fault. The
  // vocabulary mirrors the engine failure categories the worker classifies
  // (clone / trivy / disk-full / parse) plus the inert default.
  SCAN_ENGINE_TEST_FAULT: Joi.string()
    .valid('none', 'clone', 'trivy', 'disk-full', 'parse')
    .default('none'),

  // Report-readiness observability marker consumed by the worker/integration
  // harness at the TrivyRunner readiness seam. Fail-closed allowlist:
  //   'none' → no marker; 'log' → emit a structured "report ready" log line.
  SCAN_ENGINE_READY_MARKER: Joi.string().valid('none', 'log').default('none'),

  // Git transport allowlist forwarded verbatim as `GIT_ALLOW_PROTOCOL` on the
  // clone subprocess (CR-01). Fail-closed default = `https` only, so ext::/file
  // transports (RCE / local-file disclosure) are blocked in production; a
  // trusted test context may widen to `https:file` for local `.bundle` clones.
  SCAN_GIT_ALLOWED_PROTOCOLS: Joi.string()
    .default('https')
    .custom(validateGitProtocols, 'git transport allowlist'),
});
