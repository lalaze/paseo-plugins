import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Gateway, MAX_ACTIVE_REQUESTS, hashToken, validateHost, validatePublicUrl } from '../server/gateway';
import { fetchCatalog, normalizeGatewayUrl, remoteMcpConfigs } from '../server/remote';
import type { StoredServer } from '../server/mcp';

/* ------------------------------------------------------------------ fakes */

interface Upstream {
  url: string;
  seen: string[];
  headers: Record<string, string>[];
  bodies: string[];
  close(): Promise<void>;
}

/** A fake MCP Streamable HTTP server: initialize hands out a session id, tools/call answers as SSE. */
async function makeUpstream(options: { requireAuth?: string; redirect?: boolean; hang?: boolean; sessionEverywhere?: boolean } = {}): Promise<Upstream> {
  const seen: string[] = [];
  const headers: Record<string, string>[] = [];
  const bodies: string[] = [];
  const sessionHeader = options.sessionEverywhere ? { 'Mcp-Session-Id': 'up-session-1' } : {};
  const server = createServer((request, response) => {
    const auth = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
    seen.push(auth);
    headers.push(Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, String(value)])));
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      if (raw) bodies.push(raw);
      if (options.requireAuth && auth !== options.requireAuth) {
        response.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="fake"' });
        response.end('unauthorized');
        return;
      }
      if (options.redirect) {
        response.writeHead(302, { Location: 'https://elsewhere.example/mcp' });
        response.end();
        return;
      }
      if (options.hang) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: open\n\n');
        return; // Never ends, so the gateway keeps the request active.
      }
      if (request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        response.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}\n\n');
        setTimeout(() => response.end(), 15);
        return;
      }
      if (request.method === 'DELETE') { response.writeHead(204); response.end(); return; }
      const message = JSON.parse(raw || '{}') as { id?: unknown; method?: string };
      if (message.method === 'initialize') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'up-session-1' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }));
        return;
      }
      if (message.method === 'tools/call') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'pong' }] } })}\n\n`);
        setTimeout(() => response.end(), 15);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json', ...sessionHeader });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'ping', description: 'pong' }] } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/mcp`, seen, headers, bodies, close: () => new Promise(resolve => server.close(() => resolve())) };
}

async function freePort(): Promise<number> {
  return new Promise(resolve => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

interface Harness {
  root: string;
  gateway: Gateway;
  upstream: Upstream;
  base: string;
  setAuth(value: string): void;
  setMcpOn(provider: string, on: boolean): void;
  cleanup(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function harness(options: { requireAuth?: string; redirect?: boolean; hang?: boolean; sessionEverywhere?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'gateway-'));
  const upstream = await makeUpstream(options);
  const extra = options.redirect ? await makeUpstream({ redirect: true }) : null;
  const servers: Record<string, StoredServer> = {
    docs: { type: 'http', url: upstream.url },
    legacy: { type: 'sse', url: `${upstream.url}/sse` },
    local: { type: 'stdio', command: 'x' },
    off: { type: 'http', url: upstream.url, enabled: false },
    onlyCodex: { type: 'http', url: upstream.url, providers: ['codex'] },
    ...(extra ? { redir: { type: 'http' as const, url: extra.url } } : {}),
  };
  const mcpOn = new Set(['claude', 'codex']);
  let auth = 'Bearer upstream-secret';
  const gateway = new Gateway(root, {
    servers: async () => servers,
    providerMcpOn: async provider => mcpOn.has(provider),
    authHeader: async () => auth,
  });
  const port = await freePort();
  await gateway.saveConfig({ enabled: true, host: '127.0.0.1', port, publicUrl: `http://127.0.0.1:${port}` });
  const base = `http://127.0.0.1:${port}`;
  cleanups.push(async () => { gateway.stop(); await upstream.close(); if (extra) await extra.close(); await rm(root, { recursive: true, force: true }); });
  return { root, gateway, upstream, base, setAuth: value => { auth = value; }, setMcpOn: (provider, on) => { if (on) mcpOn.add(provider); else mcpOn.delete(provider); }, cleanup: async () => { gateway.stop(); } };
}

function call(base: string, token: string, body: unknown, path = '/mcp/docs', extra: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extra },
    body: JSON.stringify(body),
  });
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };

/* -------------------------------------------------------------- helpers */

