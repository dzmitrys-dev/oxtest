import { envValidationSchema, GIT_TRANSPORT_ALLOWLIST } from './env.validation';

/**
 * CR-01 — fail-closed git transport allowlist. These assertions lock the
 * production posture (HTTPS only) and prove that a future global hardening
 * cannot silently widen git's transport surface: any unlisted transport
 * (notably `ext::`, the RCE vector) refuses to boot.
 */
describe('envValidationSchema — SCAN_GIT_ALLOWED_PROTOCOLS', () => {
  const base = {
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: 6379,
    SCAN_TMP_DIR: '/scan-tmp',
  };

  const allowed = (env: Record<string, unknown>): string | undefined => {
    const result = envValidationSchema.validate(env) as {
      value: { SCAN_GIT_ALLOWED_PROTOCOLS?: string };
    };
    return result.value.SCAN_GIT_ALLOWED_PROTOCOLS;
  };

  it('defaults to https only when unset (production fail-closed default)', () => {
    const { error } = envValidationSchema.validate(base);
    expect(error).toBeUndefined();
    expect(allowed(base)).toBe('https');
  });

  it('accepts the trusted-test https:file widening for local bundle clones', () => {
    const env = { ...base, SCAN_GIT_ALLOWED_PROTOCOLS: 'https:file' };
    const { error } = envValidationSchema.validate(env);
    expect(error).toBeUndefined();
    expect(allowed(env)).toBe('https:file');
  });

  it('rejects the ext:: RCE transport (fail-closed)', () => {
    const { error } = envValidationSchema.validate({
      ...base,
      SCAN_GIT_ALLOWED_PROTOCOLS: 'https:ext',
    });
    expect(error).toBeDefined();
  });

  it.each(['ext', 'ssh', 'http', 'git', '', 'https:ext'])(
    'rejects an unlisted or empty transport value %p',
    (value) => {
      const { error } = envValidationSchema.validate({
        ...base,
        SCAN_GIT_ALLOWED_PROTOCOLS: value,
      });
      expect(error).toBeDefined();
    },
  );

  it('exposes an allowlist that excludes every dangerous user-policy transport', () => {
    expect(GIT_TRANSPORT_ALLOWLIST).toEqual(['https', 'file']);
    expect(GIT_TRANSPORT_ALLOWLIST).not.toContain('ext');
  });
});

/**
 * WR-02 (D-13) — cap SHUTDOWN_GRACE_MS under Docker's 10s SIGTERM→SIGKILL stop
 * window. The backstop fires at grace+margin, so a max of 9000 keeps the drain
 * window closing before an external SIGKILL rather than being hard-killed.
 */
describe('envValidationSchema — SHUTDOWN_GRACE_MS bound (WR-02)', () => {
  const base = {
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: 6379,
    SCAN_TMP_DIR: '/scan-tmp',
  };

  const graceOf = (env: Record<string, unknown>): number | undefined => {
    const result = envValidationSchema.validate(env) as {
      value: { SHUTDOWN_GRACE_MS?: number };
    };
    return result.value.SHUTDOWN_GRACE_MS;
  };

  it('defaults to 8000 when unset (< Docker 10s stop grace)', () => {
    const { error } = envValidationSchema.validate(base);
    expect(error).toBeUndefined();
    expect(graceOf(base)).toBe(8000);
  });

  it('accepts the boundary value 9000', () => {
    const env = { ...base, SHUTDOWN_GRACE_MS: 9000 };
    const { error } = envValidationSchema.validate(env);
    expect(error).toBeUndefined();
    expect(graceOf(env)).toBe(9000);
  });

  it('rejects 9001 (boot refuses — would risk draining past the stop window)', () => {
    const { error } = envValidationSchema.validate({
      ...base,
      SHUTDOWN_GRACE_MS: 9001,
    });
    expect(error).toBeDefined();
  });
});
