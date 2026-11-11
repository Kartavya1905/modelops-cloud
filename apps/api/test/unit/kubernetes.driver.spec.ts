import type { V1NetworkPolicy, V1Pod, V1Service } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config';
import { KubernetesDriver } from '../../src/modules/deployments/runtime/kubernetes.driver';
import {
  type RevisionRuntimeSpec,
  TransientError,
} from '../../src/modules/deployments/runtime/runtime-driver';

/**
 * M10: the KubernetesDriver against an in-memory fake of the two client-node APIs it uses. The
 * real cluster is covered by `pnpm test:k8s` (lifecycle suite on kind); these pin the objects it
 * creates and how it maps pod states and API errors.
 */
const config = loadConfig({
  DATABASE_URL: 'postgresql://modelops_app:s3cret@127.0.0.1:15432/modelops',
  REDIS_URL: 'redis://:s3cret@127.0.0.1:16379/0',
  MO_API_SESSION_PEPPER: 'x'.repeat(64),
  MO_S3_ACCESS_KEY: 'a'.repeat(20),
  MO_S3_SECRET_KEY: 's'.repeat(40),
  MO_ML_WORKER_TOKEN: 't'.repeat(64),
  MO_GATEWAY_INTERNAL_TOKEN: 'g'.repeat(64),
  MO_API_KEY_PEPPER: 'k'.repeat(64),
  MO_RUNTIME_DRIVER: 'kubernetes',
  MO_K8S_NAMESPACE: 'models',
  MO_K8S_EGRESS: '172.20.0.0/16:8333, 172.20.0.0/16:4318',
  MO_INSTANCE_ID: 'unit',
});

const spec: RevisionRuntimeSpec = {
  revisionId: '11111111-2222-3333-4444-555555555555',
  orgId: 'org-1',
  endpointId: 'ep-1',
  image: 'modelops/model-server:dev',
  env: { MO_REVISION_ID: '11111111-2222-3333-4444-555555555555' },
  cpus: 0.5,
  memoryMb: 512,
};

const apiError = (code: number) => Object.assign(new Error(`HTTP ${String(code)}`), { code });

/** Pods, services and policies by name; pods turn "running" after `startAfter` reads. */
function fakeCluster(opts: { startAfter?: number; podState?: V1Pod['status'] } = {}) {
  const pods = new Map<string, V1Pod>();
  const services = new Map<string, V1Service>();
  const policies = new Map<string, V1NetworkPolicy>();
  let reads = 0;
  const core = {
    readNamespacedPod: ({ name }: { name: string }) => {
      const pod = pods.get(name);
      if (!pod) return Promise.reject(apiError(404));
      reads++;
      if (!pod.status && reads > (opts.startAfter ?? 0)) {
        pod.status = opts.podState ?? {
          phase: 'Running',
          containerStatuses: [
            {
              name: 'model-server',
              image: '',
              imageID: '',
              ready: true,
              restartCount: 0,
              state: { running: {} },
            },
          ],
        };
      }
      return Promise.resolve(pod);
    },
    createNamespacedPod: ({ body }: { body: V1Pod }) => {
      const name = body.metadata?.name ?? '';
      if (pods.has(name)) return Promise.reject(apiError(409));
      pods.set(name, structuredClone(body));
      return Promise.resolve(body);
    },
    createNamespacedService: ({ body }: { body: V1Service }) => {
      services.set(body.metadata?.name ?? '', body);
      return Promise.resolve(body);
    },
    deleteNamespacedPod: ({ name }: { name: string }) =>
      pods.delete(name) ? Promise.resolve({}) : Promise.reject(apiError(404)),
    deleteNamespacedService: ({ name }: { name: string }) =>
      services.delete(name) ? Promise.resolve({}) : Promise.reject(apiError(404)),
    listNamespacedPod: (_req: { labelSelector?: string }): Promise<{ items: V1Pod[] }> =>
      Promise.resolve({ items: [...pods.values()] }),
    readNamespacedPodLog: () => Promise.resolve('log line'),
  };
  const net = {
    createNamespacedNetworkPolicy: ({ body }: { body: V1NetworkPolicy }) => {
      policies.set(body.metadata?.name ?? '', body);
      return Promise.resolve(body);
    },
    deleteNamespacedNetworkPolicy: ({ name }: { name: string }) =>
      policies.delete(name) ? Promise.resolve({}) : Promise.reject(apiError(404)),
  };
  const driver = new KubernetesDriver(config);
  Object.assign(driver as unknown as Record<string, unknown>, { core, net });
  return { driver, pods, services, policies, core };
}

