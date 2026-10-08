import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { credentialLabels, credentialProviders, savedCredentials, type CredentialProvider, type SavedCredential } from './credentials';
import { hasAuthHeader } from '../shared/form';
import type { McpConfig } from '../shared/rpc';

/**
 * MCP authorization (OAuth 2.1 with PKCE, protected resource metadata, dynamic client
 * registration), run by the daemon so every provider gets the same token as a header.
 * The browser step happens wherever the app runs: the redirect to localhost is caught here
 * when the daemon is on this machine or the port is forwarded, and pasted back otherwise.
 */

export const CALLBACK_PORT = 47821;
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const TIMEOUT_MS = 15_000;
const FLOW_TTL_MS = 15 * 60_000;
/** Refreshed this long before the access token runs out, so a new agent does not start with a dying one. */
const REFRESH_EARLY_MS = 5 * 60_000;

type Fetch = typeof fetch;

/** React Native's globals shadow Node's in this project's types; Node 22 has `AbortSignal.timeout`. */
function deadline(): AbortSignal {
  return (AbortSignal as unknown as { timeout(ms: number): AbortSignal }).timeout(TIMEOUT_MS);
}

export interface AuthServer {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

export interface Discovery {
  /** The canonical MCP URL, sent as the RFC 8707 `resource`. Null for servers that predate resource metadata. */
  resource: string | null;
  server: AuthServer;
  scope: string | null;
}

export interface Client { client_id: string; client_secret?: string; auth: 'none' | 'client_secret_post' | 'client_secret_basic' }

export interface Tokens { access_token: string; refresh_token?: string; expires_at?: number; scope?: string }

/** One server's sign-in as kept in oauth.json. `url` ties it to the URL it was granted for. */
export interface Grant { url: string; issuer: string; token_endpoint: string; resource: string | null; client: Client; tokens: Tokens }

export interface AuthStatus { status: 'signed-in' | 'expired'; expiresAt: string | null; scope: string | null; source: string | null }
interface Source { url: string; provider: CredentialProvider; id: string }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getJson(fetcher: Fetch, url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetcher(url, { headers: { Accept: 'application/json', 'MCP-Protocol-Version': '2025-06-18' }, signal: deadline() });
    if (!response.ok) { await response.body?.cancel(); return null; }
    return record(await response.json());
  } catch {
    return null;
  }
}

/** `Bearer realm="x", resource_metadata="https://…", scope="a b"` → its parameters. */
export function bearerParams(header: string | null): Record<string, string> {
  const params: Record<string, string> = {};
  if (!header) return params;
  for (const match of header.matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    params[match[1]!.toLowerCase()] = (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1');
  }
  return params;
}

/** Well-known URLs per RFC 8414 / 9728: the suffix goes between the origin and the path. */
function wellKnown(base: string, suffix: string): string[] {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, '');
  return path ? [`${url.origin}/.well-known/${suffix}${path}`, `${url.origin}/.well-known/${suffix}`] : [`${url.origin}/.well-known/${suffix}`];
}

function authServerUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  if (!path) return [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
  return [`${url.origin}/.well-known/oauth-authorization-server${path}`, `${url.origin}/.well-known/openid-configuration${path}`, `${url.origin}${path}/.well-known/openid-configuration`];
}

/** Asks the server without credentials; a 401 names its resource metadata and sometimes the scope it wants. */
async function probe(fetcher: Fetch, config: Extract<McpConfig, { type: 'http' | 'sse' }>): Promise<{ status: number; challenge: Record<string, string> }> {
  const init: RequestInit = config.type === 'sse'
    ? { method: 'GET', headers: { ...config.headers, Accept: 'text/event-stream' } }
    : {
      method: 'POST',
      headers: { ...config.headers, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'paseo-shared-tools', version: '0.1.0' } } }),
    };
  const response = await fetcher(config.url, { ...init, signal: deadline() });
  // An SSE stream would never end; only the status and headers matter.
  await response.body?.cancel().catch(() => undefined);
  return { status: response.status, challenge: bearerParams(response.headers.get('www-authenticate')) };
}