test('hashes tokens, validates public URLs, and normalizes gateway URLs', () => {
  assert.equal(hashToken('abc'), hashToken('abc'));
  assert.notEqual(hashToken('abc'), hashToken('abd'));
  assert.equal(validatePublicUrl('http://100.96.195.115:47822/'), 'http://100.96.195.115:47822');
  assert.throws(() => validatePublicUrl('http://user:pw@host:1'), /user name/);
  assert.throws(() => validatePublicUrl('http://host:1/#x'), /fragment/);
  assert.throws(() => validatePublicUrl('http://host:1/?token=abc'), /query/);
  assert.equal(normalizeGatewayUrl(' http://10.0.0.1:47822/ '), 'http://10.0.0.1:47822');
  assert.throws(() => normalizeGatewayUrl('http://u:p@h:1'), /user name/);
});

/* ------------------------------------------------------- catalog + auth */

test('the catalog needs a valid token and hides upstream details', async () => {
  const h = await harness();
  assert.equal((await fetch(`${h.base}/v1/servers`)).status, 401);
  assert.equal((await fetch(`${h.base}/v1/servers`, { headers: { Authorization: 'Bearer nope' } })).status, 401);

  const { token } = await h.gateway.createDevice({ name: 'laptop', provider: 'claude', servers: null });
  const response = await fetch(`${h.base}/v1/servers`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const body = await response.json() as { provider: string; servers: { name: string; path: string }[] };
  assert.equal(body.provider, 'claude');
  assert.deepEqual(body.servers.map(server => server.name), ['docs']);
  assert.equal(body.servers[0]!.path, '/mcp/docs');
  const text = JSON.stringify(body);
  assert.ok(!text.includes('upstream-secret'), 'catalog must not leak the upstream token');
  assert.ok(!text.includes(h.upstream.url), 'catalog must not leak the upstream URL');
  assert.ok(!text.includes(token), 'catalog must not echo the device token');
});

test('two independent clients both complete initialize, tools/list and a streamed tools/call', async () => {
  const h = await harness();
  const a = (await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null })).token;
  const b = (await h.gateway.createDevice({ name: 'b', provider: 'claude', servers: null })).token;

  for (const token of [a, b]) {
    const init = await call(h.base, token, initialize);
    assert.equal(init.status, 200);
    const session = init.headers.get('mcp-session-id');
    assert.ok(session, 'initialize must return a gateway session id');
    assert.notEqual(session, 'up-session-1', 'the upstream session id must not be exposed');
    const initBody = await init.json() as { result: { serverInfo: { name: string } } };
    assert.equal(initBody.result.serverInfo.name, 'fake');

    const list = await call(h.base, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, '/mcp/docs', { 'Mcp-Session-Id': session! });
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json() as { result: { tools: unknown[] } }).result.tools, [{ name: 'ping', description: 'pong' }]);

    const callResult = await call(h.base, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ping' } }, '/mcp/docs', { 'Mcp-Session-Id': session!, Accept: 'text/event-stream' });
    assert.equal(callResult.headers.get('content-type'), 'text/event-stream');
    const streamed = await callResult.text();
    assert.match(streamed, /"text":"pong"/);
  }

  // Every upstream call carried only the center's credential, never a device token.
  assert.ok(h.upstream.seen.every(value => value === 'Bearer upstream-secret'));
  assert.ok(!h.upstream.seen.some(value => value === `Bearer ${a}` || value === `Bearer ${b}`));
});

test('the upstream authorization is read again on every request', async () => {
  const h = await harness();
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  await call(h.base, token, initialize);
  h.setAuth('Bearer rotated-token');
  await call(h.base, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(h.upstream.seen, ['Bearer upstream-secret', 'Bearer rotated-token']);
});

test('device cookies and Authorization are never forwarded upstream', async () => {
  const h = await harness();
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  await call(h.base, token, initialize, '/mcp/docs', { Cookie: 'secret=1', 'X-Custom': 'drop-me' });
  const forwarded = h.upstream.headers.at(-1)!;
  assert.equal(forwarded.cookie, undefined);
  assert.equal(forwarded['x-custom'], undefined);
  assert.equal(forwarded.authorization, 'Bearer upstream-secret');
  assert.equal(forwarded['content-type'], 'application/json');
});

/* ------------------------------------------------------- sessions */

test('a session id from one device cannot be used by another, and DELETE ends it', async () => {
  const h = await harness();
  const a = (await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null })).token;
  const b = (await h.gateway.createDevice({ name: 'b', provider: 'claude', servers: null })).token;
  const session = (await call(h.base, a, initialize)).headers.get('mcp-session-id')!;

  const stolen = await call(h.base, b, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, '/mcp/docs', { 'Mcp-Session-Id': session });
  assert.equal(stolen.status, 404);

  const removed = await fetch(`${h.base}/mcp/docs`, { method: 'DELETE', headers: { Authorization: `Bearer ${a}`, 'Mcp-Session-Id': session } });
  assert.equal(removed.status, 204);
  const after = await call(h.base, a, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, '/mcp/docs', { 'Mcp-Session-Id': session });
  assert.equal(after.status, 404);
});

