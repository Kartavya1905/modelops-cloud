import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ApiKeyEntry } from './contract.js';

/** `mo_<10-char prefix>_<43-char base64url secret>` (apps/api/src/modules/api-keys). */
const KEY = /^mo_([A-Z2-9]{10})_([A-Za-z0-9_-]{43})$/;

export interface KeyStore {
  getEntry(prefix: string): Promise<ApiKeyEntry | null>;
}

export interface VerifiedKey {
  id: string;
  prefix: string;
  orgId: string;
  projectId: string;
  scopes: string[];
}

interface Cached {
  entry: ApiKeyEntry | null;
  at: number;
}

/**
 * API-key verification on the hot path (ADR-0006): parse, look up the prefix (cached), compare
 * HMAC-SHA256(pepper, secret) in constant time. The cache is bounded in time (keyCacheMs) and
 * evicted immediately on a revocation message, so a revoked key stops working within seconds,
 * and within keyCacheMs even if the message is lost.
 */
export class KeyVerifier {
  private readonly cache = new Map<string, Cached>();

  constructor(
    private readonly store: KeyStore,
    private readonly pepper: string,
    private readonly cacheMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  evict(prefix: string): void {
    this.cache.delete(prefix);
  }

  async verify(authorization: string | undefined): Promise<VerifiedKey | null> {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : undefined;
    const m = token ? KEY.exec(token) : null;
    if (!m) return null;
    const [, prefix = '', secret = ''] = m;

    let cached = this.cache.get(prefix);
    // Unknown prefixes are cached briefly too, so random keys can't hammer Redis.
    const ttl = cached?.entry ? this.cacheMs : Math.min(this.cacheMs, 5_000);
    if (!cached || this.now() - cached.at > ttl) {
      cached = { entry: await this.store.getEntry(prefix), at: this.now() };
      if (this.cache.size > 10_000) this.cache.clear(); // bounded memory
      this.cache.set(prefix, cached);
    }
    const e = cached.entry;
    if (!e || e.revoked) return null;
    if (e.expiresAt && Date.parse(e.expiresAt) <= this.now()) return null;
    const expected = Buffer.from(e.hash, 'hex');
    const actual = createHmac('sha256', this.pepper).update(secret).digest();
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return { id: e.id, prefix, orgId: e.orgId, projectId: e.projectId, scopes: e.scopes };
  }
}
