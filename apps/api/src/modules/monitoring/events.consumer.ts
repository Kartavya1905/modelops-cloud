import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { PrismaService } from '../../common/prisma/prisma.service';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { DP } from '../deployments/dataplane';
import { type CapturedRow, CaptureStore } from './capture-store';

const GROUP = 'platform';
type Entry = [id: string, fields: string[]];

export interface ConsumeReport {
  predictions: number;
  captured: number;
  feedbackApplied: number;
  feedbackIgnored: number;
}

/**
 * XREADGROUP's reply for one stream: RESP2 gives `[[stream, entries]]`, RESP3 (Redis 8 via
 * ioredis) a map that arrives as `[stream, entries]`. Accept both; anything else means "nothing".
 */
export function streamEntries(reply: unknown): Entry[] {
  if (!Array.isArray(reply) || reply.length === 0) return [];
  const pair = (Array.isArray(reply[0]) ? reply[0] : reply) as unknown[];
  const entries = pair[1];
  return Array.isArray(entries) ? (entries as Entry[]) : [];
}

const toObject = (fields: string[]) => {
  const o: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) o[fields[i] ?? ''] = fields[i + 1] ?? '';
  return o;
};

/**
 * Consumes the gateway's event stream (M7) in batches, as a Redis consumer group, so several
 * workers share the load and an entry is acknowledged only after it is stored:
 *   prediction -> prediction_records (output summary) [+ inputs -> JSONL in object storage]
 *   feedback   -> prediction_feedback, only for a prediction of the same endpoint
 * At-least-once: a crash before XACK redelivers the batch; every write is idempotent.
 */
@Injectable()
export class EventsConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(EventsConsumer.name);
  private redis?: Redis;
  private readonly consumer = `worker-${String(process.pid)}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly captures: CaptureStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private conn(): Redis {
    this.redis ??= new Redis(this.config.redisUrl, { maxRetriesPerRequest: null });
    return this.redis;
  }

  async ensureGroup(): Promise<void> {
    try {
      // From the start of the stream ("0"): nothing written before the first worker is lost.
      await this.conn().xgroup('CREATE', DP.eventsStream, GROUP, '0', 'MKSTREAM');
    } catch (err) {
      if (!String(err).includes('BUSYGROUP')) throw err;
    }
  }

  /** One batch: first this consumer's unacknowledged entries (after a crash), then new ones. */
  async runOnce(blockMs = 0, count = 500): Promise<ConsumeReport> {
    await this.ensureGroup();
    const read = async (id: string) => {
      const args: (string | number)[] = ['GROUP', GROUP, this.consumer, 'COUNT', count];
      if (blockMs > 0 && id === '>') args.push('BLOCK', blockMs);
      const res = await this.conn().call('XREADGROUP', ...args, 'STREAMS', DP.eventsStream, id);
      return streamEntries(res);
    };
    let entries = await read('0');
    if (entries.length === 0) entries = await read('>');
    if (entries.length === 0)
      return { predictions: 0, captured: 0, feedbackApplied: 0, feedbackIgnored: 0 };
    const report = await this.store(entries);
    await this.conn().xack(DP.eventsStream, GROUP, ...entries.map(([id]) => id));
    return report;
  }

  private async store(entries: Entry[]): Promise<ConsumeReport> {
    const events: Record<string, string | undefined>[] = entries.map(([id, fields]) => ({
      ...toObject(fields),
      streamId: id,
    }));
    const predictions = events.filter((e) => e.type === 'prediction' && e.id && e.endpoint);
    await this.prisma.predictionRecord.createMany({
      data: predictions.map((e) => ({
        id: e.id ?? '',
        orgId: e.org ?? '',
        endpointId: e.endpoint ?? '',
        revisionId: e.revision ?? '',
        modelVersionId: e.modelVersion ?? '',
        label: e.label ?? '',
        score: Number(e.score ?? 0),
        createdAt: new Date(Number(e.ts)),
      })),
      skipDuplicates: true,
    });

    // Captured inputs, one JSONL object per (org, endpoint) in this batch.
    const batches = new Map<
      string,
      { org: string; endpoint: string; first: string; rows: CapturedRow[] }
    >();
    for (const e of predictions) {
      if (!e.inputs) continue;
      const k = `${e.org ?? ''}/${e.endpoint ?? ''}`;
      const b = batches.get(k) ?? {
        org: e.org ?? '',
        endpoint: e.endpoint ?? '',
        first: e.streamId ?? '0',
        rows: [],
      };
      b.rows.push({
        id: e.id ?? '',
        t: Number(e.ts),
        mv: e.modelVersion ?? '',
        x: JSON.parse(e.inputs) as number[],
      });
      batches.set(k, b);
    }
    for (const b of batches.values())
      await this.captures.putBatch(b.org, b.endpoint, b.first, b.rows);

    let applied = 0;
    const feedback = events.filter((e) => e.type === 'feedback' && e.id && e.endpoint);
    for (const f of feedback) {
      // Only a prediction of the endpoint the key was allowed to call (no cross-tenant labels).
      applied += await this.prisma.$executeRaw`
        INSERT INTO prediction_feedback (prediction_id, label, received_at)
        SELECT id, ${f.label ?? ''}, ${new Date(Number(f.ts))}
        FROM prediction_records WHERE id = ${f.id ?? ''}::uuid AND endpoint_id = ${f.endpoint ?? ''}::uuid
        ON CONFLICT (prediction_id) DO UPDATE SET label = EXCLUDED.label, received_at = EXCLUDED.received_at`;
    }
    const report = {
      predictions: predictions.length,
      captured: [...batches.values()].reduce((n, b) => n + b.rows.length, 0),
      feedbackApplied: applied,
      feedbackIgnored: feedback.length - applied,
    };
    if (report.feedbackIgnored > 0) {
      this.logger.debug(
        `${String(report.feedbackIgnored)} feedback label(s) for unknown predictions ignored`,
      );
    }
    return report;
  }

  /** Retention (docs/03 §4): prediction records and captured inputs older than N days. */
  async purge(
    nowMs = Date.now(),
    orgId?: string,
  ): Promise<{ records: number; captureObjects: number }> {
    const days = this.config.monitoring.retentionDays;
    const { count } = await this.prisma.predictionRecord.deleteMany({
      where: {
        createdAt: { lt: new Date(nowMs - days * 86_400_000) },
        ...(orgId ? { orgId } : {}),
      },
    });
    return {
      records: count,
      captureObjects: await this.captures.deleteOlderThan(days, nowMs, orgId ? `${orgId}/` : ''),
    };
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }
}

/** Worker loop: consume continuously (blocking reads), purge hourly. */
@Injectable()
export class EventsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsWorker.name);
  private running = false;
  private purgeTimer?: NodeJS.Timeout;

  constructor(private readonly consumer: EventsConsumer) {}

  onModuleInit(): void {
    this.running = true;
    void this.loop();
    this.purgeTimer = setInterval(() => {
      this.consumer
        .purge()
        .catch((err: unknown) => this.logger.warn(`purge failed: ${String(err)}`));
    }, 3_600_000);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.consumer.runOnce(2000);
      } catch (err) {
        this.logger.warn(`event batch failed (will be redelivered): ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  onModuleDestroy(): void {
    this.running = false;
    clearInterval(this.purgeTimer);
  }
}
