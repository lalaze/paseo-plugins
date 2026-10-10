import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Gateway, MAX_ACTIVE_REQUESTS, type GatewayOptions, validatePublicUrl } from '../server/gateway';
import { fetchCatalog, isLoopbackGatewayUrl, normalizeGatewayUrl, remoteMcpConfigs } from '../server/remote';
import type { StoredServer } from '../server/mcp';

/* --------------------------------------------------------------- helpers */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

interface Upstream { url: string; seen: string[]; close(): Promise<void>; }

async function makeUpstream(options: { hang?: boolean; silent?: boolean; requireAuth?: string; sessionEverywhere?: boolean } = {}): Promise<Upstream> {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(typeof request.headers.authorization === 'string' ? request.headers.authorization : '');
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      if (options.silent) return; // Accept and never answer.
      if (options.requireAuth && (request.headers.authorization ?? '') !== options.requireAuth) { response.writeHead(401); response.end('no'); return; }
      if (options.hang) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('data: open\n\n'); return; }
      const message = JSON.parse(raw || '{}') as { id?: unknown; method?: string };
      if (message.method === 'initialize') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'up-1' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json', ...(options.sessionEverywhere ? { 'Mcp-Session-Id': 'up-1' } : {}) });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }));
    });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}/mcp`, seen, close: () => new Promise(resolve => server.close(() => resolve())) };
}

async function fakeCenter(provider: string | null, servers: unknown[], options: { redirect?: boolean } = {}): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    if (options.redirect) { response.writeHead(302, { Location: 'https://evil.example/v1/servers' }); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(provider === null ? { servers } : { provider, servers }));
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => server.close(() => resolve())) };
}

interface Harness {
  root: string;
  gateway: Gateway;
  base: string;
  port: number;
  servers: Record<string, StoredServer>;
  upstream: Upstream;
  logs: unknown[];
  setAuth(value: string | (() => Promise<string>)): void;
  setMcpOn(provider: string, on: boolean): void;
}

async function harness(input: {
  upstream?: Parameters<typeof makeUpstream>[0];
  servers?: Record<string, StoredServer>;
  options?: Partial<GatewayOptions>;
  publicUrl?: (port: number) => string;
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'gateway-hard-'));
  const upstream = await makeUpstream(input.upstream ?? {});
  const servers: Record<string, StoredServer> = input.servers ?? { docs: { type: 'http', url: upstream.url } };
  const mcpOn = new Set(['claude', 'codex']);
  const logs: unknown[] = [];
  let auth: string | (() => Promise<string>) = 'Bearer upstream-secret';
  const gateway = new Gateway(root, {
    servers: async () => servers,
    providerMcpOn: async provider => mcpOn.has(provider),
    authHeader: async () => (typeof auth === 'function' ? auth() : auth),
  }, error => { logs.push(error); }, fetch, input.options);
  const port = await freePort();
  await gateway.saveConfig({ enabled: true, host: '127.0.0.1', port, publicUrl: (input.publicUrl ?? (value => `http://100.96.195.115:${value}`))(port) });
  const base = `http://127.0.0.1:${port}`;
  cleanups.push(async () => { gateway.stop(); await upstream.close(); await rm(root, { recursive: true, force: true }); });
  return {
    root, gateway, base, port, servers, upstream, logs,
    setAuth: value => { auth = value; },
    setMcpOn: (provider, on) => { if (on) mcpOn.add(provider); else mcpOn.delete(provider); },
  };
}

function call(base: string, token: string, body: unknown, path = '/mcp/docs', extra: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extra },
    body: JSON.stringify(body),
  });
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };

/* ------------------------------------------------------------------- A */

test('A: the center provider must match the device credential', async () => {
  const center = await fakeCenter('claude', [{ name: 'docs', path: '/mcp/docs' }]);
  cleanups.push(center.close);
  await assert.rejects(fetchCatalog(center.url, 't', 'codex', fetch, 1000), /different provider/);
  const servers = await fetchCatalog(center.url, 't', 'claude', fetch, 1000);
  assert.deepEqual(servers.map(server => server.name), ['docs']);
});

