import type { RoutedEndpoint, RoutedRevision } from './contract.js';

/** 32-bit FNV-1a over the UTF-8 bytes: fast, stable across processes and languages. */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(text, 'utf8')) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 0-99. The same key always lands in the same bucket, on every gateway (docs/05 §6). */
export const bucketOf = (key: string) => fnv1a32(key) % 100;

export type TrafficRole = 'stable' | 'canary';

/**
 * Which revision serves this request: the canary when `bucket < weight`, else stable. With an
 * `X-Routing-Key` (e.g. a customer id) the choice is sticky, so one customer sees one model for
 * the whole canary; without one, the request id spreads requests evenly.
 */
export function pickRevision(
  endpoint: RoutedEndpoint,
  key: string,
): { revision: RoutedRevision; role: TrafficRole } | null {
  const stable = endpoint.revision;
  if (!stable) return null;
  const canary = endpoint.canary;
  if (canary && canary.weight > 0 && bucketOf(key) < canary.weight) {
    return { revision: canary.revision, role: 'canary' };
  }
  return { revision: stable, role: 'stable' };
}
