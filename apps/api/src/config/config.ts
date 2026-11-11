import { z } from 'zod';

/**
 * Typed, validated runtime configuration.
 * The process refuses to start with a clear message if a variable is missing or malformed,
 * instead of failing later with a confusing connection error.
 */
const booleanString = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((v) => v === 'true');

const ConfigSchema = z.object({
  MO_API_HOST: z.string().min(1).default('127.0.0.1'),
  MO_PORT_API: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  MO_HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),
  MO_API_SESSION_PEPPER: z.string().min(32, 'must be at least 32 characters'),
  MO_COOKIE_SECURE: booleanString('false'),
  MO_WEB_URL: z.url().default('http://127.0.0.1:3300'),
  MO_API_DOCS: booleanString('true'),
  MO_MLFLOW_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:15000'),
  MO_MLFLOW_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
  // M4: object storage + ML worker + validation queue
  MO_S3_ENDPOINT: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:18333'),
  MO_S3_ACCESS_KEY: z.string().min(8),
  MO_S3_SECRET_KEY: z.string().min(16),
  MO_S3_REGION: z.string().min(1).default('us-east-1'),
  MO_ARTIFACT_BUCKET: z.string().min(3).default('model-artifacts'),
  MO_ML_WORKER_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:18100'),
  MO_ML_WORKER_TOKEN: z.string().min(32, 'must be at least 32 characters'),
  MO_VALIDATION_SWEEP_MS: z.coerce.number().int().min(200).max(600_000).default(15_000),
  MO_VALIDATION_LEASE_MS: z.coerce.number().int().min(1000).max(3_600_000).default(600_000),
  MO_VALIDATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  // M5: deployments (worker -> Docker socket proxy -> model servers) and the inference gateway
  MO_DOCKER_PROXY_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:12375'),
  MO_MODEL_SERVER_IMAGE: z.string().min(1).default('modelops/model-server:dev'),
  MO_INFERENCE_NETWORK: z.string().min(1).default('modelops-inference'),
  /** How containers on the inference network reach object storage (presigned URL host). */
  MO_S3_INTERNAL_ENDPOINT: z.url({ protocol: /^https?$/ }).default('http://seaweedfs:8333'),
  MO_GATEWAY_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:18088'),
  MO_GATEWAY_ADMIN_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:18089'),
  MO_GATEWAY_INTERNAL_TOKEN: z.string().min(32, 'must be at least 32 characters'),
  MO_API_KEY_PEPPER: z.string().min(32, 'must be at least 32 characters'),
  MO_DEPLOY_RELAY_MS: z.coerce.number().int().min(50).max(60_000).default(500),
  MO_RECONCILE_MS: z.coerce.number().int().min(200).max(600_000).default(15_000),
  // M12: failed health checks in a row before a RUNNING model server counts as hung (docs/05).
  MO_UNHEALTHY_STREAK: z.coerce.number().int().min(1).max(20).default(3),
  // A crashed worker's deploy job is redelivered after its lock expires (renewed while it runs).
  // M10: where model servers send traces (they live on the internal network). Empty = off.
  MO_MODEL_SERVER_OTLP_ENDPOINT: z.string().default(''),
  // M10: where model servers run. docker (socket proxy, M5) or kubernetes (kind, ADR-0005).
  MO_RUNTIME_DRIVER: z.enum(['docker', 'kubernetes']).default('docker'),
  MO_K8S_NAMESPACE: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/)
    .default('modelops-models'),
  /** kubeconfig context to use from the host ('' = in-cluster service account, or the current one) */
  MO_K8S_CONTEXT: z.string().default(''),
  /**
   * What model-server pods may reach besides DNS: comma-separated `cidr:port` (object storage,
   * trace collector). Port-scoped on purpose: the compose services share one subnet, and a model
   * server must reach S3 but never Postgres or Redis. '' = DNS only.
   */
  MO_K8S_EGRESS: z
    .string()
    .regex(
      /^(?:\s*\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}:\d{1,5}\s*(?:,|$))*$/,
      'MO_K8S_EGRESS must be comma-separated cidr:port entries',
    )
    .default(''),
  MO_DEPLOY_LOCK_MS: z.coerce.number().int().min(5_000).max(600_000).default(30_000),
  MO_DRAIN_GRACE_MS: z.coerce.number().int().min(0).max(86_400_000).default(1_800_000),
  MO_CANARY_ANALYSIS_MS: z.coerce.number().int().min(200).max(600_000).default(15_000),
  // M6: dashboards read Prometheus through allow-listed queries only
  MO_PROMETHEUS_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:19090'),
  // M7: monitoring
  MO_CAPTURE_BUCKET: z.string().min(3).default('drift-captures'),
  MO_DRIFT_INTERVAL_MS: z.coerce.number().int().min(10_000).max(86_400_000).default(3_600_000),
  MO_DRIFT_WINDOW_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  MO_DRIFT_MIN_SAMPLES: z.coerce.number().int().min(30).max(100_000).default(100),
  MO_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  /** Labels every container this deployment creates; a reconciler only manages its own. */
  MO_INSTANCE_ID: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/, 'lowercase letters, digits and dashes')
    .default('dev'),
});