/* --------------------------------------------------- permissions */

test('server enablement, provider allowlists and the provider MCP switch all gate access', async () => {
  const h = await harness();
  const claude = (await h.gateway.createDevice({ name: 'claude-dev', provider: 'claude', servers: null })).token;
  const codex = (await h.gateway.createDevice({ name: 'codex-dev', provider: 'codex', servers: null })).token;

  const claudeCatalog = await (await fetch(`${h.base}/v1/servers`, { headers: { Authorization: `Bearer ${claude}` } })).json() as { servers: { name: string }[] };
  assert.deepEqual(claudeCatalog.servers.map(server => server.name), ['docs']);
  const codexCatalog = await (await fetch(`${h.base}/v1/servers`, { headers: { Authorization: `Bearer ${codex}` } })).json() as { servers: { name: string }[] };
  assert.deepEqual(codexCatalog.servers.map(server => server.name), ['docs', 'onlyCodex']);

  assert.equal((await call(h.base, claude, initialize, '/mcp/onlyCodex')).status, 404);
  assert.equal((await call(h.base, claude, initialize, '/mcp/off')).status, 404);
  assert.equal((await call(h.base, claude, initialize, '/mcp/legacy')).status, 404);
  assert.equal((await call(h.base, claude, initialize, '/mcp/nope')).status, 404);

  h.setMcpOn('claude', false);
  assert.deepEqual(((await (await fetch(`${h.base}/v1/servers`, { headers: { Authorization: `Bearer ${claude}` } })).json()) as { servers: unknown[] }).servers, []);
  assert.equal((await call(h.base, claude, initialize)).status, 404);
});

test('a per-device server list narrows the catalog', async () => {
  const h = await harness();
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'codex', servers: ['onlyCodex'] });
  const catalog = await (await fetch(`${h.base}/v1/servers`, { headers: { Authorization: `Bearer ${token}` } })).json() as { servers: { name: string }[] };
  assert.deepEqual(catalog.servers.map(server => server.name), ['onlyCodex']);
  assert.equal((await call(h.base, token, initialize, '/mcp/docs')).status, 404);
  assert.equal((await call(h.base, token, initialize, '/mcp/onlyCodex')).status, 200);
});

test('revoking a device stops new calls immediately', async () => {
  const h = await harness();
  const created = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  assert.equal((await call(h.base, created.token, initialize)).status, 200);
  await h.gateway.revokeDevice(created.state.devices[0]!.id);
  assert.equal((await fetch(`${h.base}/v1/servers`, { headers: { Authorization: `Bearer ${created.token}` } })).status, 401);
  assert.equal((await call(h.base, created.token, initialize)).status, 401);
});

/* ------------------------------------------------------- failures */

test('an upstream 401 is reported as a center authorization failure without leaking headers', async () => {
  const h = await harness({ requireAuth: 'Bearer upstream-secret' });
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  h.setAuth('Bearer expired');
  const response = await call(h.base, token, initialize);
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, /-32001/);
  assert.ok(!text.includes('upstream-secret'));
  assert.ok(!text.includes('WWW-Authenticate'));
});

test('an upstream redirect is refused rather than followed', async () => {
  const h = await harness({ redirect: true });
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const response = await call(h.base, token, initialize, '/mcp/redir');
  assert.equal(response.status, 502);
  assert.match(await response.text(), /redirect/i);
});

