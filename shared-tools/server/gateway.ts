import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { allowsProvider } from '../shared/access';
import {
  DEFAULT_GATEWAY_HOST, DEFAULT_GATEWAY_PORT, catalogServerSchema, defaultPublicUrl, gatewayConfigSchema, remoteStatuses,
  type CatalogServer, type Device, type GatewayConfig, type GatewayState, type Remote, type RemoteStatus,
} from '../shared/gateway';
import { nameSchema, type McpConfig } from '../shared/rpc';
import { stripStored, type StoredServer } from './mcp';
import { fetchCatalog, gatewayServerPath, isLoopbackGatewayUrl, normalizeGatewayUrl, remoteMcpConfigs } from './remote';

/**
 * The center of multi-machine sharing: one authenticated HTTP MCP gateway that other machines
 * reach with a revocable device credential. The gateway reads the center's own MCP authorization
 * per request and never hands it out; a device token is never forwarded upstream.
 *
 * Everything here lives in its own `gateway.json`, apart from `config.json` and `oauth.json`, so
 * a hand-edited server config and this file can never race.
 */

/** Request bodies larger than this are refused immediately. */
const MAX_BODY = 8 * 1024 * 1024;
/** In-flight upstream requests allowed at once; a slot is reserved before any await. */
export const MAX_ACTIVE_REQUESTS = 64;
const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 1_000;
const SWEEP_MS = 60_000;

export interface GatewayOptions {
  catalogTimeoutMs: number;
  agentRefreshTimeoutMs: number;
  bodyTimeoutMs: number;
  /** How long to wait for the upstream to start answering. */
  upstreamHeadersTimeoutMs: number;
  /** How long an established upstream stream may stay silent before it is cut. */
  upstreamIdleTimeoutMs: number;
  /** How often hand-edited server config is re-checked against live requests. */
  reconcileMs: number;
}

const DEFAULT_OPTIONS: GatewayOptions = {
  catalogTimeoutMs: 10_000,
  agentRefreshTimeoutMs: 2_000,
  bodyTimeoutMs: 15_000,
  upstreamHeadersTimeoutMs: 30_000,
  upstreamIdleTimeoutMs: 120_000,
  reconcileMs: 20_000,
};

/** A stored device row. Validated whole on load: a damaged row is skipped, never widened. */
const storedDeviceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  providers: z.array(z.string().min(1)).min(1),
  servers: z.array(z.string()).nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  tokenHash: z.string().min(1),
});
type StoredDevice = z.infer<typeof storedDeviceSchema>;

/** A stored remote connection. A damaged row is skipped so a broken cache cannot be injected. */
const storedRemoteSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  url: z.string().min(1),
  token: z.string().min(1),
  provider: z.string().min(1),
  createdAt: z.string(),
  checkedAt: z.string().nullable(),
  status: z.enum(remoteStatuses),
  error: z.string().nullable(),
  catalog: z.array(catalogServerSchema),
});
type StoredRemote = z.infer<typeof storedRemoteSchema>;

interface StoredGateway {
  version: 1;
  config: GatewayConfig;
  devices: Record<string, StoredDevice>;
  remotes: Record<string, StoredRemote>;
}

/** One client-facing MCP session, mapped to a device, a server, a provider and the upstream's own session id. */
interface Session {
  id: string;
  deviceId: string;
  server: string;
  provider: string;
  upstreamId: string;
  /** Static identity of the upstream target; never the dynamic OAuth token. */
  fingerprint: string;
  created: number;
  lastUsed: number;
}

interface Active {
  controller: AbortController;
  deviceId: string;
  server: string;
  provider: string;
  fingerprint: string;
  response: ServerResponse;
}

export interface GatewayDeps {
  /** Every valid shared server, as stored, for permissions and forwarding. */
  servers(): Promise<Record<string, StoredServer>>;
  /** Whether the provider's MCP master switch is on. */
  providerMcpOn(provider: string): Promise<boolean>;
  /** The upstream Authorization header for a server, refreshing first when it is about to expire. */
  authHeader(name: string, config: McpConfig): Promise<string | null>;
}

type HttpConfig = Extract<McpConfig, { type: 'http' }>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' && value.length ? value : null;
}

/**
 * The provider list from the multi-select field, or the legacy single field. Duplicates are
 * dropped and an empty selection is refused, so a blank form can never widen or blank a scope.
 */
