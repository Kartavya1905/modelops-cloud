import {
  type Span,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/**
 * M10 tracing. The predict path is instrumented explicitly (a SERVER span per request, a CLIENT
 * span around the model-server call, W3C `traceparent` passed on), which is exact and needs no
 * module patching (the gateway is an ES module). Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set;
 * without it every span is a no-op.
 */
export function startTracing(
  service: string,
  endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
): NodeSDK | null {
  if (!endpoint) return null;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: service,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/+$/, '')}/v1/traces` }),
    instrumentations: [],
  });
  sdk.start();
  return sdk;
}

const tracer = () => trace.getTracer('modelops-gateway');

/** Runs `fn` inside a SERVER span continuing the caller's trace (if it sent `traceparent`). */
export async function inServerSpan<T>(
  name: string,
  headers: Record<string, unknown>,
  attributes: Record<string, string>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const parent = propagation.extract(context.active(), headers);
  const span = tracer().startSpan(name, { kind: SpanKind.SERVER, attributes }, parent);
  return context.with(trace.setSpan(parent, span), async () => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** A CLIENT span for an outgoing call; returns the headers that carry it downstream. */
export function clientSpan(name: string, attributes: Record<string, string>) {
  const span = tracer().startSpan(name, { kind: SpanKind.CLIENT, attributes }, context.active());
  const headers: Record<string, string> = {};
  propagation.inject(trace.setSpan(context.active(), span), headers);
  return { span, headers };
}

/** The trace id to hand back to the client (X-Trace-Id), or null when tracing is off. */
export function traceIdOf(span: Span): string | null {
  const ctx = span.spanContext();
  return trace.isSpanContextValid(ctx) && ctx.traceFlags & 1 ? ctx.traceId : null;
}

export { SpanStatusCode };
