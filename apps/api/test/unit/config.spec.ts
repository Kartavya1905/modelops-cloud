import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/config';

const valid = {
  DATABASE_URL: 'postgresql://modelops_app:s3cret@127.0.0.1:15432/modelops',
  REDIS_URL: 'redis://:s3cret@127.0.0.1:16379/0',
  MO_API_SESSION_PEPPER: 'x'.repeat(64),
  MO_S3_ACCESS_KEY: 'a'.repeat(20),
  MO_S3_SECRET_KEY: 's'.repeat(40),
  MO_ML_WORKER_TOKEN: 't'.repeat(64),
};

describe('loadConfig', () => {
  it('applies defaults for optional values', () => {
    const c = loadConfig(valid);
    expect(c).toMatchObject({ host: '127.0.0.1', port: 4000, healthCheckTimeoutMs: 2000 });
  });

  it('parses boolean flags strictly', () => {
    expect(loadConfig({ ...valid, MO_COOKIE_SECURE: 'true' }).cookieSecure).toBe(true);
    expect(loadConfig(valid).cookieSecure).toBe(false);
    expect(() => loadConfig({ ...valid, MO_COOKIE_SECURE: 'yes' })).toThrow(/MO_COOKIE_SECURE/);
  });

  it('rejects a short session pepper', () => {
    expect(() => loadConfig({ ...valid, MO_API_SESSION_PEPPER: 'short' })).toThrow(
      /MO_API_SESSION_PEPPER/,
    );
  });

  it('coerces numeric strings', () => {
    expect(loadConfig({ ...valid, MO_PORT_API: '4100' }).port).toBe(4100);
  });

  it('fails with the variable name when a required value is missing', () => {
    const { DATABASE_URL: _omit, ...withoutDb } = valid;
    expect(() => loadConfig(withoutDb)).toThrow(ConfigError);
    expect(() => loadConfig(withoutDb)).toThrow(/DATABASE_URL/);
  });

  it('rejects a URL with the wrong scheme', () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: 'mysql://x@y/z' })).toThrow(/DATABASE_URL/);
  });

  it('never includes secret values in the error message', () => {
    try {
      loadConfig({ ...valid, REDIS_URL: 'not a url with s3cret-value' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('s3cret-value');
    }
  });
});
