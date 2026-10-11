import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Standard Webhooks signing. The same body that is signed is the body that is sent, so the
 * receiver's HMAC covers exactly the bytes it validates. Secrets use the `whsec_` prefix.
 */
export interface WebhookHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

export function generateSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

function keyBytes(secret: string): Buffer {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  return Buffer.from(raw, 'base64');
}

function signedContent(id: string, timestamp: string, payload: string): string {
  return `${id}.${timestamp}.${payload}`;
}

export function signPayload(secret: string, id: string, timestamp: string, payload: string): string {
  const digest = createHmac('sha256', keyBytes(secret)).update(signedContent(id, timestamp, payload)).digest('base64');
  return `v1,${digest}`;
}

/** During a key rotation window, sign with both the new and the previous secret. */
export function signPayloadMulti(secrets: string[], id: string, timestamp: string, payload: string): string {
  return secrets.filter(Boolean).map(secret => signPayload(secret, id, timestamp, payload)).join(' ');
}

export function webhookHeaders(secret: string, id: string, timestamp: string, payload: string): WebhookHeaders {
  return { id, timestamp, signature: signPayload(secret, id, timestamp, payload) };
}

/**
 * Verifies a received signature. Accepts a `webhook-signature` header that may carry several
 * space-separated `v1,<sig>` entries, and rejects timestamps outside the tolerance window.
 */
export function verifyPayload(secret: string, headers: WebhookHeaders, payload: string, now: number, toleranceSeconds = 300): boolean {
  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(now - timestamp) > toleranceSeconds) return false;
  const expected = signPayload(secret, headers.id, headers.timestamp, payload);
  const expectedBytes = Buffer.from(expected);
  for (const entry of headers.signature.split(' ')) {
    const candidate = Buffer.from(entry.trim());
    if (candidate.length === expectedBytes.length && timingSafeEqual(candidate, expectedBytes)) return true;
  }
  return false;
}