describe('KubernetesDriver (M10)', () => {
  it('creates a hardened pod with requests = limits, its Service and its NetworkPolicy', async () => {
    const { driver, pods, services, policies } = fakeCluster({ startAfter: 2 });
    const status = await driver.ensure(spec);
    expect(status).toMatchObject({ state: 'running', name: `mo-rev-${spec.revisionId}` });

    const pod = pods.get(`mo-rev-${spec.revisionId}`);
    expect(pod?.metadata?.labels).toMatchObject({
      'modelops.managed': 'true',
      'modelops.instance': 'unit',
      'modelops.revision': spec.revisionId,
      'app.kubernetes.io/name': 'model-server',
    });
    expect(pod?.spec).toMatchObject({
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 10001,
        seccompProfile: { type: 'RuntimeDefault' },
      },
    });
    const c = pod?.spec?.containers[0];
    expect(c?.resources).toEqual({
      requests: { cpu: '0.5', memory: '512Mi' },
      limits: { cpu: '0.5', memory: '512Mi' },
    });
    expect(c?.securityContext).toEqual({
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    });
    expect(c?.env).toEqual([{ name: 'MO_REVISION_ID', value: spec.revisionId }]);

    expect(services.get(`mo-rev-${spec.revisionId}`)?.spec?.selector).toEqual({
      'modelops.revision': spec.revisionId,
    });
    const policy = policies.get(`mo-rev-${spec.revisionId}`)?.spec;
    expect(policy?.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(policy?.ingress?.[0]?._from?.[0]?.podSelector?.matchLabels).toEqual({
      'app.kubernetes.io/name': 'gateway',
    });
    // DNS, then exactly the configured cidr:port pairs: S3 and the collector, nothing else.
    expect(policy?.egress?.slice(1)).toEqual([
      { to: [{ ipBlock: { cidr: '172.20.0.0/16' } }], ports: [{ protocol: 'TCP', port: 8333 }] },
      { to: [{ ipBlock: { cidr: '172.20.0.0/16' } }], ports: [{ protocol: 'TCP', port: 4318 }] },
    ]);
  });

  it('is idempotent: a second ensure returns the running pod without creating anything', async () => {
    const { driver, pods } = fakeCluster();
    await driver.ensure(spec);
    const again = await driver.ensure(spec);
    expect(again.state).toBe('running');
    expect(pods.size).toBe(1);
  });

  it('maps pod states the way the reconciler expects Docker states', async () => {
    const at = (status: V1Pod['status'], deleting = false) => {
      const { driver, pods } = fakeCluster();
      pods.set(`mo-rev-${spec.revisionId}`, {
        metadata: {
          labels: { 'modelops.revision': spec.revisionId },
          ...(deleting ? { deletionTimestamp: new Date() } : {}),
        },
        status,
      });
      return driver.inspect(spec.revisionId);
    };
    const cs = (state: object) => ({
      containerStatuses: [
        { name: 'm', image: '', imageID: '', ready: false, restartCount: 0, state },
      ],
    });
    expect((await at(cs({ terminated: { exitCode: 3 } })))?.state).toBe('exited');
    expect((await at(cs({ terminated: { exitCode: 3 } })))?.exitCode).toBe(3); // checksum mismatch
    expect((await at(cs({ waiting: { reason: 'ImagePullBackOff' } })))?.state).toBe('dead');
    expect((await at(cs({ waiting: { reason: 'ContainerCreating' } })))?.state).toBe('created');
    expect((await at({ phase: 'Failed' }))?.state).toBe('exited');
    expect((await at(cs({ running: {} }), true))?.state).toBe('exited'); // being deleted
    expect(await fakeCluster().driver.inspect(spec.revisionId)).toBeNull();
  });

  it('fails fast on a pod that can never start (exit code kept for the failure reason)', async () => {
    const { driver } = fakeCluster({
      podState: {
        phase: 'Failed',
        containerStatuses: [
          {
            name: 'm',
            image: '',
            imageID: '',
            ready: false,
            restartCount: 0,
            state: { terminated: { exitCode: 4 } },
          },
        ],
      },
    });
    expect(await driver.ensure(spec)).toMatchObject({ state: 'exited', exitCode: 4 });
  });

  it('remove deletes pod, Service and policy, returns once the pod is gone, and is idempotent', async () => {
    const { driver, pods, services, policies } = fakeCluster();
    await driver.ensure(spec);
    await driver.remove(spec.revisionId);
    expect([pods.size, services.size, policies.size]).toEqual([0, 0, 0]);
    await expect(driver.remove(spec.revisionId)).resolves.toBeUndefined();
  });

  it('turns API server outages and conflicts into TransientError (retried), not failures', async () => {
    const { driver, core } = fakeCluster();
    core.readNamespacedPod = () => Promise.reject(apiError(503));
    await expect(driver.inspect(spec.revisionId)).rejects.toBeInstanceOf(TransientError);
    core.readNamespacedPod = () => Promise.reject(new Error('connect ECONNREFUSED'));
    await expect(driver.inspect(spec.revisionId)).rejects.toBeInstanceOf(TransientError);
    core.listNamespacedPod = () => Promise.reject(apiError(429));
    await expect(driver.list()).rejects.toBeInstanceOf(TransientError);
    core.listNamespacedPod = () => Promise.reject(apiError(403)); // RBAC: a real error
    await expect(driver.list()).rejects.not.toBeInstanceOf(TransientError);
  });

  it('lists only this instance and namespace (label selector) and reads logs', async () => {
    const { driver, core } = fakeCluster();
    let selector = '';
    core.listNamespacedPod = (req: { labelSelector?: string }) => {
      selector = req.labelSelector ?? '';
      return Promise.resolve({ items: [] });
    };
    expect(await driver.list()).toEqual([]);
    expect(selector).toBe('modelops.managed=true,modelops.instance=unit');
    expect(await driver.logs(spec.revisionId, 20)).toBe('log line');
  });
});

