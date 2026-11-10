import {
  Controller,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { OrgAccessGuard, RequirePermission } from '../../common/authz/org-access.guard';
import { Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UuidParam } from '../../common/validation';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import type { CanaryVerdict, Endpoint, Prisma } from '../../generated/prisma/client';
import { PrometheusClient } from '../metrics/prometheus';
import { CanaryCheckDto, type CanaryCheckRuleDto, type CanarySideDto } from './deployments.dto';
import { ReleasesService, SYSTEM } from './releases';
import { type CanaryMetrics, canaryCheckDto } from './revision-view';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Per-project thresholds (`projects.canary_policy`), docs/05 §6. */
export interface CanaryPolicy {
  /** A PASS needs the canary to have run at least this long... */
  minDurationSeconds: number;
  /** ...and to have answered at least this many requests (any verdict needs this many). */
  minRequests: number;
  /** Canary error rate may exceed stable's by at most this much (0.01 = 1 percentage point). */
  maxErrorRateIncrease: number;
  /** Canary p95 latency may be at most this multiple of stable's. */
  maxLatencyRatio: number;
}

export const DEFAULT_CANARY_POLICY: CanaryPolicy = {
  minDurationSeconds: 300,
  minRequests: 200,
  maxErrorRateIncrease: 0.01,
  maxLatencyRatio: 1.25,
};

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(2)}%`);
const ms = (x: number | null) => (x === null ? 'n/a' : `${x.toFixed(1)} ms`);

/**
 * The decision, as a pure function. Bad news acts fast, good news needs patience: once the canary
 * has `minRequests` requests, a breach of the error or latency rule FAILS it at once (and the
 * canary is aborted), while a PASS also needs `minDurationSeconds` of history.
 */
export function judgeCanary(
  policy: CanaryPolicy,
  m: CanaryMetrics,
): { verdict: CanaryVerdict; checks: CanaryCheckRuleDto[] } {
  const enough = m.canary.requests >= policy.minRequests;
  const long = m.windowSeconds >= policy.minDurationSeconds;
  const canaryRate = m.canary.errorRate ?? 0;
  const stableRate = m.stable.errorRate ?? 0;
  const errorsOk = canaryRate <= stableRate + policy.maxErrorRateIncrease;
  const latencyOk =
    m.canary.p95Ms === null || m.stable.p95Ms === null
      ? true
      : m.canary.p95Ms <= m.stable.p95Ms * policy.maxLatencyRatio;
  const checks: CanaryCheckRuleDto[] = [
    {
      rule: 'minRequests',
      passed: enough,
      detail: `${String(m.canary.requests)} canary requests (need ${String(policy.minRequests)})`,
    },
    {
      rule: 'minDurationSeconds',
      passed: long,
      detail: `running for ${String(m.windowSeconds)} s (need ${String(policy.minDurationSeconds)} s)`,
    },
    {
      rule: 'maxErrorRateIncrease',
      passed: errorsOk,
      detail:
        `error rate ${pct(m.canary.errorRate)} vs stable ${pct(m.stable.errorRate)} ` +
        `(allowed + ${(policy.maxErrorRateIncrease * 100).toFixed(2)} pp)` +
        (m.fallbacks > 0 ? `, incl. ${String(m.fallbacks)} fallbacks to stable` : ''),
    },
    {
      rule: 'maxLatencyRatio',
      passed: latencyOk,
      detail:
        m.canary.p95Ms === null || m.stable.p95Ms === null
          ? 'p95 latency: not enough data to compare yet'
          : `p95 ${ms(m.canary.p95Ms)} vs stable ${ms(m.stable.p95Ms)} (allowed x${String(policy.maxLatencyRatio)})`,
    },
  ];
  if (enough && (!errorsOk || !latencyOk)) return { verdict: 'FAIL', checks };
  if (enough && long) return { verdict: 'PASS', checks };
  return { verdict: 'INCONCLUSIVE', checks };
}

/**
 * Canary analysis (docs/05 §6): canary vs stable from the gateway's Prometheus series since the
 * canary started taking traffic. Counts are exact (counter differences, as in M6); fallbacks
 * (requests the gateway sent to stable because the canary's circuit was open) count as canary
 * failures, so a canary cannot look healthy by being skipped.
 */
@Injectable()
export class CanaryAnalyzer {
  private readonly logger = new Logger(CanaryAnalyzer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly prometheus: PrometheusClient,
    private readonly releases: ReleasesService,
  ) {}

  private async side(endpointId: string, revisionId: string, windowS: number, nowS: number) {
    if (!UUID.test(endpointId) || !UUID.test(revisionId)) throw new Error('bad id');
    const sel = `endpoint_id="${endpointId}",revision="${revisionId}",source="api"`;
    const delta = async (metric: string, extra = '') => {
      const m = `${metric}{${sel}${extra}}`;
      const [now, before] = await Promise.all([
        this.prometheus.scalar(`sum(${m})`, nowS),
        this.prometheus.scalar(`sum(${m} offset ${String(windowS)}s)`, nowS),
      ]);
      return Math.max(0, Math.round(now - before));
    };
    const requests = await delta('gateway_requests_total');
    const errors = await delta('gateway_requests_total', ',code=~"5.."');
    const p95 = await this.prometheus.scalar(
      `histogram_quantile(0.95, sum by (le) (rate(gateway_request_duration_seconds_bucket{${sel}}[${String(windowS)}s])))`,
      nowS,
    );
    const fallbacks = await delta('gateway_canary_fallback_total');
    return {
      requests,
      errors,
      p95Ms: Number.isFinite(p95) && p95 > 0 ? p95 * 1000 : null,
      fallbacks,
    };
  }

  /** Measures, judges, records one check; aborts the canary on FAIL. */
  async analyze(endpointId: string): Promise<CanaryCheckDto | null> {
    const e = await this.prisma.endpoint.findUnique({
      where: { id: endpointId },
      include: { project: { select: { canaryPolicy: true } } },
    });
    if (!e?.canaryRevisionId || !e.stableRevisionId || !e.canaryStartedAt) return null;
    const policy = {
      ...DEFAULT_CANARY_POLICY,
      ...(e.project.canaryPolicy as Partial<CanaryPolicy>),
    };
    const nowS = Math.floor(Date.now() / 1000);
    const windowSeconds = Math.max(1, nowS - Math.floor(e.canaryStartedAt.getTime() / 1000));
    const [c, s] = await Promise.all([
      this.side(e.id, e.canaryRevisionId, windowSeconds, nowS),
      this.side(e.id, e.stableRevisionId, windowSeconds, nowS),
    ]);
    const rate = (errors: number, requests: number) => (requests > 0 ? errors / requests : null);
    const canary: CanarySideDto = {
      requests: c.requests + c.fallbacks,
      errors: c.errors + c.fallbacks,
      errorRate: rate(c.errors + c.fallbacks, c.requests + c.fallbacks),
      p95Ms: c.p95Ms,
    };
    const stable: CanarySideDto = {
      requests: s.requests,
      errors: s.errors,
      errorRate: rate(s.errors, s.requests),
      p95Ms: s.p95Ms,
    };
    const metrics: CanaryMetrics = { canary, stable, fallbacks: c.fallbacks, windowSeconds };
    const { verdict, checks } = judgeCanary(policy, metrics);

    let aborted = false;
    if (verdict === 'FAIL') {
      const failed = checks.filter((x) => !x.passed && x.rule.startsWith('max'));
      try {
        await this.releases.abort(e.orgId, e.id, SYSTEM, {
          reason: `automatic: ${failed.map((x) => x.detail).join('; ')}`,
        });
        aborted = true;
      } catch (err) {
        // Promoted, aborted or rolled back meanwhile: record what we saw, change nothing.
        this.logger.warn(`canary of ${e.id} not aborted: ${(err as Error).message}`);
      }
    }
    const row = await this.prisma.canaryCheck.create({
      data: {
        orgId: e.orgId,
        endpointId: e.id,
        revisionId: e.canaryRevisionId,
        verdict,
        metrics: metrics as unknown as Prisma.InputJsonObject,
        checks: checks as unknown as Prisma.InputJsonArray,
        policy,
        aborted,
      },
    });
    if (aborted) this.logger.warn(`canary of endpoint ${e.id} aborted automatically`);
    return canaryCheckDto(row);
  }

  /** Every running canary (weight > 0); one failing endpoint never blocks the others. */
  async runOnce(): Promise<number> {
    const live: Pick<Endpoint, 'id'>[] = await this.prisma.endpoint.findMany({
      where: { canaryRevisionId: { not: null }, canaryWeight: { gt: 0 } },
      select: { id: true },
    });
    let n = 0;
    for (const e of live) {
      try {
        if (await this.analyze(e.id)) n++;
      } catch (err) {
        this.logger.warn(`canary analysis of ${e.id} failed: ${(err as Error).message}`);
      }
    }
    return n;
  }
}

/** Worker: analyses running canaries every MO_CANARY_ANALYSIS_MS (default 15 s). */
@Injectable()
export class CanaryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CanaryScheduler.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly analyzer: CanaryAnalyzer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.analyzer
        .runOnce()
        .catch((err: unknown) => this.logger.warn(`canary analysis failed: ${String(err)}`))
        .finally(() => (this.running = false));
    }, this.config.deploy.canaryAnalysisMs);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }
}

@ApiTags('releases')
@ApiCookieAuth('session')
@UseGuards(OrgAccessGuard)
@Controller('orgs/:orgId/endpoints/:endpointId/canary')
export class CanaryChecksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analyzer: CanaryAnalyzer,
  ) {}

  /** Run the analysis now (the worker also runs it every 15 s). May abort a failing canary. */
  @Post('checks')
  @HttpCode(200)
  @RequirePermission('release:manage')
  @ApiOkResponse({ type: CanaryCheckDto })
  async check(
    @Param('orgId', new UuidParam('Organization')) orgId: string,
    @Param('endpointId', new UuidParam('Endpoint')) endpointId: string,
  ): Promise<CanaryCheckDto> {
    const e = await this.prisma.endpoint.findFirst({ where: { id: endpointId, orgId } });
    if (!e) throw Errors.notFound('Endpoint');
    if (!e.canaryRevisionId) throw Errors.conflict('NO_CANARY', 'This endpoint has no canary.');
    const out = await this.analyzer.analyze(endpointId);
    if (!out) {
      throw Errors.conflict(
        'CANARY_NOT_STARTED',
        'The canary has no traffic yet (weight 0): set a weight first.',
      );
    }
    return out;
  }
}