function resolveProviders(input: { provider?: string; providers?: string[] }): string[] {
  const raw = input.providers ?? (input.provider !== undefined ? [input.provider] : []);
  const providers = [...new Set(raw.map(value => value.trim()).filter(value => value.length > 0))];
  if (!providers.length) throw new Error('Choose at least one provider.');
  return providers;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

function newId(): string {
  return randomBytes(9).toString('base64url');
}

/** A stable serialization, so a config's identity does not depend on key order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The static identity of an upstream target: URL, static headers and the rest, but never a dynamic token. */
export function configFingerprint(config: McpConfig): string {
  return stableStringify(config);
}

/** A public gateway address: an origin, no user name, password, query, fragment or path. */
export function validatePublicUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('The address other machines use is not a valid URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The shared address must start with http:// or https://.');
  if (url.username || url.password) throw new Error('The shared address must not contain a user name or password.');
  if (url.hash) throw new Error('The shared address must not contain a "#fragment".');
  if (url.search) throw new Error('The shared address must not contain a query string.');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Enter the shared address origin only, without a path.');
  return url.origin;
}

/** A bind address: a host name or IP, never a scheme or path. */
export function validateHost(value: string): string {
  const host = value.trim();
  if (!host) throw new Error('Enter the address the gateway binds, such as 0.0.0.0 or 127.0.0.1.');
  if (host.includes('://') || /[\s/\\@]/.test(host)) throw new Error('The bind address must be a host name or IP, without a scheme or path.');
  return host;
}

function defaultConfig(): GatewayConfig {
  return { enabled: false, host: DEFAULT_GATEWAY_HOST, port: DEFAULT_GATEWAY_PORT, publicUrl: defaultPublicUrl(DEFAULT_GATEWAY_PORT) };
}

/** Addresses this gateway actually answers on, used only for the Origin check. */
function internalUrls(config: GatewayConfig): string[] {
  const urls: string[] = [];
  const host = config.host;
  if (host === '0.0.0.0' || host === '::' || host === '') urls.push(`http://127.0.0.1:${config.port}`);
  else urls.push(`http://${host.includes(':') ? `[${host}]` : host}:${config.port}`);
  const shared = config.publicUrl || defaultPublicUrl(config.port);
  if (!urls.includes(shared)) urls.push(shared);
  return urls;
}

/**
 * The addresses shown to the user. Only the configured shared address is published; loopback is
 * never handed out, and a loopback configuration falls back to the private-network default.
 */
function publicUrls(config: GatewayConfig): string[] {
  const shared = (config.publicUrl || defaultPublicUrl(config.port)).replace(/\/+$/, '');
  if (isLoopbackGatewayUrl(shared)) return [defaultPublicUrl(config.port)];
  return [shared];
}

function addressNote(config: GatewayConfig): string | null {
  const shared = config.publicUrl || defaultPublicUrl(config.port);
  if (isLoopbackGatewayUrl(shared)) return `The configured address is loopback-only; other machines cannot reach it. Set the address to this host's private-network address, for example ${defaultPublicUrl(config.port)}.`;
  return null;
}

function publicDevice(device: StoredDevice): Device {
  const { tokenHash: _tokenHash, ...rest } = device;
  return rest;
}

function publicRemote(remote: StoredRemote): Remote {
  const { token: _token, ...rest } = remote;
  return rest;
}

/** Resolves once the response can accept another chunk, or once the client is gone. */
function waitDrain(res: ServerResponse): Promise<void> {
  return new Promise(resolve => {
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.on('drain', done);
    res.on('close', done);
  });
}

type BodyRead = { kind: 'ok'; body: Buffer } | { kind: 'too-large' } | { kind: 'aborted' } | { kind: 'timeout' };

/**
 * Reads a request body up to `limit`. Oversize resolves at once (the caller answers 413), a client
 * that disconnects mid-body or an abort resolves `aborted`, and a stalled upload resolves `timeout`.
 */
function readBody(req: IncomingMessage, limit: number, timeoutMs: number, signal: AbortSignal): Promise<BodyRead> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: BodyRead) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    timer.unref?.();
    const onAbort = () => finish({ kind: 'aborted' });
    if (signal.aborted) { finish({ kind: 'aborted' }); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) { finish({ kind: 'too-large' }); return; }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ kind: 'ok', body: Buffer.concat(chunks) }));
    req.on('error', () => finish({ kind: 'aborted' }));
    req.on('close', () => { if (!req.complete) finish({ kind: 'aborted' }); });
  });
}

/** True when the body is a JSON-RPC `initialize` request, the only call that may open a session. */
function isInitializeRequest(body: Buffer | undefined): boolean {
  if (!body || !body.length) return false;
  try {
    const parsed = record(JSON.parse(body.toString('utf8')));
    return parsed?.method === 'initialize';
  } catch { return false; }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.writableEnded || res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function unauthorized(res: ServerResponse): void {
  if (res.headersSent) return;
  res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'WWW-Authenticate': 'Bearer' });
  res.end(JSON.stringify({ error: 'A valid device credential is required.' }));
}

export class Gateway {
  readonly path: string;
  private readonly options: GatewayOptions;
  private data: StoredGateway | null = null;
  private loadNotes: string[] = [];
  private server: Server | null = null;
  private runningSince: string | null = null;
  private error: string | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly sessions = new Map<string, Session>();
  private readonly active = new Set<Active>();
  private readonly sockets = new Set<Socket>();
  private stopped = false;

