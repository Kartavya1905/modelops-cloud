import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ArtifactStore } from '../../common/storage/artifact-store';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { TransientError } from './runtime/runtime-driver';

export interface ModelServerOutputs {
  outputs: Record<string, unknown[]>;
  revisionId: string;
}

/**
 * Reaches model servers through the gateway's internal admin API. Model servers live on an
 * `internal: true` Docker network, so the worker (a host process in local dev) cannot reach them
 * directly; the gateway is the only component on both networks. Token-protected, never public.
 */
@Injectable()
export class ModelServerProbe {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(`${this.config.deploy.gatewayAdminUrl}${path}`, {
        ...init,
        headers: {
          'x-modelops-token': this.config.deploy.gatewayToken,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new TransientError(`gateway admin API unreachable: ${(err as Error).message}`);
    }
  }

  /** true once the model server answers /readyz (it only listens after verifying its checksum). */
  async ready(revisionId: string): Promise<boolean> {
    const res = await this.call(`/internal/revisions/${revisionId}/readyz`);
    if (res.status === 401) throw new Error('gateway rejected the internal token');
    return res.ok;
  }

  async predict(revisionId: string, inputs: number[][]): Promise<ModelServerOutputs> {
    const res = await this.call(`/internal/revisions/${revisionId}/predict`, {
      method: 'POST',
      body: JSON.stringify({ inputs }),
    });
    if (res.status >= 500) throw new TransientError(`model server answered ${String(res.status)}`);
    if (!res.ok) throw new Error(`model server rejected golden inputs: HTTP ${String(res.status)}`);
    return (await res.json()) as ModelServerOutputs;
  }
}

/** Presigned GET URLs for exactly one artifact, signed for the host the model server can reach. */
@Injectable()
export class ArtifactUrlSigner implements OnModuleDestroy {
  private readonly s3: S3Client;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly store: ArtifactStore,
  ) {
    this.s3 = new S3Client({
      endpoint: config.deploy.s3InternalEndpoint,
      region: config.s3.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
    });
  }

  /** 10-minute URL: enough to start (and restart within the budget window is re-signed). */
  signModel(sha256: string): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.store.bucket, Key: ArtifactStore.key(sha256) }),
      { expiresIn: 600 },
    );
  }

  onModuleDestroy(): void {
    this.s3.destroy();
  }
}

export interface Golden {
  inputs: number[][];
  outputs: Record<string, unknown[]>;
  tolerance?: Record<string, number>;
}

/**
 * Functional check (docs/05 §1 VERIFYING): the deployed server must reproduce the golden
 * examples that passed validation. Labels exactly; probabilities within 1e-4 (never looser).
 */
export function compareGolden(golden: Golden, got: Record<string, unknown[]>): string | null {
  for (const [name, expected] of Object.entries(golden.outputs)) {
    const actual = got[name];
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return `output "${name}" has ${String(actual?.length ?? 0)} rows, expected ${String(expected.length)}`;
    }
    const tol = Math.min(golden.tolerance?.[name] ?? 1e-4, 1e-4);
    const flat = (v: unknown): number[] => (Array.isArray(v) ? v.flatMap(flat) : [Number(v)]);
    for (let i = 0; i < expected.length; i++) {
      const e = flat(expected[i]);
      const a = flat(actual[i]);
      if (e.length !== a.length) return `output "${name}" row ${String(i)} has the wrong shape`;
      for (let j = 0; j < e.length; j++) {
        const diff = Math.abs((e[j] ?? NaN) - (a[j] ?? NaN));
        if (!(diff <= tol)) {
          return `output "${name}" row ${String(i)} differs by ${diff.toExponential(2)} (tolerance ${tol.toExponential(0)})`;
        }
      }
    }
  }
  return null;
}
