import { randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { Counter as PromCounter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { GatewayConfig } from './config.js';
import type { RoutedEndpoint, RoutedRevision } from './contract.js';
import { CircuitBreaker, type FieldError, RateLimiter, toMatrix } from './guards.js';
import type { KeyVerifier } from './keys.js';
import type { RoutingTable } from './routing.js';

export interface Deps {
  config: GatewayConfig;
  routing: RoutingTable;
  keys: KeyVerifier;
  limiter: RateLimiter;
  breaker?: CircuitBreaker;
  /** Injected in tests; real HTTP otherwise. */
  fetchFn?: typeof fetch;
  /** Health of the Redis connection, for /readyz. */
  redisReady?: () => boolean;
}

const REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** Playground calls per user per second, per endpoint (it's for trying things, not load). */
export const PLAYGROUND_RPS = 5;

function problem(
  reply: FastifyReply,
  status: number,
  code: string,
  title: string,
  detail?: string,
  errors?: FieldError[],
) {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({
      type: `https://modelops.local/problems/${code.toLowerCase().replaceAll('_', '-')}`,
      title,
      status,
      code,
      ...(detail ? { detail } : {}),
      ...(errors ? { errors } : {}),
      requestId: reply.request.id,
    });
}

type RequestLabel = 'endpoint_id' | 'endpoint' | 'revision' | 'model_version' | 'source';

/**
 * Prometheus series (scraped by Prometheus, read by the API's allow-listed queries, M6).
 * `endpoint_id` is the stable key (slugs are only unique per project); `source` separates client
 * traffic (`api`) from the UI playground (`playground`).
 */
export function createMetrics(): {
  registry: Registry;
  requests: PromCounter<RequestLabel | 'code'>;
  duration: Histogram<RequestLabel>;
  upstream: Histogram<'revision'>;
  rateLimitFailOpen: PromCounter;
} {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'gateway_' });
  return {
    registry,
    requests: new PromCounter({
      name: 'gateway_requests_total',
      help: 'Predict requests by endpoint, revision, model version, status code and source',
      labelNames: ['endpoint_id', 'endpoint', 'revision', 'model_version', 'code', 'source'],
      registers: [registry],
    }),
    duration: new Histogram({
      name: 'gateway_request_duration_seconds',
      help: 'End-to-end predict latency at the gateway',
      labelNames: ['endpoint_id', 'endpoint', 'revision', 'model_version', 'source'],
      buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [registry],
    }),
    upstream: new Histogram({
      name: 'gateway_upstream_duration_seconds',
      help: 'Model server call latency',
      labelNames: ['revision'],
      buckets: [0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
      registers: [registry],
    }),
    rateLimitFailOpen: new PromCounter({
      name: 'gateway_rate_limit_fail_open_total',
      help: 'Requests allowed because the rate limiter could not reach Redis',
      registers: [registry],
    }),
  };
}

function baseServer(bodyLimit: number): FastifyInstance {
  const app = Fastify({
    bodyLimit,
    // Request bodies are model inputs: they are never logged (SEC-14). Only our own summary line.
    disableRequestLogging: true,
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
  });
  app.setErrorHandler(
    (err: { statusCode?: number; code?: string; message: string }, _req, reply) => {
      if (err.statusCode === 413) {
        return problem(reply, 413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
      }
      if (err.statusCode && err.statusCode < 500) {
        return problem(reply, 400, 'VALIDATION_FAILED', 'Invalid request', 'Malformed JSON body');
      }
      reply.log.error({ code: err.code }, 'unhandled gateway error');
      return problem(reply, 500, 'INTERNAL_ERROR', 'Internal error');
    },
  );
  app.setNotFoundHandler((_req, reply) => problem(reply, 404, 'NOT_FOUND', 'Not found'));
  return app;
}

interface PredictParams {
  slug: string;
}

/** Shapes the model server's tensors into the public response format (docs/04 §4). */
function toOutputs(rev: RoutedRevision, outputs: Record<string, unknown[]>) {
  const labels = outputs.label ?? [];
  const probabilities = (outputs.probabilities ?? []) as number[][];
  return labels.map((label, i) => ({
    label,
    probabilities: Object.fromEntries(
      rev.classes.map((c, j) => [String(c), probabilities[i]?.[j] ?? null]),
    ),
  }));
}

export type Metrics = ReturnType<typeof createMetrics>;

/**
 * The predict pipeline after authentication and endpoint lookup, shared by the public API and
 * the internal playground route: rate limit -> signature validation -> circuit breaker ->
 * model server (with a deadline) -> response shaping -> metrics. Inputs are never logged.
 */
export function createPredictor(deps: Deps, metrics: Metrics) {
  const { config, limiter } = deps;
  const breaker = deps.breaker ?? new CircuitBreaker();
  const fetchFn = deps.fetchFn ?? fetch;

  return async function predict(
    req: FastifyRequest,
    reply: FastifyReply,
    endpoint: RoutedEndpoint,
    opts: { rateKey: string; limitRps: number; source: 'api' | 'playground'; started: number },
  ) {
    const rev = endpoint.revision;
    if (!rev) {
      return problem(reply, 503, 'NO_READY_REVISION', 'No revision is serving this endpoint');
    }
    const labels = {
      endpoint_id: endpoint.endpointId,
      endpoint: endpoint.slug,
      revision: rev.id,
      model_version: String(rev.modelVersion),
      source: opts.source,
    };
    const done = (code: number) => {
      metrics.requests.inc({ ...labels, code: String(code) });
      metrics.duration.observe(labels, (performance.now() - opts.started) / 1000);
    };

    if (!(await limiter.allow(endpoint.endpointId, opts.rateKey, opts.limitRps))) {
      done(429);
      reply.header('Retry-After', '1');
      return problem(
        reply,
        429,
        'RATE_LIMITED',
        'Too many requests',
        `Limit: ${String(opts.limitRps)} requests/second per key.`,
      );
    }
    const parsed = toMatrix(req.body, rev.features, config.maxBatch);
    if ('errors' in parsed) {
      done(400);
      return problem(
        reply,
        400,
        'VALIDATION_FAILED',
        'Inputs do not match the model signature',
        undefined,
        parsed.errors,
      );
    }
    if (!breaker.canPass(rev.id)) {
      done(503);
      return problem(
        reply,
        503,
        'NO_READY_REVISION',
        'Model server unavailable',
        'Circuit open after repeated upstream failures.',
      );
    }

    const hostname = new URL(rev.url).hostname;
    if (!config.upstreamPattern.test(hostname)) {
      done(502);
      return problem(reply, 502, 'UPSTREAM_ERROR', 'Bad upstream');
    }
    const upstreamStart = performance.now();
    let res: Response | undefined;
    let timedOut = false;
    try {
      res = await fetchFn(`${rev.url}/v1/predict`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-id': req.id },
        body: JSON.stringify({ inputs: parsed.rows }),
        signal: AbortSignal.timeout(config.upstreamTimeoutMs),
      });
    } catch (err) {
      timedOut = (err as Error).name === 'TimeoutError';
    } finally {
      metrics.upstream.observe({ revision: rev.id }, (performance.now() - upstreamStart) / 1000);
    }
    if (!res) {
      breaker.failure(rev.id);
      done(timedOut ? 504 : 502);
      return timedOut
        ? problem(
            reply,
            504,
            'UPSTREAM_TIMEOUT',
            'Model server timed out',
            `No answer within ${String(config.upstreamTimeoutMs)} ms.`,
          )
        : problem(reply, 502, 'UPSTREAM_ERROR', 'Model server unreachable');
    }
    if (!res.ok) {
      if (res.status >= 500) breaker.failure(rev.id);
      done(502);
      return problem(
        reply,
        502,
        'UPSTREAM_ERROR',
        'Model server error',
        `HTTP ${String(res.status)}`,
      );
    }
    breaker.success(rev.id);
    const body = (await res.json()) as { outputs: Record<string, unknown[]> };
    const outputs = toOutputs(rev, body.outputs);
    const latencyMs = Math.round((performance.now() - opts.started) * 100) / 100;
    done(200);
    req.log.info(
      {
        endpoint: endpoint.slug,
        revision: rev.id,
        rows: outputs.length,
        latencyMs,
        source: opts.source,
      },
      'predict',
    );
    reply.header('X-Model-Version', String(rev.modelVersion)).header('X-Revision-Id', rev.id);
    return {
      predictionIds: outputs.map(() => randomUUID()),
      model: { name: rev.modelName, version: rev.modelVersion, framework: rev.framework },
      revisionId: rev.id,
      outputs,
      latencyMs,
    };
  };
}

export function buildPublicApp(deps: Deps, metrics = createMetrics()): FastifyInstance {
  const { config, routing, keys } = deps;
  const predict = createPredictor(deps, metrics);
  const app = baseServer(config.bodyLimitBytes);

  app.get('/healthz', () => ({ status: 'ok' }));

  app.post<{ Params: PredictParams }>(
    '/v1/endpoints/:slug/predict',
    async (req: FastifyRequest<{ Params: PredictParams }>, reply) => {
      const started = performance.now();
      const key = await keys.verify(req.headers.authorization);
      if (!key || !key.scopes.includes('predict')) {
        return problem(
          reply,
          401,
          'INVALID_API_KEY',
          'Invalid API key',
          'Send `Authorization: Bearer mo_…`.',
        );
      }
      const { slug } = req.params;
      // A key is project-scoped: another project's endpoint simply does not exist for it (SEC-11).
      const endpoint = SLUG.test(slug) ? routing.lookup(key.projectId, slug) : undefined;
      if (!endpoint) return problem(reply, 404, 'ENDPOINT_NOT_FOUND', 'Endpoint not found');
      return predict(req, reply, endpoint, {
        rateKey: key.id,
        limitRps: endpoint.rateLimitRps,
        source: 'api',
        started,
      });
    },
  );
  return app;
}

/**
 * Internal admin API (separate port, never exposed beyond 127.0.0.1): lets the worker probe a
 * revision's model server, which lives on the internal-only network, and serves /metrics.
 */
export function buildAdminApp(deps: Deps, metrics: Metrics): FastifyInstance {
  const { config, routing } = deps;
  const predict = createPredictor(deps, metrics);
  const fetchFn = deps.fetchFn ?? fetch;
  const app = baseServer(1024 * 1024);
  const token = Buffer.from(config.internalToken);

  app.get('/healthz', () => ({ status: 'ok' }));
  app.get('/readyz', (_req, reply) => {
    const ok = routing.ready && (deps.redisReady?.() ?? true);
    return reply.code(ok ? 200 : 503).send({ ready: ok, routingHash: routing.hash });
  });
  app.get('/metrics', async (_req, reply) =>
    reply.type(metrics.registry.contentType).send(await metrics.registry.metrics()),
  );

  // Callback-style plugin: it registers routes synchronously.
  app.register((internal, _opts, registered) => {
    internal.addHook('onRequest', async (req, reply) => {
      const given = Buffer.from(String(req.headers['x-modelops-token'] ?? ''));
      if (given.length !== token.length || !timingSafeEqual(given, token)) {
        return problem(reply, 401, 'UNAUTHENTICATED', 'Internal token required');
      }
    });
    const upstream = (id: string) =>
      /^[0-9a-f-]{36}$/.test(id) ? `http://mo-rev-${id}:8000` : null;

    /**
     * UI playground (M6): the API calls this on behalf of a signed-in user, who has no API key.
     * Same pipeline as the public route (validation, routing, metrics with source="playground"),
     * rate-limited per user at a low fixed rate.
     */
    internal.post<{ Params: { endpointId: string } }>(
      '/internal/endpoints/:endpointId/predict',
      async (req, reply) => {
        const started = performance.now();
        const actor = String(req.headers['x-playground-actor'] ?? '');
        if (!/^[0-9a-f-]{36}$/.test(actor)) {
          return problem(reply, 400, 'VALIDATION_FAILED', 'X-Playground-Actor must be a user id');
        }
        const endpoint = routing.lookupById(req.params.endpointId);
        if (!endpoint) return problem(reply, 404, 'ENDPOINT_NOT_FOUND', 'Endpoint not found');
        return predict(req, reply, endpoint, {
          rateKey: `playground:${actor}`,
          limitRps: Math.min(endpoint.rateLimitRps, PLAYGROUND_RPS),
          source: 'playground',
          started,
        });
      },
    );

    internal.get<{ Params: { id: string } }>(
      '/internal/revisions/:id/readyz',
      async (req, reply) => {
        const base = upstream(req.params.id);
        if (!base) return problem(reply, 400, 'VALIDATION_FAILED', 'Bad revision id');
        const ok = await fetchFn(`${base}/readyz`, { signal: AbortSignal.timeout(2000) }).then(
          (res) => res.ok,
          () => false,
        );
        return reply.code(ok ? 200 : 503).send({ ready: ok });
      },
    );

    internal.post<{ Params: { id: string } }>(
      '/internal/revisions/:id/predict',
      async (req, reply) => {
        const base = upstream(req.params.id);
        if (!base) return problem(reply, 400, 'VALIDATION_FAILED', 'Bad revision id');
        const res = await fetchFn(`${base}/v1/predict`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null);
        if (!res) return problem(reply, 502, 'UPSTREAM_ERROR', 'Model server unreachable');
        return reply
          .code(res.status)
          .type('application/json')
          .send(await res.text());
      },
    );
    registered();
  });
  return app;
}
