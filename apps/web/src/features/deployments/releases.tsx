'use client';

import type { CanaryCheck, EndpointDetail, RevisionSummary } from '@modelops/api-contract';
import {
  ActivityIcon,
  CheckIcon,
  CircleSlashIcon,
  HourglassIcon,
  RotateCcwIcon,
  TrendingUpIcon,
  XIcon,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
} from '@/components/ui/primitives';
import { NativeSelect } from '@/components/ui/select';
import { ApiError, errorMessage } from '@/lib/api/client';
import { useCan, useMembership } from '@/lib/auth/session';
import { formatRelative } from '@/lib/utils';
import {
  useAbortCanary,
  usePromote,
  useRollback,
  useRunCanaryCheck,
  useSetCanaryWeight,
} from './releases-api';

const name = (r: RevisionSummary) =>
  `revision ${String(r.revisionNumber)} · ${r.modelVersion.modelName} v${String(r.modelVersion.version)}`;
const pct = (x: number | null | undefined) => (x == null ? '—' : `${(x * 100).toFixed(2)}%`);
const ms = (x: number | null | undefined) => (x == null ? '—' : `${x.toFixed(1)} ms`);

/** Who may change traffic here: writers on staging, Owners/Admins on production (API enforces). */
function useCanRelease(orgId: string, endpoint: EndpointDetail) {
  const role = useMembership(orgId)?.role;
  const can = useCan(orgId, 'release:manage');
  return can && (endpoint.environment === 'STAGING' || role === 'OWNER' || role === 'ADMIN');
}

/**
 * Earlier revisions that served as the stable one and could again (warm: DRAINING; redeployed:
 * RETIRED), newest first. An aborted canary never served as stable, so it is never offered.
 */
export function rollbackTargets(endpoint: EndpointDetail): RevisionSummary[] {
  const busy = new Set([endpoint.stableRevision?.id, endpoint.canary?.revision.id]);
  return endpoint.revisions
    .filter(
      (r) => r.stableAt && (r.state === 'DRAINING' || r.state === 'RETIRED') && !busy.has(r.id),
    )
    .sort((a, b) => (b.stableAt ?? '').localeCompare(a.stableAt ?? ''));
}

