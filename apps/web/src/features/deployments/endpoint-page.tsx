'use client';

import type { EndpointDetail, Revision, RevisionState } from '@modelops/api-contract';
import { ArrowLeftIcon, CheckIcon, CircleIcon, RocketIcon, ServerIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ErrorState, PageHeader, PermissionGate, TableSkeleton } from '@/components/common/states';
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
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@/components/ui/primitives';
import { NativeSelect } from '@/components/ui/select';
import { useModel, useModels, useModelVersion } from '@/features/ml/api';
import { useOrgId } from '@/features/org/org-shell';
import { ApiError, errorMessage } from '@/lib/api/client';
import { cn, formatDateTime, formatRelative } from '@/lib/utils';
import { CopyField } from './api-keys-section';
import { isSettled, useCancelRevision, useDeploy, useEndpoint, useRevision } from './api';
import { PIPELINE, PIPELINE_HELP, RevisionStateBadge, stateLabel } from './labels';

const CANCELLABLE: ReadonlySet<RevisionState> = new Set([
  'REQUESTED',
  'QUEUED',
  'PROVISIONING',
  'LOADING',
]);

function DeployDialog({
  orgId,
  endpoint,
  open,
  onOpenChange,
}: {
  orgId: string;
  endpoint: EndpointDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const models = useModels(orgId, endpoint.projectId);
  const [modelId, setModelId] = useState('');
  const selectedModel = modelId || models.data?.[0]?.id || '';
  const model = useModel(orgId, selectedModel);
  const validated = (model.data?.versions ?? []).filter((v) => v.status === 'VALIDATED');
  const [versionId, setVersionId] = useState('');
  const selectedVersion = versionId || validated[0]?.id || '';
  // One key per dialog: retries and double clicks replay instead of deploying twice.
  const [key] = useState(() => crypto.randomUUID());
  const deploy = useDeploy(orgId, endpoint.id);
  const error = deploy.error instanceof ApiError ? deploy.error : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deploy to {endpoint.name}</DialogTitle>
          <DialogDescription>
            The version runs in its own container, must reproduce its golden examples, and only then
            takes over the traffic. The current revision stays warm for a while.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <span>{error.problem.detail ?? error.problem.title}</span>
          </Alert>
        )}
        <div className="grid gap-4">
          <Field id="deploy-model" label="Model">
            <NativeSelect
              id="deploy-model"
              value={selectedModel}
              onChange={(e) => {
                setModelId(e.target.value);
                setVersionId('');
              }}
            >
              {(models.data ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field
            id="deploy-version"
            label="Version"
            hint={
              model.data && validated.length === 0
                ? 'No validated versions yet. Only validated versions can be deployed.'
                : undefined
            }
          >
            <NativeSelect
              id="deploy-version"
              value={selectedVersion}
              onChange={(e) => setVersionId(e.target.value)}
              disabled={validated.length === 0}
            >
              {validated.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version} · {v.framework === 'PYTORCH_ONNX' ? 'PyTorch' : 'scikit-learn'}
                  {v.metrics.test_roc_auc !== undefined
                    ? ` · AUC ${v.metrics.test_roc_auc.toFixed(3)}`
                    : ''}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <DialogFooter>
          <Button
            disabled={!selectedVersion || deploy.isPending}
            onClick={() =>
              deploy.mutate(
                { modelVersionId: selectedVersion, key },
                {
                  onSuccess: (r) => {
                    toast.success(`Revision ${String(r.revisionNumber)} requested`);
                    onOpenChange(false);
                  },
                },
              )
            }
          >
            <RocketIcon aria-hidden />
            {deploy.isPending ? 'Requesting…' : 'Deploy'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The six happy-path steps, marked done / current / failed from the revision's events. */
function Stepper({ revision }: { revision: Revision }) {
  const reached = new Set(revision.events.map((e) => e.toState));
  const failed = revision.state === 'FAILED' || revision.state === 'CANCELLED';
  // The step a failed revision was attempting: the first one it never reached.
  const stoppedAt = failed ? PIPELINE.find((s) => !reached.has(s)) : undefined;
  return (
    <ol className="grid gap-2 sm:grid-cols-6" aria-label="Deployment progress">
      {PIPELINE.map((step) => {
        const done = reached.has(step);
        const current = revision.state === step && step !== 'READY';
        const stoppedHere = step === stoppedAt;
        return (
          <li
            key={step}
            data-step={step}
            data-state={done ? 'done' : stoppedHere ? 'failed' : current ? 'current' : 'todo'}
            className={cn(
              'grid gap-1 rounded-md border p-2 text-xs',
              done && 'border-success/40',
              stoppedHere && 'border-destructive/40',
            )}
          >
            <span className="flex items-center gap-1.5 font-medium">
              {done ? (
                <CheckIcon className="size-3.5 text-success" aria-hidden />
              ) : stoppedHere ? (
                <XIcon className="size-3.5 text-destructive" aria-hidden />
              ) : (
                <CircleIcon className="size-3.5 text-muted-foreground" aria-hidden />
              )}
              {stateLabel(step)}
              <span className="sr-only">
                : {done ? 'done' : stoppedHere ? 'failed' : current ? 'in progress' : 'pending'}
              </span>
            </span>
            <span className="text-muted-foreground">{PIPELINE_HELP[step]}</span>
          </li>
        );
      })}
    </ol>
  );
}

function LatestDeployment({
  orgId,
  endpointId,
  revisionId,
}: {
  orgId: string;
  endpointId: string;
  revisionId: string;
}) {
  const revision = useRevision(orgId, revisionId);
  const cancel = useCancelRevision(orgId, endpointId);
  if (revision.isPending) return <TableSkeleton rows={2} />;
  if (revision.isError) return <ErrorState error={revision.error} />;
  const r = revision.data;
  return (
    <Card aria-busy={!isSettled(r.state)}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <CardTitle>Latest deployment: revision {r.revisionNumber}</CardTitle>
          <CardDescription>
            {r.modelVersion.modelName} v{r.modelVersion.version} · requested by {r.requestedBy.name}{' '}
            {formatRelative(r.createdAt)}
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <span role="status" aria-live="polite">
            <RevisionStateBadge state={r.state} />
          </span>
          {CANCELLABLE.has(r.state) && (
            <PermissionGate orgId={orgId} permission="deployment:cancel">
              <Button
                variant="outline"
                size="sm"
                disabled={cancel.isPending}
                onClick={() =>
                  cancel.mutate(r.id, {
                    onSuccess: () => toast.success('Deployment cancelled'),
                    onError: (err) => toast.error(errorMessage(err)),
                  })
                }
              >
                Cancel
              </Button>
            </PermissionGate>
          )}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Stepper revision={r} />
        {r.state === 'FAILED' && (
          <Alert variant="destructive">
            <span className="font-medium">Failed: {r.failureCode}</span>
            <span>{r.failureDetail}</span>
          </Alert>
        )}
        <ol className="grid gap-1.5 text-sm" aria-label="Timeline">
          {r.events.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-3">
              <time
                className="w-40 shrink-0 text-muted-foreground tabular-nums"
                dateTime={e.createdAt}
              >
                {formatDateTime(e.createdAt)}
              </time>
              <span className="font-medium">{stateLabel(e.toState)}</span>
              <span className="text-muted-foreground">{e.message}</span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function Serving({ orgId, endpoint }: { orgId: string; endpoint: EndpointDetail }) {
  const stable = endpoint.stableRevision;
  const version = useModelVersion(orgId, stable?.modelVersion.id ?? '');
  const features = version.data?.signature.inputs[0]?.features ?? [];
  const example = JSON.stringify({ inputs: [Object.fromEntries(features.map((f) => [f, 1]))] });
  const curl = [
    `curl -X POST ${endpoint.invokeUrl} \\`,
    '  -H "Authorization: Bearer $MODELOPS_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '${example}'`,
  ].join('\n');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Serving</CardTitle>
        <CardDescription>What clients get when they call this endpoint.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {stable ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <RevisionStateBadge state={stable.state} />
            <span>
              Revision {stable.revisionNumber}:{' '}
              <Link
                href={`/orgs/${orgId}/model-versions/${stable.modelVersion.id}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {stable.modelVersion.modelName} v{stable.modelVersion.version}
              </Link>
            </span>
            {stable.readyAt && (
              <span className="text-muted-foreground">since {formatDateTime(stable.readyAt)}</span>
            )}
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <ServerIcon className="size-4" aria-hidden /> Nothing deployed yet: calls return 503.
          </p>
        )}
        <div className="grid min-w-0 gap-2">
          <span className="text-sm font-medium">Call it</span>
          <CopyField
            value={stable && features.length ? curl : endpoint.invokeUrl}
            label="Copy request"
          />
          <span className="text-xs text-muted-foreground">
            Create an API key in the project. Inputs are checked against the model’s signature;
            responses carry <code className="font-mono">X-Model-Version</code> and{' '}
            <code className="font-mono">X-Revision-Id</code>.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export function EndpointPage() {
  const orgId = useOrgId();
  const { endpointId } = useParams<{ endpointId: string }>();
  const endpoint = useEndpoint(orgId, endpointId);
  const [deployOpen, setDeployOpen] = useState(false);

  if (endpoint.isPending) return <TableSkeleton rows={4} />;
  if (endpoint.isError) {
    return <ErrorState error={endpoint.error} onRetry={() => void endpoint.refetch()} />;
  }
  const e = endpoint.data;
  const latest = e.revisions[0];

  return (
    // min-w-0: grid items default to min-width:auto, so a long curl line would widen the page.
    <div className="grid gap-6 *:min-w-0">
      <Link
        href={`/orgs/${orgId}/projects/${e.project.id}`}
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" aria-hidden /> {e.project.name}
      </Link>
      <PageHeader
        title={e.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {e.environment === 'STAGING' ? 'Staging' : 'Production'}
            </Badge>
            <code className="font-mono text-xs">/v1/endpoints/{e.slug}/predict</code>
            <span>{e.rateLimitRps} req/s per key</span>
          </span>
        }
        actions={
          <PermissionGate orgId={orgId} permission="deployment:create">
            <Button onClick={() => setDeployOpen(true)} disabled={!!e.inProgressRevision}>
              <RocketIcon aria-hidden /> Deploy
            </Button>
          </PermissionGate>
        }
      />
      <Serving orgId={orgId} endpoint={e} />
      {latest && <LatestDeployment orgId={orgId} endpointId={e.id} revisionId={latest.id} />}
      {e.revisions.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Revision history</CardTitle>
            <CardDescription>Every deployment attempt, newest first. Never reused.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <Tr>
                  <Th>#</Th>
                  <Th>Model version</Th>
                  <Th>State</Th>
                  <Th className="hidden md:table-cell">Detail</Th>
                  <Th className="hidden sm:table-cell">Requested</Th>
                </Tr>
              </THead>
              <TBody>
                {e.revisions.map((r) => (
                  <Tr key={r.id}>
                    <Td className="font-mono">{r.revisionNumber}</Td>
                    <Td>
                      {r.modelVersion.modelName} v{r.modelVersion.version}
                    </Td>
                    <Td>
                      <RevisionStateBadge state={r.state} />
                    </Td>
                    <Td className="hidden text-xs text-muted-foreground md:table-cell">
                      {r.failureCode ?? (r.id === e.stableRevision?.id ? 'serving' : '')}
                    </Td>
                    <Td className="hidden text-muted-foreground sm:table-cell">
                      {formatRelative(r.createdAt)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}
      {deployOpen && <DeployDialog orgId={orgId} endpoint={e} open onOpenChange={setDeployOpen} />}
    </div>
  );
}
