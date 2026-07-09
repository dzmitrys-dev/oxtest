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
});
