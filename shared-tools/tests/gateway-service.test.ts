import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { SharedTools, type Paseo } from '../server/service';

/**
 * End to end through the real `SharedTools`: a center signs in to an upstream MCP once, shares it
 * over the gateway, and a second host injects the gateway server into a new agent with only its
 * device token. The center's upstream authorization never reaches the second host.
 */

const entries = [{ provider: 'claude', status: 'ready', enabled: true, label: 'Claude' }];
const paseo = {
  providers: { snapshot: async () => ({ entries }) },
  config: { get: async () => ({ requestId: 'r', config: { providers: {} } }) },
} as unknown as Paseo;

interface FakeUpstream { url: string; seen: string[]; close(): Promise<void>; }

async function fakeUpstream(): Promise<FakeUpstream> {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(typeof request.headers.authorization === 'string' ? request.headers.authorization : '');
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const message = JSON.parse(raw || '{}') as { id?: unknown; method?: string };
      if (message.method === 'initialize') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'up-1' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen, close: () => new Promise(resolve => server.close(() => resolve())) };
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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

test('a second host reaches the center MCP with only its device token', async () => {
  const centerHome = await mkdtemp(join(tmpdir(), 'gateway-center-'));
  const remoteHome = await mkdtemp(join(tmpdir(), 'gateway-remote-'));
  const centerRoot = join(centerHome, '.paseo/shared-tools');
  const remoteRoot = join(remoteHome, '.paseo/shared-tools');
  const upstream = await fakeUpstream();
  const port = await freePort();

  const center = new SharedTools(centerRoot, centerHome, () => undefined);
  const remote = new SharedTools(remoteRoot, remoteHome, () => undefined);
  cleanups.push(async () => { center.stop(); remote.stop(); await upstream.close(); await rm(centerHome, { recursive: true, force: true }); await rm(remoteHome, { recursive: true, force: true }); });

  // The center's own sign-in for the upstream, kept in oauth.json (mode 600).
  await mkdir(centerRoot, { recursive: true });
  await writeFile(join(centerRoot, 'oauth.json'), `${JSON.stringify({
    version: 1,
    servers: { docs: { url: upstream.url, issuer: 'https://issuer', token_endpoint: 'https://issuer/token', resource: null, client: { client_id: 'c', auth: 'none' }, tokens: { access_token: 'upstream-secret', expires_at: Date.now() + 3_600_000 } } },
    sources: {},
  }, null, 2)}\n`, { mode: 0o600 });

  await center.state(paseo);
  await center.saveServer({ name: 'docs', previousName: null, enabled: true, providers: null, config: { type: 'http', url: upstream.url } });
  const gateway = await center.saveGatewayConfig({ enabled: true, host: '127.0.0.1', port, publicUrl: `http://100.96.195.115:${port}` });
  assert.equal(gateway.running, true);
  assert.deepEqual(gateway.shareable, ['docs']);

  const { token } = await center.createDevice({ name: 'laptop', provider: 'claude', servers: null });
  const base = `http://127.0.0.1:${port}`;

  const catalog = await (await fetch(`${base}/v1/servers`, { headers: { Authorization: `Bearer ${token}` } })).json() as { servers: { name: string; path: string }[] };
  assert.deepEqual(catalog.servers.map(server => server.name), ['docs']);

  const initialize = await fetch(`${base}/mcp/docs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'remote', version: '1' } } }),
  });
  assert.equal(initialize.status, 200);
  assert.deepEqual(upstream.seen, ['Bearer upstream-secret']);

  // The other host connects and injects the gateway server into a new agent.
  const connected = await remote.connectRemote({ name: 'center', url: base, token, provider: 'claude' });
  assert.equal(connected.remotes[0]!.status, 'ok');
  const added = await remote.mcpFor('claude', undefined, paseo);
  assert.deepEqual(Object.keys(added ?? {}), ['docs']);
  assert.deepEqual(added!.docs, { type: 'http', url: `${base}/mcp/docs`, headers: { Authorization: `Bearer ${token}`, 'X-Paseo-Provider': 'claude' } });
  assert.ok(!JSON.stringify(added).includes('upstream-secret'), 'the upstream token must never reach the remote host');

  const remoteFiles = await readFile(join(remoteRoot, 'gateway.json'), 'utf8');
  assert.ok(!remoteFiles.includes('upstream-secret'), 'the upstream token must not be written on the remote host');
  assert.ok(remoteFiles.includes(token), 'the device token is what the remote stores');

  // A call through the remote's injected config works and carries the device token to the center.
  const call = await fetch(added!.docs.url, {
    method: 'POST',
    headers: { ...(added!.docs as { headers: Record<string, string> }).headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  assert.equal(call.status, 200);
  assert.equal(upstream.seen.at(-1), 'Bearer upstream-secret');
});

test('when the center is offline a new agent gets no gateway servers', async () => {
  const centerHome = await mkdtemp(join(tmpdir(), 'gateway-center-'));
  const remoteHome = await mkdtemp(join(tmpdir(), 'gateway-remote-'));
  const upstream = await fakeUpstream();
  const port = await freePort();
  const center = new SharedTools(join(centerHome, '.paseo/shared-tools'), centerHome, () => undefined);
  const remote = new SharedTools(join(remoteHome, '.paseo/shared-tools'), remoteHome, () => undefined);
  cleanups.push(async () => { center.stop(); remote.stop(); await upstream.close(); await rm(centerHome, { recursive: true, force: true }); await rm(remoteHome, { recursive: true, force: true }); });

  await center.state(paseo);
  await center.saveServer({ name: 'docs', previousName: null, enabled: true, providers: null, config: { type: 'http', url: upstream.url } });
  await center.saveGatewayConfig({ enabled: true, host: '127.0.0.1', port, publicUrl: `http://100.96.195.115:${port}` });
  const { token } = await center.createDevice({ name: 'laptop', provider: 'claude', servers: null });
  const base = `http://127.0.0.1:${port}`;

  const connected = await remote.connectRemote({ name: 'center', url: base, token, provider: 'claude' });
  assert.equal(connected.remotes[0]!.status, 'ok');
  assert.deepEqual(Object.keys((await remote.mcpFor('claude', undefined, paseo))!), ['docs']);

  // Take the center down; the next mcpFor must refresh, fail, and inject nothing — no stale cache.
  await center.saveGatewayConfig({ enabled: false, host: '127.0.0.1', port, publicUrl: `http://100.96.195.115:${port}` });
  assert.equal(await remote.mcpFor('claude', undefined, paseo), null);
});

test('a server added or removed on the center is reflected on the next agent', async () => {
  const centerHome = await mkdtemp(join(tmpdir(), 'gateway-center-'));
  const remoteHome = await mkdtemp(join(tmpdir(), 'gateway-remote-'));
  const upstream = await fakeUpstream();
  const port = await freePort();
  const center = new SharedTools(join(centerHome, '.paseo/shared-tools'), centerHome, () => undefined);
  const remote = new SharedTools(join(remoteHome, '.paseo/shared-tools'), remoteHome, () => undefined);
  cleanups.push(async () => { center.stop(); remote.stop(); await upstream.close(); await rm(centerHome, { recursive: true, force: true }); await rm(remoteHome, { recursive: true, force: true }); });

  await center.state(paseo);
  await center.saveServer({ name: 'docs', previousName: null, enabled: true, providers: null, config: { type: 'http', url: upstream.url } });
  await center.saveGatewayConfig({ enabled: true, host: '127.0.0.1', port, publicUrl: `http://100.96.195.115:${port}` });
  const { token } = await center.createDevice({ name: 'laptop', provider: 'claude', servers: null });
  const base = `http://127.0.0.1:${port}`;
  await remote.connectRemote({ name: 'center', url: base, token, provider: 'claude' });

  assert.deepEqual(Object.keys((await remote.mcpFor('claude', undefined, paseo))!), ['docs']);

  await center.saveServer({ name: 'extra', previousName: null, enabled: true, providers: null, config: { type: 'http', url: upstream.url } });
  assert.deepEqual(Object.keys((await remote.mcpFor('claude', undefined, paseo))!).sort(), ['docs', 'extra']);

  await center.deleteServer('extra');
  assert.deepEqual(Object.keys((await remote.mcpFor('claude', undefined, paseo))!), ['docs']);
});

test('one token authorized for two providers injects each provider’s servers with its own header', async () => {
  const centerHome = await mkdtemp(join(tmpdir(), 'gateway-center-'));
  const remoteHome = await mkdtemp(join(tmpdir(), 'gateway-remote-'));
  const upstream = await fakeUpstream();
  const port = await freePort();
  const center = new SharedTools(join(centerHome, '.paseo/shared-tools'), centerHome, () => undefined);
  const remote = new SharedTools(join(remoteHome, '.paseo/shared-tools'), remoteHome, () => undefined);
  cleanups.push(async () => { center.stop(); remote.stop(); await upstream.close(); await rm(centerHome, { recursive: true, force: true }); await rm(remoteHome, { recursive: true, force: true }); });

  await center.state(paseo);
  await center.saveServer({ name: 'docs', previousName: null, enabled: true, providers: null, config: { type: 'http', url: upstream.url } });
  await center.saveGatewayConfig({ enabled: true, host: '127.0.0.1', port, publicUrl: `http://100.96.195.115:${port}` });
  const { token } = await center.createDevice({ name: 'laptop', providers: ['claude', 'codex'], servers: null });
  const base = `http://127.0.0.1:${port}`;

  const connected = await remote.connectRemote({ name: 'center', url: base, token, providers: ['claude', 'codex'] });
  assert.deepEqual(connected.remotes.map(remote => remote.provider).sort(), ['claude', 'codex']);

  const claude = await remote.mcpFor('claude', undefined, paseo);
  const codex = await remote.mcpFor('codex', undefined, paseo);
  assert.deepEqual(Object.keys(claude ?? {}), ['docs']);
  assert.deepEqual(Object.keys(codex ?? {}), ['docs']);
  assert.equal((claude!.docs as { headers: Record<string, string> }).headers['X-Paseo-Provider'], 'claude');
  assert.equal((codex!.docs as { headers: Record<string, string> }).headers['X-Paseo-Provider'], 'codex');
  assert.equal((claude!.docs as { headers: Record<string, string> }).headers.Authorization, `Bearer ${token}`);
  assert.ok(!JSON.stringify([claude, codex]).includes('upstream-secret'), 'the upstream token must never reach the remote host');
});
