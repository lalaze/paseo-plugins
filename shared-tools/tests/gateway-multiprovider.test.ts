import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Gateway, hashToken } from '../server/gateway';
import type { StoredServer } from '../server/mcp';

/**
 * One device token authorized for several providers. The provider is named per request in the
 * `X-Paseo-Provider` header, and each provider's permissions, catalog and sessions stay separate so
 * no two providers' scopes can be merged into a wider one.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (await cleanups.length) await cleanups.pop()!(); });

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

interface Upstream { url: string; seen: string[]; headers: Record<string, string>[]; close(): Promise<void>; }

async function makeUpstream(options: { hang?: boolean } = {}): Promise<Upstream> {
  const seen: string[] = [];
  const headers: Record<string, string>[] = [];
  const server = createServer((request, response) => {
    seen.push(typeof request.headers.authorization === 'string' ? request.headers.authorization : '');
    headers.push(Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, String(value)])));
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      if (options.hang) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('data: open\n\n'); return; }
      const message = JSON.parse(raw || '{}') as { id?: unknown; method?: string };
      if (message.method === 'initialize') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'up-1' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }));
    });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}/mcp`, seen, headers, close: () => new Promise(resolve => server.close(() => resolve())) };
}

interface Harness {
  gateway: Gateway;
  base: string;
  port: number;
  servers: Record<string, StoredServer>;
  upstream: Upstream;
  hang: Upstream;
  setMcpOn(provider: string, on: boolean): void;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'gateway-multi-'));
  const upstream = await makeUpstream();
  const hang = await makeUpstream({ hang: true });
  const servers: Record<string, StoredServer> = {
    docs: { type: 'http', url: upstream.url },
    live: { type: 'http', url: hang.url },
    codexOnly: { type: 'http', url: upstream.url, providers: ['codex'] },
    claudeOnly: { type: 'http', url: upstream.url, providers: ['claude'] },
  };
  const mcpOn = new Set(['claude', 'codex']);
  const gateway = new Gateway(root, {
    servers: async () => servers,
    providerMcpOn: async provider => mcpOn.has(provider),
    authHeader: async () => 'Bearer upstream-secret',
  }, () => undefined);
  const port = await freePort();
  await gateway.saveConfig({ enabled: true, host: '127.0.0.1', port, publicUrl: `http://100.96.195.115:${port}` });
  const base = `http://127.0.0.1:${port}`;
  cleanups.push(async () => { gateway.stop(); await upstream.close(); await hang.close(); await rm(root, { recursive: true, force: true }); });
  return { gateway, base, port, servers, upstream, hang, setMcpOn: (provider, on) => { if (on) mcpOn.add(provider); else mcpOn.delete(provider); } };
}

function headers(token: string, provider?: string, session?: string): Record<string, string> {
  const out: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (provider) out['X-Paseo-Provider'] = provider;
  if (session) out['Mcp-Session-Id'] = session;
  return out;
}

function call(base: string, token: string, body: unknown, options: { path?: string; provider?: string; session?: string } = {}) {
  return fetch(`${base}${options.path ?? '/mcp/docs'}`, { method: 'POST', headers: headers(token, options.provider, options.session), body: JSON.stringify(body) });
}

function catalog(base: string, token: string, provider?: string) {
  const head: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (provider) head['X-Paseo-Provider'] = provider;
  return fetch(`${base}/v1/servers`, { headers: head });
}

async function names(response: Response): Promise<string[]> {
  const body = await response.json() as { servers: { name: string }[] };
  return body.servers.map(server => server.name).sort();
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };

/* ------------------------------------------------------- scope */

test('one token sees each provider’s own catalog and may call only its own servers', async () => {
  const h = await harness();
  const { token } = await h.gateway.createDevice({ name: 'both', providers: ['claude', 'codex'], servers: null });

  const claude = await catalog(h.base, token, 'claude');
  assert.equal(claude.status, 200);
  assert.equal((await claude.clone().json() as { provider: string }).provider, 'claude');
  assert.deepEqual(await names(claude), ['claudeOnly', 'docs', 'live']);

  const codex = await catalog(h.base, token, 'codex');
  assert.equal((await codex.clone().json() as { provider: string }).provider, 'codex');
  assert.deepEqual(await names(codex), ['codexOnly', 'docs', 'live']);

  // A server only one provider may use is refused for the other.
  assert.equal((await call(h.base, token, initialize, { path: '/mcp/codexOnly', provider: 'claude' })).status, 404);
  assert.equal((await call(h.base, token, initialize, { path: '/mcp/codexOnly', provider: 'codex' })).status, 200);
  assert.equal((await call(h.base, token, initialize, { path: '/mcp/claudeOnly', provider: 'codex' })).status, 404);
  assert.equal((await call(h.base, token, initialize, { path: '/mcp/claudeOnly', provider: 'claude' })).status, 200);
});