test('a cross-site Origin and an oversized body are rejected', async () => {
  const h = await harness();
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const badOrigin = await call(h.base, token, initialize, '/mcp/docs', { Origin: 'http://evil.example' });
  assert.equal(badOrigin.status, 403);

  const huge = await fetch(`${h.base}/mcp/docs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: 'x'.repeat(9 * 1024 * 1024),
  });
  assert.equal(huge.status, 413);
});

test('state never contains the device token or its hash', async () => {
  const h = await harness();
  const created = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const text = JSON.stringify(created.state);
  assert.ok(!text.includes(created.token));
  assert.ok(!text.includes(hashToken(created.token)));
  assert.equal(created.state.devices[0]!.revokedAt, null);
});

test('stopping the gateway closes the listener', async () => {
  const h = await harness();
  assert.equal((await fetch(`${h.base}/v1/servers`)).status, 401);
  h.gateway.stop();
  await assert.rejects(fetch(`${h.base}/v1/servers`));
});

/* -------------------------------------------------------- remotes */

test('a remote host connects, lists the center catalog and builds MCP configs', async () => {
  const center = await harness();
  const { token } = await center.gateway.createDevice({ name: 'remote-dev', provider: 'claude', servers: null });

  const root = await mkdtemp(join(tmpdir(), 'gateway-remote-'));
  const remote = new Gateway(root, { servers: async () => ({}), providerMcpOn: async () => true, authHeader: async () => null });
  cleanups.push(async () => { remote.stop(); await rm(root, { recursive: true, force: true }); });

  const state = await remote.connectRemote({ name: 'center', url: center.base, token, provider: 'claude' });
  assert.equal(state.remotes[0]!.status, 'ok');
  assert.deepEqual(state.remotes[0]!.catalog.map(server => server.name), ['docs']);
  assert.ok(!JSON.stringify(state).includes(token), 'remote state must not echo the device token');

  const configs = await remote.remoteServers('claude');
  assert.deepEqual(Object.keys(configs), ['docs']);
  assert.equal(configs.docs!.type, 'http');
  assert.equal((configs.docs as { url: string }).url, `${center.base}/mcp/docs`);
  assert.equal((configs.docs as { headers: Record<string, string> }).headers.Authorization, `Bearer ${token}`);

  // Those configs work end to end against the center.
  const response = await fetch((configs.docs as { url: string }).url, {
    method: 'POST',
    headers: { ...(configs.docs as { headers: Record<string, string> }).headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(initialize),
  });
  assert.equal(response.status, 200);
});

test('a revoked or unreachable center is reported, not masked', async () => {
  const center = await harness();
  const created = await center.gateway.createDevice({ name: 'remote-dev', provider: 'claude', servers: null });
  const root = await mkdtemp(join(tmpdir(), 'gateway-remote-'));
  const remote = new Gateway(root, { servers: async () => ({}), providerMcpOn: async () => true, authHeader: async () => null });
  cleanups.push(async () => { remote.stop(); await rm(root, { recursive: true, force: true }); });

  await center.gateway.revokeDevice(created.state.devices[0]!.id);
  const revoked = await remote.connectRemote({ name: 'center', url: center.base, token: created.token, provider: 'claude' });
  assert.equal(revoked.remotes[0]!.status, 'error');
  assert.match(revoked.remotes[0]!.error ?? '', /revoked/);
  assert.deepEqual(await remote.remoteServers('claude'), {});

  const offline = await remote.connectRemote({ name: 'down', url: 'http://127.0.0.1:9', token: 'x', provider: 'claude' });
  assert.equal(offline.remotes.find(entry => entry.name === 'down')!.status, 'error');

  assert.throws(() => normalizeGatewayUrl('http://host:1/#frag'));
  await assert.rejects(fetchCatalog('http://127.0.0.1:9', 'x', 'claude', fetch, 500));
});

test('remote MCP configs carry the device token, never the center upstream token', async () => {
  const configs = remoteMcpConfigs('http://center:47822/', 'device-token', [{ name: 'docs', path: '/mcp/docs' }]);
  assert.deepEqual(configs.docs, { type: 'http', url: 'http://center:47822/mcp/docs', headers: { Authorization: 'Bearer device-token' } });
});

/* --------------------------------------------- review-gap regressions */

test('an Origin with the same host but another scheme or port is refused', async () => {
  const h = await harness();
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const auth = { Authorization: `Bearer ${token}` };
  const port = new URL(h.base).port;
  assert.equal((await fetch(`${h.base}/v1/servers`, { headers: { ...auth, Origin: `http://127.0.0.1:${port}` } })).status, 200);
  assert.equal((await fetch(`${h.base}/v1/servers`, { headers: auth })).status, 200);
  assert.equal((await fetch(`${h.base}/v1/servers`, { headers: { ...auth, Origin: 'https://127.0.0.1:11111' } })).status, 403);
  assert.equal((await fetch(`${h.base}/v1/servers`, { headers: { ...auth, Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await fetch(`${h.base}/v1/servers`, { headers: { ...auth, Origin: 'null' } })).status, 403);
});

test('disabling the gateway closes active streams and frees the port for re-enable', async () => {
  const h = await harness({ hang: true });
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const { config } = await h.gateway.state();
  const controller = new AbortController();
  const response = await fetch(`${h.base}/mcp/docs`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  await reader.read();

  await h.gateway.saveConfig({ ...config, enabled: false });
  const closed = await Promise.race([
    reader.read().then(result => result.done === true, () => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000)),
  ]);
  assert.equal(closed, true, 'the active stream must end when the gateway is disabled');
  controller.abort();

  await h.gateway.saveConfig({ ...config, enabled: true });
  assert.equal((await fetch(`${h.base}/v1/servers`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
});

test('a client that aborts mid-body does not wedge the gateway', async () => {
  const h = await harness();
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const port = Number(new URL(h.base).port);
  const req = httpRequest({ host: '127.0.0.1', port, path: '/mcp/docs', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': '1000' } });
  req.on('error', () => undefined);
  req.write('{');
  req.destroy();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal((await call(h.base, token, initialize)).status, 200);
});

test('the gateway caps concurrent upstream requests', async () => {
  const h = await harness({ hang: true });
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const controllers: AbortController[] = [];
  // Hold every response so its stream stays open; a collected body would free a slot and mask the cap.
  const held: Response[] = [];
  const statuses: number[] = [];
  for (let index = 0; index < MAX_ACTIVE_REQUESTS + 8; index += 1) {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${h.base}/mcp/docs`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: controller.signal });
    held.push(response);
    statuses.push(response.status);
  }
  assert.equal(statuses[0], 200);
  assert.ok(statuses.includes(503), 'a saturated gateway must answer 503 rather than pile up');
  assert.equal(held.filter(response => response.status === 200).length, MAX_ACTIVE_REQUESTS, 'exactly the cap is admitted');
  for (const controller of controllers) controller.abort();
  // Once the streams are released, a new request is served again.
  let recovered = false;
  for (let attempt = 0; attempt < 20 && !recovered; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const response = await fetch(`${h.base}/mcp/docs`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } });
    recovered = response.status !== 503;
    response.body?.cancel().catch(() => undefined);
  }
  assert.equal(recovered, true, 'slots must free up after the streams end');
});

test('revoking a device ends its in-flight stream', async () => {
  const h = await harness({ hang: true });
  const created = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const response = await fetch(`${h.base}/mcp/docs`, { headers: { Authorization: `Bearer ${created.token}`, Accept: 'text/event-stream' } });
  const reader = response.body!.getReader();
  await reader.read();
  await h.gateway.revokeDevice(created.state.devices[0]!.id);
  const closed = await Promise.race([
    reader.read().then(result => result.done === true, () => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000)),
  ]);
  assert.equal(closed, true, 'revoking a device must end its live stream');
});

test('a session is minted only for initialize', async () => {
  const h = await harness({ sessionEverywhere: true });
  const { token } = await h.gateway.createDevice({ name: 'a', provider: 'claude', servers: null });
  const list = await call(h.base, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('mcp-session-id'), null, 'a non-initialize response must not open a session');
  const guessed = await call(h.base, token, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, '/mcp/docs', { 'Mcp-Session-Id': 'made-up' });
  assert.equal(guessed.status, 404);
});

test('the bind address is validated and a path-prefixed gateway URL is refused', async () => {
  const h = await harness();
  const { config } = await h.gateway.state();
  await assert.rejects(h.gateway.saveConfig({ ...config, host: 'http://x' }), /bind address/);
  await assert.rejects(h.gateway.saveConfig({ ...config, host: 'a b' }), /bind address/);
  assert.equal(validateHost('0.0.0.0'), '0.0.0.0');
  assert.throws(() => normalizeGatewayUrl('http://center:47822/sub'), /origin only/);
});
