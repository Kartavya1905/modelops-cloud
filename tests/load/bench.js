/* global __ENV, __ITER, __VU -- k6 runtime globals */
// M12 benchmark scenarios, run by scripts/bench.mjs inside grafana/k6 on the compose network.
//
//   SCENARIO=steady  constant 50 req/s for DURATION (default 3m)
//   SCENARIO=ramp    constant-rate steps (STEPS="50,100,200,300,400", STEP=45s), one after
//                    another; each step is its own k6 scenario, so its latency is reported alone
//   SCENARIO=direct  constant 50 req/s straight to a model server (DIRECT_URL), no gateway: run on
//                    the internal inference network, with bodies in the model's row format
//   SCENARIO=canary  constant 50 req/s while a canary takes CANARY % of the traffic; every
//                    response is counted by the revision that answered (X-Revision-Id)
//
// The full k6 summary (every metric, every sub-metric) is written to /out/<SCENARIO>.json:
// the raw result the report is generated from.
import { check } from 'k6';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

const SCENARIO = __ENV.SCENARIO || 'steady';
const url =
  SCENARIO === 'direct'
    ? `${__ENV.DIRECT_URL}/v1/predict`
    : `${__ENV.GATEWAY}/v1/endpoints/${__ENV.ENDPOINT}/predict`;
const params = {
  headers:
    SCENARIO === 'direct'
      ? { 'content-type': 'application/json' }
      : { authorization: `Bearer ${__ENV.API_KEY}`, 'content-type': 'application/json' },
  tags: { name: 'predict' },
};
const bodies = JSON.parse(__ENV.BODIES); // request bodies, used round-robin

const byRevision = new Counter('responses_by_revision');
const latencyByRevision = new Trend('latency_by_revision', true);

function constant(rate, duration, startTime) {
  return {
    executor: 'constant-arrival-rate',
    rate,
    timeUnit: '1s',
    duration,
    startTime,
    preAllocatedVUs: Math.max(10, rate),
    maxVUs: Math.max(50, rate * 4),
  };
}

function seconds(d) {
  const m = /^(\d+)(s|m)$/.exec(d);
  return m ? Number(m[1]) * (m[2] === 'm' ? 60 : 1) : 45;
}

const scenarios = {};
const thresholds = {};
if (SCENARIO === 'ramp') {
  const steps = (__ENV.STEPS || '50,100,200,300,400').split(',').map(Number);
  const step = __ENV.STEP || '45s';
  steps.forEach((rate, i) => {
    const name = `rps_${String(rate)}`;
    scenarios[name] = constant(rate, step, `${String(i * (seconds(step) + 5))}s`);
    // A threshold that always passes makes k6 report the sub-metric for this step.
    thresholds[`http_req_duration{scenario:${name}}`] = ['max>=0'];
    thresholds[`http_req_failed{scenario:${name}}`] = ['rate>=0'];
    thresholds[`http_reqs{scenario:${name}}`] = ['count>=0'];
    thresholds[`dropped_iterations{scenario:${name}}`] = ['count>=0'];
  });
} else {
  scenarios[SCENARIO] = constant(Number(__ENV.RPS || 50), __ENV.DURATION || '3m', '0s');
}
if (SCENARIO === 'canary') {
  for (const rev of (__ENV.REVISIONS || '').split(',').filter(Boolean)) {
    thresholds[`responses_by_revision{revision:${rev}}`] = ['count>=0'];
    thresholds[`latency_by_revision{revision:${rev}}`] = ['max>=0'];
  }
}

export const options = {
  scenarios,
  thresholds,
  discardResponseBodies: false,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const body = bodies[(__ITER + __VU) % bodies.length];
  const res = http.post(url, JSON.stringify(body), params);
  check(res, { 'status is 200': (r) => r.status === 200 });
  if (SCENARIO === 'canary' && res.status === 200) {
    const rev = res.headers['X-Revision-Id'] || 'unknown';
    byRevision.add(1, { revision: rev });
    latencyByRevision.add(res.timings.duration, { revision: rev });
  }
}

export function handleSummary(data) {
  return { [`/out/${SCENARIO}.json`]: JSON.stringify(data, null, 1) };
}