describe('MO_K8S_EGRESS', () => {
  const base = {
    DATABASE_URL: 'postgresql://a:b@127.0.0.1:1/x',
    REDIS_URL: 'redis://:b@127.0.0.1:1/0',
    MO_API_SESSION_PEPPER: 'x'.repeat(64),
    MO_S3_ACCESS_KEY: 'a'.repeat(20),
    MO_S3_SECRET_KEY: 's'.repeat(40),
    MO_ML_WORKER_TOKEN: 't'.repeat(64),
    MO_GATEWAY_INTERNAL_TOKEN: 'g'.repeat(64),
    MO_API_KEY_PEPPER: 'k'.repeat(64),
  };
  it('parses cidr:port pairs and defaults to DNS only', () => {
    expect(loadConfig(base).deploy.runtime.egress).toEqual([]);
    expect(loadConfig({ ...base, MO_K8S_EGRESS: '10.0.0.0/8:443' }).deploy.runtime.egress).toEqual([
      { cidr: '10.0.0.0/8', port: 443 },
    ]);
  });
  it('rejects a bare CIDR (every egress rule must name its port)', () => {
    expect(() => loadConfig({ ...base, MO_K8S_EGRESS: '10.0.0.0/8' })).toThrow(/MO_K8S_EGRESS/);
  });
  it('names model servers by their Service DNS name on Kubernetes only', () => {
    expect(loadConfig(base).deploy.runtime.modelServerDomain).toBe('');
    expect(
      loadConfig({ ...base, MO_RUNTIME_DRIVER: 'kubernetes', MO_K8S_NAMESPACE: 'ns1' }).deploy
        .runtime.modelServerDomain,
    ).toBe('ns1.svc.cluster.local');
  });
});