test('A: a catalog without a provider is rejected', async () => {
  const center = await fakeCenter(null, [{ name: 'docs', path: '/mcp/docs' }]);
  cleanups.push(center.close);
  await assert.rejects(fetchCatalog(center.url, 't', 'claude', fetch, 1000), /usable server catalog/);
});

/* ------------------------------------------------------------------- B */

test('B: the catalog request refuses redirects', async () => {
  const center = await fakeCenter('claude', [], { redirect: true });
  cleanups.push(center.close);
  await assert.rejects(fetchCatalog(center.url, 't', 'claude', fetch, 1000), /redirect/);
});

test('B: only well-formed, non-reserved, correctly pathed catalog items survive', async () => {
  const center = await fakeCenter('claude', [
    { name: 'docs', path: '/mcp/docs' },
    { name: 'paseo', path: '/mcp/paseo' },
    { name: 'bad name', path: '/mcp/bad%20name' },
    { name: 'other', path: '/mcp/not-other' },
    { name: 'wrong', path: '/evil' },
  ]);
  cleanups.push(center.close);
  const servers = await fetchCatalog(center.url, 't', 'claude', fetch, 1000);
  assert.deepEqual(servers.map(server => server.name), ['docs']);
});

test('B: remote MCP configs drop reserved and malformed names and rebuild the path', () => {
  const configs = remoteMcpConfigs('http://c/', 'tok', [
    { name: 'docs', path: '/mcp/docs' },
    { name: 'paseo', path: '/mcp/paseo' },
    { name: 'bad name', path: '/x' },
  ]);
  assert.deepEqual(Object.keys(configs), ['docs']);
  assert.equal(configs.docs!.type, 'http');
  assert.equal((configs.docs as { url: string }).url, 'http://c/mcp/docs');
});

/* ------------------------------------------------------------------- C */

test('C: a loopback public address is never shown to the user', async () => {
  const h = await harness({ publicUrl: port => `http://127.0.0.1:${port}` });
  const state = await h.gateway.state();
  assert.deepEqual(state.localUrls, [`http://100.96.195.115:${h.port}`]);
  assert.ok(!state.localUrls.some(url => /127\.0\.0\.1|localhost/.test(url)));
  assert.ok(state.notes.some(note => /loopback/.test(note)));
});

test('C: the Origin check still accepts loopback even when it is hidden from the user', async () => {
  const h = await harness({ publicUrl: port => `http://127.0.0.1:${port}` });
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const response = await fetch(`${h.base}/v1/servers`, { headers: { Authorization: `Bearer ${token}`, Origin: `http://127.0.0.1:${h.port}` } });
  assert.equal(response.status, 200);
});

test('C: public and gateway URLs reject a path the same way', () => {
  assert.throws(() => validatePublicUrl('http://h:1/sub'), /origin only/);
  assert.throws(() => normalizeGatewayUrl('http://h:1/sub'), /origin only/);
});

test('C: isLoopbackGatewayUrl recognizes every real loopback spelling', () => {
  const loopback = [
    'http://localhost:1', 'http://LOCALHOST:1', 'http://localhost.:1', 'http://LOCALHOST.:1',
    'http://127.0.0.1:1', 'http://127.0.0.2:1', 'http://127.1:1', 'http://127.255.255.254:1',
    'http://0177.0.0.1:1', 'http://2130706433:1', 'http://127.0.0.1.:1',
    'http://[::1]:1', 'http://[0:0:0:0:0:0:0:1]:1', 'http://[::ffff:127.0.0.1]:1', 'http://[::ffff:7f00:1]:1',
  ];
  for (const url of loopback) assert.equal(isLoopbackGatewayUrl(url), true, url);
  const reachable = [
    'http://0.0.0.0:1', 'http://[::]:1', 'http://10.0.0.1:1', 'http://100.96.195.115:1',
    'http://127.0.0.1.evil.com:1', 'http://notlocalhost:1', 'http://[::ffff:10.0.0.1]:1', 'http://localhost.evil.com:1',
  ];
  for (const url of reachable) assert.equal(isLoopbackGatewayUrl(url), false, url);
});

