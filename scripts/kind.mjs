#!/usr/bin/env node
/**
 * kind.mjs: the ModelOps control plane on a local Kubernetes cluster (M10, ADR-0005).
 *
 *   pnpm kind:up            create/reuse the cluster, build + load images, deploy, wait, print URLs
 *   pnpm kind:up --no-build skip the image builds (reuse modelops/*:dev already on this machine)
 *   pnpm kind:down          delete the cluster (the modelops_kind database is kept)
 *
 * What `up` does, in order:
 *   1. Checks the tools (docker, kind, kubectl) and the compose stack (`pnpm dev:up` + `dev:obs`).
 *   2. Creates the kind cluster `modelops` from infra/kind/cluster.yaml (fixed NodePort mappings
 *      on 127.0.0.1) unless it exists.
 *   3. Attaches the kind node to the compose networks, so pods reach Postgres, Redis, SeaweedFS,
 *      MLflow, the ml-worker and the trace collector by their compose names.
 *   4. Builds the four images (api, web, gateway, model-server) and loads them into the node.
 *   5. Creates the database `modelops_kind`, applies the migrations, grants Grafana's read-only
 *      role. The kind platform has its own database and Redis DB 1, and instance id `kind`: it
 *      never touches what the Docker-based dev platform deploys, and the other way round.
 *   6. Writes the overlay's config.env + secrets.env (gitignored) from .env with in-cluster
 *      addresses, applies `kubectl apply -k infra/k8s/overlays/kind`, restarts the deployments
 *      (images are re-tagged :dev on every build) and waits for them.
 *   7. Prints the URLs.
 *
 * Costs nothing: everything runs on this machine (docs/10).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLUSTER = 'modelops';
const CONTEXT = `kind-${CLUSTER}`;
const NODE = `${CLUSTER}-control-plane`;
const DB = 'modelops_kind';
const KIND = process.env.KIND ?? 'kind';
const KUBECTL = process.env.KUBECTL ?? 'kubectl';
const IMAGES = {
  'modelops/api:dev': ['-f', 'apps/api/Dockerfile', '.'],
  'modelops/web:dev': ['-f', 'apps/web/Dockerfile', '.'],
  'modelops/gateway:dev': ['-f', 'apps/gateway/Dockerfile', '.'],
  'modelops/model-server:dev': ['--target', 'runtime', 'services/model-server'],
};
const URLS = {
  web: 'http://127.0.0.1:13400',
  api: 'http://127.0.0.1:14400/api/v1/health/ready',
  gateway: 'http://127.0.0.1:18188',
  grafana: `http://127.0.0.1:${process.env.MO_PORT_GRAFANA ?? '13001'}`,
};

const step = (n, text) => console.log(`\n[kind ${String(n)}/7] ${text}`);
/** Run and capture stdout; throws with stderr on failure. */
const out = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: 'pipe', ...opts }).trim();
/** Run with output streamed to the terminal; exits on failure. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`kind: \`${cmd} ${args.join(' ')}\` failed (exit ${String(r.status)})`);
    process.exit(r.status ?? 1);
  }
}
const kubectl = (args, opts) => run(KUBECTL, ['--context', CONTEXT, ...args], opts);
const psql = (sql, db = 'postgres') =>
  out('docker', [
    'exec',
    'modelops-postgres-1',
    'sh',
    '-c',
    `psql -v ON_ERROR_STOP=1 -tAq -U "$POSTGRES_USER" -d ${db} -c "${sql}"`,
  ]);

function loadEnv() {
  const envFile = join(root, '.env');
  if (!existsSync(envFile)) {
    console.error(
      'kind: .env not found. Run `pnpm env:init && pnpm dev:up && pnpm dev:obs` first.',
    );
    process.exit(1);
  }
  process.loadEnvFile(envFile);
  return process.env;
}

// ---------------------------------------------------------------------------------------------
// 1. Tools and the compose stack
// ---------------------------------------------------------------------------------------------
function preflight() {
  for (const [name, cmd, args] of [
    ['docker', 'docker', ['version', '--format', '{{.Server.Version}}']],
    ['kind', KIND, ['version']],
    ['kubectl', KUBECTL, ['version', '--client']],
  ]) {
    try {
      out(cmd, args);
    } catch {
      console.error(
        `kind: \`${name}\` is not available (set ${name.toUpperCase()}=<path> if it is installed elsewhere).`,
      );
      process.exit(1);
    }
  }
  for (const c of ['postgres', 'redis', 'seaweedfs', 'otel-collector']) {
    const state = (() => {
      try {
        return out('docker', ['inspect', '-f', '{{.State.Status}}', `modelops-${c}-1`]);
      } catch {
        return 'missing';
      }
    })();
    if (state !== 'running') {
      console.error(
        `kind: compose service ${c} is ${state}. Run \`pnpm dev:up && pnpm dev:obs\` first.`,
      );
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 2. + 3. Cluster and networks
// ---------------------------------------------------------------------------------------------
function cluster() {
  const clusters = out(KIND, ['get', 'clusters']).split(/\s+/);
  if (clusters.includes(CLUSTER)) console.log(`cluster ${CLUSTER} exists: reusing it`);
  else run(KIND, ['create', 'cluster', '--config', join('infra', 'kind', 'cluster.yaml')]);
}

function attachNetworks() {
  for (const net of ['modelops-backend', 'modelops-inference']) {
    const attached = out('docker', [
      'inspect',
      '-f',
      '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}',
      NODE,
    ]);
    if (attached.split(' ').includes(net)) continue;
    run('docker', ['network', 'connect', net, NODE]);
  }
  console.log(`${NODE} is attached to the compose networks`);
}

/** Pods resolve compose names to their backend-network addresses (the node's Docker DNS). */
function backendSubnet() {
  return out('docker', [
    'network',
    'inspect',
    'modelops-backend',
    '-f',
    '{{range .IPAM.Config}}{{.Subnet}}{{end}}',
  ]);
}

