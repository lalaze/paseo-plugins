import { catalogServerSchema, type CatalogServer } from '../shared/gateway';
import { mcpConfigSchema, nameSchema, type McpConfig } from '../shared/rpc';
import { RESERVED_SERVERS } from './mcp';

/**
 * The other half of multi-machine sharing: this host holds a center URL and a device token,
 * asks the center for the servers that credential may use, and hands them to new agents as
 * ordinary HTTP MCP servers. The token stays here; the center's upstream authorization never
 * reaches this machine.
 */

type Fetch = typeof fetch;

/** React Native's globals shadow Node's in this project's types; Node 22 has `AbortSignal.timeout`. */
function deadline(ms: number): AbortSignal {
  return (AbortSignal as unknown as { timeout(ms: number): AbortSignal }).timeout(ms);
}

/**
 * Accepts only a plain origin: no user name, password, query, fragment or path. The gateway
 * serves the catalog and `/mcp/...` at its root, so a path would silently mis-join, and a device
 * token in the URL would leak through logs and the address bar. This matches `validatePublicUrl`.
 */
export function normalizeGatewayUrl(raw: string): string {
  const text = raw.trim();
  if (!text) throw new Error('Enter the center gateway URL.');
  let url: URL;
  try { url = new URL(text); }
  catch { throw new Error('That is not a valid URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The URL must start with http:// or https://.');
  if (url.username || url.password) throw new Error('Remove the user name and password from the URL.');
  if (url.hash) throw new Error('Remove the "#fragment" from the URL.');
  if (url.search) throw new Error('Remove the query string from the URL; the device token is entered separately.');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Enter the center origin only, without a path.');
  return url.origin;
}

/**
 * True for the addresses only this machine can reach. The WHATWG parser keeps the brackets on an
 * IPv6 `hostname` (`[::1]`), preserves a trailing dot on a name (`localhost.`), and canonicalizes
 * every other IPv4 spelling (`127.1`, `2130706433`, `0177.0.0.1`) to dotted-decimal, so after
 * stripping those it is enough to test the `localhost` name, `::1`, the whole 127/8 block, and the
 * IPv4-mapped `::ffff:127.0.0.0/8` that a dual-stack host also routes to loopback.
 */
export function isLoopbackGatewayUrl(base: string): boolean {
  let hostname: string;
  try { hostname = new URL(base).hostname; } catch { return false; }
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').replace(/\.+$/, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  return mapped !== null && (Number.parseInt(mapped[1]!, 16) >> 8) === 127;
}

/** The only path a gateway may expose for a server: `/mcp/<encoded name>`. */
export function gatewayServerPath(name: string): string {
  return `/mcp/${encodeURIComponent(name)}`;
}

function usableServerName(name: string): boolean {
  return nameSchema.safeParse(name).success && !RESERVED_SERVERS.has(name);
}

/** The request header a device uses to name the provider it is acting as. */
export const PROVIDER_HEADER = 'X-Paseo-Provider';

/**
 * Reads the catalog the center allows this credential for `expectedProvider`. It names the provider
 * in `X-Paseo-Provider`, verifies the center's `provider` matches, refuses redirects, and rebuilds
 * every server path itself rather than trusting the center. Errors are fixed descriptions, never
 * raw fetch errors.
 */
export async function fetchCatalog(baseUrl: string, token: string, expectedProvider: string, fetcher: Fetch = fetch, timeoutMs = 10_000): Promise<CatalogServer[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/servers`;
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', [PROVIDER_HEADER]: expectedProvider },
      redirect: 'manual',
      signal: deadline(timeoutMs),
    });
  } catch {
    throw new Error('Could not reach the center gateway.');
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('The center tried to redirect; the request was refused.');
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('The center rejected this device credential; it may have been revoked or the provider changed.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`The center answered ${response.status}.`);
  }
  const body = await response.json().catch(() => null) as { provider?: unknown; servers?: unknown } | null;
  if (!body || typeof body.provider !== 'string' || !Array.isArray(body.servers)) throw new Error('The center did not return a usable server catalog.');
  if (body.provider !== expectedProvider) throw new Error('This device credential is for a different provider than the one selected.');
  const catalog: CatalogServer[] = [];
  for (const item of body.servers) {
    const parsed = catalogServerSchema.safeParse(item);
    if (!parsed.success || !usableServerName(parsed.data.name)) continue;
    const path = gatewayServerPath(parsed.data.name);
    // Never trust a returned path; the gateway serves exactly this one.
    if (parsed.data.path !== path) continue;
    catalog.push({ name: parsed.data.name, path });
  }
  return catalog;
}

/** The MCP servers a remote connection adds to a new agent: the center's endpoints with this device's token. */
export function remoteMcpConfigs(baseUrl: string, token: string, catalog: readonly CatalogServer[], provider?: string): Record<string, McpConfig> {
  const base = baseUrl.replace(/\/+$/, '');
  const configs: Record<string, McpConfig> = {};
  for (const server of catalog) {
    if (!usableServerName(server.name)) continue;
    // The provider header names the provider the gateway must act as; the device token stays the credential.
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(provider ? { [PROVIDER_HEADER]: provider } : {}) };
    configs[server.name] = mcpConfigSchema.parse({ type: 'http', url: `${base}${gatewayServerPath(server.name)}`, headers });
  }
  return configs;
}