test('C: no loopback spelling reaches state.localUrls', async () => {
  const forms: Array<(port: number) => string> = [
    port => `http://localhost.:${port}`,
    port => `http://127.0.0.2:${port}`,
    port => `http://127.1:${port}`,
    port => `http://[::1]:${port}`,
    port => `http://[::ffff:127.0.0.1]:${port}`,
  ];
  for (const publicUrl of forms) {
    const h = await harness({ publicUrl });
    const state = await h.gateway.state();
    assert.deepEqual(state.localUrls, [`http://100.96.195.115:${h.port}`], publicUrl(h.port));
    assert.ok(state.notes.some(note => /loopback/.test(note)), publicUrl(h.port));
  }
});

/* ------------------------------------------------------------------- D */

test('D: stop prevents a later start from listening', async () => {
  const h = await harness();
  h.gateway.stop();
  h.gateway.start();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal((await h.gateway.state()).running, false);
  await assert.rejects(fetch(`${h.base}/v1/servers`));
});

test('D: a restart drops sessions from before the restart', async () => {
  const h = await harness();
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const session = (await call(h.base, token, initialize)).headers.get('mcp-session-id')!;
  const { config } = await h.gateway.state();
  await h.gateway.saveConfig({ ...config, enabled: false });
  await h.gateway.saveConfig({ ...config, enabled: true });
  const after = await call(h.base, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, '/mcp/docs', { 'Mcp-Session-Id': session });
  assert.equal(after.status, 404);
});

/* ------------------------------------------------------------------- E */

test('E: reconcile aborts a live stream when the server is disabled', async () => {
  const h = await harness({ upstream: { hang: true } });
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const response = await fetch(`${h.base}/mcp/docs`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } });
  const reader = response.body!.getReader();
  await reader.read();
  h.servers.docs = { type: 'http', url: h.upstream.url, enabled: false };
  await h.gateway.reconcile();
  const closed = await Promise.race([
    reader.read().then(result => result.done === true, () => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000)),
  ]);
  assert.equal(closed, true, 'disabling the server must end the live stream');
});

test('E: reconcile aborts a live stream when the provider MCP switch turns off', async () => {
  const h = await harness({ upstream: { hang: true } });
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const response = await fetch(`${h.base}/mcp/docs`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } });
  const reader = response.body!.getReader();
  await reader.read();
  h.setMcpOn('claude', false);
  await h.gateway.reconcile();
  const closed = await Promise.race([
    reader.read().then(result => result.done === true, () => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000)),
  ]);
  assert.equal(closed, true);
});

test('E: a revoke during an in-flight authorization never reaches upstream', async () => {
  const h = await harness();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.setAuth(async () => { await gate; return 'Bearer upstream-secret'; });
  const created = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const pending = call(h.base, created.token, initialize);
  await new Promise(resolve => setTimeout(resolve, 100));
  await h.gateway.revokeDevice(created.state.devices[0]!.id);
  release();
  await pending;
  assert.deepEqual(h.upstream.seen, [], 'no upstream request may be sent after a revoke');
});

/* ------------------------------------------------------------------- F */

test('F: a reconfigured upstream invalidates old sessions', async () => {
  const h = await harness();
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const session = (await call(h.base, token, initialize)).headers.get('mcp-session-id')!;
  const other = await makeUpstream();
  cleanups.push(other.close);
  h.servers.docs = { type: 'http', url: other.url };
  const after = await call(h.base, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, '/mcp/docs', { 'Mcp-Session-Id': session });
  assert.equal(after.status, 404);
  assert.equal(other.seen.length, 0, 'the old session must not be forwarded to the new target');
});

test('F: a refreshed upstream token keeps the session', async () => {
  const h = await harness();
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const session = (await call(h.base, token, initialize)).headers.get('mcp-session-id')!;
  h.setAuth('Bearer rotated');
  const after = await call(h.base, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, '/mcp/docs', { 'Mcp-Session-Id': session });
  assert.equal(after.status, 200);
});

/* ------------------------------------------------------------------- H */