// ---------------------------------------------------------------------------------------------
// 4. Images
// ---------------------------------------------------------------------------------------------
function images(build) {
  if (build) {
    for (const [tag, args] of Object.entries(IMAGES)) {
      console.log(`building ${tag}`);
      run('docker', ['build', '-q', '-t', tag, ...args]);
    }
  }
  run(KIND, ['load', 'docker-image', ...Object.keys(IMAGES), '--name', CLUSTER]);
}

// ---------------------------------------------------------------------------------------------
// 5. Database
// ---------------------------------------------------------------------------------------------
function database(env) {
  const exists = psql(`SELECT 1 FROM pg_database WHERE datname = '${DB}'`);
  if (exists !== '1') {
    psql(`CREATE DATABASE ${DB} OWNER ${env.MO_DB_APP_USER}`);
    console.log(`created database ${DB}`);
  }
  const url = new URL(env.DATABASE_URL);
  url.pathname = `/${DB}`;
  run(
    process.execPath,
    [join('node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'],
    {
      cwd: join(root, 'apps', 'api'),
      env: { ...process.env, DATABASE_URL: url.toString() },
    },
  );
  run('docker', [
    'exec',
    '-e',
    `MO_GRAFANA_DB=${DB}`,
    'modelops-postgres-1',
    'sh',
    '/docker-entrypoint-initdb.d/02-grafana.sh',
  ]);
}

// ---------------------------------------------------------------------------------------------
// 6. Settings, manifests, rollout
// ---------------------------------------------------------------------------------------------
function settings(env) {
  const subnet = backendSubnet();
  if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(subnet)) throw new Error(`backend subnet? ${subnet}`);
  const enc = encodeURIComponent;
  const config = {
    MO_API_HOST: '0.0.0.0',
    MO_PORT_API: '4000',
    MO_WEB_URL: URLS.web,
    MO_COOKIE_SECURE: 'false',
    MO_S3_ENDPOINT: 'http://seaweedfs:8333',
    MO_S3_INTERNAL_ENDPOINT: 'http://seaweedfs:8333',
    MO_S3_REGION: env.MO_S3_REGION ?? 'us-east-1',
    MO_MLFLOW_URL: 'http://mlflow:5000',
    MO_ML_WORKER_URL: 'http://ml-worker:8000',
    MO_GATEWAY_URL: URLS.gateway, // shown to users as the invoke URL
    MO_GATEWAY_ADMIN_URL: 'http://gateway:8081',
    MO_PROMETHEUS_URL: 'http://prometheus:9090',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318',
    MO_MODEL_SERVER_OTLP_ENDPOINT: 'http://otel-collector:4318',
    MO_MODEL_SERVER_IMAGE: 'modelops/model-server:dev',
    MO_RUNTIME_DRIVER: 'kubernetes',
    MO_K8S_NAMESPACE: 'modelops-models',
    // Model servers may reach S3 and the trace collector, and nothing else on that network.
    MO_K8S_EGRESS: `${subnet}:8333,${subnet}:4318`,
    MO_INSTANCE_ID: 'kind',
  };
  const secrets = {
    DATABASE_URL: `postgresql://${enc(env.MO_DB_APP_USER)}:${enc(env.MO_DB_APP_PASSWORD)}@postgres:5432/${DB}`,
    REDIS_URL: `redis://:${enc(env.MO_REDIS_PASSWORD)}@redis:6379/1`,
    MO_API_SESSION_PEPPER: env.MO_API_SESSION_PEPPER,
    MO_S3_ACCESS_KEY: env.MO_S3_ACCESS_KEY,
    MO_S3_SECRET_KEY: env.MO_S3_SECRET_KEY,
    MO_ML_WORKER_TOKEN: env.MO_ML_WORKER_TOKEN,
    MO_GATEWAY_INTERNAL_TOKEN: env.MO_GATEWAY_INTERNAL_TOKEN,
    MO_API_KEY_PEPPER: env.MO_API_KEY_PEPPER,
  };
  const missing = Object.entries(secrets).filter(([, v]) => !v || v.includes('undefined'));
  if (missing.length) throw new Error(`.env lacks ${missing.map(([k]) => k).join(', ')}`);
  const dir = join(root, 'infra', 'k8s', 'overlays', 'kind');
  const lines = (o) =>
    `${Object.entries(o)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`;
  writeFileSync(join(dir, 'config.env'), lines(config));
  writeFileSync(join(dir, 'secrets.env'), lines(secrets), { mode: 0o600 });
}

