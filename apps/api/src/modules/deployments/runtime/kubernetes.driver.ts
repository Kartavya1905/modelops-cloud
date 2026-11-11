import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CoreV1Api,
  KubeConfig,
  NetworkingV1Api,
  type V1NetworkPolicy,
  type V1Pod,
  type V1Service,
} from '@kubernetes/client-node';
import { APP_CONFIG, type AppConfig } from '../../../config/config';
import {
  containerName,
  type RevisionRuntimeSpec,
  type RuntimeDriver,
  type RuntimeStatus,
  TransientError,
} from './runtime-driver';

const MANAGED = 'modelops.managed';
const INSTANCE = 'modelops.instance';
const REVISION = 'modelops.revision';
/** Grace period (2 s) plus kubelet latency; past this, removal is retried by the caller. */
const REMOVE_WAIT_MS = 30_000;
/** Scheduling + container start (the image is already on the node: IfNotPresent). */
const START_WAIT_MS = 60_000;

/** HTTP status of a client-node error (ApiException.code), or null for network failures. */
function statusOf(err: unknown): number | null {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

/**
 * Kubernetes runtime (M10, ADR-0005). One revision = one **Pod** + one Service (`mo-rev-<id>`,
 * its DNS name in the namespace) + one NetworkPolicy (ingress only from gateway pods, egress
 * only DNS and the configured CIDRs). The pod spec mirrors the Docker driver's hardening:
 * non-root 10001, read-only root, no capabilities, no privilege escalation, RuntimeDefault
 * seccomp, CPU/memory limits, no service-account token.
 *
 * A bare Pod with `restartPolicy: Never`, not a Deployment: restarts are the reconciler's
 * decision, with its budget (3 in 10 min, then FAILED), exactly as on Docker, and an exit code
 * (3 = checksum mismatch, 4 = load error) stays visible as the failure reason instead of being
 * restarted away by a ReplicaSet.
 */
@Injectable()
export class KubernetesDriver implements RuntimeDriver {
  private readonly logger = new Logger(KubernetesDriver.name);
  private readonly core: CoreV1Api;
  private readonly net: NetworkingV1Api;
  private readonly ns: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    const kc = new KubeConfig();
    kc.loadFromDefault(); // in-cluster service account, or KUBECONFIG / ~/.kube/config
    if (config.deploy.runtime.context) kc.setCurrentContext(config.deploy.runtime.context);
    this.core = kc.makeApiClient(CoreV1Api);
    this.net = kc.makeApiClient(NetworkingV1Api);
    this.ns = config.deploy.runtime.namespace;
  }

  private async call<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const code = statusOf(err);
      // Unreachable API server, 5xx, 409 (concurrent change), 429: worth retrying.
      if (code === null || code >= 500 || code === 409 || code === 429) {
        throw new TransientError(
          `${what}: ${code === null ? (err as Error).message : `HTTP ${String(code)}`}`,
        );
      }
      throw err;
    }
  }

  private labels(spec: Pick<RevisionRuntimeSpec, 'revisionId' | 'endpointId' | 'orgId'>) {
    return {
      [MANAGED]: 'true',
      [INSTANCE]: this.config.deploy.instanceId,
      [REVISION]: spec.revisionId,
      'modelops.endpoint': spec.endpointId,
      'modelops.org': spec.orgId,
      'app.kubernetes.io/name': 'model-server',
    };
  }

  private toStatus(pod: V1Pod): RuntimeStatus {
    const revisionId = pod.metadata?.labels?.[REVISION] ?? '';
    const name = containerName(revisionId);
    const cs = pod.status?.containerStatuses?.[0];
    if (pod.metadata?.deletionTimestamp)
      return { revisionId, name, state: 'exited', exitCode: null };
    if (cs?.state?.running) return { revisionId, name, state: 'running', exitCode: null };
    if (cs?.state?.terminated) {
      return { revisionId, name, state: 'exited', exitCode: cs.state.terminated.exitCode };
    }
    const waiting = cs?.state?.waiting?.reason ?? '';
    // The image can't be pulled (or doesn't exist): this revision will never start.
    if (/ErrImagePull|ImagePullBackOff|InvalidImageName|CreateContainerConfigError/.test(waiting)) {
      return { revisionId, name, state: 'dead', exitCode: null };
    }
    if (pod.status?.phase === 'Failed' || pod.status?.phase === 'Succeeded') {
      return { revisionId, name, state: 'exited', exitCode: null };
    }
    return { revisionId, name, state: 'created', exitCode: null }; // scheduling / creating
  }

  async inspect(revisionId: string): Promise<RuntimeStatus | null> {
    try {
      const pod = await this.core.readNamespacedPod({
        name: containerName(revisionId),
        namespace: this.ns,
      });
      return this.toStatus(pod);
    } catch (err) {
      if (statusOf(err) === 404) return null;
      return this.call('read pod', () => Promise.reject(err as Error));
    }
  }

  async ensure(spec: RevisionRuntimeSpec): Promise<RuntimeStatus> {
    const current = await this.inspect(spec.revisionId);
    if (current && current.state === 'exited' && (await this.terminating(spec.revisionId))) {
      // The previous pod of this revision is still shutting down: its name is not free yet.
      throw new TransientError('previous pod still terminating');
    }
    if (current) return current.state === 'created' ? this.started(spec.revisionId) : current;
    await this.createIfMissing('service', () =>
      this.core.createNamespacedService({ namespace: this.ns, body: this.service(spec) }),
    );
    await this.createIfMissing('network policy', () =>
      this.net.createNamespacedNetworkPolicy({
        namespace: this.ns,
        body: this.networkPolicy(spec),
      }),
    );
    await this.createIfMissing('pod', () =>
      this.core.createNamespacedPod({ namespace: this.ns, body: this.pod(spec) }),
    );
    return this.started(spec.revisionId);
  }

  /**
   * Docker's `start` returns a running container; a pod is scheduled and started asynchronously.
   * Wait (bounded) until it leaves "created", so that "ensured" means the same on both runtimes.
   * Still pending after the wait: the caller sees "created" and retries (a TransientError).
   */
  private async started(revisionId: string): Promise<RuntimeStatus> {
    const deadline = Date.now() + START_WAIT_MS;
    for (;;) {
      const status = await this.inspect(revisionId);
      if (!status) throw new TransientError('pod vanished right after creation');
      if (status.state !== 'created' || Date.now() > deadline) return status;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Create, treating "already exists" (a concurrent ensure won) as success. */
  private async createIfMissing(what: string, create: () => Promise<unknown>): Promise<void> {
    try {
      await create();
    } catch (err) {
      if (statusOf(err) === 409) return;
      await this.call(`create ${what}`, () => Promise.reject(err as Error));
    }
  }

  private pod(spec: RevisionRuntimeSpec): V1Pod {
    const name = containerName(spec.revisionId);
    const resources = { cpu: String(spec.cpus), memory: `${String(spec.memoryMb)}Mi` };
    return {
      metadata: { name, labels: this.labels(spec) },
      spec: {
        restartPolicy: 'Never', // the reconciler restarts, with a budget (see the class comment)
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 10001,
          runAsGroup: 10001,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        containers: [
          {
            name: 'model-server',
            image: spec.image,
            imagePullPolicy: 'IfNotPresent',
            env: Object.entries(spec.env).map(([k, v]) => ({ name: k, value: v })),
            ports: [{ name: 'http', containerPort: 8000 }],
            resources: { requests: resources, limits: resources },
            securityContext: {
              readOnlyRootFilesystem: true,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'] },
            },
            volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
          },
        ],
        volumes: [{ name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } }],
      },
    };
  }

  private service(spec: RevisionRuntimeSpec): V1Service {
    return {
      metadata: { name: containerName(spec.revisionId), labels: this.labels(spec) },
      spec: {
        selector: { [REVISION]: spec.revisionId },
        ports: [{ name: 'http', port: 8000, targetPort: 8000 }],
      },
    };
  }

  /** Only gateway pods may call it; it may only resolve names and reach the allowed CIDRs. */
  private networkPolicy(spec: RevisionRuntimeSpec): V1NetworkPolicy {
    return {
      metadata: { name: containerName(spec.revisionId), labels: this.labels(spec) },
      spec: {
        podSelector: { matchLabels: { [REVISION]: spec.revisionId } },
        policyTypes: ['Ingress', 'Egress'],
        ingress: [
          {
            _from: [
              // serialized as `from` by the client
              {
                namespaceSelector: {},
                podSelector: { matchLabels: { 'app.kubernetes.io/name': 'gateway' } },
              },
            ],
            ports: [{ protocol: 'TCP', port: 8000 }],
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
          ...this.config.deploy.runtime.egress.map(({ cidr, port }) => ({
            to: [{ ipBlock: { cidr } }],
            ports: [{ protocol: 'TCP', port }],
          })),
        ],
      },
    };
  }

  async remove(revisionId: string): Promise<void> {
    const name = containerName(revisionId);
    const del = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        if (statusOf(err) === 404) return;
        await this.call(`delete ${what}`, () => Promise.reject(err as Error));
      }
    };
    await del('pod', () =>
      this.core.deleteNamespacedPod({ name, namespace: this.ns, gracePeriodSeconds: 2 }),
    );
    await del('service', () => this.core.deleteNamespacedService({ name, namespace: this.ns }));
    await del('network policy', () =>
      this.net.deleteNamespacedNetworkPolicy({ name, namespace: this.ns }),
    );
    // Like `docker rm -f`, return only once the pod is gone: a restart (remove, then ensure)
    // must not find the old, terminating pod, and "removed" must mean removed.
    const deadline = Date.now() + REMOVE_WAIT_MS;
    while ((await this.inspect(revisionId)) !== null) {
      if (Date.now() > deadline) throw new TransientError(`pod ${name} is still terminating`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  private async terminating(revisionId: string): Promise<boolean> {
    try {
      const pod = await this.core.readNamespacedPod({
        name: containerName(revisionId),
        namespace: this.ns,
      });
      return Boolean(pod.metadata?.deletionTimestamp);
    } catch {
      return false;
    }
  }

  async list(): Promise<RuntimeStatus[]> {
    const pods = await this.call('list pods', () =>
      this.core.listNamespacedPod({
        namespace: this.ns,
        labelSelector: `${MANAGED}=true,${INSTANCE}=${this.config.deploy.instanceId}`,
      }),
    );
    return pods.items.map((p) => this.toStatus(p));
  }

  async logs(revisionId: string, tail: number): Promise<string> {
    try {
      const text = await this.core.readNamespacedPodLog({
        name: containerName(revisionId),
        namespace: this.ns,
        tailLines: tail,
      });
      return text.slice(-2000);
    } catch (err) {
      this.logger.debug(`no logs for ${revisionId}: ${(err as Error).message}`);
      return '';
    }
  }
}
