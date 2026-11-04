'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  CircleDashedIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  PlusIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorState, PageHeader, PermissionGate, TableSkeleton } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@/components/ui/primitives';
import { useOrgId } from '@/features/org/org-shell';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { formatDateTime, formatRelative } from '@/lib/utils';
import { useModel, useModels, useRuns } from './api';
import {
  formatMetric,
  FrameworkBadge,
  HEADLINE_METRICS,
  metricLabel,
  VersionStatusBadge,
} from './labels';
import { RegisterDialog } from './register-dialog';

const BackLink = ({ href, label }: { href: string; label: string }) => (
  <Link
    href={href}
    className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
  >
    <ArrowLeftIcon className="size-4" aria-hidden /> {label}
  </Link>
);

export function ModelPage() {
  const orgId = useOrgId();
  const { modelId } = useParams<{ modelId: string }>();
  const model = useModel(orgId, modelId);
  const projectId = model.data?.project.id ?? '';
  const runs = useRuns(orgId, projectId);
  const models = useModels(orgId, projectId);
  const [registerOpen, setRegisterOpen] = useState(false);

  if (model.isPending) return <TableSkeleton rows={4} />;
  if (model.isError) return <ErrorState error={model.error} onRetry={() => void model.refetch()} />;
  const m = model.data;

  return (
    <div className="grid gap-6">
      <BackLink href={`/orgs/${orgId}/projects/${m.project.id}`} label={m.project.name} />
      <PageHeader
        title={m.name}
        description={
          <span>
            MLflow registry name <code className="font-mono text-xs">{m.mlflowName}</code>
          </span>
        }
        actions={
          <PermissionGate orgId={orgId} permission="model:register">
            <Button onClick={() => setRegisterOpen(true)} disabled={!runs.data}>
              <PlusIcon aria-hidden /> Register version
            </Button>
          </PermissionGate>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>Versions</CardTitle>
          <CardDescription>Immutable. Each points at one MLflow run’s ONNX bundle.</CardDescription>
        </CardHeader>
        <CardContent>
          {m.versions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No versions yet. Register a finished run from this project.
            </p>
          ) : (
            <Table>
              <THead>
                <Tr>
                  <Th>Version</Th>
                  <Th>Status</Th>
                  <Th className="hidden md:table-cell">Framework</Th>
                  <Th>ROC-AUC</Th>
                  <Th className="hidden lg:table-cell">Run</Th>
                  <Th className="hidden sm:table-cell">Registered</Th>
                </Tr>
              </THead>
              <TBody>
                {m.versions.map((v) => (
                  <Tr key={v.id}>
                    <Td>
                      <Link
                        href={`/orgs/${orgId}/model-versions/${v.id}`}
                        className="font-mono font-medium underline-offset-4 hover:underline"
                      >
                        v{v.version}
                      </Link>
                    </Td>
                    <Td>
                      <VersionStatusBadge status={v.status} />
                    </Td>
                    <Td className="hidden md:table-cell">
                      <FrameworkBadge framework={v.framework} />
                    </Td>
                    <Td className="tabular-nums">
                      {formatMetric('test_roc_auc', v.metrics.test_roc_auc)}
                    </Td>
                    <Td className="hidden font-mono text-xs lg:table-cell">
                      {v.mlflowRunId.slice(0, 8)}
                    </Td>
                    <Td className="hidden text-muted-foreground sm:table-cell">
                      {formatRelative(v.createdAt)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {registerOpen && runs.data && (
        <RegisterDialog
          orgId={orgId}
          projectId={projectId}
          open
          onOpenChange={setRegisterOpen}
          runs={runs.data.data.filter((r) => !r.registeredAs.some((x) => x.modelId === m.id))}
          models={models.data ?? []}
          fixedModelId={m.id}
        />
      )}
    </div>
  );
}

export function ModelVersionPage() {
  const orgId = useOrgId();
  const { versionId } = useParams<{ versionId: string }>();
  const query = useQuery({
    queryKey: qk.modelVersion(orgId, versionId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/model-versions/{versionId}', {
          params: { path: { orgId, versionId } },
        }),
      ),
  });

  if (query.isPending) return <TableSkeleton rows={5} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const v = query.data;
  const input = v.signature.inputs[0];

  return (
    <div className="grid gap-6">
      <BackLink href={`/orgs/${orgId}/models/${v.model.id}`} label={v.model.name} />
      <PageHeader
        title={`${v.model.name} v${String(v.version)}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <VersionStatusBadge status={v.status} />
            <FrameworkBadge framework={v.framework} />
            <span>registered {formatDateTime(v.createdAt)}</span>
          </span>
        }
      />

      {v.status === 'PENDING_VALIDATION' && (
        <Alert>
          <span className="flex items-center gap-2 font-medium">
            <CircleDashedIcon className="size-4" aria-hidden /> Awaiting validation
          </span>
          <span className="text-muted-foreground">
            Before a version can be deployed, the platform checks its ONNX graph, operators,
            signature, checksum and golden examples. That validator arrives in Milestone 4.
          </span>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Metrics at registration</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4">
              {HEADLINE_METRICS.filter((k) => v.metrics[k] !== undefined).map((k) => (
                <div key={k} className="grid gap-1">
                  <dt className="text-xs text-muted-foreground">{metricLabel(k)}</dt>
                  <dd className="text-xl font-semibold tabular-nums">
                    {formatMetric(k, v.metrics[k])}
                  </dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Lineage</CardTitle>
            <CardDescription>Where this version came from.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <div className="flex gap-3">
              <FlaskConicalIcon
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <div className="grid gap-0.5">
                <span className="font-medium">MLflow run</span>
                <span className="font-mono text-xs break-all">{v.mlflowRunId}</span>
                <span className="text-xs text-muted-foreground">
                  Registry mirror:{' '}
                  {v.mlflowVersion ? `MLflow version ${v.mlflowVersion}` : 'pending'}
                </span>
              </div>
            </div>
            <div className="flex gap-3">
              <DatabaseIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="grid gap-0.5">
                <span className="font-medium">Training dataset</span>
                {v.trainingDataset ? (
                  <>
                    <span>
                      {v.trainingDataset.name} ·{' '}
                      <span className="font-mono">{v.trainingDataset.version}</span>
                      {v.trainingDataset.rowCount !== null &&
                        ` · ${v.trainingDataset.rowCount.toLocaleString()} rows`}
                    </span>
                    <span className="font-mono text-xs break-all text-muted-foreground">
                      sha256 {v.trainingDataset.sha256}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">Not recorded by the run</span>
                )}
              </div>
            </div>
            <div className="grid gap-0.5">
              <span className="font-medium">Bundle</span>
              <span className="font-mono text-xs break-all">{v.sourceUri}</span>
              {v.reportedSha256 && (
                <span className="font-mono text-xs break-all text-muted-foreground">
                  reported sha256 {v.reportedSha256} (verified in M4)
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Signature</CardTitle>
          <CardDescription>
            The input contract. Requests to a deployed endpoint are validated against it.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          {input && (
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">Input</span>
                <code className="font-mono text-xs">{input.name}</code>
                <Badge variant="outline">{input.dtype}</Badge>
                <Badge variant="outline">
                  [{input.shape.map((d) => (d === -1 ? 'batch' : d)).join(', ')}]
                </Badge>
              </div>
              {input.features && (
                <Table>
                  <THead>
                    <Tr>
                      <Th className="w-16">#</Th>
                      <Th>Feature</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {input.features.map((f, i) => (
                      <Tr key={f}>
                        <Td className="text-muted-foreground tabular-nums">{i}</Td>
                        <Td className="font-mono text-xs">{f}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              )}
            </div>
          )}
          <div className="grid gap-2 text-sm">
            <span className="font-medium">Outputs</span>
            <ul className="grid gap-1">
              {v.signature.outputs.map((o) => (
                <li key={o.name} className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-xs">{o.name}</code>
                  <Badge variant="outline">{o.dtype}</Badge>
                  <Badge variant="outline">
                    [{o.shape.map((d) => (d === -1 ? 'batch' : d)).join(', ')}]
                  </Badge>
                  {o.classes && (
                    <span className="text-xs text-muted-foreground">
                      classes {o.classes.join(', ')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
