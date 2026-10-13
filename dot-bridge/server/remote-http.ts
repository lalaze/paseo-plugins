import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
export const REMOTE_PATH = '/dot/remote/v1';
export const REMOTE_MAX_BYTES = 8 * 1024 * 1024;
export function remoteUrl(raw: string, privateHttp: boolean): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Use a center origin without credentials, path, query or fragment');
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  const parts = host.split('.').map(Number);
  const privateV4 = isIP(host) === 4 && (parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127));
  const privateHost = privateV4 || host === 'localhost' || host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || host.endsWith('.ts.net');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateHttp && privateHost)) throw new Error('HTTPS is required; HTTP needs explicit trusted-private-network approval');
  return url.origin;
}
export async function readRemoteBody(request: IncomingMessage): Promise<unknown> {
  const timer = setTimeout(() => request.destroy(new Error('Request timeout')), 15000); timer.unref();
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > REMOTE_MAX_BYTES) throw new Error('Request too large'); chunks.push(bytes); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { clearTimeout(timer); }
}
export async function remoteCall(base: string, token: string, action: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 25000); timer.unref();
  try {
    const body = JSON.stringify({ action, input });
    if (Buffer.byteLength(body) > REMOTE_MAX_BYTES) throw new Error('Remote request too large');
    const response = await fetch(base + REMOTE_PATH, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body, redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Center rejected the device credential or scope' : 'Center request failed (' + response.status + ')');
    const reader = response.body?.getReader(); if (!reader) throw new Error('Missing center response');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > REMOTE_MAX_BYTES) throw new Error('Center response too large'); chunks.push(chunk.value); } }
    finally { await reader.cancel().catch(() => undefined); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || result.ok !== true) throw new Error(typeof result?.error === 'string' ? result.error : 'Invalid center response');
    return result.value;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
