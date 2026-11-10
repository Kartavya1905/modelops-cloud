import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/common/errors/app-error';
import { parseMetricsQuery } from '../../src/modules/metrics/metrics.service';
import {
  countQueries,
  RANGES,
  selector,
  SERIES_NAMES,
  seriesQueries,
} from '../../src/modules/metrics/series';

const ID = '0b9f6c1e-5d2a-4f7b-9c3d-2e1f0a9b8c7d';

const rejects = (q: Record<string, unknown>) => {
  try {
    parseMetricsQuery(q);
  } catch (err) {
    return err instanceof AppError ? err.code : 'OTHER';
  }
  return 'ACCEPTED';
};

describe('SEC-15: only allow-listed metrics, never caller-supplied PromQL', () => {
  it('accepts the documented ranges and series names', () => {
    expect(parseMetricsQuery({})).toEqual({ range: '1h', series: [...SERIES_NAMES] });
    expect(parseMetricsQuery({ range: '15m', series: 'rps,latency' })).toEqual({
      range: '15m',
      series: ['rps', 'latency'],
    });
  });

  it.each([
    [{ series: 'sum(up)' }],
    [{ series: 'rps,{__name__=~".+"}' }],
    [{ query: 'up' }],
    [{ promql: 'up' }],
    [{ range: '1y' }],
    [{ range: '1h; drop' }],
    [{ step: '1s' }],
    [{ series: ['rps', 'latency'] }],
  ])('400 for %j', (q) => {
    expect(rejects(q)).toBe('VALIDATION_FAILED');
  });

  it('selectors are built only from UUIDs', () => {
    expect(selector([ID])).toBe(`endpoint_id="${ID}"`);
    expect(() => selector(['x"} or vector(1) or {a="'])).toThrow();
    expect(() => selector([])).toThrow();
  });

  it('every query is a fixed template around the selector', () => {
    const sel = selector([ID]);
    for (const name of SERIES_NAMES) {
      for (const q of seriesQueries(name, sel, RANGES['1h'].window)) {
        // nothing but the endpoint id varies
        expect(q.query.replaceAll(ID, '<id>')).not.toContain(ID);
        expect(q.query).toContain(`endpoint_id="${ID}"`);
      }
    }
    const [errorRate] = seriesQueries('errorRate', sel, '1m');
    expect(errorRate?.query).toContain('or vector(0)'); // 0 errors reads as 0%, not as a gap
    const c = countQueries(sel, 3600, '5..');
    expect(c.before).toBe(`sum(gateway_requests_total{${sel},code=~"5.."} offset 3600s)`);
  });
});