test('an unknown or unauthorized provider is refused', async () => {
  const h = await harness();
  const { token } = await h.gateway.createDevice({ name: 'claude-only', provider: 'claude', servers: null });
  assert.equal((await catalog(h.base, token, 'codex')).status, 403);
  assert.equal((await catalog(h.base, token, 'nope')).status, 403);
  assert.equal((await call(h.base, token, initialize, { provider: 'codex' })).status, 403);
  assert.equal((await catalog(h.base, token, 'claude')).status, 200);
});

test('a multi-provider device with no header is asked to choose; a single-provider one is not', async () => {
  const h = await harness();
  const { token } = await h.gateway.createDevice({ name: 'both', providers: ['claude', 'codex'], servers: null });
  assert.equal((await catalog(h.base, token)).status, 400);
  assert.equal((await call(h.base, token, initialize)).status, 400);

  const single = await h.gateway.createDevice({ name: 'one', provider: 'claude', servers: null });
  assert.equal((await catalog(h.base, single.token)).status, 200);
  assert.equal((await call(h.base, single.token, initialize)).status, 200);
});

test('a device can be widened to another provider without a new token', async () => {
  const h = await harness();
  const created = await h.gateway.createDevice({ name: 'one', provider: 'claude', servers: null });
  assert.equal((await catalog(h.base, created.token, 'codex')).status, 403);
  const id = created.state.devices[0]!.id;
  const widened = await h.gateway.updateDeviceProviders({ id, providers: ['claude', 'codex'] });
  assert.deepEqual(widened.devices[0]!.providers, ['claude', 'codex']);
  assert.equal((await catalog(h.base, created.token, 'codex')).status, 200);
  assert.equal((await catalog(h.base, created.token, 'claude')).status, 200);
});

test('creating a device with no providers is refused, and duplicates collapse', async () => {
  const h = await harness();
  await assert.rejects(h.gateway.createDevice({ name: 'x', providers: [], servers: null }), /at least one provider/);
  await assert.rejects(h.gateway.createDevice({ name: 'x', providers: ['', '  '], servers: null }), /at least one provider/);
  await assert.rejects(h.gateway.createDevice({ name: 'x', servers: null }), /at least one provider/);
  const created = await h.gateway.createDevice({ name: 'x', providers: ['claude', 'claude', 'codex'], servers: null });
  assert.deepEqual(created.state.devices[0]!.providers, ['claude', 'codex']);
});

/* ------------------------------------------------------- sessions */

test('a session cannot be reused as another provider of the same device', async () => {
  const h = await harness();
  const { token } = await h.gateway.createDevice({ name: 'both', providers: ['claude', 'codex'], servers: null });
  const session = (await call(h.base, token, initialize, { provider: 'claude' })).headers.get('mcp-session-id')!;
  assert.ok(session, 'initialize must open a session');
  assert.equal((await call(h.base, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { provider: 'codex', session })).status, 404);
  assert.equal((await call(h.base, token, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { provider: 'claude', session })).status, 200);
});

test('a session dropped with its provider stays gone after the provider is granted again', async () => {
  const h = await harness();
  const created = await h.gateway.createDevice({ name: 'both', providers: ['claude', 'codex'], servers: null });
  const id = created.state.devices[0]!.id;
  const token = created.token;

  const session = (await call(h.base, token, initialize, { provider: 'codex' })).headers.get('mcp-session-id')!;
  assert.ok(session, 'initialize must open a session');

  // Remove codex, then grant it again immediately, without ever touching the old session in between.
  // The removal must have dropped the session for good, so the re-grant cannot revive it.
  await h.gateway.updateDeviceProviders({ id, providers: ['claude'] });
  await h.gateway.updateDeviceProviders({ id, providers: ['claude', 'codex'] });

  assert.equal((await call(h.base, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { provider: 'codex', session })).status, 404);

  // The same token still opens a fresh session for the re-granted provider.
  const fresh = await call(h.base, token, initialize, { provider: 'codex' });
  assert.equal(fresh.status, 200);
  assert.ok(fresh.headers.get('mcp-session-id'), 'a new initialize must mint a fresh session');
});

/* ------------------------------------------------------- gating */

