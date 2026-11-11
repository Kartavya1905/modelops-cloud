/**
 * kind-runtime.ts: the M10 test data plane on Kubernetes (`MO_TEST_RUNTIME=kubernetes`).
 *
 * What happens here:
 *   1. Images: the dev images are loaded into the kind node (`kind load docker-image`).
 *   2. Namespace: one per test run (`mo-test-<pid>`), default-deny, so nothing a test deploys can
 *      talk to anything it was not explicitly allowed to.
 *   3. Gateway: the same gateway image as the Docker run, as a pod labelled
 *      `app.kubernetes.io/name=gateway` (the only pods model servers accept traffic from), reading
 *      the test Redis database, exposed on NodePorts 30098/30099 -> 127.0.0.1:18198/18199
 *      (`infra/kind/cluster.yaml`).
 *   4. Settings the test API and worker need to drive the KubernetesDriver.
 *   5. Teardown: deleting the namespace removes every pod, service and policy of the run.
 *
 * Prerequisite: `pnpm kind:up` (or at least the `modelops` kind cluster, attached to the compose
 * networks) and the dev stack. The compose services resolve from pods by name through CoreDNS ->
 * the node's Docker DNS, and they resolve to their `modelops-backend` addresses.
 */
import { execFileSync } from 'node:child_process';

export const KIND_CLUSTER = 'modelops';
export const KIND_CONTEXT = `kind-${KIND_CLUSTER}`;
const IMAGES = ['modelops/gateway:dev', 'modelops/model-server:dev'];

const run = (cmd: string, args: string[], input?: string) =>
  execFileSync(cmd, args, { input, stdio: 'pipe', encoding: 'utf8' }).trim();
const kubectl = (args: string[], input?: string) =>
  run('kubectl', ['--context', KIND_CONTEXT, ...args], input);

/** The subnet of the compose backend network, as pods see the compose services. */
function backendSubnet(): string {
  const subnet = run('docker', [
    'network',
    'inspect',
    'modelops-backend',
    '-f',
    '{{range .IPAM.Config}}{{.Subnet}}{{end}}',
  ]);
  if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(subnet)) throw new Error(`backend subnet? ${subnet}`);
  return subnet;
}

