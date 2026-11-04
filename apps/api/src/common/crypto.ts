import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe random token with `bytes` bytes of entropy (default 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 digest as bytes, the form stored for session and invitation tokens. */
export function sha256Bytes(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash('sha256').update(value).digest());
}

export function hmacBase64Url(key: string, value: string): string {
  return createHmac('sha256', key).update(value).digest('base64url');
}

/** Constant-time string comparison (avoids leaking how many leading characters matched). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
