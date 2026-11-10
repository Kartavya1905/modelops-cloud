/**
 * Prediction and feedback events (M7). The gateway appends them to one Redis Stream; the
 * platform worker consumes it in batches (prediction records, captured inputs for drift, ground
 * truth). One stream for both kinds keeps order: a client can only send feedback for a prediction
 * it already received, so the prediction event is always ahead of its feedback.
 *
 * Fire-and-forget: recording never slows down or fails a prediction (docs/02 §3). A dropped event
 * is counted in `gateway_events_dropped_total`.
 */
import type { RoutedEndpoint, RoutedRevision } from './contract.js';
import type { FieldError } from './guards.js';

export type StreamEvent = Record<string, string>;

export interface EventSink {
  publish(events: StreamEvent[]): Promise<void>;
}

export interface Output {
  label: unknown;
  probabilities: Record<string, number | null>;
}

/** One event per returned row. Inputs only when the endpoint opted in to capture (FR-37). */
export function predictionEvents(
  endpoint: RoutedEndpoint,
  rev: RoutedRevision,
  ids: string[],
  outputs: Output[],
  rows: number[][],
  now: number,
): StreamEvent[] {
  const positive = String(rev.classes[rev.classes.length - 1] ?? 1);
  return outputs.map((o, i) => ({
    type: 'prediction',
    id: ids[i] ?? '',
    org: endpoint.orgId,
    endpoint: endpoint.endpointId,
    revision: rev.id,
    modelVersion: rev.modelVersionId,
    label: String(o.label),
    score: String(o.probabilities[positive] ?? 0),
    ts: String(now),
    ...(endpoint.captureInputs ? { inputs: JSON.stringify(rows[i] ?? []) } : {}),
  }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_FEEDBACK_ITEMS = 1000;

/** `{ items: [{ predictionId, label }] }`, labels must be one of the model's classes. */
export function parseFeedback(
  body: unknown,
  classes: readonly (string | number)[],
): { items: { predictionId: string; label: string }[] } | { errors: FieldError[] } {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_FEEDBACK_ITEMS) {
    return {
      errors: [{ field: 'items', message: `must be 1-${String(MAX_FEEDBACK_ITEMS)} items` }],
    };
  }
  const allowed = new Set(classes.map(String));
  const errors: FieldError[] = [];
  const out: { predictionId: string; label: string }[] = [];
  items.forEach((item: unknown, i) => {
    const it = item as { predictionId?: unknown; label?: unknown } | null;
    if (typeof it?.predictionId !== 'string' || !UUID.test(it.predictionId)) {
      errors.push({
        field: `items[${String(i)}].predictionId`,
        message: 'must be a prediction id',
      });
      return;
    }
    const label =
      typeof it.label === 'number' || typeof it.label === 'string' ? String(it.label) : '';
    if (!allowed.has(label)) {
      errors.push({
        field: `items[${String(i)}].label`,
        message: `must be one of ${[...allowed].join(', ')}`,
      });
      return;
    }
    out.push({ predictionId: it.predictionId, label });
  });
  return errors.length ? { errors: errors.slice(0, 20) } : { items: out };
}

export function feedbackEvents(
  endpoint: RoutedEndpoint,
  items: { predictionId: string; label: string }[],
  now: number,
): StreamEvent[] {
  return items.map((it) => ({
    type: 'feedback',
    id: it.predictionId,
    // The worker only applies a label to a prediction of this endpoint (no cross-tenant labels).
    endpoint: endpoint.endpointId,
    label: it.label,
    ts: String(now),
  }));
}
