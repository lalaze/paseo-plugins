import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';

/**
 * Expands any IPv6 spelling into its eight 16-bit groups, so `::1`, `0:0:0:0:0:0:0:1`,
 * `::ffff:7f00:1` and `0:0:0:0:0:ffff:7f00:1` all compare equal. Returns null when the text is
 * not a valid address.
 */
function ipv6Groups(address: string): number[] | null {
  const percent = address.indexOf('%');
  let value = (percent >= 0 ? address.slice(0, percent) : address).toLowerCase();
  if (value.includes('.')) {
    // A trailing dotted-quad carries the low 32 bits.
    const colon = value.lastIndexOf(':');
    const octets = value.slice(colon + 1).split('.').map(Number);
    if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    value = `${value.slice(0, colon + 1)}${(((octets[0] << 8) | octets[1]) >>> 0).toString(16)}:${(((octets[2] << 8) | octets[3]) >>> 0).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const parse = (text: string): number[] | null => {
    if (text === '') return [];
    const out: number[] = [];
    for (const group of text.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parse(halves[1]);
  if (!tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function isPrivateIpv6(groups: number[]): boolean {
  const [a, b, c, d] = groups;
  if (groups.every(group => group === 0)) return true; // ::
  if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible (::a.b.c.d) forms.
  if (groups.slice(0, 5).every(group => group === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    return isPrivateAddress(`${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`);
  }
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (a === 0x2001 && b === 0x0db8) return true; // 2001:db8::/32 documentation
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return true; // 100::/64 discard-only
  if (a === 0x2001 && b === 0x0000) return true; // 2001::/32 Teredo
  if (a === 0x2002) return true; // 2002::/16 6to4
  return false;
}

/** Loopback, link-local, private, documentation, multicast and reserved ranges are refused. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 0 && c === 0) return true;
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  if (version === 6) {
    const groups = ipv6Groups(address);
    if (!groups) return true;
    return isPrivateIpv6(groups);
  }
  return true;
}

export type Lookup = (hostname: string) => Promise<string[]>;

const defaultLookup: Lookup = async hostname => {
  const records = await dnsLookup(hostname, { all: true });
  return records.map(record => record.address);
};

/** Callback resolution is bounded, so a hung resolver cannot stall startup, subscribe or delivery. */
export const DNS_TIMEOUT_MS = 10_000;

/**
 * Resolves a hostname with a hard deadline and the caller's lifecycle signal. `dns.lookup` has no
 * cancellation, so the promise is raced against the deadline instead of awaiting it forever: the
 * caller (recover, subscribe, delivery) is unblocked even when the resolver never answers.
 */
async function lookupBounded(lookup: Lookup, host: string, signal?: AbortSignal): Promise<string[]> {
  const timeout = withTimeout(signal, DNS_TIMEOUT_MS);
  try {
    return await new Promise<string[]>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(new Error('dns-aborted'));
      };
      if (timeout.signal.aborted) {
        onAbort();
        return;
      }
      timeout.signal.addEventListener('abort', onAbort, { once: true });
      lookup(host).then(
        addresses => {
          if (settled) return;
          settled = true;
          timeout.signal.removeEventListener('abort', onAbort);
          resolve(addresses);
        },
        error => {
          if (settled) return;
          settled = true;
          timeout.signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  } finally {
    timeout.clear();
  }
}

export interface CallbackCheck {
  ok: boolean;
  reason?: string;
  /** The validated address the caller must connect to, preserving the hostname for TLS. */
  address?: string;
}

/** Clash/Mihomo maps domains to the reserved 198.18.0.0/15 range before forwarding through TUN. */
function isProxyFakeIp(address: string): boolean {
  return isIP(address) === 4 && (address.startsWith('198.18.') || address.startsWith('198.19.'));
}

/**
 * A callback must be HTTPS and every resolved address must be public, except Clash fake IPs for
 * the exact OpenAI connectors host on the standard HTTPS port without URL credentials. TLS still
 * verifies that hostname, and subscription verification still requires a signed challenge echo.
 * This runs at subscribe time and again before each delivery, so a name that later points at a
 * disallowed address is refused. The
 * returned address is pinned into the connection so DNS cannot re-resolve to a private host between
 * the check and the request (TOCTOU). Resolution is bounded by `DNS_TIMEOUT_MS` and honours the
 * lifecycle `signal`, so unload is never blocked on a stuck resolver.
 */
export async function checkCallbackUrl(url: string, lookup: Lookup = defaultLookup, signal?: AbortSignal): Promise<CallbackCheck> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'not-https' };
  const host = parsed.hostname;
  if (isIP(host)) return isPrivateAddress(host) ? { ok: false, reason: 'private-address' } : { ok: true, address: host };
  let addresses: string[];
  try {
    addresses = await lookupBounded(lookup, host, signal);
  } catch {
    return { ok: false, reason: 'dns-failed' };
  }
  if (!addresses.length) return { ok: false, reason: 'dns-empty' };
  const allowFakeIp = host === 'connectors.api.openai.com' && !parsed.port && !parsed.username && !parsed.password;
  if (addresses.some(address => isPrivateAddress(address) && !(allowFakeIp && isProxyFakeIp(address)))) {
    return { ok: false, reason: 'private-address' };
  }
  return { ok: true, address: addresses[0] };
}

export interface PostResult {
  status: number;
  retryAfterSeconds: number | null;
  /** The response body, bounded so a hostile endpoint cannot exhaust memory. */
  text: string;
  error: string | null;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const POST_TIMEOUT_MS = 10_000;
const RESPONSE_BODY_LIMIT = 64 * 1024;

/** Parses Retry-After as either delta-seconds or an HTTP-date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

/** Combines the caller's signal with a hard timeout without relying on DOM-only AbortSignal statics. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

async function readResponse(response: Response): Promise<PostResult> {
  const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
  let text = '';
  try {
    const raw = await response.text();
    text = raw.length > RESPONSE_BODY_LIMIT ? raw.slice(0, RESPONSE_BODY_LIMIT) : raw;
  } catch {
    text = '';
  }
  return { status: response.status, retryAfterSeconds, text, error: null };
}

/**
 * The production transport. It connects to the validated `address` while keeping the URL hostname
 * for SNI and the Host header, and refuses to follow redirects.
 */
function httpsPost(url: string, body: string, headers: Record<string, string>, address: string | undefined, signal: AbortSignal): Promise<PostResult> {
  return new Promise<PostResult>(resolve => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ status: 0, retryAfterSeconds: null, text: '', error: 'invalid-url' });
      return;
    }
    const options: RequestOptions = {
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      servername: parsed.hostname,
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      signal,
    };
    if (address) {
      // Pin the connection to the address that passed the callback-address policy.
      (options as { lookup?: unknown }).lookup = (hostname: string, opts: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        const family = isIP(address);
        if (opts && opts.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      };
    }
    const request = httpsRequest(options, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= RESPONSE_BODY_LIMIT) chunks.push(chunk);
      });
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          retryAfterSeconds: parseRetryAfter(response.headers['retry-after'] ?? null),
          text: Buffer.concat(chunks).toString('utf8'),
          error: null,
        });
      });
    });
    request.on('error', error => {
      resolve({ status: 0, retryAfterSeconds: null, text: '', error: error instanceof Error ? error.message : String(error) });
    });
    request.end(body);
  });
}

/**
 * One POST with redirects disabled and a bounded timeout, so a hung endpoint cannot stall the
 * plugin. `fetchImpl` is a test hook; production uses a pinned HTTPS request to `address`.
 */
export async function postSigned(
  url: string,
  body: string,
  headers: Record<string, string>,
  fetchImpl?: FetchLike,
  signal?: AbortSignal,
  address?: string,
): Promise<PostResult> {
  const timeout = withTimeout(signal, POST_TIMEOUT_MS);
  try {
    if (fetchImpl) {
      const response = await fetchImpl(url, { method: 'POST', headers, body, redirect: 'error', signal: timeout.signal });
      return await readResponse(response);
    }
    return await httpsPost(url, body, headers, address, timeout.signal);
  } catch (error) {
    return { status: 0, retryAfterSeconds: null, text: '', error: error instanceof Error ? error.message : String(error) };
  } finally {
    timeout.clear();
  }
}