export function TrafficSplit({ endpoint }: { endpoint: EndpointDetail }) {
  const stable = endpoint.stableRevision;
  if (!stable) return null;
  const canary = endpoint.canary;
  const share = canary?.weight ?? 0;
  const label = canary
    ? `Traffic split: ${String(100 - share)}% to stable ${name(stable)}, ${String(share)}% to canary ${name(canary.revision)}`
    : `Traffic split: 100% to stable ${name(stable)}`;
  return (
    <div className="grid gap-2">
      <div className="flex h-3 overflow-hidden rounded-full bg-muted" role="img" aria-label={label}>
        <div style={{ width: `${String(100 - share)}%`, background: 'var(--chart-1)' }} />
        {share > 0 && <div style={{ width: `${String(share)}%`, background: 'var(--chart-2)' }} />}
      </div>
      <div className="flex flex-wrap justify-between gap-2 text-sm" data-testid="traffic-split">
        <span>
          <span className="font-medium">Stable {100 - share}%</span>{' '}
          <span className="text-muted-foreground">{name(stable)}</span>
        </span>
        {canary && (
          <span>
            <span className="font-medium">Canary {share}%</span>{' '}
            <span className="text-muted-foreground">{name(canary.revision)}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function VerdictBadge({ check }: { check: CanaryCheck | null }) {
  if (!check) {
    return (
      <Badge variant="secondary">
        <HourglassIcon className="size-3" aria-hidden /> No check yet
      </Badge>
    );
  }
  if (check.verdict === 'PASS') {
    return (
      <Badge variant="success">
        <CheckIcon className="size-3" aria-hidden /> Healthy: eligible to promote
      </Badge>
    );
  }
  if (check.verdict === 'FAIL') {
    return (
      <Badge variant="destructive">
        <XIcon className="size-3" aria-hidden /> Failing
      </Badge>
    );
  }
  return (
    <Badge variant="secondary">
      <HourglassIcon className="size-3" aria-hidden /> Collecting evidence
    </Badge>
  );
}

function CheckDetails({ check }: { check: CanaryCheck }) {
  return (
    <div className="grid gap-3">
      <dl className="grid grid-cols-3 gap-x-4 gap-y-1 text-sm" aria-label="Canary vs stable">
        <span />
        <dt className="font-medium">Canary</dt>
        <dt className="font-medium">Stable</dt>
        <dt className="text-muted-foreground">Requests</dt>
        <dd className="tabular-nums" data-canary="requests">
          {check.canary.requests.toLocaleString()}
        </dd>
        <dd className="tabular-nums">{check.stable.requests.toLocaleString()}</dd>
        <dt className="text-muted-foreground">Error rate</dt>
        <dd className="tabular-nums" data-canary="errorRate">
          {pct(check.canary.errorRate)}
        </dd>
        <dd className="tabular-nums">{pct(check.stable.errorRate)}</dd>
        <dt className="text-muted-foreground">p95 latency</dt>
        <dd className="tabular-nums">{ms(check.canary.p95Ms)}</dd>
        <dd className="tabular-nums">{ms(check.stable.p95Ms)}</dd>
      </dl>
      <ul className="grid gap-1" aria-label="Canary checks">
        {check.checks.map((c) => (
          <li key={c.rule} className="flex items-start gap-2 text-xs">
            {c.passed ? (
              <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
            ) : (
              <XIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
            )}
            <span>
              <span className="sr-only">{c.passed ? 'passed: ' : 'not met: '}</span>
              {c.detail}
            </span>
          </li>
        ))}
      </ul>
      <span className="text-xs text-muted-foreground">
        Checked {formatRelative(check.createdAt)} over the last {check.windowSeconds} s; the worker
        checks every 15 s and aborts a failing canary on its own.
      </span>
    </div>
  );
}

function CanaryControls({ orgId, endpoint }: { orgId: string; endpoint: EndpointDetail }) {
  const canary = endpoint.canary;
  const canRelease = useCanRelease(orgId, endpoint);
  const [weight, setWeight] = useState(String(canary?.weight ?? 10));
  const setShare = useSetCanaryWeight(orgId, endpoint.id);
  const promote = usePromote(orgId, endpoint.id);
  const abort = useAbortCanary(orgId, endpoint.id);
  const check = useRunCanaryCheck(orgId, endpoint.id);
  if (!canary) return null;
  const parsed = Number(weight);
  const validWeight = Number.isInteger(parsed) && parsed >= 0 && parsed <= 50;
  const busy = setShare.isPending || promote.isPending || abort.isPending;
  const onError = (err: unknown) => toast.error(errorMessage(err));

  return (
    <section className="grid gap-4 rounded-lg border p-4" aria-label="Canary">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Canary: {name(canary.revision)}</span>
        <VerdictBadge check={canary.latestCheck} />
      </div>
      {canary.latestCheck ? (
        <CheckDetails check={canary.latestCheck} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {canary.weight === 0
            ? 'Warm, but receiving no traffic. Give it a share to start the analysis.'
            : 'Receiving traffic; the first analysis runs within 15 seconds.'}
        </p>
      )}
      {canRelease && (
        <div className="flex flex-wrap items-end gap-3">
          <form
            className="flex items-end gap-2"
            onSubmit={(ev) => {
              ev.preventDefault();
              if (!validWeight) return;
              setShare.mutate(
                { weight: parsed, rowVersion: endpoint.rowVersion },
                {
                  onSuccess: () => toast.success(`Canary share set to ${String(parsed)}%`),
                  onError,
                },
              );
            }}
          >
            <div className="w-36">
              <Field
                id="canary-weight"
                label="Canary share (%)"
                error={validWeight ? undefined : '0 to 50'}
              >
                <Input
                  id="canary-weight"
                  type="number"
                  min={0}
                  max={50}
                  step={1}
                  value={weight}
                  onChange={(ev) => setWeight(ev.target.value)}
                  aria-invalid={!validWeight}
                />
              </Field>
            </div>
            <Button type="submit" variant="outline" disabled={!validWeight || busy}>
              Set share
            </Button>
          </form>
          <Button
            variant="outline"
            disabled={check.isPending}
            onClick={() =>
              check.mutate(undefined, {
                onSuccess: (c) =>
                  c.aborted
                    ? toast.error('The canary failed its check and was aborted')
                    : toast.success(`Canary check: ${c.verdict.toLowerCase()}`),
                onError,
              })
            }
          >
            <ActivityIcon aria-hidden /> {check.isPending ? 'Checking…' : 'Run check'}
          </Button>
          <Button
            disabled={!canary.eligible || busy}
            title={canary.eligible ? undefined : 'Needs a passing canary check'}
            onClick={() =>
              promote.mutate(endpoint.rowVersion, {
                onSuccess: () => toast.success('Promoted: the canary now serves all traffic'),
                onError,
              })
            }
          >
            <TrendingUpIcon aria-hidden /> Promote
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              abort.mutate(endpoint.rowVersion, {
                onSuccess: () => toast.success('Canary aborted: stable serves all traffic'),
                onError,
              })
            }
          >
            <CircleSlashIcon aria-hidden /> Abort canary
          </Button>
        </div>
      )}
    </section>
  );
}

function RollbackDialog({
  orgId,
  endpoint,
  targets,
  onClose,
}: {
  orgId: string;
  endpoint: EndpointDetail;
  targets: RevisionSummary[];
  onClose: () => void;
}) {
  const rollback = useRollback(orgId, endpoint.id);
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '');
  const target = targets.find((t) => t.id === targetId);
  const error = rollback.error instanceof ApiError ? rollback.error : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Roll back {endpoint.name}?</DialogTitle>
          <DialogDescription>
            {endpoint.stableRevision ? (
              <>
                {name(endpoint.stableRevision)} stops receiving traffic and stays warm for a while,
                so you can undo this.
              </>
            ) : (
              'Nothing is serving right now.'
            )}
            {endpoint.canary ? ' The running canary is aborted.' : ''}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <span>{error.problem.detail ?? error.problem.title}</span>
          </Alert>
        )}
        <Field id="rollback-target" label="Roll back to">
          <NativeSelect
            id="rollback-target"
            value={targetId}
            onChange={(ev) => setTargetId(ev.target.value)}
          >
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {name(t)} ({t.state === 'DRAINING' ? 'warm' : 'retired'})
              </option>
            ))}
          </NativeSelect>
        </Field>
        {target && (
          <p className="text-sm text-muted-foreground">
            {target.state === 'DRAINING'
              ? 'It is still running: traffic moves to it in seconds.'
              : 'Its container was removed: the same validated version is deployed again (about a minute), then takes over.'}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Keep current
          </Button>
          <Button
            variant="destructive"
            disabled={!target || rollback.isPending}
            onClick={() =>
              rollback.mutate(
                { rowVersion: endpoint.rowVersion, targetRevisionId: targetId },
                {
                  onSuccess: (r) => {
                    toast.success(
                      r.path === 'fast'
                        ? `Rolled back: ${name(r.revision)} serves again`
                        : `Rolling back: deploying ${name(r.revision)}`,
                    );
                    onClose();
                  },
                },
              )
            }
          >
            <RotateCcwIcon aria-hidden /> {rollback.isPending ? 'Rolling back…' : 'Roll back'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Releases (M8): who gets which share of traffic, the canary's evidence, promote / abort, and
 * rollback to an earlier revision. Every action sends the endpoint's ETag.
 */
export function ReleasePanel({ orgId, endpoint }: { orgId: string; endpoint: EndpointDetail }) {
  const canRelease = useCanRelease(orgId, endpoint);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const targets = rollbackTargets(endpoint);
  if (!endpoint.stableRevision && targets.length === 0) return null;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <CardTitle>Release</CardTitle>
          <CardDescription>
            {endpoint.environment === 'PRODUCTION'
              ? 'Production: deployments need a second Owner/Admin; traffic changes are Owner/Admin only.'
              : 'Deploy a new version as a canary to try it on a share of real traffic first.'}
          </CardDescription>
        </div>
        {canRelease && targets.length > 0 && (
          <Button variant="outline" onClick={() => setRollbackOpen(true)}>
            <RotateCcwIcon aria-hidden /> Roll back
          </Button>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        <TrafficSplit endpoint={endpoint} />
        <CanaryControls
          key={endpoint.canary?.revision.id ?? 'none'}
          orgId={orgId}
          endpoint={endpoint}
        />
      </CardContent>
      {rollbackOpen && (
        <RollbackDialog
          orgId={orgId}
          endpoint={endpoint}
          targets={targets}
          onClose={() => setRollbackOpen(false)}
        />
      )}
    </Card>
  );
}