function deploy() {
  let existed = false;
  try {
    existed =
      out(KUBECTL, ['--context', CONTEXT, '-n', 'modelops', 'get', 'deployment', '-o', 'name']) !==
      '';
  } catch {
    // namespace not created yet
  }
  kubectl(['apply', '-k', join('infra', 'k8s', 'overlays', 'kind')]);
  // Images keep the :dev tag across builds, so running pods would keep the old one: restart.
  if (existed) kubectl(['-n', 'modelops', 'rollout', 'restart', 'deployment']);
  for (const d of ['api', 'worker', 'web', 'gateway']) {
    kubectl(['-n', 'modelops', 'rollout', 'status', `deployment/${d}`, '--timeout=300s']);
  }
}

async function waitHealthy(url, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
async function up(build) {
  const env = loadEnv();
  step(1, 'tools and the compose stack');
  preflight();
  step(2, `cluster ${CLUSTER}`);
  cluster();
  step(3, 'networks');
  attachNetworks();
  step(4, build ? 'build and load images' : 'load images (--no-build)');
  images(build);
  step(5, `database ${DB}`);
  database(env);
  step(6, 'deploy (kubectl apply -k infra/k8s/overlays/kind)');
  settings(env);
  deploy();
  step(7, 'ready');
  const ok = await waitHealthy(URLS.api, 60_000);
  console.log(`
  web console   ${URLS.web}
  API           ${URLS.api}   ${ok ? '(ready)' : '(NOT ready yet: kubectl -n modelops logs deploy/api)'}
  gateway       ${URLS.gateway}/v1/endpoints/<slug>/predict
  Grafana       ${URLS.grafana}   (Database: "ModelOps DB (kind)")
  model servers kubectl --context ${CONTEXT} -n modelops-models get pods
`);
  if (!ok) process.exit(1);
}

function down() {
  run(KIND, ['delete', 'cluster', '--name', CLUSTER]);
  console.log(`cluster deleted; database ${DB} kept (drop it with psql if you want it gone)`);
}

const [command = 'up', ...flags] = process.argv.slice(2);
if (command === 'up') await up(!flags.includes('--no-build'));
else if (command === 'down') down();
else {
  console.error('usage: node scripts/kind.mjs up [--no-build] | down');
  process.exit(2);
}
