// M10: OpenTelemetry for the API and worker processes. Imported FIRST by main.ts and worker.ts,
// so the instrumentations can wrap http, fetch (undici), pg and ioredis before anything loads
// them. Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set (tests never import this file).
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const service = process.argv.some((a) => a.endsWith('worker.js'))
  ? 'modelops-worker'
  : 'modelops-api';

export const tracing = endpoint
  ? new NodeSDK({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: service }),
      traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/+$/, '')}/v1/traces` }),
      instrumentations: [
        new HttpInstrumentation({
          // Health probes every few seconds would drown the real traffic.
          ignoreIncomingRequestHook: (req) => (req.url ?? '').includes('/health/'),
        }),
        new UndiciInstrumentation(),
        // Statement text is not recorded: it can contain user data in parameters (SEC-14).
        new PgInstrumentation({ enhancedDatabaseReporting: false }),
        new IORedisInstrumentation(),
      ],
    })
  : null;
tracing?.start();
process.once('SIGTERM', () => void tracing?.shutdown());
