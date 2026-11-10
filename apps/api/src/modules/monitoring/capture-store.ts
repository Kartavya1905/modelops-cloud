import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/config';

/** One captured request row: prediction id, time, model version, inputs in signature order. */
export interface CapturedRow {
  id: string;
  t: number;
  mv: string;
  x: number[];
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Captured inputs for drift (FR-37), opt-in per endpoint, as JSONL batches in object storage:
 *   drift-captures/<org>/<endpoint>/<yyyy-mm-dd>/<first-stream-id>.jsonl
 * Day prefixes make the 7-day retention a cheap prefix delete. Never inputs in logs or Postgres.
 */
@Injectable()
export class CaptureStore implements OnModuleDestroy {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.bucket = config.monitoring.captureBucket;
    this.s3 = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
    });
  }

  static prefix(orgId: string, endpointId: string, dayString?: string): string {
    return `${orgId}/${endpointId}/${dayString ? `${dayString}/` : ''}`;
  }

  /** Idempotent: a redelivered batch overwrites its own object (same first stream id). */
  async putBatch(orgId: string, endpointId: string, batchId: string, rows: CapturedRow[]) {
    if (rows.length === 0) return;
    const key = `${CaptureStore.prefix(orgId, endpointId, day(rows[0]?.t ?? Date.now()))}${batchId.replace(/[^0-9-]/g, '')}.jsonl`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
        ContentType: 'application/x-ndjson',
      }),
    );
  }

  private async keys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of page.Contents ?? []) if (o.Key) out.push(o.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  /** Rows captured in [fromMs, toMs], de-duplicated by prediction id, newest first. */
  async read(
    orgId: string,
    endpointId: string,
    fromMs: number,
    toMs: number,
  ): Promise<CapturedRow[]> {
    const days: string[] = [];
    for (let t = fromMs - (fromMs % 86_400_000); t <= toMs; t += 86_400_000) days.push(day(t));
    const rows = new Map<string, CapturedRow>();
    for (const d of days) {
      for (const key of await this.keys(CaptureStore.prefix(orgId, endpointId, d))) {
        const obj = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
        const text = (await obj.Body?.transformToString()) ?? '';
        for (const line of text.split('\n')) {
          if (!line) continue;
          const r = JSON.parse(line) as CapturedRow;
          if (r.t >= fromMs && r.t <= toMs) rows.set(r.id, r);
        }
      }
    }
    return [...rows.values()].sort((a, b) => b.t - a.t);
  }

  /** Retention: deletes whole day folders older than `days`. Returns objects removed. */
  async deleteOlderThan(days: number, nowMs = Date.now(), prefix = ''): Promise<number> {
    const cutoff = day(nowMs - days * 86_400_000);
    const old = (await this.keys(prefix)).filter((k) => {
      const d = k.split('/')[2] ?? '';
      return /^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff;
    });
    for (let i = 0; i < old.length; i += 1000) {
      await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: old.slice(i, i + 1000).map((Key) => ({ Key })) },
        }),
      );
    }
    return old.length;
  }

  onModuleDestroy(): void {
    this.s3.destroy();
  }
}