test('the provider MCP switch and a server denylist still gate a multi-provider device', async () => {
  const h = await harness();
  const { token } = await h.gateway.createDevice({ name: 'both', providers: ['claude', 'codex'], servers: null });

  h.setMcpOn('codex', false);
  assert.deepEqual(await names(await catalog(h.base, token, 'codex')), []);
  assert.equal((await call(h.base, token, initialize, { path: '/mcp/codexOnly', provider: 'codex' })).status, 404);
  assert.equal((await call(h.base, token, initialize, { path: '/mcp/docs', provider: 'claude' })).status, 200);

  h.setMcpOn('codex', true);
  h.servers.docs = { type: 'http', url: h.upstream.url, excludedProviders: ['codex'] };
  assert.ok(!(await names(await catalog(h.base, token, 'codex'))).includes('docs'));
  assert.ok((await names(await catalog(h.base, token, 'claude'))).includes('docs'));
});

test('removing one provider ends only its streams and sessions', async () => {
  const h = await harness();
  const created = await h.gateway.createDevice({ name: 'both', providers: ['claude', 'codex'], servers: null });
  const id = created.state.devices[0]!.id;
  const claudeSession = (await call(h.base, created.token, initialize, { provider: 'claude' })).headers.get('mcp-session-id')!;
  const codexSession = (await call(h.base, created.token, initialize, { provider: 'codex' })).headers.get('mcp-session-id')!;

  const claudeStream = await fetch(`${h.base}/mcp/live`, { headers: headers(created.token, 'claude') });
  const codexStream = await fetch(`${h.base}/mcp/live`, { headers: headers(created.token, 'codex') });
  const claudeReader = claudeStream.body!.getReader();
  const codexReader = codexStream.body!.getReader();
  await claudeReader.read();
  await codexReader.read();

  await h.gateway.updateDeviceProviders({ id, providers: ['codex'] });

  const claudeClosed = await Promise.race([
    claudeReader.read().then(result => result.done === true, () => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000)),
  ]);
  assert.equal(claudeClosed, true, 'the removed provider’s stream must end at once');
  const codexClosed = await Promise.race([
    codexReader.read().then(result => result.done === true, () => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 150)),
  ]);
  assert.equal(codexClosed, false, 'the kept provider’s stream must stay open');

  // The removed provider is refused; the old session is gone; the kept provider still works.
  assert.equal((await catalog(h.base, created.token, 'claude')).status, 403);
  assert.equal((await call(h.base, created.token, { jsonrpc: '2.0', id: 9, method: 'tools/list' }, { provider: 'claude', session: claudeSession })).status, 404);
  assert.equal((await call(h.base, created.token, { jsonrpc: '2.0', id: 10, method: 'tools/list' }, { provider: 'codex', session: codexSession })).status, 200);

  codexReader.cancel().catch(() => undefined);
});

/* ------------------------------------------------------- storage */

test('a legacy single-provider row loads, and a bad providers[] never falls back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-multi-'));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'gateway.json'), JSON.stringify({
    version: 1,
    config: { enabled: false, host: '0.0.0.0', port: 47822, publicUrl: 'http://100.96.195.115:47822' },
    devices: {
      legacy: { id: 'legacy', name: 'old', provider: 'claude', servers: null, createdAt: 'x', revokedAt: null, tokenHash: 'h' },
      emptyList: { id: 'emptyList', name: 'a', providers: [], provider: 'codex', servers: null, createdAt: 'x', revokedAt: null, tokenHash: 'h' },
      nullField: { id: 'nullField', name: 'b', providers: null, provider: 'codex', servers: null, createdAt: 'x', revokedAt: null, tokenHash: 'h' },
      blankEntry: { id: 'blankEntry', name: 'c', providers: ['claude', ''], servers: null, createdAt: 'x', revokedAt: null, tokenHash: 'h' },
    },
    remotes: {},
  }, null, 2));
  const gateway = new Gateway(root, { servers: async () => ({}), providerMcpOn: async () => true, authHeader: async () => null });
  cleanups.push(async () => { gateway.stop(); await rm(root, { recursive: true, force: true }); });
  const state = await gateway.state();
  assert.deepEqual(state.devices.map(device => device.id), ['legacy']);
  assert.deepEqual(state.devices[0]!.providers, ['claude']);
  assert.ok(state.notes.some(note => /damaged/.test(note)));
});

/* ------------------------------------------------------- remotes */