export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  healthCheckTimeoutMs: number;
  /** Server-side secret for CSRF token derivation and IP hashing. */
  sessionPepper: string;
  cookieSecure: boolean;
  webUrl: string;
  apiDocsEnabled: boolean;
  mlflowUrl: string;
  mlflowTimeoutMs: number;
  s3: {
    endpoint: string;
    accessKey: string;
    secretKey: string;
    region: string;
    artifactBucket: string;
  };
  mlWorker: { url: string; token: string };
  validation: { sweepMs: number; leaseMs: number; maxAttempts: number };
  /** HMAC pepper for inference API keys (shared with the gateway, ADR-0006). */
  apiKeyPepper: string;
  prometheusUrl: string;
  monitoring: {
    captureBucket: string;
    driftIntervalMs: number;
    driftWindowHours: number;
    driftMinSamples: number;
    retentionDays: number;
  };
  deploy: {
    dockerProxyUrl: string;
    modelServerImage: string;
    inferenceNetwork: string;
    s3InternalEndpoint: string;
    gatewayUrl: string;
    gatewayAdminUrl: string;
    gatewayToken: string;
    relayMs: number;
    /** BullMQ lock of a running deploy job; bounds recovery after a worker crash (M9) */
    lockMs: number;
    /** M10: OTLP endpoint passed to model servers ('' = tracing off) */
    modelServerOtlpEndpoint: string;
    /** M10: runtime of model servers, and how they are addressed */
    runtime: {
      driver: 'docker' | 'kubernetes';
      namespace: string;
      context: string;
      egress: { cidr: string; port: number }[];
      /** DNS suffix of `mo-rev-<id>` ('' on Docker; `<namespace>.svc.cluster.local` on k8s) */
      modelServerDomain: string;
    };
    reconcileMs: number;
    /** failed health checks in a row before a running model server is restarted */
    unhealthyStreak: number;
    drainGraceMs: number;
    /** M8: how often the worker analyses running canaries */
    canaryAnalysisMs: number;
    instanceId: string;
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    // Report variable names and problems only; never echo values (they may be secrets).
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration. Did you run \`pnpm env:init\`?\n${problems}`);
  }
  const c = parsed.data;
  return {
    host: c.MO_API_HOST,
    port: c.MO_PORT_API,
    databaseUrl: c.DATABASE_URL,
    redisUrl: c.REDIS_URL,
    healthCheckTimeoutMs: c.MO_HEALTH_CHECK_TIMEOUT_MS,
    sessionPepper: c.MO_API_SESSION_PEPPER,
    cookieSecure: c.MO_COOKIE_SECURE,
    webUrl: c.MO_WEB_URL,
    apiDocsEnabled: c.MO_API_DOCS,
    mlflowUrl: c.MO_MLFLOW_URL.replace(/\/+$/, ''),
    mlflowTimeoutMs: c.MO_MLFLOW_TIMEOUT_MS,
    s3: {
      endpoint: c.MO_S3_ENDPOINT,
      accessKey: c.MO_S3_ACCESS_KEY,
      secretKey: c.MO_S3_SECRET_KEY,
      region: c.MO_S3_REGION,
      artifactBucket: c.MO_ARTIFACT_BUCKET,
    },
    mlWorker: { url: c.MO_ML_WORKER_URL.replace(/\/+$/, ''), token: c.MO_ML_WORKER_TOKEN },
    validation: {
      sweepMs: c.MO_VALIDATION_SWEEP_MS,
      leaseMs: c.MO_VALIDATION_LEASE_MS,
      maxAttempts: c.MO_VALIDATION_MAX_ATTEMPTS,
    },
    apiKeyPepper: c.MO_API_KEY_PEPPER,
    prometheusUrl: c.MO_PROMETHEUS_URL.replace(/\/+$/, ''),
    monitoring: {
      captureBucket: c.MO_CAPTURE_BUCKET,
      driftIntervalMs: c.MO_DRIFT_INTERVAL_MS,
      driftWindowHours: c.MO_DRIFT_WINDOW_HOURS,
      driftMinSamples: c.MO_DRIFT_MIN_SAMPLES,
      retentionDays: c.MO_RETENTION_DAYS,
    },
    deploy: {
      dockerProxyUrl: c.MO_DOCKER_PROXY_URL.replace(/\/+$/, ''),
      modelServerImage: c.MO_MODEL_SERVER_IMAGE,
      inferenceNetwork: c.MO_INFERENCE_NETWORK,
      s3InternalEndpoint: c.MO_S3_INTERNAL_ENDPOINT.replace(/\/+$/, ''),
      gatewayUrl: c.MO_GATEWAY_URL.replace(/\/+$/, ''),
      gatewayAdminUrl: c.MO_GATEWAY_ADMIN_URL.replace(/\/+$/, ''),
      gatewayToken: c.MO_GATEWAY_INTERNAL_TOKEN,
      relayMs: c.MO_DEPLOY_RELAY_MS,
      lockMs: c.MO_DEPLOY_LOCK_MS,
      modelServerOtlpEndpoint: c.MO_MODEL_SERVER_OTLP_ENDPOINT,
      runtime: {
        driver: c.MO_RUNTIME_DRIVER,
        namespace: c.MO_K8S_NAMESPACE,
        context: c.MO_K8S_CONTEXT,
        egress: c.MO_K8S_EGRESS.split(',')
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => {
            const i = x.lastIndexOf(':');
            return { cidr: x.slice(0, i), port: Number(x.slice(i + 1)) };
          }),
        modelServerDomain:
          c.MO_RUNTIME_DRIVER === 'kubernetes' ? `${c.MO_K8S_NAMESPACE}.svc.cluster.local` : '',
      },
      reconcileMs: c.MO_RECONCILE_MS,
      unhealthyStreak: c.MO_UNHEALTHY_STREAK,
      drainGraceMs: c.MO_DRAIN_GRACE_MS,
      canaryAnalysisMs: c.MO_CANARY_ANALYSIS_MS,
      instanceId: c.MO_INSTANCE_ID,
    },
  };
}
