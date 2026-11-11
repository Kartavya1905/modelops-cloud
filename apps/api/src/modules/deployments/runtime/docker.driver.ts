import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config/config';
import {
  containerName,
  type RevisionRuntimeSpec,
  type RuntimeDriver,
  type RuntimeState,
  type RuntimeStatus,
  TransientError,
} from './runtime-driver';

interface DockerContainer {
  Id: string;
  Names?: string[];
  Name?: string;
  State: string | { Status: string; ExitCode: number };
  Labels?: Record<string, string>;
  Config?: { Labels?: Record<string, string> };
}

const STATES: ReadonlySet<string> = new Set(['created', 'running', 'exited', 'restarting', 'dead']);
const toState = (s: string): RuntimeState => (STATES.has(s) ? (s as RuntimeState) : 'dead');

/**
 * Talks to the Docker Engine API through docker-socket-proxy (ADR-0005), which only allows the
 * containers and images endpoints. Model servers are started with a fixed, hardened spec
 * (docs/02 §8): non-root, read-only rootfs, no capabilities, no-new-privileges, CPU/memory/pid
 * limits, and only the internal `inference` network (no internet, no Postgres, no Redis).
 */
@Injectable()
export class DockerDriver implements RuntimeDriver {
  private readonly base: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.base = config.deploy.dockerProxyUrl;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await fetch(`${this.base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new TransientError(`Docker API unreachable: ${(err as Error).message}`);
    }
  }

  private async fail(res: Response, what: string): Promise<never> {
    const text = (await res.text()).slice(0, 300);
    // 5xx and 409 (in-flight state change) are worth retrying; 4xx means our request is wrong.
    if (res.status >= 500 || res.status === 409) {
      throw new TransientError(`${what}: HTTP ${String(res.status)} ${text}`);
    }
    throw new Error(`${what}: HTTP ${String(res.status)} ${text}`);
  }

  async inspect(revisionId: string): Promise<RuntimeStatus | null> {
    const res = await this.call('GET', `/containers/${containerName(revisionId)}/json`);
    if (res.status === 404) return null;
    if (!res.ok) return this.fail(res, 'inspect container');
    const c = (await res.json()) as DockerContainer;
    const st = typeof c.State === 'string' ? { Status: c.State, ExitCode: 0 } : c.State;
    return {
      revisionId,
      name: containerName(revisionId),
      state: toState(st.Status),
      exitCode: st.Status === 'exited' || st.Status === 'dead' ? st.ExitCode : null,
    };
  }

  async ensure(spec: RevisionRuntimeSpec): Promise<RuntimeStatus> {
    let current = await this.inspect(spec.revisionId);
    if (!current) {
      await this.create(spec);
      current = await this.inspect(spec.revisionId);
      if (!current) throw new TransientError('container vanished right after creation');
    }
    if (current.state === 'created') {
      const res = await this.call('POST', `/containers/${current.name}/start`);
      // 304 = already started (a concurrent ensure won the race): fine.
      if (!res.ok && res.status !== 304) await this.fail(res, 'start container');
      current = (await this.inspect(spec.revisionId)) ?? current;
    }
    return current;
  }

  private async create(spec: RevisionRuntimeSpec): Promise<void> {
    const name = containerName(spec.revisionId);
    const network = this.config.deploy.inferenceNetwork;
    const memory = spec.memoryMb * 1024 * 1024;
    const res = await this.call('POST', `/containers/create?name=${encodeURIComponent(name)}`, {
      Image: spec.image,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      User: '10001:10001',
      Labels: {
        'modelops.managed': 'true',
        'modelops.instance': this.config.deploy.instanceId,
        'modelops.revision': spec.revisionId,
        'modelops.endpoint': spec.endpointId,
        'modelops.org': spec.orgId,
      },
      ExposedPorts: { '8000/tcp': {} },
      HostConfig: {
        NanoCpus: Math.round(spec.cpus * 1e9),
        Memory: memory,
        MemorySwap: memory, // no swap
        PidsLimit: 128,
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16m' },
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        NetworkMode: network,
        RestartPolicy: { Name: 'no' }, // restarts are the reconciler's decision (with a budget)
        LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '2' } },
      },
      NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [name] } } },
    });
    if (res.status === 409) return; // created concurrently by another worker: inspect will see it
    if (res.status === 404) {
      throw new Error(`model server image ${spec.image} not found (run \`pnpm dev:up\`)`);
    }
    if (!res.ok) await this.fail(res, 'create container');
  }

  async remove(revisionId: string): Promise<void> {
    const res = await this.call('DELETE', `/containers/${containerName(revisionId)}?force=true`);
    if (res.ok || res.status === 404) return;
    // 409 "removal … is already in progress": someone (worker or reconciler) is removing it.
    if (res.status === 409 && /already in progress/.test(await res.clone().text())) return;
    await this.fail(res, 'remove container');
  }

  async list(): Promise<RuntimeStatus[]> {
    const filters = encodeURIComponent(
      JSON.stringify({
        label: ['modelops.managed=true', `modelops.instance=${this.config.deploy.instanceId}`],
      }),
    );
    const res = await this.call('GET', `/containers/json?all=true&filters=${filters}`);
    if (!res.ok) return this.fail(res, 'list containers');
    const rows = (await res.json()) as DockerContainer[];
    return rows.flatMap((c) => {
      const revisionId = c.Labels?.['modelops.revision'];
      if (!revisionId) return [];
      const state = typeof c.State === 'string' ? c.State : c.State.Status;
      return [
        { revisionId, name: containerName(revisionId), state: toState(state), exitCode: null },
      ];
    });
  }

  async logs(revisionId: string, tail: number): Promise<string> {
    const res = await this.call(
      'GET',
      `/containers/${containerName(revisionId)}/logs?stdout=true&stderr=true&tail=${String(tail)}`,
    );
    if (!res.ok) return '';
    // Multiplexed stream: 8-byte frame headers. Keep printable text only.
    const raw = Buffer.from(await res.arrayBuffer());
    const out: string[] = [];
    let i = 0;
    while (i + 8 <= raw.length) {
      const size = raw.readUInt32BE(i + 4);
      out.push(raw.subarray(i + 8, i + 8 + size).toString('utf8'));
      i += 8 + size;
    }
    return out.join('').slice(-2000);
  }
}