  constructor(
    readonly root: string,
    private readonly deps: GatewayDeps,
    private readonly log: (error: unknown) => void = () => undefined,
    private readonly fetcher: typeof fetch = fetch,
    options: Partial<GatewayOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.path = join(root, 'gateway.json');
  }

  /** Every read-modify-write runs one at a time. */
  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<StoredGateway> {
    if (this.data) return this.data;
    const text = await readFile(this.path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    let parsed: Record<string, unknown> | null = null;
    if (text !== null) {
      try { parsed = record(JSON.parse(text)); }
      catch { this.loadNotes.push(`${this.path} is not valid JSON; gateway settings were reset.`); }
    }
    const config = gatewayConfigSchema.safeParse({ ...defaultConfig(), ...record(parsed?.config) });
    const devices: Record<string, StoredDevice> = {};
    for (const [id, value] of Object.entries(record(parsed?.devices) ?? {})) {
      const raw = record(value) ?? {};
      // A legacy single-provider row migrates only when it has no `providers` field at all; a
      // present-but-empty or malformed `providers` is rejected rather than falling back to widen.
      const candidate = 'providers' in raw ? raw : ('provider' in raw ? { ...raw, providers: [raw.provider] } : raw);
      const row = storedDeviceSchema.safeParse({ ...candidate, id });
      if (!row.success) { this.loadNotes.push(`A stored device credential (${id}) is damaged and is ignored; create a new one.`); continue; }
      devices[id] = { ...row.data, providers: [...new Set(row.data.providers)] };
    }
    const remotes: Record<string, StoredRemote> = {};
    for (const [id, value] of Object.entries(record(parsed?.remotes) ?? {})) {
      const row = storedRemoteSchema.safeParse({ ...(record(value) ?? {}), id });
      if (!row.success) { this.loadNotes.push(`A stored center connection (${id}) is damaged and is ignored.`); continue; }
      let url: string;
      try { url = normalizeGatewayUrl(row.data.url); }
      catch { this.loadNotes.push(`A stored center connection (${id}) has an unusable URL and is ignored.`); continue; }
      const catalog = row.data.catalog.filter(item => nameSchema.safeParse(item.name).success && item.path === gatewayServerPath(item.name));
      remotes[id] = { ...row.data, url, catalog };
    }
    this.data = { version: 1, config: config.success ? config.data : defaultConfig(), devices, remotes };
    return this.data;
  }

  private save(): Promise<void> {
    const job = async () => {
      const data = await this.load();
      await mkdir(this.root, { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      // Device token hashes and remote tokens live here.
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
    };
    const run = this.writes.then(job, job);
    this.writes = run.catch(() => undefined);
    return run;
  }

  /* ---------------------------------------------------------------- state */

  async state(): Promise<GatewayState> {
    const stored = await this.load();
    const servers = await this.deps.servers().catch(() => ({}));
    const shareable = Object.entries(servers)
      .filter(([, server]) => server.enabled !== false && server.type === 'http')
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b));
    const legacy = Object.entries(servers)
      .filter(([, server]) => server.enabled !== false && server.type === 'sse')
      .map(([name]) => name);
    const notes = [...this.loadNotes];
    const address = addressNote(stored.config);
    if (address) notes.push(address);
    if (legacy.length) notes.push(`Not shared across machines (older SSE transport): ${legacy.join(', ')}. Re-add them as http servers to share them.`);
    return {
      dataDir: this.root,
      config: stored.config,
      running: this.server !== null,
      runningSince: this.runningSince,
      error: this.error,
      localUrls: publicUrls(stored.config),
      devices: Object.values(stored.devices).map(publicDevice).sort((a, b) => a.name.localeCompare(b.name)),
      remotes: Object.values(stored.remotes).map(publicRemote).sort((a, b) => a.name.localeCompare(b.name)),
      shareable,
      notes,
    };
  }

  /* ------------------------------------------------------------- config */

  saveConfig(input: GatewayConfig): Promise<GatewayState> {
    return this.exclusive(async () => {
      const stored = await this.load();
      const host = validateHost(input.host);
      const publicUrl = input.publicUrl.trim() ? validatePublicUrl(input.publicUrl) : defaultPublicUrl(input.port);
      const config = gatewayConfigSchema.parse({ ...input, host, publicUrl });
      const moved = config.host !== stored.config.host || config.port !== stored.config.port || config.enabled !== stored.config.enabled;
      stored.config = config;
      await this.save();
      // Restart on a moved endpoint, or to retry a bind that failed before (no listener yet).
      if (moved || (config.enabled && this.server === null)) await this.restart();
      return this.state();
    });
  }

  /* ------------------------------------------------------------ devices */

  createDevice(input: { name: string; provider?: string; providers?: string[]; servers: string[] | null }): Promise<{ state: GatewayState; token: string }> {
    const token = newDeviceToken();
    return this.exclusive(async () => {
      const providers = resolveProviders(input);
      const stored = await this.load();
      const id = newId();
      stored.devices[id] = {
        id, name: input.name, providers, servers: input.servers,
        createdAt: new Date().toISOString(), revokedAt: null, tokenHash: hashToken(token),
      };
      await this.save();
      return { state: await this.state(), token };
    });
  }

  /** Widens or narrows a device's providers, keeping the same token. A narrowed provider is cut at once. */
  updateDeviceProviders(input: { id: string; providers: string[] }): Promise<GatewayState> {
    return this.exclusive(async () => {
      const providers = resolveProviders(input);
      const stored = await this.load();
      const device = stored.devices[input.id];
      if (!device) throw new Error('That device credential no longer exists.');
      const removed = device.providers.filter(provider => !providers.includes(provider));
      device.providers = providers;
      await this.save();
      if (removed.length) this.abortDeviceProviders(input.id, removed);
      return this.state();
    });
  }

  revokeDevice(id: string): Promise<GatewayState> {
    return this.exclusive(async () => {
      const stored = await this.load();
      const device = stored.devices[id];
      if (device && device.revokedAt === null) {
        device.revokedAt = new Date().toISOString();
        await this.save();
        this.abortDevice(id);
      }
      return this.state();
    });
  }

  /**
   * Removes a revoked device credential for good. An unrevoked device is refused here, not just in
   * the UI, so a live credential can never be deleted without first revoking it. Deleting an id that
   * is already gone is a no-op that returns the current state.
   */
  deleteDevice(id: string): Promise<GatewayState> {
    return this.exclusive(async () => {
      const stored = await this.load();
      const device = stored.devices[id];
      if (!device) return this.state();
      if (device.revokedAt === null) throw new Error('Revoke this device before deleting it.');
      delete stored.devices[id];
      await this.save();
      // Defensive: a revoked device should have no live requests or sessions, but end any stragglers.
      this.abortDevice(id);
      return this.state();
    });
  }

  /* ------------------------------------------------------------ remotes */

  connectRemote(input: { name: string; url: string; token: string; provider?: string; providers?: string[] }): Promise<GatewayState> {
    const base = normalizeGatewayUrl(input.url);
    return this.exclusive(async () => {
      const providers = resolveProviders(input);
      const stored = await this.load();
      const now = new Date().toISOString();
      for (const provider of providers) {
        // The same URL, token and provider is one connection: refresh it in place rather than duplicate.
        const existing = Object.values(stored.remotes).find(remote => remote.url === base && remote.token === input.token && remote.provider === provider);
        const id = existing?.id ?? newId();
        let catalog: CatalogServer[] = [];
        let status: RemoteStatus = 'ok';
        let error: string | null = null;
        try { catalog = await fetchCatalog(base, input.token, provider, this.fetcher, this.options.catalogTimeoutMs); }
        catch (cause) { status = 'error'; error = message(cause); }
        stored.remotes[id] = {
          id, name: input.name, url: base, token: input.token, provider,
          createdAt: existing?.createdAt ?? now, checkedAt: now, status, error, catalog,
        };
      }
      await this.save();
      return this.state();
    });
  }

  refreshRemote(id: string): Promise<GatewayState> {
    return this.exclusive(async () => {
      const stored = await this.load();
      const remote = stored.remotes[id];
      if (!remote) throw new Error('That center connection no longer exists.');
      await this.reload(remote, this.options.catalogTimeoutMs);
      await this.save();
      return this.state();
    });
  }

  disconnectRemote(id: string): Promise<GatewayState> {
    return this.exclusive(async () => {
      const stored = await this.load();
      delete stored.remotes[id];
      await this.save();
      return this.state();
    });
  }

  private async reload(remote: StoredRemote, timeoutMs: number): Promise<void> {
    try {
      remote.catalog = await fetchCatalog(remote.url, remote.token, remote.provider, this.fetcher, timeoutMs);
      remote.status = 'ok';
      remote.error = null;
    } catch (cause) {
      remote.status = 'error';
      remote.error = message(cause);
    }
    remote.checkedAt = new Date().toISOString();
  }

  /**
   * Refreshes the catalog for the provider before a new agent is created, so a server added or
   * removed on the center is seen right away. On failure the connection is marked failed and no
   * cached catalog is used.
   */
  async refreshRemotes(provider: string, timeoutMs = this.options.agentRefreshTimeoutMs): Promise<void> {
    await this.exclusive(async () => {
      const stored = await this.load();
      const targets = Object.values(stored.remotes).filter(remote => remote.provider === provider);
      if (!targets.length) return;
      let changed = false;
      for (const remote of targets) {
        const before = JSON.stringify([remote.catalog, remote.status, remote.error]);
        await this.reload(remote, timeoutMs);
        if (JSON.stringify([remote.catalog, remote.status, remote.error]) !== before) changed = true;
      }
      if (changed) await this.save();
    });
  }

  /** The gateway servers this provider's remotes offer, as ordinary HTTP MCP configs. */
  async remoteServers(provider: string): Promise<Record<string, McpConfig>> {
    const stored = await this.load();
    const out: Record<string, McpConfig> = {};
    for (const remote of Object.values(stored.remotes)) {
      if (remote.provider !== provider || remote.status !== 'ok') continue;
      for (const [name, config] of Object.entries(remoteMcpConfigs(remote.url, remote.token, remote.catalog, remote.provider))) {
        if (out[name] === undefined) out[name] = config;
      }
    }
    return out;
  }

  /* ------------------------------------------------------- reconciliation */

  /**
   * Re-checks live requests and sessions against the current servers, permissions and device
   * records, aborting anything that is no longer allowed. Called after a config change and on a
   * light timer, so a hand-edited config also takes effect.
   */
  async reconcile(): Promise<void> {
    const stored = await this.load();
    const servers = await this.deps.servers().catch((): Record<string, StoredServer> => ({}));
    const mcp = new Map<string, boolean>();
    const mcpOn = async (provider: string): Promise<boolean> => {
      if (!mcp.has(provider)) mcp.set(provider, await this.deps.providerMcpOn(provider).catch(() => false));
      return mcp.get(provider)!;
    };
    const allowed = async (deviceId: string, serverName: string, provider: string): Promise<boolean> => {
      const device = stored.devices[deviceId];
      if (!device || device.revokedAt !== null) return false;
      // The provider must still be one the device is authorized for; a narrowed scope cuts it here.
      if (!device.providers.includes(provider)) return false;
      const server = servers[serverName];
      if (!server || !this.mayUse(device, provider, serverName, server)) return false;
      return mcpOn(provider);
    };
    for (const active of [...this.active]) {
      const server = servers[active.server];
      const ok = await allowed(active.deviceId, active.server, active.provider);
      if (!ok || !server || configFingerprint(stripStored(server)) !== active.fingerprint) this.endActive(active);
    }
    for (const [id, session] of [...this.sessions]) {
      const server = servers[session.server];
      const ok = await allowed(session.deviceId, session.server, session.provider);
      if (!ok || !server || configFingerprint(stripStored(server)) !== session.fingerprint) this.sessions.delete(id);
    }
  }

  /* ------------------------------------------------------------- server */

  start(): void {
    void this.exclusive(() => this.apply()).catch(this.log);
  }

  private async apply(): Promise<void> {
    const stored = await this.load();
    if (this.stopped) return;
    if (!stored.config.enabled) { await this.closeServer(); this.error = null; return; }
    if (this.server) return;
    await this.listen(stored.config);
  }

  private listen(config: GatewayConfig): Promise<void> {
    return new Promise<void>(resolve => {
      if (this.stopped) { resolve(); return; }
      const server = createServer((request, response) => { void this.handle(request, response); });
      const fail = (error: unknown) => {
        this.error = message(error);
        this.log(error);
        server.close();
        resolve();
      };
      server.once('error', fail);
      server.on('connection', socket => {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
      });
      server.listen(config.port, config.host, () => {
        server.off('error', fail);
        // A stop or a competing listener may have happened while the bind was in flight.
        if (this.stopped || this.server) { server.close(); resolve(); return; }
        this.server = server;
        this.runningSince = new Date().toISOString();
        this.error = null;
        this.startTimers();
        resolve();
      });
    });
  }

  private startTimers(): void {
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => {
        const now = Date.now();
        for (const [id, session] of this.sessions) if (now - session.lastUsed > SESSION_TTL_MS) this.sessions.delete(id);
      }, SWEEP_MS);
      this.sweepTimer.unref?.();
    }
    if (!this.reconcileTimer) {
      this.reconcileTimer = setInterval(() => { void this.reconcile().catch(this.log); }, this.options.reconcileMs);
      this.reconcileTimer.unref?.();
    }
  }

  /** Aborts every in-flight upstream request and ends its client response. */
  private endActive(active: Active): void {
    active.controller.abort();
    if (!active.response.writableEnded && !active.response.destroyed) active.response.end();
  }

  private abortActive(): void {
    for (const active of this.active) this.endActive(active);
  }

  private abortDevice(id: string): void {
    for (const [sessionId, session] of this.sessions) if (session.deviceId === id) this.sessions.delete(sessionId);
    for (const active of this.active) if (active.deviceId === id) this.endActive(active);
  }

  /**
   * Ends the streams and forgets the sessions of a device that used one of the now-removed
   * providers. The sessions are deleted rather than kept: a kept session would be revived if the
   * provider were authorized again before the next request touched it. Once gone, any later request
   * carrying that id is answered 404 by the unknown-session pre-check in `handle`.
   */
  private abortDeviceProviders(id: string, providers: readonly string[]): void {
    const drop = new Set(providers);
    for (const [sessionId, session] of this.sessions) if (session.deviceId === id && drop.has(session.provider)) this.sessions.delete(sessionId);
    for (const active of this.active) if (active.deviceId === id && drop.has(active.provider)) this.endActive(active);
  }

  /** Stops the listener, ends every live stream and forgets every session; resolves once the port is free. */
  private closeServer(): Promise<void> {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = null; }
    const server = this.server;
    this.server = null;
    this.runningSince = null;
    this.abortActive();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.sessions.clear();
    if (!server) return Promise.resolve();
    return new Promise(resolve => server.close(() => resolve()));
  }

  private async restart(): Promise<void> {
    await this.closeServer();
    await this.apply();
  }

  stop(): void {
    this.stopped = true;
    void this.closeServer().catch(() => undefined);
  }

  /* -------------------------------------------------------------- http */

  /**
   * A non-browser MCP client sends no Origin. A browser must be same-origin with the gateway:
   * scheme, host and port all have to match one of the addresses this gateway answers on.
   */
  private originAllowed(origin: string | undefined, config: GatewayConfig): boolean {
    if (!origin) return true;
    if (origin === 'null') return false;
    let normalized: string;
    try { normalized = new URL(origin).origin; }
    catch { return false; }
    const allowed = new Set<string>();
    for (const url of internalUrls(config)) { try { allowed.add(new URL(url).origin); } catch { /* skip malformed */ } }
    if (config.publicUrl) { try { allowed.add(new URL(config.publicUrl).origin); } catch { /* skip malformed */ } }
    allowed.add(`http://127.0.0.1:${config.port}`);
    allowed.add(`http://localhost:${config.port}`);
    return allowed.has(normalized);
  }

  private async authenticate(request: IncomingMessage): Promise<StoredDevice | null> {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer\s+/i.test(header)) return null;
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;
    const hash = hashToken(token);
    const stored = await this.load();
    for (const device of Object.values(stored.devices)) {
      if (device.revokedAt === null && device.tokenHash === hash) return device;
    }
    return null;
  }

  /**
   * The provider this request acts as, named by `X-Paseo-Provider`. A single-provider credential
   * with no header keeps working; a multi-provider credential must choose, and an unauthorized
   * choice is refused rather than silently downgraded to another provider.
   */
  private selectProvider(request: IncomingMessage, device: StoredDevice): { provider: string } | { status: number; error: string } {
    const requested = headerValue(request.headers['x-paseo-provider']);
    if (!requested) {
      if (device.providers.length === 1) return { provider: device.providers[0]! };
      return { status: 400, error: 'This device is authorized for more than one provider; send the X-Paseo-Provider header.' };
    }
    if (!device.providers.includes(requested)) return { status: 403, error: 'This device is not authorized for that provider.' };
    return { provider: requested };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const stored = await this.load();
      if (!this.originAllowed(request.headers.origin, stored.config)) return json(response, 403, { error: 'Origin not allowed.' });
      const url = new URL(request.url ?? '/', 'http://gateway');
      if (url.pathname === '/v1/servers') {
        if (request.method !== 'GET') return json(response, 405, { error: 'Method not allowed.' });
        const device = await this.authenticate(request);
        if (!device) return unauthorized(response);
        const selected = this.selectProvider(request, device);
        if ('error' in selected) return json(response, selected.status, { error: selected.error });
        return json(response, 200, { provider: selected.provider, servers: await this.catalogFor(device, selected.provider) });
      }
      const match = /^\/mcp\/([^/]+)$/.exec(url.pathname);
      if (match) {
        const method = request.method ?? '';
        if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') return json(response, 405, { error: 'Method not allowed.' });
        const device = await this.authenticate(request);
        if (!device) return unauthorized(response);
        let name: string;
        try { name = decodeURIComponent(match[1]!); } catch { return json(response, 404, { error: 'Unknown server.' }); }
        // A session that is unknown, or belongs to another device or server, is gone. Answer 404
        // before the provider check, so a deleted or foreign session is never mistaken for a fresh
        // request as an unauthorized provider.
        const incoming = headerValue(request.headers['mcp-session-id']);
        if (incoming) {
          const session = this.sessions.get(incoming);
          if (!session || session.deviceId !== device.id || session.server !== name) {
            return json(response, 404, { error: 'That MCP session is no longer valid.' });
          }
        }
        const selected = this.selectProvider(request, device);
        if ('error' in selected) return json(response, selected.status, { error: selected.error });
        const config = await this.serverFor(device, selected.provider, name);
        if (!config) return json(response, 404, { error: 'No such server for this device.' });
        return await this.forward(request, response, device, selected.provider, name, config);
      }
      return json(response, 404, { error: 'Not found.' });
    } catch (error) {
      this.log(new Error('gateway: request handling failed'));
      if (!response.headersSent) json(response, 502, { error: 'The gateway could not handle this request.' });
      else if (!response.writableEnded) response.end();
    }
  }

  /** Whether a device may use a server as a provider: the server is enabled, HTTP, and allowed for it. */
  private mayUse(device: StoredDevice, provider: string, name: string, server: StoredServer): boolean {
    if (server.enabled === false) return false;
    // Only the streamable HTTP transport is shared across machines; sse and stdio are local-only.
    if (server.type !== 'http') return false;
    if (!nameSchema.safeParse(name).success) return false;
    if (device.servers !== null && !device.servers.includes(name)) return false;
    return allowsProvider(server, provider);
  }

  private async catalogFor(device: StoredDevice, provider: string): Promise<CatalogServer[]> {
    if (!await this.deps.providerMcpOn(provider).catch(() => false)) return [];
    const servers = await this.deps.servers();
    const catalog: CatalogServer[] = [];
    for (const [name, server] of Object.entries(servers)) {
      if (!this.mayUse(device, provider, name, server)) continue;
      catalog.push({ name, path: `/mcp/${encodeURIComponent(name)}` });
    }
    return catalog.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async serverFor(device: StoredDevice, provider: string, name: string): Promise<McpConfig | null> {
    if (!await this.deps.providerMcpOn(provider).catch(() => false)) return null;
    const server = (await this.deps.servers())[name];
    if (!server || !this.mayUse(device, provider, name, server)) return null;
    return stripStored(server);
  }

  /** The current target for a device, provider and server, or null if it is no longer allowed. */
  private async currentTarget(device: StoredDevice, provider: string, name: string): Promise<{ config: HttpConfig; fingerprint: string } | null> {
    const stored = await this.load();
    const fresh = stored.devices[device.id];
    if (!fresh || fresh.revokedAt !== null) return null;
    if (!fresh.providers.includes(provider)) return null;
    if (!await this.deps.providerMcpOn(provider).catch(() => false)) return null;
    const server = (await this.deps.servers())[name];
    if (!server || !this.mayUse(fresh, provider, name, server)) return null;
    const config = stripStored(server);
    if (config.type !== 'http') return null;
    return { config, fingerprint: configFingerprint(config) };
  }

  /* ---------------------------------------------------------- forwarding */

  private forwardHeaders(request: IncomingMessage, config: HttpConfig, session: Session | null): Record<string, string> {
    const headers: Record<string, string> = {};
    const contentType = headerValue(request.headers['content-type']);
    if (contentType) headers['content-type'] = contentType;
    headers.accept = headerValue(request.headers.accept) ?? 'application/json, text/event-stream';
    const protocol = headerValue(request.headers['mcp-protocol-version']);
    if (protocol) headers['mcp-protocol-version'] = protocol;
    const lastEvent = headerValue(request.headers['last-event-id']);
    if (lastEvent) headers['last-event-id'] = lastEvent;
    if (session) headers['mcp-session-id'] = session.upstreamId;
    // The upstream headers come entirely from the center's config; the device's are not forwarded.
    for (const [key, value] of Object.entries(config.headers ?? {})) headers[key.toLowerCase()] = value;
    return headers;
  }

  private async forward(request: IncomingMessage, response: ServerResponse, device: StoredDevice, provider: string, name: string, config: McpConfig): Promise<void> {
    if (config.type !== 'http') return json(response, 404, { error: 'No such server for this device.' });

    const incoming = headerValue(request.headers['mcp-session-id']);
    let session: Session | null = null;
    if (incoming) {
      session = this.sessions.get(incoming) ?? null;
      // A session belongs to one device, one server and one provider; another provider must not reuse it.
      if (!session || session.deviceId !== device.id || session.server !== name || session.provider !== provider) return json(response, 404, { error: 'That MCP session is not known here.' });
      // A reconfigured upstream must not receive an old session.
      if (session.fingerprint !== configFingerprint(config)) { this.sessions.delete(incoming); return json(response, 404, { error: 'That MCP session is no longer valid.' }); }
      session.lastUsed = Date.now();
    }

    // Reserve the slot before any await, so concurrent requests cannot slip past the cap.
    if (this.active.size >= MAX_ACTIVE_REQUESTS) return json(response, 503, { error: 'The gateway is busy; try again shortly.' }, { 'Retry-After': '1' });

    const controller = new AbortController();
    const active: Active = { controller, deviceId: device.id, server: name, provider, fingerprint: configFingerprint(config), response };
    this.active.add(active);
    const onClose = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', onClose);

    let headersTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      let body: Buffer | undefined;
      if (request.method === 'POST' || request.method === 'PUT') {
        const read = await readBody(request, MAX_BODY, this.options.bodyTimeoutMs, controller.signal);
        if (read.kind === 'aborted') return;
        if (read.kind === 'timeout') return json(response, 408, { error: 'Timed out reading the request body.' });
        if (read.kind === 'too-large') { json(response, 413, { error: 'Request body too large.' }); request.resume(); return; }
        body = read.body;
      }
      if (controller.signal.aborted) return;

      // The device may have been revoked, the server disabled, permissions changed, the provider
      // narrowed, or the target reconfigured while the body was read. Re-check before contacting upstream.
      const target = await this.currentTarget(device, provider, name);
      if (!target || target.fingerprint !== active.fingerprint) return json(response, 401, { error: 'This device or server is no longer allowed.' });

      const headers = this.forwardHeaders(request, target.config, session);
      const authorization = await this.deps.authHeader(name, target.config).catch(() => { this.log(new Error('gateway: upstream authorization lookup failed')); return null; });
      if (controller.signal.aborted) return;

      // authHeader may have awaited a refresh; re-check once more so a revoke during it is honored.
      const confirmed = await this.currentTarget(device, provider, name);
      if (!confirmed || confirmed.fingerprint !== active.fingerprint) return json(response, 401, { error: 'This device or server is no longer allowed.' });
      if (authorization) headers.authorization = authorization;

      headersTimer = setTimeout(() => controller.abort(), this.options.upstreamHeadersTimeoutMs);
      headersTimer.unref?.();

      let upstream: Response;
      try {
        upstream = await this.fetcher(target.config.url, { method: request.method, headers, body, redirect: 'manual', signal: controller.signal });
      } catch {
        if (headersTimer) { clearTimeout(headersTimer); headersTimer = null; }
        if (response.writableEnded || response.destroyed) return;
        if (controller.signal.aborted) return json(response, 504, { error: 'The upstream MCP server did not respond in time.' });
        this.log(new Error('gateway: the upstream MCP request failed'));
        return json(response, 502, { error: 'The center could not reach the upstream MCP server.' });
      }
      if (headersTimer) { clearTimeout(headersTimer); headersTimer = null; }

      // A redirect would carry the center's Authorization to a target the user did not configure.
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel().catch(() => undefined);
        return json(response, 502, { error: 'The upstream MCP server tried to redirect; the gateway refuses to follow it.' });
      }
      if (upstream.status === 401 || upstream.status === 403) {
        await upstream.body?.cancel().catch(() => undefined);
        if (session) this.sessions.delete(session.id);
        return json(response, 502, {
          jsonrpc: '2.0', id: null,
          error: { code: -32001, message: 'The center’s authorization for this MCP server is no longer valid; sign in again on the center host.' },
        });
      }

      // An upstream 404 means the session is gone there; a successful DELETE ends it here too.
      if (session && (upstream.status === 404 || (request.method === 'DELETE' && upstream.status < 300))) this.sessions.delete(session.id);

      const upstreamId = upstream.headers.get('mcp-session-id');
      let outSessionId = incoming;
      // Only `initialize` may open a session; other responses must not mint one that could linger.
      if (!outSessionId && upstreamId && isInitializeRequest(body)) {
        outSessionId = newDeviceToken();
        this.addSession({ id: outSessionId, deviceId: device.id, server: name, provider, upstreamId, fingerprint: active.fingerprint, created: Date.now(), lastUsed: Date.now() });
      }

      const outHeaders: Record<string, string> = {};
      const responseType = upstream.headers.get('content-type');
      if (responseType) outHeaders['Content-Type'] = responseType;
      const cache = upstream.headers.get('cache-control');
      if (cache) outHeaders['Cache-Control'] = cache;
      if (outSessionId) outHeaders['Mcp-Session-Id'] = outSessionId;
      if (!response.writableEnded) response.writeHead(upstream.status, outHeaders);

      const stream = upstream.body;
      if (stream && !response.writableEnded) {
        const reader = stream.getReader();
        const bumpIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            controller.abort();
            if (!response.writableEnded && !response.destroyed) response.end();
          }, this.options.upstreamIdleTimeoutMs);
          idleTimer.unref?.();
        };
        bumpIdle();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (response.writableEnded || response.destroyed) break;
            bumpIdle();
            if (value && value.length) {
              if (!response.write(Buffer.from(value))) await waitDrain(response);
            }
          }
        } catch {
          // The upstream ended, was aborted, or the client went away.
        } finally {
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
          reader.releaseLock?.();
        }
      }
      if (!response.writableEnded && !response.destroyed) response.end();
    } finally {
      if (headersTimer) clearTimeout(headersTimer);
      if (idleTimer) clearTimeout(idleTimer);
      response.off('close', onClose);
      this.active.delete(active);
    }
  }

  private addSession(session: Session): void {
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (oldest) this.sessions.delete(oldest.id);
    }
    this.sessions.set(session.id, session);
  }
}