// ---------------------------------------------------------------------------------------------
// 1. + 2. + 3. Images, namespace and the test gateway
// ---------------------------------------------------------------------------------------------
export function startKindDataPlane(opts: { namespace: string; redisUrl: URL }): {
  env: Record<string, string>;
} {
  try {
    run('kind', ['get', 'kubeconfig', '--name', KIND_CLUSTER]);
  } catch {
    throw new Error(`kind cluster "${KIND_CLUSTER}" not found: run \`pnpm kind:up\` first`);
  }
  run('kind', ['load', 'docker-image', ...IMAGES, '--name', KIND_CLUSTER]);
  // A crashed earlier run's namespace would still hold NodePorts 30098/30099.
  kubectl(['delete', 'namespace', '-l', 'modelops.test=true', '--wait=true', '--timeout=120s']);

  const ns = opts.namespace;
  const subnet = backendSubnet();
  const password = decodeURIComponent(opts.redisUrl.password);
  const manifest = [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: ns, labels: { 'modelops.test': 'true' } },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'default-deny', namespace: ns },
      spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] },
    },
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'gateway', namespace: ns },
      stringData: {
        REDIS_URL: `redis://:${password}@redis:6379/15`,
        MO_API_KEY_PEPPER: process.env.MO_API_KEY_PEPPER ?? '',
        MO_GATEWAY_INTERNAL_TOKEN: process.env.MO_GATEWAY_INTERNAL_TOKEN ?? '',
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'gateway', namespace: ns, labels: { 'app.kubernetes.io/name': 'gateway' } },
      spec: {
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000, // `node` in the image
          runAsGroup: 1000,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        containers: [
          {
            name: 'gateway',
            image: 'modelops/gateway:dev',
            imagePullPolicy: 'IfNotPresent',
            envFrom: [{ secretRef: { name: 'gateway' } }],
            env: [
              { name: 'MO_GATEWAY_ROUTING_POLL_MS', value: '500' },
              { name: 'MO_MODEL_SERVER_DOMAIN', value: `${ns}.svc.cluster.local` },
              { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://otel-collector:4318' },
              { name: 'LOG_LEVEL', value: 'info' },
            ],
            ports: [{ containerPort: 8080 }, { containerPort: 8081 }],
            readinessProbe: { httpGet: { path: '/healthz', port: 8081 }, periodSeconds: 2 },
            resources: {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '1', memory: '256Mi' },
            },
            securityContext: {
              readOnlyRootFilesystem: true,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'] },
            },
          },
        ],
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'gateway', namespace: ns },
      spec: {
        type: 'NodePort',
        selector: { 'app.kubernetes.io/name': 'gateway' },
        ports: [
          { name: 'public', port: 8080, targetPort: 8080, nodePort: 30098 },
          { name: 'admin', port: 8081, targetPort: 8081, nodePort: 30099 },
        ],
      },
    },
    {
      // The gateway: reachable on its two ports; may reach DNS, Redis, the collector and the
      // model servers of this namespace. Nothing else.
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'gateway', namespace: ns },
      spec: {
        podSelector: { matchLabels: { 'app.kubernetes.io/name': 'gateway' } },
        policyTypes: ['Ingress', 'Egress'],
        ingress: [
          {
            ports: [
              { protocol: 'TCP', port: 8080 },
              { protocol: 'TCP', port: 8081 },
            ],
          },
        ],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
                },
                podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
              },
            ],
            ports: [
              { protocol: 'UDP', port: 53 },
              { protocol: 'TCP', port: 53 },
            ],
          },
          { to: [{ ipBlock: { cidr: subnet } }], ports: [{ protocol: 'TCP', port: 6379 }] },
          { to: [{ ipBlock: { cidr: subnet } }], ports: [{ protocol: 'TCP', port: 4318 }] },
          {
            to: [{ podSelector: { matchLabels: { 'app.kubernetes.io/name': 'model-server' } } }],
            ports: [{ protocol: 'TCP', port: 8000 }],
          },
        ],
      },
    },
  ];
  kubectl(
    ['apply', '-f', '-'],
    JSON.stringify({ apiVersion: 'v1', kind: 'List', items: manifest }),
  );
  kubectl(['-n', ns, 'wait', '--for=condition=Ready', 'pod/gateway', '--timeout=120s']);

  // 4. What the test API/worker need to run model servers in this namespace.
  return {
    env: {
      MO_RUNTIME_DRIVER: 'kubernetes',
      MO_K8S_CONTEXT: KIND_CONTEXT,
      MO_K8S_NAMESPACE: ns,
      MO_K8S_EGRESS: `${subnet}:8333,${subnet}:4318`, // S3 and the trace collector only
      // The suite leaves a dozen model servers running; a 4-CPU CI runner can only reserve ~6
      // at 500m each. Request 100m (limits stay 500m), so every one of them schedules.
      MO_K8S_CPU_REQUEST: '100m',
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 5. Teardown
// ---------------------------------------------------------------------------------------------
export function stopKindDataPlane(namespace: string): void {
  try {
    kubectl(['delete', 'namespace', namespace, '--wait=false', '--ignore-not-found']);
  } catch {
    // cluster gone: nothing left to clean
  }
}

// ---------------------------------------------------------------------------------------------
// 6. Network probes (NetworkPolicy tests): a TCP connect, from inside a pod
// ---------------------------------------------------------------------------------------------
// Python, because the model-server image (already on the node) has it: no image pulls.
const TCP_CHECK = [
  'import socket, sys',
  'try:',
  '    socket.create_connection((sys.argv[1], int(sys.argv[2])), 3).close()',
  '    print("OPEN")',
  'except OSError:',
  '    print("BLOCKED")',
].join('\n');

/** Can an existing pod open a TCP connection to host:port? */
export function tcpFromPod(namespace: string, pod: string, host: string, port: number): string {
  return kubectl([
    '-n',
    namespace,
    'exec',
    pod,
    '--',
    'python',
    '-c',
    TCP_CHECK,
    host,
    String(port),
  ]);
}

/**
 * Can a fresh pod in `namespace`, with `labels`, open a TCP connection to host:port? It waits 5 s
 * first: kindnet's policy engine enforces only once it has seen the new pod's IP.
 */
export function tcpFromNewPod(
  namespace: string,
  labels: Record<string, string>,
  host: string,
  port: number,
): string {
  const name = `probe-${Math.random().toString(36).slice(2, 8)}`;
  const script = `import time\ntime.sleep(5)\n${TCP_CHECK}`;
  kubectl([
    '-n',
    namespace,
    'run',
    name,
    '--image=modelops/model-server:dev',
    '--image-pull-policy=IfNotPresent',
    '--restart=Never',
    `--labels=${Object.entries(labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(',')}`,
    '--command',
    '--',
    'python',
    '-c',
    script,
    host,
    String(port),
  ]);
  try {
    kubectl([
      '-n',
      namespace,
      'wait',
      `pod/${name}`,
      '--for=jsonpath={.status.phase}=Succeeded',
      '--timeout=90s',
    ]);
    return kubectl(['-n', namespace, 'logs', name]);
  } finally {
    kubectl(['-n', namespace, 'delete', 'pod', name, '--wait=false']);
  }
}

/** Read a model-server pod (hardening assertions in the lifecycle tests). */
export function readPod(namespace: string, name: string): KindPod | null {
  try {
    return JSON.parse(kubectl(['-n', namespace, 'get', 'pod', name, '-o', 'json'])) as KindPod;
  } catch (err) {
    if (/NotFound/.test(String((err as { stderr?: string }).stderr))) return null;
    throw err;
  }
}

export interface KindPod {
  metadata: { labels: Record<string, string>; deletionTimestamp?: string };
  spec: {
    restartPolicy: string;
    automountServiceAccountToken?: boolean;
    securityContext: { runAsNonRoot?: boolean; runAsUser?: number; runAsGroup?: number };
    containers: {
      resources: { limits: Record<string, string>; requests: Record<string, string> };
      securityContext: {
        readOnlyRootFilesystem?: boolean;
        allowPrivilegeEscalation?: boolean;
        capabilities?: { drop?: string[] };
      };
    }[];
  };
  status: { phase: string; containerStatuses?: { state: { running?: object } }[] };
}
