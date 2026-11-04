import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/config';

const valid = {
  DATABASE_URL: 'postgresql://modelops_app:s3cret@127.0.0.1:15432/modelops',
  REDIS_URL: 'redis://:s3cret@127.0.0.1:16379/0',
};

describe('loadConfig', () => {
  it('applies defaults for optional values', () => {
    const c = loadConfig(valid);
    expect(c).toMatchObject({ host: '127.0.0.1', port: 4000, healthCheckTimeoutMs: 2000 });
  });

  it('coerces numeric strings', () => {
    expect(loadConfig({ ...valid, MO_PORT_API: '4100' }).port).toBe(4100);
  });

  it('fails with the variable name when a required value is missing', () => {
    expect(() => loadConfig({ REDIS_URL: valid.REDIS_URL })).toThrow(ConfigError);
    expect(() => loadConfig({ REDIS_URL: valid.REDIS_URL })).toThrow(/DATABASE_URL/);
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