export async function discover(config: Extract<McpConfig, { type: 'http' | 'sse' }>, fetcher: Fetch = fetch): Promise<Discovery> {
  const { status, challenge } = await probe(fetcher, config).catch((error: unknown) => {
    throw new Error(`Could not reach ${config.url}: ${message(error)}`);
  });
  let metadata: Record<string, unknown> | null = null;
  for (const url of challenge.resource_metadata ? [challenge.resource_metadata] : wellKnown(config.url, 'oauth-protected-resource')) {
    metadata = await getJson(fetcher, url);
    if (metadata) break;
  }
  if (status !== 401 && status !== 403 && !metadata) throw new Error('This server does not ask for sign-in.');
  const issuers = Array.isArray(metadata?.authorization_servers) ? metadata.authorization_servers.filter((item): item is string => typeof item === 'string') : [];
  const origin = new URL(config.url).origin;
  let server: AuthServer | null = null;
  for (const issuer of issuers.length ? issuers : [origin]) {
    for (const url of authServerUrls(issuer)) {
      const found = await getJson(fetcher, url);
      if (typeof found?.authorization_endpoint === 'string' && typeof found.token_endpoint === 'string') {
        server = { ...found, issuer: typeof found.issuer === 'string' ? found.issuer : issuer } as AuthServer;
        break;
      }
    }
    if (server) break;
  }
  // Servers from before authorization metadata existed serve the endpoints at fixed paths.
  if (!server && !issuers.length) server = { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` };
  if (!server) throw new Error(`No authorization server metadata at ${issuers.join(', ')}.`);
  const methods = server.code_challenge_methods_supported;
  if (Array.isArray(methods) && methods.length && !methods.includes('S256')) throw new Error('The authorization server does not support PKCE (S256).');
  const scopes = Array.isArray(metadata?.scopes_supported) ? metadata.scopes_supported.filter((item): item is string => typeof item === 'string') : [];
  const resource = typeof metadata?.resource === 'string' ? metadata.resource : metadata ? config.url : null;
  return { resource, server, scope: challenge.scope ?? (scopes.length ? scopes.join(' ') : null) };
}

export async function register(server: AuthServer, fetcher: Fetch = fetch): Promise<Client> {
  if (!server.registration_endpoint) throw new Error(`${server.issuer} does not let apps register themselves, so the plugin cannot sign in; add an Authorization header with a token instead.`);
  const response = await fetcher(server.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Paseo shared tools', redirect_uris: [REDIRECT_URI], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none',
    }),
    signal: deadline(),
  });
  const body = record(await response.json().catch(() => null));
  if (!response.ok || typeof body?.client_id !== 'string') throw new Error(`Client registration failed (${response.status})${typeof body?.error_description === 'string' ? `: ${body.error_description}` : ''}.`);
  const secret = typeof body.client_secret === 'string' ? body.client_secret : undefined;
  const method = body.token_endpoint_auth_method;
  const auth = method === 'client_secret_basic' || method === 'client_secret_post' ? method : secret ? 'client_secret_post' : 'none';
  return { client_id: body.client_id, ...(secret ? { client_secret: secret } : {}), auth };
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export function authorizationUrl(discovery: Discovery, client: Client, state: string, challenge: string): string {
  const url = new URL(discovery.server.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.client_id);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (discovery.scope) url.searchParams.set('scope', discovery.scope);
  if (discovery.resource) url.searchParams.set('resource', discovery.resource);
  return url.toString();
}

async function tokenRequest(endpoint: string, client: Client, params: Record<string, string>, fetcher: Fetch): Promise<Tokens> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (client.auth === 'client_secret_basic' && client.client_secret) {
    headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64')}`;
  } else {
    body.set('client_id', client.client_id);
    if (client.auth === 'client_secret_post' && client.client_secret) body.set('client_secret', client.client_secret);
  }
  const response = await fetcher(endpoint, { method: 'POST', headers, body: body.toString(), signal: deadline() });
  const data = record(await response.json().catch(() => null));
  if (!response.ok || typeof data?.access_token !== 'string') {
    const reason = typeof data?.error_description === 'string' ? data.error_description : typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`;
    throw new Error(`The token request failed: ${reason}.`);
  }
  const expiresIn = Number(data.expires_in);
  return {
    access_token: data.access_token,
    ...(typeof data.refresh_token === 'string' ? { refresh_token: data.refresh_token } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expires_at: Date.now() + expiresIn * 1000 } : {}),
    ...(typeof data.scope === 'string' ? { scope: data.scope } : {}),
  };
}

export function exchangeCode(grant: Omit<Grant, 'tokens'>, code: string, verifier: string, fetcher: Fetch = fetch): Promise<Tokens> {
  return tokenRequest(grant.token_endpoint, grant.client, {
    grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier, ...(grant.resource ? { resource: grant.resource } : {}),
  }, fetcher);
}

export async function refreshTokens(grant: Grant, fetcher: Fetch = fetch): Promise<Tokens> {
  if (!grant.tokens.refresh_token) throw new Error('No refresh token.');
  const next = await tokenRequest(grant.token_endpoint, grant.client, {
    grant_type: 'refresh_token', refresh_token: grant.tokens.refresh_token, ...(grant.resource ? { resource: grant.resource } : {}),
  }, fetcher);
  // A server that does not rotate refresh tokens leaves the old one valid.
  return { ...next, refresh_token: next.refresh_token ?? grant.tokens.refresh_token };
}

/** Reads `code` and `state` from the address the browser ended on, or takes a bare code. */
export function parseCallback(text: string): { code: string; state: string | null } {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Paste the address your browser ended on.');
  if (!/[?&#]/.test(trimmed) && !/^https?:/i.test(trimmed)) return { code: trimmed, state: null };
  let params: URLSearchParams;
  try { params = new URL(trimmed, 'http://localhost').searchParams; }
  catch { throw new Error('That is not the address the browser ended on.'); }
  const error = params.get('error');
  if (error) throw new Error(`Sign-in was refused: ${params.get('error_description') ?? error}.`);
  const code = params.get('code');
  if (!code) throw new Error('That address has no "code"; paste the full address the browser ended on after you approved.');
  return { code, state: params.get('state') };
}

interface Flow { name: string; url: string; grant: Omit<Grant, 'tokens'>; verifier: string; created: number; result: 'pending' | 'done' | string }

export type FlowStatus = { status: 'pending' | 'done' | 'none' } | { status: 'failed'; error: string };

const PAGE = (title: string, text: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>`
  + `<body style="font:15px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem"><h2>${title}</h2><p>${text}</p></body>`;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);
}

