import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/config';

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Content-addressed artifact storage (docs/03, section 5): every blob lives at
 * `blobs/sha256/<sha256-of-its-bytes>` in the model-artifacts bucket.
 *
 * - The key *is* the content hash, so a reference can never silently point at different bytes:
 *   anyone holding the hash can verify what they read (the validator and model server do).
 * - Writes are put-if-absent: an existing blob is never overwritten. If stored bytes were ever
 *   tampered with, that is detected (V11 / load-time checksum), not quietly "repaired".
 */
@Injectable()
export class ArtifactStore implements OnModuleDestroy {
  private readonly s3: S3Client;
  readonly bucket: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.bucket = config.s3.artifactBucket;
    this.s3 = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
    });
  }

  static key(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid sha256');
    return `blobs/sha256/${sha256}`;
  }

  async exists(sha256: string): Promise<boolean> {
    try {
      await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: ArtifactStore.key(sha256) }),
      );
      return true;
    } catch (err) {
      if (
        err instanceof NotFound ||
        (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404)
      ) {
        return false;
      }
      throw err;
    }
  }

  /** Stores `data` under its own hash unless already present. Returns the hash. */
  async putIfAbsent(
    data: Uint8Array,
    contentType: string,
  ): Promise<{ sha256: string; stored: boolean }> {
    const sha256 = sha256Hex(data);
    if (await this.exists(sha256)) return { sha256, stored: false };
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: ArtifactStore.key(sha256),
        Body: data,
        ContentType: contentType,
        ContentLength: data.length,
      }),
    );
    return { sha256, stored: true };
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: ArtifactStore.key(sha256) }),
      );
      return res.Body ? await res.Body.transformToByteArray() : null;
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      throw err;
    }
  }

  onModuleDestroy(): void {
    this.s3.destroy();
  }
}

@Global()
@Module({ providers: [ArtifactStore], exports: [ArtifactStore] })
export class ArtifactStoreModule {}