test('a batch connection injects each provider’s servers with its own header', async () => {
  const center = await harness();
  const { token } = await center.gateway.createDevice({ name: 'both', providers: ['claude', 'codex'], servers: null });

  const root = await mkdtemp(join(tmpdir(), 'gateway-multi-remote-'));
  const remote = new Gateway(root, { servers: async () => ({}), providerMcpOn: async () => true, authHeader: async () => null });
  cleanups.push(async () => { remote.stop(); await rm(root, { recursive: true, force: true }); });

  const state = await remote.connectRemote({ name: 'center', url: center.base, token, providers: ['claude', 'codex'] });
  assert.equal(state.remotes.length, 2);
  const claude = state.remotes.find(remote => remote.provider === 'claude')!;
  const codex = state.remotes.find(remote => remote.provider === 'codex')!;
  assert.deepEqual(claude.catalog.map(server => server.name).sort(), ['claudeOnly', 'docs', 'live']);
  assert.deepEqual(codex.catalog.map(server => server.name).sort(), ['codexOnly', 'docs', 'live']);
  assert.ok(!JSON.stringify(state).includes(token), 'the device token must not be echoed in state');

  const claudeConfigs = await remote.remoteServers('claude');
  assert.deepEqual(Object.keys(claudeConfigs).sort(), ['claudeOnly', 'docs', 'live']);
  assert.equal((claudeConfigs.docs as { headers: Record<string, string> }).headers['X-Paseo-Provider'], 'claude');
  assert.equal((claudeConfigs.docs as { headers: Record<string, string> }).headers.Authorization, `Bearer ${token}`);

  const codexConfigs = await remote.remoteServers('codex');
  assert.deepEqual(Object.keys(codexConfigs).sort(), ['codexOnly', 'docs', 'live']);
  assert.equal((codexConfigs.codexOnly as { headers: Record<string, string> }).headers['X-Paseo-Provider'], 'codex');

  // The injected config works end to end and carries the provider to the center.
  const live = await fetch((codexConfigs.codexOnly as { url: string }).url, {
    method: 'POST',
    headers: { ...(codexConfigs.codexOnly as { headers: Record<string, string> }).headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(initialize),
  });
  assert.equal(live.status, 200);
  assert.equal(center.upstream.seen.at(-1), 'Bearer upstream-secret');
});

test('reconnecting the same url, token and provider refreshes instead of duplicating', async () => {
  const center = await harness();
  const { token } = await center.gateway.createDevice({ name: 'both', providers: ['claude', 'codex'], servers: null });
  const root = await mkdtemp(join(tmpdir(), 'gateway-multi-remote-'));
  const remote = new Gateway(root, { servers: async () => ({}), providerMcpOn: async () => true, authHeader: async () => null });
  cleanups.push(async () => { remote.stop(); await rm(root, { recursive: true, force: true }); });

  const first = await remote.connectRemote({ name: 'center', url: center.base, token, providers: ['claude', 'codex'] });
  assert.equal(first.remotes.length, 2);
  const again = await remote.connectRemote({ name: 'center', url: center.base, token, providers: ['claude'] });
  assert.equal(again.remotes.length, 2, 'the same connection must be refreshed, not duplicated');
  assert.deepEqual(again.remotes.map(remote => remote.provider).sort(), ['claude', 'codex']);
});

test('an unauthorized provider in a batch is saved as an error and not injected', async () => {
  const center = await harness();
  const { token } = await center.gateway.createDevice({ name: 'claude-only', provider: 'claude', servers: null });
  const root = await mkdtemp(join(tmpdir(), 'gateway-multi-remote-'));
  const remote = new Gateway(root, { servers: async () => ({}), providerMcpOn: async () => true, authHeader: async () => null });
  cleanups.push(async () => { remote.stop(); await rm(root, { recursive: true, force: true }); });

  const state = await remote.connectRemote({ name: 'center', url: center.base, token, providers: ['claude', 'codex'] });
  const claude = state.remotes.find(remote => remote.provider === 'claude')!;
  const codex = state.remotes.find(remote => remote.provider === 'codex')!;
  assert.equal(claude.status, 'ok');
  assert.equal(codex.status, 'error');
  assert.match(codex.error ?? '', /rejected this device credential|not authorized|different provider/);
  assert.deepEqual(await remote.remoteServers('codex'), {});
  assert.deepEqual(Object.keys(await remote.remoteServers('claude')).sort(), ['claudeOnly', 'docs', 'live']);
});

/* ------------------------------------------------------- no leaks */

test('the device token and the provider header never reach upstream', async () => {
  const h = await harness();
  const created = await h.gateway.createDevice({ name: 'both', providers: ['claude', 'codex'], servers: null });
  assert.equal((await call(h.base, created.token, initialize, { provider: 'codex' })).status, 200);
  const forwarded = h.upstream.headers.at(-1)!;
  assert.equal(forwarded['x-paseo-provider'], undefined, 'the device provider header must not be forwarded upstream');
  assert.equal(forwarded.authorization, 'Bearer upstream-secret');
  assert.notEqual(forwarded.authorization, `Bearer ${created.token}`);
  assert.ok(h.upstream.seen.every(value => value === 'Bearer upstream-secret'));

  const text = JSON.stringify(created.state);
  assert.ok(!text.includes(created.token));
  assert.ok(!text.includes(hashToken(created.token)));
});
