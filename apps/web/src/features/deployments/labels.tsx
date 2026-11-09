import type { RevisionState } from '@modelops/api-contract';
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleSlashIcon,
  HourglassIcon,
  LoaderIcon,
  TriangleAlertIcon,
  XCircleIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/primitives';

const STATE = {
  REQUESTED: { label: 'Requested', variant: 'secondary', Icon: CircleDashedIcon },
  AWAITING_APPROVAL: { label: 'Awaiting approval', variant: 'warning', Icon: HourglassIcon },
  QUEUED: { label: 'Queued', variant: 'secondary', Icon: CircleDashedIcon },
  PROVISIONING: { label: 'Provisioning', variant: 'secondary', Icon: LoaderIcon },
  LOADING: { label: 'Loading model', variant: 'secondary', Icon: LoaderIcon },
  VERIFYING: { label: 'Verifying', variant: 'secondary', Icon: LoaderIcon },
  READY: { label: 'Ready', variant: 'success', Icon: CheckCircle2Icon },
  DEGRADED: { label: 'Degraded', variant: 'warning', Icon: TriangleAlertIcon },
  DRAINING: { label: 'Draining', variant: 'outline', Icon: HourglassIcon },
  RETIRED: { label: 'Retired', variant: 'outline', Icon: CircleSlashIcon },
  FAILED: { label: 'Failed', variant: 'destructive', Icon: XCircleIcon },
  CANCELLED: { label: 'Cancelled', variant: 'outline', Icon: CircleSlashIcon },
} as const satisfies Record<RevisionState, unknown>;

export const stateLabel = (s: RevisionState) => STATE[s].label;

/** Text + icon, never colour alone (docs/01 NFR-10). */
export function RevisionStateBadge({ state }: { state: RevisionState }) {
  const s = STATE[state];
  const spinning = s.Icon === LoaderIcon;
  return (
    <Badge variant={s.variant}>
      <s.Icon className={spinning ? 'size-3 motion-safe:animate-spin' : 'size-3'} aria-hidden />
      {s.label}
    </Badge>
  );
}

/** The happy path, in order, for the timeline stepper. */
export const PIPELINE: readonly RevisionState[] = [
  'REQUESTED',
  'QUEUED',
  'PROVISIONING',
  'LOADING',
  'VERIFYING',
  'READY',
];

export const PIPELINE_HELP: Partial<Record<RevisionState, string>> = {
  REQUESTED: 'Saved durably with the request (outbox)',
  QUEUED: 'Handed to the deployment worker',
  PROVISIONING: 'Starting an isolated container',
  LOADING: 'Downloading the artifact and verifying its SHA-256',
  VERIFYING: 'Replaying the golden examples',
  READY: 'Serving traffic',
};
