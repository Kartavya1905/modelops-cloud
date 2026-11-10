/* global __ENV, __ITER, __VU -- k6 runtime globals */
// k6 load script for one endpoint (run by scripts/demo-traffic.mjs inside grafana/k6).
// Constant arrival rate, so the number of requests is known in advance and comparable with the
// dashboard's exact counts. Prints a one-line JSON summary on stdout for machines.
import { check } from 'k6';
import http from 'k6/http';

const RPS = Number(__ENV.RPS || 10);
const DURATION = __ENV.DURATION || '30s';

export const options = {
  scenarios: {
    predict: {
      executor: 'constant-arrival-rate',
      rate: RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(5, RPS),
      maxVUs: Math.max(20, RPS * 4),
    },
  },
  // Cut the default output down: the JSON summary below is what matters.
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

const url = `${__ENV.GATEWAY}/v1/endpoints/${__ENV.ENDPOINT}/predict`;
const params = {
  headers: { authorization: `Bearer ${__ENV.API_KEY}`, 'content-type': 'application/json' },
  tags: { name: 'predict' },
};
const bodies = JSON.parse(__ENV.BODIES); // array of request bodies, used round-robin

export default function () {
  const body = bodies[(__ITER + __VU) % bodies.length];
  const res = http.post(url, JSON.stringify(body), params);
  check(res, { 'status is 200': (r) => r.status === 200 });
}

export function handleSummary(data) {
  const m = data.metrics;
  const summary = {
    requests: m.http_reqs.values.count,
    failed: m.http_req_failed.values.passes,
    checksPassed: m.checks ? m.checks.values.passes : 0,
    p95Ms: m.http_req_duration.values['p(95)'],
    p99Ms: m.http_req_duration.values['p(99)'],
    avgMs: m.http_req_duration.values.avg,
    rps: m.http_reqs.values.rate,
  };
  return { stdout: `K6_SUMMARY ${JSON.stringify(summary)}\n` };
}
