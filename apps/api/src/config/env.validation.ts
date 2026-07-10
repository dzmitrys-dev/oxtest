import * as Joi from 'joi';

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
});