/** oauth.json plus the sign-ins waiting for their browser step. */
export class SignIns {
  private readonly path: string;
  private grants: Record<string, Grant> | null = null;
  private sources: Record<string, Source> = {};
  private borrowed = new Map<string, SavedCredential>();
  private readonly flows = new Map<string, Flow>();
  private readonly refreshing = new Map<string, Promise<Grant | null>>();
  private writes: Promise<unknown> = Promise.resolve();
  private listeners: Server[] = [];
  private listening = false;
  private opening: Promise<void> | null = null;

  constructor(readonly root: string, private readonly log: (error: unknown) => void = () => undefined, private readonly fetcher: Fetch = fetch, private readonly listen = true, private readonly home = homedir()) {
    this.path = join(root, 'oauth.json');
  }

  async load(): Promise<Record<string, Grant>> {
    if (this.grants) return this.grants;
    const text = await readFile(this.path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    let parsed: Record<string, unknown> | null = null;
    if (text !== null) {
      try { parsed = record(JSON.parse(text)); }
      catch { this.log(new Error(`${this.path} is not valid JSON; sign in again.`)); }
    }
    this.grants ??= (record(parsed?.servers) ?? {}) as Record<string, Grant>;
    for (const [name, value] of Object.entries(record(parsed?.sources) ?? {})) {
      const source = record(value);
      if (typeof source?.url === 'string' && typeof source.id === 'string' && credentialProviders.includes(source.provider as CredentialProvider)) {
        this.sources[name] = { url: source.url, provider: source.provider as CredentialProvider, id: source.id };
      }
    }
    return this.grants;
  }

  /** Re-read linked caches so native refreshes and sign-outs are visible on this page. */
  async readSources(): Promise<void> {
    await this.load();
    for (const [name, source] of Object.entries(this.sources)) {
      const latest = (await savedCredentials(this.home, source.url, source.provider)).find(item => item.id === source.id);
      if (latest) this.borrowed.set(name, latest);
      else this.borrowed.delete(name);
    }
  }

  /** Find an existing MCP authorization before attempting dynamic registration. */
  async reuse(name: string, config: McpConfig, only?: CredentialProvider): Promise<string | null> {
    if (config.type === 'stdio' || hasAuthHeader(config)) return null;
    await this.load();
    const candidates = await savedCredentials(this.home, config.url, only);
    for (const candidate of candidates) {
      if (candidate.tokens.expires_at !== undefined && candidate.tokens.expires_at <= Date.now()) continue;
      // Verify a revoked credential before telling the user it can be reused.
      const result = await probe(this.fetcher, { ...config, headers: { ...config.headers, Authorization: `Bearer ${candidate.tokens.access_token}` } }).catch(() => null);
      if (!result || result.status < 200 || result.status >= 300) continue;
      this.sources[name] = { url: config.url, provider: candidate.provider, id: candidate.id };
      this.borrowed.set(name, candidate);
      await this.save();
      return credentialLabels[candidate.provider];
    }
    if (candidates.length) {
      const labels = [...new Set(candidates.map(item => credentialLabels[item.provider]))].join(', ');
      throw new Error(`Found an MCP authorization in ${labels}, but it is expired or could not be verified. Sign in to this MCP server in that client, then try again. / 找到了 ${labels} 的 MCP 授权，但已过期或验证失败。请先在该客户端重新授权此 MCP，再重试。`);
    }
    return null;
  }

  private save(): Promise<void> {
    const job = async () => {
      await mkdir(this.root, { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, servers: this.grants ?? {}, sources: this.sources }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
    };
    const run = this.writes.then(job, job);
    this.writes = run.catch(() => undefined);
    return run;
  }

  /** What the screen shows per server; a grant for another URL no longer counts. */
  statuses(servers: Record<string, McpConfig>): Record<string, AuthStatus> {
    const out: Record<string, AuthStatus> = {};
    for (const [name, grant] of Object.entries(this.grants ?? {})) {
      const config = servers[name];
      if (!config || config.type === 'stdio' || config.url !== grant.url) continue;
      const expired = grant.tokens.expires_at !== undefined && grant.tokens.expires_at <= Date.now() && !grant.tokens.refresh_token;
      out[name] = {
        status: expired ? 'expired' : 'signed-in',
        expiresAt: grant.tokens.expires_at && !grant.tokens.refresh_token ? new Date(grant.tokens.expires_at).toISOString() : null,
        scope: grant.tokens.scope ?? null,
        source: null,
      };
    }
    for (const [name, source] of Object.entries(this.sources)) {
      const config = servers[name];
      if (!config || config.type === 'stdio' || config.url !== source.url) continue;
      const tokens = this.borrowed.get(name)?.tokens;
      out[name] = {
        status: !tokens || (tokens.expires_at !== undefined && tokens.expires_at <= Date.now()) ? 'expired' : 'signed-in',
        expiresAt: tokens?.expires_at !== undefined ? new Date(tokens.expires_at).toISOString() : null,
        scope: tokens?.scope ?? null,
        source: credentialLabels[source.provider],
      };
    }
    return out;
  }

  async start(name: string, config: McpConfig): Promise<{ authorizationUrl: string; redirectUri: string; listening: boolean }> {
    if (config.type === 'stdio') throw new Error('Only http and sse servers sign in.');
    const discovery = await discover(config, this.fetcher);
    const grants = await this.load();
    const previous = grants[name];
    // A client registered earlier with the same authorization server is reused rather than piling up registrations.
    const client = previous && previous.issuer === discovery.server.issuer ? previous.client : await register(discovery.server, this.fetcher);
    const { verifier, challenge } = pkce();
    const state = base64url(randomBytes(16));
    for (const [key, flow] of this.flows) if (flow.name === name || Date.now() - flow.created > FLOW_TTL_MS) this.flows.delete(key);
    this.flows.set(state, {
      name, url: config.url, verifier, created: Date.now(), result: 'pending',
      grant: { url: config.url, issuer: discovery.server.issuer, token_endpoint: discovery.server.token_endpoint, resource: discovery.resource, client },
    });
    await this.openListener();
    return { authorizationUrl: authorizationUrl(discovery, client, state, challenge), redirectUri: REDIRECT_URI, listening: this.listening };
  }

  /** Finishes the flow a pasted address belongs to; a bare code goes to the server's only pending flow. */
  async finish(name: string, text: string): Promise<void> {
    const { code, state } = parseCallback(text);
    const entry = state !== null
      ? [...this.flows].find(([key]) => key === state)
      : [...this.flows].find(([, flow]) => flow.name === name && flow.result === 'pending');
    if (!entry) throw new Error(state !== null ? 'That address belongs to an older sign-in; start again.' : 'Start the sign-in first.');
    if (entry[1].name !== name) throw new Error(`That address is for "${entry[1].name}".`);
    await this.complete(entry[0], entry[1], code);
  }

  private async complete(state: string, flow: Flow, code: string): Promise<void> {
    if (flow.result === 'done') return;
    try {
      const tokens = await exchangeCode(flow.grant, code, flow.verifier, this.fetcher);
      const grants = await this.load();
      grants[flow.name] = { ...flow.grant, tokens };
      delete this.sources[flow.name];
      this.borrowed.delete(flow.name);
      await this.save();
      flow.result = 'done';
    } catch (error) {
      flow.result = message(error);
      throw error;
    } finally {
      if (![...this.flows.values()].some(other => other.result === 'pending')) this.closeListener();
      // Kept briefly so the screen's poll sees how it ended.
      setTimeout(() => { if (this.flows.get(state) === flow) this.flows.delete(state); }, 60_000).unref?.();
    }
  }

  status(name: string): FlowStatus {
    const flows = [...this.flows.values()].filter(flow => flow.name === name);
    const flow = flows.at(-1);
    if (!flow) return { status: 'none' };
    if (flow.result === 'pending' || flow.result === 'done') return { status: flow.result };
    return { status: 'failed', error: flow.result };
  }

  cancel(name: string): void {
    for (const [key, flow] of this.flows) if (flow.name === name) this.flows.delete(key);
    if (![...this.flows.values()].some(flow => flow.result === 'pending')) this.closeListener();
  }

  async signOut(name: string): Promise<void> {
    this.cancel(name);
    const grants = await this.load();
    if (!(name in grants) && !(name in this.sources)) return;
    delete grants[name];
    delete this.sources[name];
    this.borrowed.delete(name);
    await this.save();
  }

  async rename(from: string, to: string): Promise<void> {
    const grants = await this.load();
    if (from === to || (!(from in grants) && !(from in this.sources))) return;
    if (from in grants) { grants[to] = grants[from]!; delete grants[from]; }
    if (from in this.sources) {
      this.sources[to] = this.sources[from]!;
      delete this.sources[from];
      const cached = this.borrowed.get(from);
      if (cached) this.borrowed.set(to, cached);
      this.borrowed.delete(from);
    }
    await this.save();
  }

  /** The header for a new agent, refreshing first when the token is about to run out. Null when there is nothing usable. */
  async header(name: string, config: McpConfig): Promise<string | null> {
    if (config.type === 'stdio' || hasAuthHeader(config)) return null;
    await this.load();
    const source = this.sources[name];
    if (source) {
      if (source.url !== config.url) return null;
      const latest = (await savedCredentials(this.home, source.url, source.provider)).find(item => item.id === source.id);
      if (latest) this.borrowed.set(name, latest);
      else this.borrowed.delete(name);
      if (!latest || (latest.tokens.expires_at !== undefined && latest.tokens.expires_at <= Date.now())) return null;
      return `Bearer ${latest.tokens.access_token}`;
    }
    let grant = (await this.load())[name];
    if (!grant || grant.url !== config.url) return null;
    const expires = grant.tokens.expires_at;
    if (expires !== undefined && expires - REFRESH_EARLY_MS <= Date.now() && grant.tokens.refresh_token) {
      grant = await this.refresh(name, grant) ?? grant;
    }
    if (grant.tokens.expires_at !== undefined && grant.tokens.expires_at <= Date.now()) return null;
    return `Bearer ${grant.tokens.access_token}`;
  }

  /** One refresh per server at a time: a rotated refresh token works only once. */
  private refresh(name: string, grant: Grant): Promise<Grant | null> {
    const running = this.refreshing.get(name);
    if (running) return running;
    const job = (async () => {
      try {
        const tokens = await refreshTokens(grant, this.fetcher);
        const grants = await this.load();
        if (grants[name] !== grant) return grants[name] ?? null;
        const next = { ...grant, tokens };
        grants[name] = next;
        await this.save();
        return next;
      } catch (error) {
        this.log(new Error(`Refreshing the sign-in for MCP server "${name}" failed: ${message(error)}`));
        return null;
      } finally {
        this.refreshing.delete(name);
      }
    })();
    this.refreshing.set(name, job);
    return job;
  }

  /** Catches the redirect on this host's loopback; a port already in use just means pasting. */
  private openListener(): Promise<void> {
    if (!this.listen || this.listening) return Promise.resolve();
    this.opening ??= this.bind().finally(() => { this.opening = null; });
    return this.opening;
  }

  private async bind(): Promise<void> {
    const handler = (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => {
      const url = new URL(request.url ?? '/', REDIRECT_URI);
      const state = url.searchParams.get('state');
      const flow = state ? this.flows.get(state) : undefined;
      const reply = (status: number, title: string, text: string) => {
        response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(PAGE(title, escapeHtml(text)));
      };
      if (url.pathname !== '/callback' || !flow || !state) { reply(404, 'Not found', 'This sign-in is not pending any more.'); return; }
      let code: string;
      try { code = parseCallback(url.toString()).code; }
      catch (error) { flow.result = message(error); reply(400, 'Sign-in failed', message(error)); return; }
      this.complete(state, flow, code).then(
        () => reply(200, 'Signed in', `${flow.name} is signed in. You can close this tab and go back to Paseo.`),
        (error: unknown) => reply(400, 'Sign-in failed', message(error)),
      );
    };
    const hosts = ['127.0.0.1', '::1'];
    const opened = await Promise.all(hosts.map(host => new Promise<Server | null>(resolve => {
      const server = createServer(handler);
      server.once('error', () => resolve(null));
      server.listen(CALLBACK_PORT, host, () => resolve(server));
    })));
    this.listeners = opened.filter((server): server is Server => server !== null);
    this.listening = this.listeners.length > 0;
  }

  private closeListener(): void {
    for (const server of this.listeners) server.close();
    this.listeners = [];
    this.listening = false;
  }

  stop(): void {
    this.flows.clear();
    this.closeListener();
  }
}
