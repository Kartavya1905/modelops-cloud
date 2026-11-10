'use client';

import { DatabaseIcon, UploadIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ErrorState, PermissionGate, TableSkeleton } from '@/components/common/states';
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
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@/components/ui/primitives';
import { ApiError } from '@/lib/api/client';
import { formatRelative } from '@/lib/utils';
import { useDatasets, useUploadDataset } from './api';

function UploadDatasetDialog({
  orgId,
  projectId,
  onClose,
}: {
  orgId: string;
  projectId: string;
  onClose: () => void;
}) {
  const upload = useUploadDataset(orgId, projectId);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const error = upload.error instanceof ApiError ? upload.error : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload a dataset</DialogTitle>
          <DialogDescription>
            A CSV with a header row: a held-out set for evaluations (with the label column), or the
            data a bundle was trained on (reference for drift). Stored by its SHA-256.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <span>{error.problem.detail ?? error.problem.title}</span>
          </Alert>
        )}
        <div className="grid gap-4">
          <Field id="ds-name" label="Name">
            <Input
              id="ds-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="churn-holdout"
            />
          </Field>
          <Field id="ds-version" label="Version">
            <Input
              id="ds-version"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="seed11-n2000"
            />
          </Field>
          <Field id="ds-file" label="CSV file">
            <Input
              id="ds-file"
              type="file"
              accept=".csv,text/csv"
              className="h-auto py-1.5"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button
            disabled={!file || name.trim().length < 2 || !version.trim() || upload.isPending}
            onClick={() =>
              file &&
              upload.mutate(
                { file, name: name.trim(), version: version.trim() },
                {
                  onSuccess: (d) => {
                    toast.success(`Dataset ${d.name} ${d.version} stored`);
                    onClose();
                  },
                },
              )
            }
          >
            <UploadIcon aria-hidden /> {upload.isPending ? 'Uploading…' : 'Upload'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Dataset versions of a project (M3 lineage; M7 stores the bytes for drift and evaluations). */
export function DatasetsSection({ orgId, projectId }: { orgId: string; projectId: string }) {
  const datasets = useDatasets(orgId, projectId);
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <CardTitle>Datasets</CardTitle>
          <CardDescription>
            Training data (lineage, drift reference) and held-out sets.
          </CardDescription>
        </div>
        <PermissionGate orgId={orgId} permission="dataset:create">
          <Button variant="outline" onClick={() => setOpen(true)}>
            <UploadIcon aria-hidden /> Upload dataset
          </Button>
        </PermissionGate>
      </CardHeader>
      <CardContent>
        {datasets.isPending ? (
          <TableSkeleton rows={2} />
        ) : datasets.isError ? (
          <ErrorState error={datasets.error} />
        ) : datasets.data.length === 0 ? (
          <div className="flex items-center gap-3 rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
            <DatabaseIcon className="size-5" aria-hidden />
            No datasets yet. Training runs record theirs; upload held-out sets here.
          </div>
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>Dataset</Th>
                <Th className="hidden sm:table-cell">Rows</Th>
                <Th>Data</Th>
                <Th className="hidden md:table-cell">SHA-256</Th>
                <Th className="hidden sm:table-cell">Added</Th>
              </Tr>
            </THead>
            <TBody>
              {datasets.data.map((d) => (
                <Tr key={d.id}>
                  <Td>
                    <span className="font-medium">{d.name}</span>{' '}
                    <span className="font-mono text-xs text-muted-foreground">{d.version}</span>
                  </Td>
                  <Td className="hidden tabular-nums sm:table-cell">
                    {d.rowCount?.toLocaleString() ?? '—'}
                  </Td>
                  <Td>
                    {d.stored ? (
                      <Badge variant="success">Stored</Badge>
                    ) : (
                      <Badge variant="outline">Lineage only</Badge>
                    )}
                  </Td>
                  <Td className="hidden font-mono text-xs md:table-cell">
                    {d.sha256.slice(0, 12)}…
                  </Td>
                  <Td className="hidden text-muted-foreground sm:table-cell">
                    {formatRelative(d.createdAt)}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
      {open && (
        <UploadDatasetDialog orgId={orgId} projectId={projectId} onClose={() => setOpen(false)} />
      )}
    </Card>
  );
}
