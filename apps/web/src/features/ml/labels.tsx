import type { ModelVersionSummary } from '@modelops/api-contract';
import { CheckCircle2Icon, CircleDashedIcon, LoaderIcon, XCircleIcon } from 'lucide-react';
import { Badge } from '@/components/ui/primitives';

const FRAMEWORK_LABEL: Record<string, string> = {
  SKLEARN_ONNX: 'scikit-learn → ONNX',
  PYTORCH_ONNX: 'PyTorch → ONNX',
};

export function FrameworkBadge({ framework }: { framework: string | null }) {
  if (!framework) return <span className="text-muted-foreground">—</span>;
  return <Badge variant="secondary">{FRAMEWORK_LABEL[framework] ?? framework}</Badge>;
}

const STATUS = {
  PENDING_VALIDATION: { label: 'Awaiting validation', variant: 'warning', Icon: CircleDashedIcon },
  VALIDATING: { label: 'Validating', variant: 'secondary', Icon: LoaderIcon },
  VALIDATED: { label: 'Validated', variant: 'success', Icon: CheckCircle2Icon },
  REJECTED: { label: 'Rejected', variant: 'destructive', Icon: XCircleIcon },
} as const;

/** Status is conveyed by text and icon, never by colour alone (docs/01 NFR-10). */
export function VersionStatusBadge({ status }: { status: ModelVersionSummary['status'] }) {
  const s = STATUS[status];
  return (
    <Badge variant={s.variant}>
      <s.Icon className="size-3" aria-hidden />
      {s.label}
    </Badge>
  );
}

/** Metrics shown first, in this order, wherever runs or versions are summarized. */
export const HEADLINE_METRICS = [
  'test_roc_auc',
  'test_accuracy',
  'test_f1',
  'test_log_loss',
] as const;

const METRIC_LABEL: Record<string, string> = {
  test_roc_auc: 'ROC-AUC',
  test_accuracy: 'Accuracy',
  test_f1: 'F1',
  test_log_loss: 'Log loss',
  parity_max_abs_diff: 'ONNX parity |Δp|',
  train_seconds: 'Train time (s)',
  train_loss: 'Train loss',
  val_loss: 'Validation loss',
};

export const metricLabel = (key: string) => METRIC_LABEL[key] ?? key;

/** For these metrics lower is better (used to highlight the best run). */
export const LOWER_IS_BETTER = new Set([
  'test_log_loss',
  'parity_max_abs_diff',
  'train_seconds',
  'train_loss',
  'val_loss',
]);

export function formatMetric(key: string, value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—';
  if (key === 'parity_max_abs_diff') return value === 0 ? '0' : value.toExponential(1);
  if (key === 'train_seconds') return value.toFixed(2);
  return value.toFixed(4);
}