test('H: damaged stored rows are skipped, not widened', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-hard-'));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'gateway.json'), JSON.stringify({
    version: 1,
    config: { enabled: false, host: '0.0.0.0', port: 47822, publicUrl: 'http://100.96.195.115:47822' },
    devices: {
      badServers: { id: 'badServers', name: 'a', provider: 'claude', servers: 'all', createdAt: 'x', revokedAt: null, tokenHash: 'h' },
      badRevoked: { id: 'badRevoked', name: 'b', provider: 'claude', servers: null, createdAt: 'x', revokedAt: 123, tokenHash: 'h' },
    },
    remotes: {
      badUrl: { id: 'badUrl', name: 'c', url: 'not a url', token: 't', provider: 'claude', createdAt: 'x', checkedAt: null, status: 'ok', error: null, catalog: [] },
    },
  }, null, 2));
  const gateway = new Gateway(root, { servers: async () => ({}), providerMcpOn: async () => true, authHeader: async () => null });
  cleanups.push(async () => { gateway.stop(); await rm(root, { recursive: true, force: true }); });
  const state = await gateway.state();
  assert.equal(state.devices.length, 0, 'a damaged scope or revoke field must not load as a valid device');
  assert.equal(state.remotes.length, 0, 'a remote with an unusable URL must not load');
  assert.ok(state.notes.some(note => /damaged/.test(note)));
  assert.deepEqual(await gateway.remoteServers('claude'), {});
});

test('H: a valid stored device still loads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-hard-'));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'gateway.json'), JSON.stringify({
    version: 1,
    config: { enabled: false, host: '0.0.0.0', port: 47822, publicUrl: 'http://100.96.195.115:47822' },
    devices: { good: { id: 'good', name: 'a', provider: 'claude', servers: null, createdAt: 'x', revokedAt: null, tokenHash: 'h' } },
    remotes: {},
  }, null, 2));
  const gateway = new Gateway(root, { servers: async () => ({}), providerMcpOn: async () => true, authHeader: async () => null });
  cleanups.push(async () => { gateway.stop(); await rm(root, { recursive: true, force: true }); });
  const state = await gateway.state();
  assert.deepEqual(state.devices.map(device => device.id), ['good']);
  assert.equal(state.notes.length, 0);
});

/* ------------------------------------------------------------------- I */

test('I: a stalled request body times out with 408', async () => {
  const h = await harness({ options: { bodyTimeoutMs: 150 } });
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const request = httpRequest({ host: '127.0.0.1', port: h.port, path: '/mcp/docs', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': '100' } });
  request.write('{');
  const status = await new Promise<number>(resolve => {
    request.on('response', response => { response.resume(); resolve(response.statusCode ?? -1); });
    request.on('error', () => resolve(-1));
  });
  request.destroy();
  assert.equal(status, 408);
});

test('I: a silent upstream times out with 504 and logs no credential', async () => {
  const h = await harness({ upstream: { silent: true }, options: { upstreamHeadersTimeoutMs: 150 } });
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  assert.equal((await call(h.base, token, initialize)).status, 504);
  assert.ok(!JSON.stringify(h.logs).includes('upstream-secret'));
});

test('I: an idle upstream stream is cut', async () => {
  const h = await harness({ upstream: { hang: true }, options: { upstreamIdleTimeoutMs: 150 } });
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const response = await fetch(`${h.base}/mcp/docs`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } });
  const text = await response.text();
  assert.match(text, /open/);
});

test('I: a concurrency slot is reserved before authorization waits', async () => {
  const h = await harness({ upstream: { hang: true } });
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const controllers: AbortController[] = [];
  for (let index = 0; index < MAX_ACTIVE_REQUESTS; index += 1) {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${h.base}/mcp/docs`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: controller.signal });
    assert.equal(response.status, 200);
  }
  // A slow authorization must not let a request slip past the cap.
  h.setAuth(async () => { await new Promise(resolve => setTimeout(resolve, 500)); return 'Bearer upstream-secret'; });
  assert.equal((await call(h.base, token, initialize)).status, 503);
  for (const controller of controllers) controller.abort();
});

test('I: a failed upstream lookup logs a fixed message without the credential', async () => {
  const h = await harness();
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  h.servers.docs = { type: 'http', url: 'http://127.0.0.1:1/mcp' };
  assert.equal((await call(h.base, token, initialize)).status, 502);
  assert.ok(!JSON.stringify(h.logs).includes('upstream-secret'));
});
