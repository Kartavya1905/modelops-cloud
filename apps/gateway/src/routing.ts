import type { RoutedEndpoint, RoutingSnapshot } from './contract.js';

export interface SnapshotSource {
  load(): Promise<RoutingSnapshot | null>;
}

/**
 * In-memory routing table. Replaced wholesale from the snapshot (never patched), so a lost or
 * reordered invalidation message can't leave it half-updated. If Redis is unreachable the last
 * good table keeps serving (docs/02 §6 "Redis restarts").
 */
export class RoutingTable {
  private snapshot: RoutingSnapshot | null = null;
  loadedAt = 0;

  constructor(private readonly source: SnapshotSource) {}

  get hash(): string | null {
    return this.snapshot?.hash ?? null;
  }

  get ready(): boolean {
    return this.snapshot !== null;
  }

  async refresh(): Promise<boolean> {
    const next = await this.source.load();
    if (!next) return false;
    const changed = next.hash !== this.snapshot?.hash;
    this.snapshot = next;
    this.loadedAt = Date.now();
    return changed;
  }

  lookup(projectId: string, slug: string): RoutedEndpoint | undefined {
    return this.snapshot?.endpoints[`${projectId}/${slug}`];
  }

  /** For the internal playground route, which knows the endpoint id rather than the slug. */
  lookupById(endpointId: string): RoutedEndpoint | undefined {
    if (!this.snapshot) return undefined;
    return Object.values(this.snapshot.endpoints).find((e) => e.endpointId === endpointId);
  }
}
